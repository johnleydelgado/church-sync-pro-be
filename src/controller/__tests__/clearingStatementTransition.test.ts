/**
 * The switch-over block on the clearing statement. Every model and third party is faked; the
 * arithmetic itself is transitionFigures', covered by its own tests - this proves the controller
 * feeds it the right inputs and says "unknown" rather than "zero" when it cannot.
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
// clearingSnapshot is loaded for real (its netCentsOf is needed), so the QuickBooks client it
// imports must be faked - the real one loads the tokens model, which wires associations onto the
// mocked user model and throws.
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => {
  const actual = jest.requireActual('../../services/clearingSnapshot');
  return { ...actual, readQboClearingBalance: jest.fn(), captureClearingSnapshot: jest.fn() };
});

import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import DailyJeSync from '../../db/models/DailyJeSync';
import { readQboClearingBalance } from '../../services/clearingSnapshot';
import { getClearingStatement } from '../journalEntry';

const users = Users as unknown as { findOne: jest.Mock };
const settings = UserSettings as unknown as { findOne: jest.Mock; update: jest.Mock };
const ledger = DailyJeSync as unknown as { findAll: jest.Mock };
const qbo = readQboClearingBalance as unknown as jest.Mock;

const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
const day = (d: string, gross: number, fee: number) => ({ day: d, postedGrossCents: gross, postedFeeCents: fee, entryCount: 1, qboEntryIds: ['1'], batchIds: [] });

const statement = async (opts: { settings: any; rows: any[]; qbo: number | null }) => {
  users.findOne.mockResolvedValue({ id: 1 });
  settings.findOne.mockResolvedValue({
    settingBankData: [{ type: 'donation', value: '175000', label: 'Clearing' }],
    ...opts.settings,
  });
  ledger.findAll.mockResolvedValue(opts.rows);
  qbo.mockResolvedValue(opts.qbo);
  const res = makeRes();
  await getClearingStatement({ query: { email: 'a@b.test', month: '2026-09' } } as any, res);
  return res.json.mock.calls[0][0].data;
};

beforeEach(() => jest.clearAllMocks());

describe('getClearingStatement: transition block', () => {
  test('absent when the church has no go-live date', async () => {
    const d = await statement({ settings: { startDateAutomationFund: null }, rows: [], qbo: 0 });
    expect(d.transition).toBeNull();
  });

  test("Matt's example: a $5,000 deposit cleared against $3,000 of CSP postings", async () => {
    const d = await statement({
      settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: 0, clearingSnapshotAt: new Date('2026-09-15T12:00:00Z'), transitionTruedUpAt: null },
      rows: [day('2026-09-15', 100000, 0), day('2026-09-16', 100000, 0), day('2026-09-17', 100000, 0)],
      qbo: -2000,
    });
    expect(d.transition).toMatchObject({
      goLiveDay: '2026-09-15',
      balanceAtGoLive: 0,
      postedSinceGoLive: 3000,
      qboBalance: -2000,
      released: 5000,
      inTransit: 0,
      trueUp: 2000,
      truedUpAt: null,
    });
  });

  test('only days on or after go-live count as posted-since', async () => {
    const d = await statement({
      settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: 0 },
      rows: [day('2026-09-10', 50000, 0), day('2026-09-15', 100000, 0)],
      qbo: 1500,
    });
    expect(d.transition.postedSinceGoLive).toBe(1000);
  });

  test('figures are null, not zero, when the snapshot was never captured', async () => {
    const d = await statement({ settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: null }, rows: [], qbo: 0 });
    expect(d.transition.balanceAtGoLive).toBeNull();
    expect(d.transition.trueUp).toBeNull();
    expect(d.transition.released).toBeNull();
  });

  test('figures are null when QuickBooks cannot be read', async () => {
    const d = await statement({ settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: 0 }, rows: [], qbo: null });
    expect(d.transition.trueUp).toBeNull();
    expect(d.qboBalance).toBeNull();
  });

  test('a bigint column arriving as a string is still a number to the maths', async () => {
    // Sequelize returns BIGINT as a string on some drivers.
    const d = await statement({ settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: '366220' }, rows: [day('2026-09-15', 100, 32)], qbo: 3662.88 });
    expect(d.transition.balanceAtGoLive).toBe(3662.2);
    expect(d.transition.inTransit).toBe(0.68);
    expect(d.transition.trueUp).toBe(0);
  });

  test('carries truedUpAt so the panel can retire itself', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const d = await statement({ settings: { startDateAutomationFund: '09-15-2026', clearingBalanceAtGoLiveCents: 0, transitionTruedUpAt: at }, rows: [], qbo: 0 });
    expect(new Date(d.transition.truedUpAt).toISOString()).toBe(at.toISOString());
  });
});

import { markTransitionTruedUp } from '../journalEntry';

describe('markTransitionTruedUp', () => {
  test('stamps the settings row and returns the timestamp', async () => {
    users.findOne.mockResolvedValue({ id: 1 });
    settings.update.mockResolvedValue([1]);
    const res = makeRes();
    await markTransitionTruedUp({ body: { email: 'a@b.test' } } as any, res);
    expect(settings.update).toHaveBeenCalledWith({ transitionTruedUpAt: expect.any(Date) }, { where: { userId: 1 } });
    expect(res.json.mock.calls[0][0].data.truedUpAt).toBeTruthy();
  });

  test('404 for an unknown email', async () => {
    users.findOne.mockResolvedValue(null);
    const res = makeRes();
    await markTransitionTruedUp({ body: { email: 'nobody@b.test' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
