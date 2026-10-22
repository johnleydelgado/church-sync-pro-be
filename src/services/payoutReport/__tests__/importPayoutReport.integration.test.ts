/**
 * Recording a payout report end to end against a real Postgres, with QuickBooks and Planning
 * Center faked. What matters: every registration is posted exactly once, nothing is posted
 * before its start date, a refused day is retried and an interrupted one never is, and the
 * giving lines are checked against CSP's own day ledger.
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
import { importPayoutReport, previewPayoutReport, PayoutImportSetupError, PayoutImportBusyError } from '../importPayoutReport';
import { PayoutReportFormatError } from '../parsePayoutReport';

const mockedAutomation = automation as jest.Mocked<typeof automation>;
const coverage = loadDayCoverage as jest.Mock;

/** "Payouts in this file: from / to" - required on every upload. */
const PAYOUTS = { payoutFrom: '2026-10-01', payoutTo: '2026-10-20' };
const EMAIL = 'payout@example.test';
const USER_ID = 90010;
const CLEARING = '1150040022';
let posted: any[] = [];

const HEADER = 'Date,Type,Source,Name,Fund/Signup,Gross,Fee,Net,Payment method,Campus,Description';
const money = (n: number) => n.toFixed(2);
const reg = (day: string, id: number, gross: number, fee: number, signup = 'SHE Conference 2026') =>
  `${day},Charge,Registrations,Person ${id},${signup},${money(gross)},${money(fee)},${money(gross - fee)},card,,"Registration #${id} - Person ${id} - ${signup}"`;
const regRefund = (day: string, id: number, gross: number, signup = 'SHE Conference 2026') =>
  `${day},Refund,Registrations,Person ${id},${signup},-${money(gross)},0.00,-${money(gross)},card,,"REFUND FOR CHARGE (Registration #${id} - Person ${id} - ${signup})"`;
const gift = (day: string, id: number, gross: number, fee: number) =>
  `${day},Charge,Giving,Donor ${id},Tithes & Offerings,${money(gross)},${money(fee)},${money(gross - fee)},card,,"Donation #${id} - Donor ${id} - Tithes & Offerings"`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n');

/** The giving check's view of Planning Center + the ledger: unlisted days have nothing. */
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

const settings = (o: any = {}) => ({
  userId: USER_ID,
  isAutomationEnable: false,
  isAutomationRegistration: false,
  settingBankCharges: { account: { value: '5', label: 'Bank Charges' }, class: { value: 'gf', label: 'General Fund' } },
  settingBankData: [{ type: 'registration', value: CLEARING, label: 'Clearing Account' }],
  startDateAutomationRegistration: '10-01-2026',
  startDateAutomationFund: '09-15-2026',
  settingRegistrationData: { version: 2, default: { account: { value: '77', label: '44000 Event Income' } }, events: [] },
  ...o,
});

const rowsByKey = async () => {
  const rows = await PayoutTransaction.findAll({ where: { userId: USER_ID }, order: [['id', 'ASC']] });
  return new Map((rows as any[]).map((r) => [String(r.rowKey), r]));
};
const ledger = async (day: string): Promise<any> => DailyJeSync.findOne({ where: { userId: USER_ID, day } });
const linesOf = (je: any) =>
  je.Line.map((l: any) => [l.JournalEntryLineDetail.PostingType, l.JournalEntryLineDetail.AccountRef.value, l.Amount]);
const postNormally = () =>
  mockedAutomation.automationJournalEntry.mockImplementation(async (_e: string, payload: any) => {
    posted.push(payload);
    return { Id: `JE${posted.length}` } as any;
  });

const OCT = file(
  reg('2026-10-05', 1, 60, 1.59),
  reg('2026-10-05', 2, 60, 1.59),
  reg('2026-10-06', 3, 30, 0.95),
  regRefund('2026-10-06', 4, 55),
  gift('2026-10-05', 100, 100, 3),
);
const OCT_5_POSTED = { '2026-10-05': { pcoGrossCents: 10000, postedGrossCents: 10000, ids: ['100'] } };

