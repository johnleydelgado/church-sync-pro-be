import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import { Json } from 'sequelize/types/utils';
import User from './user';

export interface UserSyncAttributes {
  id?: number;
  syncedData?: Json | any[];
  batchId?: string;
  donationId?: string;
  userId?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

class UserSync extends Model<UserSyncAttributes> implements UserSyncAttributes {
  public id!: number;
  public syncedData!: Json;
  public batchId!: string;
  public donationId!: string;
  public userId!: number;
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
