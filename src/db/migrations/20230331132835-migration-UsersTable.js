'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    return queryInterface.createTable('Users', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement:true,
        allowNull: false,
        primaryKey: true
      },
      firstName: Sequelize.DataTypes.STRING(32),
      lastName: Sequelize.DataTypes.STRING(32),
      churchName: Sequelize.DataTypes.STRING(32),
      isSubscribe: Sequelize.DataTypes.STRING(1),
      email: Sequelize.DataTypes.STRING(256),
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updatedAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.fn('NOW'),
      },
    });
  },

  async down (queryInterface, Sequelize) {
    return queryInterface.dropTable('Users');
  }
};
