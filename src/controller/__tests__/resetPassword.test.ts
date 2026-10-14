/**
 * The password-reset token is the only credential on a public route. These pin the three ways it
 * leaked: a missing or malformed token reached the query (`token: null` became `IS NULL` and
 * matched every user who never asked for a reset), the token was sent to the browser inside Users
 * rows, and session endpoints wrote whatever `token` the request body carried.
 */
// A function declaration, not a const: jest hoists the mock() calls above everything else, so an
// arrow assigned to a const is read before it is initialised. The mock- prefix is what jest
// requires of any out-of-scope identifier a factory refers to.
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() } };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/syncEngine', () => ({ syncBatchToJournalEntries: jest.fn() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdparty', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({
  __esModule: true,
  default: { getUserByEmail: jest.fn(), updateEmailOrPassword: jest.fn() },
}));

import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Users from '../../db/models/user';
import bookkeeper from '../../db/models/bookkeeper';
import { resetPassword } from '../index';
import { bookkeeperList, createUser, getUserRelated, updateUser } from '../user';
import { addTokenInUser } from '../db';

const users = Users as unknown as { findOne: jest.Mock; update: jest.Mock; create: jest.Mock };
const bookkeepers = bookkeeper as unknown as { findAll: jest.Mock };
const emailPassword = EmailPassword as unknown as { getUserByEmail: jest.Mock; updateEmailOrPassword: jest.Mock };

const TOKEN = '0123456789abcdef0123456789abcdef';
const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
const sent = (res: any) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  users.findOne.mockResolvedValue({ id: 7, email: 'church@b.test', token: TOKEN });
  users.update.mockResolvedValue([1]);
  users.create.mockResolvedValue({});
  emailPassword.getUserByEmail.mockResolvedValue({ id: 'st-user-7' });
  emailPassword.updateEmailOrPassword.mockResolvedValue({ status: 'OK' });
});

describe('resetPassword refuses a missing or malformed token before any query', () => {
  const reset = async (body: any) => { const res = makeRes(); await resetPassword({ body } as any, res); return res; };
  const expectRefused = (res: any) => {
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sent(res)).toEqual(expect.objectContaining({ success: false, data: 'Invalid or expired reset link' }));
    expect(users.findOne).not.toHaveBeenCalled();
    expect(emailPassword.updateEmailOrPassword).not.toHaveBeenCalled();
    expect(users.update).not.toHaveBeenCalled();
  };

  test.each([
    ['null (would query "token" IS NULL)', null],
    ['missing', undefined],
    ['an array (would query IN (...))', [TOKEN]],
    ['an object', { $ne: '' }],
    ['a number', 12345],
    ['an empty string', ''],
    ['not hex', 'zz'.repeat(16)],
    ['too short', TOKEN.slice(1)],
    ['too long', `${TOKEN}0`],
    ['upper-case hex (never issued)', TOKEN.toUpperCase()],
  ])('token %s -> 400', async (_label, token) => {
    expectRefused(await reset({ email: 'church@b.test', token, password: 'new-pass-1' }));
  });

  test.each([
    ['missing', undefined],
    ['blank', '   '],
    ['an array', ['church@b.test']],
    ['null', null],
  ])('email %s -> 400', async (_label, email) => {
    expectRefused(await reset({ email, token: TOKEN, password: 'new-pass-1' }));
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 123456],
  ])('password %s -> 400', async (_label, password) => {
    expectRefused(await reset({ email: 'church@b.test', token: TOKEN, password }));
  });

  test('no body at all -> 400', async () => {
    const res = makeRes();
    await resetPassword({ body: {} } as any, res);
    expectRefused(res);
  });
});

