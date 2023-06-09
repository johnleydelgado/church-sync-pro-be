import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import { Json } from 'sequelize/types/utils';
import User from './user';
import tokenEntity from './tokenEntity';

export interface tokenAttributes {
  id: number;
  userId: number;
  clientId: number;
  email: string;
  invitationToken: string;
  inviteSent: boolean;
  inviteAccepted: boolean;
}

class bookkeeper extends Model<tokenAttributes> implements tokenAttributes {
  public id!: number;
  public userId!: number;
  public clientId!: number;
  public email!: string;
  public invitationToken!: string;
  public inviteSent!: boolean;
  public inviteAccepted!: boolean;

  public readonly user?: User; // Define the association property
  public readonly token_entity?: tokenEntity; // Define the association property

  // Associate the UserSettings model with the Users model
  public static associate(models: any) {
    bookkeeper.belongsTo(models.User, {
      foreignKey: 'userId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    bookkeeper.belongsTo(models.tokenEntity, {
      foreignKey: 'tokenEntityId',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
  }
}

bookkeeper.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      primaryKey: true,
    },
    clientId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
    },
    email: {
      type: DataTypes.STRING(256),
      allowNull: false,
    },
    invitationToken: {
      type: DataTypes.STRING(256),
      allowNull: false,
    },
    inviteSent: DataTypes.BOOLEAN,
    inviteAccepted: DataTypes.BOOLEAN,
  },
  {
    sequelize,
    modelName: 'bookkeeper',
    freezeTableName: true,
  },
);

User.hasMany(bookkeeper, { foreignKey: 'userId', as: 'UserBookkeepers' });
User.hasMany(bookkeeper, { foreignKey: 'clientId', as: 'ClientBookkeepers' });

bookkeeper.belongsTo(User, { foreignKey: 'userId', as: 'User' });
bookkeeper.belongsTo(User, { foreignKey: 'clientId', as: 'Client' });
export default bookkeeper;
