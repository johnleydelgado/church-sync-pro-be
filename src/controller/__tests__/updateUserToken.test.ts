/**
 * Saving a QuickBooks / Planning Center / Stripe connection after OAuth.
 *
 * The route sits behind requireAccountAccess(fromBody, 'integrations'), which leaves the church's
 * account row in res.locals.churchAccess.account. The connection is filed under that row - not
 * under the body's userId, which is whoever clicked Connect (a bookkeeper's own id).
 *
 * Connecting again replaces the old connection. It used to be ignored when a token of that type
 * already existed, so a reconnect kept the dead token and the church stayed disconnected.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() } };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));

import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import { updateUserToken } from '../user';

const mockedTokens = tokens as unknown as { findOne: jest.Mock; findAll: jest.Mock; create: jest.Mock };
const mockedEntity = tokenEntity as unknown as { findOne: jest.Mock; create: jest.Mock };

const makeRes = () => {
  const res: any = { locals: { churchAccess: { account: { id: 10, email: 'acct@x' } } } };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// What the Connect screens send: the church's email, but the clicker's own userId.
const body = {
  email: 'acct@x',
  userId: 2,
  token_type: 'qbo',
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  realm_id: 'realm-1',
};

beforeEach(() => jest.clearAllMocks());

it("creates the church's token entity and files the token under the account, not the body's userId", async () => {
  mockedEntity.findOne.mockResolvedValue(null);
  mockedEntity.create.mockResolvedValue({ id: 77 });
  mockedTokens.findOne.mockResolvedValue(null);
  mockedTokens.create.mockResolvedValue({ id: 1 });
  const res = makeRes();

  await updateUserToken({ body } as any, res);

  expect(mockedEntity.findOne).toHaveBeenCalledWith({ where: { email: 'acct@x' } });
  expect(mockedEntity.create).toHaveBeenCalledWith({ email: 'acct@x', isEnabled: true });
  expect(mockedTokens.findOne).toHaveBeenCalledWith({ where: { tokenEntityId: 77, token_type: 'qbo' } });
  expect(mockedTokens.create).toHaveBeenCalledWith({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    realm_id: 'realm-1',
    userId: 10,
    tokenEntityId: 77,
    token_type: 'qbo',
  });
  expect(res.status).toHaveBeenCalledWith(200);
});

it('replaces an existing token of that type instead of ignoring the reconnect', async () => {
  mockedEntity.findOne.mockResolvedValue({ id: 77 });
  const existing = { id: 5, token_type: 'qbo', update: jest.fn().mockResolvedValue(undefined) };
  mockedTokens.findOne.mockResolvedValue(existing);
  const res = makeRes();

  await updateUserToken({ body } as any, res);

  expect(mockedEntity.create).not.toHaveBeenCalled();
  expect(existing.update).toHaveBeenCalledWith({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    realm_id: 'realm-1',
    userId: 10,
  });
  expect(mockedTokens.create).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('refuses an unknown connection type', async () => {
  const res = makeRes();

  await updateUserToken({ body: { ...body, token_type: 'xero' } } as any, res);

  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedEntity.findOne).not.toHaveBeenCalled();
  expect(mockedTokens.create).not.toHaveBeenCalled();
});
