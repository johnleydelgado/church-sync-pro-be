/**
 * A bookkeeper adding a church must not end up logged in AS that church. The browser
 * sign-up API sets the new user's session cookies; the backend SDK call does not. This
 * also retires the shared default password the old flow hard-coded in the browser.
 *
 * Access reads ChurchMembers only, so the church is filed as a Church owned by the bookkeeper
 * who added it (as the resync migration does for older Clients-page churches), in the same
 * transaction as the account row and the legacy bookkeeper row. Only the signed-in bookkeeper
 * can add a church for themselves.
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
jest.mock('../../db/models/church', mockModel);
// Runs the callback with a marker transaction, so a test can see every write joined it.
jest.mock('../../db', () => ({
  __esModule: true,
  default: { transaction: jest.fn((work: (t: unknown) => unknown) => work('TX')) },
}));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));
jest.mock('supertokens-node', () => ({ deleteUser: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, createLogger: () => log, default: () => log };
});

import Users from '../../db/models/user';
import bookkeeper from '../../db/models/bookkeeper';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import sequelize from '../../db';
import { createLogger } from '../../utils/logger';
import { createClientChurch } from '../user';
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');
const supertokens = require('supertokens-node');

const mockedUsers = Users as unknown as { findOne: jest.Mock; create: jest.Mock };
const mockedBk = bookkeeper as unknown as { create: jest.Mock };
const mockedChurch = Church as unknown as { create: jest.Mock };
const mockedMember = ChurchMember as unknown as { create: jest.Mock };
const transaction = (sequelize as unknown as { transaction: jest.Mock }).transaction;
const mockedSignUp = ThirdPartyEmailPassword.emailPasswordSignUp as jest.Mock;
const log = createLogger('test') as any;

const JAKE = { id: 5, email: 'jake@cfp.com', role: 'bookkeeper' };

// What the route's guard leaves behind: the signed-in person.
const makeRes = (actor: unknown = JAKE) => {
  const res: any = { locals: actor ? { actor } : {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedChurch.create.mockResolvedValue({ id: 300 });
  mockedMember.create.mockResolvedValue({ id: 400 });
});

it('creates the SuperTokens user with the synthetic address and a random password, then the rows', async () => {
  mockedSignUp.mockResolvedValue({ status: 'OK', user: { id: 'st-9' } });
  mockedUsers.create.mockResolvedValue({ id: 77 });
  mockedBk.create.mockResolvedValue({});
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);

  expect(mockedSignUp).toHaveBeenCalledTimes(1);
  const [email, password] = mockedSignUp.mock.calls[0];
  expect(email).toBe('active-church-jake@cfp.com');
  expect(password).not.toBe('csp@2024');
  expect(password.length).toBeGreaterThanOrEqual(24);

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(mockedUsers.create).toHaveBeenCalledWith(
    expect.objectContaining({ email, churchName: 'Active Church', role: 'client', isActive: true }),
    { transaction: 'TX' },
  );
  expect(mockedBk.create).toHaveBeenCalledWith(
    expect.objectContaining({
      email,
      clientId: 77,
      userId: 5,
      inviteAccepted: true,
      bookkeeperIntegrationAccessEnabled: false,
    }),
    { transaction: 'TX' },
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { clientId: 77, email } }));
});

it('files the church under the new account, owned by the bookkeeper who added it, so access lets them in', async () => {
  mockedSignUp.mockResolvedValue({ status: 'OK', user: { id: 'st-9' } });
  mockedUsers.create.mockResolvedValue({ id: 77 });
  mockedBk.create.mockResolvedValue({});
  const res = makeRes();
  await createClientChurch({ body: { churchName: '  Active Church ', bookkeeperId: '5' } } as any, res);

  expect(mockedChurch.create).toHaveBeenCalledWith(
    { name: 'Active Church', ownerUserId: 77, isActive: true },
    { transaction: 'TX' },
  );
  expect(mockedMember.create).toHaveBeenCalledWith(
    {
      churchId: 300,
      userId: 5,
      role: 'owner',
      integrationAccessEnabled: true,
      invitedEmail: null,
      invitationToken: null,
      inviteAccepted: true,
    },
    { transaction: 'TX' },
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it.each([
  ['someone other than the signed-in person', 6],
  ['no account at all', 'abc'],
])('refuses with 403 a bookkeeperId naming %s', async (_label, bookkeeperId) => {
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId } } as any, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mockedSignUp).not.toHaveBeenCalled();
  expect(mockedUsers.create).not.toHaveBeenCalled();
});

it('refuses with 403 when the route ran without its guard (no signed-in person)', async () => {
  const res = makeRes(null);
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mockedSignUp).not.toHaveBeenCalled();
});

it('returns 409 when that church already exists for this bookkeeper', async () => {
  mockedSignUp.mockResolvedValue({ status: 'EMAIL_ALREADY_EXISTS_ERROR' });
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(mockedUsers.create).not.toHaveBeenCalled();
});

it('rejects a missing church name', async () => {
  const res = makeRes();
  await createClientChurch({ body: { churchName: '', bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedSignUp).not.toHaveBeenCalled();
});

it('removes the SuperTokens login again when the church rows cannot be written', async () => {
  mockedSignUp.mockResolvedValue({ status: 'OK', user: { id: 'st-9' } });
  mockedUsers.create.mockRejectedValue(new Error('value too long for type character varying(32)'));
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'A Very Long Church Name Indeed', bookkeeperId: 5 } } as any, res);
  expect(supertokens.deleteUser).toHaveBeenCalledWith('st-9');
  expect(res.status).toHaveBeenCalledWith(500);
  expect(mockedBk.create).not.toHaveBeenCalled();
});

it('removes the SuperTokens login again when the church itself cannot be written (the transaction undoes the rest)', async () => {
  mockedSignUp.mockResolvedValue({ status: 'OK', user: { id: 'st-9' } });
  mockedUsers.create.mockResolvedValue({ id: 77 });
  mockedBk.create.mockResolvedValue({});
  mockedMember.create.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);
  expect(supertokens.deleteUser).toHaveBeenCalledWith('st-9');
  expect(res.status).toHaveBeenCalledWith(500);
});

it('refuses an absurdly long church name before creating anything', async () => {
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'x'.repeat(201), bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedSignUp).not.toHaveBeenCalled();
});

it('logs, by SuperTokens id and error kind only, a login it could not remove again', async () => {
  mockedSignUp.mockResolvedValue({ status: 'OK', user: { id: 'st-9' } });
  mockedUsers.create.mockRejectedValue(new Error('connection lost'));
  const refused = new Error('core unreachable for active-church-jake@cfp.com');
  refused.name = 'SuperTokensError';
  supertokens.deleteUser.mockRejectedValueOnce(refused);
  const res = makeRes();

  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(log.error).toHaveBeenCalledWith(expect.any(String), { superTokensUserId: 'st-9', error: 'SuperTokensError' });
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('cfp.com');
});
