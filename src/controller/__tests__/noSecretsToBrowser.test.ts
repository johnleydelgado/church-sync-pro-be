/**
 * OAuth secrets and invitation tokens stay on the server. The browser gets an OAuth token only from
 * the callBack* exchange; after that it needs a token row's id and token_type (which integrations
 * are connected), never the secret. An invitation token belongs only in the emailed invite link.
 */
// A function declaration, not a const: jest hoists the mock() calls above everything else, so an
// arrow assigned to a const is read before it is initialised. The mock- prefix is what jest
// requires of any out-of-scope identifier a factory refers to.
function mockModel() {
  return { __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() } };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db/models/church', mockModel);
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));

import Users from '../../db/models/user';
import tokens from '../../db/models/tokens';
import tokenEntity from '../../db/models/tokenEntity';
import bookkeeper from '../../db/models/bookkeeper';
import { bookkeeperList, getTokenList, getUserRelated } from '../user';

const users = Users as unknown as { findOne: jest.Mock };
const entities = tokenEntity as unknown as { findAll: jest.Mock };
const bookkeepers = bookkeeper as unknown as { findAll: jest.Mock };

const OAUTH = { exclude: ['access_token', 'refresh_token'] };
const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
const sent = (res: any) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getTokenList', () => {
  test('reads token rows without the OAuth secrets and still returns them', async () => {
    const rows = [{ id: 3, email: 'church@b.test', tokens: [{ id: 11, token_type: 'pco' }] }];
    entities.findAll.mockResolvedValue(rows);
    const res = makeRes();
    await getTokenList({ body: { email: 'church@b.test' } } as any, res);

    expect(entities.findAll).toHaveBeenCalledWith({
      where: { email: 'church@b.test' },
      include: [{ model: tokens, attributes: OAUTH }],
    });
    expect(sent(res)).toEqual(expect.objectContaining({ success: true, data: rows }));
  });
});

describe('bookkeeperList', () => {
  test('leaves out the invitation token and both users\' OAuth secrets', async () => {
    bookkeepers.findAll.mockResolvedValue([]);
    await bookkeeperList({ body: { clientId: 7 } } as any, makeRes());

    const query = bookkeepers.findAll.mock.calls[0][0];
    expect(query.where).toEqual({ clientId: 7 });
    expect(query.attributes).toEqual({ exclude: ['invitationToken'] });
    const byAlias = Object.fromEntries(query.include.map((i: any) => [i.as, i]));
    for (const alias of ['User', 'Client']) {
      expect(byAlias[alias].model).toBe(Users);
      // Still includes the token rows - the client table shows which integrations are connected.
      expect(byAlias[alias].include).toEqual([{ model: tokens, as: 'tokens', attributes: OAUTH }]);
    }
  });
});

describe('getUserRelated', () => {
  test('leaves the invitation token out of UserBookkeepers, in the query and the response', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    users.findOne.mockResolvedValue({
      toJSON: () => ({
        id: 7,
        email: 'bk@b.test',
        UserBookkeepers: [{ id: 1, email: 'bk@b.test', inviteAccepted: true, invitationToken: 'abc123' }],
        UserSetting: {},
      }),
    });
    const res = makeRes();
    await getUserRelated({ query: { email: 'bk@b.test' } } as any, res);
    log.mockRestore();

    const { include } = users.findOne.mock.calls[0][0];
    const bkInclude = include.find((i: any) => i.as === 'UserBookkeepers');
    expect(bkInclude.attributes).toEqual({ exclude: ['invitationToken'] });

    const [row] = sent(res).data.UserBookkeepers;
    expect(row).toEqual({ id: 1, email: 'bk@b.test', inviteAccepted: true });
  });

  test('a user with no bookkeeper rows still loads', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    users.findOne.mockResolvedValue({ toJSON: () => ({ id: 7, email: 'church@b.test' }) });
    const res = makeRes();
    await getUserRelated({ query: { email: 'church@b.test' } } as any, res);
    log.mockRestore();
    expect(sent(res)).toEqual(expect.objectContaining({ success: true, data: { id: 7, email: 'church@b.test' } }));
  });
});
