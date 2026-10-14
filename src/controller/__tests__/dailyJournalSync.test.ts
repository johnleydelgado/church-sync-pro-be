/**
 * The nightly journal-entry run skips a church whose owner has deactivated it (D8), and says so:
 * every church is accounted for as synced, failed or skipped with a named reason. The church
 * stays readable by its members; only the automatic posting stops.
 *
 * automation.ts imports most of the codebase, so everything it pulls in is faked to keep this a
 * unit test. Factories are inline or function declarations because jest hoists jest.mock().
 */
function mockModel() {
  return {
    __esModule: true,
    default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/UserSync', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/emailLog', mockModel);
jest.mock('../../db/models/SyncRun', mockModel);
jest.mock('../../db/models/church', mockModel);
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../planning-center', () => ({ getBatchInDonationPCO: jest.fn(), isAccessTokenValidPCO: jest.fn() }));
jest.mock('../stripe', () => ({
  checkAccessTokenValidity: jest.fn(),
  refreshAccessToken: jest.fn(),
  removeDuplicatesAndSumAmount: jest.fn(),
}));
jest.mock('../../utils/automation-helper', () => ({ dailySyncing: jest.fn(), dailySyncingRegistration: jest.fn() }));
jest.mock('../../services/dailyDonationSync', () => ({ runDailyDonationSync: jest.fn() }));
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn(), refreshQboToken: jest.fn() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('winston', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  format: { combine: jest.fn(), timestamp: jest.fn(), json: jest.fn() },
  transports: { Console: jest.fn() },
}));

import User from '../../db/models/user';
import SyncRun from '../../db/models/SyncRun';
import Church from '../../db/models/church';
import { runDailyDonationSync } from '../../services/dailyDonationSync';
import { dailyJournalSync } from '../automation';

const mockedUser = User as unknown as { findAll: jest.Mock };
const mockedSyncRun = SyncRun as unknown as { create: jest.Mock };
const mockedChurch = Church as unknown as { findAll: jest.Mock };
const mockedRun = runDailyDonationSync as unknown as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

it('skips a deactivated church with reason church_inactive and runs the others', async () => {
  const run = { update: jest.fn().mockResolvedValue(undefined) };
  mockedSyncRun.create.mockResolvedValue(run);
  mockedUser.findAll.mockResolvedValue([
    { id: 10, email: 'live@church.test' },
    { id: 11, email: 'gone@church.test' },
  ]);
  mockedChurch.findAll.mockResolvedValue([{ ownerUserId: 11 }]);
  mockedRun.mockResolvedValue({
    status: 'synced',
    email: 'live@church.test',
    daysExamined: ['2026-10-13'],
    postedDays: ['2026-10-13'],
    failedDays: [],
  });
  const res = makeRes();

  await dailyJournalSync({ body: {} } as any, res);

  expect(mockedChurch.findAll).toHaveBeenCalledWith({ where: { isActive: false }, attributes: ['ownerUserId'] });
  expect(mockedRun).toHaveBeenCalledTimes(1);
  expect(mockedRun.mock.calls[0][0]).toMatchObject({ id: 10 });

  const skips = [{ email: 'gone@church.test', reason: 'church_inactive' }];
  expect(run.update).toHaveBeenCalledWith(
    expect.objectContaining({ processed: 1, succeeded: 1, skipped: 1, skips, status: 'completed' }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0][0].data).toMatchObject({ processed: 1, skipped: 1, skips });
});

/**
 * The operator overrides, `email` (one church) and `days` (exact days), are optional - the
 * scheduler sends neither. Sent but unusable, they are refused: an empty `email` used to mean
 * "every church", and ran them all.
 */
describe('operator overrides', () => {
  const sync = async (body: Record<string, unknown>) => {
    const res = makeRes();
    await dailyJournalSync({ body } as any, res);
    return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };
  const synced = {
    status: 'synced',
    email: 'live@church.test',
    daysExamined: ['2026-09-08'],
    postedDays: ['2026-09-08'],
    failedDays: [],
  };

  beforeEach(() => {
    mockedSyncRun.create.mockResolvedValue({ update: jest.fn().mockResolvedValue(undefined) });
    mockedUser.findAll.mockResolvedValue([{ id: 10, email: 'live@church.test' }]);
    mockedChurch.findAll.mockResolvedValue([]);
    mockedRun.mockResolvedValue(synced);
  });

  it.each([[''], ['   '], [null], [5], [['live@church.test']], [{ email: 'live@church.test' }]])(
    'refuses email %p with 400, before opening a run or reading any church',
    async (email) => {
      const { code, body } = await sync({ email });
      expect(code).toBe(400);
      expect(body.success).toBe(false);
      expect(mockedSyncRun.create).not.toHaveBeenCalled();
      expect(mockedUser.findAll).not.toHaveBeenCalled();
      expect(mockedRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an empty list', []],
    ['not a list', '2026-09-08'],
    ['null', null],
    ['a day not written YYYY-MM-DD', ['2026-9-8']],
    ['a day that does not exist', ['2026-02-30']],
    ['a day that is not a string', [20260908]],
    ['one bad day among good ones', ['2026-09-08', 'yesterday']],
  ])('refuses days that are %s with 400, running nothing', async (_label, days) => {
    const { code } = await sync({ days });
    expect(code).toBe(400);
    expect(mockedSyncRun.create).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('runs only the church named, for the days named', async () => {
    const { code } = await sync({ email: 'live@church.test', days: ['2026-09-08', '2026-09-09'] });
    expect(code).toBe(200);
    expect(mockedUser.findAll).toHaveBeenCalledWith({ where: { role: 'client', email: 'live@church.test' } });
    expect(mockedRun.mock.calls[0][1]).toMatchObject({ days: ['2026-09-08', '2026-09-09'] });
  });

  it('runs every church for the default days when neither is sent', async () => {
    const { code } = await sync({});
    expect(code).toBe(200);
    expect(mockedUser.findAll).toHaveBeenCalledWith({ where: { role: 'client' } });
    expect(mockedRun.mock.calls[0][1].days).toBeUndefined();
  });
});
