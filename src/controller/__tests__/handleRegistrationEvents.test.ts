/**
 * Renaming a registration event. The route guard checked the church named by body.userId; the row
 * to edit is found by registrationId AND that church's account, and an edit never moves a row to
 * another account. Otherwise a member of one church could rename, or take, another church's rows.
 */
function mockModel() {
  return {
    __esModule: true,
    default: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), findByPk: jest.fn() },
  };
}
jest.mock('../../db/models/registration', mockModel);
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../automation', () => ({ generatePcToken: jest.fn(), generateQBOToken: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/quickbookAuth', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import registration from '../../db/models/registration';
import { handleRegistrationEvents } from '../planning-center';

const findOne = (registration as any).findOne as jest.Mock;
const findByPk = (registration as any).findByPk as jest.Mock;

const ACCOUNT = { id: 10, email: 'church@example.test' };

const makeRes = (locals: any = { churchAccess: { account: ACCOUNT } }) => {
  const res: any = { locals };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const update = async (body: Record<string, unknown>, res = makeRes()) => {
  await handleRegistrationEvents({ body: { action: 'update', userId: ACCOUNT.id, ...body } } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  name: 'Old name',
  userId: ACCOUNT.id,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => jest.resetAllMocks());

it("renames a row filed under the guarded church's account", async () => {
  const own = row();
  findOne.mockResolvedValue(own);
  const { code } = await update({ registrationId: '5', name: 'SHE Conference' });
  expect(code).toBe(200);
  expect(findOne).toHaveBeenCalledWith({ where: { id: 5, userId: ACCOUNT.id } });
  expect(findByPk).not.toHaveBeenCalled();
  expect(own.name).toBe('SHE Conference');
  expect(own.save).toHaveBeenCalled();
});

it("answers 404 for another church's row and changes nothing", async () => {
  findOne.mockResolvedValue(null); // the row exists, but not under this account
  const { code } = await update({ registrationId: 6, name: 'Taken' });
  expect(code).toBe(404);
  expect(findOne).toHaveBeenCalledWith({ where: { id: 6, userId: ACCOUNT.id } });
});

it('never moves a row to another account, whatever userId the request sends', async () => {
  const own = row();
  findOne.mockResolvedValue(own);
  await update({ registrationId: 5, name: 'Renamed', userId: 99 });
  expect(own.userId).toBe(ACCOUNT.id);
  expect(own.save).toHaveBeenCalled();
});

it.each([
  ['no id', undefined],
  ['a non-numeric id', 'abc'],
  ['zero', 0],
  ['an array of ids', [5, 6]],
])('answers 404 for %s without querying', async (_label, registrationId) => {
  const { code } = await update({ registrationId, name: 'x' });
  expect(code).toBe(404);
  expect(findOne).not.toHaveBeenCalled();
});

it('refuses an update that reached the handler without its church guard', async () => {
  const { code } = await update({ registrationId: 5, name: 'x' }, makeRes({}));
  expect(code).toBe(403);
  expect(findOne).not.toHaveBeenCalled();
});
