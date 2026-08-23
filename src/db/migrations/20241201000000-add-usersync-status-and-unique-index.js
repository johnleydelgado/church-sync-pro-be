'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add `status` column. Default to 'pending' for the claim-then-post flow.
    await queryInterface.addColumn('UserSync', 'status', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'pending',
    });

    // 2. Existing rows represent completed syncs -> mark them as 'posted'.
    await queryInterface.sequelize.query(`UPDATE "UserSync" SET "status" = 'posted';`);

    // 3. Dedupe any existing duplicate (userId, batchId, donationId) tuples before
    //    creating the unique index, otherwise the index creation will fail.
    //    Keep the lowest id per tuple, delete the rest.
    await queryInterface.sequelize.query(`
      DELETE FROM "UserSync" a
      USING "UserSync" b
      WHERE a."id" > b."id"
        AND a."userId" IS NOT DISTINCT FROM b."userId"
        AND a."batchId" IS NOT DISTINCT FROM b."batchId"
        AND a."donationId" IS NOT DISTINCT FROM b."donationId";
    `);

    // 4. Add the unique index that backs the atomic findOrCreate claim.
    await queryInterface.addIndex('UserSync', ['userId', 'batchId', 'donationId'], {
      name: 'user_sync_user_batch_donation_unique',
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('UserSync', 'user_sync_user_batch_donation_unique');
    await queryInterface.removeColumn('UserSync', 'status');
  },
};
