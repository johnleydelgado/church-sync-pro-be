/**
 * The invitation token was mailed to this address, so accepting it is proof the inbox is
 * theirs - the same proof a verification link gives. Without this, an invited bookkeeper
 * would sign up and be stopped at "check your inbox" for a mail that was never sent.
 * The user id is derived from the invited address rather than trusted from the body.
 *
 * Invitations live in ChurchMembers (a pending row: invitedEmail + invitationToken, no userId).
 * Accepting one fills in the login; the legacy bookkeeper table is still updated alongside so
 * the screens that read it keep working until they are retired.
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
// The lower(...) comparisons are built through the sequelize instance. This stand-in records its
// arguments so a test can read the query back, and needs no config.json.
jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    fn: (fn: string, ...args: unknown[]) => ({ fn, args }),
    col: (col: string) => ({ col }),
    where: (attribute: unknown, logic: unknown) => ({ attribute, logic }),
  },
}));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log, mockLog: log };
});
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

const mockedUsers = Users as unknown as { findAll: jest.Mock; findOne: jest.Mock };
const mockedBk = bookkeeper as unknown as { findOne: jest.Mock; update: jest.Mock };
const mockedMember = ChurchMember as unknown as { findOne: jest.Mock };
const mockedMark = markEmailVerified as unknown as jest.Mock;
const log = jest.requireMock('../../utils/logger').mockLog as { warn: jest.Mock; error: jest.Mock };

const lowerEq = (col: string, value: string) => ({ attribute: { fn: 'lower', args: [{ col }] }, logic: value });

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** A pending ChurchMembers row, as the invite endpoints leave it (the address is stored lowercased). */
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

const accept = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await updateInvitationStatus({ body } as any, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedBk.update.mockResolvedValue([1]);
  mockedUsers.findAll.mockResolvedValue([]);
});

