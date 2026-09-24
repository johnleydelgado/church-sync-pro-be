/**
 * Every controller will pick its church through resolveChurch, so the precedence and the
 * failure shapes are pinned here: churchId first, the legacy email second, null (never a
 * guess) when neither finds a church.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn() } };
}
jest.mock('../../db/models/church', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db/models/user', mockModel);

import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import Users from '../../db/models/user';
import { assertMembership, canConnectIntegrations, NotAMemberError, resolveChurch } from '../churchContext';

const church = Church as unknown as { findOne: jest.Mock };
const member = ChurchMember as unknown as { findOne: jest.Mock };
const users = Users as unknown as { findOne: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('resolveChurch', () => {
  it('finds the church by id and loads its owner login', async () => {
    church.findOne.mockResolvedValue({ id: 4, ownerUserId: 1, name: 'Active Church' });
    users.findOne.mockResolvedValue({ id: 1, email: 'matt@cfp.com' });
    const ctx = await resolveChurch({ churchId: '4' });
    expect(church.findOne).toHaveBeenCalledWith({ where: { id: 4 } });
    expect(users.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(ctx).toEqual({ church: { id: 4, ownerUserId: 1, name: 'Active Church' }, ownerUser: { id: 1, email: 'matt@cfp.com' } });
  });

  it('returns a church that has no owner login with ownerUser null', async () => {
    church.findOne.mockResolvedValue({ id: 5, ownerUserId: null, name: 'Loginless Church' });
    const ctx = await resolveChurch({ churchId: 5 });
    expect(users.findOne).not.toHaveBeenCalled();
    expect(ctx?.ownerUser).toBeNull();
  });

  it('returns null for an unknown or malformed churchId, without falling back to the email', async () => {
    church.findOne.mockResolvedValue(null);
    expect(await resolveChurch({ churchId: 999, email: 'matt@cfp.com' })).toBeNull();
    expect(await resolveChurch({ churchId: 'abc', email: 'matt@cfp.com' })).toBeNull();
    expect(await resolveChurch({ churchId: -1 })).toBeNull();
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('resolves the legacy email through the login that owns the church', async () => {
    users.findOne.mockResolvedValue({ id: 1, email: 'matt@cfp.com' });
    church.findOne.mockResolvedValue({ id: 4, ownerUserId: 1 });
    const ctx = await resolveChurch({ email: 'matt@cfp.com' });
    expect(users.findOne).toHaveBeenCalledWith({ where: { email: 'matt@cfp.com' } });
    expect(church.findOne).toHaveBeenCalledWith({ where: { ownerUserId: 1 } });
    expect(ctx?.church.id).toBe(4);
  });

  it('returns null when the email is unknown or its login owns no church', async () => {
    users.findOne.mockResolvedValueOnce(null);
    expect(await resolveChurch({ email: 'nobody@x.com' })).toBeNull();
    users.findOne.mockResolvedValueOnce({ id: 2, email: 'bk@cfp.com' });
    church.findOne.mockResolvedValueOnce(null);
    expect(await resolveChurch({ email: 'bk@cfp.com' })).toBeNull();
  });

  it('prefers churchId over email when both are given', async () => {
    church.findOne.mockResolvedValue({ id: 7, ownerUserId: null });
    await resolveChurch({ churchId: 7, email: 'matt@cfp.com' });
    expect(users.findOne).not.toHaveBeenCalledWith({ where: { email: 'matt@cfp.com' } });
  });

  it('returns null when given nothing to resolve with', async () => {
    expect(await resolveChurch({})).toBeNull();
    expect(await resolveChurch({ churchId: '', email: '' })).toBeNull();
    expect(church.findOne).not.toHaveBeenCalled();
  });
});

describe('assertMembership', () => {
  it('returns the membership row', async () => {
    member.findOne.mockResolvedValue({ id: 9, churchId: 4, userId: 2, role: 'bookkeeper' });
    expect(await assertMembership(4, 2)).toMatchObject({ role: 'bookkeeper' });
    expect(member.findOne).toHaveBeenCalledWith({ where: { churchId: 4, userId: 2 } });
  });

  it('throws a 403-shaped error for a non-member', async () => {
    member.findOne.mockResolvedValue(null);
    await expect(assertMembership(4, 3)).rejects.toBeInstanceOf(NotAMemberError);
    await expect(assertMembership(4, 3)).rejects.toMatchObject({ status: 403 });
  });
});

describe('canConnectIntegrations', () => {
  it('lets owners always, and bookkeepers only when granted', () => {
    expect(canConnectIntegrations({ role: 'owner', integrationAccessEnabled: false })).toBe(true);
    expect(canConnectIntegrations({ role: 'bookkeeper', integrationAccessEnabled: true })).toBe(true);
    expect(canConnectIntegrations({ role: 'bookkeeper', integrationAccessEnabled: false })).toBe(false);
  });
});
