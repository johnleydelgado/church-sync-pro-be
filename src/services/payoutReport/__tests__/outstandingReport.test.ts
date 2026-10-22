/**
 * The "still in transit" report's loader: what it reads, when it asks Planning Center and QuickBooks,
 * and how it answers when they can't be read. Models, Planning Center and QuickBooks are faked; the
 * arithmetic has its own tests (outstanding.test.ts).
 */
jest.mock('../../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../../db/models/userSettings', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../../db/models/PayoutReportUpload', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../../db/models/PayoutTransaction', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../../controller/automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../dailyDonationSync', () => ({
  getOrgTimeZone: jest.fn(),
  // The real parser, minus the module it lives in (which loads the sync engine and its models).
  parseSyncStartDay: (raw: unknown) => {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(raw ?? ''));
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  },
}));
jest.mock('../../donationSweep', () => ({ ...jest.requireActual('../../donationSweep'), fetchDonationsForRange: jest.fn() }));
jest.mock('../../qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
// Planning Center's people endpoint (donor names); everything else that would use axios is faked above.
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import Users from '../../../db/models/user';
import UserSettings from '../../../db/models/userSettings';
import DailyJeSync from '../../../db/models/DailyJeSync';
import PayoutReportUpload from '../../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../../db/models/PayoutTransaction';
import { generatePcToken } from '../../../controller/automation';
import { getOrgTimeZone } from '../../dailyDonationSync';
import { fetchDonationsForRange } from '../../donationSweep';
import { getQboTokensForUser } from '../../qboClient';
import quickBookApi from '../../../utils/quickBookApi';
import axios from 'axios';
import { createLogger } from '../../../utils/logger';
import {
  getOutstandingDeposits,
  OutstandingRequestError,
  PLANNING_CENTER_DOWN,
  PlanningCenterUnavailableError,
} from '../outstandingReport';

const m = {
  user: (Users as any).findOne as jest.Mock,
  settings: (UserSettings as any).findOne as jest.Mock,
  ledger: (DailyJeSync as any).findAll as jest.Mock,
  uploads: (PayoutReportUpload as any).findAll as jest.Mock,
  rows: (PayoutTransaction as any).findAll as jest.Mock,
  token: generatePcToken as jest.Mock,
  zone: getOrgTimeZone as jest.Mock,
  sweep: fetchDonationsForRange as jest.Mock,
  qboTokens: getQboTokensForUser as jest.Mock,
  qbApi: quickBookApi as unknown as jest.Mock,
  people: axios.get as jest.Mock,
};
const log = createLogger('test') as any;

const EMAIL = 'church@example.test';
const NOV_5 = new Date('2026-11-05T18:00:00Z');
const CLEARING = { id: '175', Name: 'Clearing Account', AcctNum: '175000' };

const ledger = (day: string, gross: number, fee: number) => ({
  toJSON: () => ({ day, postedGrossCents: String(gross), postedFeeCents: String(fee), refundedGrossCents: '0', refundedFeeCents: '0' }),
});
const givingRow = (id: number, day: string, gross: number, fee: number, uploadId: number) => ({
  rowKey: `donation:${id}:charge:${day}:${gross}`,
  uploadId,
  day,
  type: 'Charge',
  source: 'Giving',
  name: `Donor ${id}`,
  fundOrSignup: 'General',
  grossCents: String(gross),
  feeCents: String(fee),
  netCents: String(gross - fee),
  status: 'giving_covered',
});
/** person: an id (default `p<id>`), null for "no person", or 'absent' when the payload has no relationship. */
const donation = (id: number, gross: number, fee: number, receivedAt: string, o: any = {}, person: string | null = `p${id}`) => ({
  id: String(id),
  type: 'Donation',
  attributes: {
    amount_cents: gross,
    fee_cents: -fee,
    payment_method: 'card',
    payment_status: 'succeeded',
    refunded: false,
    received_at: receivedAt,
    completed_at: receivedAt,
    ...o,
  },
  relationships: {
    designations: { data: [{ id: `des-${id}` }] },
    ...(person === 'absent' ? {} : { person: { data: person === null ? null : { type: 'Person', id: person } } }),
  },
});
const included = (ids: number[], unmappedIds: number[] = []) => [
  { type: 'Fund', id: 'f1', attributes: { name: 'General' } },
  { type: 'Fund', id: 'f2', attributes: { name: 'Building Fund' } },
  ...ids.map((id) => ({
    type: 'Designation',
    id: `des-${id}`,
    relationships: { fund: { data: { id: unmappedIds.includes(id) ? 'f2' : 'f1' } } },
  })),
];

// QuickBooks: the account and its General Ledger detail.
const glRow = (date: string, type: string, num: string, amount: string) => ({
  type: 'Data',
  ColData: [{ value: date }, { value: type }, { value: num }, { value: 'memo' }, { value: amount }],
});
let glReport: any;
let account: any;
const reportCall = jest.fn();
const qbo = () =>
  m.qbApi.mockReturnValue({
    getAccount: (_id: string, cb: any) => (account instanceof Error ? cb(account, null) : cb(null, account)),
    reportGeneralLedgerDetail: (opts: any, cb: any) => {
      reportCall(opts);
      return glReport instanceof Error ? cb(glReport, null) : cb(null, glReport);
    },
  });
const section = (name: string, rows: any[]) => ({ Columns: { Column: [] }, Rows: { Row: [{ Header: { ColData: [{ value: name }] }, Rows: { Row: rows } }] } });

const SETTINGS = {
  startDateAutomationFund: '10-01-2026',
  settingsData: [
    { fundName: 'General', account: { value: '40000', label: 'Contributions' } },
    { fundName: 'Building Fund', account: null },
  ],
  settingBankData: [{ type: 'donation', value: '175', label: 'Clearing Account' }],
  clearingBalanceAtGoLiveCents: null,
  transitionTruedUpAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  m.user.mockResolvedValue({ id: 7 });
  m.settings.mockResolvedValue(SETTINGS);
  m.ledger.mockResolvedValue([]);
  m.uploads.mockResolvedValue([{ id: 1, payoutFrom: '2026-10-01', payoutTo: '2026-10-31', lastDay: '2026-10-29' }]);
  m.rows.mockResolvedValue([]);
  m.token.mockResolvedValue({ access_token: 'pco' });
  m.zone.mockResolvedValue('America/Denver');
  m.sweep.mockResolvedValue({ donations: [], included: [] });
  m.qboTokens.mockResolvedValue({});
  m.people.mockImplementation(async (url: string) => {
    const id = url.split('/').pop();
    return { data: { data: { type: 'Person', id, attributes: { first_name: 'Given', last_name: `Family-${id}` } } } };
  });
  account = { ...CLEARING, CurrentBalance: 0 };
  glReport = { Columns: { Column: [] }, Rows: {} };
  qbo();
});

