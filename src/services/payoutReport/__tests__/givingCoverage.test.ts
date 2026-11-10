jest.mock('../../../controller/automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../donationSweep', () => ({ fetchDonationsForRange: jest.fn() }));
jest.mock('../../dailyDonationSync', () => ({ getOrgTimeZone: jest.fn() }));
jest.mock('../../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));

import { generatePcToken } from '../../../controller/automation';
import { fetchDonationsForRange } from '../../donationSweep';
import { getOrgTimeZone } from '../../dailyDonationSync';
import DailyJeSync from '../../../db/models/DailyJeSync';
import { givingCoverage, loadDayCoverage, DayCoverage } from '../givingCoverage';

const charge = (id: string, day: string, grossCents = 1000) => ({ externalId: `donation:${id}`, day, type: 'Charge', grossCents } as any);
const refund = (id: string, day: string, grossCents: number) => ({ externalId: `donation:${id}`, day, type: 'Refund', grossCents } as any);
const cov = (o: Partial<DayCoverage>): DayCoverage => ({
  pcoGrossCents: 0,
  postedGrossCents: 0,
  pcoIds: new Set<string>(),
  knownGrossCents: 0,
  refundedGrossCents: 0,
  failedIds: new Set<string>(),
  ...o,
});

describe('givingCoverage', () => {
  const days = new Map([
    ['2026-10-05', cov({ pcoGrossCents: 10000, postedGrossCents: 10000, pcoIds: new Set(['1', '2']) })],
    ['2026-10-06', cov({ pcoGrossCents: 5000, postedGrossCents: 2000, pcoIds: new Set(['3']) })],
    ['2026-10-07', cov({ pcoGrossCents: 4000, postedGrossCents: 0, pcoIds: new Set(['4']) })],
  ]);

  test.each([
    ['1', '2026-10-05', 'giving_covered', undefined],
    ['3', '2026-10-06', 'giving_not_posted', 'day_partly_posted'],
    ['4', '2026-10-07', 'giving_not_posted', 'day_not_posted'],
    ['9', '2026-10-05', 'giving_not_posted', 'not_in_planning_center'],
    ['5', '2026-09-01', 'giving_covered', 'before_giving_start'],
  ])('donation %s on %s -> %s', (id, day, status, reason) => {
    const [result] = givingCoverage([charge(id, day)], { givingStartDay: '2026-09-15', days });
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
  });

  // Active Church, October 2026 (2026-11-09): the two lines its upload wrongly called missing.
  test('a late-evening gift the file dates the next day is found on its own day', () => {
    const late = new Map([
      ['2026-10-15', cov({ pcoGrossCents: 160816, postedGrossCents: 160816, pcoIds: new Set(['407356032']) })],
      ['2026-10-16', cov({ pcoGrossCents: 154571, postedGrossCents: 154571, pcoIds: new Set(['1']) })],
    ]);
    expect(givingCoverage([charge('407356032', '2026-10-16', 18700)], { givingStartDay: '2026-09-15', days: late })[0]).toMatchObject({
      status: 'giving_covered',
      day: '2026-10-15',
    });
  });

  test('...judged on that day: not posted there means not posted', () => {
    const late = new Map([['2026-10-15', cov({ pcoGrossCents: 18700, postedGrossCents: 0, pcoIds: new Set(['9']) })]]);
    expect(givingCoverage([charge('9', '2026-10-16')], { givingStartDay: '2026-09-15', days: late })[0]).toMatchObject({
      status: 'giving_not_posted',
      reason: 'day_not_posted',
      day: '2026-10-15',
    });
  });

  test('...and before the sync start it is before the start', () => {
    const early = new Map([['2026-09-30', cov({ pcoIds: new Set(['9']) })]]);
    expect(givingCoverage([charge('9', '2026-10-01')], { givingStartDay: '2026-10-01', days: early })[0]).toMatchObject({
      status: 'giving_covered',
      reason: 'before_giving_start',
    });
  });

  describe('a gift the donor\'s bank returned (failed in Planning Center)', () => {
    const returned = (o: Partial<DayCoverage>) =>
      givingCoverage([charge('404799338', '2026-10-04', 60000)], {
        givingStartDay: '2026-09-15',
        days: new Map([['2026-10-04', cov({ failedIds: new Set(['404799338']), ...o })]]),
      })[0];

    test('its day posted exactly what Planning Center counts without it: never in QuickBooks', () => {
      // 10/4 as it really is: CSP posted $4,788.48, Planning Center's total without the $600.
      expect(returned({ postedGrossCents: 478848, knownGrossCents: 478848 })).toMatchObject({ status: 'giving_not_posted', reason: 'returned_gift' });
    });
    test('nothing posted that day: never in QuickBooks', () => {
      expect(returned({ postedGrossCents: 0, knownGrossCents: 5000 })).toMatchObject({ reason: 'returned_gift' });
    });
    test('the day holds more than Planning Center counts: CSP posted it before it came back', () => {
      expect(returned({ postedGrossCents: 538848, knownGrossCents: 478848 })).toMatchObject({ reason: 'returned_after_posting' });
    });
    test('a gift refunded before the day was posted does not make it look unsettled', () => {
      // $500 settled and posted; a $100 gift refunded before posting (never posted); the $600 returned.
      expect(returned({ pcoGrossCents: 50000, postedGrossCents: 50000, knownGrossCents: 60000 })).toMatchObject({ reason: 'returned_gift' });
    });
    test("the day is only partly posted: CSP can't tell yet", () => {
      expect(returned({ pcoGrossCents: 478848, postedGrossCents: 300000, knownGrossCents: 478848 })).toMatchObject({ reason: 'returned_day_unsettled' });
    });
    test('before the sync start: left alone', () => {
      expect(
        givingCoverage([charge('404799338', '2026-10-04', 60000)], {
          givingStartDay: '2026-10-10',
          days: new Map([['2026-10-04', cov({ failedIds: new Set(['404799338']) })]]),
        })[0],
      ).toMatchObject({ status: 'giving_covered', reason: 'before_giving_start' });
    });
  });

  test('Planning Center unreachable: nothing is called covered', () => {
    expect(givingCoverage([charge('1', '2026-10-05')], { givingStartDay: '2026-09-15', days: null })[0]).toMatchObject({
      status: 'giving_not_posted',
      reason: 'planning_center_unreachable',
    });
  });

  test("a refund is covered once CSP has reversed at least the file's refunds for that day", () => {
    const refundDays = new Map([['2026-10-08', cov({ refundedGrossCents: 7500 })]]);
    const rows = [refund('11', '2026-10-08', -5000), refund('12', '2026-10-08', -2500)];
    expect(givingCoverage(rows, { givingStartDay: '2026-09-15', days: refundDays }).map((r) => r.status)).toEqual([
      'giving_covered',
      'giving_covered',
    ]);
  });

  test('a refund CSP has not reversed (or only partly) needs attention', () => {
    const refundDays = new Map([['2026-10-08', cov({ refundedGrossCents: 5000 })]]);
    const rows = [refund('11', '2026-10-08', -5000), refund('12', '2026-10-08', -2500)];
    expect(givingCoverage(rows, { givingStartDay: '2026-09-15', days: refundDays })[1]).toMatchObject({
      status: 'giving_not_posted',
      reason: 'refund_not_posted',
    });
  });
});

describe('loadDayCoverage', () => {
  const gift = (id: string, receivedAt: string, o: any = {}) => ({
    id,
    attributes: { received_at: receivedAt, payment_method: 'card', payment_status: 'succeeded', amount_cents: 1000, fee_cents: 59, refunded: false, ...o },
  });

  beforeEach(() => {
    jest.resetAllMocks();
    (generatePcToken as jest.Mock).mockResolvedValue({ access_token: 't' });
    (getOrgTimeZone as jest.Mock).mockResolvedValue('America/Los_Angeles');
    // BIGINT columns arrive as strings.
    (DailyJeSync.findAll as jest.Mock).mockResolvedValue([
      { toJSON: () => ({ day: '2026-10-05', postedGrossCents: '6000', refundedGrossCents: '2500' }) },
    ]);
  });

  test('settled gifts only in the day total; refunded ones still count as known gifts', async () => {
    (fetchDonationsForRange as jest.Mock).mockResolvedValue({
      donations: [
        gift('1', '2026-10-05T17:00:00Z', { amount_cents: 6000 }),
        gift('2', '2026-10-05T18:00:00Z', { payment_method: 'ach', payment_status: 'pending', amount_cents: 9000 }),
        gift('3', '2026-10-05T19:00:00Z', { refunded: true, amount_cents: 4000 }),
        gift('4', '2026-10-05T20:00:00Z', { payment_method: 'cash', fee_cents: 0, amount_cents: 2000 }),
      ],
    });
    const map = await loadDayCoverage('a@b.test', 1, ['2026-10-05']);
    const d = map!.get('2026-10-05')!;
    expect(d.pcoGrossCents).toBe(6000);
    expect([...d.pcoIds].sort()).toEqual(['1', '3']);
    expect(d.postedGrossCents).toBe(6000);
    expect(d.refundedGrossCents).toBe(2500);
  });

  test("days are the church's local days, and the fetch is padded so late-evening gifts are found", async () => {
    (fetchDonationsForRange as jest.Mock).mockResolvedValue({ donations: [gift('7', '2026-10-06T02:00:00Z')] });
    const map = await loadDayCoverage('a@b.test', 1, ['2026-10-05']);
    // The day either side is covered too (a gift may be filed there), with a day of margin.
    expect((fetchDonationsForRange as jest.Mock).mock.calls[0].slice(1)).toEqual(['2026-10-03', '2026-10-07']);
    expect([...map!.get('2026-10-05')!.pcoIds]).toEqual(['7']);
    expect([...map!.keys()]).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
  });

  test('a card or ACH gift that failed is listed as failed, not as a gift', async () => {
    const g = gift('8', '2026-10-05T18:00:00Z');
    (fetchDonationsForRange as jest.Mock).mockResolvedValue({ donations: [{ ...g, attributes: { ...g.attributes, payment_status: 'failed' } }] });
    const day = (await loadDayCoverage('a@b.test', 1, ['2026-10-05']))!.get('2026-10-05')!;
    expect([...day.failedIds]).toEqual(['8']);
    expect([...day.pcoIds]).toEqual([]);
    expect(day.knownGrossCents).toBe(0);
  });

  test('cannot read Planning Center -> null, never an empty "all clear"', async () => {
    (generatePcToken as jest.Mock).mockResolvedValue(null);
    expect(await loadDayCoverage('a@b.test', 1, ['2026-10-05'])).toBeNull();
    (generatePcToken as jest.Mock).mockResolvedValue({ access_token: 't' });
    (getOrgTimeZone as jest.Mock).mockResolvedValue(null);
    expect(await loadDayCoverage('a@b.test', 1, ['2026-10-05'])).toBeNull();
    (getOrgTimeZone as jest.Mock).mockResolvedValue('America/Los_Angeles');
    (fetchDonationsForRange as jest.Mock).mockRejectedValue(new Error('429'));
    expect(await loadDayCoverage('a@b.test', 1, ['2026-10-05'])).toBeNull();
  });

  test('a database failure is an error, not "Planning Center unreachable"', async () => {
    (fetchDonationsForRange as jest.Mock).mockResolvedValue({ donations: [] });
    (DailyJeSync.findAll as jest.Mock).mockRejectedValue(new Error('column does not exist'));
    await expect(loadDayCoverage('a@b.test', 1, ['2026-10-05'])).rejects.toThrow('column does not exist');
  });

  test('no days asked for -> empty map without calling Planning Center', async () => {
    expect((await loadDayCoverage('a@b.test', 1, []))!.size).toBe(0);
    expect(generatePcToken).not.toHaveBeenCalled();
  });
});
