/**
 * Google sign-up: once SuperTokens has made the login, the browser (GoogleCallBack.tsx) asks for
 * the person's Users row with `{ email }`. No row exists yet, so no church guard can run. The only
 * row this may create is the signed-in login's own, under the address SuperTokens holds, and only
 * profile fields are taken from the body - never `token`, `isActive` or any other column.
 *
 * A Users row already spelled the same apart from case (a Google login for an address that signed
 * up another way) is the person's row: no second one is made, and the answer names the stored
 * address, which is the one the guarded endpoints look the account up by.
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
// Records lower(...) comparisons so a test can read the query back. Needs no config.json.
jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    fn: (fn: string, ...args: unknown[]) => ({ fn, args }),
    col: (col: string) => ({ col }),
    where: (attribute: unknown, logic: unknown) => ({ attribute, logic }),
  },
}));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('../../services/sessionEmail', () => ({ sessionEmail: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, createLogger: () => log, default: () => log };
});

import Users from '../../db/models/user';
import { sessionEmail } from '../../services/sessionEmail';
import { createLogger } from '../../utils/logger';
import { createUser } from '../user';

const users = Users as unknown as { findAll: jest.Mock; create: jest.Mock };
const log = createLogger('test') as any;
const signedIn = sessionEmail as jest.Mock;

const LOGIN = 'Grace.Admin@Example.test';

/** `sessionUserId` null: no session on the request at all. */
const create = async (body: Record<string, unknown>, sessionUserId: string | null = 'st-1') => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  const session = sessionUserId ? { getUserId: () => sessionUserId } : undefined;
  await createUser({ body, session } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.resetAllMocks();
  signedIn.mockResolvedValue(LOGIN);
  users.findAll.mockResolvedValue([]);
  users.create.mockResolvedValue({ id: 50 });
});

it("creates the signed-in login's own row from what GoogleCallBack sends", async () => {
  const { code } = await create({ email: LOGIN });
  expect(code).toBe(200);
  expect(signedIn).toHaveBeenCalledWith('st-1');
  expect(users.create).toHaveBeenCalledWith({ email: LOGIN, isActive: true });
});

it("files the row under the login's address as SuperTokens holds it, whatever case the body used", async () => {
  await create({ email: '  grace.admin@example.TEST ' });
  expect(users.create).toHaveBeenCalledWith({ email: LOGIN, isActive: true });
});

it('refuses with 409 a second row for the same address', async () => {
  users.findAll.mockResolvedValue([{ id: 9, email: LOGIN }]);
  const { code } = await create({ email: LOGIN });
  expect(code).toBe(409);
  expect(users.findAll).toHaveBeenCalledWith({
    where: { attribute: { fn: 'lower', args: [{ col: 'email' }] }, logic: 'grace.admin@example.test' },
    attributes: ['id', 'email'],
  });
  expect(users.create).not.toHaveBeenCalled();
});

it('answers with the stored address when the only row differs from the login only in case', async () => {
  users.findAll.mockResolvedValue([{ id: 9, email: 'grace.admin@example.test' }]);
  const { code, body } = await create({ email: LOGIN });
  expect(code).toBe(200);
  expect(body.data).toEqual({ email: 'grace.admin@example.test' });
  expect(users.create).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledWith(expect.any(String), { userId: 9 });
  expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls]).toLowerCase()).not.toContain(
    'grace.admin@example.test',
  );
});

it('refuses with 409, logging ids only, when several rows differ from the login only in case', async () => {
  users.findAll.mockResolvedValue([
    { id: 9, email: 'grace.admin@example.test' },
    { id: 12, email: 'GRACE.ADMIN@example.test' },
  ]);
  const { code } = await create({ email: LOGIN });
  expect(code).toBe(409);
  expect(users.create).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith(expect.any(String), { ids: [9, 12] });
  expect(JSON.stringify(log.error.mock.calls).toLowerCase()).not.toContain('grace.admin@example.test');
});

it("refuses with 403 a row for anyone else's address", async () => {
  const { code } = await create({ email: 'someone.else@example.test', role: 'client' });
  expect(code).toBe(403);
  expect(users.create).not.toHaveBeenCalled();
});

it.each([
  ['no session', null, LOGIN],
  ['a session SuperTokens does not know', 'st-gone', null],
  ['a church account login', 'st-1', 'church-abc@accounts.churchsyncpro.invalid'],
])('refuses with 403 %s', async (_label, sessionUserId, email) => {
  // As the real lookup: no session id, no login.
  signedIn.mockImplementation(async (id?: string) => (id ? email : null));
  const { code } = await create({ email: email ?? LOGIN }, sessionUserId);
  expect(code).toBe(403);
  expect(users.create).not.toHaveBeenCalled();
});

it('takes only the profile fields, never token, isActive or other columns', async () => {
  const { code } = await create({
    email: LOGIN,
    firstName: ' Grace ',
    lastName: 'Admin',
    churchName: 'Grace Chapel',
    role: 'bookkeeper',
    isSubscribe: '1',
    img_url: 'https://img.example.test/a.png',
    token: 'reset-token-chosen-by-caller',
    isActive: false,
    id: 1,
  });
  expect(code).toBe(200);
  expect(users.create).toHaveBeenCalledWith({
    email: LOGIN,
    isActive: true,
    firstName: 'Grace',
    lastName: 'Admin',
    churchName: 'Grace Chapel',
    role: 'bookkeeper',
    isSubscribe: '1',
    img_url: 'https://img.example.test/a.png',
  });
});

it.each([
  ['a role other than client or bookkeeper', { role: 'admin' }],
  ['an isSubscribe other than 0 or 1', { isSubscribe: 'yes' }],
  ['a name that is not text', { firstName: { $gt: '' } }],
])('refuses with 400 %s', async (_label, extra) => {
  const { code } = await create({ email: LOGIN, ...extra });
  expect(code).toBe(400);
  expect(users.create).not.toHaveBeenCalled();
});
