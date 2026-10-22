import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

export interface PayoutReportUploadAttributes {
  id?: number;
  userId?: number;
  fileName?: string | null;
  uploadedBy?: string | null;
  rowCount?: number;
  firstDay?: string | null;
  lastDay?: string | null;
  // The payout dates the file covers (YYYY-MM-DD), as the bookkeeper entered them. Null on uploads
  // made before the field existed.
  payoutFrom?: string | null;
  payoutTo?: string | null;
  summary?: any;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One row per payout report a church uploaded: the audit trail, and what the Clearing page shows
 * as "last payout report loaded". The rows of the file live in `PayoutTransactions`.
 *
 * `firstDay` / `lastDay` are the CHARGE dates in the file; `payoutFrom` / `payoutTo` are the PAYOUT
 * dates it was exported for, which is what says when its rows were paid out.
 */
class PayoutReportUpload extends Model<PayoutReportUploadAttributes> implements PayoutReportUploadAttributes {
  public id!: number;
  public userId!: number;
  public fileName!: string | null;
  public uploadedBy!: string | null;
  public rowCount!: number;
  public firstDay!: string | null;
  public lastDay!: string | null;
  public payoutFrom!: string | null;
  public payoutTo!: string | null;
  public summary!: any;
  public createdAt!: Date;
  public updatedAt!: Date;
}

PayoutReportUpload.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    fileName: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    uploadedBy: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    rowCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    firstDay: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    lastDay: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    payoutFrom: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    payoutTo: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    summary: {
      type: DataTypes.JSON,
      allowNull: true,
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
    modelName: 'PayoutReportUploads',
    freezeTableName: true,
    timestamps: true,
  },
);

User.hasMany(PayoutReportUpload, { foreignKey: 'userId' });
export default PayoutReportUpload;
