'use strict';

/**
 * The payout dates an uploaded payout report covers ("Payouts in this file: from / to").
 *
 * Planning Center's payout report rows carry the CHARGE date and no payout date or id, but the
 * bookkeeper exports the file for a range of PAYOUT dates - so that range is the one fact that
 * says when each row was paid out. The "still in transit at month-end" report reads it
 * (docs/plans/2026-10-22-outstanding-deposits.md in the frontend repo).
 *
 * Nullable: uploads made before this column existed have no range. They count as "range
 * unknown" - their rows are treated as paid out by the upload's own lastDay, and the report's
 * coverage treats them as gaps.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('PayoutReportUploads', 'payoutFrom', { type: Sequelize.DATEONLY, allowNull: true });
    await queryInterface.addColumn('PayoutReportUploads', 'payoutTo', { type: Sequelize.DATEONLY, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PayoutReportUploads', 'payoutTo');
    await queryInterface.removeColumn('PayoutReportUploads', 'payoutFrom');
  },
};
