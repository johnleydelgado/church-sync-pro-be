import { Op } from 'sequelize';
import sequelize from '../db';
import bookkeeper from '../db/models/bookkeeper';
import Church from '../db/models/church';
import ChurchMember from '../db/models/churchMember';

/**
 * The legacy Bookkeepers tab removes a person by deleting their `bookkeeper` row (deleteBookeeper,
 * retired in Task 22). Access now comes from ChurchMembers only, so deleting that row alone left the
 * person able to open the church. This removes the matching member row on the church filed under
 * the row's clientId as well, in the same transaction: both go, or neither.
 *
 * The member is matched by the row's login, or by the address the invite went to (any case), so a
 * still-pending invite is withdrawn too. Returns null when there is no such row.
 */
export const removeLegacyBookkeeper = async (id: number): Promise<{ removedMembers: number } | null> =>
  sequelize.transaction(async (transaction) => {
    const row = await bookkeeper.findOne({ where: { id }, transaction });
    if (!row) return null;

    let removedMembers = 0;
    const church = await Church.findOne({ where: { ownerUserId: row.clientId }, transaction });
    if (church) {
      const who: unknown[] = [];
      // A row attached to its own client is a data quirk, not a person (churchBackfillPlan.js skips
      // it too): matching it by userId would take the church's own login off its church.
      if (row.userId && row.userId !== row.clientId) who.push({ userId: row.userId });
      if (typeof row.email === 'string' && row.email.trim()) {
        who.push(sequelize.where(sequelize.fn('lower', sequelize.col('invitedEmail')), row.email.trim().toLowerCase()));
      }
      if (who.length) {
        removedMembers = await ChurchMember.destroy({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: { churchId: church.id, [Op.or]: who } as any,
          transaction,
        });
      }
    }

    await bookkeeper.destroy({ where: { id: row.id }, transaction });
    return { removedMembers };
  });