describe('resetPassword with a well-formed token', () => {
  const reset = async (body: any) => { const res = makeRes(); await resetPassword({ body } as any, res); return res; };

  test('no user holds that email + token -> the existing not-found response, nothing changed', async () => {
    users.findOne.mockResolvedValue(null);
    const res = await reset({ email: 'church@b.test', token: TOKEN, password: 'new-pass-1' });
    expect(users.findOne).toHaveBeenCalledWith({ where: { email: 'church@b.test', token: TOKEN } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(sent(res)).toEqual(expect.objectContaining({ success: false, data: 'User not found ! or invalid token' }));
    expect(emailPassword.updateEmailOrPassword).not.toHaveBeenCalled();
    expect(users.update).not.toHaveBeenCalled();
  });

  test('a match changes the password and clears the token so the link works once', async () => {
    const res = await reset({ email: 'church@b.test', token: TOKEN, password: 'new-pass-1' });
    expect(emailPassword.getUserByEmail).toHaveBeenCalledWith('church@b.test');
    expect(emailPassword.updateEmailOrPassword).toHaveBeenCalledWith({ userId: 'st-user-7', password: 'new-pass-1' });
    expect(users.update).toHaveBeenCalledTimes(1);
    expect(users.update).toHaveBeenCalledWith({ token: null }, { where: { id: 7 } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent(res)).toEqual(expect.objectContaining({ success: true }));
  });

  test('neither the token nor the matched row is logged', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await reset({ email: 'church@b.test', token: TOKEN, password: 'new-pass-1' });
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    } finally {
      log.mockRestore();
    }
  });
});

describe('the reset token is never sent to the browser', () => {
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => undefined);

  test('getUserRelated leaves the token out of the query and the response', async () => {
    const log = quiet();
    users.findOne.mockResolvedValue({ toJSON: () => ({ id: 7, email: 'church@b.test', token: TOKEN, UserSetting: {} }) });
    const res = makeRes();
    await getUserRelated({ query: { email: 'church@b.test' } } as any, res);
    log.mockRestore();

    expect(users.findOne).toHaveBeenCalledWith(expect.objectContaining({ attributes: { exclude: ['token'] } }));
    const data = sent(res).data;
    expect(data).toEqual(expect.objectContaining({ id: 7, email: 'church@b.test', UserSetting: {} }));
    expect(data).not.toHaveProperty('token');
  });

  test('bookkeeperList leaves the token out of both the bookkeeper and the church rows', async () => {
    bookkeepers.findAll.mockResolvedValue([]);
    const res = makeRes();
    await bookkeeperList({ body: { clientId: 7 } } as any, res);

    const { include } = bookkeepers.findAll.mock.calls[0][0];
    const byAlias = Object.fromEntries(include.map((i: any) => [i.as, i]));
    expect(byAlias.User.attributes).toEqual({ exclude: ['token'] });
    expect(byAlias.Client.attributes).toEqual({ exclude: ['token'] });
  });
});

describe('a request body cannot write the reset token', () => {
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => undefined);

  test('updateUser drops token and keeps the rest', async () => {
    await updateUser({ body: { email: 'church@b.test', firstName: 'Ann', token: TOKEN } } as any, makeRes());
    expect(users.update).toHaveBeenCalledWith({ email: 'church@b.test', firstName: 'Ann' }, { where: { email: 'church@b.test' } });
  });

  test('createUser drops token and keeps the rest', async () => {
    const log = quiet();
    users.findOne.mockResolvedValue(null);
    await createUser({ body: { email: 'new@b.test', firstName: 'Ann', token: TOKEN } } as any, makeRes());
    log.mockRestore();
    expect(users.create).toHaveBeenCalledWith({ email: 'new@b.test', isActive: true, firstName: 'Ann' });
  });

  test('addTokenInUser drops token and keeps the rest', async () => {
    const log = quiet();
    await addTokenInUser({ body: { email: 'church@b.test', access_token_qbo: 'qbo', token: TOKEN } } as any, makeRes());
    log.mockRestore();
    expect(users.update).toHaveBeenCalledWith({ access_token_qbo: 'qbo' }, { where: { email: 'church@b.test' } });
  });
});
