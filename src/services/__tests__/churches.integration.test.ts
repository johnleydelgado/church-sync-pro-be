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

import { Op, QueryTypes } from 'sequelize';
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
const PEOPLE = [CLIENT, BK, EXISTING, BK_ONLY, OTHER_CLIENT];

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

const seed = async () => {
  await User.create({ ...person, id: CLIENT, email: 'client-ch-it@example.test', role: 'client', churchName: ' Hope Chapel ', firstName: 'Hope', lastName: 'Admin' } as any);
  await User.create({ ...person, id: BK, email: 'bk-ch-it@example.test', role: 'bookkeeper', churchName: '', firstName: 'Bea', lastName: 'Keeper' } as any);
  await User.create({ ...person, id: EXISTING, email: 'Existing-CH-it@example.test', role: 'bookkeeper', churchName: '', firstName: 'Ed', lastName: 'N/A' } as any);
  await User.create({ ...person, id: BK_ONLY, email: 'bk-only-ch-it@example.test', role: 'bookkeeper', churchName: '', firstName: 'N/A', lastName: 'N/A' } as any);
  await User.create({ ...person, id: OTHER_CLIENT, email: 'other-ch-it@example.test', role: 'client', churchName: 'Other', firstName: 'N/A', lastName: 'N/A' } as any);
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

  it('still makes one church when two first calls race', async () => {
    const [a, b] = await Promise.all([listMyChurches(await user(CLIENT)), listMyChurches(await user(CLIENT))]);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(await Church.count({ where: { ownerUserId: CLIENT } })).toBe(1);
  });

  it('creates nothing for a bookkeeper login on no church', async () => {
    expect(await listMyChurches(await user(BK_ONLY))).toEqual([]);
    expect(await Church.count({ where: { ownerUserId: BK_ONLY } })).toBe(0);
  });

  it('says QuickBooks is connected once the account holds a qbo token with an access token', async () => {
    const id = await graceFor();
    const account = await accountOf(id);
    const entity: any = await tokenEntity.create({ email: account.email, isEnabled: true } as any);
    await tokens.create({ userId: account.id, tokenEntityId: entity.id, token_type: 'qbo', access_token: 'qbo-at' } as any);
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

  it('adds someone who already has a login straight away, with no link and no email', async () => {
    const id = await graceFor();
    const result = await invitePerson(await accessAs(BK, id), 'existing-ch-it@EXAMPLE.test');

    expect(result).toEqual({ memberId: expect.any(Number), addedExisting: true, inviteLink: null, emailSent: false });
    const member: any = await ChurchMember.findOne({ where: { id: result.memberId } });
    expect(member).toMatchObject({ userId: EXISTING, role: 'bookkeeper', inviteAccepted: true, integrationAccessEnabled: false, invitationToken: null });
    expect(mailer).not.toHaveBeenCalled();

    const theirs = await listMyChurches(await user(EXISTING));
    expect(theirs.map((c) => [c.id, c.role, c.canConnectIntegrations, c.canManagePeople])).toEqual([[id, 'bookkeeper', false, false]]);

    await expect(invitePerson(await accessAs(BK, id), 'Existing-CH-it@example.test')).rejects.toMatchObject({ status: 409 });
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

  it('refuses something that is not an email address, and the church account addresses', async () => {
    const id = await graceFor();
    const account = await accountOf(id);
    await expect(invitePerson(await accessAs(BK, id), 'not-an-email')).rejects.toMatchObject({ status: 400 });
    await expect(invitePerson(await accessAs(BK, id), account.email)).rejects.toMatchObject({ status: 400 });
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
      { role: 'owner', name: 'Bea Keeper', email: 'bk-ch-it@example.test', status: 'active', integrationAccessEnabled: true, isYou: true, inviteLink: null },
      { role: 'bookkeeper', name: 'Ed', email: 'Existing-CH-it@example.test', status: 'active', integrationAccessEnabled: false, isYou: false, inviteLink: null },
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

  it('refuses an owner row, and a person who is not on the church', async () => {
    const id = await graceFor();
    const owner: any = await ChurchMember.findOne({ where: { churchId: id, userId: BK } });
    await expect(setIntegrationAccess(await accessAs(BK, id), owner.id, false)).rejects.toMatchObject({ status: 400 });

    const [other] = await listMyChurches(await user(OTHER_CLIENT));
    const elsewhere: any = await ChurchMember.findOne({ where: { churchId: other.id } });
    await expect(setIntegrationAccess(await accessAs(BK, id), elsewhere.id, true)).rejects.toMatchObject({ status: 404 });
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
    await bookkeeper.create({ ...legacy, userId: EXISTING, clientId: account.id, email: 'existing-ch-it@example.test', invitationToken: 't1' } as any);
    await bookkeeper.create({ ...legacy, userId: EXISTING, clientId: OTHER_CLIENT, email: 'existing-ch-it@example.test', invitationToken: 't2' } as any);
    await bookkeeper.create({ ...legacy, userId: null, clientId: account.id, email: 'Pending-Legacy-it@example.test', invitationToken: 't3', inviteAccepted: false } as any);

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

  it('refuses to remove the last owner', async () => {
    const id = await graceFor();
    const owner: any = await ChurchMember.findOne({ where: { churchId: id, userId: BK } });
    await expect(removePerson(await accessAs(BK, id), owner.id)).rejects.toMatchObject({ status: 409 });
    expect(await ChurchMember.findOne({ where: { id: owner.id } })).not.toBeNull();
  });
});

describe('updateChurch', () => {
  it("renames the church and its account row's churchName", async () => {
    const id = await graceFor();
    await updateChurch(await accessAs(BK, id), { name: '  Grace Fellowship ' });

    expect(((await Church.findOne({ where: { id } })) as any).name).toBe('Grace Fellowship');
    expect((await accountOf(id)).churchName).toBe('Grace Fellowship');
    expect((await listMyChurches(await user(BK)))[0].name).toBe('Grace Fellowship');
  });

  it("deactivates only the church, never the account row - for a church's own login that is a person", async () => {
    const [own] = await listMyChurches(await user(CLIENT));
    await updateChurch(await accessAs(CLIENT, own.id), { isActive: false });

    expect(((await Church.findOne({ where: { id: own.id } })) as any).isActive).toBe(false);
    const login = await user(CLIENT);
    expect(login.isActive).toBe(true);
    expect(login.churchName).toBe(' Hope Chapel ');
    expect((await listMyChurches(login))[0].isActive).toBe(false);
  });

  it('lists inactive churches after the active ones', async () => {
    const grace = await graceFor();
    const zion = (await createChurch(await user(BK), 'Abundant Life')).id;
    await updateChurch(await accessAs(BK, zion), { isActive: false });

    expect((await listMyChurches(await user(BK))).map((c) => [c.name, c.isActive])).toEqual([
      ['Grace', true],
      ['Abundant Life', false],
    ]);
    expect(grace).not.toBe(zion);
  });
});
