import { Model, DataTypes, Sequelize } from 'sequelize';
import sequelize from '..';

export interface UserAttributes {
  id?: number;
  email?: string;
  time_joined?: string;
  firstName?: string;
  lastName?: string;
  churchName?: string;
  isSubscribe: string;
  access_token_pc?: string;
  refresh_token_pc?: string;
  access_token_qbo?: string;
  refresh_token_qbo?: string;
  access_token_stripe?: string;
  refresh_token_stripe?: string;
  realm_id?: string;
}

class User extends Model<UserAttributes> implements UserAttributes {
  public id?: number;
  public email!: string;
  public firstName!: string;
  public lastName!: string;
  public churchName!: string;
  public isSubscribe!: string;
  public access_token_pc!: string;
  public refresh_token_pc!: string;
  public access_token_qbo!: string;
  public refresh_token_qbo!: string;
  public access_token_stripe!: string;
  public refresh_token_stripe!: string;
  public realm_id!: string;
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(256),
      allowNull: false,
    },
    firstName: {
      type: DataTypes.STRING(32),
    },
    lastName: {
      type: DataTypes.STRING(32),
    },
    churchName: {
      type: DataTypes.STRING(32),
    },
    isSubscribe: {
      type: DataTypes.STRING(1),
    },
    access_token_pc: {
      type: DataTypes.TEXT,
    },
    refresh_token_pc: {
      type: DataTypes.TEXT,
    },
    access_token_qbo: {
      type: DataTypes.TEXT,
    },
    refresh_token_qbo: {
      type: DataTypes.TEXT,
    },
    access_token_stripe: {
      type: DataTypes.TEXT,
    },
    refresh_token_stripe: {
      type: DataTypes.TEXT,
    },
    realm_id: {
      type: DataTypes.TEXT,
    },
  },
  {
    sequelize,
    modelName: 'Users',
    // timestamps: false,
    freezeTableName: true,
  },
);

export default User;
