/**
 * Still in transit at month-end, end to end against a real Postgres: payout reports uploaded
 * through the real importer (payout dates and all), then the report read back from what was
 * stored. Planning Center and QuickBooks are faked. Synthetic data only.
 */
jest.mock('../../../controller/automation', () => ({
  generatePcToken: jest.fn(),
  automationJournalEntry: jest.fn(),
  getFundInDonation: jest.fn(),
}));
jest.mock('../givingCoverage', () => ({ ...jest.requireActual('../givingCoverage'), loadDayCoverage: jest.fn() }));
jest.mock('../../donationSweep', () => ({ ...jest.requireActual('../../donationSweep'), fetchDonationsForRange: jest.fn() }));
jest.mock('../../dailyDonationSync', () => ({ ...jest.requireActual('../../dailyDonationSync'), getOrgTimeZone: jest.fn() }));
jest.mock('../../qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));

import sequelize from '../../../db';
import User from '../../../db/models/user';
import UserSettings from '../../../db/models/userSettings';
import DailyJeSync from '../../../db/models/DailyJeSync';
import PayoutReportUpload from '../../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../../db/models/PayoutTransaction';
import * as automation from '../../../controller/automation';
import { loadDayCoverage } from '../givingCoverage';
import { fetchDonationsForRange } from '../../donationSweep';
import { getOrgTimeZone } from '../../dailyDonationSync';
import { getQboTokensForUser } from '../../qboClient';
import quickBookApi from '../../../utils/quickBookApi';
import { importPayoutReport } from '../importPayoutReport';
import { getOutstandingDeposits } from '../outstandingReport';

const mocked = automation as jest.Mocked<typeof automation>;
const EMAIL = 'outstanding@example.test';
const USER_ID = 90030;
const CLEARING = '1150040099';

const HEADER = 'Date,Type,Source,Name,Fund/Signup,Gross,Fee,Net,Payment method,Campus,Description';
const money = (n: number) => n.toFixed(2);
const reg = (day: string, id: number, gross: number, fee: number) =>
  `${day},Charge,Registrations,Person ${id},Retreat,${money(gross)},${money(fee)},${money(gross - fee)},card,,"Registration #${id} - Person ${id} - Retreat"`;
const gift = (day: string, id: number, gross: number, fee: number) =>
  `${day},Charge,Giving,Donor ${id},General,${money(gross)},${money(fee)},${money(gross - fee)},card,,"Donation #${id} - Donor ${id} - General"`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n');

const donation = (id: number, gross: number, fee: number, receivedAt: string) => ({
  id: String(id),
  type: 'Donation',
  attributes: { amount_cents: gross, fee_cents: -fee, payment_method: 'card', payment_status: 'succeeded', refunded: false, received_at: receivedAt, completed_at: receivedAt },
  relationships: { designations: { data: [] } },
});

/** Giving CSP posted for a day (the registration import may already have made the day's row). */
const ledgerDay = async (day: string, gross: number, fee: number) => {
  const [row] = await DailyJeSync.findOrCreate({ where: { userId: USER_ID, day }, defaults: { userId: USER_ID, day } as any });
  await row.update({ postedGrossCents: gross, postedFeeCents: fee, entryCount: 1 } as any);
};

let balance = 0;
const qbo = () =>
  (quickBookApi as unknown as jest.Mock).mockReturnValue({
    getAccount: (_id: string, cb: any) => cb(null, { Id: CLEARING, Name: 'Clearing Account', CurrentBalance: balance }),
    reportGeneralLedgerDetail: (_o: any, cb: any) => cb(null, { Columns: { Column: [] }, Rows: {} }),
  });

const wipe = async () => {
  await PayoutTransaction.destroy({ where: { userId: USER_ID } });
  await PayoutReportUpload.destroy({ where: { userId: USER_ID } });
  await DailyJeSync.destroy({ where: { userId: USER_ID } });
  await UserSettings.destroy({ where: { userId: USER_ID } });
  await User.destroy({ where: { id: USER_ID } });
};

beforeEach(async () => {
  jest.clearAllMocks();
  let n = 0;
  mocked.automationJournalEntry.mockImplementation(async () => ({ Id: `JE${++n}` }));
  mocked.generatePcToken.mockResolvedValue({ access_token: 'pco' } as any);
  (getOrgTimeZone as jest.Mock).mockResolvedValue('America/Denver');
  (loadDayCoverage as jest.Mock).mockResolvedValue(new Map());
  (getQboTokensForUser as jest.Mock).mockResolvedValue({});
  qbo();
  await wipe();
  await User.create({ id: USER_ID, email: EMAIL, isActive: true, role: 'client' } as any);
  await UserSettings.create({
    userId: USER_ID,
    isAutomationEnable: false,
    isAutomationRegistration: false,
    settingBankCharges: { account: { value: '5', label: 'Bank Charges' } },
    settingBankData: [
      { type: 'donation', value: CLEARING, label: 'Clearing Account' },
      { type: 'registration', value: CLEARING, label: 'Clearing Account' },
    ],
    startDateAutomationRegistration: '10-01-2026',
    startDateAutomationFund: '10-01-2026',
    settingRegistrationData: { version: 2, default: { account: { value: '77', label: 'Event Income' } }, events: [] },
  } as any);

  // October's payouts, uploaded Nov 5; November's, uploaded Dec 5.
  await importPayoutReport({
    email: EMAIL,
    csvText: file(reg('2026-10-05', 1, 60, 1.59), gift('2026-10-20', 100, 100, 3)),
    payoutFrom: '2026-10-01',
    payoutTo: '2026-10-31',
    now: new Date('2026-11-05T18:00:00Z'),
  });
  await importPayoutReport({
    email: EMAIL,
    csvText: file(reg('2026-10-30', 2, 30, 0.95), gift('2026-10-30', 101, 100, 3)),
    payoutFrom: '2026-11-01',
    payoutTo: '2026-11-30',
    now: new Date('2026-12-05T18:00:00Z'),
  });
  // CSP's giving: Oct 20 (paid in October), Oct 30 (one gift paid in November, one in no file yet).
  await ledgerDay('2026-10-20', 10000, 300);
  await ledgerDay('2026-10-30', 15000, 475);
  (fetchDonationsForRange as jest.Mock).mockResolvedValue({
    donations: [donation(101, 10000, 300, '2026-10-30T16:00:00Z'), donation(102, 5000, 175, '2026-10-30T17:00:00Z')],
    included: [],
  });
});

afterAll(async () => {
  await wipe();
  await sequelize.close();
});

test('the uploads carry their payout dates', async () => {
  const uploads = (await PayoutReportUpload.findAll({ where: { userId: USER_ID }, order: [['id', 'ASC']] })) as any[];
  expect(uploads.map((u) => [u.payoutFrom, u.payoutTo])).toEqual([
    ['2026-10-01', '2026-10-31'],
    ['2026-11-01', '2026-11-30'],
  ]);
});

test('October: what Stripe paid out in November, or not yet, from the stored rows', async () => {
  balance = 999.99;
  const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: new Date('2026-12-05T18:00:00Z') });

  expect(fetchDonationsForRange).toHaveBeenCalledTimes(1);
  expect((fetchDonationsForRange as jest.Mock).mock.calls[0].slice(1)).toEqual(['2026-10-29', '2026-10-31']);
  expect(r.asOf).toBe('2026-10-31');
  expect(r.coverage).toEqual({ complete: true, from: '2026-10-01', missing: [] });
  expect(r.items.map((i) => [i.day, i.kind, i.ref, i.name, i.net, i.paidOut])).toEqual([
    ['2026-10-30', 'gift', 'Donation #101', 'Donor 101', 97, { from: '2026-11-01', to: '2026-11-30' }],
    ['2026-10-30', 'gift', 'Donation #102', null, 48.25, null],
    ['2026-10-30', 'registration', 'Registration #2', 'Person 2', 29.05, { from: '2026-11-01', to: '2026-11-30' }],
  ]);
  expect(r.inTransit).toEqual({
    net: 174.3,
    gifts: { count: 2, gross: 150, fee: 4.75, net: 145.25 },
    registrations: { count: 1, gross: 30, fee: 0.95, net: 29.05 },
  });
  // The QuickBooks figure is whatever the account held; nothing is posted after Oct 31 here.
  expect(r.qbo).toEqual({ account: { id: CLEARING, name: 'Clearing Account' }, balance: 999.99 });
  expect(r.difference).toBe(825.69);
});

test("November: November's payouts are paid by Nov 30; the gift in no file is still in transit", async () => {
  balance = 48.25;
  const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-11', now: new Date('2026-12-05T18:00:00Z') });
  expect(r.items.map((i) => [i.day, i.ref, i.paidOut])).toEqual([['2026-10-30', 'Donation #102', null]]);
  expect(r.difference).toBe(0);
});

test('a payout report for later payouts changes an earlier month, as QuickBooks does', async () => {
  // Before November's file: the Oct 30 registration is not recorded at all, and gift 101 is in no file.
  await PayoutTransaction.destroy({ where: { userId: USER_ID, day: '2026-10-30' } });
  await PayoutReportUpload.destroy({ where: { userId: USER_ID, payoutFrom: '2026-11-01' } });
  const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: new Date('2026-11-05T18:00:00Z') });
  expect(r.items.map((i) => [i.ref, i.paidOut])).toEqual([
    ['Donation #101', null],
    ['Donation #102', null],
  ]);
});