beforeAll(async () => {
  await sequelize.authenticate();
});
afterAll(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  posted = [];
  jest.clearAllMocks();
  postNormally();
  pcoDays({});
  await PayoutTransaction.destroy({ where: { userId: USER_ID } });
  await PayoutReportUpload.destroy({ where: { userId: USER_ID } });
  await DailyJeSync.destroy({ where: { userId: USER_ID } });
  await UserSettings.destroy({ where: { userId: USER_ID } });
  await User.destroy({ where: { id: USER_ID } });
  await User.create({ id: USER_ID, email: EMAIL, isActive: true, role: 'client' } as any);
  await UserSettings.create(settings() as any);
});

describe('preview', () => {
  test('says what an import would do, and writes nothing', async () => {
    pcoDays(OCT_5_POSTED);
    const s = await previewPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT });
    expect(s.file).toEqual({ rows: 5, firstDay: '2026-10-05', lastDay: '2026-10-06', payoutFrom: '2026-10-01', payoutTo: '2026-10-20' });
    expect(s.registrations).toEqual({
      toPost: { count: 4, gross: 95, fees: 4.13, net: 90.87 },
      alreadyRecorded: 0,
      beforeStart: { count: 0, net: 0 },
    });
    expect(s.entries).toEqual([
      { day: '2026-10-05', kind: 'charge', docNumber: 'CSP-E-2026-10-05-1', count: 2, gross: 120, fees: 3.18, net: 116.82 },
      { day: '2026-10-06', kind: 'charge', docNumber: 'CSP-E-2026-10-06-1', count: 1, gross: 30, fees: 0.95, net: 29.05 },
      { day: '2026-10-06', kind: 'refund', docNumber: 'CSP-ER-2026-10-06-2', count: 1, gross: -55, fees: 0, net: -55 },
    ]);
    expect(s.giving).toEqual({ covered: 1, notPosted: [] });
    expect(s.held).toEqual([]);
    expect(await PayoutTransaction.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await PayoutReportUpload.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await DailyJeSync.count({ where: { userId: USER_ID } })).toBe(0);
    expect(posted).toHaveLength(0);
  });
});

