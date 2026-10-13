/**
 * The review list against a real Postgres, QuickBooks and Planning Center faked: a person can
 * code or dismiss what an upload held, settle an interrupted post, and re-check giving - and can
 * never post a line twice through it.
 */
jest.mock('../../../controller/automation', () => ({
  generatePcToken: jest.fn(),
  automationJournalEntry: jest.fn(),
  getFundInDonation: jest.fn(),
}));
jest.mock('../givingCoverage', () => ({ ...jest.requireActual('../givingCoverage'), loadDayCoverage: jest.fn() }));

import sequelize from '../../../db';
import User from '../../../db/models/user';
import UserSettings from '../../../db/models/userSettings';
import DailyJeSync from '../../../db/models/DailyJeSync';
import PayoutReportUpload from '../../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../../db/models/PayoutTransaction';
import * as automation from '../../../controller/automation';
import { loadDayCoverage, DayCoverage } from '../givingCoverage';
import { importPayoutReport } from '../importPayoutReport';
import { getPayoutStatus, listReview, listSignups, recheckGiving, resolvePayoutRow } from '../reviewPayoutRows';

const mockedAutomation = automation as jest.Mocked<typeof automation>;
const coverage = loadDayCoverage as jest.Mock;

const EMAIL = 'review@example.test';
const USER_ID = 90011;
const OTHER_EMAIL = 'other-church@example.test';
const OTHER_ID = 90012;
const CLEARING = '1150040022';
let posted: any[] = [];

const HEADER = 'Date,Type,Source,Name,Fund/Signup,Gross,Fee,Net,Payment method,Campus,Description';
const money = (n: number) => n.toFixed(2);
const reg = (day: string, id: number, gross: number, fee: number, signup = 'SHE Conference 2026') =>
  `${day},Charge,Registrations,Person ${id},${signup},${money(gross)},${money(fee)},${money(gross - fee)},card,,"Registration #${id} - Person ${id} - ${signup}"`;
const gift = (day: string, id: number, gross: number, fee: number) =>
  `${day},Charge,Giving,Donor ${id},Tithes & Offerings,${money(gross)},${money(fee)},${money(gross - fee)},card,,"Donation #${id} - Donor ${id} - Tithes & Offerings"`;
const DISPUTE = '2026-10-02,Dispute,Stripe,,,-25.00,15.00,-40.00,card,,Chargeback';
const STRIPE_ADJUSTMENT = '2026-10-05,Charge,Stripe,X,,25.00,1.00,24.00,card,,Adjustment';
const file = (...lines: string[]) => [HEADER, ...lines].join('\n');

const pcoDays = (days: Record<string, Partial<Omit<DayCoverage, 'pcoIds'>> & { ids?: string[] }>) => {
  coverage.mockImplementation(async (_email: string, _userId: number, wanted: string[]) => {
    const m = new Map<string, DayCoverage>();
    for (const d of wanted) {
      const o = days[d] ?? {};
      m.set(d, {
        pcoGrossCents: o.pcoGrossCents ?? 0,
        postedGrossCents: o.postedGrossCents ?? 0,
        pcoIds: new Set(o.ids ?? []),
        refundedGrossCents: o.refundedGrossCents ?? 0,
      });
    }
    return m;
  });
};

const settings = (userId: number) => ({
  userId,
  isAutomationEnable: false,
  isAutomationRegistration: false,
  settingBankCharges: { account: { value: '5', label: 'Bank Charges' }, class: { value: 'gf', label: 'General Fund' } },
  settingBankData: [{ type: 'registration', value: CLEARING, label: 'Clearing Account' }],
  startDateAutomationRegistration: '10-01-2026',
  startDateAutomationFund: '09-15-2026',
  settingRegistrationData: { version: 2, default: { account: { value: '77', label: '44000 Event Income' } }, events: [] },
});

const linesOf = (je: any) =>
  je.Line.map((l: any) => [l.JournalEntryLineDetail.PostingType, l.JournalEntryLineDetail.AccountRef.value, l.Amount]);
const ledger = async (day: string): Promise<any> => DailyJeSync.findOne({ where: { userId: USER_ID, day } });
const interruptedRow = (o: any = {}) =>
  PayoutTransaction.create({
    userId: USER_ID,
    rowKey: 'registration:9:charge:2026-10-04:6000',
    day: '2026-10-04',
    type: 'Charge',
    source: 'Registrations',
    fundOrSignup: 'SHE Conference 2026',
    grossCents: 6000,
    feeCents: 159,
    netCents: 5841,
    status: 'pending',
    reason: 'posting_interrupted',
    accountRef: '77',
    ...o,
  } as any) as Promise<any>;