describe('updateInvitationStatus', () => {
  it('refuses without an invitation token', async () => {
    const res = await accept({ email: 'bk@cfp.com' });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockedMember.findOne).not.toHaveBeenCalled();
    expect(mockedMark).not.toHaveBeenCalled();
  });

  it.each([
    ['no email', { invitationToken: 'tok' }],
    ['an email that is not a string', { email: ['bk@cfp.com'], invitationToken: 'tok' }],
    ['a blank email', { email: '  ', invitationToken: 'tok' }],
    ['a token that is not a string', { email: 'bk@cfp.com', invitationToken: ['tok', 'tok2'] }],
  ])('refuses %s with 400 before looking anything up', async (_label, body) => {
    const res = await accept(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedMember.findOne).not.toHaveBeenCalled();
    expect(mockedMark).not.toHaveBeenCalled();
  });

  it("refuses a church account's address", async () => {
    const res = await accept({ email: 'grace@accounts.churchsyncpro.invalid', invitationToken: 'tok' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedMember.findOne).not.toHaveBeenCalled();
    expect(mockedMark).not.toHaveBeenCalled();
  });

  it('refuses a token that does not match the invited email', async () => {
    mockedMember.findOne.mockResolvedValue(null);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'nope' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedMark).not.toHaveBeenCalled();
    expect(mockedBk.update).not.toHaveBeenCalled();
  });

  it("links the invite to the login with the invite's address, ignoring a body id, and mirrors it to bookkeeper", async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }]);
    const res = await accept({ email: 'BK@cfp.com', invitationToken: 'tok', bookkeeperId: 999, userId: 999 });

    expect(mockedMark).toHaveBeenCalledWith('BK@cfp.com');
    // The login is found from the stored invited address (any case), never from the body.
    expect(mockedUsers.findAll).toHaveBeenCalledWith({ where: lowerEq('email', 'bk@cfp.com'), limit: 2 });
    // Is this login already on that church, on some row other than this invite?
    expect(mockedMember.findOne).toHaveBeenLastCalledWith({
      where: { churchId: 3, userId: 42, id: { [Op.ne]: 5 } },
    });
    expect(invite.update).toHaveBeenCalledWith({ userId: 42, inviteAccepted: true });
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(mockedBk.update).toHaveBeenCalledWith(
      { inviteAccepted: true, userId: 42 },
      { where: { [Op.and]: [{ invitationToken: 'tok' }, lowerEq('email', 'bk@cfp.com')] } },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('drops the invite when the login is already a member of that church', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce({ id: 8, churchId: 3, userId: 42 });
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }]);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(invite.destroy).toHaveBeenCalled();
    expect(invite.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('leaves the invite pending when no login exists yet, and still succeeds', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(mockedMark).toHaveBeenCalledWith('bk@cfp.com');
    expect(invite.update).not.toHaveBeenCalled();
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(mockedBk.update).toHaveBeenCalledWith(
      { inviteAccepted: true },
      { where: { [Op.and]: [{ invitationToken: 'tok' }, lowerEq('email', 'bk@cfp.com')] } },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('links nobody when two logins share the address, and logs ids only', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite);
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }, { id: 43 }]);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(invite.update).not.toHaveBeenCalled();
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(mockedBk.update).toHaveBeenCalledWith({ inviteAccepted: true }, expect.anything());
    expect(log.error).toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('bk@cfp.com');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not touch an invite that is already accepted by a login', async () => {
    // The invite page calls this twice (after sign-up, and again once the login is loaded).
    const invite = pendingInvite({ userId: 42, inviteAccepted: true });
    mockedMember.findOne.mockResolvedValueOnce(invite);
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }]);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(mockedMember.findOne).toHaveBeenCalledTimes(1);
    expect(invite.update).not.toHaveBeenCalled();
    expect(invite.destroy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('links a row marked accepted that has no login yet (written so by the first backfill)', async () => {
    const invite = pendingInvite({ userId: null, inviteAccepted: true });
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }]);
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(invite.update).toHaveBeenCalledWith({ userId: 42, inviteAccepted: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still accepts when the legacy mirror fails, and logs ids only', async () => {
    const invite = pendingInvite();
    mockedMember.findOne.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    mockedUsers.findAll.mockResolvedValue([{ id: 42 }]);
    mockedBk.update.mockRejectedValue(new Error('bookkeeper table locked'));
    const res = await accept({ email: 'bk@cfp.com', invitationToken: 'tok' });
    expect(invite.update).toHaveBeenCalledWith({ userId: 42, inviteAccepted: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ memberId: 5, churchId: 3, userId: 42 }),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('bk@cfp.com');
  });
});

describe('checkValidInvitation', () => {
  const check = async (body: Record<string, unknown>) => {
    const res = makeRes();
    await checkValidInvitation({ body } as any, res);
    return res;
  };

  it('finds the invite by token and by email, ignoring case', async () => {
    mockedMember.findOne.mockResolvedValue(pendingInvite({ invitedEmail: 'Bk@Cfp.com' }));
    const res = await check({ email: ' BK@cfp.COM ', invitationToken: 'tok' });
    const where = mockedMember.findOne.mock.calls[0][0].where;
    expect(where[Op.and]).toEqual([{ invitationToken: 'tok' }, lowerEq('invitedEmail', 'bk@cfp.com')]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: 'exist' });
  });

  it('answers 400 "not found !" for an unknown invite', async () => {
    mockedMember.findOne.mockResolvedValue(null);
    const res = await check({ email: 'bk@cfp.com', invitationToken: 'nope' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, message: 'not found !' });
  });

  it.each([
    ['no token', { email: 'bk@cfp.com' }],
    ['a token that is not a string', { email: 'bk@cfp.com', invitationToken: ['tok'] }],
    ['an email that is not a string', { email: { a: 1 }, invitationToken: 'tok' }],
    ["a church account's address", { email: 'grace@accounts.churchsyncpro.invalid', invitationToken: 'tok' }],
  ])('answers 400 "not found !" for %s without looking it up', async (_label, body) => {
    const res = await check(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, message: 'not found !' });
    expect(mockedMember.findOne).not.toHaveBeenCalled();
  });
});