describe('import', () => {
  test('posts one entry per day and kind, and records it on the ledger, the rows and the upload', async () => {
    pcoDays(OCT_5_POSTED);
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, fileName: 'oct.csv', csvText: OCT, uploadedBy: 'bk@example.test' });

    expect(posted.map((je) => [je.TxnDate, je.DocNumber])).toEqual([
      ['2026-10-05', 'CSP-E-2026-10-05-1'],
      ['2026-10-06', 'CSP-E-2026-10-06-1'],
      ['2026-10-06', 'CSP-ER-2026-10-06-2'],
    ]);
    expect(linesOf(posted[0])).toEqual([
      ['Credit', '77', 120],
      ['Debit', '5', 3.18],
      ['Debit', CLEARING, 116.82],
    ]);
    expect(linesOf(posted[2])).toEqual([
      ['Debit', '77', 55],
      ['Credit', CLEARING, 55],
    ]);
    expect(s.entries.map((e) => e.qboEntryId)).toEqual(['JE1', 'JE2', 'JE3']);
    expect(typeof s.uploadId).toBe('number');

    const oct5 = await ledger('2026-10-05');
    expect(Number(oct5.registrationGrossCents)).toBe(12000);
    expect(Number(oct5.registrationFeeCents)).toBe(318);
    expect(oct5.registrationEntryCount).toBe(1);
    expect(oct5.registrationEntryIds).toEqual(['JE1']);
    // Giving's side of the day is untouched: its first entry will still be CSP-<day>-1.
    expect(Number(oct5.postedGrossCents)).toBe(0);
    expect(oct5.entryCount).toBe(0);
    const oct6 = await ledger('2026-10-06');
    expect(Number(oct6.registrationGrossCents)).toBe(3000);
    expect(Number(oct6.registrationRefundGrossCents)).toBe(5500);
    expect(oct6.registrationEntryCount).toBe(2);
    expect(oct6.registrationEntryIds).toEqual(['JE2', 'JE3']);

    const rows = await rowsByKey();
    expect(rows.size).toBe(5);
    expect(rows.get('registration:1:charge:2026-10-05:6000')).toMatchObject({ status: 'posted', qboEntryId: 'JE1', accountRef: '77' });
    expect(rows.get('registration:4:refund:2026-10-06:-5500')).toMatchObject({ status: 'posted', qboEntryId: 'JE3' });
    expect(rows.get('donation:100:charge:2026-10-05:10000')).toMatchObject({ status: 'giving_covered' });

    const upload: any = await PayoutReportUpload.findOne({ where: { userId: USER_ID } });
    expect(upload).toMatchObject({
      fileName: 'oct.csv',
      uploadedBy: 'bk@example.test',
      rowCount: 5,
      firstDay: '2026-10-05',
      lastDay: '2026-10-06',
      payoutFrom: '2026-10-01',
      payoutTo: '2026-10-20',
    });
    expect(upload.summary.entries).toHaveLength(3);
    expect(upload.summary.file).toMatchObject({ payoutFrom: '2026-10-01', payoutTo: '2026-10-20' });
  });

  test('each row points at the upload with the earliest payout dates it has appeared in', async () => {
    pcoDays(OCT_5_POSTED);
    const payoutUploadIds = async () => [...new Set([...(await rowsByKey()).values()].map((r: any) => r.payoutUploadId))];
    const first = await importPayoutReport({ email: EMAIL, csvText: OCT, payoutFrom: '2026-10-15', payoutTo: '2026-10-20' });
    expect(await payoutUploadIds()).toEqual([first.uploadId]);
    const earlier = await importPayoutReport({ email: EMAIL, csvText: OCT, payoutFrom: '2026-10-07', payoutTo: '2026-10-10' });
    expect(await payoutUploadIds()).toEqual([earlier.uploadId]);
    await importPayoutReport({ email: EMAIL, csvText: OCT, payoutFrom: '2026-10-01', payoutTo: '2026-10-20' });
    expect(await payoutUploadIds()).toEqual([earlier.uploadId]);
    // Which upload created or re-checked a row is unchanged.
    expect((await rowsByKey()).get('registration:1:charge:2026-10-05:6000')).toMatchObject({ uploadId: first.uploadId });
  });

  test('payout dates that end before the rows were charged are refused, and nothing is stored', async () => {
    pcoDays(OCT_5_POSTED);
    const err = await importPayoutReport({ email: EMAIL, csvText: OCT, payoutFrom: '2026-09-01', payoutTo: '2026-09-30' }).catch((e) => e);
    expect(err).toBeInstanceOf(PayoutReportFormatError);
    expect(err.message).toBe(
      'This file has rows dated as late as Oct 6, after the last payout date entered (Sep 30). Nothing is paid out before it happens, so check the payout dates.',
    );
    expect(coverage).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
    expect(await PayoutReportUpload.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await PayoutTransaction.count({ where: { userId: USER_ID } })).toBe(0);
  });

  test.each([
    ['no payout dates', {}, 'Enter the dates of the payouts in this file: from and to.'],
    ['dates the wrong way round', { payoutFrom: '2026-10-20', payoutTo: '2026-10-01' }, 'The payout dates are the wrong way round'],
    ['a last date in the future', { payoutFrom: '2026-10-01', payoutTo: '2099-10-31' }, 'is in the future'],
    ['dates across a month-end', { payoutFrom: '2026-09-25', payoutTo: '2026-10-05' }, "Split it at the month-end: CSP can't tell which side of Sep 30"],
  ])('%s: refused with a sentence, and nothing is read, posted or stored', async (_name, dates, message) => {
    pcoDays(OCT_5_POSTED);
    const err = await importPayoutReport({ ...dates, email: EMAIL, csvText: OCT }).catch((e) => e);
    expect(err).toBeInstanceOf(PayoutReportFormatError);
    expect(err.message).toContain(message);
    await expect(previewPayoutReport({ ...dates, email: EMAIL, csvText: OCT })).rejects.toThrow(PayoutReportFormatError);
    expect(posted).toHaveLength(0);
    expect(coverage).not.toHaveBeenCalled();
    expect(await PayoutReportUpload.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await PayoutTransaction.count({ where: { userId: USER_ID } })).toBe(0);
  });

  test('uploading the same file again posts nothing', async () => {
    pcoDays(OCT_5_POSTED);
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT });
    posted = [];
    const again = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT });
    expect(posted).toHaveLength(0);
    expect(again.entries).toEqual([]);
    expect(again.registrations).toMatchObject({ toPost: { count: 0 }, alreadyRecorded: 4 });
    expect(again.giving.covered).toBe(1);
    expect(Number((await ledger('2026-10-05')).registrationGrossCents)).toBe(12000);
  });

  test('an overlapping file posts only its new rows, numbered after the earlier entries', async () => {
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-07', 3, 30, 0.95)) });
    posted = [];
    const s = await importPayoutReport({
      ...PAYOUTS,
      email: EMAIL,
      csvText: file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-07', 3, 30, 0.95), reg('2026-10-07', 5, 60, 1.59), reg('2026-10-08', 6, 30, 0.95)),
    });
    expect(posted.map((je) => je.DocNumber)).toEqual(['CSP-E-2026-10-07-2', 'CSP-E-2026-10-08-1']);
    expect(s.registrations).toMatchObject({ toPost: { count: 2, gross: 90 }, alreadyRecorded: 2 });
  });

  test('charges before the start date are left alone, and post if the start date moves earlier', async () => {
    const sept = file(reg('2026-09-28', 7, 60, 1.59), reg('2026-09-29', 8, 60, 1.59));
    const first = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: sept });
    expect(posted).toHaveLength(0);
    expect(first.registrations.beforeStart).toEqual({ count: 2, net: 116.82 });
    expect([...(await rowsByKey()).values()].map((r: any) => r.status)).toEqual(['before_start', 'before_start']);

    await UserSettings.update({ startDateAutomationRegistration: '09-01-2026' } as any, { where: { userId: USER_ID } });
    const second = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: sept });
    expect(posted.map((je) => je.TxnDate)).toEqual(['2026-09-28', '2026-09-29']);
    expect(second.registrations.toPost.count).toBe(2);
  });

  test('a day QuickBooks refuses is retried by the next upload; the other days post', async () => {
    mockedAutomation.automationJournalEntry.mockImplementation(async (_e: string, payload: any) => {
      if (payload.TxnDate === '2026-10-06') {
        throw { Fault: { Error: [{ Message: 'Invalid account', Detail: 'Account 77 is inactive' }] } };
      }
      posted.push(payload);
      return { Id: `JE${posted.length}` } as any;
    });
    const f = file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-06', 3, 30, 0.95));
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(posted.map((je) => je.TxnDate)).toEqual(['2026-10-05']);
    expect(s.entries[1]).toMatchObject({ day: '2026-10-06', error: 'Invalid account: Account 77 is inactive' });
    expect((await rowsByKey()).get('registration:3:charge:2026-10-06:3000')).toMatchObject({
      status: 'failed',
      reason: 'Invalid account: Account 77 is inactive',
    });
    expect((await ledger('2026-10-06'))?.registrationEntryCount ?? 0).toBe(0);

    postNormally();
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(posted.map((je) => [je.TxnDate, je.DocNumber])).toEqual([
      ['2026-10-05', 'CSP-E-2026-10-05-1'],
      ['2026-10-06', 'CSP-E-2026-10-06-1'],
    ]);
    expect((await rowsByKey()).get('registration:3:charge:2026-10-06:3000')).toMatchObject({ status: 'posted', reason: null });
  });

  test('QuickBooks took it but CSP could not record it: the rows wait for a person and are never posted again', async () => {
    const spy = jest.spyOn(DailyJeSync.prototype, 'update').mockRejectedValueOnce(new Error('connection lost'));
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    spy.mockRestore();
    expect(posted).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ docNumber: 'CSP-E-2026-10-05-1', qboEntryId: 'JE1' });
    expect(s.entries[0].error).toMatch(/review list/);
    expect((await rowsByKey()).get('registration:1:charge:2026-10-05:6000')).toMatchObject({
      status: 'pending',
      qboEntryId: 'JE1',
      reason: 'posting_interrupted',
    });

    posted = [];
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    expect(posted).toHaveLength(0);
  });

  test('a row left pending by a crash is not posted again by an upload', async () => {
    await PayoutTransaction.create({
      userId: USER_ID,
      rowKey: 'registration:1:charge:2026-10-05:6000',
      day: '2026-10-05',
      type: 'Charge',
      source: 'Registrations',
      grossCents: 6000,
      feeCents: 159,
      netCents: 5841,
      status: 'pending',
    } as any);
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    expect(posted).toHaveLength(0);
    expect(s.registrations.alreadyRecorded).toBe(1);
  });

  test('unrecognised lines are held once with their reason; later uploads leave them to the review list', async () => {
    const f = file('2026-10-02,Dispute,Stripe,,,-25.00,15.00,-40.00,card,,Chargeback', reg('2026-10-05', 1, 60, 1.59, 'Brand New Event'));
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(s.held).toEqual([
      { line: 2, day: '2026-10-02', type: 'Dispute', source: 'Stripe', fundOrSignup: '', net: -40, reason: 'unrecognised_type' },
    ]);
    // An event with no override goes to the default account.
    expect(linesOf(posted[0])[0]).toEqual(['Credit', '77', 60]);
    const held = [...(await rowsByKey()).values()].find((r: any) => r.status === 'held');
    expect(held).toMatchObject({ reason: 'unrecognised_type', type: 'Dispute', source: 'Stripe' });

    const again = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(again.held).toEqual([]);
    expect(again.registrations.alreadyRecorded).toBe(1);
  });

  test('a per-event override sends that event to its own account and class', async () => {
    await UserSettings.update(
      {
        settingRegistrationData: {
          version: 2,
          default: { account: { value: '77', label: '44000 Event Income' } },
          events: [{ signup: 'Young Adult Retreat 2027', account: { value: '78', label: 'Retreat Income' }, class: { value: 'ya', label: 'Young Adults' } }],
        },
      } as any,
      { where: { userId: USER_ID } },
    );
    await importPayoutReport({
      ...PAYOUTS,
      email: EMAIL,
      csvText: file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-05', 2, 500, 11.35, 'Young Adult Retreat 2027')),
    });
    const credits = posted[0].Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit').map((l: any) => [
      l.JournalEntryLineDetail.AccountRef.value,
      l.JournalEntryLineDetail.ClassRef?.value,
      l.Amount,
    ]);
    expect(credits).toEqual([
      ['77', undefined, 60],
      ['78', 'ya', 500],
    ]);
  });
});

