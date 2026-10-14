/**
 * Invites sent from the legacy Bookkeepers tab also write the pending ChurchMembers row, because
 * accepting an invite now reads ChurchMembers only. One row per person per church: someone already
 * on the church (by invited email, or by the login that email belongs to) gets no second row.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() } };
}
jest.mock('../../db/models/church', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db/models/user', mockModel);
// lower(...) comparisons are built through the sequelize instance; this stand-in records them.
jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    fn: (fn: string, ...args: unknown[]) => ({ fn, args }),
    col: (col: string) => ({ col }),
    where: (attribute: unknown, logic: unknown) => ({ attribute, logic }),
  },
}));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import { Op } from 'sequelize';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import Users from '../../db/models/user';
import { createLogger } from '../../utils/logger';
import { recordPendingChurchInvite } from '../pendingInvite';

const churches = (Church as any).findOne as jest.Mock;
const memberFind = (ChurchMember as any).findOne as jest.Mock;
const memberCreate = (ChurchMember as any).create as jest.Mock;
const logins = (Users as any).findAll as jest.Mock;
const log = createLogger('test') as any;

const CHURCH = { id: 100, ownerUserId: 10 };
const invite = { clientId: 10, email: '  BK@Example.test ', token: 'tok-new' };

beforeEach(() => {
  jest.resetAllMocks();
  churches.mockImplementation(async ({ where }: any) => (where.ownerUserId === 10 ? CHURCH : null));
  logins.mockResolvedValue([]);
  memberFind.mockResolvedValue(null);
  memberCreate.mockResolvedValue({ id: 1 });
});

it('writes a pending bookkeeper row with the same token as the mail', async () => {
  await expect(recordPendingChurchInvite(invite)).resolves.toBe('created');
  expect(churches).toHaveBeenCalledWith({ where: { ownerUserId: 10 } });
  expect(memberCreate).toHaveBeenCalledWith({
    churchId: 100,
    userId: null,
    role: 'bookkeeper',
    integrationAccessEnabled: false,
    invitedEmail: 'bk@example.test',
    invitationToken: 'tok-new',
    inviteAccepted: false,
  });
});

it('looks for an existing member by invited email (any case) and by the login with that email', async () => {
  logins.mockResolvedValue([{ id: 2 }, { id: 3 }]);
  await recordPendingChurchInvite(invite);
  const lowerEmail = { attribute: { fn: 'lower', args: [{ col: 'email' }] }, logic: 'bk@example.test' };
  expect(logins.mock.calls[0][0].where).toEqual(lowerEmail);
  const where = memberFind.mock.calls[0][0].where;
  expect(where.churchId).toBe(100);
  expect(where[Op.or]).toEqual([
    { attribute: { fn: 'lower', args: [{ col: 'invitedEmail' }] }, logic: 'bk@example.test' },
    { userId: [2, 3] },
  ]);
});

it('adds no second row for someone already on the church', async () => {
  const accepted = { id: 7, userId: 2, inviteAccepted: true, update: jest.fn() };
  memberFind.mockResolvedValue(accepted);
  await expect(recordPendingChurchInvite(invite)).resolves.toBe('already-member');
  expect(memberCreate).not.toHaveBeenCalled();
  expect(accepted.update).not.toHaveBeenCalled();
});

it('points a still-pending invite at the newest token, so the link just mailed works', async () => {
  const pending = { id: 8, userId: null, inviteAccepted: false, update: jest.fn().mockResolvedValue(undefined) };
  memberFind.mockResolvedValue(pending);
  await expect(recordPendingChurchInvite(invite)).resolves.toBe('refreshed');
  expect(pending.update).toHaveBeenCalledWith({ invitationToken: 'tok-new' });
  expect(memberCreate).not.toHaveBeenCalled();
});

it('writes nothing, and logs no address, when no church is filed under the account', async () => {
  await expect(recordPendingChurchInvite({ ...invite, clientId: 11 })).resolves.toBe('no-church');
  expect(memberFind).not.toHaveBeenCalled();
  expect(memberCreate).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.warn.mock.calls[0])).not.toMatch(/example\.test/i);
});
