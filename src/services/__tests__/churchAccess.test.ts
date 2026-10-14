/**
 * The one church access rule and the Express guards that apply it: own row always, otherwise an
 * accepted ChurchMembers row; integrations need an owner or the owner's say-so; owner actions need
 * an owner. Refusals are 403 (never 401), unknown or ambiguous churches 404. Church account rows
 * never act. Models and SuperTokens are faked.
 */
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({
  __esModule: true,
  default: { getUserById: jest.fn() },
}));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: { getUserById: jest.fn() } }));
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../db/models/church', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/churchMember', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/tokens', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/tokenEntity', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../db/models/bookkeeper', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Users from '../../db/models/user';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import bookkeeper from '../../db/models/bookkeeper';
import { createLogger } from '../../utils/logger';
import {
  ACCOUNT_EMAIL_DOMAIN,
  actorFromSession,
  checkAccountAccess,
  clearSessionEmailCache,
  fromBody,
  fromBodyBookkeeperId,
  fromBodyClientId,
  fromBodyClientOrBookkeeperId,
  fromBodyItems,
  fromBookkeeperRowId,
  fromTokenId,
  isChurchAccountEmail,
  isChurchGuard,
  requireAccountAccess,
  requireChurch,
  sessionEmailCacheSize,
} from '../churchAccess';

const usersById = (Users as any).findOne as jest.Mock;
const usersByEmail = (Users as any).findAll as jest.Mock;
const churches = (Church as any).findOne as jest.Mock;
const members = (ChurchMember as any).findOne as jest.Mock;
const tokenRows = (tokens as any).findOne as jest.Mock;
const tokenEntities = (tokenEntity as any).findOne as jest.Mock;
const bookkeeperRows = (bookkeeper as any).findOne as jest.Mock;
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
afterEach(() => jest.restoreAllMocks());

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
  it('lets an owner connect integrations even with the toggle off', async () => {
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'owner', integrationAccessEnabled: false });
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

describe('isChurchAccountEmail', () => {
  it('knows the church account domain, in any case', () => {
    expect(ACCOUNT_EMAIL_DOMAIN).toBe('accounts.churchsyncpro.invalid');
    expect(isChurchAccountEmail(ACCOUNT.email)).toBe(true);
    expect(isChurchAccountEmail('Church-ABC@Accounts.ChurchSyncPro.INVALID')).toBe(true);
  });
  it('leaves every other address alone', () => {
    expect(isChurchAccountEmail(MATT.email)).toBe(false);
    expect(isChurchAccountEmail('someone@notaccounts.churchsyncpro.invalid')).toBe(false);
    expect(isChurchAccountEmail('accounts.churchsyncpro.invalid@example.test')).toBe(false);
    expect(isChurchAccountEmail(undefined)).toBe(false);
  });
});

describe('actorFromSession', () => {
  it('finds the Users row through either recipe and caches the email', async () => {
    tpep.mockResolvedValue(undefined);
    ep.mockResolvedValue({ email: BK.email });
    usersByEmail.mockResolvedValue([BK]);
    await expect(actorFromSession('st-2')).resolves.toBe(BK);
    await actorFromSession('st-2');
    expect(ep).toHaveBeenCalledTimes(1);
    expect(usersByEmail).toHaveBeenCalledWith({ where: { email: BK.email }, limit: 2 });
  });
  it('is null without a session', async () => {
    await expect(actorFromSession(undefined)).resolves.toBeNull();
  });
  it('is null when the email belongs to more than one Users row, and says so without the email', async () => {
    tpep.mockResolvedValue({ email: BK.email });
    usersByEmail.mockResolvedValue([BK, { id: 7, email: BK.email }]);
    await expect(actorFromSession('st-2')).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'more than one Users row for an email',
      expect.objectContaining({ count: 2, ids: [2, 7] }),
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(BK.email);
  });
  it('never lets a church account row act, whatever the case of its address', async () => {
    tpep.mockResolvedValue({ email: 'Church-ABC@Accounts.ChurchSyncPro.INVALID' });
    usersByEmail.mockResolvedValue([ACCOUNT]);
    await expect(actorFromSession('st-10')).resolves.toBeNull();
    expect(usersByEmail).not.toHaveBeenCalled();
  });
  it('asks SuperTokens again after five minutes and drops expired entries', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    tpep.mockImplementation(async (id: string) => ({ email: `${id}@example.test` }));
    usersByEmail.mockResolvedValue([BK]);
    await actorFromSession('st-1');
    await actorFromSession('st-2');
    expect(sessionEmailCacheSize()).toBe(2);
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    await actorFromSession('st-3');
    expect(sessionEmailCacheSize()).toBe(1);
    await actorFromSession('st-1');
    expect(tpep).toHaveBeenCalledTimes(4);
  });
});

