/**
 * A day's row must say what is still in transit.
 *
 * The case that prompted this: five card gifts posted for 15 September, and three ACH gifts
 * dated the same day still pending in Planning Center. The row read "Posted · 5 donations ·
 * $925.86" and nothing else, so the only way to learn that $487.60 was still on its way was to
 * add the day up by hand in Planning Center. The totals and the entry are right to leave
 * pending money out; the row is wrong to hide that it exists.
 */
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/userSettings', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/UserSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../db/models/SyncRun', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../services/donationSweep', () => ({
  fetchDonationsForDay: jest.fn(),
  fetchDonationsForRange: jest.fn(),
}));
jest.mock('../../services/dailyDonationSync', () => {
  const actual = jest.requireActual('../../services/dailyDonationSync');
  return { ...actual, getOrgTimeZone: jest.fn(), runDailyDonationSync: jest.fn() };
});

import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import UserSync from '../../db/models/UserSync';
import { generatePcToken } from '../automation';
import { getOrgTimeZone } from '../../services/dailyDonationSync';
import { fetchDonationsForRange } from '../../services/donationSweep';
import { getStripeGivingByDay } from '../journalEntry';

const mockedUsers = Users as unknown as { findOne: jest.Mock };
const mockedSettings = UserSettings as unknown as { findOne: jest.Mock };
const mockedUserSync = UserSync as unknown as { findAll: jest.Mock };
const mockedToken = generatePcToken as unknown as jest.Mock;
const mockedTimeZone = getOrgTimeZone as unknown as jest.Mock;
const mockedSweep = fetchDonationsForRange as unknown as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

let nextId = 1;
const gift = (
  amountCents: number,
  feeCents: number,
  method: 'card' | 'ach' | 'cash',
  status: 'succeeded' | 'pending' | 'failed',
  receivedAt = '2026-09-15T14:00:00Z',
  extra: Record<string, unknown> = {},
) => ({
  type: 'Donation',
  id: String(nextId++),
  attributes: {
    amount_cents: amountCents,
    fee_cents: feeCents,
    payment_method: method,
    payment_status: status,
    received_at: receivedAt,
    ...extra,
  },
  relationships: { designations: { data: [] } },
});

// Matt's 15 September, as Planning Center reported it on 18 September.
const SEPT_15 = [
  gift(2000, 0, 'cash', 'succeeded'),
  gift(50000, -1105, 'card', 'succeeded'),
  gift(10000, -245, 'card', 'succeeded'),
  gift(20000, -460, 'card', 'succeeded'),
  gift(2586, -86, 'card', 'succeeded'),
  gift(10000, -245, 'card', 'succeeded'),
  gift(32000, -30, 'ach', 'pending'),
  gift(15030, -30, 'ach', 'pending'),
  gift(1730, -30, 'ach', 'pending'),
];

const callWith = async (donations: any[], syncRows: any[] = []) => {
  mockedUsers.findOne.mockResolvedValue({ toJSON: () => ({ id: 1 }) });
  mockedToken.mockResolvedValue({ access_token: 'tok' });
  mockedTimeZone.mockResolvedValue('America/New_York');
  mockedSettings.findOne.mockResolvedValue({ startDateAutomationFund: '09-15-2026' });
  mockedUserSync.findAll.mockResolvedValue(syncRows.map((r) => ({ toJSON: () => r })));
  mockedSweep.mockResolvedValue({ donations, included: [] });

  const res = makeRes();
  await getStripeGivingByDay({ query: { email: 'a@b.test', from: '2026-09-01', to: '2026-09-30' } } as any, res);
  return res.json.mock.calls[0][0].data;
};

const POSTED_SEPT_15 = { donationId: '2026-09-15', status: 'posted', postedGrossCents: 92586 };

describe('a posted day with ACH still in transit', () => {
  test('reports the pending gifts separately, and leaves them out of the totals', async () => {
    const { days } = await callWith(SEPT_15, [POSTED_SEPT_15]);
    expect(days).toHaveLength(1);
    const [day] = days;
    expect(day.date).toBe('2026-09-15');
    expect(day.status).toBe('posted');
    expect(day.donations).toBe(5);
    expect(day.gross).toBeCloseTo(925.86, 2);
    expect(day.fees).toBeCloseTo(21.41, 2);
    expect(day.postedGross).toBeCloseTo(925.86, 2);
    expect(day.inTransit).toBe(3);
    expect(day.inTransitGross).toBeCloseTo(487.6, 2);
  });

  test('once the ACH settles it moves into the totals, and the day now exceeds what was posted', async () => {
    const settled = SEPT_15.map((d) =>
      d.attributes.payment_status === 'pending'
        ? { ...d, attributes: { ...d.attributes, payment_status: 'succeeded', fee_cents: -100 } }
        : d,
    );
    const [day] = (await callWith(settled, [POSTED_SEPT_15])).days;
    expect(day.donations).toBe(8);
    expect(day.gross).toBeCloseTo(1413.46, 2);
    expect(day.inTransit).toBe(0);
    expect(day.inTransitGross).toBe(0);
    // The page uses this gap to offer "Post the difference".
    expect(day.gross - day.postedGross).toBeCloseTo(487.6, 2);
  });
});

describe('what counts as in transit', () => {
  test('a failed ACH is not in transit - the money is not coming', async () => {
    const [day] = (await callWith([gift(10000, -245, 'card', 'succeeded'), gift(5000, -30, 'ach', 'failed')])).days;
    expect(day.inTransit).toBe(0);
  });

  test('a refunded pending gift is a cancellation, not money in transit', async () => {
    const [day] = (
      await callWith([gift(10000, -245, 'card', 'succeeded'), gift(5000, -30, 'ach', 'pending', undefined, { refunded: true })])
    ).days;
    expect(day.inTransit).toBe(0);
  });

  test('a day whose only giving is still in transit is listed with nothing to post yet', async () => {
    const [day] = (await callWith([gift(5000, -30, 'ach', 'pending')])).days;
    expect(day.date).toBe('2026-09-15');
    expect(day.donations).toBe(0);
    expect(day.gross).toBe(0);
    expect(day.status).toBe('pending');
    expect(day.inTransit).toBe(1);
    expect(day.inTransitGross).toBeCloseTo(50, 2);
  });

  test('a day with nothing in transit says so', async () => {
    const [day] = (await callWith([gift(10000, -245, 'card', 'succeeded')])).days;
    expect(day.inTransit).toBe(0);
    expect(day.inTransitGross).toBe(0);
  });
});
