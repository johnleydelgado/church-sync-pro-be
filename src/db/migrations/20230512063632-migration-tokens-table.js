'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('tokens', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement:true,
        allowNull: false,
        primaryKey: true
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
      tokenEntityId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'token_entity',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      token_type: Sequelize.DataTypes.ENUM({
        values: ['stripe', 'qbo', 'pco']
      }),
      access_token: Sequelize.DataTypes.TEXT,
      refresh_token: Sequelize.DataTypes.TEXT,
      realm_id: Sequelize.DataTypes.TEXT,
      organization_name: Sequelize.DataTypes.TEXT,
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
    await queryInterface.dropTable('tokens');
  }
};
