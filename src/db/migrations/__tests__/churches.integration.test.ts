/**
 * The backfill migration against a real Postgres: rows that exist today become churches
 * and memberships, and every per-church row gets its churchId. Runs after the schema
 * migrations have been applied to the throwaway test database (see
 * jest.integration.config.js for the setup commands).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import sequelize from '../../index';
import User from '../../models/user';
import UserSettings from '../../models/userSettings';
import DailyJeSync from '../../models/DailyJeSync';
import bookkeeper from '../../models/bookkeeper';

const backfill = require('../20260925000003-backfill-churches');

const qi = sequelize.getQueryInterface();
const q = async (sql: string) => (await sequelize.query(sql))[0] as any[];

// Ids far from anything the other integration suites create.
const MATT = 9101;
const BK = 9102;
const OTHER = 9103;
const IDS = `${MATT}, ${BK}, ${OTHER}`;

const wipe = async () => {
  await backfill.down(qi);
  await DailyJeSync.destroy({ where: { userId: [MATT, BK, OTHER] } });
  await UserSettings.destroy({ where: { userId: [MATT, BK, OTHER] } });
  await bookkeeper.destroy({ where: { clientId: [MATT, OTHER] } });
  await User.destroy({ where: { id: [MATT, BK, OTHER] } });
};

const seed = async () => {
  const person = { firstName: 'N/A', lastName: 'N/A', isSubscribe: '0', isActive: true };
  await User.create({ ...person, id: MATT, email: 'matt-it@example.com', role: 'client', churchName: 'Active Church' } as any);
  await User.create({ ...person, id: BK, email: 'bk-it@example.com', role: 'bookkeeper', churchName: '' } as any);
  await User.create({ ...person, id: OTHER, email: 'other-it@example.com', role: 'client', churchName: '', isActive: false } as any);

  await bookkeeper.create({ userId: BK, clientId: MATT, email: 'bk-it@example.com', invitationToken: 'tok-accepted', inviteSent: true, inviteAccepted: true, bookkeeperIntegrationAccessEnabled: true } as any);
  await bookkeeper.create({ userId: null, clientId: MATT, email: 'pending-it@example.com', invitationToken: 'tok-pending', inviteSent: true, inviteAccepted: false, bookkeeperIntegrationAccessEnabled: false } as any);

  await UserSettings.create({ userId: MATT, isAutomationEnable: false, isAutomationRegistration: false } as any);
  await DailyJeSync.create({ userId: MATT, day: '2026-09-15', postedGrossCents: 92586, postedFeeCents: 2141, refundedGrossCents: 0, refundedFeeCents: 0, entryCount: 1, qboEntryIds: ['20963'] } as any);
  // A row keyed by the bookkeeper's own login: nobody's church, must stay null.
  await DailyJeSync.create({ userId: BK, day: '2026-09-15', postedGrossCents: 1, postedFeeCents: 0, refundedGrossCents: 0, refundedFeeCents: 0, entryCount: 1, qboEntryIds: ['1'] } as any);
};

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await wipe();
  await seed();
});

afterAll(async () => {
  await wipe();
  await sequelize.close();
});

const churchesOf = () => q(`SELECT id, name, "ownerUserId", "isActive" FROM "Churches" WHERE "ownerUserId" IN (${IDS}) ORDER BY "ownerUserId"`);
const membersOf = () =>
  q(`SELECT m."churchId", m."userId", m.role, m."integrationAccessEnabled", m."invitedEmail", m."invitationToken", m."inviteAccepted"
     FROM "ChurchMembers" m JOIN "Churches" c ON c.id = m."churchId"
     WHERE c."ownerUserId" IN (${IDS}) ORDER BY c."ownerUserId", m.role::text, m."userId" NULLS LAST`);

it('creates a church per client login with its owner, bookkeepers and pending invites, and stamps churchId', async () => {
  await backfill.up(qi);

  const churches = await churchesOf();
  expect(churches.map((c) => [c.ownerUserId, c.name, c.isActive])).toEqual([
    [MATT, 'Active Church', true],
    [OTHER, `Church #${OTHER}`, false],
  ]);
  const active = churches[0].id;

  const members = await membersOf();
  expect(members).toEqual([
    { churchId: active, userId: BK, role: 'bookkeeper', integrationAccessEnabled: true, invitedEmail: 'bk-it@example.com', invitationToken: 'tok-accepted', inviteAccepted: true },
    { churchId: active, userId: null, role: 'bookkeeper', integrationAccessEnabled: false, invitedEmail: 'pending-it@example.com', invitationToken: 'tok-pending', inviteAccepted: false },
    { churchId: active, userId: MATT, role: 'owner', integrationAccessEnabled: true, invitedEmail: null, invitationToken: null, inviteAccepted: true },
    { churchId: churches[1].id, userId: OTHER, role: 'owner', integrationAccessEnabled: true, invitedEmail: null, invitationToken: null, inviteAccepted: true },
  ]);

  const [settings] = await q(`SELECT "churchId" FROM "UserSettings" WHERE "userId" = ${MATT}`);
  expect(settings.churchId).toBe(active);
  const je = await q(`SELECT "userId", "churchId" FROM "DailyJeSync" WHERE "userId" IN (${IDS}) ORDER BY "userId"`);
  expect(je).toEqual([
    { userId: MATT, churchId: active },
    { userId: BK, churchId: null },
  ]);
});

it('is a no-op when run again', async () => {
  await backfill.up(qi);
  const before = { churches: await churchesOf(), members: await membersOf() };
  await backfill.up(qi);
  expect(await churchesOf()).toEqual(before.churches);
  expect(await membersOf()).toEqual(before.members);
});

it('down removes the churches and clears every churchId it stamped', async () => {
  await backfill.up(qi);
  await backfill.down(qi);
  expect(await churchesOf()).toEqual([]);
  const [settings] = await q(`SELECT "churchId" FROM "UserSettings" WHERE "userId" = ${MATT}`);
  expect(settings.churchId).toBeNull();
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM "DailyJeSync" WHERE "userId" IN (${IDS}) AND "churchId" IS NOT NULL`);
  expect(n).toBe(0);
});
