/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextFunction, Request, Response } from 'express';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import { col, fn, where as sqlWhere } from 'sequelize';
import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';
import Users from '../db/models/user';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
import bookkeeper from '../db/models/bookkeeper';
import { canConnectIntegrations } from './churchContext';
import { ACCOUNT_EMAIL_DOMAIN, isChurchAccountEmail } from './churchAccountEmail';
import { clearSessionEmailCache, sessionEmail, sessionEmailCacheSize } from './sessionEmail';
import { createLogger } from '../utils/logger';

export { ACCOUNT_EMAIL_DOMAIN, isChurchAccountEmail, clearSessionEmailCache, sessionEmailCacheSize };

const logger = createLogger('church-access');

/**
 * Who may work on which church.
 *
 * A church's settings, tokens and postings are filed under one Users row - its account,
 * Churches.ownerUserId. For a church that started as a client login (Active Church) that row is
 * the person's own login; for a church added from the Churches page it is a row nobody signs in
 * with. People reach a church through ChurchMembers. This file is the only place that decides.
 */
export type ChurchNeed = 'member' | 'integrations' | 'owner';

export interface ChurchAccess {
  /** Null when the row is a person's own login with no church filed under it. */
  church: Church | null;
  account: Users;
  /** Null when the caller IS the account. */
  membership: ChurchMember | null;
}

export class ChurchAccessError extends Error {
  constructor(
    public readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'ChurchAccessError';
  }
}

const NO_ACCESS = "You don't have access to this church.";
const NOT_FOUND = 'Church not found.';

/**
 * A row id as a request sent it: a positive integer, or a string of digits. Anything else is no id -
 * above all an array, which Sequelize turns into `IN (...)`, so a guard that checked one row would
 * let the handler touch several.
 */
