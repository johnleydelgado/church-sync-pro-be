/**
 * The one church access rule and the Express guards that apply it: own row always, otherwise an
 * accepted ChurchMembers row; integrations need an owner or the owner's say-so; owner actions need
 * an owner. Refusals are 403 (never 401), unknown churches 404. Models and SuperTokens are faked.
 */
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({
  __esModule: true,
  default: { getUserById: jest.fn() },
}));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: { getUserById: jest.fn() } }));
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/church', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/churchMember', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/tokens', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/tokenEntity', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Users from '../../db/models/user';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import { createLogger } from '../../utils/logger';
import {
  actorFromSession,
  checkAccountAccess,
  clearSessionEmailCache,
  requireAccountAccess,
  requireChurch,
  fromBody,
} from '../churchAccess';

const users = (Users as any).findOne as jest.Mock;
const churches = (Church as any).findOne as jest.Mock;
const members = (ChurchMember as any).findOne as jest.Mock;
const tpep = (ThirdPartyEmailPassword as any).getUserById as jest.Mock;
const ep = (EmailPassword as any).getUserById as jest.Mock;
const log = createLogger('test') as any;

const MATT = { id: 1, email: 'matt@example.test' };
const BK = { id: 2, email: 'bk@example.test' };
const ACCOUNT = { id: 10, email: 'church-abc@accounts.churchsyncpro.invalid' };
const CHURCH = { id: 100, ownerUserId: 10, isActive: true };

beforeEach(() => {
  jest.resetAllMocks();
  clearSessionEmailCache();
});

describe('checkAccountAccess', () => {
  it('lets anyone at their own row', async () => {
    churches.mockResolvedValue(null);
    await expect(checkAccountAccess(BK as any, BK as any, 'owner')).resolves.toMatchObject({
      church: null,
      membership: null,
    });
  });
  it('lets an accepted member at the church filed under the account', async () => {
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: false });
    await expect(checkAccountAccess(BK as any, ACCOUNT as any)).resolves.toMatchObject({ church: CHURCH });
    expect(members).toHaveBeenCalledWith({ where: { churchId: 100, userId: 2, inviteAccepted: true } });
  });
  it('refuses a stranger', async () => {
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue(null);
    await expect(checkAccountAccess(BK as any, ACCOUNT as any)).rejects.toMatchObject({ status: 403 });
  });
  it("refuses another person's own row (no church filed under it)", async () => {
    churches.mockResolvedValue(null);
    await expect(checkAccountAccess(BK as any, MATT as any)).rejects.toMatchObject({ status: 403 });
  });
  it("needs the owner's say-so for integrations", async () => {
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: false });
    await expect(checkAccountAccess(BK as any, ACCOUNT as any, 'integrations')).rejects.toMatchObject({ status: 403 });
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: true });
    await expect(checkAccountAccess(BK as any, ACCOUNT as any, 'integrations')).resolves.toBeTruthy();
  });
  it('keeps owner actions for owners', async () => {
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: true });
    await expect(checkAccountAccess(BK as any, ACCOUNT as any, 'owner')).rejects.toMatchObject({ status: 403 });
    members.mockResolvedValue({ role: 'owner', integrationAccessEnabled: true });
    await expect(checkAccountAccess(BK as any, ACCOUNT as any, 'owner')).resolves.toBeTruthy();
  });
});

describe('actorFromSession', () => {
  it('finds the Users row through either recipe and caches the email', async () => {
    tpep.mockResolvedValue(undefined);
    ep.mockResolvedValue({ email: BK.email });
    users.mockResolvedValue(BK);
    await expect(actorFromSession('st-2')).resolves.toBe(BK);
    await actorFromSession('st-2');
    expect(ep).toHaveBeenCalledTimes(1);
    expect(users).toHaveBeenCalledWith({ where: { email: BK.email } });
  });
  it('is null without a session', async () => {
    await expect(actorFromSession(undefined)).resolves.toBeNull();
  });
});

describe('middleware', () => {
  const run = async (mw: any, req: any) => {
    const res: any = { locals: {} };
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    const next = jest.fn();
    await mw(req, res, next);
    return { res, next, code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };
  const signedInAs = (u: any) => {
    tpep.mockResolvedValue({ email: u.email });
    users.mockImplementation(async ({ where }: any) => {
      if (where.email === u.email) return u;
      if (where.email === ACCOUNT.email || where.id === ACCOUNT.id) return ACCOUNT;
      return null;
    });
  };

  it('passes a member through and leaves the access on res.locals', async () => {
    signedInAs(BK);
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: false });
    const { next, res } = await run(requireAccountAccess(fromBody), {
      body: { email: ACCOUNT.email },
      session: { getUserId: () => 'st-2' },
    });
    expect(next).toHaveBeenCalled();
    expect(res.locals.churchAccess.account).toBe(ACCOUNT);
  });
  it('answers 403 for a stranger and never calls the handler', async () => {
    signedInAs(BK);
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue(null);
    const { next, code, body } = await run(requireAccountAccess(fromBody), {
      body: { email: ACCOUNT.email },
      session: { getUserId: () => 'st-2' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(403);
    expect(body.success).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'church access refused',
      expect.objectContaining({ actorId: 2, accountId: 10 }),
    );
  });
  it('answers 404 when the request names no known account', async () => {
    signedInAs(BK);
    const { code } = await run(requireAccountAccess(fromBody), {
      body: { email: '' },
      session: { getUserId: () => 'st-2' },
    });
    expect(code).toBe(404);
  });
  it('answers 403 (not 401) when the session has no Users row', async () => {
    tpep.mockResolvedValue({ email: 'ghost@example.test' });
    users.mockResolvedValue(null);
    const { code } = await run(requireAccountAccess(fromBody), {
      body: { email: ACCOUNT.email },
      session: { getUserId: () => 'st-9' },
    });
    expect(code).toBe(403);
  });
  it('answers 500 when the check itself fails, and never calls the handler', async () => {
    signedInAs(BK);
    churches.mockRejectedValue(new Error('database unreachable'));
    const { next, code, body } = await run(requireAccountAccess(fromBody), {
      body: { email: ACCOUNT.email },
      session: { getUserId: () => 'st-2' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(500);
    expect(body.success).toBe(false);
  });
  it('requireChurch finds the account through churchId', async () => {
    signedInAs(BK);
    churches.mockImplementation(async ({ where }: any) =>
      where.id === 100 || where.ownerUserId === 10 ? CHURCH : null,
    );
    members.mockResolvedValue({ role: 'owner', integrationAccessEnabled: true });
    const { next } = await run(requireChurch('owner'), {
      body: { churchId: 100 },
      query: {},
      session: { getUserId: () => 'st-2' },
    });
    expect(next).toHaveBeenCalled();
  });
});
