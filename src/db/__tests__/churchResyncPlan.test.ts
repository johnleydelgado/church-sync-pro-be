/**
 * Between the 2026-09-25 backfill and the church screens, invites, acceptances and the
 * Clients page only wrote the legacy `bookkeeper` table. These pin how the resync brings
 * ChurchMembers back in step with it.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { planResync } = require('../churchResyncPlan');

const churches = [{ id: 100, ownerUserId: 10 }];
const accounts = [{ id: 10, email: 'grace-bk@example.test' }];

it('adds a member for a bookkeeper row written after the backfill', () => {
  const plan = planResync(churches, [], [{ userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false }], accounts);
  expect(plan.insert).toEqual([expect.objectContaining({ churchId: 100, userId: 2, role: 'bookkeeper', inviteAccepted: true })]);
});

it('adds an invitation sent after the backfill as a member with only an invited email', () => {
  const plan = planResync(churches, [], [{ userId: null, clientId: 10, email: 'new@example.test', invitationToken: 'abc', inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false }], accounts);
  expect(plan.insert).toEqual([
    { churchId: 100, userId: null, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'new@example.test', invitationToken: 'abc', inviteAccepted: false },
  ]);
});

it('accepts a pending member whose legacy invite was accepted later', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'BK@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true }], accounts);
  expect(plan.accept).toEqual([{ id: 7, userId: 2 }]);
  expect(plan.insert).toEqual([]);
});

it('leaves a pending member alone while its legacy invite is still outstanding', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: null, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: false }], accounts);
  expect(plan).toEqual({ insert: [], accept: [], promote: [], dropMembers: [] });
});

it('does not re-invite an address whose member was accepted, when a resent invite to it is still outstanding', () => {
  // A resent invite leaves two legacy rows for one address. After the first run accepted the
  // member through one of them, the other must not create a fresh pending member next run.
  const members = [{ id: 7, churchId: 100, userId: 2, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: true }];
  const plan = planResync(
    churches,
    members,
    [
      { userId: null, clientId: 10, email: 'bk@example.test', invitationToken: 'first', inviteAccepted: false },
      { userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 'resent', inviteAccepted: true },
    ],
    accounts,
  );
  expect(plan).toEqual({ insert: [], accept: [], promote: [], dropMembers: [] });
});

it('accepts a member that has its user but was not yet accepted, once its legacy row is', () => {
  const members = [{ id: 7, churchId: 100, userId: 2, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', inviteAccepted: true }], accounts);
  expect(plan.accept).toEqual([{ id: 7, userId: 2 }]);
});

it('gives one pending member to one person only', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'shared@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(
    churches,
    members,
    [
      { userId: 2, clientId: 10, email: 'shared@example.test', invitationToken: 'a', inviteAccepted: true },
      { userId: 3, clientId: 10, email: 'shared@example.test', invitationToken: 'b', inviteAccepted: true },
    ],
    accounts,
  );
  expect(plan.accept).toEqual([{ id: 7, userId: 2 }]);
  expect(plan.insert).toEqual([expect.objectContaining({ churchId: 100, userId: 3, inviteAccepted: true })]);
});

it('makes the bookkeeper who created a church its owner and drops the unused account membership', () => {
  const members = [
    { id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
    { id: 9, churchId: 100, userId: 2, invitedEmail: 'grace-bk@example.test', role: 'bookkeeper', inviteAccepted: true },
  ];
  // createClientChurch wrote the church's own synthetic email on the bookkeeper row.
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true }], accounts);
  expect(plan.promote).toEqual([9]);
  expect(plan.dropMembers).toEqual([8]);
  expect(plan.insert).toEqual([]);
});

it('inserts the creator as owner when the church has no member for them yet', () => {
  const members = [{ id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'Grace-BK@example.test', inviteAccepted: true }], accounts);
  expect(plan.insert).toEqual([
    { churchId: 100, userId: 2, role: 'owner', integrationAccessEnabled: true, invitedEmail: null, invitationToken: null, inviteAccepted: true },
  ]);
  expect(plan.dropMembers).toEqual([8]);
});

it('changes nothing once the creator owns the church', () => {
  const members = [{ id: 9, churchId: 100, userId: 2, invitedEmail: null, role: 'owner', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true }], accounts);
  expect(plan).toEqual({ insert: [], accept: [], promote: [], dropMembers: [] });
});

it('changes nothing when already in step', () => {
  const members = [{ id: 9, churchId: 100, userId: 2, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', inviteAccepted: true }], accounts);
  expect(plan).toEqual({ insert: [], accept: [], promote: [], dropMembers: [] });
});

it('ignores rows for an account no church is filed under', () => {
  const plan = planResync(churches, [], [{ userId: 2, clientId: 99, email: 'x@example.test', inviteAccepted: true }], accounts);
  expect(plan.insert).toEqual([]);
});

it('ignores a login attached to itself, and an invitation with neither a user nor an address', () => {
  const plan = planResync(
    churches,
    [],
    [
      { userId: 10, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true },
      { userId: null, clientId: 10, email: '  ', invitationToken: 't', inviteAccepted: false },
    ],
    accounts,
  );
  expect(plan).toEqual({ insert: [], accept: [], promote: [], dropMembers: [] });
});

it('collapses duplicate rows for the same person on the same church', () => {
  const row = { userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false };
  const plan = planResync(churches, [], [row, { ...row, invitationToken: 'later' }], accounts);
  expect(plan.insert).toHaveLength(1);
});
