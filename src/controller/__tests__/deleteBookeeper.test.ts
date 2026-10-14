/**
 * Removing a bookkeeper from the legacy Bookkeepers tab takes away their access to the church, not
 * just the old row (services/legacyBookkeeper.ts does both in one transaction). The route's guard
 * (fromBookkeeperRowId) has already checked the caller owns the church the row belongs to.
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
jest.mock('../../services/churches', () => ({ ensureOwnChurch: jest.fn() }));
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));

import { removeLegacyBookkeeper } from '../../services/legacyBookkeeper';
import { deleteBookeeper } from '..';

const remove = removeLegacyBookkeeper as jest.Mock;

const del = async (body: Record<string, unknown>) => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  await deleteBookeeper({ body } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => jest.resetAllMocks());

it('removes the row and the access it gave', async () => {
  remove.mockResolvedValue({ removedMembers: 1 });
  const { code, body } = await del({ id: '7' });
  expect(remove).toHaveBeenCalledWith(7);
  expect(code).toBe(200);
  expect(body.data).toBe('deleted');
});

it('answers 404 for a row that is not there', async () => {
  remove.mockResolvedValue(null);
  const { code } = await del({ id: 7 });
  expect(code).toBe(404);
});

it.each([[undefined], [0], ['7; drop'], [[7, 8]]])('refuses id %p without deleting anything', async (id) => {
  const { code } = await del({ id });
  expect(code).toBe(400);
  expect(remove).not.toHaveBeenCalled();
});

it('answers 500 when the delete fails (and both deletes roll back together)', async () => {
  remove.mockRejectedValue(new Error('db down'));
  const { code } = await del({ id: 7 });
  expect(code).toBe(500);
});