describe('setup', () => {
  test.each([
    ['no registration start date', { startDateAutomationRegistration: null }, /date to record registrations from/],
    ['no default event account', { settingRegistrationData: { version: 2, default: { account: null }, events: [] } }, /income account for event payments/],
    ['only the old Stripe-era mapping', { settingRegistrationData: [{ registration: 'x', account: {} }] }, /income account for event payments/],
    ['no clearing account', { settingBankData: [] }, /clearing account on Mapping/],
    [
      'two different clearing accounts',
      { settingBankData: [{ type: 'donation', value: '1', label: 'A' }, { type: 'registration', value: '2', label: 'B' }] },
      /same clearing account/,
    ],
    ['no fee account while a row has a fee', { settingBankCharges: null }, /Stripe fees/],
  ])('%s: refused, nothing written', async (_name, override, message) => {
    await UserSettings.update(override as any, { where: { userId: USER_ID } });
    const attempt = importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT });
    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.toBeInstanceOf(PayoutImportSetupError);
    expect(await PayoutTransaction.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await PayoutReportUpload.count({ where: { userId: USER_ID } })).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test('a refund-only file needs no fee account', async () => {
    await UserSettings.update({ settingBankCharges: null } as any, { where: { userId: USER_ID } });
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(regRefund('2026-10-06', 4, 55)) });
    expect(posted).toHaveLength(1);
  });

  test('the giving clearing slot is used when there is no registration slot', async () => {
    await UserSettings.update({ settingBankData: [{ type: 'donation', value: '999', label: 'Stripe Clearing' }] } as any, {
      where: { userId: USER_ID },
    });
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    expect(linesOf(posted[0])[2]).toEqual(['Debit', '999', 58.41]);
  });

  test('preview refuses for the same reasons', async () => {
    await UserSettings.update({ startDateAutomationRegistration: null } as any, { where: { userId: USER_ID } });
    await expect(previewPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT })).rejects.toBeInstanceOf(PayoutImportSetupError);
  });
});

