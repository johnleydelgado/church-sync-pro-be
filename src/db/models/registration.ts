import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import tokens from './tokens';
import bookkeeper from './bookkeeper';
import User from './user';

export interface registrationAttributes {
  id: number;
  name: string;
  userId: number;
  churchId?: number | null;
}

class registration extends Model<registrationAttributes> implements registrationAttributes {
  public id!: number;
  public name!: string;
  public userId!: number;
  public churchId!: number | null;

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
    // Which church this row belongs to. Backfilled 2026-09; userId stays until the code reads churches.
    churchId: { type: DataTypes.INTEGER, allowNull: true },
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
