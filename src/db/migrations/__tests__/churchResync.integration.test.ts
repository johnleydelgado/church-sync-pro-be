/**
 * The resync migration against a real Postgres. After the 2026-09-25 backfill only the legacy
 * `bookkeeper` table was written (invites, acceptances, Clients-page churches); this checks
 * ChurchMembers is brought back in step and that one account row owns at most one church.
 * Runs after the schema migrations have been applied to the throwaway test database (see
 * jest.integration.config.js for the setup commands).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import sequelize from '../../index';
import User from '../../models/user';
import bookkeeper from '../../models/bookkeeper';

const backfill = require('../20260925000003-backfill-churches');
const resync = require('../20261015000001-resync-church-members');

const qi = sequelize.getQueryInterface();
const q = async (sql: string) => (await sequelize.query(sql))[0] as any[];

// Ids far from anything the other integration suites create.
const ACTIVE = 9201; // a church's own login, backfilled
const BK_LATE = 9202; // given access after the backfill
const BK_INVITED = 9203; // invited before the backfill, accepted after it
const BK_CREATOR = 9204; // adds churches from the Clients page
const GRACE = 9205; // Clients-page church that existed at the backfill
const LATE_CLIENT = 9206; // client login that signed up after the backfill
const LATE_CC = 9207; // Clients-page church added after the backfill
const USERS = [ACTIVE, BK_LATE, BK_INVITED, BK_CREATOR, GRACE, LATE_CLIENT, LATE_CC];
const IDS = USERS.join(', ');

// createClientChurch's synthetic address: `<church-name>-<bookkeeper's email>`.
const GRACE_EMAIL = 'grace-creator-it@example.test';
const LATE_CC_EMAIL = 'late-cc-creator-it@example.test';

const person = { firstName: 'N/A', lastName: 'N/A', isSubscribe: '0', isActive: true };
const legacy = { inviteSent: true, bookkeeperIntegrationAccessEnabled: false };

const wipe = async () => {
  await resync.down(qi);
  await backfill.down(qi);
  await bookkeeper.destroy({ where: { clientId: USERS } });
  await User.destroy({ where: { id: USERS } });
};

/** What existed when the backfill ran on 2026-09-25. */
const seedAtBackfill = async () => {
  await User.create({ ...person, id: ACTIVE, email: 'active-it@example.test', role: 'client', churchName: 'Active Church' } as any);
  await User.create({ ...person, id: BK_LATE, email: 'bk-late-it@example.test', role: 'bookkeeper', churchName: '' } as any);
  await User.create({ ...person, id: BK_INVITED, email: 'bk-invited-it@example.test', role: 'bookkeeper', churchName: '' } as any);
  await User.create({ ...person, id: BK_CREATOR, email: 'creator-it@example.test', role: 'bookkeeper', churchName: '' } as any);
  await User.create({ ...person, id: GRACE, email: GRACE_EMAIL, role: 'client', churchName: 'Grace' } as any);

  await bookkeeper.create({ ...legacy, userId: null, clientId: ACTIVE, email: 'bk-invited-it@example.test', invitationToken: 'tok-invited', inviteAccepted: false } as any);
  await bookkeeper.create({ ...legacy, userId: null, clientId: ACTIVE, email: 'still-pending-it@example.test', invitationToken: 'tok-pending', inviteAccepted: false } as any);
  await bookkeeper.create({ ...legacy, userId: BK_CREATOR, clientId: GRACE, email: GRACE_EMAIL, invitationToken: 'tok-grace', inviteAccepted: true } as any);
};

/** What only the legacy table recorded after it. */
const writeSinceBackfill = async () => {
  await bookkeeper.create({ ...legacy, userId: BK_LATE, clientId: ACTIVE, email: 'bk-late-it@example.test', invitationToken: 'tok-late', inviteAccepted: true, bookkeeperIntegrationAccessEnabled: true } as any);
  // updateInvitationStatus: the invitee followed the link.
  await bookkeeper.update({ userId: BK_INVITED, inviteAccepted: true } as any, { where: { invitationToken: 'tok-invited' } });
  await User.create({ ...person, id: LATE_CLIENT, email: 'late-client-it@example.test', role: 'client', churchName: 'Late Church' } as any);
  // createClientChurch: a client login nobody signs in with, and a bookkeeper row carrying its email.
  await User.create({ ...person, id: LATE_CC, email: LATE_CC_EMAIL, role: 'client', churchName: 'Late Clients-page Church' } as any);
  await bookkeeper.create({ ...legacy, userId: BK_CREATOR, clientId: LATE_CC, email: LATE_CC_EMAIL, invitationToken: 'tok-late-cc', inviteAccepted: true } as any);
};

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await wipe();
  await seedAtBackfill();
  await backfill.up(qi);
  await writeSinceBackfill();
});

