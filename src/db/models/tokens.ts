import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';
import tokenEntity from './tokenEntity';

export interface tokenAttributes {
  id: number;
  userId: number;
  tokenEntityId: number;
  token_type: 'stripe' | 'qbo' | 'pco';
  access_token: string;
  refresh_token: string;
  realm_id: string;
  organization_name: string;
}

class tokens extends Model<tokenAttributes> implements tokenAttributes {
  public id!: number;
  public token_type!: 'stripe' | 'qbo' | 'pco';
  public access_token!: string;
  public refresh_token!: string;
  public realm_id!: string;
  public userId!: number;
  public tokenEntityId!: number;
  public organization_name!: string;

  public readonly user?: User; // Define the association property
  public readonly token_entity?: tokenEntity; // Define the association property

  // Associate the UserSettings model with the Users model
  public static associate(models: any) {
    tokens.belongsTo(models.User, {
      foreignKey: 'userId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    tokens.belongsTo(models.tokenEntity, {
      foreignKey: 'tokenEntityId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
  }
}

tokens.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tokenEntityId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    token_type: DataTypes.ENUM({
      values: ['stripe', 'qbo', 'pco'],
    }),
    access_token: DataTypes.TEXT,
    refresh_token: DataTypes.TEXT,
    realm_id: DataTypes.TEXT,
    organization_name: DataTypes.TEXT,
  },
  {
    sequelize,
    modelName: 'tokens',
    freezeTableName: true,
  },
);

User.hasMany(tokens, { foreignKey: 'userId' });
tokenEntity.hasMany(tokens, { foreignKey: 'tokenEntityId' });

tokens.belongsTo(User, { foreignKey: 'userId' });
tokens.belongsTo(tokenEntity, { foreignKey: 'tokenEntityId' });
export default tokens;
