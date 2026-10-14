/**
 * addTokenInUser used to write the whole request body onto the Users row with that email - any
 * column, email, role and isActive included. The only caller (the sign-in-to-QuickBooks /
 * Planning Center / Stripe page) sends token fields the Users table has no columns for, so it now
 * writes nothing and still answers success.
 */
jest.mock('../../db/models/user', () => ({ __esModule: true, default: { update: jest.fn() } }));

import User from '../../db/models/user';
import { addTokenInUser } from '../db';

const makeRes = () => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

it('writes nothing onto the account row, whatever the body says', async () => {
  const res = makeRes();
  await addTokenInUser(
    {
      body: {
        email: 'church@example.test',
        access_token_qbo: 'a',
        realm_id: 'r',
        role: 'bookkeeper',
        isActive: false,
        email2: 'x',
      },
    } as any,
    res,
  );
  expect((User as any).update).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: 'success' });
});
