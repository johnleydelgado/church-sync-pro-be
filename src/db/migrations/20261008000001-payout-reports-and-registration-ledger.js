'use strict';

/**
 * Registrations from Planning Center's payout report (see docs/plans/2026-10-08-registrations-import.md
 * in the frontend repo). One row per upload, one row per file row ever seen (unique per church, so
 * a re-upload never posts twice), and registration totals on the existing day ledger so the
 * Clearing statement counts them.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PayoutReportUploads', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onDelete: 'CASCADE' },
      fileName: { type: Sequelize.STRING(512), allowNull: true },
      uploadedBy: { type: Sequelize.STRING(256), allowNull: true },
      rowCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      firstDay: { type: Sequelize.STRING(10), allowNull: true },
      lastDay: { type: Sequelize.STRING(10), allowNull: true },
      summary: { type: Sequelize.JSON, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.createTable('PayoutTransactions', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onDelete: 'CASCADE' },
      uploadId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'PayoutReportUploads', key: 'id' },
        onDelete: 'SET NULL',
      },
      rowKey: { type: Sequelize.STRING(128), allowNull: false },
      line: { type: Sequelize.INTEGER, allowNull: true },
      day: { type: Sequelize.STRING(10), allowNull: false },
      type: { type: Sequelize.STRING(32), allowNull: false },
      source: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(256), allowNull: true },
      fundOrSignup: { type: Sequelize.STRING(512), allowNull: true },
      grossCents: { type: Sequelize.BIGINT, allowNull: false },
      feeCents: { type: Sequelize.BIGINT, allowNull: false },
      netCents: { type: Sequelize.BIGINT, allowNull: false },
      paymentMethod: { type: Sequelize.STRING(32), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false },
      reason: { type: Sequelize.STRING(64), allowNull: true },
      accountRef: { type: Sequelize.STRING(64), allowNull: true },
      classRef: { type: Sequelize.STRING(64), allowNull: true },
      qboEntryId: { type: Sequelize.STRING(64), allowNull: true },
      note: { type: Sequelize.TEXT, allowNull: true },
      resolvedBy: { type: Sequelize.STRING(256), allowNull: true },
      resolvedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.addIndex('PayoutTransactions', ['userId', 'rowKey'], {
      unique: true,
      name: 'payout_transactions_user_row_key',
    });
    await queryInterface.addIndex('PayoutTransactions', ['userId', 'status'], { name: 'payout_transactions_user_status' });

    for (const col of ['registrationGrossCents', 'registrationFeeCents', 'registrationRefundGrossCents', 'registrationRefundFeeCents']) {
      await queryInterface.addColumn('DailyJeSync', col, { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 });
    }
    await queryInterface.addColumn('DailyJeSync', 'registrationEntryCount', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('DailyJeSync', 'registrationEntryIds', { type: Sequelize.JSON, allowNull: true });
  },

  async down(queryInterface) {
    for (const col of [
      'registrationEntryIds',
      'registrationEntryCount',
      'registrationRefundFeeCents',
      'registrationRefundGrossCents',
      'registrationFeeCents',
      'registrationGrossCents',
    ]) {
      await queryInterface.removeColumn('DailyJeSync', col);
    }
    await queryInterface.dropTable('PayoutTransactions');
    await queryInterface.dropTable('PayoutReportUploads');
  },
};
