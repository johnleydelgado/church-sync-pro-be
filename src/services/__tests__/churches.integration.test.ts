/**
 * The church service against a real Postgres: the Churches page (list, add, rename, deactivate)
 * and the People tab (list, invite with a copyable link, integration access, remove). SendGrid is
 * faked; the invite link is built for real, because the owner copies it when email fails.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../inviteEmail', () => ({ ...jest.requireActual('../inviteEmail'), sendInviteEmail: jest.fn() }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, createLogger: () => log, default: () => log };
});

import { Op, QueryTypes, UniqueConstraintError } from 'sequelize';
import sequelize from '../../db';
import User from '../../db/models/user';
import Church from '../../db/models/church';
import ChurchMember from '../../db/models/churchMember';
import bookkeeper from '../../db/models/bookkeeper';
import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import { checkAccountAccess, ChurchNeed } from '../churchAccess';
import { sendInviteEmail, inviteLinkFor } from '../inviteEmail';
import { createLogger } from '../../utils/logger';
import {
  createChurch,
  invitePerson,
  listMyChurches,
  listPeople,
  removePerson,
  setIntegrationAccess,
  updateChurch,
} from '../churches';

const mailer = sendInviteEmail as jest.Mock;
const log = createLogger('test') as any;

// Ids far from anything the other integration suites create.
const CLIENT = 9301; // a client login that signed up and owns no church yet
const BK = 9302; // a bookkeeper who adds churches from the Churches page
const EXISTING = 9303; // a bookkeeper who already has a login when invited
const BK_ONLY = 9304; // a bookkeeper login on no church at all
const OTHER_CLIENT = 9305; // someone else's church, to check removals stay scoped
const DUP_LOWER = 9306; // two logins whose addresses differ only in case (Users.email is not unique) ...
const DUP_EXACT = 9307; // ... the second one, spelled the way the owner types it
const LEGACY_ACCOUNT = 9308; // a Clients-page church's account row: a real-looking address nobody signs in with
const PEOPLE = [CLIENT, BK, EXISTING, BK_ONLY, OTHER_CLIENT, DUP_LOWER, DUP_EXACT, LEGACY_ACCOUNT];

const ACCOUNT_EMAIL = /^church-[0-9a-f]{16}@accounts\.churchsyncpro\.invalid$/;
const TEST_INVITATION_URL = 'https://csp.example.test/auth/invite';
let savedInvitationUrl: string | undefined;

const person = { isSubscribe: '0', isActive: true };

/** Everything this suite may have written, found from its people, so other suites' rows are left alone. */
const wipe = async () => {
  const churches: any[] = await sequelize.query(
    `SELECT DISTINCT c.id, c."ownerUserId" FROM "Churches" c LEFT JOIN "ChurchMembers" m ON m."churchId" = c.id
     WHERE c."ownerUserId" IN (:people) OR m."userId" IN (:people)`,
    { replacements: { people: PEOPLE }, type: QueryTypes.SELECT },
  );
  const accountIds = churches.map((c) => c.ownerUserId).filter((id) => id && !PEOPLE.includes(id));
  const accounts: any[] = accountIds.length
    ? await User.findAll({ where: { id: accountIds, email: { [Op.like]: '%@accounts.churchsyncpro.invalid' } } })
    : [];
  const allAccountIds = [...PEOPLE, ...accounts.map((a) => a.id)];
  const emails = (await User.findAll({ where: { id: allAccountIds } })).map((u: any) => u.email);
  if (emails.length) await tokenEntity.destroy({ where: { email: emails } });
  await bookkeeper.destroy({ where: { clientId: allAccountIds } });
  await bookkeeper.destroy({ where: { userId: PEOPLE } });
  if (churches.length) await Church.destroy({ where: { id: churches.map((c) => c.id) } });
  await User.destroy({ where: { id: allAccountIds } });
};

const login = (id: number, email: string, role: 'client' | 'bookkeeper', extra: any = {}) =>
  User.create({ ...person, id, email, role, churchName: '', firstName: 'N/A', lastName: 'N/A', ...extra } as any);

