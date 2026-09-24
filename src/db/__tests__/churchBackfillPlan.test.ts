/**
 * The backfill decides, once, which church every existing row belongs to. These pin the
 * rules on the shapes production actually has (2026-09-25): one client login per church,
 * accepted bookkeepers, and outstanding invitations with no user yet.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { planBackfill } = require('../churchBackfillPlan');

const matt = { id: 1, churchName: 'Active Church', isActive: true };
const other = { id: 7, churchName: '  ', isActive: false };

it('makes one church per client login, an owner membership for it, and a bookkeeper membership per row', () => {
  const plan = planBackfill(
    [matt, other],
    [{ userId: 2, clientId: 1, email: 'bk@cfp.com', invitationToken: 't1', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: true }],
  );
  expect(plan.churches).toEqual([
    { ownerUserId: 1, name: 'Active Church', isActive: true },
    { ownerUserId: 7, name: 'Church #7', isActive: false },
  ]);
  expect(plan.members).toHaveLength(3);
  expect(plan.members[0]).toMatchObject({ ownerUserId: 1, userId: 1, role: 'owner', integrationAccessEnabled: true, inviteAccepted: true });
  expect(plan.members[2]).toEqual({
    ownerUserId: 1,
    userId: 2,
    role: 'bookkeeper',
    integrationAccessEnabled: true,
    invitedEmail: 'bk@cfp.com',
    invitationToken: 't1',
    inviteAccepted: true,
  });
});

it('keeps an outstanding invitation as a member with no user, so the invite link still resolves', () => {
  const plan = planBackfill([matt], [{ userId: null, clientId: 1, email: 'new@cfp.com', invitationToken: 'abc', inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false }]);
  expect(plan.members[1]).toEqual({
    ownerUserId: 1,
    userId: null,
    role: 'bookkeeper',
    integrationAccessEnabled: false,
    invitedEmail: 'new@cfp.com',
    invitationToken: 'abc',
    inviteAccepted: false,
  });
});

it('drops rows for a client login that no longer exists, and a login attached to itself', () => {
  const plan = planBackfill(
    [matt],
    [
      { userId: 2, clientId: 99, email: 'orphan@x.com', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false },
      { userId: 1, clientId: 1, email: 'matt@x.com', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false },
    ],
  );
  expect(plan.members).toHaveLength(1);
  expect(plan.members[0].role).toBe('owner');
});

it('collapses duplicate rows for the same person on the same church', () => {
  const row = { userId: 2, clientId: 1, email: 'bk@cfp.com', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false };
  const invite = { userId: null, clientId: 1, email: 'Pending@cfp.com', invitationToken: 'a', inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false };
  const plan = planBackfill([matt], [row, { ...row, invitationToken: 'later' }, invite, { ...invite, email: 'pending@cfp.com' }]);
  expect(plan.members.filter((m: any) => m.role === 'bookkeeper')).toHaveLength(2);
});

it('treats a missing isActive as active and a missing churchName as a placeholder', () => {
  const plan = planBackfill([{ id: 3 }], []);
  expect(plan.churches[0]).toEqual({ ownerUserId: 3, name: 'Church #3', isActive: true });
});
