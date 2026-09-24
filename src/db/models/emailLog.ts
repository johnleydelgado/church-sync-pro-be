import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

export interface EmailLogAttributes {
  id?: number;
  userId?: number;
  churchId?: number | null;
  emailType?: 'fund' | 'stripe' | string;
  createdAt?: Date;
  updatedAt?: Date;
}

class EmailLog extends Model<EmailLogAttributes> implements EmailLogAttributes {
  public id!: number;
  public userId!: number;
  public churchId!: number | null;
  public emailType!: 'fund' | 'stripe' | string;
  public createdAt!: Date;
  public updatedAt!: Date;
}

EmailLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    // Which church this row belongs to. Backfilled 2026-09; userId stays until the code reads churches.
    churchId: { type: DataTypes.INTEGER, allowNull: true },
    userId: {
      type: DataTypes.INTEGER,
    },
    emailType: {
      type: DataTypes.STRING,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'email_logs',
    freezeTableName: true,
    timestamps: true,
  },
);

User.hasOne(EmailLog, { foreignKey: 'userId' });
export default EmailLog;