const seed = async () => {
  await login(CLIENT, 'client-ch-it@example.test', 'client', {
    churchName: ' Hope Chapel ',
    firstName: 'Hope',
    lastName: 'Admin',
  });
  await login(BK, 'bk-ch-it@example.test', 'bookkeeper', { firstName: 'Bea', lastName: 'Keeper' });
  await login(EXISTING, 'Existing-CH-it@example.test', 'bookkeeper', { firstName: 'Ed' });
  await login(BK_ONLY, 'bk-only-ch-it@example.test', 'bookkeeper');
  await login(OTHER_CLIENT, 'other-ch-it@example.test', 'client', { churchName: 'Other' });
  await login(DUP_LOWER, 'dup-ch-it@example.test', 'bookkeeper');
  await login(DUP_EXACT, 'Dup-CH-it@example.test', 'bookkeeper');
  await login(LEGACY_ACCOUNT, 'legacy-cc-it@example.test', 'client', { churchName: 'Legacy CC' });
};

const user = async (id: number): Promise<any> => User.findOne({ where: { id } });
const accountOf = async (churchId: number): Promise<any> => {
  const church: any = await Church.findOne({ where: { id: churchId } });
  return User.findOne({ where: { id: church.ownerUserId } });
};
/** What the /church routes hand the service once requireChurch has let the caller through. */
const accessAs = async (actorId: number, churchId: number, need: ChurchNeed = 'owner') =>
  checkAccountAccess(await user(actorId), await accountOf(churchId), need);
const graceFor = async (actorId = BK) => (await createChurch(await user(actorId), 'Grace')).id;
const memberRow = async (churchId: number, userId: number): Promise<any> =>
  ChurchMember.findOne({ where: { churchId, userId } });
const addOwner = (churchId: number, userId: number) =>
  ChurchMember.create({
    churchId,
    userId,
    role: 'owner',
    integrationAccessEnabled: true,
    invitedEmail: null,
    invitationToken: null,
    inviteAccepted: true,
  });
const ownersOf = (churchId: number) => ChurchMember.count({ where: { churchId, role: 'owner' } });

/** Answers null the next `times` calls, as if another request had not committed yet. */
const spies: jest.SpyInstance[] = [];
const nullOnce = (model: any, times = 1) => {
  const spy = jest.spyOn(model, 'findOne');
  for (let i = 0; i < times; i++) spy.mockResolvedValueOnce(null);
  spies.push(spy);
};

beforeAll(async () => {
  await sequelize.authenticate();
  savedInvitationUrl = process.env.INVITATION_URL;
  process.env.INVITATION_URL = TEST_INVITATION_URL;
});

beforeEach(async () => {
  await wipe();
  await seed();
  mailer.mockReset();
  mailer.mockResolvedValue(undefined);
  log.warn.mockClear();
  log.error.mockClear();
});

afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  process.env.INVITATION_URL = TEST_INVITATION_URL;
});

afterAll(async () => {
  await wipe();
  if (savedInvitationUrl === undefined) delete process.env.INVITATION_URL;
  else process.env.INVITATION_URL = savedInvitationUrl;
  await sequelize.close();
});

describe('listMyChurches', () => {
  it("creates a client login's own church once, named from its churchName", async () => {
    const first = await listMyChurches(await user(CLIENT));
    const again = await listMyChurches(await user(CLIENT));

    expect(first).toEqual([
      {
        id: expect.any(Number),
        name: 'Hope Chapel',
        isActive: true,
        role: 'owner',
        canConnectIntegrations: true,
        canManagePeople: true,
        accountUserId: CLIENT,
        accountEmail: 'client-ch-it@example.test',
        connections: { qbo: false, pco: false },
      },
    ]);
    expect(again).toEqual(first);
    expect(await Church.count({ where: { ownerUserId: CLIENT } })).toBe(1);
    expect(await ChurchMember.count({ where: { churchId: first[0].id } })).toBe(1);
  });

  it('uses the church a parallel first call made, when it lost the race to create one', async () => {
    const [first] = await listMyChurches(await user(CLIENT));
    // This call looks before the other one has committed: it sees no church, tries to create one,
    // and runs into the one-church-per-account index.
    nullOnce(Church);

    expect((await listMyChurches(await user(CLIENT))).map((c) => c.id)).toEqual([first.id]);
    expect(await Church.count({ where: { ownerUserId: CLIENT } })).toBe(1);
  });

  it('does not swallow the unique error when there is still no church after it', async () => {
    await listMyChurches(await user(CLIENT));
    nullOnce(Church, 2);

    await expect(listMyChurches(await user(CLIENT))).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('creates nothing for a bookkeeper login on no church', async () => {
    expect(await listMyChurches(await user(BK_ONLY))).toEqual([]);
    expect(await Church.count({ where: { ownerUserId: BK_ONLY } })).toBe(0);
  });

  it('leaves out, and logs by id, a membership of a church with no account row', async () => {
    const orphan = await Church.create({ name: 'Orphan', ownerUserId: null, isActive: true });
    const member = await addOwner(orphan.id, BK);

    expect(await listMyChurches(await user(BK))).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      actorId: BK,
      memberId: member.id,
      churchId: orphan.id,
    });
  });

  it('says QuickBooks is connected once the account holds a qbo token with an access token', async () => {
    const id = await graceFor();
    const account = await accountOf(id);
    const entity: any = await tokenEntity.create({ email: account.email, isEnabled: true } as any);
    await tokens.create({
      userId: account.id,
      tokenEntityId: entity.id,
      token_type: 'qbo',
      access_token: 'qbo-at',
    } as any);
    // A Planning Center row without an access token is not a connection.
    await tokens.create({ userId: account.id, tokenEntityId: entity.id, token_type: 'pco', access_token: null } as any);

    const [grace] = await listMyChurches(await user(BK));
    expect(grace.connections).toEqual({ qbo: true, pco: false });
  });
});

