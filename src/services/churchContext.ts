import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';
import Users from '../db/models/user';

export interface ChurchContext {
  church: Church;
  /** The client login the church was created from; null once churches can exist without one. */
  ownerUser: Users | null;
}

/**
 * Which church is this request about?
 *
 * New callers send a churchId. Older callers - and the whole frontend until it moves
 * over - send the client login's email, which after the backfill maps to exactly one
 * church through Churches.ownerUserId. churchId wins when both are present.
 */
export const resolveChurch = async ({
  churchId,
  email,
}: {
  churchId?: number | string | null;
  email?: string | null;
}): Promise<ChurchContext | null> => {
  if (churchId !== undefined && churchId !== null && churchId !== '') {
    const id = Number(churchId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const church = await Church.findOne({ where: { id } });
    if (!church) return null;
    const ownerUser = church.ownerUserId ? await Users.findOne({ where: { id: church.ownerUserId } }) : null;
    return { church, ownerUser };
  }
  if (email) {
    const ownerUser = await Users.findOne({ where: { email } });
    if (!ownerUser) return null;
    const church = await Church.findOne({ where: { ownerUserId: ownerUser.id } });
    return church ? { church, ownerUser } : null;
  }
  return null;
};

export class NotAMemberError extends Error {
  public readonly status = 403;
  constructor(churchId: number, userId: number) {
    super(`User ${userId} is not a member of church ${churchId}`);
    this.name = 'NotAMemberError';
  }
}

/** The caller's membership of the church, or a 403-shaped error. */
export const assertMembership = async (churchId: number, userId: number): Promise<ChurchMember> => {
  const membership = await ChurchMember.findOne({ where: { churchId, userId } });
  if (!membership) throw new NotAMemberError(churchId, userId);
  return membership;
};

/** May this member connect QuickBooks / Planning Center for the church? Owners always; bookkeepers only when granted. */
export const canConnectIntegrations = (membership: Pick<ChurchMember, 'role' | 'integrationAccessEnabled'>): boolean =>
  membership.role === 'owner' || membership.integrationAccessEnabled === true;
