/**
 * What the day-detail endpoint refuses, and what it says when it cannot answer. The arithmetic
 * it returns is `stripeGivingDayDetail`'s, and is covered by that helper's own tests.
 *
 * Every module the controller reaches for a database or a third party is faked here, so the
 * suite stays a unit test: none of the real models are loaded, which also keeps it runnable in a
 * checkout with no database config.
 */
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/userSettings', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/UserSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../db/models/SyncRun', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/DailyJeSync', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../services/dailyDonationSync', () => ({ getOrgTimeZone: jest.fn(), runDailyDonationSync: jest.fn() }));
jest.mock('../../services/donationSweep', () => ({
  fetchDonationsForDay: jest.fn(),
  fetchDonationsForRange: jest.fn(),
}));

import Users from '../../db/models/user';
import { generatePcToken } from '../automation';
import { getOrgTimeZone } from '../../services/dailyDonationSync';
import { fetchDonationsForDay } from '../../services/donationSweep';
import { getStripeGivingDayDetail } from '../journalEntry';

const mockedUsers = Users as unknown as { findOne: jest.Mock };
const mockedToken = generatePcToken as unknown as jest.Mock;
const mockedTimeZone = getOrgTimeZone as unknown as jest.Mock;
const mockedSweep = fetchDonationsForDay as unknown as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const call = async (query: any) => {
  const res = makeRes();
  await getStripeGivingDayDetail({ query } as any, res);
  return { res, body: res.json.mock.calls[0]?.[0] };
};

const cardDonation = {
  type: 'Donation',
  id: '171986861',
  attributes: {
    amount_cents: 10000,
    fee_cents: -320,
    payment_method: 'card',
    payment_method_sub: 'credit',
    payment_status: 'succeeded',
    fee_covered: false,
    refunded: false,
    received_at: '2026-09-08T14:02:11Z',
    completed_at: '2026-09-08T14:02:13Z',
  },
  relationships: { designations: { data: [{ type: 'Designation', id: 'des-1' }] } },
};
const cashDonation = {
  type: 'Donation',
  id: '171048983',
  attributes: { amount_cents: 2000, fee_cents: 0, payment_method: 'cash', payment_status: 'succeeded' },
};
const included = [
  { type: 'Fund', id: '901', attributes: { name: 'General' } },
  {
    type: 'Designation',
    id: 'des-1',
    attributes: { amount_cents: 10000 },
    relationships: { fund: { data: { type: 'Fund', id: '901' } } },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockedUsers.findOne.mockResolvedValue({ toJSON: () => ({ id: 1, email: 'church@example.test' }) });
  mockedToken.mockResolvedValue({ access_token: 'pco-token' });
  mockedTimeZone.mockResolvedValue('America/New_York');
  mockedSweep.mockResolvedValue({ donations: [cardDonation, cashDonation], included });
});

describe('getStripeGivingDayDetail', () => {
  test('rejects a day that is not YYYY-MM-DD without asking Planning Center', async () => {
    for (const day of ['08-09-2026', '2026-9-8', 'yesterday', '']) {
      const { res, body } = await call({ email: 'church@example.test', day });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(body).toEqual({ success: false, message: 'day must be YYYY-MM-DD' });
    }
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  test("returns the day's Stripe giving with the cash gift left out", async () => {
    const { body } = await call({ email: 'church@example.test', day: '2026-09-08' });
    expect(mockedSweep).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer pco-token' } }, '2026-09-08');
    expect(body.data.day).toBe('2026-09-08');
    expect(body.data.orgTimeZone).toBe('America/New_York');
    expect(body.data.donations).toHaveLength(1);
    expect(body.data.donations[0]).toMatchObject({
      id: '171986861',
      gross: 100,
      fee: 3.2,
      net: 96.8,
      designations: [{ fundName: 'General', amount: 100 }],
    });
    expect(body.data.totals).toEqual({ gross: 100, fees: 3.2, net: 96.8, count: 1 });
  });

  test('says why it has nothing rather than returning a bare empty list', async () => {
    mockedUsers.findOne.mockResolvedValue(null);
    expect((await call({ email: 'nobody@example.test', day: '2026-09-08' })).body.data).toEqual({
      donations: [],
      unavailable: 'no_user',
    });

    mockedUsers.findOne.mockResolvedValue({ toJSON: () => ({ id: 1 }) });
    mockedToken.mockResolvedValue({});
    expect((await call({ email: 'church@example.test', day: '2026-09-08' })).body.data).toEqual({
      donations: [],
      unavailable: 'no_pco_token',
    });

    mockedToken.mockRejectedValue(new Error('token refresh failed'));
    expect((await call({ email: 'church@example.test', day: '2026-09-08' })).body.data).toEqual({
      donations: [],
      unavailable: 'no_pco_token',
    });

    mockedToken.mockResolvedValue({ access_token: 'pco-token' });
    mockedTimeZone.mockResolvedValue(null);
    expect((await call({ email: 'church@example.test', day: '2026-09-08' })).body.data).toEqual({
      donations: [],
      unavailable: 'no_org_timezone',
    });
  });

  // A refused query must not read as a quiet day - that is the difference between "look into
  // this" and "nobody gave on Tuesday".
  test('a Planning Center failure surfaces as 502, not as a day with no giving', async () => {
    mockedSweep.mockRejectedValue(new Error('Request failed with status code 429'));
    const { res, body } = await call({ email: 'church@example.test', day: '2026-09-08' });
    expect(res.status).toHaveBeenCalledWith(502);
    expect(body).toEqual({ success: false, message: 'Request failed with status code 429' });
  });
});