describe('fromTokenId', () => {
  const body = (id: unknown) => ({ body: { id } }) as any;

  it('follows a token row to its church account email', async () => {
    tokenRows.mockResolvedValue({ id: 5, tokenEntityId: 3 });
    tokenEntities.mockResolvedValue({ id: 3, email: ACCOUNT.email });
    await expect(fromTokenId(body(5))).resolves.toEqual({ email: ACCOUNT.email });
    await expect(fromTokenId(body('5'))).resolves.toEqual({ email: ACCOUNT.email });
    expect(tokenRows).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(tokenEntities).toHaveBeenCalledWith({ where: { id: 3 } });
  });
  it.each([
    ['an array', [5, 9]],
    ['a one-item array', [5]],
    ['nothing', undefined],
    ['null', null],
    ['a fraction', 5.5],
    ['zero', 0],
    ['a negative number', -5],
    ['a non-numeric string', '5abc'],
    ['a padded string', ' 5'],
    ['an object', { gt: 0 }],
  ])('names no church for %s', async (_label, id) => {
    await expect(fromTokenId(body(id))).resolves.toEqual({});
    expect(tokenRows).not.toHaveBeenCalled();
  });
});

describe('fromBookkeeperRowId', () => {
  const body = (id: unknown) => ({ body: { id } }) as any;

  it('follows a legacy bookkeeper row to the church that invited', async () => {
    bookkeeperRows.mockResolvedValue({ id: 7, clientId: ACCOUNT.id, userId: BK.id });
    await expect(fromBookkeeperRowId(body(7))).resolves.toEqual({ userId: ACCOUNT.id });
    await expect(fromBookkeeperRowId(body('7'))).resolves.toEqual({ userId: ACCOUNT.id });
    expect(bookkeeperRows).toHaveBeenCalledWith({ where: { id: 7 } });
  });
  it('names no church for a row that does not exist', async () => {
    bookkeeperRows.mockResolvedValue(null);
    await expect(fromBookkeeperRowId(body(7))).resolves.toEqual({});
  });
  it.each([
    ['an array', [7, 9]],
    ['a one-item array', [7]],
    ['nothing', undefined],
    ['zero', 0],
    ['a non-numeric string', '7 OR 1=1'],
    ['an object', { gt: 0 }],
  ])('names no church for %s', async (_label, id) => {
    await expect(fromBookkeeperRowId(body(id))).resolves.toEqual({});
    expect(bookkeeperRows).not.toHaveBeenCalled();
  });
});

describe('legacy bookkeeper-screen locators', () => {
  it('sendEmailInvitation names the church by clientId', () => {
    expect(fromBodyClientId({ body: { clientId: 10, bookkeeperId: 2 } } as any)).toEqual({ userId: 10 });
  });
  it('createClientChurch names the account by bookkeeperId', () => {
    expect(fromBodyBookkeeperId({ body: { bookkeeperId: 2 } } as any)).toEqual({ userId: 2 });
  });
  it('bookkeeperList names clientId when it is given, as the handler reads it, else bookkeeperId', () => {
    expect(fromBodyClientOrBookkeeperId({ body: { clientId: 10, bookkeeperId: 2 } } as any)).toEqual({ userId: 10 });
    expect(fromBodyClientOrBookkeeperId({ body: { bookkeeperId: 2 } } as any)).toEqual({ userId: 2 });
    expect(fromBodyClientOrBookkeeperId({ body: { clientId: 0, bookkeeperId: 2 } } as any)).toEqual({ userId: 2 });
    expect(fromBodyClientOrBookkeeperId({ body: {} } as any)).toEqual({ userId: undefined });
  });
});

