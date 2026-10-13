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
  refundedGrossCents: 0,
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
    expect((fetchDonationsForRange as jest.Mock).mock.calls[0].slice(1)).toEqual(['2026-10-04', '2026-10-06']);
    expect([...map!.get('2026-10-05')!.pcoIds]).toEqual(['7']);
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
