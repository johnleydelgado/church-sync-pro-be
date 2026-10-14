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
 * The member is matched by the row's login, or - only while it is still waiting for a login - by the
 * address the invite went to (any case), so a pending invite is withdrawn too. The address never
 * finds a member who has a login: an invite sent twice leaves a stale pending legacy row next to the
 * accepted one, and deleting the stale row must not take the person who accepted off the church.
 * A row that names an owner is refused ('owner') and nothing is deleted: owners are removed from
 * the People tab, which keeps a church from losing its last one. Returns null when there is no
 * such row.
 */
export const removeLegacyBookkeeper = async (id: number): Promise<{ removedMembers: number } | 'owner' | null> =>
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
        who.push({
          [Op.and]: [
            { userId: null },
            sequelize.where(sequelize.fn('lower', sequelize.col('invitedEmail')), row.email.trim().toLowerCase()),
          ],
        });
      }
      if (who.length) {
        const owner = await ChurchMember.findOne({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: { churchId: church.id, role: 'owner', [Op.or]: who } as any,
          transaction,
        });
        if (owner) return 'owner';
        removedMembers = await ChurchMember.destroy({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: { churchId: church.id, role: 'bookkeeper', [Op.or]: who } as any,
          transaction,
        });
      }
    }

    await bookkeeper.destroy({ where: { id: row.id }, transaction });
    return { removedMembers };
  });