afterAll(async () => {
  await wipe();
  // Leave the schema as the migrations left it, for whichever suite runs next.
  await resync.addOwnerIndex(qi);
  await sequelize.close();
});

const churchesOf = () => q(`SELECT "ownerUserId", name FROM "Churches" WHERE "ownerUserId" IN (${IDS}) ORDER BY "ownerUserId"`);
const membersOf = () =>
  q(`SELECT c."ownerUserId" AS account, m."userId", m.role, m."integrationAccessEnabled", m."invitedEmail", m."invitationToken", m."inviteAccepted"
     FROM "ChurchMembers" m JOIN "Churches" c ON c.id = m."churchId"
     WHERE c."ownerUserId" IN (${IDS}) ORDER BY c."ownerUserId", m.role::text, m."userId" NULLS LAST`);
const everything = async () => ({
  churches: await q(`SELECT * FROM "Churches" ORDER BY id`),
  members: await q(`SELECT * FROM "ChurchMembers" ORDER BY id`),
});
const ownerIndex = async () =>
  (await q(`SELECT indexdef FROM pg_indexes WHERE tablename = 'Churches' AND indexname = '${resync.OWNER_INDEX}'`))[0]?.indexdef ?? null;
const addChurch = (name: string, owner: number | null) =>
  q(`INSERT INTO "Churches" (name, "ownerUserId", "isActive", "createdAt", "updatedAt") VALUES ('${name}', ${owner ?? 'NULL'}, true, now(), now())`);

const owner = (account: number, userId: number) => ({
  account,
  userId,
  role: 'owner',
  integrationAccessEnabled: true,
  invitedEmail: null,
  invitationToken: null,
  inviteAccepted: true,
});

it('catches memberships up with the bookkeeper table and gives each new church its owner', async () => {
  await resync.up(qi);

  expect(await churchesOf()).toEqual([
    { ownerUserId: ACTIVE, name: 'Active Church' },
    { ownerUserId: GRACE, name: 'Grace' },
    { ownerUserId: LATE_CLIENT, name: 'Late Church' },
    { ownerUserId: LATE_CC, name: 'Late Clients-page Church' },
  ]);
  expect(await membersOf()).toEqual([
    // Given access after the backfill: inserted, with its integration flag.
    { account: ACTIVE, userId: BK_LATE, role: 'bookkeeper', integrationAccessEnabled: true, invitedEmail: 'bk-late-it@example.test', invitationToken: 'tok-late', inviteAccepted: true },
    // Pending at the backfill, accepted since: the same member now has its user.
    { account: ACTIVE, userId: BK_INVITED, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'bk-invited-it@example.test', invitationToken: 'tok-invited', inviteAccepted: true },
    // Still outstanding: unchanged, not duplicated.
    { account: ACTIVE, userId: null, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'still-pending-it@example.test', invitationToken: 'tok-pending', inviteAccepted: false },
    owner(ACTIVE, ACTIVE),
    // Clients-page churches: the bookkeeper who added each one owns it; the account row has no membership.
    owner(GRACE, BK_CREATOR),
    owner(LATE_CLIENT, LATE_CLIENT),
    owner(LATE_CC, BK_CREATOR),
  ]);
  expect(await ownerIndex()).toMatch(/^CREATE UNIQUE INDEX .*\("ownerUserId"\) WHERE \("ownerUserId" IS NOT NULL\)$/);
});

it('changes nothing when run again', async () => {
  await resync.up(qi);
  const before = await everything();
  await resync.up(qi);
  expect(await everything()).toEqual(before);
  expect(await ownerIndex()).not.toBeNull();
});

it('refuses a second church on the same account row, but allows any number with none', async () => {
  await resync.up(qi);
  const err: any = await addChurch('Second', ACTIVE).catch((e) => e);
  expect(err?.original?.constraint).toBe(resync.OWNER_INDEX);

  await addChurch('Unowned A', null);
  await addChurch('Unowned B', null);
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM "Churches" WHERE name LIKE 'Unowned %'`);
  expect(n).toBe(2);
});

it('refuses to run, and writes nothing, while an account owns two churches', async () => {
  await addChurch('Duplicate', ACTIVE);
  const before = await everything();

  await expect(resync.up(qi)).rejects.toThrow(`Accounts owning more than one church: ${ACTIVE}`);

  // Refused before the backfill step too: the late sign-ups still have no church.
  expect(await everything()).toEqual(before);
  expect((await churchesOf()).map((c) => c.ownerUserId)).toEqual([ACTIVE, ACTIVE, GRACE]);
  expect(await ownerIndex()).toBeNull();
});

it('down drops the index and keeps the membership corrections', async () => {
  await resync.up(qi);
  const members = await membersOf();
  await resync.down(qi);
  expect(await ownerIndex()).toBeNull();
  expect(await membersOf()).toEqual(members);
});
