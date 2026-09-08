import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import { Json } from 'sequelize/types/utils';
import User from './user';

export interface UserSyncAttributes {
  id?: number;
  syncedData?: Json | any[];
  /** What this (user, batch, day) claim has actually posted so far. */
  postedGrossCents?: number | null;
  postedFeeCents?: number | null;
  postedByAccount?: Record<string, number> | null;
  batchId?: string;
  donationId?: string;
  userId?: number;
  status?: 'pending' | 'posted' | 'failed';
  createdAt?: Date;
  updatedAt?: Date;
}

class UserSync extends Model<UserSyncAttributes> implements UserSyncAttributes {
  public id!: number;
  public syncedData!: Json;
  public postedGrossCents!: number | null;
  public postedFeeCents!: number | null;
  public postedByAccount!: Record<string, number> | null;
  public batchId!: string;
  public donationId!: string;
  public userId!: number;
  public status!: 'pending' | 'posted' | 'failed';
  public createdAt!: Date;
  public updatedAt!: Date;

  public readonly user?: User; // Define the association property

  // Associate the UserSync model with the Users model
  public static associate(models: any) {
    UserSync.belongsTo(models.Users, {
      foreignKey: 'userId',
    });
  }
}

UserSync.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    syncedData: {
      type: DataTypes.JSON,
    },
    postedGrossCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    postedFeeCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    postedByAccount: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    batchId: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
    },
    donationId: {
      type: DataTypes.STRING,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'UserSync',
    freezeTableName: true,
    timestamps: true,
  },
);

User.hasOne(UserSync, { foreignKey: 'userId' });
export default UserSync;