beforeAll(async () => {
  await sequelize.authenticate();
});
afterAll(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  posted = [];
  jest.clearAllMocks();
  mockedAutomation.automationJournalEntry.mockImplementation(async (_e: string, payload: any) => {
    posted.push(payload);
    return { Id: `JE${posted.length}` } as any;
  });
  pcoDays({});
  for (const id of [USER_ID, OTHER_ID]) {
    await PayoutTransaction.destroy({ where: { userId: id } });
    await PayoutReportUpload.destroy({ where: { userId: id } });
    await DailyJeSync.destroy({ where: { userId: id } });
    await UserSettings.destroy({ where: { userId: id } });
    await User.destroy({ where: { id } });
  }
  await User.create({ id: USER_ID, email: EMAIL, isActive: true, role: 'client' } as any);
  await UserSettings.create(settings(USER_ID) as any);
});

describe('listReview', () => {
  test('held, giving not posted and interrupted lines - but not a line an upload is posting right now', async () => {
    pcoDays({ '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 0, ids: ['101'] } });
    await importPayoutReport({ email: EMAIL, csvText: file(DISPUTE, gift('2026-10-06', 101, 50, 1.5)) });
    await interruptedRow({ qboEntryId: '555' });
    await interruptedRow({ rowKey: 'registration:10:charge:2026-10-04:6000', reason: null }); // just went pending

    const r = await listReview(EMAIL);
    expect(r.held).toMatchObject([{ status: 'held', reason: 'unrecognised_type', type: 'Dispute', net: -40 }]);
    expect(r.givingNotPosted).toMatchObject([{ day: '2026-10-06', reason: 'day_not_posted', gross: 50, fee: 1.5, net: 48.5 }]);
    expect(r.postingInterrupted).toMatchObject([{ status: 'posting_interrupted', reason: 'posting_interrupted', qboEntryId: '555' }]);
  });
});

describe('resolvePayoutRow', () => {
  test("a held line coded by a person posts on its own, continuing the day's numbering", async () => {
    await importPayoutReport({ email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59), STRIPE_ADJUSTMENT) });
    const [held] = (await listReview(EMAIL)).held;
    expect(held.reason).toBe('unrecognised_source');
    posted = [];

    const res = await resolvePayoutRow({
      email: EMAIL,
      id: held.id,
      action: 'post',
      account: { value: '80', label: 'Misc Income' },
      class: { value: 'gf', label: 'General Fund' },
      resolvedBy: 'bk@example.test',
    });
    expect(res).toMatchObject({ status: 'resolved', docNumber: 'CSP-E-2026-10-05-2', qboEntryId: 'JE1' });
    expect(linesOf(posted[0])).toEqual([
      ['Credit', '80', 25],
      ['Debit', '5', 1],
      ['Debit', CLEARING, 24],
    ]);
    const row: any = await PayoutTransaction.findByPk(held.id);
    expect(row).toMatchObject({ status: 'resolved', accountRef: '80', classRef: 'gf', resolvedBy: 'bk@example.test', reason: null, qboEntryId: 'JE1' });
    expect(row.resolvedAt).toBeInstanceOf(Date);
    const oct5 = await ledger('2026-10-05');
    expect(Number(oct5.registrationGrossCents)).toBe(6000 + 2500);
    expect(Number(oct5.registrationFeeCents)).toBe(159 + 100);
    expect(oct5.registrationEntryCount).toBe(2);
    expect((await listReview(EMAIL)).held).toEqual([]);
  });

  test('QuickBooks refusing a coded line puts it back in the list', async () => {
    await importPayoutReport({ email: EMAIL, csvText: file(STRIPE_ADJUSTMENT) });
    const [held] = (await listReview(EMAIL)).held;
    mockedAutomation.automationJournalEntry.mockRejectedValueOnce({ Fault: { Error: [{ Message: 'Invalid account' }] } });
    await expect(resolvePayoutRow({ email: EMAIL, id: held.id, action: 'post', account: { value: '80' } })).rejects.toThrow(
      /QuickBooks did not take the entry: Invalid account/,
    );
    expect(await PayoutTransaction.findByPk(held.id)).toMatchObject({ status: 'held', reason: 'unrecognised_source' });
  });

  test.each([
    ["amounts that don't add up", '2026-10-05,Charge,Stripe,X,,25.00,1.00,20.00,card,,Odd'],
    ['a refund that returns a fee', '2026-10-05,Refund,Registrations,X,SHE,-25.00,1.00,-26.00,card,,"REFUND FOR CHARGE (Registration #5)"'],
    ['a dispute', DISPUTE],
  ])('%s can only be marked handled', async (_name, line) => {
    await importPayoutReport({ email: EMAIL, csvText: file(line) });
    const [held] = (await listReview(EMAIL)).held;
    await expect(resolvePayoutRow({ email: EMAIL, id: held.id, action: 'post', account: { value: '80' } })).rejects.toThrow(
      /Record it yourself and mark it handled/,
    );
    expect(posted).toHaveLength(0);
    expect(await PayoutTransaction.findByPk(held.id)).toMatchObject({ status: 'held' });
  });

  test('marking a line handled needs a note, and a later upload leaves it handled', async () => {
    await importPayoutReport({ email: EMAIL, csvText: file(DISPUTE) });
    const [held] = (await listReview(EMAIL)).held;
    await expect(resolvePayoutRow({ email: EMAIL, id: held.id, action: 'dismiss', note: '   ' })).rejects.toThrow(/note/);

    const res = await resolvePayoutRow({ email: EMAIL, id: held.id, action: 'dismiss', note: 'Recorded by hand, JE 123', resolvedBy: 'bk@example.test' });
    expect(res).toEqual({ id: held.id, status: 'dismissed' });
    expect(await PayoutTransaction.findByPk(held.id)).toMatchObject({ status: 'dismissed', note: 'Recorded by hand, JE 123', resolvedBy: 'bk@example.test' });

    await importPayoutReport({ email: EMAIL, csvText: file(DISPUTE) });
    expect((await listReview(EMAIL)).held).toEqual([]);
  });

  test('a giving line can be marked handled too', async () => {
    pcoDays({ '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 0, ids: ['101'] } });
    await importPayoutReport({ email: EMAIL, csvText: file(gift('2026-10-06', 101, 50, 1.5)) });
    const [line] = (await listReview(EMAIL)).givingNotPosted;
    await resolvePayoutRow({ email: EMAIL, id: line.id, action: 'dismiss', note: 'Cash entry covers it' });
    expect((await listReview(EMAIL)).givingNotPosted).toEqual([]);
  });

  test('a line that is not waiting for review is refused, and another church cannot touch it', async () => {
    await importPayoutReport({ email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    const postedRow: any = await PayoutTransaction.findOne({ where: { userId: USER_ID, status: 'posted' } });
    await expect(resolvePayoutRow({ email: EMAIL, id: postedRow.id, action: 'post', account: { value: '80' } })).rejects.toMatchObject({ status: 409 });
    await expect(resolvePayoutRow({ email: EMAIL, id: postedRow.id, action: 'dismiss', note: 'x' })).rejects.toMatchObject({ status: 409 });
    await expect(resolvePayoutRow({ email: EMAIL, id: postedRow.id, action: 'mark_posted', qboEntryId: '1' })).rejects.toMatchObject({ status: 409 });
    await expect(resolvePayoutRow({ email: EMAIL, id: 987654321, action: 'dismiss', note: 'x' })).rejects.toMatchObject({ status: 404 });

    await User.create({ id: OTHER_ID, email: OTHER_EMAIL, isActive: true, role: 'client' } as any);
    await UserSettings.create(settings(OTHER_ID) as any);
    await importPayoutReport({ email: OTHER_EMAIL, csvText: file(DISPUTE) });
    const [theirs] = (await listReview(OTHER_EMAIL)).held;
    await expect(resolvePayoutRow({ email: EMAIL, id: theirs.id, action: 'dismiss', note: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(await PayoutTransaction.findByPk(theirs.id)).toMatchObject({ status: 'held' });
  });

  test('an interrupted line found in QuickBooks is marked posted and counted on the ledger', async () => {
    const row = await interruptedRow();
    const res = await resolvePayoutRow({ email: EMAIL, id: row.id, action: 'mark_posted', qboEntryId: '#555', resolvedBy: 'bk@example.test' });
    expect(res).toEqual({ id: row.id, status: 'posted', qboEntryId: '555' });
    expect(posted).toHaveLength(0);
    const oct4 = await ledger('2026-10-04');
    expect(Number(oct4.registrationGrossCents)).toBe(6000);
    expect(Number(oct4.registrationFeeCents)).toBe(159);
    expect(oct4.registrationEntryCount).toBe(1);
    expect(oct4.registrationEntryIds).toEqual(['555']);
    expect(await PayoutTransaction.findByPk(row.id)).toMatchObject({ status: 'posted', qboEntryId: '555', reason: null });
  });

  test('an interrupted line QuickBooks does not have is posted once, however many clicks', async () => {
    const row = await interruptedRow();
    const results = await Promise.allSettled([
      resolvePayoutRow({ email: EMAIL, id: row.id, action: 'post_now' }),
      resolvePayoutRow({ email: EMAIL, id: row.id, action: 'post_now' }),
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ TxnDate: '2026-10-04', DocNumber: 'CSP-E-2026-10-04-1' });
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(await PayoutTransaction.findByPk(row.id)).toMatchObject({ status: 'posted', qboEntryId: 'JE1' });
  });
});

describe('recheckGiving', () => {
  test('flips giving lines whose day has since been posted', async () => {
    pcoDays({
      '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 0, ids: ['101'] },
      '2026-10-07': { pcoGrossCents: 3000, postedGrossCents: 0, ids: ['102'] },
    });
    await importPayoutReport({ email: EMAIL, csvText: file(gift('2026-10-06', 101, 50, 1.5), gift('2026-10-07', 102, 30, 1)) });
    pcoDays({
      '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 5000, ids: ['101'] },
      '2026-10-07': { pcoGrossCents: 3000, postedGrossCents: 0, ids: ['102'] },
    });
    expect(await recheckGiving(EMAIL)).toEqual({ checked: 2, nowCovered: 1, stillNotPosted: 1 });
    expect((await listReview(EMAIL)).givingNotPosted.map((r) => r.day)).toEqual(['2026-10-07']);
    expect(coverage).toHaveBeenLastCalledWith(EMAIL, USER_ID, ['2026-10-06', '2026-10-07']);
  });

  test('nothing to check', async () => {
    expect(await recheckGiving(EMAIL)).toEqual({ checked: 0, nowCovered: 0, stillNotPosted: 0 });
  });
});

describe('getPayoutStatus', () => {
  test('last upload, what needs a person, and whether setup is complete', async () => {
    expect(await getPayoutStatus(EMAIL)).toEqual({
      lastUpload: null,
      needsReview: 0,
      givingNotPosted: 0,
      registrationStartDay: '2026-10-01',
      ready: true,
      notReadyReason: null,
    });

    pcoDays({ '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 0, ids: ['101'] } });
    await importPayoutReport({
      email: EMAIL,
      fileName: 'oct.csv',
      uploadedBy: 'bk@example.test',
      csvText: file(DISPUTE, gift('2026-10-06', 101, 50, 1.5), reg('2026-10-05', 1, 60, 1.59)),
    });
    await interruptedRow();
    const s = await getPayoutStatus(EMAIL);
    expect(s).toMatchObject({
      lastUpload: { fileName: 'oct.csv', firstDay: '2026-10-02', lastDay: '2026-10-06', uploadedBy: 'bk@example.test' },
      needsReview: 2,
      givingNotPosted: 1,
      ready: true,
    });
    expect(typeof s.lastUpload?.uploadedAt).toBe('string');

    await UserSettings.update({ startDateAutomationRegistration: null } as any, { where: { userId: USER_ID } });
    expect(await getPayoutStatus(EMAIL)).toMatchObject({
      ready: false,
      registrationStartDay: null,
      notReadyReason: expect.stringMatching(/date to record registrations from/),
    });
  });

  test('a missing fee account is not ready', async () => {
    await UserSettings.update({ settingBankCharges: null } as any, { where: { userId: USER_ID } });
    expect(await getPayoutStatus(EMAIL)).toMatchObject({ ready: false, notReadyReason: expect.stringMatching(/Stripe fees/) });
  });
});

describe('listSignups', () => {
  test('the registration names seen so far, sorted, giving funds excluded', async () => {
    await importPayoutReport({
      email: EMAIL,
      csvText: file(
        reg('2026-10-05', 1, 60, 1.59, 'Young Adult Retreat 2027'),
        reg('2026-10-05', 2, 60, 1.59),
        reg('2026-10-06', 3, 20, 1.04, "Active Church Men's Breakfast"),
        gift('2026-10-05', 100, 100, 3),
      ),
    });
    expect(await listSignups(EMAIL)).toEqual(["Active Church Men's Breakfast", 'SHE Conference 2026', 'Young Adult Retreat 2027']);
  });
});
