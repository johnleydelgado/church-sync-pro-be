/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextFunction, Request, Response } from 'express';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';
import Users from '../db/models/user';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
import { canConnectIntegrations } from './churchContext';
import { createLogger } from '../utils/logger';

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

// One SuperTokens lookup per person per five minutes rather than per request.
const SESSION_EMAIL_TTL_MS = 5 * 60 * 1000;
const sessionEmails = new Map<string, { email: string; at: number }>();
export const clearSessionEmailCache = () => sessionEmails.clear();

/** The signed-in person's Users row. A session only carries the SuperTokens id, so go through the email. */
export const actorFromSession = async (sessionUserId: string | undefined): Promise<Users | null> => {
  if (!sessionUserId) return null;
  let hit = sessionEmails.get(sessionUserId);
  if (!hit || Date.now() - hit.at > SESSION_EMAIL_TTL_MS) {
    const st: any =
      (await ThirdPartyEmailPassword.getUserById(sessionUserId)) ?? (await EmailPassword.getUserById(sessionUserId));
    if (!st?.email) return null;
    hit = { email: String(st.email), at: Date.now() };
    sessionEmails.set(sessionUserId, hit);
  }
  return Users.findOne({ where: { email: hit.email } });
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
    const id = Number(userId);
    return Number.isInteger(id) && id > 0 ? Users.findOne({ where: { id } }) : null;
  }
  return typeof email === 'string' && email ? Users.findOne({ where: { email } }) : null;
};

const guard =
  (resolveAccount: (req: Request) => Promise<Users | null>, need: ChurchNeed) =>
  async (req: SessionRequest, res: Response, next: NextFunction) => {
    let actor: Users | null = null;
    let account: Users | null = null;
    try {
      actor = await actorFromSession(req.session?.getUserId());
      if (!actor) throw new ChurchAccessError(403, 'Your account was not found. Sign out and sign in again.');
      account = await resolveAccount(req);
      if (!account) throw new ChurchAccessError(404, 'Church not found.');
      res.locals.actor = actor;
      res.locals.churchAccess = await checkAccountAccess(actor, account, need);
      return next();
    } catch (e) {
      if (e instanceof ChurchAccessError) {
        if (e.status === 403) {
          logger.warn('church access refused', { path: req.path, actorId: actor?.id, accountId: account?.id, need });
        }
        return res.status(e.status).json({ success: false, message: e.message });
      }
      logger.error('church access check failed', { path: req.path, error: e instanceof Error ? e.message : String(e) });
      return res
        .status(500)
        .json({ success: false, message: 'Could not check your access to this church. Try again.' });
    }
  };

/** For the existing endpoints, which name the church by its account's email or user id. */
export const requireAccountAccess = (locate: (req: Request) => Named | Promise<Named>, need: ChurchNeed = 'member') =>
  guard(async (req) => findAccount(await locate(req)), need);

/** For /church endpoints, which name the church by churchId. */
export const requireChurch = (need: ChurchNeed = 'member') =>
  guard(async (req) => {
    const id = Number(req.body?.churchId ?? req.query?.churchId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const church = await Church.findOne({ where: { id } });
    return church?.ownerUserId ? Users.findOne({ where: { id: church.ownerUserId } }) : null;
  }, need);

// Where each existing endpoint names its church.
export const fromQuery = (req: Request): Named => ({ email: req.query?.email });
export const fromBody = (req: Request): Named => ({ email: req.body?.email });
export const fromBodyUserId = (req: Request): Named => ({ userId: req.body?.userId });
export const fromBillingData = (req: Request): Named => ({ userId: req.body?.data?.userId });
/** finalSyncStripe sends one email per item; all items must be the same church. */
export const fromBodyItems = (req: Request): Named => {
  const emails = new Set((Array.isArray(req.body?.data) ? req.body.data : []).map((d: any) => d?.email));
  return emails.size === 1 ? { email: [...emails][0] } : {};
};
/** deleteUserToken names a token row; its church is the token entity's email. */
export const fromTokenId = async (req: Request): Promise<Named> => {
  const token: any = await tokens.findOne({ where: { id: req.body?.id } });
  const entity: any = token ? await tokenEntity.findOne({ where: { id: token.tokenEntityId } }) : null;
  return { email: entity?.email };
};
