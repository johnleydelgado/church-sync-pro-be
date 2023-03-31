import { Model, DataTypes, Sequelize } from 'sequelize';
import sequelize from '..';

interface UserAttributes {
  id?: string;
  email?: string;
  time_joined?: string;
  firstName?: string;
  lastName?: string;
  churchName?: string;
  isSubscribe: string;
}

class User extends Model<UserAttributes> implements UserAttributes {
  public id?: string;
  public email!: string;
  public firstName!: string;
  public lastName!: string;
  public churchName!: string;
  public isSubscribe!: string;
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
  },
  {
    sequelize,
    modelName: 'Users',
    // timestamps: false,
    freezeTableName: true,
  },
);

export default User;
