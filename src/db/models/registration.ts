import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import tokens from './tokens';
import bookkeeper from './bookkeeper';
import User from './user';

export interface registrationAttributes {
  id: number;
  name: string;
  userId: number;
}

class registration extends Model<registrationAttributes> implements registrationAttributes {
  public id!: number;
  public name!: string;
  public userId!: number;

  public static associate(models: any) {
    registration.belongsTo(models.User, {
      foreignKey: 'userId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
  }
}

registration.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(256),
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'registration',
    freezeTableName: true,
  },
);

User.hasMany(registration, { foreignKey: 'userId', as: 'UserRegistration' });

registration.belongsTo(User, { foreignKey: 'userId', as: 'User' });

export default registration;
