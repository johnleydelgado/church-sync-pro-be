'use strict';

/**
 * Catch ChurchMembers up with the legacy bookkeeper table (rules: ../churchResyncPlan.js) and
 * make "one church per account row" a database rule - the church screens rely on it.
 *
 * 1. Refuses, before writing anything, if any account row owns two churches.
 * 2. Re-runs the backfill (…000003, its own transaction). It is idempotent, and creates a
 *    church and owner for every client login that signed up, or was added from the Clients
 *    page, since it last ran. Its churchId stamp is harmless.
 * 3. In one transaction: checks (1) again, logs what the plan will do (counts and ids, no
 *    addresses), applies it, and adds the partial unique index on Churches.ownerUserId.
 *
 * Safe to re-run. `down` only drops the index: the membership corrections are data fixes and
 * stay.
 */
const { Op } = require('sequelize');
const backfill = require('./20260925000003-backfill-churches');
const { planResync, describePlan } = require('../churchResyncPlan');

const OWNER_INDEX = 'churches_owner_user_unique';

const refuseSharedAccounts = async (sequelize, transaction) => {
  const [dupes] = await sequelize.query(
    `SELECT "ownerUserId" FROM "Churches" WHERE "ownerUserId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`,
    { transaction },
  );
  if (dupes.length) {
    throw new Error(`Accounts owning more than one church: ${dupes.map((d) => d.ownerUserId).join(', ')}`);
  }
};

/** Adds the one-church-per-account index unless it is already there. */
const addOwnerIndex = async (queryInterface, transaction) => {
  const indexes = await queryInterface.showIndex('Churches', { transaction });
  if (indexes.some((i) => i.name === OWNER_INDEX)) return;
  await queryInterface.addIndex('Churches', ['ownerUserId'], {
    unique: true,
    name: OWNER_INDEX,
    where: { ownerUserId: { [Op.ne]: null } },
    transaction,
  });
};

module.exports = {
  OWNER_INDEX,
  addOwnerIndex,

  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await refuseSharedAccounts(sequelize);
    await backfill.up(queryInterface);
    await sequelize.transaction(async (transaction) => {
      const q = async (sql) => (await sequelize.query(sql, { transaction }))[0];
      await refuseSharedAccounts(sequelize, transaction);

      const churches = await q(`SELECT id, "ownerUserId" FROM "Churches"`);
      const members = await q(
        `SELECT id, "churchId", "userId", "invitedEmail", role::text AS role, "inviteAccepted" FROM "ChurchMembers" ORDER BY id`,
      );
      const bookkeepers = await q(
        `SELECT "userId", "clientId", email, "invitationToken", "inviteAccepted", "bookkeeperIntegrationAccessEnabled"
         FROM "bookkeeper" ORDER BY id`,
      );
      const accounts = await q(`SELECT u.id, u.email FROM "Users" u JOIN "Churches" c ON c."ownerUserId" = u.id`);
      const bookkeeperUsers = await q(
        `SELECT id, email FROM "Users" WHERE id IN (SELECT "userId" FROM "bookkeeper" WHERE "userId" IS NOT NULL)`,
      );

      const plan = planResync(churches, members, bookkeepers, accounts, bookkeeperUsers);
      for (const line of describePlan(plan, members)) console.log(`[resync-church-members] ${line}`);
      const now = new Date();
      if (plan.insert.length) {
        await queryInterface.bulkInsert(
          'ChurchMembers',
          plan.insert.map((m) => ({ ...m, createdAt: now, updatedAt: now })),
          { transaction },
        );
      }
      for (const a of plan.accept) {
        await sequelize.query(
          `UPDATE "ChurchMembers" SET "userId" = :userId, "inviteAccepted" = true, "updatedAt" = now() WHERE id = :id`,
          { replacements: a, transaction },
        );
      }
      if (plan.promote.length) {
        await sequelize.query(
          `UPDATE "ChurchMembers"
           SET role = 'owner', "integrationAccessEnabled" = true, "inviteAccepted" = true,
               "invitedEmail" = NULL, "invitationToken" = NULL, "updatedAt" = now()
           WHERE id IN (:ids)`,
          { replacements: { ids: plan.promote }, transaction },
        );
      }
      if (plan.unaccept.length) {
        await sequelize.query(
          `UPDATE "ChurchMembers" SET "inviteAccepted" = false, "updatedAt" = now() WHERE id IN (:ids) AND "userId" IS NULL`,
          { replacements: { ids: plan.unaccept }, transaction },
        );
      }
      if (plan.dropMembers.length) {
        await sequelize.query(`DELETE FROM "ChurchMembers" WHERE id IN (:ids)`, {
          replacements: { ids: plan.dropMembers },
          transaction,
        });
      }
      await addOwnerIndex(queryInterface, transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Churches', OWNER_INDEX);
  },
};
