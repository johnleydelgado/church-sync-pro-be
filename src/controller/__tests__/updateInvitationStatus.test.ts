/**
 * The invitation token was mailed to this address, so accepting it is proof the inbox is
 * theirs - the same proof a verification link gives. Without this, an invited bookkeeper
 * would sign up and be stopped at "check your inbox" for a mail that was never sent.
 * The user id is derived from the email rather than trusted from the body.
 *
 * Invitations live in ChurchMembers (a pending row: invitedEmail + invitationToken, no userId).
 * Accepting one fills in the login; the legacy bookkeeper table is still updated alongside so
 * the screens that read it keep working until they are retired.
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
// The lower(invitedEmail) comparison is built through the sequelize instance. This stand-in
// records its arguments so a test can read the query back, and needs no config.json.
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
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));

import { Op } from 'sequelize';
import Users from '../../db/models/user';
import bookkeeper from '../../db/models/bookkeeper';
import ChurchMember from '../../db/models/churchMember';
import { markEmailVerified } from '../../services/emailVerification';
import { checkValidInvitation, updateInvitationStatus } from '../user';

const mockedUsers = Users as unknown as { findOne: jest.Mock };
const mockedBk = bookkeeper as unknown as { findOne: jest.Mock; update: jest.Mock };
const mockedMember = ChurchMember as unknown as { findOne: jest.Mock };
const mockedMark = markEmailVerified as unknown as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** A pending ChurchMembers row, as the invite endpoint leaves it. */
const pendingInvite = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  churchId: 3,
  userId: null,
  inviteAccepted: false,
  invitedEmail: 'bk@cfp.com',
  invitationToken: 'tok',
  update: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedBk.update.mockResolvedValue([1]);
});

describe('updateInvitationStatus', () => {
  it('refuses without an invitation token', async () => {
    const res = makeRes();
    await updateInvitationStatus({ body: { email: 'bk@cfp.com' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockedMember.findOne).not.toHaveBeenCalled();
    expect(mockedMark).not.toHaveBeenCalled();
  });

  it('refuses a token that does not match the invited email', async () => {
    mockedMember.findOne.mockResolvedValue(null);
    const res = makeRes();
    await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'nope' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedMark).not.toHaveBeenCalled();
    expect(mockedBk.update).not.toHaveBeenCalled();
  });

  it('links the invite to the login found by email, ignoring a body id, and mirrors it to bookkeeper', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    mockedUsers.findOne.mockResolvedValue({ id: 42 });
    const res = makeRes();
    await updateInvitationStatus(
      { body: { email: 'bk@cfp.com', invitationToken: 'tok', bookkeeperId: 999, userId: 999 } } as any,
      res,
    );
    expect(mockedMark).toHaveBeenCalledWith('bk@cfp.com');
    expect(mockedUsers.findOne).toHaveBeenCalledWith({ where: { email: 'bk@cfp.com' } });
    // Is this login already on that church?
    expect(mockedMember.findOne).toHaveBeenLastCalledWith({ where: { churchId: 3, userId: 42 } });
    expect(invite.update).toHaveBeenCalledWith({ userId: 42, inviteAccepted: true });
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(mockedBk.update).toHaveBeenCalledWith(
      { inviteAccepted: true, userId: 42 },
      { where: { email: 'bk@cfp.com', invitationToken: 'tok' } },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('drops the invite when the login is already a member of that church', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce({ id: 8, churchId: 3, userId: 42 });
    mockedUsers.findOne.mockResolvedValue({ id: 42 });
    const res = makeRes();
    await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'tok' } } as any, res);
    expect(invite.destroy).toHaveBeenCalled();
    expect(invite.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('leaves the invite pending when no login exists yet, and still succeeds', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite);
    mockedUsers.findOne.mockResolvedValue(null);
    const res = makeRes();
    await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'tok' } } as any, res);
    expect(mockedMark).toHaveBeenCalledWith('bk@cfp.com');
    expect(invite.update).not.toHaveBeenCalled();
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(mockedBk.update).toHaveBeenCalledWith(
      { inviteAccepted: true },
      { where: { email: 'bk@cfp.com', invitationToken: 'tok' } },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not touch an invite that is already accepted', async () => {
    // The invite page calls this twice (after sign-up, and again once the login is loaded).
    const invite = pendingInvite({ userId: 42, inviteAccepted: true });
    mockedMember.findOne.mockResolvedValueOnce(invite);
    mockedUsers.findOne.mockResolvedValue({ id: 42 });
    const res = makeRes();
    await updateInvitationStatus({ body: { email: 'bk@cfp.com', invitationToken: 'tok' } } as any, res);
    expect(mockedMember.findOne).toHaveBeenCalledTimes(1);
    expect(invite.update).not.toHaveBeenCalled();
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('checkValidInvitation', () => {
  it('finds the invite by token and by email, ignoring case', async () => {
    mockedMember.findOne.mockResolvedValue(pendingInvite({ invitedEmail: 'Bk@Cfp.com' }));
    const res = makeRes();
    await checkValidInvitation({ body: { email: ' BK@cfp.COM ', invitationToken: 'tok' } } as any, res);
    const where = mockedMember.findOne.mock.calls[0][0].where;
    expect(where[Op.and]).toEqual([
      { invitationToken: 'tok' },
      { attribute: { fn: 'lower', args: [{ col: 'invitedEmail' }] }, logic: 'bk@cfp.com' },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: 'exist' });
  });

  it('answers 400 "not found !" for an unknown invite', async () => {
    mockedMember.findOne.mockResolvedValue(null);
    const res = makeRes();
    await checkValidInvitation({ body: { email: 'bk@cfp.com', invitationToken: 'nope' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, message: 'not found !' });
  });
});
