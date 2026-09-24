/**
 * A bookkeeper adding a church must not end up logged in AS that church. The browser
 * sign-up API sets the new user's session cookies; the backend SDK call does not. This
 * also retires the shared default password the old flow hard-coded in the browser.
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
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));
jest.mock('supertokens-node', () => ({ deleteUser: jest.fn().mockResolvedValue(undefined) }));

import Users from '../../db/models/user';
import bookkeeper from '../../db/models/bookkeeper';
import { createClientChurch } from '../user';
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');
const supertokens = require('supertokens-node');

const mockedUsers = Users as unknown as { findOne: jest.Mock; create: jest.Mock };
const mockedBk = bookkeeper as unknown as { create: jest.Mock };
const mockedSignUp = ThirdPartyEmailPassword.emailPasswordSignUp as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedUsers.findOne.mockResolvedValue({ id: 5, email: 'jake@cfp.com', role: 'bookkeeper' });
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

  expect(mockedUsers.create).toHaveBeenCalledWith(
    expect.objectContaining({ email, churchName: 'Active Church', role: 'client', isActive: true }),
  );
  expect(mockedBk.create).toHaveBeenCalledWith(
    expect.objectContaining({
      email,
      clientId: 77,
      userId: 5,
      inviteAccepted: true,
      bookkeeperIntegrationAccessEnabled: false,
    }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { clientId: 77, email } }));
});

it('returns 409 when that church already exists for this bookkeeper', async () => {
  mockedSignUp.mockResolvedValue({ status: 'EMAIL_ALREADY_EXISTS_ERROR' });
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'Active Church', bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(mockedUsers.create).not.toHaveBeenCalled();
});

it('rejects a missing church name or unknown bookkeeper', async () => {
  const res1 = makeRes();
  await createClientChurch({ body: { churchName: '', bookkeeperId: 5 } } as any, res1);
  expect(res1.status).toHaveBeenCalledWith(400);

  mockedUsers.findOne.mockResolvedValue(null);
  const res2 = makeRes();
  await createClientChurch({ body: { churchName: 'X', bookkeeperId: 5 } } as any, res2);
  expect(res2.status).toHaveBeenCalledWith(400);
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

it('refuses an absurdly long church name before creating anything', async () => {
  const res = makeRes();
  await createClientChurch({ body: { churchName: 'x'.repeat(201), bookkeeperId: 5 } } as any, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedSignUp).not.toHaveBeenCalled();
});
