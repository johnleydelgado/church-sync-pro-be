import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

/**
 * A church as its own record. Until 2026-09 a church was only a Users row with role
 * 'client' and a churchName; ownerUserId points back at that login for churches created
 * from one, and is null for churches that never had a login of their own.
 */
export interface ChurchAttributes {
  id?: number;
  name: string;
  ownerUserId: number | null;
  isActive: boolean;
}

class Church extends Model<ChurchAttributes> implements ChurchAttributes {
  public id!: number;
  public name!: string;
  public ownerUserId!: number | null;
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Church.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, allowNull: false, primaryKey: true },
    name: { type: DataTypes.STRING(256), allowNull: false },
    ownerUserId: { type: DataTypes.INTEGER, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    sequelize,
    modelName: 'Churches',
    freezeTableName: true,
  },
);

Church.belongsTo(User, { foreignKey: 'ownerUserId', as: 'Owner' });
User.hasMany(Church, { foreignKey: 'ownerUserId', as: 'OwnedChurches' });

export default Church;
