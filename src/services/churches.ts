/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'crypto';
import { Op, UniqueConstraintError } from 'sequelize';
import sequelize from '../db';
import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';
import Users from '../db/models/user';
import bookkeeper from '../db/models/bookkeeper';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
import { canConnectIntegrations } from './churchContext';
import type { ChurchAccess } from './churchAccess';
import { inviteLinkFor, sendInviteEmail } from './inviteEmail';
import { createLogger } from '../utils/logger';

const logger = createLogger('churches');

/**
 * The Churches page and the People tab.
 *
 * A church's data is filed under one Users row, its account (Churches.ownerUserId). People reach
 * it through ChurchMembers. The caller's access has already been checked by requireChurch
 * (churchAccess.ts); these functions take its result and only do the work.
 */

export class ChurchServiceError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ChurchServiceError';
  }
}

export interface MyChurch {
  id: number;
  name: string;
  isActive: boolean;
  role: 'owner' | 'bookkeeper';
  /** Owner, or a bookkeeper an owner has allowed. */
  canConnectIntegrations: boolean;
  canManagePeople: boolean;
  /** The Users row the church's data is filed under. */
  accountUserId: number;
  /** What the existing endpoints take as `email`. */
  accountEmail: string;
  connections: { qbo: boolean; pco: boolean };
}

export interface ChurchPerson {
  memberId: number;
  role: 'owner' | 'bookkeeper';
  name: string | null;
  /** The login's email, or the invited address. */
  email: string;
  status: 'active' | 'invited';
  /** Owners: always true. */
  integrationAccessEnabled: boolean;
  isYou: boolean;
  /** Only for invited rows, only when the caller may manage people. */
  inviteLink: string | null;
}

export interface InviteResult {
  memberId: number;
  /** The address already had a login: added straight away, no link. */
  addedExisting: boolean;
  inviteLink: string | null;
  /** False when SendGrid refused; the link still works. */
  emailSent: boolean;
}

/**
 * A church added from the Churches page files its data under a row nobody can sign in as: no
 * SuperTokens user, and .invalid never receives mail.
 */
const ACCOUNT_DOMAIN = 'accounts.churchsyncpro.invalid';
const MAX_NAME = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cleanName = (name: unknown): string => {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new ChurchServiceError('Enter the church name.');
  if (n.length > MAX_NAME) throw new ChurchServiceError(`Church names can be up to ${MAX_NAME} characters.`);
  return n;
};

const lowerEq = (column: string, value: string) =>
  sequelize.where(sequelize.fn('lower', sequelize.col(column)), value.toLowerCase());

const personName = (u: any): string | null =>
  u ? [u.firstName, u.lastName].filter((s: string) => s && s !== 'N/A').join(' ') || null : null;

