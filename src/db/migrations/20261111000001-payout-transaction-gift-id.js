'use strict';

/**
 * Which Planning Center gift a payout-report line belongs to, when its own description doesn't say.
 *
 * Planning Center prints "Donation #<id>" only on a gift's charge. When the donor's bank returns a bank
 * (ACH) gift, the file adds Stripe's own lines for it - "Charge failure" ("Funds reversed due to payment
 * py_... failed") and "Fee" ("Application fee refund for py_...") - which carry only Stripe's payment id.
 * CSP links them to the gift when it records the file and keeps the link here, so the review list can
 * say what the returned gift cost. Nullable: most lines need no link.
 * docs/plans/2026-11-10-payout-bounces.md in the frontend repo.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('PayoutTransactions', 'giftDonationId', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PayoutTransactions', 'giftDonationId');
  },
};
