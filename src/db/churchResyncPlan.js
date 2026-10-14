'use strict';

/**
 * Brings ChurchMembers up to date with the legacy `bookkeeper` table, which is all that
 * invites, acceptances and the Clients page wrote between the 2026-09-25 backfill and the
 * church screens. Pure, like churchBackfillPlan.js.
 *
 * - A bookkeeper row with no member yet becomes one. One member per invited address: a
 *   resent invite is not a second invitation, and an accepted row wins over a pending one.
 * - A member still waiting on an invite whose legacy row was since accepted gets its user.
 * - A member with no user is never "accepted" (the backfill could write that): it is reset,
 *   so invite acceptance does not take it for done.
 * - A church added from the Clients page is owned by the bookkeeper who added it, and the
 *   membership of its account row - a login nobody uses - is DELETED. Such a church is
 *   recognised only by the address createClientChurch (and the browser Clients page before
 *   it) gave the account, `<church-slug>-<the bookkeeper's own email>`, written on that
 *   bookkeeper's row. Users.email is not unique, so an address match alone is not enough;
 *   anything else is treated as an ordinary bookkeeper row.
 *
 * - A row that carries the church account's own address but fails that check (say the creator
 *   has since changed their login's address) is handled as an ordinary bookkeeper row and listed
 *   in `unmatched`, so someone can set the owner by hand.
 *
 * That deletion is the only one: a legacy row deleted since the backfill leaves its member
 * in place. Running it again on its own result plans nothing (`unmatched` is a report, not a
 * change, and lists the same rows every run until they are fixed).
 *
 * @typedef {{ id: number, ownerUserId: number | null }} ChurchRow
 * @typedef {{ id: number, churchId: number, userId: number | null, invitedEmail?: string | null,
 *   role: 'owner' | 'bookkeeper', inviteAccepted: boolean }} MemberRow
 * @typedef {{ userId: number | null, clientId: number, email?: string | null,
 *   invitationToken?: string | null, inviteAccepted?: boolean | null,
 *   bookkeeperIntegrationAccessEnabled?: boolean | null }} BookkeeperRow
 * @typedef {{ id: number, email?: string | null }} UserRow
 */
const lower = (s) => (s || '').trim().toLowerCase();

/**
 * @param {ChurchRow[]} churches
 * @param {MemberRow[]} members
 * @param {BookkeeperRow[]} bookkeepers
 * @param {UserRow[]} accounts  the Users rows churches are filed under
 * @param {UserRow[]} bookkeeperUsers  the Users rows of every bookkeeper row's userId
 */
