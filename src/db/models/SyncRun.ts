import { Model, DataTypes } from 'sequelize';
import sequelize from '..';

export interface SyncRunFailure {
  email: string;
  error?: string;
}

export interface SyncRunAttributes {
  id?: number;
  trigger?: 'automationScheduler' | 'latestFundAutomation' | string;
  startedAt?: Date;
  finishedAt?: Date | null;
  processed?: number;
  succeeded?: number;
  failed?: number;
  failures?: SyncRunFailure[] | null;
  skipped?: number;
  skips?: { email: string; reason: string }[] | null;
  status?: 'running' | 'completed' | 'errored' | string;
  createdAt?: Date;
  updatedAt?: Date;
}

class SyncRun extends Model<SyncRunAttributes> implements SyncRunAttributes {
  public id!: number;
  public trigger!: 'automationScheduler' | 'latestFundAutomation' | string;
  public startedAt!: Date;
  public finishedAt!: Date | null;
  public processed!: number;
  public succeeded!: number;
  public failed!: number;
  public failures!: SyncRunFailure[] | null;
  /** Churches the run passed over, and the named reason for each. */
  public skipped!: number;
  public skips!: { email: string; reason: string }[] | null;
  public status!: 'running' | 'completed' | 'errored' | string;
  public createdAt!: Date;
  public updatedAt!: Date;
}

SyncRun.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    trigger: {
      type: DataTypes.STRING,
    },
    startedAt: {
      type: DataTypes.DATE,
    },
    finishedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    processed: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    succeeded: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    failed: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    skipped: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    skips: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    failures: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'running',
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
    modelName: 'SyncRun',
    freezeTableName: true,
    timestamps: true,
  },
);

export default SyncRun;
