'use strict';

/**
 * Users.churchName was VARCHAR(32). "First Baptist Church of Springfield" is 35 characters,
 * and the failure was ugly: the SuperTokens user had already been created when the Users
 * insert was refused, leaving a login that could never finish signing up (found on
 * staging, 2026-09-25). First and last names get the same headroom.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Users', 'churchName', { type: Sequelize.STRING(256) });
    await queryInterface.changeColumn('Users', 'firstName', { type: Sequelize.STRING(64) });
    await queryInterface.changeColumn('Users', 'lastName', { type: Sequelize.STRING(64) });
  },

  async down(queryInterface, Sequelize) {
    // Shrinking fails if any row is longer than the old limit; that is the right outcome.
    await queryInterface.changeColumn('Users', 'lastName', { type: Sequelize.STRING(32) });
    await queryInterface.changeColumn('Users', 'firstName', { type: Sequelize.STRING(32) });
    await queryInterface.changeColumn('Users', 'churchName', { type: Sequelize.STRING(32) });
  },
};
