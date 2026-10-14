/**
 * Inviting a bookkeeper from the legacy Bookkeepers tab. Always a pending invite with a mail:
 * `createdByBk` / `bookkeeperId` from the body are ignored (they used to write an already-accepted
 * row for any user id, which a resync would turn into a ChurchMembers row). The pending
 * ChurchMembers row is written too, with the same token the mail carries, in one transaction with
 * the legacy row.
 *
 * The church is the one the route's guard checked (res.locals.churchAccess.account). A client who
 * signed up after the churches migration gets their church first, or the link could not be
 * accepted. Someone already on the church is refused before anything is written or mailed, and a
 * re-sent invite refreshes the pending legacy row instead of adding another.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() } };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
// Runs the callback with a marker transaction, and records lower(...) comparisons so a test can
// read the query back. Needs no config.json.
jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    transaction: jest.fn((work: (t: unknown) => unknown) => work('TX')),
    fn: (fn: string, ...args: unknown[]) => ({ fn, args }),
    col: (col: string) => ({ col }),
    where: (attribute: unknown, logic: unknown) => ({ attribute, logic }),
  },
}));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/thirdparty', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/syncEngine', () => ({ syncBatchToJournalEntries: jest.fn() }));
jest.mock('../../services/pendingInvite', () => ({ recordPendingChurchInvite: jest.fn() }));
jest.mock('../../services/legacyBookkeeper', () => ({ removeLegacyBookkeeper: jest.fn() }));
jest.mock('../../services/churches', () => ({ ensureOwnChurch: jest.fn() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));

import { Op } from 'sequelize';
import bookkeeper from '../../db/models/bookkeeper';
import sequelize from '../../db';
import { recordPendingChurchInvite } from '../../services/pendingInvite';
import { ensureOwnChurch } from '../../services/churches';
import { sendEmailInvitation } from '..';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sgMail = require('@sendgrid/mail');
const bkCreate = (bookkeeper as any).create as jest.Mock;
const bkUpdate = (bookkeeper as any).update as jest.Mock;
const mirror = recordPendingChurchInvite as jest.Mock;
const ensureChurch = ensureOwnChurch as jest.Mock;
const transaction = (sequelize as any).transaction as jest.Mock;

const ACCOUNT = { id: 10, role: 'client', email: 'hope@example.test' };

const makeRes = (locals: Record<string, unknown> = { churchAccess: { account: ACCOUNT } }) => {
  const res: any = { locals };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const send = async (body: Record<string, unknown>, res = makeRes()) => {
  await sendEmailInvitation({ body } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

const expectNothingWritten = () => {
  expect(bkCreate).not.toHaveBeenCalled();
  expect(bkUpdate).not.toHaveBeenCalled();
  expect(sgMail.send).not.toHaveBeenCalled();
};

// inviteLinkFor refuses to build a link without it (it would mail `undefined?...`).
const ORIGINAL_INVITATION_URL = process.env.INVITATION_URL;
beforeAll(() => {
  process.env.INVITATION_URL = 'https://app.example.test/invite-bookkeeper';
});
afterAll(() => {
  process.env.INVITATION_URL = ORIGINAL_INVITATION_URL;
});

beforeEach(() => {
  jest.resetAllMocks();
  transaction.mockImplementation((work: (t: unknown) => unknown) => work('TX'));
  ensureChurch.mockResolvedValue(undefined);
  bkCreate.mockResolvedValue({ id: 1 });
  bkUpdate.mockResolvedValue([0]);
  mirror.mockResolvedValue('created');
  sgMail.send.mockResolvedValue([{ statusCode: 202 }]);
});

it('ignores createdByBk and bookkeeperId: a pending invite, and the mail goes out', async () => {
  const { code, body } = await send({
    name: 'B K',
    emailTo: 'bk@example.test',
    clientId: 10,
    createdByBk: true,
    bookkeeperId: 99,
  });
  expect(code).toBe(200);
  expect(body.data).toBe('Email sent');
  const [row, options] = bkCreate.mock.calls[0];
  expect(row).toMatchObject({ email: 'bk@example.test', clientId: 10, inviteAccepted: false, inviteSent: true });
  expect(row).not.toHaveProperty('userId');
  expect(options).toEqual({ transaction: 'TX' });
  expect(sgMail.send).toHaveBeenCalledTimes(1);
});

it('writes the pending ChurchMembers row with the token the mail carries, in the same transaction', async () => {
  await send({ emailTo: 'bk+1@example.test', clientId: '10' });
  const token = bkCreate.mock.calls[0][0].invitationToken;
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(mirror).toHaveBeenCalledWith({ clientId: 10, email: 'bk+1@example.test', token, transaction: 'TX' });
  const { inviteLink } = sgMail.send.mock.calls[0][0].dynamicTemplateData;
  expect(inviteLink).toContain(`bookkeeperEmail=${encodeURIComponent('bk+1@example.test')}`);
  expect(inviteLink).toContain(`invitationToken=${token}`);
});

it('files the invite under the church the guard checked', async () => {
  await send({ emailTo: 'bk@example.test', clientId: '0010' });
  expect(bkCreate.mock.calls[0][0].clientId).toBe(10);
  expect(mirror.mock.calls[0][0].clientId).toBe(10);
});

it('trims the address before it is stored or mailed', async () => {
  await send({ emailTo: '  bk@example.test ', clientId: 10 });
  expect(bkCreate.mock.calls[0][0].email).toBe('bk@example.test');
  expect(mirror.mock.calls[0][0].email).toBe('bk@example.test');
  expect(sgMail.send.mock.calls[0][0].to).toBe('bk@example.test');
});

it('makes sure a client who signed up since the churches migration has a church before inviting', async () => {
  await send({ emailTo: 'bk@example.test', clientId: 10 });
  expect(ensureChurch).toHaveBeenCalledWith(ACCOUNT);
  expect(ensureChurch.mock.invocationCallOrder[0]).toBeLessThan(mirror.mock.invocationCallOrder[0]);
});

it('refuses with 409 someone already on the church, before writing the legacy row or mailing', async () => {
  mirror.mockResolvedValue('already-member');
  const { code, body } = await send({ emailTo: ' BK@example.test ', clientId: 10 });
  expect(code).toBe(409);
  expect(body).toMatchObject({ success: false, message: 'BK@example.test is already on this church.' });
  expectNothingWritten();
});

it('refreshes the pending legacy row of a re-sent invite instead of adding another', async () => {
  bkUpdate.mockResolvedValue([1]);
  const { code } = await send({ emailTo: 'BK@example.test', clientId: 10 });
  expect(code).toBe(200);
  const token = mirror.mock.calls[0][0].token;
  expect(bkUpdate).toHaveBeenCalledWith(
    { invitationToken: token, inviteSent: true },
    {
      where: {
        [Op.and]: [
          { clientId: 10, userId: null, inviteAccepted: { [Op.not]: true } },
          { attribute: { fn: 'lower', args: [{ col: 'email' }] }, logic: 'bk@example.test' },
        ],
      },
      transaction: 'TX',
    },
  );
  expect(bkCreate).not.toHaveBeenCalled();
  expect(sgMail.send.mock.calls[0][0].dynamicTemplateData.inviteLink).toContain(`invitationToken=${token}`);
});

it('sends no mail when the ChurchMembers row could not be written', async () => {
  mirror.mockRejectedValue(new Error('db down'));
  const { code } = await send({ emailTo: 'bk@example.test', clientId: 10 });
  expect(code).toBe(500);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it('sends no mail when the church could not be made', async () => {
  ensureChurch.mockRejectedValue(new Error('db down'));
  const { code } = await send({ emailTo: 'bk@example.test', clientId: 10 });
  expect(code).toBe(500);
  expect(mirror).not.toHaveBeenCalled();
  expectNothingWritten();
});

it('refuses with 403 when the route ran without its church guard', async () => {
  const { code } = await send({ emailTo: 'bk@example.test', clientId: 10 }, makeRes({}));
  expect(code).toBe(403);
  expect(ensureChurch).not.toHaveBeenCalled();
  expect(mirror).not.toHaveBeenCalled();
  expectNothingWritten();
});

it.each([[undefined], [''], ['   '], [['a@example.test']]])('refuses emailTo %p, writing nothing', async (emailTo) => {
  const { code } = await send({ emailTo, clientId: 10 });
  expect(code).toBe(400);
  expect(ensureChurch).not.toHaveBeenCalled();
  expect(mirror).not.toHaveBeenCalled();
  expectNothingWritten();
});