describe('the request', () => {
  test.each([['nope'], ['2026-13'], ['2026-1'], [undefined]])('month %s is a 400 before anything is read', async (month) => {
    const err = await getOutstandingDeposits({ email: EMAIL, month, now: NOV_5 }).catch((e) => e);
    expect(err).toBeInstanceOf(OutstandingRequestError);
    expect(err.status).toBe(400);
    expect(m.user).not.toHaveBeenCalled();
  });

  test('an unknown church is a 404', async () => {
    m.user.mockResolvedValue(null);
    const err = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 }).catch((e) => e);
    expect(err).toMatchObject({ status: 404, message: 'No church found for this account.' });
  });
});

describe('a month that is over', () => {
  test('all paid out by the files: no Planning Center call at all; the balance on D from QuickBooks', async () => {
    m.ledger.mockResolvedValue([ledger('2026-10-10', 10000, 300)]);
    m.rows.mockResolvedValue([givingRow(1, '2026-10-10', 10000, 300, 1)]);
    account = { ...CLEARING, CurrentBalance: 25.5 }; // today, after November activity
    glReport = section('175000 Clearing Account', [
      glRow('2026-10-10', 'Journal Entry', 'CSP-2026-10-10-1', '97.00'),
      glRow('2026-10-14', 'Deposit', '', '-97.00'),
      glRow('2026-11-02', 'Journal Entry', 'CSP-2026-11-02-1', '45.50'),
      glRow('2026-11-04', 'Deposit', '', '-20.00'),
    ]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });

    expect(m.token).not.toHaveBeenCalled();
    expect(m.sweep).not.toHaveBeenCalled();
    expect(reportCall).toHaveBeenCalledWith({
      account: '175',
      start_date: '2026-10-01',
      end_date: '2031-12-31',
      accounting_method: 'Accrual',
      columns: 'tx_date,txn_type,doc_num,memo,subt_nat_amount',
    });
    expect(r).toMatchObject({
      month: '2026-10',
      asOf: '2026-10-31',
      coverage: { complete: true, from: '2026-10-01', missing: [] },
      qbo: { account: { id: '175', name: 'Clearing Account' }, balance: 0 },
      inTransit: { net: 0 },
      difference: 0,
      differenceNotes: [],
      items: [],
    });
    // Only rows of this church are read, the BIGINT strings become numbers.
    expect(m.ledger.mock.calls[0][0].where.userId).toBe(7);
    expect(m.rows.mock.calls[0][0].where).toEqual({ userId: 7 });
  });

  test('days not paid out: one Planning Center read for the run of days, by the church day, gifts as the engine selects them', async () => {
    m.ledger.mockResolvedValue([ledger('2026-10-10', 10000, 300), ledger('2026-10-30', 15000, 475), ledger('2026-10-31', 2000, 89)]);
    m.rows.mockResolvedValue([givingRow(1, '2026-10-10', 10000, 300, 1)]);
    m.sweep.mockResolvedValue({
      donations: [
        donation(2, 10000, 300, '2026-10-30T16:00:00Z'),
        donation(3, 5000, 175, '2026-10-31T03:00:00Z'), // 9pm on the 30th in Denver
        donation(4, 2000, 89, '2026-10-31T18:00:00Z'),
        donation(5, 999, 0, '2026-10-31T18:00:00Z', { payment_method: 'cash' }), // not Stripe money
        donation(6, 4000, 146, '2026-10-31T19:00:00Z', { payment_status: 'pending' }), // not settled
      ],
      included: included([2, 3, 4, 5, 6]),
    });
    account = { ...CLEARING, CurrentBalance: 165.36 };
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });

    expect(m.sweep).toHaveBeenCalledTimes(1);
    expect(m.sweep).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer pco' } }, '2026-10-29', '2026-11-01');
    expect(r.items.map((i) => [i.day, i.ref, i.fundOrEvent, i.net, i.paidOut])).toEqual([
      ['2026-10-30', 'Donation #2', 'General', 97, null],
      ['2026-10-30', 'Donation #3', 'General', 48.25, null],
      ['2026-10-31', 'Donation #4', 'General', 19.11, null],
    ]);
    expect(r.inTransit.net).toBe(164.36);
    expect(r.difference).toBe(1);
  });

  test('a gift in a fund with no QuickBooks account was never posted: "not in QuickBooks yet"', async () => {
    m.ledger.mockResolvedValue([ledger('2026-10-30', 10000, 300)]);
    m.sweep.mockResolvedValue({
      donations: [donation(2, 10000, 300, '2026-10-30T16:00:00Z'), donation(7, 4000, 150, '2026-10-30T15:00:00Z')],
      included: included([2, 7], [7]),
    });
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.items.map((i) => i.ref)).toEqual(['Donation #2']);
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-30', count: 1, gross: 40, net: 38.5 }]);
  });

  test.each([
    ['no Planning Center connection', () => m.token.mockRejectedValue(new Error('Not found !'))],
    ['no timezone reported', () => m.zone.mockResolvedValue(null)],
    ['the donations read failing', () => m.sweep.mockRejectedValue(new Error('429'))],
  ])('Planning Center needed and not read (%s): a plain 502 sentence', async (_name, breakIt) => {
    m.ledger.mockResolvedValue([ledger('2026-10-30', 10000, 300)]);
    breakIt();
    const err = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningCenterUnavailableError);
    expect(err.message).toBe(PLANNING_CENTER_DOWN);
    expect(PLANNING_CENTER_DOWN).toBe("Planning Center didn't answer, so the giving lines can't be listed. Try again in a minute.");
  });

  test('the switch-over facts come from the transition panel settings', async () => {
    m.settings.mockResolvedValue({ ...SETTINGS, clearingBalanceAtGoLiveCents: '50000', transitionTruedUpAt: new Date('2026-10-14T10:00:00Z') });
    account = { ...CLEARING, CurrentBalance: 500 };
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.difference).toBe(500);
    expect(r.differenceNotes).toEqual([
      expect.objectContaining({ kind: 'switch_over', amount: 500, text: expect.stringContaining('marked done on Oct 14, 2026') }),
    ]);
  });
});

