'use strict';

/**
 * A church becomes its own record.
 *
 * Until now "a church" was a Users row with role 'client' and a churchName column, so one
 * login could only ever be one church, and a bookkeeper's access had to be a row per
 * (bookkeeper, client-login) pair in `bookkeeper`. Churches holds the church itself;
 * ChurchMembers holds who may work on it and as what.
 *
 * Additive: nothing reads these tables yet. The backfill (…000003) fills them from the
 * existing client logins and bookkeeper rows.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Churches', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: Sequelize.STRING(256), allowNull: false },
      // The client login this church was created from. Null once churches can exist
      // without a login of their own.
      ownerUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'SET NULL',
      },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('ChurchMembers', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      churchId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Churches', key: 'id' },
        onDelete: 'CASCADE',
      },
      // Null while an invitation is outstanding; set when the invitee signs up.
      userId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.ENUM('owner', 'bookkeeper'), allowNull: false },
      // Whether this member may connect QuickBooks / Planning Center for the church.
      // Owners always can; this is the bookkeeper flag that lived on `bookkeeper`.
      integrationAccessEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      invitedEmail: { type: Sequelize.STRING(256), allowNull: true },
      invitationToken: { type: Sequelize.STRING(256), allowNull: true },
      inviteAccepted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // One membership per person per church. Outstanding invites have no userId yet, so
    // they are left out of the constraint (Postgres partial index).
    await queryInterface.addIndex('ChurchMembers', ['churchId', 'userId'], {
      unique: true,
      name: 'church_members_church_user_unique',
      where: { userId: { [Sequelize.Op.ne]: null } },
    });
    await queryInterface.addIndex('ChurchMembers', ['userId'], { name: 'church_members_user_idx' });
    await queryInterface.addIndex('Churches', ['ownerUserId'], { name: 'churches_owner_user_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ChurchMembers');
    await queryInterface.dropTable('Churches');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_ChurchMembers_role";');
  },
};
