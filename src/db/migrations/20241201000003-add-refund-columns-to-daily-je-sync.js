'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Refunds are posted as reversing entries on the day the refund happened (the
  // client's decision), so the per-day ledger needs to carry what was reversed
  // alongside what was posted. The monthly statement nets the two.
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('DailyJeSync', 'refundedGrossCents', {
      type: Sequelize.BIGINT, allowNull: false, defaultValue: 0,
    });
    await queryInterface.addColumn('DailyJeSync', 'refundedFeeCents', {
      type: Sequelize.BIGINT, allowNull: false, defaultValue: 0,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('DailyJeSync', 'refundedGrossCents');
    await queryInterface.removeColumn('DailyJeSync', 'refundedFeeCents');
  },
};
