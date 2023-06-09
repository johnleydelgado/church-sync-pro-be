import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import tokens from './tokens';
import bookkeeper from './bookkeeper';

export interface tokenEntityAttributes {
  id: number;
  email?: string;
  isEnabled: boolean;
  tokens?: tokens[];
  bookkeepers?: bookkeeper[];
}

class tokenEntity extends Model<tokenEntityAttributes> implements tokenEntityAttributes {
  public id!: number;
  public email!: string;
  public isEnabled!: boolean;
  public tokens!: tokens[];
  public bookkeepers!: bookkeeper[];
}

tokenEntity.init(
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
    isEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    modelName: 'token_entity',
    freezeTableName: true,
  },
);

export default tokenEntity;
