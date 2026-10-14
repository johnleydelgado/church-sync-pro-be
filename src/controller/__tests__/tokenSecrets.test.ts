/**
 * OAuth secrets stay on the server. The screens that list connections only use each token's id,
 * its type, and whether one exists, so getTokenList and bookkeeperList neither ask the database
 * for access_token / refresh_token nor send them if a row carries them anyway.
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
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));

import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import bookkeeper from '../../db/models/bookkeeper';
import { bookkeeperList, getTokenList } from '../user';

const entityFindAll = (tokenEntity as unknown as { findAll: jest.Mock }).findAll;
const bkFindAll = (bookkeeper as unknown as { findAll: jest.Mock }).findAll;

const SECRETS = { exclude: ['access_token', 'refresh_token'] };

/** A stored token as the table holds it. */
const token = (id: number, token_type: string) => ({
  id,
  token_type,
  access_token: `secret-access-${id}`,
  refresh_token: `secret-refresh-${id}`,
  realm_id: 'realm-1',
  tokenEntityId: 77,
});
/** What findAll resolves to: model instances, which become plain objects through toJSON(). */
const instance = (json: Record<string, unknown>) => ({ ...json, toJSON: () => json });

const call = async (handler: typeof getTokenList, body: Record<string, unknown>) => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  await handler({ body } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => jest.clearAllMocks());

it('getTokenList sends each token without its access or refresh token', async () => {
  entityFindAll.mockResolvedValue([
    instance({ id: 77, email: 'acct@x', isEnabled: true, tokens: [token(1, 'qbo'), token(2, 'pco')] }),
  ]);

  const { code, body } = await call(getTokenList, { email: 'acct@x' });

  expect(entityFindAll).toHaveBeenCalledWith({
    where: { email: 'acct@x' },
    include: [{ model: tokens, attributes: SECRETS }],
  });
  expect(code).toBe(200);
  expect(JSON.stringify(body)).not.toContain('secret-');
  expect(body.data[0]).toMatchObject({ id: 77, isEnabled: true });
  expect(body.data[0].tokens).toEqual([
    { id: 1, token_type: 'qbo', realm_id: 'realm-1', tokenEntityId: 77 },
    { id: 2, token_type: 'pco', realm_id: 'realm-1', tokenEntityId: 77 },
  ]);
});

it("bookkeeperList sends the bookkeeper's and the client's tokens without their secrets", async () => {
  bkFindAll.mockResolvedValue([
    instance({
      id: 7,
      clientId: 10,
      userId: 42,
      User: { id: 42, email: 'bk@cfp.com', tokens: [token(3, 'qbo')] },
      Client: { id: 10, email: 'acct@x', tokens: [token(4, 'qbo'), token(5, 'stripe')] },
    }),
    instance({ id: 8, clientId: 10, userId: null, User: null, Client: { id: 10, tokens: [] } }),
  ]);

  const { code, body } = await call(bookkeeperList, { clientId: 10 });

  const include = bkFindAll.mock.calls[0][0].include;
  expect(include[0].include).toEqual([{ model: tokens, as: 'tokens', attributes: SECRETS }]);
  expect(include[1].include).toEqual([{ model: tokens, as: 'tokens', attributes: SECRETS }]);
  expect(code).toBe(200);
  expect(JSON.stringify(body)).not.toContain('secret-');
  expect(body.data[0].User.tokens).toEqual([{ id: 3, token_type: 'qbo', realm_id: 'realm-1', tokenEntityId: 77 }]);
  expect(body.data[0].Client.tokens.map((t: any) => t.token_type)).toEqual(['qbo', 'stripe']);
  expect(body.data[1]).toMatchObject({ id: 8, User: null, Client: { id: 10, tokens: [] } });
});
