'use strict';

/**
 * What the clearing account held when a church went live on CSP, and whether they have
 * since trued up the switch-over.
 *
 * A church that starts mid-period keeps receiving Stripe deposits that mix old-process money
 * with money CSP posted. The only way to tell the leftover apart from a normal running
 * balance is to know what the account held before CSP touched it - so that is captured once,
 * when the go-live date is saved, and never guessed.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('UserSettings', 'clearingBalanceAtGoLiveCents', {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
    await queryInterface.addColumn('UserSettings', 'clearingSnapshotAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('UserSettings', 'transitionTruedUpAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('UserSettings', 'transitionTruedUpAt');
    await queryInterface.removeColumn('UserSettings', 'clearingSnapshotAt');
    await queryInterface.removeColumn('UserSettings', 'clearingBalanceAtGoLiveCents');
  },
};
