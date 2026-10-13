import { Model, DataTypes } from 'sequelize';
import sequelize from '..';
import User from './user';

/**
 * posted / resolved      - in QuickBooks through CSP (counts in Clearing)
 * pending                - being posted; if a crash leaves it behind it goes to review, never auto-retried
 * failed                 - QuickBooks rejected the entry; retried on the next upload
 * before_start           - registration charged before the registration start date
 * giving_covered         - giving line whose day CSP has fully posted (or before the giving start date)
 * giving_not_posted      - giving line whose day is not (fully) in QuickBooks yet
 * held                   - not recognised; waits in the review list
 * dismissed              - a person marked it handled outside CSP (with a note)
 */
export type PayoutTransactionStatus =
  | 'posted'
  | 'pending'
  | 'failed'
  | 'before_start'
  | 'giving_covered'
  | 'giving_not_posted'
  | 'held'
  | 'resolved'
  | 'dismissed';

export interface PayoutTransactionAttributes {
  id?: number;
  userId?: number;
  uploadId?: number | null;
  rowKey?: string;
  line?: number | null;
  day?: string;
  type?: string;
  source?: string;
  name?: string | null;
  fundOrSignup?: string | null;
  // BIGINT: Postgres returns these as strings - wrap every read in Number().
  grossCents?: number | string;
  feeCents?: number | string;
  netCents?: number | string;
  paymentMethod?: string | null;
  description?: string | null;
  status?: PayoutTransactionStatus;
  reason?: string | null;
  accountRef?: string | null;
  classRef?: string | null;
  qboEntryId?: string | null;
  note?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One row per payout-report line a church has ever uploaded, unique on (userId, rowKey). That
 * uniqueness is what makes re-uploading a file - or an overlapping one - safe: a row is posted at
 * most once, whoever inserts it first.
 */
class PayoutTransaction extends Model<PayoutTransactionAttributes> implements PayoutTransactionAttributes {
  public id!: number;
  public userId!: number;
  public uploadId!: number | null;
  public rowKey!: string;
  public line!: number | null;
  public day!: string;
  public type!: string;
  public source!: string;
  public name!: string | null;
  public fundOrSignup!: string | null;
  public grossCents!: number | string;
  public feeCents!: number | string;
  public netCents!: number | string;
  public paymentMethod!: string | null;
  public description!: string | null;
  public status!: PayoutTransactionStatus;
  public reason!: string | null;
  public accountRef!: string | null;
  public classRef!: string | null;
  public qboEntryId!: string | null;
  public note!: string | null;
  public resolvedBy!: string | null;
  public resolvedAt!: Date | null;
  public createdAt!: Date;
  public updatedAt!: Date;
}

PayoutTransaction.init(
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
    uploadId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    rowKey: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    line: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    day: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    fundOrSignup: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    grossCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    feeCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    netCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    paymentMethod: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    reason: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    accountRef: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    classRef: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    qboEntryId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    resolvedBy: {
      type: DataTypes.STRING(256),
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
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
    modelName: 'PayoutTransactions',
    freezeTableName: true,
    timestamps: true,
  },
);

User.hasMany(PayoutTransaction, { foreignKey: 'userId' });
export default PayoutTransaction;
