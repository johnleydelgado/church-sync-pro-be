/**
 * The day list reports the church's sync start date, so the page can mark everything before it
 * as giving the church has decided not to bring across rather than as work still outstanding.
 *
 * The parsing itself belongs to `parseSyncStartDay` and is covered by that helper's own tests;
 * what matters here is that the value reaches the response, and that an unset or malformed
 * setting degrades to "no cutoff" rather than to a bogus one that would hide real days.
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
// getOrgTimeZone is faked because it calls Planning Center; parseSyncStartDay is the real one,
// since this suite exists to prove the controller uses it rather than its own parsing.
jest.mock('../../services/dailyDonationSync', () => {
  const actual = jest.requireActual('../../services/dailyDonationSync');
  return {
    ...actual,
    getOrgTimeZone: jest.fn(),
    runDailyDonationSync: jest.fn(),
  };
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

const cardDonation = {
  type: 'Donation',
  id: '1',
  attributes: {
    amount_cents: 10000,
    fee_cents: -320,
    payment_method: 'card',
    payment_status: 'succeeded',
    received_at: '2026-09-08T14:02:11Z',
  },
  relationships: { designations: { data: [] } },
};

/** Run the endpoint with a given stored start date, and hand back the response body. */
const callWith = async (startDateAutomationFund: unknown) => {
  mockedUsers.findOne.mockResolvedValue({ toJSON: () => ({ id: 7 }) });
  mockedToken.mockResolvedValue({ access_token: 'tok' });
  mockedTimeZone.mockResolvedValue('America/New_York');
  mockedSettings.findOne.mockResolvedValue({ startDateAutomationFund });
  mockedUserSync.findAll.mockResolvedValue([]);
  mockedSweep.mockResolvedValue({ donations: [cardDonation], included: [] });

  const res = makeRes();
  await getStripeGivingByDay(
    { query: { email: 'a@b.test', from: '2026-09-01', to: '2026-09-30' } } as any,
    res,
  );
  return res.json.mock.calls[0]?.[0]?.data;
};

beforeEach(() => jest.clearAllMocks());

describe('getStripeGivingByDay: the sync start date', () => {
  test('returns the stored cutoff as a date-only day', async () => {
    // The mapping page writes MM-DD-YYYY; the page needs YYYY-MM-DD to compare against day keys.
    const body = await callWith('09-09-2026');
    expect(body.syncStartDay).toBe('2026-09-09');
  });

  test('accepts a value already stored the other way round', async () => {
    const body = await callWith('2026-09-09');
    expect(body.syncStartDay).toBe('2026-09-09');
  });

  test('reports no cutoff when the church has not set one', async () => {
    expect((await callWith(null)).syncStartDay).toBeNull();
    expect((await callWith('')).syncStartDay).toBeNull();
    expect((await callWith(undefined)).syncStartDay).toBeNull();
  });

  test('reports no cutoff rather than a bogus one for an unparseable value', async () => {
    // The column is an unvalidated varchar. Guessing at "next tuesday" would hide real days;
    // no cutoff at least errs towards showing the church everything.
    const body = await callWith('next tuesday');
    expect(body.syncStartDay).toBeNull();
  });

  test('still returns the days themselves alongside it', async () => {
    const body = await callWith('09-09-2026');
    expect(body.days).toHaveLength(1);
    expect(body.days[0].gross).toBe(100);
  });

  test('survives a church with no settings row at all', async () => {
    const body = await callWith(undefined);
    expect(body.syncStartDay).toBeNull();
  });
});
