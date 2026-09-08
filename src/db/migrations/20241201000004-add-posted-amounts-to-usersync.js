'use strict';

/**
 * Records what each (user, batch, day) claim actually posted.
 *
 * The claim row was a bare flag: once `posted`, that batch could never contribute to that day
 * again. So when a batch's donation set GREW - the un-paginated fetch had truncated it at 25,
 * or the church reopened and re-committed the batch - the engine fetched the missing gifts and
 * then threw them away, reporting success. Storing the amounts lets the next run see the
 * difference and post it as an adjusting entry instead.
 *
 * `postedByAccount` keeps the per-revenue-account split so the adjusting entry credits the
 * right funds rather than lumping the difference onto one.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('UserSync', 'postedGrossCents', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('UserSync', 'postedFeeCents', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('UserSync', 'postedByAccount', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('UserSync', 'postedByAccount');
    await queryInterface.removeColumn('UserSync', 'postedFeeCents');
    await queryInterface.removeColumn('UserSync', 'postedGrossCents');
  },
};