const positiveId = (value: unknown): number | null => {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The Users rows with this email, at most two: Users.email is not unique, and when two rows share
 * an address nobody can say which one is meant, so neither is used. `anyCase` compares without
 * case. Logs ids, never the address itself.
 */
const lookUpEmail = async (email: string, anyCase = false): Promise<{ user: Users | null; ambiguous: boolean }> => {
  const where = anyCase ? sqlWhere(fn('lower', col('email')), email.trim().toLowerCase()) : { email };
  const rows = await Users.findAll({ where: where as any, limit: 2 });
  if (rows.length > 1) {
    // `count` is at least this many: the lookup stops at two.
    logger.error(
      anyCase ? 'more than one Users row for an email in any case' : 'more than one Users row for an email',
      {
        count: rows.length,
        ids: rows.map((r) => r.id),
      },
    );
    return { user: null, ambiguous: true };
  }
  return { user: rows[0] ?? null, ambiguous: false };
};

/** The one Users row spelled exactly so - how every handler looks a church's account up. */
const userByEmail = async (email: string): Promise<Users | null> => (await lookUpEmail(email)).user;

/**
 * The signed-in person's Users row. A session only carries the SuperTokens id, so go through the
 * email: the row spelled exactly as the login, else the one row that differs from it only in case
 * (a row written in another case than SuperTokens holds the login). A church's account row is
 * never a person, so its address never resolves to an actor.
 */
export const actorFromSession = async (sessionUserId: string | undefined): Promise<Users | null> => {
  const email = await sessionEmail(sessionUserId);
  if (!email || isChurchAccountEmail(email)) return null;
  const exact = await lookUpEmail(email);
  if (exact.user || exact.ambiguous) return exact.user;
  return (await lookUpEmail(email, true)).user;
};

/**
 * May `actor` work on the data filed under `account`? Their own row always; otherwise an accepted
 * ChurchMembers row on the church filed under it, and 'integrations' / 'owner' as the role allows.
 */
export const checkAccountAccess = async (
  actor: Users,
  account: Users,
  need: ChurchNeed = 'member',
): Promise<ChurchAccess> => {
  const church = await Church.findOne({ where: { ownerUserId: account.id } });
  if (actor.id === account.id) return { church, account, membership: null };
  if (!church) throw new ChurchAccessError(403, NO_ACCESS);
  const membership = await ChurchMember.findOne({
    where: { churchId: church.id, userId: actor.id, inviteAccepted: true },
  });
  if (!membership) throw new ChurchAccessError(403, NO_ACCESS);
  if (need === 'owner' && membership.role !== 'owner') {
    throw new ChurchAccessError(403, 'Only an owner of this church can do that.');
  }
  if (need === 'integrations' && !canConnectIntegrations(membership)) {
    throw new ChurchAccessError(
      403,
      "This church's owner hasn't given you access to connect QuickBooks or Planning Center.",
    );
  }
  return { church, account, membership };
};

type Named = { email?: unknown; userId?: unknown };

const findAccount = async ({ email, userId }: Named): Promise<Users | null> => {
  if (userId !== undefined && userId !== null && userId !== '') {
    const id = positiveId(userId);
    return id ? Users.findOne({ where: { id } }) : null;
  }
  return typeof email === 'string' && email ? userByEmail(email) : null;
};

/** The account a request names, and - for /church endpoints - the church id it named. */
type Located = { account: Users | null; churchId?: number };

const guard =
  (locate: (req: Request) => Promise<Located>, need: ChurchNeed) =>
  async (req: SessionRequest, res: Response, next: NextFunction) => {
    let actor: Users | null = null;
    let account: Users | null = null;
    try {
      actor = await actorFromSession(req.session?.getUserId());
      if (!actor) throw new ChurchAccessError(403, 'Your account was not found. Sign out and sign in again.');
      const located = await locate(req);
      account = located.account;
      if (!account) throw new ChurchAccessError(404, NOT_FOUND);
      const access = await checkAccountAccess(actor, account, need);
      // The church asked for by id must be the one whose access was just checked.
      if (located.churchId !== undefined && access.church?.id !== located.churchId) {
        throw new ChurchAccessError(404, NOT_FOUND);
      }
      res.locals.actor = actor;
      res.locals.churchAccess = access;
      return next();
    } catch (e) {
      if (e instanceof ChurchAccessError) {
        if (e.status === 403) {
          logger.warn('church access refused', { path: req.path, actorId: actor?.id, accountId: account?.id, need });
        }
        return res.status(e.status).json({ success: false, message: e.message });
      }
      logger.error('church access check failed', {
        path: req.path,
        actorId: actor?.id,
        accountId: account?.id,
        need,
        error: e instanceof Error ? e.message : String(e),
      });
      return res
        .status(500)
        .json({ success: false, message: 'Could not check your access to this church. Try again.' });
    }
  };

/** How a guard finds the church: by the account a request names, or by a /church churchId. */
export type ChurchGuardKind = 'account' | 'church';

/**
 * Marks a guard so routes/__tests__/routers.test.ts can tell a guarded route from an unguarded one
 * by looking at the router, and check each route asks for the right need with the right kind.
 */
const marked = <T extends (...args: any[]) => unknown>(fn: T, need: ChurchNeed, kind: ChurchGuardKind) =>
  Object.assign(fn, { churchGuard: true as const, need, kind });

export const isChurchGuard = (fn: unknown): boolean =>
  typeof fn === 'function' && (fn as { churchGuard?: unknown }).churchGuard === true;

/** For the existing endpoints, which name the church by its account's email or user id. */
export const requireAccountAccess = (locate: (req: Request) => Named | Promise<Named>, need: ChurchNeed = 'member') =>
  marked(
    guard(async (req) => ({ account: await findAccount(await locate(req)) }), need),
    need,
    'account',
  );

/** For /church endpoints, which name the church by churchId (body, or query string for GETs). */
export const requireChurch = (need: ChurchNeed = 'member') =>
  marked(
    guard(async (req) => {
      const churchId = positiveId(req.body?.churchId ?? req.query?.churchId);
      if (churchId === null) return { account: null };
      const church = await Church.findOne({ where: { id: churchId } });
      const account = church?.ownerUserId ? await Users.findOne({ where: { id: church.ownerUserId } }) : null;
      return { account, churchId };
    }, need),
    need,
    'church',
  );

// Where each existing endpoint names its church.
export const fromQuery = (req: Request): Named => ({ email: req.query?.email });
export const fromBody = (req: Request): Named => ({ email: req.body?.email });
export const fromBodyUserId = (req: Request): Named => ({ userId: req.body?.userId });
export const fromBillingData = (req: Request): Named => ({ userId: req.body?.data?.userId });
/**
 * finalSyncStripe sends `data` as { [fundName]: item[] }, each item with its own email; all items
 * must name the same church. Empty funds count for nothing, as in the handler.
 */
export const fromBodyItems = (req: Request): Named => {
  const raw = req.body?.data;
  let items: any[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === 'object') items = ([] as any[]).concat(...Object.values(raw).map((v) => v || []));
  const emails = new Set(items.map((d: any) => d?.email));
  return emails.size === 1 ? { email: [...emails][0] } : {};
};
/**
 * deleteUserToken names a token row; its church is the token entity's email. The handler deletes
 * WHERE id = body.id, so only a single plain id names a church.
 */
export const fromTokenId = async (req: Request): Promise<Named> => {
  const id = positiveId(req.body?.id);
  if (id === null) return {};
  const token: any = await tokens.findOne({ where: { id } });
  const entity: any = token ? await tokenEntity.findOne({ where: { id: token.tokenEntityId } }) : null;
  return { email: entity?.email };
};

// The legacy Bookkeepers / Clients screens (retired in Task 22).
/** sendEmailInvitation: the church inviting is clientId. */
export const fromBodyClientId = (req: Request): Named => ({ userId: req.body?.clientId });
/** createClientChurch: the bookkeeper adding a church names their own row. */
export const fromBodyBookkeeperId = (req: Request): Named => ({ userId: req.body?.bookkeeperId });
/** bookkeeperList: clientId when it is given (truthy, as the handler reads it), else bookkeeperId. */
export const fromBodyClientOrBookkeeperId = (req: Request): Named => ({
  userId: req.body?.clientId || req.body?.bookkeeperId,
});
/**
 * deleteBookeeper names a legacy bookkeeper row; its church is the row's clientId. The handler
 * deletes WHERE id = body.id, so only a single plain id names a church.
 */
export const fromBookkeeperRowId = async (req: Request): Promise<Named> => {
  const id = positiveId(req.body?.id);
  if (id === null) return {};
  const row: any = await bookkeeper.findOne({ where: { id } });
  return row ? { userId: row.clientId } : {};
};
