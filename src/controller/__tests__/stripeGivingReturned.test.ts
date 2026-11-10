/**
 * Daily Giving must show trouble the day it happens, not at month-end (Matt, 2026-11-09).
 *
 * Active Church, 4 October 2026: a $600 ACH gift was charged and then returned by the donor's bank.
 * Planning Center marked it failed, CSP rightly never posted it, and the church only learned of it
 * from the payout report at month-end. The row now says so on the day.
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
  method: 'card' | 'ach',
  status: 'succeeded' | 'failed',
  receivedAt = '2026-10-04T11:36:49Z',
  extra = {},
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

const callWith = async (donations: any[], syncRows: any[] = []) => {
  (Users as any).findOne.mockResolvedValue({ toJSON: () => ({ id: 1 }) });
  (generatePcToken as jest.Mock).mockResolvedValue({ access_token: 'tok' });
  (getOrgTimeZone as jest.Mock).mockResolvedValue('America/Los_Angeles');
  (UserSettings as any).findOne.mockResolvedValue({ startDateAutomationFund: '09-15-2026' });
  (UserSync as any).findAll.mockResolvedValue(syncRows.map((r) => ({ toJSON: () => r })));
  (fetchDonationsForRange as jest.Mock).mockResolvedValue({ donations, included: [] });
  const res = makeRes();
  await getStripeGivingByDay({ query: { email: 'a@b.test', from: '2026-10-01', to: '2026-10-31' } } as any, res);
  return res.json.mock.calls[0][0].data.days;
};

test('a bank gift returned after it was charged is reported on its day, apart from the totals', async () => {
  const [day] = await callWith(
    [gift(10000, -245, 'card', 'succeeded'), gift(60000, -30, 'ach', 'failed')],
    [{ donationId: '2026-10-04', status: 'posted', postedGrossCents: 10000 }],
  );
  expect(day).toMatchObject({
    date: '2026-10-04',
    donations: 1,
    gross: 100,
    returned: 1,
    returnedGross: 600,
  });
});

test('a declined card (failed, no fee) moved no money and is not "returned"', async () => {
  const [day] = await callWith([gift(10000, -245, 'card', 'succeeded'), gift(2000, 0, 'card', 'failed')]);
  expect(day).toMatchObject({ returned: 0, returnedGross: 0 });
});

test('a day whose only gift was returned is still listed', async () => {
  const days = await callWith([gift(60000, -30, 'ach', 'failed')]);
  expect(days).toEqual([
    expect.objectContaining({ date: '2026-10-04', donations: 0, gross: 0, returned: 1, returnedGross: 600 }),
  ]);
});
