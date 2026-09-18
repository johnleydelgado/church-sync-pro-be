/**
 * The invitation token was mailed to this address, so accepting it is proof the inbox is
 * theirs - the same proof a verification link gives. Without this, an invited bookkeeper
 * would sign up and be stopped at "check your inbox" for a mail that was never sent.
 * The user id is derived from the email rather than trusted from the body.
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

import Users from '../../db/models/user';
import bookkeeper from '../../db/models/bookkeeper';
import { markEmailVerified } from '../../services/emailVerification';
import { updateInvitationStatus } from '../user';

const mockedUsers = Users as unknown as { findOne: jest.Mock };
const mockedBk = bookkeeper as unknown as { findOne: jest.Mock; update: jest.Mock };
const mockedMark = markEmailVerified as unknown as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

it('refuses without an invitation token', async () => {
  const res = makeRes();
  await updateInvitationStatus({ body: { email: 'bk@cfp.com' } } as any, res);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockedMark).not.toHaveBeenCalled();
});

it('refuses a token that does not match the invited email', async () => {
  mockedBk.findOne.mockResolvedValue(null);
  const res = makeRes();
  await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'nope' } } as any, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockedMark).not.toHaveBeenCalled();
  expect(mockedBk.update).not.toHaveBeenCalled();
});

it('marks the invitee verified and links the row to the user found by email, ignoring a body id', async () => {
  mockedBk.findOne.mockResolvedValue({ id: 7, email: 'bk@cfp.com' });
  mockedUsers.findOne.mockResolvedValue({ id: 42 });
  mockedBk.update.mockResolvedValue([1]);
  const res = makeRes();
  await updateInvitationStatus(
    { body: { email: 'bk@cfp.com', invitationToken: 'tok', bookkeeperId: 999 } } as any,
    res,
  );
  expect(mockedMark).toHaveBeenCalledWith('bk@cfp.com');
  expect(mockedBk.update).toHaveBeenCalledWith(
    { inviteAccepted: true, userId: 42 },
    { where: { email: 'bk@cfp.com', invitationToken: 'tok' } },
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('still accepts the invite when no Users row exists yet', async () => {
  mockedBk.findOne.mockResolvedValue({ id: 7 });
  mockedUsers.findOne.mockResolvedValue(null);
  mockedBk.update.mockResolvedValue([1]);
  const res = makeRes();
  await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'tok' } } as any, res);
  expect(mockedBk.update).toHaveBeenCalledWith(
    { inviteAccepted: true },
    { where: { email: 'bk@cfp.com', invitationToken: 'tok' } },
  );
});
