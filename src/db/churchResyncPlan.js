'use strict';

/**
 * Brings ChurchMembers up to date with the legacy `bookkeeper` table, which is all that
 * invites, acceptances and the Clients page wrote between the 2026-09-25 backfill and the
 * church screens. Pure, like churchBackfillPlan.js.
 *
 * - A bookkeeper row with no member yet becomes one.
 * - A member still waiting on an invite whose legacy row was since accepted gets its user.
 * - A church added from the Clients page (createClientChurch wrote the church's own email on
 *   the bookkeeper row) is owned by the bookkeeper who added it; the membership of its
 *   account row - a login nobody uses - is dropped.
 *
 * It only adds and corrects: a legacy row deleted since the backfill leaves its member in
 * place. Running it again on its own result plans nothing.
 *
 * @typedef {{ id: number, ownerUserId: number | null }} ChurchRow
 * @typedef {{ id: number, churchId: number, userId: number | null, invitedEmail?: string | null,
 *   role: 'owner' | 'bookkeeper', inviteAccepted: boolean }} MemberRow
 * @typedef {{ userId: number | null, clientId: number, email?: string | null,
 *   invitationToken?: string | null, inviteAccepted?: boolean | null,
 *   bookkeeperIntegrationAccessEnabled?: boolean | null }} BookkeeperRow
 * @typedef {{ id: number, email?: string | null }} AccountRow  the Users row a church is filed under
 */
const lower = (s) => (s || '').trim().toLowerCase();

/**
 * @param {ChurchRow[]} churches
 * @param {MemberRow[]} members
 * @param {BookkeeperRow[]} bookkeepers
 * @param {AccountRow[]} accounts
 */
const planResync = (churches, members, bookkeepers, accounts) => {
  const churchIdByAccount = new Map(churches.filter((c) => c.ownerUserId != null).map((c) => [c.ownerUserId, c.id]));
  const accountEmail = new Map(accounts.map((a) => [a.id, lower(a.email)]));

  const byUser = new Map(); // `${churchId}:${userId}` -> member
  const pendingByEmail = new Map(); // `${churchId}:${email}` -> member with no user yet
  const invited = new Set(); // `${churchId}:${email}` of every member, pending or accepted
  for (const m of members) {
    const email = lower(m.invitedEmail);
    if (email) invited.add(`${m.churchId}:${email}`);
    if (m.userId != null) byUser.set(`${m.churchId}:${m.userId}`, m);
    else if (email && !pendingByEmail.has(`${m.churchId}:${email}`)) pendingByEmail.set(`${m.churchId}:${email}`, m);
  }

  const plan = { insert: [], accept: [], promote: [], dropMembers: [] };
  const seen = new Set();
  const claimed = new Set(); // pending members already given a user by this plan
  for (const b of bookkeepers) {
    const churchId = churchIdByAccount.get(b.clientId);
    if (churchId == null) continue;
    if (b.userId != null && b.userId === b.clientId) continue;
    const email = lower(b.email);
    if (b.userId == null && !email) continue;
    const key = b.userId != null ? `${churchId}:user:${b.userId}` : `${churchId}:invite:${email}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (b.userId == null) {
      // Still outstanding. One member per invited address: a resent invite, or one whose
      // member was since accepted, is not a new invitation.
      if (invited.has(`${churchId}:${email}`)) continue;
      plan.insert.push({
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
    if (email !== '' && email === accountEmail.get(b.clientId)) {
      // The bookkeeper added this church from the Clients page.
      if (member && member.role !== 'owner') plan.promote.push(member.id);
      if (!member) {
        plan.insert.push({
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
    plan.insert.push({
      churchId,
      userId: b.userId,
      role: 'bookkeeper',
      integrationAccessEnabled: !!b.bookkeeperIntegrationAccessEnabled,
      invitedEmail: b.email || null,
      invitationToken: b.invitationToken || null,
      inviteAccepted: !!b.inviteAccepted,
    });
  }
  return plan;
};

module.exports = { planResync };
