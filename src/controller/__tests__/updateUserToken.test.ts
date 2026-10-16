/**
 * Saving a QuickBooks / Planning Center / Stripe connection after OAuth.
 *
 * The route sits behind requireAccountAccess(fromBody, 'integrations'), which leaves the church's
 * account row in res.locals.churchAccess.account. The connection is filed under that row - not
 * under the body's userId, which is whoever clicked Connect (a bookkeeper's own id).
 *
 * Connecting again replaces the old connection. It used to be ignored when a token of that type
 * already existed, so a reconnect kept the dead token and the church stayed disconnected. Because
 * a reconnect now overwrites, a call without a usable token is refused rather than allowed to
 * wipe a working connection. QuickBooks and Planning Center need their refresh token too: a
 * connection saved without one dies with its access token.
 */
function mockModel() {
  return {
    __esModule: true,
    default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db/models/church', mockModel);
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

const ACCOUNT = { id: 10, email: 'acct@x' };
const ENTITY_ORDER = [
  ['isEnabled', 'DESC'],
  ['id', 'ASC'],
];

const makeRes = (locals: Record<string, unknown> = { churchAccess: { account: ACCOUNT } }) => {
  const res: any = { locals };
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

const save = async (sent: Record<string, unknown>, res = makeRes()) => {
  await updateUserToken({ body: sent } as any, res);
  return res;
};

const expectNothingWritten = () => {
  expect(mockedEntity.create).not.toHaveBeenCalled();
  expect(mockedTokens.create).not.toHaveBeenCalled();
};

beforeEach(() => jest.clearAllMocks());

it("creates the church's token entity and files the token under the account, not the body's userId", async () => {
  mockedEntity.findOne.mockResolvedValue(null);
  mockedEntity.create.mockResolvedValue({ id: 77 });
  mockedTokens.findOne.mockResolvedValue(null);
  mockedTokens.create.mockResolvedValue({ id: 1 });

  const res = await save(body);

  expect(mockedEntity.findOne).toHaveBeenCalledWith({ where: { email: 'acct@x' }, order: ENTITY_ORDER });
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
  const entity = { id: 77, isEnabled: true, update: jest.fn() };
  mockedEntity.findOne.mockResolvedValue(entity);
  const existing = { id: 5, token_type: 'qbo', update: jest.fn().mockResolvedValue(undefined) };
  mockedTokens.findOne.mockResolvedValue(existing);

  const res = await save(body);

  expect(mockedEntity.create).not.toHaveBeenCalled();
  expect(entity.update).not.toHaveBeenCalled();
  expect(existing.update).toHaveBeenCalledWith({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    realm_id: 'realm-1',
    userId: 10,
  });
  expect(mockedTokens.create).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('switches the chosen entity on when the only one the church has is disabled', async () => {
  // The lookup prefers an enabled entity, then the oldest; landing on a disabled one means none is on.
  const entity = { id: 77, isEnabled: false, update: jest.fn().mockResolvedValue(undefined) };
  mockedEntity.findOne.mockResolvedValue(entity);
  mockedTokens.findOne.mockResolvedValue(null);

  const res = await save(body);

  expect(entity.update).toHaveBeenCalledWith({ isEnabled: true });
  expect(mockedTokens.create).toHaveBeenCalledWith(expect.objectContaining({ tokenEntityId: 77, userId: 10 }));
  expect(res.status).toHaveBeenCalledWith(200);
});

it('saves a Planning Center connection without a realm id', async () => {
  mockedEntity.findOne.mockResolvedValue({ id: 77, isEnabled: true, update: jest.fn() });
  mockedTokens.findOne.mockResolvedValue(null);

  const res = await save({ ...body, token_type: 'pco', realm_id: undefined });

  expect(mockedTokens.create).toHaveBeenCalledWith(
    expect.objectContaining({ token_type: 'pco', realm_id: null, access_token: 'new-access' }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('refuses a Stripe connection now that Stripe Connect is gone', async () => {
  const res = await save({ ...body, token_type: 'stripe', realm_id: undefined, refresh_token: undefined });

  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedEntity.findOne).not.toHaveBeenCalled();
  expect(mockedTokens.create).not.toHaveBeenCalled();
});

it('refuses an unknown connection type', async () => {
  const res = await save({ ...body, token_type: 'xero' });

  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedEntity.findOne).not.toHaveBeenCalled();
  expectNothingWritten();
});

it.each([
  ['no access token', { access_token: undefined }],
  ['an empty access token', { access_token: '' }],
  ['an access token that is not a string', { access_token: { a: 1 } }],
  ['a QuickBooks token without its realm id', { realm_id: undefined }],
  ['a QuickBooks token with a blank realm id', { realm_id: ' ' }],
  ['a QuickBooks token without its refresh token', { refresh_token: undefined }],
  ['a QuickBooks token with an empty refresh token', { refresh_token: '' }],
  ['a QuickBooks refresh token that is not a string', { refresh_token: ['r'] }],
  [
    'a Planning Center token without its refresh token',
    { token_type: 'pco', realm_id: undefined, refresh_token: undefined },
  ],
  [
    'a Planning Center token with a blank refresh token',
    { token_type: 'pco', realm_id: undefined, refresh_token: '  ' },
  ],
])('refuses %s, leaving any working connection alone', async (_label, change) => {
  const existing = { id: 5, update: jest.fn() };
  mockedEntity.findOne.mockResolvedValue({ id: 77, isEnabled: true, update: jest.fn() });
  mockedTokens.findOne.mockResolvedValue(existing);

  const res = await save({ ...body, ...change });

  expect(res.status).toHaveBeenCalledWith(400);
  expect(existing.update).not.toHaveBeenCalled();
  expectNothingWritten();
});

it('refuses with 403 when the route was wired without its church guard', async () => {
  const res = await save(body, makeRes({}));

  expect(res.status).toHaveBeenCalledWith(403);
  expect(mockedEntity.findOne).not.toHaveBeenCalled();
  expectNothingWritten();
});