describe('QuickBooks', () => {
  test("a report that isn't the clearing account: no balance, a sentence, the list still there", async () => {
    glReport = section('10000 Checking', [glRow('2026-10-05', 'Deposit', '', '5.00')]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.qbo).toEqual({
      account: { id: '175', name: 'Clearing Account' },
      balance: null,
      message: "QuickBooks answered with another account's figures, so the Clearing balance on Oct 31, 2026 isn't shown.",
    });
    expect(r.difference).toBeNull();
  });

  test('a report with rows CSP cannot read: no balance rather than a wrong one', async () => {
    glReport = section('175000 Clearing Account', [glRow('2026-11-02', 'Deposit', '', 'n/a')]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.qbo).toEqual({
      account: { id: '175', name: 'Clearing Account' },
      balance: null,
      message: "QuickBooks' report for the Clearing account couldn't be read, so the balance on Oct 31, 2026 isn't shown.",
    });
  });

  test("QuickBooks not answering is not a 500", async () => {
    m.qboTokens.mockRejectedValue(new Error('QBO token refresh failed'));
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.qbo).toEqual({
      account: { id: '175', name: 'Clearing Account' },
      balance: null,
      message: "QuickBooks didn't answer, so the Clearing balance on Oct 31, 2026 isn't shown. Try again in a minute.",
    });
  });

  test('no clearing account mapped', async () => {
    m.settings.mockResolvedValue({ ...SETTINGS, settingBankData: [] });
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.qbo).toEqual({ account: null, balance: null, message: 'Choose the clearing account on Mapping → Bank to see its QuickBooks balance.' });
    expect(m.qbApi).not.toHaveBeenCalled();
  });

  test('entries CSP did not make, up to D, explain a difference', async () => {
    account = { ...CLEARING, CurrentBalance: -12.34 };
    glReport = section('175000 Clearing Account', [
      glRow('2026-10-03', 'Journal Entry', 'CSP-2026-10-03-1', '100.00'),
      glRow('2026-10-06', 'Deposit', 'DEP-1', '-112.34'),
    ]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.differenceNotes).toEqual([
      expect.objectContaining({
        kind: 'not_csp',
        amount: -12.34,
        entries: [{ date: '2026-10-06', type: 'Deposit', amount: -112.34, memo: 'memo', docNumber: 'DEP-1' }],
      }),
    ]);
  });
});