describe('two uploads at once', () => {
  test('each registration is posted once', async () => {
    pcoDays(OCT_5_POSTED);
    mockedAutomation.automationJournalEntry.mockImplementation(async (_e: string, payload: any) => {
      await new Promise((r) => setTimeout(r, 100));
      posted.push(payload);
      return { Id: `JE${posted.length}` } as any;
    });
    const results = await Promise.allSettled([
      importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT }),
      importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT }),
    ]);
    expect(posted).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PayoutImportBusyError);
    }
    const entries = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.entries.length : 0), 0);
    expect(entries).toBe(3);
    const oct6 = await ledger('2026-10-06');
    expect(Number(oct6.registrationGrossCents)).toBe(3000);
    expect(Number(oct6.registrationRefundGrossCents)).toBe(5500);
  });
});

describe('giving lines', () => {
  test('stored as covered or not posted, and re-checked by the next upload', async () => {
    const f = file(gift('2026-10-05', 100, 100, 3), gift('2026-10-06', 101, 50, 1.5));
    pcoDays({ ...OCT_5_POSTED, '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 0, ids: ['101'] } });
    const first = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(first.giving).toEqual({ covered: 1, notPosted: [{ day: '2026-10-06', count: 1, net: 48.5, reason: 'day_not_posted' }] });
    expect((await rowsByKey()).get('donation:101:charge:2026-10-06:5000')).toMatchObject({
      status: 'giving_not_posted',
      reason: 'day_not_posted',
    });

    pcoDays({ '2026-10-06': { pcoGrossCents: 5000, postedGrossCents: 5000, ids: ['101'] } });
    const second = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: f });
    expect(second.giving).toEqual({ covered: 2, notPosted: [] });
    expect((await rowsByKey()).get('donation:101:charge:2026-10-06:5000')).toMatchObject({ status: 'giving_covered', reason: null });
  });

  test('giving before the giving start date is covered without asking Planning Center', async () => {
    const s = await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(gift('2026-09-10', 90, 100, 3)) });
    expect(s.giving.covered).toBe(1);
    expect(coverage).toHaveBeenCalledWith(EMAIL, USER_ID, []);
  });
});

