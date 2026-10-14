/**
 * The secrets-to-the-browser fixes against a real Postgres, so the SQL Sequelize actually builds
 * is what is checked, not just the options passed to it: what each endpoint hands to res.json,
 * serialised the way Express does, never carries a reset token, an OAuth secret or an invitation
 * token - and still carries what the frontend reads.
 */
jest.mock('supertokens-node/recipe/emailpassword', () => ({
  __esModule: true,
  default: { getUserByEmail: jest.fn(), updateEmailOrPassword: jest.fn() },
}));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));

import EmailPassword from 'supertokens-node/recipe/emailpassword';
import sequelize from '../../db';
import User from '../../db/models/user';
import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import bookkeeper from '../../db/models/bookkeeper';
import UserSettings from '../../db/models/userSettings';
import { resetPassword, sendPasswordReset } from '../index';
import { bookkeeperList, getTokenList, getUserRelated } from '../user';

const emailPassword = EmailPassword as unknown as { getUserByEmail: jest.Mock; updateEmailOrPassword: jest.Mock };
const sgMail = jest.requireMock('@sendgrid/mail') as { send: jest.Mock };

const CHURCH_ID = 90101;
const CHURCH_EMAIL = 'secrets-church@example.test';
const BK_ID = 90102;
const BK_EMAIL = 'secrets-bk@example.test';
const RESET_TOKEN = 'feedfacefeedfacefeedfacefeedface';
const SECRETS = [RESET_TOKEN, 'INVITE-SECRET', 'PCO-ACCESS-SECRET', 'PCO-REFRESH-SECRET', 'BK-ACCESS-SECRET', 'BK-REFRESH-SECRET'];

const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
// What Express would put on the wire.
const wire = (res: any) => JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
const expectNoSecrets = (payload: any) => {
  const text = JSON.stringify(payload);
  for (const s of SECRETS) expect(text).not.toContain(s);
};

const cleanUp = async () => {
  await tokens.destroy({ where: { userId: [CHURCH_ID, BK_ID] } });
  await tokenEntity.destroy({ where: { email: [CHURCH_EMAIL, BK_EMAIL] } });
  await bookkeeper.destroy({ where: { clientId: CHURCH_ID } });
  await UserSettings.destroy({ where: { userId: [CHURCH_ID, BK_ID] } });
  await User.destroy({ where: { id: [CHURCH_ID, BK_ID] } });
};

