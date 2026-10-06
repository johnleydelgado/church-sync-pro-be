/**
 * The Daily Sync list. A day that took an adjusting entry used to show only that latest entry,
 * and "posted by CSP to date" summed those partial rows - Active Church's page read $18,180.07
 * when CSP had posted $29,262.36. Every model and third party is faked; this proves the
 * controller builds each row from the day's running totals and the headline from the ledger.
 */
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/userSettings', () => ({ __esModule: true, default: { findOne: jest.fn(), update: jest.fn() } }));
jest.mock('../../db/models/UserSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../db/models/SyncRun', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../services/donationSweep', () => ({ fetchDonationsForDay: jest.fn(), fetchDonationsForRange: jest.fn() }));
jest.mock('../../services/dailyDonationSync', () => {
  const actual = jest.requireActual('../../services/dailyDonationSync');
  return { ...actual, getOrgTimeZone: jest.fn(), runDailyDonationSync: jest.fn() };
});
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => {
  const actual = jest.requireActual('../../services/clearingSnapshot');
  return { ...actual, readQboClearingBalance: jest.fn(), captureClearingSnapshot: jest.fn() };
});

import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import UserSync from '../../db/models/UserSync';
import SyncRun from '../../db/models/SyncRun';
import DailyJeSync from '../../db/models/DailyJeSync';
import { readQboClearingBalance } from '../../services/clearingSnapshot';
import { getDailyJournalEntries } from '../journalEntry';

const users = Users as unknown as { findOne: jest.Mock };
const settings = UserSettings as unknown as { findOne: jest.Mock };
const claims = UserSync as unknown as { findAll: jest.Mock };
const runs = SyncRun as unknown as { findOne: jest.Mock };
const ledger = DailyJeSync as unknown as { findAll: jest.Mock };
const qbo = readQboClearingBalance as unknown as jest.Mock;

const row = (data: any) => ({ toJSON: () => data });
const line = (type: 'Credit' | 'Debit', amount: number, account: string) => ({
  Amount: amount,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: { PostingType: type, AccountRef: { value: account } },
});

// Active Church, production, 2026-09-15 and 2026-09-16: the first took an adjusting entry.
const sept15Claim = {
  donationId: '2026-09-15',
  batchId: 'daily-2026-09-15',
  status: 'posted',
  syncedData: {
    Line: [line('Credit', 487.6, 'tithes'), line('Debit', 0.9, 'fees'), line('Debit', 486.7, 'clearing')],
    PrivateNote: 'Church Sync Pro - PCO Electronic Giving Adjustment - 2026-09-15',
  },
  postedGrossCents: '141346',
  postedFeeCents: '2231',
  postedByAccount: { tithes: 141346 },
};
const sept16Claim = {
  donationId: '2026-09-16',
  batchId: 'daily-2026-09-16',
  status: 'posted',
  syncedData: {
    Line: [line('Credit', 1220.03, 'tithes'), line('Debit', 6.52, 'fees'), line('Debit', 1213.51, 'clearing')],
    PrivateNote: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-09-16',
  },
  postedGrossCents: '122003',
  postedFeeCents: '652',
  postedByAccount: { tithes: 122003 },
};
const sept15Ledger = { day: '2026-09-15', postedGrossCents: '141346', postedFeeCents: '2231', refundedGrossCents: '0', refundedFeeCents: '0', entryCount: 2, qboEntryIds: ['20963', '21008'] };
const sept16Ledger = { day: '2026-09-16', postedGrossCents: '122003', postedFeeCents: '652', refundedGrossCents: '0', refundedFeeCents: '0', entryCount: 1, qboEntryIds: ['21009'] };

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const list = async (opts: { claims: any[]; ledgers: any[] }) => {
  users.findOne.mockResolvedValue(row({ id: 1 }));
  settings.findOne.mockResolvedValue({
    settingsData: [{ account: { value: 'tithes', label: 'Tithes & Offerings' } }],
    settingBankData: [{ type: 'donation', value: 'clearing', label: 'Clearing Account' }],
    isAutomationEnable: false,
  });
  claims.findAll.mockResolvedValue(opts.claims.map(row));
  ledger.findAll.mockResolvedValue(opts.ledgers);
  runs.findOne.mockResolvedValue(null);
  qbo.mockResolvedValue(-4681.01);
  const res = makeRes();
  await getDailyJournalEntries({ query: { email: 'matt@example.test' } } as any, res);
  return res.json.mock.calls[0][0].data;
};

beforeEach(() => jest.clearAllMocks());

describe('getDailyJournalEntries: a day is its total, not its latest entry', () => {
  test('a day posted as two entries shows both together', async () => {
    const d = await list({ claims: [sept16Claim, sept15Claim], ledgers: [sept15Ledger, sept16Ledger] });
    const sept15 = d.entries.find((e: any) => e.date === '2026-09-15');

    expect(sept15).toMatchObject({ gross: 1413.46, fees: 22.31, net: 1391.15, status: 'posted' });
    expect(sept15.credits).toEqual([{ accountRef: 'tithes', amount: 1413.46, accountName: 'Tithes & Offerings' }]);
    expect(sept15.memo).toBe('Posted as 2 QuickBooks entries: #20963, #21008');
  });

  test('a single-entry day is unchanged', async () => {
    const d = await list({ claims: [sept16Claim, sept15Claim], ledgers: [sept15Ledger, sept16Ledger] });
    const sept16 = d.entries.find((e: any) => e.date === '2026-09-16');

    expect(sept16).toMatchObject({ gross: 1220.03, fees: 6.52, net: 1213.51 });
    expect(sept16.memo).toBe('Church Sync Pro - PCO Electronic Giving Sync - 2026-09-16');
  });

  test('"posted by CSP to date" is the ledger total the clearing statement uses', async () => {
    const d = await list({ claims: [sept16Claim, sept15Claim], ledgers: [sept15Ledger, sept16Ledger] });

    expect(d.clearingBalance).toBe(2604.66); // 1,391.15 + 1,213.51, not 486.70 + 1,213.51
    expect(d.qboClearingBalance).toBe(-4681.01);
  });

  test('refunds come off "posted to date" exactly as they do on the statement', async () => {
    const refunded = { ...sept16Ledger, refundedGrossCents: '10000', refundedFeeCents: '30' };
    const d = await list({ claims: [sept16Claim], ledgers: [refunded] });

    expect(d.clearingBalance).toBe(1113.81); // 1,213.51 - (100.00 - 0.30)
  });
});
