/**
 * A church can hold more than one enabled token entity (organisation). Saving a connection
 * (updateUserToken) writes to the enabled one with the lowest id, so every place that reads a
 * church's tokens by `isEnabled` must pick that same row - otherwise a reconnect lands on one
 * entity and the sync keeps refreshing a dead token on another. Postgres returns rows in no
 * promised order without ORDER BY.
 *
 * Everything these modules reach for a database or a third party is faked.
 */
function mockModel() {
  return {
    __esModule: true,
    default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/emailLog', mockModel);
jest.mock('../../db/models/SyncRun', mockModel);
jest.mock('../../db/models/church', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('../../services/sessionEmail', () => ({ sessionEmail: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../planning-center', () => ({ getBatchInDonationPCO: jest.fn(), isAccessTokenValidPCO: jest.fn() }));
jest.mock('../../utils/automation-helper', () => ({ dailySyncing: jest.fn(), dailySyncingRegistration: jest.fn() }));
jest.mock('../../services/dailyDonationSync', () => ({ runDailyDonationSync: jest.fn() }));
jest.mock('../../services/payoutReport/registrationMapping', () => ({ legacyRegistrationList: jest.fn(() => []) }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: Object.assign(jest.fn(), { post: jest.fn() }) }));
jest.mock('winston', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  format: { combine: jest.fn(), timestamp: jest.fn(), json: jest.fn() },
  transports: { Console: jest.fn() },
}));

import axios from 'axios';
import tokenEntity from '../../db/models/tokenEntity';
import { isAccessTokenValidPCO } from '../planning-center';
import { getQboTokensForUser } from '../../services/qboClient';
import { generatePcToken } from '../automation';
import { getStripePayouts, refreshAccessToken } from '../stripe';
import { isUserHaveTokens } from '../user';

const entities = tokenEntity as unknown as { findOne: jest.Mock; findAll: jest.Mock };
const post = (axios as unknown as { post: jest.Mock }).post;
const pcoValid = isAccessTokenValidPCO as jest.Mock;

const EMAIL = 'acct@example.test';
const ENABLED_OLDEST_FIRST = expect.objectContaining({
  where: { email: EMAIL, isEnabled: true },
  order: [['id', 'ASC']],
});

beforeEach(() => jest.clearAllMocks());

it('QuickBooks: both the token read and the refresh pick the oldest enabled entity', async () => {
  entities.findOne.mockResolvedValue({
    tokens: [{ id: 5, token_type: 'qbo', refresh_token: 'r-old', realm_id: 'realm-1' }],
  });
  post.mockResolvedValue({ data: { access_token: 'a-new', refresh_token: 'r-new' } });

  await expect(getQboTokensForUser(EMAIL)).resolves.toMatchObject({ ACCESS_TOKEN: 'a-new', REALM_ID: 'realm-1' });

  expect(entities.findOne).toHaveBeenCalledTimes(2);
  expect(entities.findOne).toHaveBeenNthCalledWith(1, ENABLED_OLDEST_FIRST);
  expect(entities.findOne).toHaveBeenNthCalledWith(2, ENABLED_OLDEST_FIRST);
});

it('Planning Center: generatePcToken picks the oldest enabled entity', async () => {
  entities.findOne.mockResolvedValue({ tokens: [{ id: 6, token_type: 'pco', access_token: 'a', refresh_token: 'r' }] });
  pcoValid.mockResolvedValue(true);

  await expect(generatePcToken(EMAIL)).resolves.toEqual({ access_token: 'a', refresh_token: 'r' });

  expect(entities.findOne).toHaveBeenCalledWith(ENABLED_OLDEST_FIRST);
});

it('Stripe: the payout list and the token refresh pick the oldest enabled entity', async () => {
  entities.findOne.mockResolvedValue(null);
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);

  await getStripePayouts({ query: { email: EMAIL, selectedDate: '', cPage: '1' } } as any, res);
  await expect(refreshAccessToken(EMAIL)).resolves.toEqual({ error: 'Data or tokens not found' });

  expect(entities.findOne).toHaveBeenCalledTimes(2);
  expect(entities.findOne).toHaveBeenNthCalledWith(1, ENABLED_OLDEST_FIRST);
  expect(entities.findOne).toHaveBeenNthCalledWith(2, ENABLED_OLDEST_FIRST);
});

it('Connections check: isUserHaveTokens reads the oldest enabled entity first', async () => {
  // Two enabled entities: the answer is about the one the connection was saved to.
  entities.findAll.mockResolvedValue([
    { dataValues: { isEnabled: true }, tokens: [{}, {}, {}] },
    { dataValues: { isEnabled: true }, tokens: [] },
  ]);
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);

  await isUserHaveTokens({ body: { email: EMAIL } } as any, res);

  expect(entities.findAll).toHaveBeenCalledWith(
    expect.objectContaining({ where: { email: EMAIL }, order: [['id', 'ASC']] }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
});
