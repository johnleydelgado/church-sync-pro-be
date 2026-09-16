/**
 * Saving the donation start date is the moment the clearing-account snapshot is taken. user.ts
 * imports every model it touches anywhere, so all of them are faked to keep this a unit test.
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
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));

import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import { captureClearingSnapshot } from '../../services/clearingSnapshot';
import { setStartDataAutomation } from '../user';

const users = Users as unknown as { findOne: jest.Mock };
const settings = UserSettings as unknown as { findOne: jest.Mock; update: jest.Mock; create: jest.Mock };
const snapshot = captureClearingSnapshot as unknown as jest.Mock;

const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
const call = async (body: any) => { const res = makeRes(); await setStartDataAutomation({ body } as any, res); return res; };

beforeEach(() => {
  jest.clearAllMocks();
  users.findOne.mockResolvedValue({ toJSON: () => ({ id: 1 }) });
  settings.findOne.mockResolvedValue({ id: 10 });
  settings.update.mockResolvedValue([1]);
  snapshot.mockResolvedValue(0);
});

describe('setStartDataAutomation and the go-live snapshot', () => {
  test('saving the donation start date captures the snapshot and re-opens the transition', async () => {
    await call({ email: 'a@b.test', type: 'donation', date: '09-15-2026' });
    expect(snapshot).toHaveBeenCalledWith('a@b.test', 1);
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ startDateAutomationFund: '09-15-2026', transitionTruedUpAt: null }),
      { where: { userId: 1 } },
    );
  });

  test('the snapshot is taken AFTER the date is written, so it reads the new go-live day', async () => {
    const order: string[] = [];
    settings.update.mockImplementation(async () => { order.push('update'); return [1]; });
    snapshot.mockImplementation(async () => { order.push('snapshot'); return 0; });
    await call({ email: 'a@b.test', type: 'donation', date: '09-15-2026' });
    expect(order).toEqual(['update', 'snapshot']);
  });

  test('a snapshot failure does not fail the save', async () => {
    snapshot.mockRejectedValue(new Error('qbo down'));
    const res = await call({ email: 'a@b.test', type: 'donation', date: '09-15-2026' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('the registration start date does not touch the clearing snapshot', async () => {
    await call({ email: 'a@b.test', type: 'registration', date: '09-15-2026' });
    expect(snapshot).not.toHaveBeenCalled();
  });
});
