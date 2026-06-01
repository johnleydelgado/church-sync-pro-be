import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

export interface EmailLogAttributes {
  id?: number;
  userId?: number;
  emailType?: 'fund' | 'stripe' | string;
  createdAt?: Date;
  updatedAt?: Date;
}

class EmailLog extends Model<EmailLogAttributes> implements EmailLogAttributes {
  public id!: number;
  public userId!: number;
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
