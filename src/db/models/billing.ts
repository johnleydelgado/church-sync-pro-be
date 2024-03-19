import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

export interface BillingAttributes {
  id?: number;
  userId?: number;
  name?: string;
  phone?: string;
  address?: string;
  email?: string;
  zipCode?: string;
}

class Billing extends Model<BillingAttributes> implements BillingAttributes {
  public id!: number;
  public userId!: number;
  public name!: string;
  public phone!: string;
  public address!: string;
  public email!: string;
  public zipCode!: string;
}

Billing.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
    },
    name: {
      type: DataTypes.STRING,
    },
    phone: {
      type: DataTypes.STRING,
    },
    address: {
      type: DataTypes.STRING,
    },
    email: {
      type: DataTypes.STRING,
    },
    zipCode: {
      type: DataTypes.STRING,
    },
  },
  {
    sequelize,
    modelName: 'billing',
    freezeTableName: true,
  },
);

User.hasOne(Billing, { foreignKey: 'userId' });
export default Billing;