beforeAll(async () => {
  await sequelize.authenticate();
});
afterAll(async () => {
  await cleanUp();
  await sequelize.close();
});

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await cleanUp();
  await User.create({ id: CHURCH_ID, email: CHURCH_EMAIL, firstName: 'Grace', isActive: true, role: 'client', token: RESET_TOKEN } as any);
  await User.create({ id: BK_ID, email: BK_EMAIL, firstName: 'Ben', isActive: true, role: 'bookkeeper' } as any);
  const churchEntity: any = await tokenEntity.create({ email: CHURCH_EMAIL, isEnabled: true } as any);
  const bkEntity: any = await tokenEntity.create({ email: BK_EMAIL, isEnabled: true } as any);
  await tokens.create({
    userId: CHURCH_ID, tokenEntityId: churchEntity.id, token_type: 'pco',
    access_token: 'PCO-ACCESS-SECRET', refresh_token: 'PCO-REFRESH-SECRET', organization_name: 'Grace Church',
  } as any);
  await tokens.create({
    userId: BK_ID, tokenEntityId: bkEntity.id, token_type: 'qbo',
    access_token: 'BK-ACCESS-SECRET', refresh_token: 'BK-REFRESH-SECRET', realm_id: '4620816365',
  } as any);
  await bookkeeper.create({
    clientId: CHURCH_ID, userId: BK_ID, email: BK_EMAIL, invitationToken: 'INVITE-SECRET',
    inviteSent: true, inviteAccepted: true, bookkeeperIntegrationAccessEnabled: false,
  } as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('getTokenList: which integrations are connected, without the OAuth secrets', async () => {
  const res = makeRes();
  await getTokenList({ body: { email: CHURCH_EMAIL } } as any, res);
  const { data } = wire(res);

  expectNoSecrets(data);
  expect(data).toHaveLength(1);
  expect(data[0].tokens).toEqual([
    expect.objectContaining({ id: expect.any(Number), token_type: 'pco', organization_name: 'Grace Church' }),
  ]);
  expect(data[0].tokens[0]).not.toHaveProperty('access_token');
  expect(data[0].tokens[0]).not.toHaveProperty('refresh_token');
});

test.each([
  ['the church asking (clientId)', { clientId: CHURCH_ID }],
  ['the bookkeeper asking (bookkeeperId)', { bookkeeperId: BK_ID }],
])('bookkeeperList, %s: no reset, OAuth or invitation secret', async (_label, body) => {
  const res = makeRes();
  await bookkeeperList({ body } as any, res);
  const { data } = wire(res);

  expectNoSecrets(data);
  expect(data).toHaveLength(1);
  const [row] = data;
  expect(row).toEqual(expect.objectContaining({ email: BK_EMAIL, inviteSent: true, inviteAccepted: true, createdAt: expect.any(String) }));
  expect(row).not.toHaveProperty('invitationToken');
  expect(row.Client).toEqual(expect.objectContaining({ id: CHURCH_ID, email: CHURCH_EMAIL, firstName: 'Grace' }));
  expect(row.Client).not.toHaveProperty('token');
  expect(row.Client.tokens).toEqual([expect.objectContaining({ token_type: 'pco' })]);
  expect(row.User).toEqual(expect.objectContaining({ id: BK_ID, email: BK_EMAIL, firstName: 'Ben' }));
  expect(row.User.tokens).toEqual([expect.objectContaining({ token_type: 'qbo', realm_id: '4620816365' })]);
});

test('getUserRelated: the user and their bookkeeper rows, no reset or invitation token', async () => {
  const church = makeRes();
  await getUserRelated({ query: { email: CHURCH_EMAIL } } as any, church);
  const churchData = wire(church).data;
  expectNoSecrets(churchData);
  expect(churchData).toEqual(expect.objectContaining({ id: CHURCH_ID, email: CHURCH_EMAIL, role: 'client' }));
  expect(churchData).not.toHaveProperty('token');

  const bk = makeRes();
  await getUserRelated({ query: { email: BK_EMAIL } } as any, bk);
  const bkData = wire(bk).data;
  expectNoSecrets(bkData);
  expect(bkData.UserBookkeepers).toEqual([expect.objectContaining({ clientId: CHURCH_ID, email: BK_EMAIL, inviteAccepted: true })]);
  expect(bkData.UserBookkeepers[0]).not.toHaveProperty('invitationToken');
});

test('resetPassword: a null token is refused; the real token works once and is then cleared', async () => {
  emailPassword.getUserByEmail.mockResolvedValue({ id: 'st-church' });
  emailPassword.updateEmailOrPassword.mockResolvedValue({ status: 'OK' });

  // The bookkeeper never asked for a reset, so its token column IS NULL - the old hole matched it.
  const refused = makeRes();
  await resetPassword({ body: { email: BK_EMAIL, token: null, password: 'stolen-1' } } as any, refused);
  expect(refused.status).toHaveBeenCalledWith(400);
  expect(emailPassword.updateEmailOrPassword).not.toHaveBeenCalled();

  const ok = makeRes();
  await resetPassword({ body: { email: CHURCH_EMAIL, token: RESET_TOKEN, password: 'new-pass-1' } } as any, ok);
  expect(ok.status).toHaveBeenCalledWith(200);
  expect(emailPassword.updateEmailOrPassword).toHaveBeenCalledWith({ userId: 'st-church', password: 'new-pass-1' });
  const after: any = await User.findByPk(CHURCH_ID);
  expect(after.token).toBeNull();

  const again = makeRes();
  await resetPassword({ body: { email: CHURCH_EMAIL, token: RESET_TOKEN, password: 'new-pass-2' } } as any, again);
  expect(again.status).toHaveBeenCalledWith(500);
  expect(emailPassword.updateEmailOrPassword).toHaveBeenCalledTimes(1);
});

test('resetPassword: two requests racing with one link change the password once', async () => {
  emailPassword.getUserByEmail.mockResolvedValue({ id: 'st-church' });
  emailPassword.updateEmailOrPassword.mockResolvedValue({ status: 'OK' });

  const [a, b] = [makeRes(), makeRes()];
  await Promise.all([
    resetPassword({ body: { email: CHURCH_EMAIL, token: RESET_TOKEN, password: 'first-1' } } as any, a),
    resetPassword({ body: { email: CHURCH_EMAIL, token: RESET_TOKEN, password: 'second-2' } } as any, b),
  ]);

  expect(emailPassword.updateEmailOrPassword).toHaveBeenCalledTimes(1);
  const statuses = [a.status.mock.calls[0][0], b.status.mock.calls[0][0]].sort();
  expect(statuses).toEqual([200, 500]);
  const after: any = await User.findByPk(CHURCH_ID);
  expect(after.token).toBeNull();
});

test('sendPasswordReset: an array of addresses writes no token and sends nothing; one address writes its own row', async () => {
  const before: any = await User.findByPk(CHURCH_ID);
  const refused = makeRes();
  await sendPasswordReset({ body: { email: ['attacker@example.test', CHURCH_EMAIL] } } as any, refused);
  expect(refused.status).toHaveBeenCalledWith(400);
  expect(sgMail.send).not.toHaveBeenCalled();
  expect(((await User.findByPk(CHURCH_ID)) as any).token).toBe(before.token);

  const ok = makeRes();
  await sendPasswordReset({ body: { email: BK_EMAIL } } as any, ok);
  expect(ok.status).toHaveBeenCalledWith(200);
  const bkRow: any = await User.findByPk(BK_ID);
  expect(bkRow.token).toMatch(/^[0-9a-f]{32}$/);
  expect(((await User.findByPk(CHURCH_ID)) as any).token).toBe(RESET_TOKEN); // nobody else's row
  expect(sgMail.send).toHaveBeenCalledTimes(1);
  expect(sgMail.send.mock.calls[0][0].to).toBe(BK_EMAIL);
  expect(sgMail.send.mock.calls[0][0].dynamicTemplateData.gotoUrl).toContain(`token=${bkRow.token}`);
});