describe('isChurchGuard', () => {
  it('recognises the guards and says what each needs', () => {
    const owner = requireAccountAccess(fromBody, 'owner');
    expect(isChurchGuard(owner)).toBe(true);
    expect(owner.need).toBe('owner');
    expect(requireAccountAccess(fromBody).need).toBe('member');
    expect(isChurchGuard(requireChurch('integrations'))).toBe(true);
    expect(requireChurch('integrations').need).toBe('integrations');
  });
  it('says which kind of guard it is: by account (existing endpoints) or by churchId (/church)', () => {
    expect(requireAccountAccess(fromBody, 'owner').kind).toBe('account');
    expect(requireChurch('owner').kind).toBe('church');
  });
  it('does not mistake any other function for a guard', () => {
    expect(isChurchGuard(() => undefined)).toBe(false);
    expect(isChurchGuard(undefined)).toBe(false);
  });
});

describe('fromBodyItems', () => {
  const body = (data: unknown) => ({ body: { data } }) as any;
  const item = (email: string) => ({ email, batchData: { fundName: 'General' } });

  it('reads the email from finalSyncStripe items grouped by fund', () => {
    expect(
      fromBodyItems(body({ General: [item(ACCOUNT.email), item(ACCOUNT.email)], Charge: [item(ACCOUNT.email)] })),
    ).toEqual({ email: ACCOUNT.email });
  });
  it('still reads a flat list of items', () => {
    expect(fromBodyItems(body([item(ACCOUNT.email)]))).toEqual({ email: ACCOUNT.email });
  });
  it('names no church when the items are for more than one church', () => {
    expect(fromBodyItems(body({ General: [item(ACCOUNT.email)], Charge: [item(MATT.email)] }))).toEqual({});
    expect(fromBodyItems(body({ General: [item(ACCOUNT.email), { batchData: {} }] }))).toEqual({});
  });
  it('names no church when there are no items', () => {
    expect(fromBodyItems(body({}))).toEqual({});
    expect(fromBodyItems(body({ General: [] }))).toEqual({});
    expect(fromBodyItems(body(undefined))).toEqual({});
    expect(fromBodyItems(body('nonsense'))).toEqual({});
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
    usersByEmail.mockImplementation(async ({ where }: any) => {
      if (where.email === u.email) return [u];
      if (where.email === ACCOUNT.email) return [ACCOUNT];
      return [];
    });
    usersById.mockImplementation(async ({ where }: any) => (where.id === ACCOUNT.id ? ACCOUNT : null));
  };
  const session = { getUserId: () => 'st-2' };

  it('passes a member through and leaves the actor and the access on res.locals', async () => {
    signedInAs(BK);
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue({ role: 'bookkeeper', integrationAccessEnabled: false });
    const { next, res } = await run(requireAccountAccess(fromBody), { body: { email: ACCOUNT.email }, session });
    expect(next).toHaveBeenCalled();
    expect(res.locals.actor).toBe(BK);
    expect(res.locals.churchAccess.account).toBe(ACCOUNT);
  });
  it('answers 403 for a stranger and never calls the handler', async () => {
    signedInAs(BK);
    churches.mockResolvedValue(CHURCH);
    members.mockResolvedValue(null);
    const { next, code, body } = await run(requireAccountAccess(fromBody), { body: { email: ACCOUNT.email }, session });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(403);
    expect(body.success).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'church access refused',
      expect.objectContaining({ actorId: 2, accountId: 10 }),
    );
  });
  it('answers 404 when the request names no account', async () => {
    signedInAs(BK);
    const { code } = await run(requireAccountAccess(fromBody), { body: { email: '' }, session });
    expect(code).toBe(404);
  });
  it('answers 404 when no Users row has the email', async () => {
    signedInAs(BK);
    const { next, code } = await run(requireAccountAccess(fromBody), {
      body: { email: 'nobody@example.test' },
      session,
    });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(404);
  });
  it('answers 404 when more than one Users row has the email', async () => {
    signedInAs(BK);
    usersByEmail.mockImplementation(async ({ where }: any) =>
      where.email === BK.email ? [BK] : [ACCOUNT, { id: 11, email: ACCOUNT.email }],
    );
    const { next, code } = await run(requireAccountAccess(fromBody), { body: { email: ACCOUNT.email }, session });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(404);
    expect(log.error).toHaveBeenCalledWith(
      'more than one Users row for an email',
      expect.objectContaining({ count: 2, ids: [10, 11] }),
    );
  });
  it('answers 403 (not 401) when the session has no Users row', async () => {
    tpep.mockResolvedValue({ email: 'ghost@example.test' });
    usersByEmail.mockResolvedValue([]);
    const { code, body } = await run(requireAccountAccess(fromBody), {
      body: { email: ACCOUNT.email },
      session: { getUserId: () => 'st-9' },
    });
    expect(code).toBe(403);
    expect(body.message).toMatch(/sign in again/);
  });
  it('answers 500 when the check itself fails, logs who and what, and never calls the handler', async () => {
    signedInAs(BK);
    churches.mockRejectedValue(new Error('database unreachable'));
    const { next, code, body } = await run(requireAccountAccess(fromBody), { body: { email: ACCOUNT.email }, session });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(500);
    expect(body.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'church access check failed',
      expect.objectContaining({ actorId: 2, accountId: 10, need: 'member' }),
    );
  });
  it('answers 404 for an array token id, so one church cannot delete another church token', async () => {
    signedInAs(BK);
    const { next, code } = await run(requireAccountAccess(fromTokenId, 'integrations'), {
      body: { id: [5, 9] },
      session,
    });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(404);
    expect(tokenRows).not.toHaveBeenCalled();
  });

  describe('requireChurch', () => {
    const asMember = (role: 'owner' | 'bookkeeper' | null) => {
      signedInAs(BK);
      churches.mockImplementation(async ({ where }: any) =>
        where.id === 100 || where.ownerUserId === 10 ? CHURCH : null,
      );
      members.mockResolvedValue(role ? { role, integrationAccessEnabled: role === 'owner' } : null);
    };

    it('finds the account through churchId in the body', async () => {
      asMember('owner');
      const { next, res } = await run(requireChurch('owner'), { body: { churchId: 100 }, query: {}, session });
      expect(next).toHaveBeenCalled();
      expect(res.locals.churchAccess.church).toBe(CHURCH);
    });
    it('finds the account through churchId in the query string', async () => {
      asMember('bookkeeper');
      const { next } = await run(requireChurch(), { body: {}, query: { churchId: '100' }, session });
      expect(next).toHaveBeenCalled();
    });
    it.each([['abc'], [-1], [0], [1.5], [[100]], [undefined]])('answers 404 for churchId %p', async (churchId) => {
      asMember('owner');
      const { next, code } = await run(requireChurch(), { body: { churchId }, query: {}, session });
      expect(next).not.toHaveBeenCalled();
      expect(code).toBe(404);
      expect(churches).not.toHaveBeenCalled();
    });
    it('answers 404 for a church that does not exist', async () => {
      asMember('owner');
      const { next, code } = await run(requireChurch(), { body: { churchId: 999 }, query: {}, session });
      expect(next).not.toHaveBeenCalled();
      expect(code).toBe(404);
    });
    it('answers 403 for someone who is not a member', async () => {
      asMember(null);
      const { next, code } = await run(requireChurch(), { body: { churchId: 100 }, query: {}, session });
      expect(next).not.toHaveBeenCalled();
      expect(code).toBe(403);
    });
    it('answers 404 when the account it checked holds a different church than the one asked for', async () => {
      asMember('owner');
      churches.mockImplementation(async ({ where }: any) => {
        if (where.id === 100) return CHURCH;
        if (where.ownerUserId === 10) return { id: 101, ownerUserId: 10, isActive: true };
        return null;
      });
      const { next, code } = await run(requireChurch('owner'), { body: { churchId: 100 }, query: {}, session });
      expect(next).not.toHaveBeenCalled();
      expect(code).toBe(404);
    });
  });
});
