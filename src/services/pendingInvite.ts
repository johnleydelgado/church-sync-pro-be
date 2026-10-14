import { Op, Transaction } from 'sequelize';
import sequelize from '../db';
import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';
import Users from '../db/models/user';
import { createLogger } from '../utils/logger';

const logger = createLogger('pending-invite');

export type PendingInviteOutcome = 'created' | 'refreshed' | 'already-member' | 'no-church';

const lowerCol = (col: string, value: string) => sequelize.where(sequelize.fn('lower', sequelize.col(col)), value);

/**
 * The legacy Bookkeepers tab still invites through sendEmailInvitation, which writes a `bookkeeper`
 * row, but accepting an invite now reads ChurchMembers only (findInvite in controller/user.ts). Until
 * the People tab replaces that screen, write the pending ChurchMembers row as well, with the same
 * token as the mail, so the link works.
 *
 * One row per person per church: if the church already has a member with this invited email (any
 * case) or with the login that email belongs to, no second row is written. A still-pending invite is
 * pointed at the new token instead, because the link in the mail just sent carries that token.
 * 'already-member' writes nothing, so the caller can refuse the invite.
 *
 * Pass the caller's transaction to write this row together with the legacy one.
 */
export const recordPendingChurchInvite = async ({
  clientId,
  email,
  token,
  transaction,
}: {
  clientId: number;
  email: string;
  token: string;
  transaction?: Transaction;
}): Promise<PendingInviteOutcome> => {
  const church = await Church.findOne({ where: { ownerUserId: clientId }, transaction });
  if (!church) {
    logger.warn('invite for an account with no church filed under it; no ChurchMembers row written', { clientId });
    return 'no-church';
  }

  const invitedEmail = String(email).trim().toLowerCase();
  const loginIds = (
    await Users.findAll({ where: lowerCol('email', invitedEmail) as any, attributes: ['id'], transaction })
  ).map((u) => u.id);
  const existing = await ChurchMember.findOne({
    where: {
      churchId: church.id,
      [Op.or]: [lowerCol('invitedEmail', invitedEmail), ...(loginIds.length ? [{ userId: loginIds }] : [])],
    } as any,
    transaction,
  });

  if (existing) {
    if (!existing.inviteAccepted && !existing.userId) {
      await existing.update({ invitationToken: token }, { transaction });
      return 'refreshed';
    }
    return 'already-member';
  }

  await ChurchMember.create(
    {
      churchId: church.id,
      userId: null,
      role: 'bookkeeper',
      integrationAccessEnabled: false,
      invitedEmail,
      invitationToken: token,
      inviteAccepted: false,
    },
    { transaction },
  );
  return 'created';
};
