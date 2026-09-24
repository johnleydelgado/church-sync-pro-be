'use strict';

/**
 * A nullable churchId on every table that is really "per church" but has been keyed by
 * the client login's userId. Nothing reads it yet; the backfill (…000003) fills it and
 * a later phase moves the code over. userId stays until then.
 *
 * `billing` is deliberately not here: who pays stays on the person. `SyncRun` has no
 * userId at all (it is the nightly run's own log).
 */
const PER_CHURCH_TABLES = [
  'UserSettings',
  'tokens',
  'UserSync',
  'DailyJeSync',
  'registration',
  'userEmailPreferences',
  // Exists on staging and production but not in every local database; skipped when absent.
  'email_logs',
];

const existingTables = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return new Set(tables.map((t) => (typeof t === 'string' ? t : t.tableName)));
};

module.exports = {
  PER_CHURCH_TABLES,

  async up(queryInterface, Sequelize) {
    const present = await existingTables(queryInterface);
    for (const table of PER_CHURCH_TABLES) {
      if (!present.has(table)) continue;
      await queryInterface.addColumn(table, 'churchId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Churches', key: 'id' },
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex(table, ['churchId'], { name: `${table}_church_id_idx` });
    }
  },

  async down(queryInterface) {
    const present = await existingTables(queryInterface);
    for (const table of [...PER_CHURCH_TABLES].reverse()) {
      if (!present.has(table)) continue;
      await queryInterface.removeIndex(table, `${table}_church_id_idx`);
      await queryInterface.removeColumn(table, 'churchId');
    }
  },
};
