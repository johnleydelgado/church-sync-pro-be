import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';
import tokenEntity from './tokenEntity';

export interface userEmailPrefAttributes {
  id: number;
  email: string;
  userId: number;
  type: 'new-fund' | 'new-registration';
}

class userEmailPreferences extends Model<userEmailPrefAttributes> implements userEmailPrefAttributes {
  public id!: number;
  public email!: string;
  public type!: 'new-fund' | 'new-registration';
  public userId!: number;

  public readonly user?: User; // Define the association property
  public readonly token_entity?: tokenEntity; // Define the association property

  // Associate the UserSettings model with the Users model
  public static associate(models: any) {
    userEmailPreferences.belongsTo(models.User, {
      foreignKey: 'userId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
  }
}

userEmailPreferences.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(256),
      allowNull: false,
    },
    type: DataTypes.ENUM({
      values: ['stripe', 'qbo', 'pco'],
    }),
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'userEmailPreferences',
    freezeTableName: true,
  },
);

User.hasMany(userEmailPreferences, { foreignKey: 'userId' });
userEmailPreferences.belongsTo(User, { foreignKey: 'userId' });
export default userEmailPreferences;
