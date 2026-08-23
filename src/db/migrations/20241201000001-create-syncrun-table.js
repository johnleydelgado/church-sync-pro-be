'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('SyncRun', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        allowNull: false,
        primaryKey: true,
      },
      trigger: {
        type: Sequelize.STRING,
      },
      startedAt: {
        type: Sequelize.DATE,
      },
      finishedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      processed: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      succeeded: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      failed: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      failures: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING,
        defaultValue: 'running',
      },
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

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('SyncRun');
  },
};
