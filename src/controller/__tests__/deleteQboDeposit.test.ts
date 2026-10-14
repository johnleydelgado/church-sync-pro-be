/**
 * Unsyncing deposits. The request lists UserSync rows by id; only rows filed under the church the
 * route guard checked (res.locals.churchAccess.account) are touched, and the QuickBooks deposit id
 * comes from the stored row, never from the request. Otherwise a member of one church could forget
 * another church's postings, and the next run would post that church's day again.
 */
jest.mock('../../db/models/UserSync', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../services/qboClient', () => ({ getQboClientForUser: jest.fn() }));
jest.mock('../../utils/mapping', () => ({ projectPayload: jest.fn() }));

import UserSync from '../../db/models/UserSync';
import { getQboClientForUser } from '../../services/qboClient';
import { deleteQboDeposit } from '../qbo';

const rows = (UserSync as any).findOne as jest.Mock;
const destroy = (UserSync as any).destroy as jest.Mock;
const qboFor = getQboClientForUser as jest.Mock;

const ACCOUNT = { id: 10, email: 'church@example.test' };
const OWN = { id: 1, userId: 10, donationId: 'dep-1' };

let qbo: { deleteDeposit: jest.Mock };

const makeRes = (locals: any = { churchAccess: { account: ACCOUNT } }) => {
  const res: any = { locals };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const call = async (synchData: unknown, res = makeRes()) => {
  await deleteQboDeposit({ body: { email: ACCOUNT.email, synchData } } as any, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  jest.resetAllMocks();
  qbo = { deleteDeposit: jest.fn((_id: string, cb: (err: unknown) => void) => cb(null)) };
  qboFor.mockResolvedValue(qbo);
  rows.mockImplementation(async ({ where }: any) => (where.id === OWN.id && where.userId === ACCOUNT.id ? OWN : null));
  destroy.mockResolvedValue(1);
});

it("deletes the church's own row, using the deposit id stored on it", async () => {
  const { code } = await call([{ id: 1, donationId: 'someone-elses-deposit' }]);
  expect(code).toBe(200);
  expect(qboFor).toHaveBeenCalledWith(ACCOUNT.email);
  expect(rows).toHaveBeenCalledWith({ where: { id: 1, userId: ACCOUNT.id } });
  expect(qbo.deleteDeposit).toHaveBeenCalledWith('dep-1', expect.any(Function));
  expect(destroy).toHaveBeenCalledWith({ where: { id: 1, userId: ACCOUNT.id } });
});

it("does not touch a row filed under another church's account", async () => {
  const { code, body } = await call([{ id: 2, donationId: 'dep-2', userId: 99 }]);
  expect(rows).toHaveBeenCalledWith({ where: { id: 2, userId: ACCOUNT.id } });
  expect(qbo.deleteDeposit).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(code).toBe(500);
  expect(body.message).toBe('Deleted 0 of 1. 1 not found for this church.');
});

it('deletes the rows it may and reports the rest', async () => {
  const { code, body } = await call([{ id: 1 }, { id: 2 }]);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledWith({ where: { id: 1, userId: ACCOUNT.id } });
  expect(code).toBe(500);
  expect(body.message).toMatch(/^Deleted 1 of 2\./);
});

it.each([
  ['an array id', [1, 2]],
  ['an object id', { gt: 0 }],
  ['no id', undefined],
  ['a non-numeric id', '1 OR 1=1'],
])('treats %s as a row that is not there', async (_label, id) => {
  const { body } = await call([{ id }]);
  expect(rows).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(body.message).toMatch(/^Deleted 0 of 1\./);
});

it('keeps the row when QuickBooks refuses the delete', async () => {
  qbo.deleteDeposit.mockImplementation((_id: string, cb: (err: unknown) => void) =>
    cb({ Fault: { Error: [{ Message: 'Object Not Found' }] } }),
  );
  const { code, body } = await call([{ id: 1 }]);
  expect(code).toBe(500);
  expect(body.message).toBe('Deleted 0 of 1. QuickBooks rejected 1; those remain synced so they are not re-posted.');
  expect(destroy).not.toHaveBeenCalled();
});

it('refuses, touching nothing, when the route ran without its church guard', async () => {
  const { code } = await call([{ id: 1 }], makeRes({}));
  expect(code).toBe(403);
  expect(qboFor).not.toHaveBeenCalled();
  expect(rows).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
});