describe('createChurch', () => {
  it('files the church under an account row nobody can sign in as, owned by its creator', async () => {
    const created = await createChurch(await user(BK), 'Grace');

    const church: any = await Church.findOne({ where: { id: created.id } });
    const account: any = await User.findOne({ where: { id: church.ownerUserId } });
    expect(account.email).toMatch(ACCOUNT_EMAIL);
    expect(account.role).toBe('client');
    expect(account.churchName).toBe('Grace');
    expect(church.name).toBe('Grace');
    expect(church.isActive).toBe(true);

    const members: any[] = await ChurchMember.findAll({ where: { churchId: created.id } });
    expect(members.map((m) => [m.userId, m.role, m.integrationAccessEnabled, m.inviteAccepted])).toEqual([
      [BK, 'owner', true, true],
    ]);

    expect(created).toEqual({
      id: church.id,
      name: 'Grace',
      isActive: true,
      role: 'owner',
      canConnectIntegrations: true,
      canManagePeople: true,
      accountUserId: account.id,
      accountEmail: account.email,
      connections: { qbo: false, pco: false },
    });
  });

  it('refuses a second church with the same name, ignoring case and spaces', async () => {
    await createChurch(await user(BK), 'Grace');
    await expect(createChurch(await user(BK), ' grace ')).rejects.toMatchObject({ status: 409 });
    expect(await ChurchMember.count({ where: { userId: BK } })).toBe(1);
  });

  it('makes one church from a double submit', async () => {
    const results = await Promise.allSettled([
      createChurch(await user(BK), 'Grace'),
      createChurch(await user(BK), 'Grace'),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
    expect(await ChurchMember.count({ where: { userId: BK } })).toBe(1);
  });

  it('refuses a blank name', async () => {
    await expect(createChurch(await user(BK), '   ')).rejects.toMatchObject({ status: 400 });
  });
});

describe('invitePerson', () => {
  it('invites a new address with a copyable link and emails it', async () => {
    const id = await graceFor();
    const result = await invitePerson(await accessAs(BK, id), ' New.Person+x@Example.test ');

    const member: any = await ChurchMember.findOne({ where: { id: result.memberId } });
    expect(member).toMatchObject({
      churchId: id,
      userId: null,
      role: 'bookkeeper',
      integrationAccessEnabled: false,
      invitedEmail: 'new.person+x@example.test',
      inviteAccepted: false,
    });
    expect(member.invitationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result).toEqual({
      memberId: member.id,
      addedExisting: false,
      inviteLink: `${TEST_INVITATION_URL}?bookkeeperEmail=new.person%2Bx%40example.test&invitationToken=${member.invitationToken}`,
      emailSent: true,
    });
    expect(mailer).toHaveBeenCalledWith('new.person+x@example.test', result.inviteLink);
  });

  it('refuses the same address twice', async () => {
    const id = await graceFor();
    await invitePerson(await accessAs(BK, id), 'twice-it@example.test');
    await expect(invitePerson(await accessAs(BK, id), 'TWICE-it@example.test')).rejects.toMatchObject({ status: 409 });
    expect(await ChurchMember.count({ where: { churchId: id } })).toBe(2);
  });

  it('turns a double submit that gets past the check into a 409, not a second invite', async () => {
    const id = await graceFor();
    await invitePerson(await accessAs(BK, id), 'double-it@example.test');
    const access = await accessAs(BK, id);
    nullOnce(ChurchMember); // the "already invited?" look misses the first submit's row

    await expect(invitePerson(access, 'Double-it@example.test')).rejects.toMatchObject({
      status: 409,
      message: 'double-it@example.test has already been invited. Copy their invite link from the list.',
    });
    expect(await ChurchMember.count({ where: { churchId: id, invitedEmail: 'double-it@example.test' } })).toBe(1);
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it('adds someone who already has a login straight away, with no link and no email', async () => {
    const id = await graceFor();
    const result = await invitePerson(await accessAs(BK, id), 'existing-ch-it@EXAMPLE.test');

    expect(result).toEqual({ memberId: expect.any(Number), addedExisting: true, inviteLink: null, emailSent: false });
    const member: any = await ChurchMember.findOne({ where: { id: result.memberId } });
    expect(member).toMatchObject({
      userId: EXISTING,
      role: 'bookkeeper',
      inviteAccepted: true,
      integrationAccessEnabled: false,
      invitationToken: null,
    });
    expect(mailer).not.toHaveBeenCalled();

    const theirs = await listMyChurches(await user(EXISTING));
    expect(theirs.map((c) => [c.id, c.role, c.canConnectIntegrations, c.canManagePeople])).toEqual([
      [id, 'bookkeeper', false, false],
    ]);

    await expect(invitePerson(await accessAs(BK, id), 'Existing-CH-it@example.test')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('turns a double submit for an existing login into a 409', async () => {
    const id = await graceFor();
    await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');
    const access = await accessAs(BK, id);
    nullOnce(ChurchMember, 2);

    await expect(invitePerson(access, 'existing-ch-it@example.test')).rejects.toMatchObject({
      status: 409,
      message: 'existing-ch-it@example.test is already on this church.',
    });
    expect(await ChurchMember.count({ where: { churchId: id, userId: EXISTING } })).toBe(1);
  });

  it('picks the login spelled exactly as typed, else the oldest, when two differ only in case', async () => {
    const grace = await graceFor();
    const zion = (await createChurch(await user(BK), 'Zion')).id;

    await invitePerson(await accessAs(BK, grace), 'Dup-CH-it@example.test');
    await invitePerson(await accessAs(BK, zion), 'DUP-ch-it@example.test');

    expect(await memberRow(grace, DUP_EXACT)).not.toBeNull();
    expect(await memberRow(grace, DUP_LOWER)).toBeNull();
    expect(await memberRow(zion, DUP_LOWER)).not.toBeNull();
    expect(await memberRow(zion, DUP_EXACT)).toBeNull();
  });

  it("refuses the church's own login, which is on it already", async () => {
    // A church whose own login is a person: they own it through their membership.
    const [own] = await listMyChurches(await user(CLIENT));
    await expect(invitePerson(await accessAs(CLIENT, own.id), 'Client-CH-it@example.test')).rejects.toMatchObject({
      status: 409,
    });

    // A Clients-page church: its account row has no membership, but it is still the church itself.
    const legacy = await Church.create({ name: 'Legacy CC', ownerUserId: LEGACY_ACCOUNT, isActive: true });
    await addOwner(legacy.id, BK);
    await expect(invitePerson(await accessAs(BK, legacy.id), 'legacy-cc-it@example.test')).rejects.toMatchObject({
      status: 409,
      message: 'legacy-cc-it@example.test is already on this church.',
    });
    expect(await ChurchMember.count({ where: { churchId: legacy.id } })).toBe(1);
  });

  it('keeps the invite and says so when the email cannot be sent, without logging the address', async () => {
    const id = await graceFor();
    mailer.mockRejectedValueOnce(new Error('Forbidden: mail-fail-it@example.test'));

    const result = await invitePerson(await accessAs(BK, id), 'mail-fail-it@example.test');

    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toContain('invitationToken=');
    expect(await ChurchMember.findOne({ where: { id: result.memberId } })).not.toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('mail-fail-it');
  });

  it('writes no invite when the server has no invitation URL to link to', async () => {
    const id = await graceFor();
    delete process.env.INVITATION_URL;

    await expect(invitePerson(await accessAs(BK, id), 'no-url-it@example.test')).rejects.toThrow();

    expect(await ChurchMember.count({ where: { churchId: id } })).toBe(1);
    expect(mailer).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('no-url-it');
  });

  it('refuses something that is not an email address, and the church account addresses', async () => {
    const id = await graceFor();
    const account = await accountOf(id);
    await expect(invitePerson(await accessAs(BK, id), 'not-an-email')).rejects.toMatchObject({ status: 400 });
    await expect(invitePerson(await accessAs(BK, id), account.email)).rejects.toMatchObject({ status: 400 });
  });
});

describe('only an owner, or the church itself, manages it', () => {
  it('refuses a bookkeeper even if a route forgot to check', async () => {
    const id = await graceFor();
    const { memberId } = await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');
    const bk = await accessAs(EXISTING, id, 'member');
    const owner = await memberRow(id, BK);
    const asBookkeeper = { status: 403, message: 'Only an owner of this church can do that.' };

    await expect(invitePerson(bk, 'someone-it@example.test')).rejects.toMatchObject(asBookkeeper);
    await expect(updateChurch(bk, await user(EXISTING), { name: 'Mine now' })).rejects.toMatchObject(asBookkeeper);
    await expect(setIntegrationAccess(bk, memberId, true)).rejects.toMatchObject(asBookkeeper);
    await expect(removePerson(bk, owner.id)).rejects.toMatchObject(asBookkeeper);

    expect(await ChurchMember.count({ where: { churchId: id } })).toBe(2);
    expect(((await Church.findOne({ where: { id } })) as any).name).toBe('Grace');
  });
});

describe('listPeople', () => {
  const setUp = async () => {
    const id = await graceFor();
    await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');
    const pending = await invitePerson(await accessAs(BK, id), 'pending-it@example.test');
    const member: any = await ChurchMember.findOne({ where: { id: pending.memberId } });
    const token: string = member.invitationToken;
    return { id, token };
  };

  it("shows an owner everyone, with each outstanding invite's link", async () => {
    const { id, token } = await setUp();
    const people = await listPeople(await accessAs(BK, id), await user(BK));

    expect(people.map((p) => ({ ...p, memberId: undefined }))).toEqual([
      {
        role: 'owner',
        name: 'Bea Keeper',
        email: 'bk-ch-it@example.test',
        status: 'active',
        integrationAccessEnabled: true,
        isYou: true,
        inviteLink: null,
      },
      {
        role: 'bookkeeper',
        name: 'Ed',
        email: 'Existing-CH-it@example.test',
        status: 'active',
        integrationAccessEnabled: false,
        isYou: false,
        inviteLink: null,
      },
      {
        role: 'bookkeeper',
        name: null,
        email: 'pending-it@example.test',
        status: 'invited',
        integrationAccessEnabled: false,
        isYou: false,
        inviteLink: inviteLinkFor('pending-it@example.test', token),
      },
    ]);
  });

  it('shows a bookkeeper the same people but no invite links', async () => {
    const { id } = await setUp();
    const people = await listPeople(await accessAs(EXISTING, id, 'member'), await user(EXISTING));

    expect(people).toHaveLength(3);
    expect(people.every((p) => p.inviteLink === null)).toBe(true);
    expect(people.filter((p) => p.isYou).map((p) => p.email)).toEqual(['Existing-CH-it@example.test']);
  });

  it("lets a church's own login manage its people", async () => {
    const [own] = await listMyChurches(await user(CLIENT));
    const pending = await invitePerson(await accessAs(CLIENT, own.id), 'own-pending-it@example.test');

    const people = await listPeople(await accessAs(CLIENT, own.id), await user(CLIENT));
    expect(people.map((p) => [p.email, p.isYou, p.inviteLink !== null])).toEqual([
      ['client-ch-it@example.test', true, false],
      ['own-pending-it@example.test', false, true],
    ]);
    expect(people[1].memberId).toBe(pending.memberId);
  });

  it('still lists everyone, without links and logging once, when the server has no invitation URL', async () => {
    const { id } = await setUp();
    await invitePerson(await accessAs(BK, id), 'pending-two-it@example.test');
    delete process.env.INVITATION_URL;

    const people = await listPeople(await accessAs(BK, id), await user(BK));

    expect(people.map((p) => [p.status, p.inviteLink])).toEqual([
      ['active', null],
      ['active', null],
      ['invited', null],
      ['invited', null],
    ]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('setIntegrationAccess', () => {
  it("turns a bookkeeper's access on and off", async () => {
    const id = await graceFor();
    const { memberId } = await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');

    await setIntegrationAccess(await accessAs(BK, id), memberId, true);
    expect((await listMyChurches(await user(EXISTING)))[0].canConnectIntegrations).toBe(true);

    await setIntegrationAccess(await accessAs(BK, id), memberId, false);
    expect((await listMyChurches(await user(EXISTING)))[0].canConnectIntegrations).toBe(false);
  });

  it('accepts only true or false', async () => {
    const id = await graceFor();
    const { memberId } = await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');

    for (const value of ['true', 1, null, undefined]) {
      await expect(setIntegrationAccess(await accessAs(BK, id), memberId, value)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect((await ChurchMember.findOne({ where: { id: memberId } }))?.integrationAccessEnabled).toBe(false);
  });

  it('refuses an owner row, and a person who is not on the church', async () => {
    const id = await graceFor();
    const owner = await memberRow(id, BK);
    await expect(setIntegrationAccess(await accessAs(BK, id), owner.id, false)).rejects.toMatchObject({ status: 400 });

    const [other] = await listMyChurches(await user(OTHER_CLIENT));
    const elsewhere: any = await ChurchMember.findOne({ where: { churchId: other.id } });
    await expect(setIntegrationAccess(await accessAs(BK, id), elsewhere.id, true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(setIntegrationAccess(await accessAs(BK, id), 'abc', true)).rejects.toMatchObject({ status: 404 });
  });
});

describe('removePerson', () => {
  it('removes a bookkeeper and their legacy bookkeeper rows for this church only', async () => {
    const id = await graceFor();
    const account = await accountOf(id);
    const [other] = await listMyChurches(await user(OTHER_CLIENT));
    const { memberId } = await invitePerson(await accessAs(BK, id), 'existing-ch-it@example.test');
    const pending = await invitePerson(await accessAs(BK, id), 'Pending-Legacy-it@example.test');
    const legacy = { inviteSent: true, bookkeeperIntegrationAccessEnabled: false, inviteAccepted: true };
    await bookkeeper.create({
      ...legacy,
      userId: EXISTING,
      clientId: account.id,
      email: 'existing-ch-it@example.test',
      invitationToken: 't1',
    } as any);
    await bookkeeper.create({
      ...legacy,
      userId: EXISTING,
      clientId: OTHER_CLIENT,
      email: 'existing-ch-it@example.test',
      invitationToken: 't2',
    } as any);
    await bookkeeper.create({
      ...legacy,
      userId: null,
      clientId: account.id,
      email: 'Pending-Legacy-it@example.test',
      invitationToken: 't3',
      inviteAccepted: false,
    } as any);

    await removePerson(await accessAs(BK, id), memberId);
    await removePerson(await accessAs(BK, id), pending.memberId);

    expect(await ChurchMember.findOne({ where: { id: memberId } })).toBeNull();
    expect(await ChurchMember.findOne({ where: { id: pending.memberId } })).toBeNull();
    expect(await listMyChurches(await user(EXISTING))).toEqual([]);
    const left: any[] = await bookkeeper.findAll({ where: { clientId: [account.id, OTHER_CLIENT] } });
    expect(left.map((b) => b.invitationToken)).toEqual(['t2']);
    // The other church is untouched.
    expect(await ChurchMember.count({ where: { churchId: other.id } })).toBe(1);
  });

  it('removes one of two owners, then refuses the last', async () => {
    const id = await graceFor();
    const second = await addOwner(id, EXISTING);
    const first = await memberRow(id, BK);

    await removePerson(await accessAs(BK, id), second.id);
    expect(await ownersOf(id)).toBe(1);

    await expect(removePerson(await accessAs(BK, id), first.id)).rejects.toMatchObject({
      status: 409,
      message: 'A church needs at least one owner.',
    });
    expect(await ChurchMember.findOne({ where: { id: first.id } })).not.toBeNull();
  });

  it('keeps one owner when two owners remove each other at the same moment', async () => {
    const id = await graceFor();
    const second = await addOwner(id, EXISTING);
    const first = await memberRow(id, BK);
    const [asFirst, asSecond] = [await accessAs(BK, id), await accessAs(EXISTING, id)];

    const results = await Promise.allSettled([removePerson(asFirst, second.id), removePerson(asSecond, first.id)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    // Whoever goes second has just been removed, so is no longer an owner.
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 403,
    });
    expect(await ownersOf(id)).toBe(1);
  });

  it('lets only one of two owners remove the other at the same moment, even with a third owner left', async () => {
    const id = await graceFor();
    const second = await addOwner(id, EXISTING);
    await addOwner(id, BK_ONLY);
    const first = await memberRow(id, BK);
    const [asFirst, asSecond] = [await accessAs(BK, id), await accessAs(EXISTING, id)];

    const results = await Promise.allSettled([removePerson(asFirst, second.id), removePerson(asSecond, first.id)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 403,
      message: 'Only an owner of this church can do that.',
    });
    expect(await ownersOf(id)).toBe(2);
  });

  it('refuses an owner who was removed after their access was checked', async () => {
    const id = await graceFor();
    const second = await addOwner(id, EXISTING);
    const third = await addOwner(id, BK_ONLY);
    const asSecond = await accessAs(EXISTING, id); // checked by the route ...
    await removePerson(await accessAs(BK, id), second.id); // ... then removed by another owner

    await expect(removePerson(asSecond, third.id)).rejects.toMatchObject({ status: 403 });
    expect(await ChurchMember.findOne({ where: { id: third.id } })).not.toBeNull();
  });

  it("refuses to remove the church's own login, even with another owner", async () => {
    const [own] = await listMyChurches(await user(CLIENT));
    await addOwner(own.id, BK);
    const itself = await memberRow(own.id, CLIENT);

    await expect(removePerson(await accessAs(BK, own.id), itself.id)).rejects.toMatchObject({
      status: 409,
      message: "This is the church's own login; it can't be removed.",
    });
    expect(await ChurchMember.findOne({ where: { id: itself.id } })).not.toBeNull();
  });
});

describe('updateChurch', () => {
  it("renames the church and its account row's churchName", async () => {
    const id = await graceFor();
    await updateChurch(await accessAs(BK, id), await user(BK), { name: '  Grace Fellowship ' });

    expect(((await Church.findOne({ where: { id } })) as any).name).toBe('Grace Fellowship');
    expect((await accountOf(id)).churchName).toBe('Grace Fellowship');
    expect((await listMyChurches(await user(BK)))[0].name).toBe('Grace Fellowship');
  });

  it('refuses a name the caller already uses for another church, but allows recasing its own', async () => {
    const grace = await graceFor();
    const zion = (await createChurch(await user(BK), 'Zion')).id;

    await expect(updateChurch(await accessAs(BK, zion), await user(BK), { name: ' GRACE ' })).rejects.toMatchObject({
      status: 409,
    });
    expect(((await Church.findOne({ where: { id: zion } })) as any).name).toBe('Zion');

    await updateChurch(await accessAs(BK, grace), await user(BK), { name: 'GRACE' });
    expect(((await Church.findOne({ where: { id: grace } })) as any).name).toBe('GRACE');
  });

  it("deactivates only the church, never the account row - for a church's own login that is a person", async () => {
    const [own] = await listMyChurches(await user(CLIENT));
    await updateChurch(await accessAs(CLIENT, own.id), await user(CLIENT), { isActive: false });

    expect(((await Church.findOne({ where: { id: own.id } })) as any).isActive).toBe(false);
    const person = await user(CLIENT);
    expect(person.isActive).toBe(true);
    expect(person.churchName).toBe(' Hope Chapel ');
    expect((await listMyChurches(person))[0].isActive).toBe(false);
  });

  it('accepts only true or false for isActive', async () => {
    const id = await graceFor();
    for (const value of ['false', 0, null]) {
      await expect(updateChurch(await accessAs(BK, id), await user(BK), { isActive: value })).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(((await Church.findOne({ where: { id } })) as any).isActive).toBe(true);
  });

  it('lists inactive churches after the active ones', async () => {
    const grace = await graceFor();
    const zion = (await createChurch(await user(BK), 'Abundant Life')).id;
    await updateChurch(await accessAs(BK, zion), await user(BK), { isActive: false });

    expect((await listMyChurches(await user(BK))).map((c) => [c.name, c.isActive])).toEqual([
      ['Grace', true],
      ['Abundant Life', false],
    ]);
    expect(grace).not.toBe(zion);
  });
});
