'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'isActive', {
      type: Sequelize.BOOLEAN,
      defaultValue: true, // Set default value to true
      allowNull: false,   // Optional: Prevent null values
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Users', 'isActive');
  }
};
