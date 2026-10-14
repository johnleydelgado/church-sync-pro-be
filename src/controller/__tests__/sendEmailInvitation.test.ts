/**
 * Inviting a bookkeeper from the legacy Bookkeepers tab. Always a pending invite with a mail:
 * `createdByBk` / `bookkeeperId` from the body are ignored (they used to write an already-accepted
 * row for any user id, which a resync would turn into a ChurchMembers row). The pending
 * ChurchMembers row is written too, with the same token the mail carries.
 */
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() } };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/thirdparty', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/syncEngine', () => ({ syncBatchToJournalEntries: jest.fn() }));
jest.mock('../../services/pendingInvite', () => ({ recordPendingChurchInvite: jest.fn() }));
jest.mock('../../services/legacyBookkeeper', () => ({ removeLegacyBookkeeper: jest.fn() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));

import bookkeeper from '../../db/models/bookkeeper';
import { recordPendingChurchInvite } from '../../services/pendingInvite';
import { sendEmailInvitation } from '..';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sgMail = require('@sendgrid/mail');
const bkCreate = (bookkeeper as any).create as jest.Mock;
const mirror = recordPendingChurchInvite as jest.Mock;

const makeRes = () => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const send = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await sendEmailInvitation({ body } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.resetAllMocks();
  bkCreate.mockResolvedValue({ id: 1 });
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
  const row = bkCreate.mock.calls[0][0];
  expect(row).toMatchObject({ email: 'bk@example.test', clientId: 10, inviteAccepted: false, inviteSent: true });
  expect(row).not.toHaveProperty('userId');
  expect(sgMail.send).toHaveBeenCalledTimes(1);
});

it('writes the pending ChurchMembers row with the token the mail carries', async () => {
  await send({ emailTo: 'bk+1@example.test', clientId: '10' });
  const token = bkCreate.mock.calls[0][0].invitationToken;
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(mirror).toHaveBeenCalledWith({ clientId: 10, email: 'bk+1@example.test', token });
  const { inviteLink } = sgMail.send.mock.calls[0][0].dynamicTemplateData;
  expect(inviteLink).toContain(`bookkeeperEmail=${encodeURIComponent('bk+1@example.test')}`);
  expect(inviteLink).toContain(`invitationToken=${token}`);
});

it('still sends the mail when the church already has that person', async () => {
  mirror.mockResolvedValue('already-member');
  const { code } = await send({ emailTo: 'bk@example.test', clientId: 10 });
  expect(code).toBe(200);
  expect(sgMail.send).toHaveBeenCalledTimes(1);
});

it('sends no mail when the ChurchMembers row could not be written', async () => {
  mirror.mockRejectedValue(new Error('db down'));
  const { code } = await send({ emailTo: 'bk@example.test', clientId: 10 });
  expect(code).toBe(500);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it.each([[undefined], [''], ['   '], [['a@example.test']]])('refuses emailTo %p, writing nothing', async (emailTo) => {
  const { code } = await send({ emailTo, clientId: 10 });
  expect(code).toBe(400);
  expect(bkCreate).not.toHaveBeenCalled();
  expect(mirror).not.toHaveBeenCalled();
  expect(sgMail.send).not.toHaveBeenCalled();
});
