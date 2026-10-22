'use strict';

/**
 * Which upload says when a payout-report row was paid out: the one with the EARLIEST payout range
 * among all the uploads the row has appeared in (overlapping uploads are allowed). `uploadId` can't
 * say it - it is the upload that created the row, or the latest one that re-checked it.
 *
 * Kept on every import for every row of the file, so re-uploading a file with corrected (earlier)
 * payout dates corrects the rows too. Null on rows stored before this column: those fall back to
 * `uploadId`.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('PayoutTransactions', 'payoutUploadId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'PayoutReportUploads', key: 'id' },
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PayoutTransactions', 'payoutUploadId');
  },
};