describe('earlier uploads covering the same dates', () => {
  test('a fresh file has none', async () => {
    const s = await previewPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: OCT });
    expect(s.overlap).toEqual({ rowsSeenBefore: 0, previousUploads: [] });
  });

  test('the preview names the earlier upload and counts the lines it already brought in', async () => {
    pcoDays(OCT_5_POSTED);
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, fileName: 'oct-week1.csv', uploadedBy: 'bk@example.test', csvText: OCT });
    const s = await previewPayoutReport({
      ...PAYOUTS,
      email: EMAIL,
      csvText: file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-06', 3, 30, 0.95), reg('2026-10-07', 5, 60, 1.59)),
    });
    expect(s.overlap.rowsSeenBefore).toBe(2);
    expect(s.overlap.previousUploads).toHaveLength(1);
    expect(s.overlap.previousUploads[0]).toMatchObject({
      fileName: 'oct-week1.csv',
      uploadedBy: 'bk@example.test',
      firstDay: '2026-10-05',
      lastDay: '2026-10-06',
      payoutFrom: '2026-10-01',
      payoutTo: '2026-10-20',
    });
    expect(typeof s.overlap.previousUploads[0].uploadedAt).toBe('string');
  });

  test('an upload with no dates in common is not mentioned', async () => {
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    const s = await previewPayoutReport({ ...PAYOUTS, email: EMAIL, csvText: file(reg('2026-10-20', 9, 60, 1.59)) });
    expect(s.overlap).toEqual({ rowsSeenBefore: 0, previousUploads: [] });
  });

  test('the import result lists the earlier uploads, not itself', async () => {
    await importPayoutReport({ ...PAYOUTS, email: EMAIL, fileName: 'first.csv', csvText: file(reg('2026-10-05', 1, 60, 1.59)) });
    const s = await importPayoutReport({
      ...PAYOUTS,
      email: EMAIL,
      fileName: 'second.csv',
      csvText: file(reg('2026-10-05', 1, 60, 1.59), reg('2026-10-05', 2, 60, 1.59)),
    });
    expect(s.overlap.rowsSeenBefore).toBe(1);
    expect(s.overlap.previousUploads.map((u) => u.fileName)).toEqual(['first.csv']);
  });
});
