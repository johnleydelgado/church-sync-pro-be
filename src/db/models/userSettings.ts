import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import { Json } from 'sequelize/types/utils';
import User from './user';

export interface UserSettingsAttributes {
  id?: number;
  settingsData?: Json;
  settingRegistrationData?: Json;
  settingBankData?: Json;
  settingBankCharges?: Json;
  isAutomationEnable?: boolean;
  isAutomationRegistration?: boolean;
  userId?: number;
  startDateAutomationFund?: string;
  startDateAutomationRegistration?: string;
  clearingBalanceAtGoLiveCents?: number | null;
  clearingSnapshotAt?: Date | null;
  transitionTruedUpAt?: Date | null;
}

class UserSettings extends Model<UserSettingsAttributes> implements UserSettingsAttributes {
  public id!: number;
  public settingsData!: Json;
  public settingRegistrationData!: Json;
  public settingBankData!: Json;
  public settingBankCharges!: Json;
  public isAutomationEnable!: boolean;
  public isAutomationRegistration!: boolean;
  public userId!: number;
  public startDateAutomationFund!: string;
  public startDateAutomationRegistration!: string;
  public clearingBalanceAtGoLiveCents!: number | null;
  public clearingSnapshotAt!: Date | null;
  public transitionTruedUpAt!: Date | null;

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
    settingBankData: {
      type: DataTypes.JSON,
    },
    settingBankCharges: {
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
    startDateAutomationFund: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    startDateAutomationRegistration: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    clearingBalanceAtGoLiveCents: { type: DataTypes.BIGINT, allowNull: true },
    clearingSnapshotAt: { type: DataTypes.DATE, allowNull: true },
    transitionTruedUpAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'UserSettings',
    freezeTableName: true,
  },
);

User.hasOne(UserSettings, { foreignKey: 'userId' });
export default UserSettings;