/** Error text from SendGrid can echo the recipient; logs never carry addresses. */
const withoutAddresses = (text: string) => text.replace(/[^\s@<>"',;:]+@[^\s@<>"',;:]+/g, '<address>');

const churchOf = (access: ChurchAccess): Church => {
  if (!access.church) throw new ChurchServiceError('Church not found.', 404);
  return access.church;
};

/** A client login - from before churches, or signed up since - owns the church its data is filed under. */
export const ensureOwnChurch = async (actor: Users): Promise<void> => {
  if (actor.role !== 'client') return;
  if (await Church.findOne({ where: { ownerUserId: actor.id } })) return;
  try {
    await sequelize.transaction(async (transaction) => {
      const church = await Church.create(
        { name: (actor.churchName || '').trim() || `Church #${actor.id}`, ownerUserId: actor.id as number, isActive: true },
        { transaction },
      );
      await ChurchMember.create(
        {
          churchId: church.id,
          userId: actor.id as number,
          role: 'owner',
          integrationAccessEnabled: true,
          invitedEmail: null,
          invitationToken: null,
          inviteAccepted: true,
        },
        { transaction },
      );
    });
  } catch (e) {
    // A parallel request made it first (churches_owner_user_unique).
    if (!(e instanceof UniqueConstraintError)) throw e;
  }
};

/** The caller's churches: active first, then by name. */
export const listMyChurches = async (actor: Users): Promise<MyChurch[]> => {
  await ensureOwnChurch(actor);
  const memberships: any[] = await ChurchMember.findAll({
    where: { userId: actor.id, inviteAccepted: true },
    include: [{ model: Church, as: 'Church' }],
  });
  const filed = memberships.filter((m) => m.Church?.ownerUserId);
  if (!filed.length) return [];

  const accounts: any[] = await Users.findAll({ where: { id: filed.map((m) => m.Church.ownerUserId) } });
  const accountById = new Map<number, any>(accounts.map((a) => [a.id, a]));
  const entities: any[] = await tokenEntity.findAll({
    where: { email: accounts.map((a) => a.email), isEnabled: true },
    include: tokens,
  });
  const connected = new Map<string, Set<string>>();
  for (const e of entities) {
    const types = connected.get(e.email) ?? new Set<string>();
    for (const t of e.tokens ?? []) if (t.access_token) types.add(t.token_type);
    connected.set(e.email, types);
  }

  return filed
    .map((m): MyChurch | null => {
      const account = accountById.get(m.Church.ownerUserId);
      if (!account) return null;
      const types = connected.get(account.email) ?? new Set<string>();
      return {
        id: m.Church.id,
        name: m.Church.name,
        isActive: m.Church.isActive !== false,
        role: m.role,
        canConnectIntegrations: canConnectIntegrations(m),
        canManagePeople: m.role === 'owner',
        accountUserId: account.id,
        accountEmail: account.email,
        connections: { qbo: types.has('qbo'), pco: types.has('pco') },
      };
    })
    .filter((c): c is MyChurch => c !== null)
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
};

/** Whoever adds a church owns it. Its data goes under a new account row nobody signs in as. */
export const createChurch = async (actor: Users, rawName: unknown): Promise<MyChurch> => {
  const name = cleanName(rawName);
  if ((await listMyChurches(actor)).some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new ChurchServiceError(`You already have a church called ${name}.`, 409);
  }
  const churchId = await sequelize.transaction(async (transaction) => {
    const account = await Users.create(
      {
        email: `church-${crypto.randomBytes(8).toString('hex')}@${ACCOUNT_DOMAIN}`,
        churchName: name,
        firstName: 'N/A',
        lastName: 'N/A',
        role: 'client',
        isSubscribe: '0',
        isActive: true,
      } as any,
      { transaction },
    );
    const church = await Church.create({ name, ownerUserId: account.id as number, isActive: true }, { transaction });
    await ChurchMember.create(
      {
        churchId: church.id,
        userId: actor.id as number,
        role: 'owner',
        integrationAccessEnabled: true,
        invitedEmail: null,
        invitationToken: null,
        inviteAccepted: true,
      },
      { transaction },
    );
    return church.id;
  });
  const created = (await listMyChurches(actor)).find((c) => c.id === churchId);
  if (!created) throw new Error(`church ${churchId} was created but is not listed`);
  return created;
};

/** Rename and/or (de)activate. Owner only (checked by the route). */
export const updateChurch = async (
  access: ChurchAccess,
  changes: { name?: unknown; isActive?: unknown },
): Promise<void> => {
  const church = churchOf(access);
  const name = changes.name !== undefined ? cleanName(changes.name) : undefined;
  if (changes.isActive !== undefined && typeof changes.isActive !== 'boolean') {
    throw new ChurchServiceError('Choose whether the church is active.');
  }
  await sequelize.transaction(async (transaction) => {
    await church.update(
      {
        ...(name !== undefined ? { name } : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive as boolean } : {}),
      },
      { transaction },
    );
    // Older screens read the name off the account row. isActive stays on the church: for Active
    // Church the account row is Matt's own login, which must not be switched off with it.
    if (name !== undefined) {
      await Users.update({ churchName: name } as any, { where: { id: access.account.id }, transaction });
    }
  });
};

/** Everyone on the church: owners, then active bookkeepers, then outstanding invites. */
export const listPeople = async (access: ChurchAccess, actor: Users): Promise<ChurchPerson[]> => {
  const church = churchOf(access);
  // No membership means the caller is the church's own login, which may do anything.
  const canManage = access.membership === null || access.membership.role === 'owner';
  const rows: any[] = await ChurchMember.findAll({
    where: { churchId: church.id },
    include: [{ model: Users, as: 'User' }],
  });
  const rank = (p: ChurchPerson) => (p.role === 'owner' ? 0 : p.status === 'active' ? 1 : 2);
  return rows
    .map((m): ChurchPerson => {
      const invited = !(m.inviteAccepted && m.userId);
      return {
        memberId: m.id,
        role: m.role,
        name: personName(m.User),
        email: m.User?.email ?? m.invitedEmail ?? '',
        status: invited ? 'invited' : 'active',
        integrationAccessEnabled: canConnectIntegrations(m),
        isYou: m.userId === actor.id,
        inviteLink:
          canManage && invited && m.invitationToken && m.invitedEmail
            ? inviteLinkFor(m.invitedEmail, m.invitationToken)
            : null,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email));
};

/**
 * Invite someone as a bookkeeper. Someone who already has a login is added straight away; anyone
 * else gets a link, which is returned as well as emailed because email does not always arrive.
 */
export const invitePerson = async (access: ChurchAccess, rawEmail: unknown): Promise<InviteResult> => {
  const churchId = churchOf(access).id;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.endsWith(`@${ACCOUNT_DOMAIN}`)) {
    throw new ChurchServiceError('Enter a valid email address.');
  }

  const login: any = await Users.findOne({ where: lowerEq('email', email) });
  if (
    login &&
    (login.id === access.account.id || (await ChurchMember.findOne({ where: { churchId, userId: login.id } })))
  ) {
    throw new ChurchServiceError(`${email} is already on this church.`, 409);
  }
  if (await ChurchMember.findOne({ where: { [Op.and]: [{ churchId }, lowerEq('invitedEmail', email)] } as any })) {
    throw new ChurchServiceError(`${email} has already been invited. Copy their invite link from the list.`, 409);
  }

  if (login) {
    // Already has a Church Sync Pro login: add them now rather than send a link they'd have to accept.
    const member = await ChurchMember.create({
      churchId,
      userId: login.id,
      role: 'bookkeeper',
      integrationAccessEnabled: false,
      invitedEmail: email,
      invitationToken: null,
      inviteAccepted: true,
    });
    return { memberId: member.id, addedExisting: true, inviteLink: null, emailSent: false };
  }

  const token = crypto.randomBytes(16).toString('hex');
  const member = await ChurchMember.create({
    churchId,
    userId: null,
    role: 'bookkeeper',
    integrationAccessEnabled: false,
    invitedEmail: email,
    invitationToken: token,
    inviteAccepted: false,
  });
  const inviteLink = inviteLinkFor(email, token);
  let emailSent = true;
  try {
    await sendInviteEmail(email, inviteLink);
  } catch (e) {
    // SendGrid's DNS is not set up (2026-09-29): the owner can still send the link themselves.
    emailSent = false;
    logger.warn('invite email not sent', {
      churchId,
      memberId: member.id,
      error: withoutAddresses(e instanceof Error ? e.message : String(e)),
    });
  }
  return { memberId: member.id, addedExisting: false, inviteLink, emailSent };
};

const memberOf = async (access: ChurchAccess, memberId: unknown): Promise<ChurchMember> => {
  const churchId = churchOf(access).id;
  const id = Number(memberId);
  const m = Number.isInteger(id) && id > 0 ? await ChurchMember.findOne({ where: { id, churchId } }) : null;
  if (!m) throw new ChurchServiceError('That person is not on this church.', 404);
  return m;
};

/** Whether a bookkeeper may connect QuickBooks / Planning Center. Owners always may. */
export const setIntegrationAccess = async (access: ChurchAccess, memberId: unknown, enabled: unknown): Promise<void> => {
  const m = await memberOf(access, memberId);
  if (m.role === 'owner') throw new ChurchServiceError('Owners can always connect QuickBooks and Planning Center.');
  if (typeof enabled !== 'boolean') throw new ChurchServiceError('Choose whether they can connect integrations.');
  await m.update({ integrationAccessEnabled: enabled });
};

/** Take someone off the church, or withdraw their invite. A church keeps at least one owner. */
export const removePerson = async (access: ChurchAccess, memberId: unknown): Promise<void> => {
  const m = await memberOf(access, memberId);
  const churchId = m.churchId;
  if (
    m.role === 'owner' &&
    (await ChurchMember.count({ where: { churchId, role: 'owner', inviteAccepted: true } })) <= 1
  ) {
    throw new ChurchServiceError('A church needs at least one owner.', 409);
  }
  await sequelize.transaction(async (transaction) => {
    await m.destroy({ transaction });
    // Keep the legacy table in step until its endpoints are retired.
    const who: any[] = [
      ...(m.userId ? [{ userId: m.userId }] : []),
      ...(m.invitedEmail ? [lowerEq('email', m.invitedEmail)] : []),
    ];
    if (who.length) {
      await bookkeeper.destroy({ where: { clientId: access.account.id, [Op.or]: who } as any, transaction });
    }
  });
};
