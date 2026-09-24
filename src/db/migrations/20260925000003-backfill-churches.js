'use strict';

/**
 * Fill Churches / ChurchMembers from the rows that exist today, and stamp churchId on
 * every per-church row. The rules live in ../churchBackfillPlan.js (unit-tested); this
 * file only reads, plans, writes.
 *
 * Safe to re-run: only client logins that do not own a church yet are planned, and the
 * churchId stamp only touches rows still null. Everything runs in one transaction.
 */
const { planBackfill } = require('../churchBackfillPlan');
const { PER_CHURCH_TABLES } = require('./20260925000002-add-churchid-columns');

const presentTables = async (queryInterface, transaction) => {
  const tables = await queryInterface.showAllTables({ transaction });
  const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
  return PER_CHURCH_TABLES.filter((t) => names.includes(t));
};

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      const q = async (sql) => (await sequelize.query(sql, { transaction }))[0];

      const clients = await q(
        `SELECT u.id, u."churchName", u."isActive" FROM "Users" u
         WHERE u.role = 'client'
           AND NOT EXISTS (SELECT 1 FROM "Churches" c WHERE c."ownerUserId" = u.id)
         ORDER BY u.id`,
      );
      const bookkeepers = await q(
        `SELECT "userId", "clientId", email, "invitationToken", "inviteAccepted",
                "bookkeeperIntegrationAccessEnabled"
         FROM "bookkeeper" ORDER BY id`,
      );

      const plan = planBackfill(clients, bookkeepers);
      if (plan.churches.length > 0) {
        const now = new Date();
        await queryInterface.bulkInsert(
          'Churches',
          plan.churches.map((c) => ({ ...c, createdAt: now, updatedAt: now })),
          { transaction },
        );
        const churches = await q(`SELECT id, "ownerUserId" FROM "Churches" WHERE "ownerUserId" IS NOT NULL`);
        const idByOwner = new Map(churches.map((c) => [c.ownerUserId, c.id]));
        const members = plan.members
          .map(({ ownerUserId, ...m }) => ({ ...m, churchId: idByOwner.get(ownerUserId), createdAt: now, updatedAt: now }))
          .filter((m) => m.churchId);
        if (members.length > 0) {
          await queryInterface.bulkInsert('ChurchMembers', members, { transaction });
        }
      }

      for (const table of await presentTables(queryInterface, transaction)) {
        await sequelize.query(
          `UPDATE "${table}" t SET "churchId" = c.id
           FROM "Churches" c
           WHERE c."ownerUserId" = t."userId" AND t."churchId" IS NULL`,
          { transaction },
        );
      }
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      for (const table of await presentTables(queryInterface, transaction)) {
        await sequelize.query(`UPDATE "${table}" SET "churchId" = NULL WHERE "churchId" IS NOT NULL`, { transaction });
      }
      await sequelize.query('DELETE FROM "ChurchMembers"', { transaction });
      await sequelize.query('DELETE FROM "Churches"', { transaction });
    });
  },
};
