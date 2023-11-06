'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('UserSettings', 'settingBankData', {
      type: Sequelize.JSON,
      allowNull: true,
    });

  
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('UserSettings', 'settingBankData');
  }
};
