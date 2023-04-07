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
      churchName: Sequelize.DataTypes.STRING(32),
      isSubscribe: Sequelize.DataTypes.STRING(1),
      email: Sequelize.DataTypes.STRING(256),
      access_token_pc: Sequelize.DataTypes.TEXT,
      refresh_token_pc: Sequelize.DataTypes.TEXT,
      access_token_qbo: Sequelize.DataTypes.TEXT,
      refresh_token_qbo: Sequelize.DataTypes.TEXT,
      realm_id: Sequelize.DataTypes.TEXT,
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
    await queryInterface.dropTable('Users');
    await queryInterface.dropTable('UserSync');
  }
};