describe('as of when', () => {
  const OCT_22 = new Date('2026-10-22T18:00:00Z');

  test("a month still running reports as of the church's today", async () => {
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: OCT_22 });
    expect(r.asOf).toBe('2026-10-22');
    expect(m.zone).toHaveBeenCalled();
  });

  test('a month in the future reports as of today', async () => {
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-12', now: OCT_22 });
    expect(r).toMatchObject({ month: '2026-12', asOf: '2026-10-22' });
  });

  test('the last evening of a month in Denver is still that month there', async () => {
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: new Date('2026-11-01T03:00:00Z') });
    expect(r.asOf).toBe('2026-10-31');
  });

  test('before the sync start date: an empty report that says so, nothing else read', async () => {
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-09', now: NOV_5 });
    expect(r).toMatchObject({
      asOf: '2026-09-30',
      message: "CSP's sync starts on Oct 1, 2026, after Sep 30, 2026, so nothing of CSP's was in Clearing then.",
      items: [],
      qbo: { account: { id: '175', name: 'Clearing Account' }, balance: null },
    });
    expect(m.uploads).not.toHaveBeenCalled();
    expect(m.token).not.toHaveBeenCalled();
    expect(m.qbApi).not.toHaveBeenCalled();
  });
});

describe('donor names for gifts no payout report names', () => {
  beforeEach(() => {
    m.ledger.mockResolvedValue([ledger('2026-10-30', 21000, 700)]);
    m.uploads.mockResolvedValue([
      { id: 1, payoutFrom: '2026-10-01', payoutTo: '2026-10-31', lastDay: '2026-10-29' },
      { id: 2, payoutFrom: '2026-11-01', payoutTo: '2026-11-30', lastDay: '2026-10-30' },
    ]);
    // Gift 2 is in November's file (named there); 3, 4, 5, 6 are in no file.
    m.rows.mockResolvedValue([givingRow(2, '2026-10-30', 5000, 175, 2)]);
  });
  const day = (donations: any[]) => m.sweep.mockResolvedValue({ donations, included: included(donations.map((d) => Number(d.id))) });
  const at = '2026-10-30T16:00:00Z';

  test("named as Planning Center shows them, each person looked up once; a payout row's name is kept", async () => {
    day([
      donation(2, 5000, 175, at),
      donation(3, 6000, 200, at, {}, 'p77'),
      donation(4, 4000, 150, at, {}, 'p77'), // the same donor twice
      donation(5, 3000, 100, at, {}, 'p88'),
      donation(6, 3000, 75, at, {}, 'p99'),
    ]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.items.map((i) => [i.ref, i.name])).toEqual([
      ['Donation #2', 'Donor 2'],
      ['Donation #3', 'Given Family-p77'],
      ['Donation #4', 'Given Family-p77'],
      ['Donation #5', 'Given Family-p88'],
      ['Donation #6', 'Given Family-p99'],
    ]);
    expect(m.people.mock.calls.map((c) => c[0]).sort()).toEqual([
      'https://api.planningcenteronline.com/giving/v2/people/p77',
      'https://api.planningcenteronline.com/giving/v2/people/p88',
      'https://api.planningcenteronline.com/giving/v2/people/p99',
    ]);
    expect(m.people.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer pco' } });
  });

  test('no person on the gift: "Anonymous Donor", as Planning Center shows it; no person in the payload: blank', async () => {
    day([donation(2, 5000, 175, at), donation(3, 6000, 200, at, {}, null), donation(4, 4000, 150, at, {}, 'absent'), donation(5, 6000, 175, at)]);
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.items.map((i) => [i.ref, i.name])).toEqual([
      ['Donation #2', 'Donor 2'],
      ['Donation #3', 'Anonymous Donor'],
      ['Donation #4', null],
      ['Donation #5', 'Given Family-p5'],
    ]);
    expect(m.people).toHaveBeenCalledTimes(1);
  });

  test('a person Planning Center no longer has is left blank', async () => {
    day([donation(2, 5000, 175, at), donation(3, 6000, 200, at), donation(4, 4000, 150, at), donation(5, 6000, 175, at)]);
    m.people.mockImplementation(async (url: string) => {
      const id = url.split('/').pop();
      if (id === 'p3') throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return { data: { data: { type: 'Person', id, attributes: { first_name: 'Given', last_name: `Family-${id}` } } } };
    });
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.items.map((i) => i.name)).toEqual(['Donor 2', null, 'Given Family-p4', 'Given Family-p5']);
  });

  test('the lookup failing keeps the report, names blank, and is logged - nothing else', async () => {
    day([donation(2, 5000, 175, at), donation(3, 6000, 200, at), donation(4, 4000, 150, at), donation(5, 6000, 175, at)]);
    m.people.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));
    const r = await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(r.items.map((i) => [i.ref, i.name])).toEqual([
      ['Donation #2', 'Donor 2'],
      ['Donation #3', null],
      ['Donation #4', null],
      ['Donation #5', null],
    ]);
    expect(r.inTransit.gifts.count).toBe(4);
    expect(r).not.toHaveProperty('message');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/donor names stay blank/), expect.objectContaining({ status: 401 }));
  });

  test('every gift already named: no people lookups at all', async () => {
    m.rows.mockResolvedValue([givingRow(2, '2026-10-30', 21000, 700, 2)]);
    day([donation(2, 21000, 700, at)]);
    await getOutstandingDeposits({ email: EMAIL, month: '2026-10', now: NOV_5 });
    expect(m.people).not.toHaveBeenCalled();
  });
});
