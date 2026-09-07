import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

export interface DailyJeSyncAttributes {
  id?: number;
  userId?: number;
  day?: string;
  postedGrossCents?: number;
  postedFeeCents?: number;
  refundedGrossCents?: number;
  refundedFeeCents?: number;
  entryCount?: number;
  qboEntryIds?: string[] | null;
  batchIds?: string[] | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One row per (userId, calendar day) - the per-day ledger behind "one journal entry per day".
 *
 * Serves two purposes:
 *  1. Concurrency lock. Contributions to the same day are serialized with a row-level
 *     `SELECT ... FOR UPDATE`, so two workers processing different PCO batches that both
 *     contain donations for the same day cannot each post a "first" entry.
 *  2. Running totals. `entryCount > 0` means the day already has an entry in QuickBooks, so
 *     any further donations for that day must be posted as an *adjusting* entry covering only
 *     the new amount, rather than a duplicate full entry.
 */
class DailyJeSync extends Model<DailyJeSyncAttributes> implements DailyJeSyncAttributes {
  public id!: number;
  public userId!: number;
  public day!: string;
  public postedGrossCents!: number;
  public postedFeeCents!: number;
  public refundedGrossCents!: number;
  public refundedFeeCents!: number;
  public entryCount!: number;
  public qboEntryIds!: string[] | null;
  public batchIds!: string[] | null;
  public createdAt!: Date;
  public updatedAt!: Date;

  public static associate(models: any) {
    DailyJeSync.belongsTo(models.Users, { foreignKey: 'userId' });
  }
}

DailyJeSync.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    day: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    postedGrossCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    postedFeeCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    // Reversed on this day by refunds (grouped by the refund date, not the gift date).
    refundedGrossCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    refundedFeeCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    entryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    qboEntryIds: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    batchIds: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'DailyJeSync',
    freezeTableName: true,
    timestamps: true,
  },
);

User.hasMany(DailyJeSync, { foreignKey: 'userId' });
export default DailyJeSync;
