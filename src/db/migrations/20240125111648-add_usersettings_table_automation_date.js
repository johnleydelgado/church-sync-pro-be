'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('UserSettings', 'startDateAutomationFund', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('UserSettings', 'startDateAutomationRegistration', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('UserSettings', 'startDateAutomationFund');
    await queryInterface.removeColumn('UserSettings', 'startDateAutomationRegistration');
  }
};
