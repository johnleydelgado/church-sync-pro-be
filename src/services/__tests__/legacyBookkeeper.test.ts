/**
 * The legacy Bookkeepers tab removes a person by deleting their `bookkeeper` row. Access now comes
 * from ChurchMembers only, so deleting that row alone left the person able to open the church. The
 * matching member row goes too, in the same transaction.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), destroy: jest.fn() } };
}
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/church', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
// Runs the callback with a marker transaction, and records lower(...) comparisons so a test can read
// the query back. Needs no config.json.
jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    transaction: jest.fn((work: (t: unknown) => unknown) => work('TX')),
    fn: (fn: string, ...args: unknown[]) => ({ fn, args }),
    col: (col: string) => ({ col }),
    where: (attribute: unknown, logic: unknown) => ({ attribute, logic }),
  },
}));

import { Op } from 'sequelize';
import bookkeeper from '../../db/models/bookkeeper';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import sequelize from '../../db';
import { removeLegacyBookkeeper } from '../legacyBookkeeper';

const bk = bookkeeper as unknown as { findOne: jest.Mock; destroy: jest.Mock };
const church = Church as unknown as { findOne: jest.Mock };
const member = ChurchMember as unknown as { destroy: jest.Mock };
const transaction = (sequelize as unknown as { transaction: jest.Mock }).transaction;

const lowerEq = (col: string, value: string) => ({ attribute: { fn: 'lower', args: [{ col }] }, logic: value });

beforeEach(() => {
  jest.clearAllMocks();
  church.findOne.mockResolvedValue({ id: 3, ownerUserId: 10 });
  member.destroy.mockResolvedValue(1);
  bk.destroy.mockResolvedValue(1);
});

it('removes the member by login or by invited address, and the legacy row, in one transaction', async () => {
  bk.findOne.mockResolvedValue({ id: 7, clientId: 10, userId: 42, email: 'Bk@Cfp.com' });

  await expect(removeLegacyBookkeeper(7)).resolves.toEqual({ removedMembers: 1 });

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(bk.findOne).toHaveBeenCalledWith({ where: { id: 7 }, transaction: 'TX' });
  expect(church.findOne).toHaveBeenCalledWith({ where: { ownerUserId: 10 }, transaction: 'TX' });
  expect(member.destroy).toHaveBeenCalledWith({
    where: { churchId: 3, [Op.or]: [{ userId: 42 }, lowerEq('invitedEmail', 'bk@cfp.com')] },
    transaction: 'TX',
  });
  expect(bk.destroy).toHaveBeenCalledWith({ where: { id: 7 }, transaction: 'TX' });
});

it('withdraws a pending invite (no login yet) by its address', async () => {
  bk.findOne.mockResolvedValue({ id: 7, clientId: 10, userId: null, email: 'new@cfp.com' });

  await removeLegacyBookkeeper(7);

  expect(member.destroy).toHaveBeenCalledWith({
    where: { churchId: 3, [Op.or]: [lowerEq('invitedEmail', 'new@cfp.com')] },
    transaction: 'TX',
  });
  expect(bk.destroy).toHaveBeenCalled();
});

it("never matches the church's own login (a row attached to its own client is a data quirk)", async () => {
  bk.findOne.mockResolvedValue({ id: 7, clientId: 10, userId: 10, email: null });

  await expect(removeLegacyBookkeeper(7)).resolves.toEqual({ removedMembers: 0 });

  expect(member.destroy).not.toHaveBeenCalled();
  expect(bk.destroy).toHaveBeenCalledWith({ where: { id: 7 }, transaction: 'TX' });
});

it('only deletes the legacy row when no church is filed under its client', async () => {
  bk.findOne.mockResolvedValue({ id: 7, clientId: 10, userId: 42, email: 'bk@cfp.com' });
  church.findOne.mockResolvedValue(null);

  await expect(removeLegacyBookkeeper(7)).resolves.toEqual({ removedMembers: 0 });

  expect(member.destroy).not.toHaveBeenCalled();
  expect(bk.destroy).toHaveBeenCalled();
});

it('returns null and deletes nothing for an unknown row', async () => {
  bk.findOne.mockResolvedValue(null);

  await expect(removeLegacyBookkeeper(7)).resolves.toBeNull();

  expect(member.destroy).not.toHaveBeenCalled();
  expect(bk.destroy).not.toHaveBeenCalled();
});

it('lets a failure propagate so the transaction rolls both deletes back', async () => {
  bk.findOne.mockResolvedValue({ id: 7, clientId: 10, userId: 42, email: 'bk@cfp.com' });
  member.destroy.mockRejectedValue(new Error('connection lost'));

  await expect(removeLegacyBookkeeper(7)).rejects.toThrow('connection lost');

  expect(bk.destroy).not.toHaveBeenCalled();
});
