import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import { Json } from 'sequelize/types/utils';
import User from './user';

export interface UserSettingsAttributes {
  id?: number;
  settingsData?: Json;
  settingRegistrationData?: Json;
  isAutomationEnable?: boolean;
  isAutomationRegistration?: boolean;
  userId?: number;
}

class UserSettings extends Model<UserSettingsAttributes> implements UserSettingsAttributes {
  public id!: number;
  public settingsData!: Json;
  public settingRegistrationData!: Json;
  public isAutomationEnable!: boolean;
  public isAutomationRegistration!: boolean;
  public userId!: number;

  public readonly user?: User; // Define the association property

  // Associate the UserSettings model with the Users model
  public static associate(models: any) {
    UserSettings.belongsTo(models.User, {
      foreignKey: 'userId',
    });
  }
}

UserSettings.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    settingsData: {
      type: DataTypes.JSON,
    },
    settingRegistrationData: {
      type: DataTypes.JSON,
    },
    isAutomationEnable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    isAutomationRegistration: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
    },
  },
  {
    sequelize,
    modelName: 'UserSettings',
    freezeTableName: true,
  },
);

User.hasOne(UserSettings, { foreignKey: 'userId' });
export default UserSettings;
