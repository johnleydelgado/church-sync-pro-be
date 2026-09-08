/**
 * The nightly run, end to end against a real Postgres.
 *
 * Proves the thing the whole rework exists for: online giving reaches QuickBooks WITHOUT going
 * through a Planning Center batch, because Planning Center does not put it in one.
 */
import axios from 'axios';

import sequelize from '../../db';
import DailyJeSync from '../../db/models/DailyJeSync';
import User from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import UserSync from '../../db/models/UserSync';
import * as automation from '../../controller/automation';
import { runDailyDonationSync } from '../dailyDonationSync';

jest.mock('axios');
jest.mock('../../controller/automation', () => ({
  generatePcToken: jest.fn(),
  automationJournalEntry: jest.fn(),
  getFundInDonation: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedAutomation = automation as jest.Mocked<typeof automation>;

const EMAIL = 'nightly@example.test';
const USER_ID = 90002;
const TZ = 'America/New_York';
const ACCOUNTS = { general: '40', fees: '60', clearing: '10' };

const SETTINGS = [
  { fundName: 'General', account: { value: ACCOUNTS.general, label: 'Tithes' }, class: { value: '', label: '' }, customer: { value: '', label: '' } },
];
const BANK = [{ type: 'donation', value: ACCOUNTS.clearing, label: 'Stripe Clearing' }];

let posted: any[] = [];
/** day -> donations PCO would return for that day's window */
let byDay: Record<string, any[]> = {};

const donation = (id: string, cents: number, fee: number, receivedAt: string, over: any = {}) => ({
  type: 'Donation',
  id,
  attributes: {
    amount_cents: cents,
    fee_cents: fee,
    payment_method: 'card',
    payment_status: 'succeeded',
    refunded: false,
    fee_covered: false,
    received_at: receivedAt,
    completed_at: receivedAt,
    ...over,
  },
  relationships: { designations: { data: [{ type: 'Designation', id: `${id}-des` }] } },
});

const includedFor = (donations: any[]) => {
  const out: any[] = [{ type: 'Fund', id: '901', attributes: { name: 'General' } }];
  for (const d of donations) {
    out.push({
      type: 'Designation',
      id: `${d.id}-des`,
      attributes: { amount_cents: d.attributes.amount_cents },
      relationships: { fund: { data: { type: 'Fund', id: '901' } } },
    });
  }
  return out;
};

const serve = () => {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/giving/v2')) return { data: { data: { attributes: { time_zone: TZ } } } };
    const m = url.match(/where\[received_at\]\[gte\]=(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const donations = byDay[m[1]] ?? [];
      return { data: { data: donations, included: includedFor(donations), meta: { total_count: donations.length } } };
    }
    throw new Error(`unmocked GET ${url}`);
  });
};

const amountFor = (entry: any, account: string) =>
  entry.Line.filter((l: any) => l.JournalEntryLineDetail.AccountRef.value === account).reduce(
    (s: number, l: any) => s + l.Amount,
    0,
  );

beforeAll(async () => { await sequelize.authenticate(); });
afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
  posted = [];
  byDay = {};
  jest.clearAllMocks();
  mockedAutomation.generatePcToken.mockResolvedValue({ access_token: 't', refresh_token: 'r' } as any);
  mockedAutomation.automationJournalEntry.mockImplementation(async (_e: string, payload: any) => {
    posted.push(payload);
    return { Id: `JE${posted.length}` } as any;
  });
  serve();

  await UserSync.destroy({ where: { userId: USER_ID } });
  await DailyJeSync.destroy({ where: { userId: USER_ID } });
  await UserSettings.destroy({ where: { userId: USER_ID } });
  await User.destroy({ where: { id: USER_ID } });
  await User.create({ id: USER_ID, email: EMAIL, isActive: true, role: 'client' } as any);
  await UserSettings.create({
    userId: USER_ID,
    settingsData: SETTINGS,
    settingBankCharges: { account: { value: ACCOUNTS.fees, label: 'Fees' }, class: { value: '', label: '' } },
    settingBankData: BANK,
    isAutomationEnable: true,
    isAutomationRegistration: false,
    startDateAutomationFund: '01-01-2026',
  } as any);
});

const user = () => ({ id: USER_ID, email: EMAIL });
// Wednesday 8am in New York.
const WED_8AM = new Date('2026-09-09T12:00:00Z');

