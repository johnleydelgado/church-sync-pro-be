'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('Users', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement:true,
        allowNull: false,
        primaryKey: true
      },
      firstName: Sequelize.DataTypes.STRING(32),
      lastName: Sequelize.DataTypes.STRING(32),
      churchName: { type:Sequelize.DataTypes.STRING(32),allowNull:true },
      isSubscribe: Sequelize.DataTypes.STRING(1),
      email: Sequelize.DataTypes.STRING(256),
      role: Sequelize.DataTypes.ENUM({
        values: ['client', 'bookkeeper']
      }),
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updatedAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.createTable('UserSettings', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true
      },
      settingsData: {
        type: Sequelize.JSON,
        allowNull: true
      },
      settingRegistrationData:{
        type: Sequelize.JSON,
        allowNull: true
      },
      isAutomationEnable: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    })

    await queryInterface.createTable('UserSync', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true
      },
      batchId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      syncedData: {
        type: Sequelize.JSON,
        allowNull: true
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    })
  },

  

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('UserSettings');
    await queryInterface.dropTable('UserSync');
    await queryInterface.dropTable('Users');
  }
};
