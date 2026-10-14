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
 * 4. In the same transaction, after the plan: one outstanding invite per address per church, as
 *    a partial unique index on ("churchId", lower("invitedEmail")) for members with no user yet,
 *    so a double-clicked Invite can't write two. Neither the backfill nor the plan writes such
 *    duplicates (both key invites by church + lower-cased address), so the clean-up before it
 *    should find none; if some exist anyway, it keeps the oldest and logs how many it dropped.
 *
 * Safe to re-run. `down` only drops the indexes: the membership corrections are data fixes and
 * stay.
 */
const { Op } = require('sequelize');
const backfill = require('./20260925000003-backfill-churches');
const { planResync, describePlan } = require('../churchResyncPlan');

const OWNER_INDEX = 'churches_owner_user_unique';
const INVITE_INDEX = 'church_members_church_invite_unique';
const LOG = '[resync-church-members]';

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

/** Outstanding invites for the same church and address, beyond the oldest. Logs ids, never addresses. */
const dropDuplicateInvites = async (sequelize, transaction) => {
  const [dropped] = await sequelize.query(
    `DELETE FROM "ChurchMembers" m
     USING "ChurchMembers" k
     WHERE m."userId" IS NULL AND k."userId" IS NULL
       AND m."invitedEmail" IS NOT NULL AND k."invitedEmail" IS NOT NULL
       AND m."churchId" = k."churchId" AND lower(m."invitedEmail") = lower(k."invitedEmail")
       AND m.id > k.id
     RETURNING m.id`,
    { transaction },
  );
  if (dropped.length) {
    const ids = dropped.map((r) => r.id).sort((a, b) => a - b);
    console.log(
      `${LOG} dropped ${ids.length} duplicate outstanding invite(s), kept the oldest: members ${ids.join(', ')}`,
    );
  }
};

/** One outstanding invite per address per church. */
const addInviteIndex = async (queryInterface, transaction) => {
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INVITE_INDEX}" ON "ChurchMembers" ("churchId", lower("invitedEmail"))
     WHERE "userId" IS NULL AND "invitedEmail" IS NOT NULL`,
    { transaction },
  );
};

module.exports = {
  OWNER_INDEX,
  INVITE_INDEX,
  addOwnerIndex,
  addInviteIndex,

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
      for (const line of describePlan(plan, members)) console.log(`${LOG} ${line}`);
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
      await dropDuplicateInvites(sequelize, transaction);
      await addInviteIndex(queryInterface, transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${INVITE_INDEX}"`);
    await queryInterface.removeIndex('Churches', OWNER_INDEX);
  },
};