describe('the 8am run', () => {
  test("posts Tuesday's giving, dated Tuesday", async () => {
    byDay['2026-09-08'] = [
      donation('a', 50000, -758, '2026-09-08T14:00:00Z'),
      donation('b', 19920, -300, '2026-09-08T20:00:00Z'),
    ];

    const result = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 3 });

    expect(result.status).toBe('synced');
    expect(result.postedDays).toEqual(['2026-09-08']);
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(699.2, 2);
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(10.58, 2);
    expect(amountFor(posted[0], ACCOUNTS.clearing)).toBeCloseTo(688.62, 2);
    expect(posted[0].TxnDate).toBe('2026-09-08');
  });

  test('reaches giving that is in no batch at all', async () => {
    // The whole point: this donation has no batch relationship, so the old batch sweep could
    // never have seen it.
    byDay['2026-09-08'] = [donation('unbatched', 10000, -320, '2026-09-08T14:00:00Z')];
    await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 0 });
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(100, 2);
  });

  test('a quiet Tuesday posts nothing', async () => {
    const result = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 3 });
    expect(posted).toHaveLength(0);
    expect(result.status).toBe('synced');
  });

  test('examines the days before it, most recent first', async () => {
    const result = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 3 });
    expect(result.daysExamined).toEqual(['2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05']);
  });

  test('never looks earlier than the church\'s sync start date', async () => {
    await UserSettings.update({ startDateAutomationFund: '09-07-2026' } as any, { where: { userId: USER_ID } });
    const result = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 10 });
    expect(result.daysExamined).toEqual(['2026-09-08', '2026-09-07']);
  });
});

describe('ACH that settles after the entry is posted', () => {
  // An ACH gift given Tuesday is still pending at Wednesday 8am, so it must stay out - the
  // money has not arrived. When it settles, the catch-up window finds it and tops Tuesday up.
  test('is left out while pending, then tops the day up once it settles', async () => {
    byDay['2026-09-08'] = [
      donation('card', 10000, -320, '2026-09-08T14:00:00Z'),
      donation('ach', 35000, 0, '2026-09-08T15:00:00Z', { payment_method: 'ach', payment_status: 'pending' }),
    ];
    await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 3 });
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(100, 2);

    // Friday: the ACH has settled.
    byDay['2026-09-08'] = [
      donation('card', 10000, -320, '2026-09-08T14:00:00Z'),
      donation('ach', 35000, -87, '2026-09-08T15:00:00Z', { payment_method: 'ach' }),
    ];
    const friday = await runDailyDonationSync(user(), { now: new Date('2026-09-11T12:00:00Z'), catchUpDays: 5 });

    expect(friday.postedDays).toContain('2026-09-08');
    expect(posted).toHaveLength(2);
    // Only the ACH gift, as an adjusting entry still dated Tuesday.
    expect(amountFor(posted[1], ACCOUNTS.general)).toBeCloseTo(350, 2);
    expect(posted[1].TxnDate).toBe('2026-09-08');

    const ledger = await DailyJeSync.findOne({ where: { userId: USER_ID, day: '2026-09-08' } });
    expect(Number(ledger!.postedGrossCents)).toBe(45000);
  });

  test('a settled day is not posted again on later runs', async () => {
    byDay['2026-09-08'] = [donation('card', 10000, -320, '2026-09-08T14:00:00Z')];
    await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 3 });
    await runDailyDonationSync(user(), { now: new Date('2026-09-10T12:00:00Z'), catchUpDays: 5 });
    expect(posted).toHaveLength(1);
  });
});

describe('churches the run passes over', () => {
  const reasonFor = async (patch: any) => {
    await UserSettings.update(patch, { where: { userId: USER_ID } });
    const r = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 1 });
    return r.reason;
  };

  test('names why, instead of failing silently', async () => {
    expect(await reasonFor({ isAutomationEnable: false } as any)).toBe('automation_off');
    expect(await reasonFor({ isAutomationEnable: true, settingsData: [] } as any)).toBe('no_fund_mapping');
    expect(await reasonFor({ settingsData: SETTINGS, settingBankData: [] } as any)).toBe('no_clearing_account');
  });

  test('a church with no settings row at all is named too', async () => {
    await UserSettings.destroy({ where: { userId: USER_ID } });
    const r = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 1 });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no_settings');
  });

  // A NULL start date used to drop the church with no log and no counter - the run reported
  // processed: 0, completed, exactly like a night with no giving.
  test('a missing sync start date does not silence the church', async () => {
    await UserSettings.update({ startDateAutomationFund: null } as any, { where: { userId: USER_ID } });
    byDay['2026-09-08'] = [donation('card', 10000, -320, '2026-09-08T14:00:00Z')];
    const r = await runDailyDonationSync(user(), { now: WED_8AM, catchUpDays: 2 });
    expect(r.status).toBe('synced');
    expect(r.postedDays).toEqual(['2026-09-08']);
  });
});