const planResync = (churches, members, bookkeepers, accounts, bookkeeperUsers = []) => {
  const churchIdByAccount = new Map(churches.filter((c) => c.ownerUserId != null).map((c) => [c.ownerUserId, c.id]));
  const accountEmail = new Map(accounts.map((a) => [a.id, lower(a.email)]));
  const ownEmail = new Map(bookkeeperUsers.map((u) => [u.id, lower(u.email)]));

  const byUser = new Map(); // `${churchId}:${userId}` -> member
  const pendingByEmail = new Map(); // `${churchId}:${email}` -> member with no user yet
  const invited = new Set(); // `${churchId}:${email}` of every member, existing or planned
  for (const m of members) {
    const email = lower(m.invitedEmail);
    if (email) invited.add(`${m.churchId}:${email}`);
    if (m.userId != null) byUser.set(`${m.churchId}:${m.userId}`, m);
    else if (email && !pendingByEmail.has(`${m.churchId}:${email}`)) pendingByEmail.set(`${m.churchId}:${email}`, m);
  }

  /** b added the church filed under its clientId from the Clients page. */
  const addedThisChurch = (b, email) => {
    const account = accountEmail.get(b.clientId);
    const own = ownEmail.get(b.userId);
    return !!account && !!own && email === account && account.length > own.length + 1 && account.endsWith(`-${own}`);
  };

  const plan = { insert: [], accept: [], promote: [], dropMembers: [], unaccept: [], unmatched: [] };
  const insert = (member) => {
    plan.insert.push(member);
    if (member.invitedEmail) invited.add(`${member.churchId}:${lower(member.invitedEmail)}`);
  };
  const seen = new Set();
  const claimed = new Set(); // pending members given a user by this plan
  // Rows with a user first, so an accepted row claims its address before a pending duplicate.
  const ordered = [...bookkeepers.filter((b) => b.userId != null), ...bookkeepers.filter((b) => b.userId == null)];
  for (const b of ordered) {
    const churchId = churchIdByAccount.get(b.clientId);
    if (churchId == null) continue;
    if (b.userId != null && b.userId === b.clientId) continue;
    const email = lower(b.email);
    if (b.userId == null && !email) continue;
    const key = b.userId != null ? `${churchId}:user:${b.userId}` : `${churchId}:invite:${email}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (b.userId == null) {
      // Still outstanding.
      if (invited.has(`${churchId}:${email}`)) continue;
      insert({
        churchId,
        userId: null,
        role: 'bookkeeper',
        integrationAccessEnabled: !!b.bookkeeperIntegrationAccessEnabled,
        invitedEmail: b.email,
        invitationToken: b.invitationToken || null,
        inviteAccepted: false,
      });
      continue;
    }

    const member = byUser.get(`${churchId}:${b.userId}`);
    if (addedThisChurch(b, email)) {
      if (member && member.role !== 'owner') plan.promote.push(member.id);
      if (!member) {
        insert({
          churchId,
          userId: b.userId,
          role: 'owner',
          integrationAccessEnabled: true,
          invitedEmail: null,
          invitationToken: null,
          inviteAccepted: true,
        });
      }
      const accountMember = byUser.get(`${churchId}:${b.clientId}`);
      if (accountMember && !plan.dropMembers.includes(accountMember.id)) plan.dropMembers.push(accountMember.id);
      continue;
    }
    if (email && email === accountEmail.get(b.clientId)) {
      plan.unmatched.push({ ...(member ? { memberId: member.id } : {}), churchId, userId: b.userId });
    }

    if (member) {
      if (!member.inviteAccepted && b.inviteAccepted) plan.accept.push({ id: member.id, userId: b.userId });
      continue;
    }
    const pending = pendingByEmail.get(`${churchId}:${email}`);
    if (pending && !claimed.has(pending.id)) {
      if (b.inviteAccepted) {
        plan.accept.push({ id: pending.id, userId: b.userId });
        claimed.add(pending.id);
      }
      continue;
    }
    insert({
      churchId,
      userId: b.userId,
      role: 'bookkeeper',
      integrationAccessEnabled: !!b.bookkeeperIntegrationAccessEnabled,
      invitedEmail: b.email || null,
      invitationToken: b.invitationToken || null,
      inviteAccepted: !!b.inviteAccepted,
    });
  }

  for (const m of members) {
    if (m.userId == null && m.inviteAccepted && !claimed.has(m.id)) plan.unaccept.push(m.id);
  }
  return plan;
};

/**
 * What a plan will do, for the migration log. Ids only, never addresses: this lands in
 * terminal output that gets pasted around.
 *
 * @param {ReturnType<typeof planResync>} plan
 * @param {MemberRow[]} members
 */
const describePlan = (plan, members) => {
  const byId = new Map(members.map((m) => [m.id, m]));
  const who = (id) => {
    const m = byId.get(id);
    return m ? `member ${id} (church ${m.churchId}, user ${m.userId == null ? 'none' : m.userId})` : `member ${id}`;
  };
  const lines = [
    `insert ${plan.insert.length}, accept ${plan.accept.length}, promote ${plan.promote.length}, ` +
      `drop ${plan.dropMembers.length}, unaccept ${plan.unaccept.length}, unmatched ${plan.unmatched.length}`,
  ];
  for (const id of plan.promote) lines.push(`promote to owner: ${who(id)}`);
  for (const id of plan.dropMembers) lines.push(`drop: ${who(id)}`);
  for (const u of plan.unmatched) {
    lines.push(
      `unmatched: church ${u.churchId}, user ${u.userId}, ${u.memberId != null ? `member ${u.memberId}` : 'no member yet'}` +
        " - a bookkeeper row with the church account's address whose user no longer matches it; set the owner by hand",
    );
  }
  return lines;
};

module.exports = { planResync, describePlan };
