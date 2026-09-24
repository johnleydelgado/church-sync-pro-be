'use strict';

/**
 * Turns today's rows into churches and memberships. Pure: rows in, rows out, no database,
 * so the rules can be unit-tested and the migration stays a thin wrapper.
 *
 * - One church per client login, named from its churchName.
 * - The login itself becomes the church's owner member.
 * - Every `bookkeeper` row becomes a bookkeeper member of that client's church. Rows for
 *   a client login that no longer exists are dropped; a login attached to itself is a
 *   data quirk, not a membership. Outstanding invitations (no userId yet) are kept as
 *   members with only an invited email, so the invite link keeps working.
 *
 * Plain JS rather than TS because sequelize-cli loads migrations without ts-node, and
 * this module is required from one.
 *
 * @typedef {{ id: number, churchName?: string | null, isActive?: boolean | null }} ClientRow
 * @typedef {{ userId: number | null, clientId: number, email?: string | null,
 *   invitationToken?: string | null, inviteAccepted?: boolean | null,
 *   bookkeeperIntegrationAccessEnabled?: boolean | null }} BookkeeperRow
 */

/**
 * @param {ClientRow[]} clients
 * @param {BookkeeperRow[]} bookkeepers
 */
const planBackfill = (clients, bookkeepers) => {
  const churches = clients.map((c) => ({
    ownerUserId: c.id,
    name: (c.churchName || '').trim() || `Church #${c.id}`,
    isActive: c.isActive !== false,
  }));

  const owners = clients.map((c) => ({
    ownerUserId: c.id,
    userId: c.id,
    role: 'owner',
    integrationAccessEnabled: true,
    invitedEmail: null,
    invitationToken: null,
    inviteAccepted: true,
  }));

  const clientIds = new Set(clients.map((c) => c.id));
  const seen = new Set();
  const bks = [];
  for (const b of bookkeepers) {
    if (!clientIds.has(b.clientId)) continue;
    if (b.userId != null && b.userId === b.clientId) continue;
    const key =
      b.userId != null ? `${b.clientId}:user:${b.userId}` : `${b.clientId}:invite:${(b.email || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bks.push({
      ownerUserId: b.clientId,
      userId: b.userId == null ? null : b.userId,
      role: 'bookkeeper',
      integrationAccessEnabled: !!b.bookkeeperIntegrationAccessEnabled,
      invitedEmail: b.email || null,
      invitationToken: b.invitationToken || null,
      inviteAccepted: !!b.inviteAccepted,
    });
  }

  return { churches, members: [...owners, ...bks] };
};

module.exports = { planBackfill };
