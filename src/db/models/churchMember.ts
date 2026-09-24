import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';
import Church from './church';

export type ChurchRole = 'owner' | 'bookkeeper';

/**
 * Who may work on a church, and as what. One row per person per church; an outstanding
 * invitation is a row with no userId yet. Replaces the (userId, clientId) pairs in
 * `bookkeeper` once everything reads churches.
 */
export interface ChurchMemberAttributes {
  id?: number;
  churchId: number;
  userId: number | null;
  role: ChurchRole;
  integrationAccessEnabled: boolean;
  invitedEmail: string | null;
  invitationToken: string | null;
  inviteAccepted: boolean;
}

class ChurchMember extends Model<ChurchMemberAttributes> implements ChurchMemberAttributes {
  public id!: number;
  public churchId!: number;
  public userId!: number | null;
  public role!: ChurchRole;
  public integrationAccessEnabled!: boolean;
  public invitedEmail!: string | null;
  public invitationToken!: string | null;
  public inviteAccepted!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ChurchMember.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, allowNull: false, primaryKey: true },
    churchId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    role: { type: DataTypes.ENUM('owner', 'bookkeeper'), allowNull: false },
    integrationAccessEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    invitedEmail: { type: DataTypes.STRING(256), allowNull: true },
    invitationToken: { type: DataTypes.STRING(256), allowNull: true },
    inviteAccepted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    sequelize,
    modelName: 'ChurchMembers',
    freezeTableName: true,
  },
);

ChurchMember.belongsTo(Church, { foreignKey: 'churchId', as: 'Church' });
ChurchMember.belongsTo(User, { foreignKey: 'userId', as: 'User' });
Church.hasMany(ChurchMember, { foreignKey: 'churchId', as: 'Members' });
User.hasMany(ChurchMember, { foreignKey: 'userId', as: 'Memberships' });

export default ChurchMember;
