'use strict';

/**
 * Records the churches a nightly run passed over, and why.
 *
 * A run that touched nobody reported `processed: 0, status: completed` - indistinguishable
 * from a quiet night with no giving. Staging shows fifteen consecutive runs like that, and
 * production has 18 users but only 3 settings rows, one of which has a NULL sync start date
 * that was being dropped without a word. "Green" has to mean something more than "nothing
 * threw".
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('SyncRun', 'skipped', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('SyncRun', 'skips', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('SyncRun', 'skips');
    await queryInterface.removeColumn('SyncRun', 'skipped');
  },
};
