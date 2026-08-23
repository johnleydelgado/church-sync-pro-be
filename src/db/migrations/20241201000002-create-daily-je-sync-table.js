'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // One row per (userId, calendar day). Backs two things:
    //   1. The per-day lock (SELECT ... FOR UPDATE) that serializes concurrent batch
    //      contributions to the same day, so two workers can't both post a "first" entry.
    //   2. The running per-day totals, so a later contribution knows it must post an
    //      *adjusting* entry rather than a duplicate full entry.
    await queryInterface.createTable('DailyJeSync', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      // 'YYYY-MM-DD' - matches the dayKey() format, stored as text to avoid any
      // timezone coercion on the way in or out of the database.
      day: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      // Cumulative amounts already reflected in QuickBooks for this day, across the
      // original entry and every adjusting entry.
      postedGrossCents: {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
      },
      postedFeeCents: {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
      },
      // How many QBO entries exist for this day. 1 in the normal case; >1 only when
      // late donations forced adjusting entries.
      entryCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      // QBO JournalEntry Ids, in post order. First is the original entry.
      qboEntryIds: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      // PCO batch ids that have contributed to this day.
      batchIds: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('DailyJeSync', ['userId', 'day'], {
      name: 'daily_je_sync_user_day_unique',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('DailyJeSync', 'daily_je_sync_user_day_unique');
    await queryInterface.dropTable('DailyJeSync');
  },
};
