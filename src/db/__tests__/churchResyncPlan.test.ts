/**
 * Between the 2026-09-25 backfill and the church screens, invites, acceptances and the
 * Clients page only wrote the legacy `bookkeeper` table. These pin how the resync brings
 * ChurchMembers back in step with it.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { planResync, describePlan } = require('../churchResyncPlan');

const churches = [{ id: 100, ownerUserId: 10 }];
// Church 100 was added from the Clients page by user 2: its account's address is
// `<church-slug>-<user 2's own email>`.
const accounts = [{ id: 10, email: 'grace-bk@example.test' }];
const users = [{ id: 2, email: 'bk@example.test' }];
const nothing = { insert: [], accept: [], promote: [], dropMembers: [], unaccept: [], unmatched: [] };

it('adds a member for a bookkeeper row written after the backfill', () => {
  const plan = planResync(churches, [], [{ userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false }], accounts, users);
  expect(plan.insert).toEqual([expect.objectContaining({ churchId: 100, userId: 2, role: 'bookkeeper', inviteAccepted: true })]);
});

it('adds an invitation sent after the backfill as a member with only an invited email', () => {
  const plan = planResync(churches, [], [{ userId: null, clientId: 10, email: 'new@example.test', invitationToken: 'abc', inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false }], accounts, users);
  expect(plan.insert).toEqual([
    { churchId: 100, userId: null, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'new@example.test', invitationToken: 'abc', inviteAccepted: false },
  ]);
});

it('accepts a pending member whose legacy invite was accepted later', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'BK@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true }], accounts, users);
  expect(plan.accept).toEqual([{ id: 7, userId: 2 }]);
  expect(plan.insert).toEqual([]);
});

it('leaves a pending member alone while its legacy invite is still outstanding', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: null, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: false }], accounts, users);
  expect(plan).toEqual(nothing);
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
    users,
  );
  expect(plan).toEqual(nothing);
});

it('gives a resent invite written after the backfill one member, the accepted one, in either order', () => {
  const pending = { userId: null, clientId: 10, email: 'New@example.test', invitationToken: 'first', inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false };
  const accepted = { userId: 3, clientId: 10, email: 'new@example.test', invitationToken: 'resent', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false };
  const one = planResync(churches, [], [pending, accepted], accounts, users);
  const other = planResync(churches, [], [accepted, pending], accounts, users);
  expect(one.insert).toEqual([
    { churchId: 100, userId: 3, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'new@example.test', invitationToken: 'resent', inviteAccepted: true },
  ]);
  expect(other).toEqual(one);
});

it('accepts a member that has its user but was not yet accepted, once its legacy row is', () => {
  const members = [{ id: 7, churchId: 100, userId: 2, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: false }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', inviteAccepted: true }], accounts, users);
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
    users,
  );
  expect(plan.accept).toEqual([{ id: 7, userId: 2 }]);
  expect(plan.insert).toEqual([expect.objectContaining({ churchId: 100, userId: 3, inviteAccepted: true })]);
});

it('resets a member with no user that the backfill wrote as accepted', () => {
  // A legacy invite accepted before the invitee had a login: no user, so no access.
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'early@example.test', role: 'bookkeeper', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: null, clientId: 10, email: 'early@example.test', invitationToken: 't', inviteAccepted: true }], accounts, users);
  expect(plan).toEqual({ ...nothing, unaccept: [7] });
});

it('gives such a member its user rather than resetting it, once the legacy row has one', () => {
  const members = [{ id: 7, churchId: 100, userId: null, invitedEmail: 'early@example.test', role: 'bookkeeper', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 3, clientId: 10, email: 'early@example.test', invitationToken: 't', inviteAccepted: true }], accounts, users);
  expect(plan).toEqual({ ...nothing, accept: [{ id: 7, userId: 3 }] });
});

it('makes the bookkeeper who created a church its owner and drops the unused account membership', () => {
  const members = [
    { id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
    { id: 9, churchId: 100, userId: 2, invitedEmail: 'grace-bk@example.test', role: 'bookkeeper', inviteAccepted: true },
  ];
  // createClientChurch wrote the church's own synthetic email on the bookkeeper row.
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true }], accounts, users);
  expect(plan.promote).toEqual([9]);
  expect(plan.dropMembers).toEqual([8]);
  expect(plan.insert).toEqual([]);
});

it("promotes on staging's shape: bookkeeper 9 added client 10 from the Clients page", () => {
  const plan = planResync(
    [{ id: 6, ownerUserId: 10 }],
    [
      { id: 6, churchId: 6, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
      { id: 9, churchId: 6, userId: 9, invitedEmail: 'e2e-church-bk9@Example.test', role: 'bookkeeper', inviteAccepted: true },
    ],
    [{ userId: 9, clientId: 10, email: 'e2e-church-bk9@Example.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false }],
    [{ id: 10, email: 'e2e-church-bk9@example.test' }],
    [{ id: 9, email: 'BK9@example.test' }],
  );
  expect(plan).toEqual({ ...nothing, promote: [9], dropMembers: [6] });
});

it("never promotes a different user who merely has the account's address, nor drops the owner", () => {
  // Users.email is not unique: a second row carrying a real church login's address, attached
  // as that church's bookkeeper.
  const realChurch = [{ id: 1, ownerUserId: 1 }];
  const members = [{ id: 1, churchId: 1, userId: 1, invitedEmail: null, role: 'owner', inviteAccepted: true }];
  const row = { userId: 4, clientId: 1, email: 'matt@church.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false };
  const plan = planResync(realChurch, members, [row], [{ id: 1, email: 'matt@church.test' }], [{ id: 4, email: 'Matt@church.test' }]);
  expect(plan.promote).toEqual([]);
  expect(plan.dropMembers).toEqual([]);
  // It is still a bookkeeper row like any other - and listed, so someone can look at it.
  expect(plan.insert).toEqual([expect.objectContaining({ churchId: 1, userId: 4, role: 'bookkeeper' })]);
  expect(plan.unmatched).toEqual([{ churchId: 1, userId: 4 }]);
});

it("never promotes when the bookkeeper's own address is not the account address's suffix, or is unknown", () => {
  const members = [
    { id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
    { id: 9, churchId: 100, userId: 3, invitedEmail: 'grace-bk@example.test', role: 'bookkeeper', inviteAccepted: true },
  ];
  const row = { userId: 3, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true };
  for (const known of [[{ id: 3, email: 'someone-else@example.test' }], []]) {
    const plan = planResync(churches, members, [row], accounts, known);
    expect(plan).toEqual({ ...nothing, unmatched: [{ memberId: 9, churchId: 100, userId: 3 }] });
  }
});

it("lists, for fixing by hand, a creator whose own address changed after adding the church", () => {
  // User 2 added Grace as bk@example.test, so its account is grace-bk@example.test; they have
  // since changed their login's address. The owner can't be worked out, so nothing is promoted
  // or dropped - but the run says which church and user to look at.
  const members = [
    { id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
    { id: 9, churchId: 100, userId: 2, invitedEmail: 'grace-bk@example.test', role: 'bookkeeper', inviteAccepted: true },
  ];
  const row = { userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true };
  const plan = planResync(churches, members, [row], accounts, [{ id: 2, email: 'bea@new-domain.test' }]);

  expect(plan).toEqual({ ...nothing, unmatched: [{ memberId: 9, churchId: 100, userId: 2 }] });
  const lines = describePlan(plan, members);
  expect(lines).toEqual([
    'insert 0, accept 0, promote 0, drop 0, unaccept 0, unmatched 1',
    "unmatched: church 100, user 2, member 9 - a bookkeeper row with the church account's address whose user no longer matches it; set the owner by hand",
  ]);
  expect(lines.join('\n')).not.toContain('@');

  // Without a member yet: the row is planned as an ordinary bookkeeper, and still listed.
  const fresh = planResync(churches, [members[0]], [row], accounts, [{ id: 2, email: 'bea@new-domain.test' }]);
  expect(fresh.unmatched).toEqual([{ churchId: 100, userId: 2 }]);
  expect(describePlan(fresh, [members[0]])[1]).toBe(
    "unmatched: church 100, user 2, no member yet - a bookkeeper row with the church account's address whose user no longer matches it; set the owner by hand",
  );
});

it('inserts the creator as owner when the church has no member for them yet', () => {
  const members = [{ id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'Grace-BK@example.test', inviteAccepted: true }], accounts, users);
  expect(plan.insert).toEqual([
    { churchId: 100, userId: 2, role: 'owner', integrationAccessEnabled: true, invitedEmail: null, invitationToken: null, inviteAccepted: true },
  ]);
  expect(plan.dropMembers).toEqual([8]);
});

it('changes nothing once the creator owns the church', () => {
  const members = [{ id: 9, churchId: 100, userId: 2, invitedEmail: null, role: 'owner', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true }], accounts, users);
  expect(plan).toEqual(nothing);
});

it('changes nothing when already in step', () => {
  const members = [{ id: 9, churchId: 100, userId: 2, invitedEmail: 'bk@example.test', role: 'bookkeeper', inviteAccepted: true }];
  const plan = planResync(churches, members, [{ userId: 2, clientId: 10, email: 'bk@example.test', inviteAccepted: true }], accounts, users);
  expect(plan).toEqual(nothing);
});

it('ignores rows for an account no church is filed under', () => {
  const plan = planResync(churches, [], [{ userId: 2, clientId: 99, email: 'x@example.test', inviteAccepted: true }], accounts, users);
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
    users,
  );
  expect(plan).toEqual(nothing);
});

it('collapses duplicate rows for the same person on the same church', () => {
  const row = { userId: 2, clientId: 10, email: 'bk@example.test', invitationToken: 't', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false };
  const plan = planResync(churches, [], [row, { ...row, invitationToken: 'later' }], accounts, users);
  expect(plan.insert).toHaveLength(1);
});

it('describes a plan by counts and ids, never by address', () => {
  const members = [
    { id: 8, churchId: 100, userId: 10, invitedEmail: null, role: 'owner', inviteAccepted: true },
    { id: 9, churchId: 100, userId: 2, invitedEmail: 'grace-bk@example.test', role: 'bookkeeper', inviteAccepted: true },
  ];
  const plan = planResync(
    churches,
    members,
    [
      { userId: 2, clientId: 10, email: 'grace-bk@example.test', inviteAccepted: true },
      { userId: null, clientId: 10, email: 'new@example.test', invitationToken: 't', inviteAccepted: false },
    ],
    accounts,
    users,
  );
  const lines = describePlan(plan, members);
  expect(lines).toEqual([
    'insert 1, accept 0, promote 1, drop 1, unaccept 0, unmatched 0',
    'promote to owner: member 9 (church 100, user 2)',
    'drop: member 8 (church 100, user 10)',
  ]);
  expect(lines.join('\n')).not.toContain('@');
});
