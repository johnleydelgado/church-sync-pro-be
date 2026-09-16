jest.mock('../../db/models/userSettings', () => ({ __esModule: true, default: { findOne: jest.fn(), update: jest.fn() } }));
jest.mock('../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../qboClient', () => ({ getQboTokensForUser: jest.fn().mockResolvedValue({}) }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));

import UserSettings from '../../db/models/userSettings';
import DailyJeSync from '../../db/models/DailyJeSync';
import quickBookApi from '../../utils/quickBookApi';
import { captureClearingSnapshot, netCentsOf } from '../clearingSnapshot';

const settings = UserSettings as unknown as { findOne: jest.Mock; update: jest.Mock };
const ledger = DailyJeSync as unknown as { findAll: jest.Mock };
const qbApi = quickBookApi as unknown as jest.Mock;

const withQboBalance = (balance: number | Error) =>
  qbApi.mockReturnValue({
    getAccount: (_id: string, cb: (e: any, d: any) => void) =>
      balance instanceof Error ? cb(balance, null) : cb(null, { CurrentBalance: balance }),
  });

const row = (gross: number, fee: number, day = '2026-09-15') => ({ toJSON: () => ({ day, postedGrossCents: gross, postedFeeCents: fee }) });

beforeEach(() => {
  jest.clearAllMocks();
  settings.findOne.mockResolvedValue({
    settingBankData: [{ type: 'donation', value: '175000', label: 'Clearing' }],
    startDateAutomationFund: '09-15-2026',
  });
  settings.update.mockResolvedValue([1]);
});

describe('netCentsOf', () => {
  test('gross minus fees minus refunds, treating missing columns as zero', () => {
    expect(netCentsOf({ postedGrossCents: 92586, postedFeeCents: 2141 })).toBe(90445);
    expect(netCentsOf({ postedGrossCents: 100, postedFeeCents: 32, refundedGrossCents: 100, refundedFeeCents: 32 })).toBe(0);
  });
});

describe('captureClearingSnapshot', () => {
  test("stores the balance net of CSP's own postings - Matt's account", async () => {
    // QuickBooks holds 904.45 and that is exactly CSP's one entry, so the church started from zero.
    withQboBalance(904.45);
    ledger.findAll.mockResolvedValue([row(92586, 2141)]);
    const cents = await captureClearingSnapshot('matt@example.test', 1);
    expect(cents).toBe(0);
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ clearingBalanceAtGoLiveCents: 0, clearingSnapshotAt: expect.any(Date) }),
      { where: { userId: 1 } },
    );
  });

  test("keeps a pre-existing balance that was never CSP's - the sandbox account", async () => {
    withQboBalance(3662.88);
    ledger.findAll.mockResolvedValue([row(100, 32)]);
    expect(await captureClearingSnapshot('a@b.test', 7)).toBe(366220);
  });

  test('records nothing rather than a wrong number when QuickBooks cannot be read', async () => {
    withQboBalance(new Error('token revoked'));
    ledger.findAll.mockResolvedValue([]);
    expect(await captureClearingSnapshot('a@b.test', 7)).toBeNull();
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ clearingBalanceAtGoLiveCents: null, clearingSnapshotAt: null }),
      { where: { userId: 7 } },
    );
  });

  test('records nothing when no clearing account is mapped yet', async () => {
    settings.findOne.mockResolvedValue({ settingBankData: [] });
    ledger.findAll.mockResolvedValue([]);
    expect(await captureClearingSnapshot('a@b.test', 7)).toBeNull();
  });

  test('a day posted before go-live stays inside the starting balance', async () => {
    // "Post anyway" can put a pre-cutoff day into the account. The statement only adds back
    // postings on or after go-live, so the snapshot must subtract only those - otherwise the
    // old day is subtracted here and never added back, and every later figure drifts.
    withQboBalance(1000);
    ledger.findAll.mockResolvedValue([row(20000, 0, '2026-09-10'), row(80000, 0, '2026-09-15')]);
    // 100,000 in the account; only the 80,000 from 9/15 is "since go-live". The 9/10 posting is
    // part of what the account held at go-live, so the snapshot is 20,000 - not 0.
    expect(await captureClearingSnapshot('a@b.test', 7)).toBe(20000);
  });
});
