import { Model, DataTypes, Sequelize } from 'sequelize';
import sequelize from '..';
import tokens from './tokens';
import userEmailPreferences from './userEmailPreferences';
import UserSettings from './userSettings';

export interface UserAttributes {
  id?: number;
  email?: string;
  time_joined?: string;
  firstName?: string;
  lastName?: string;
  churchName?: string;
  isSubscribe: string;
  role?: 'client' | 'bookkeeper';
  tokens?: tokens[];
  UserSetting?: UserSettings;
  userEmailPreferences?: userEmailPreferences[];
  token: string;
  img_url: string;
}

class User extends Model<UserAttributes> implements UserAttributes {
  public id?: number;
  public email!: string;
  public firstName!: string;
  public lastName!: string;
  public churchName!: string;
  public isSubscribe!: string;
  public token!: string;
  public img_url!: string;
  public role!: 'client' | 'bookkeeper';
  public tokens!: tokens[];
  public UserSetting!: UserSettings;
  public userEmailPreferences!: userEmailPreferences[];
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
    role: DataTypes.ENUM({
      values: ['client', 'bookkeeper'],
    }),
    token: {
      type: DataTypes.STRING(256),
    },
    img_url: {
      type: DataTypes.STRING(256),
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
