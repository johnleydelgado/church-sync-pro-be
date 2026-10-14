/**
 * The profile form saves names and the picture. It never changes the login email: SuperTokens owns
 * that address, and changing only Users.email would lock the person out of every guarded route and
 * leave their connections filed under an address nobody has.
 */
function mockModel() {
  return {
    __esModule: true,
    default: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
}
jest.mock('../../db/models/user', mockModel);
jest.mock('../../db/models/userSettings', mockModel);
jest.mock('../../db/models/tokens', mockModel);
jest.mock('../../db/models/tokenEntity', mockModel);
jest.mock('../../db/models/bookkeeper', mockModel);
jest.mock('../../db/models/userEmailPreferences', mockModel);
jest.mock('../../db/models/billing', mockModel);
jest.mock('../../db/models/churchMember', mockModel);
jest.mock('../../db', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/storage', () => ({ uploadImage: jest.fn() }));
jest.mock('../../services/clearingSnapshot', () => ({ captureClearingSnapshot: jest.fn() }));
jest.mock('../../services/emailVerification', () => ({ markEmailVerified: jest.fn() }));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ emailPasswordSignUp: jest.fn() }));

import Users from '../../db/models/user';
import { uploadImage } from '../../utils/storage';
import { updateUserData } from '../user';

const update = (Users as any).update as jest.Mock;
const upload = uploadImage as jest.Mock;

const makeRes = () => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.resetAllMocks();
  update.mockResolvedValue([1]);
});

const body = { userId: 10, email: 'new@example.test', firstName: 'Matt', lastName: 'K', churchName: 'Active Church' };

it('saves the names and never the email', async () => {
  const res = makeRes();
  await updateUserData({ body } as any, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(update).toHaveBeenCalled();
  for (const [values, options] of update.mock.calls) {
    expect(values).not.toHaveProperty('email');
    expect(options).toEqual({ where: { id: 10 } });
  }
  expect(update).toHaveBeenCalledWith(
    { firstName: 'Matt', lastName: 'K', churchName: 'Active Church' },
    { where: { id: 10 } },
  );
});

it('saves the picture, and still not the email', async () => {
  upload.mockResolvedValue({ fileName: 'a.png', imageUrl: 'https://img/a.png' });
  const res = makeRes();
  await updateUserData({ body: { ...body, file: 'data', file_name: 'a.png' } } as any, res);
  expect(update).toHaveBeenCalledWith({ img_url: 'https://img/a.png' }, { where: { id: 10 } });
  for (const [values] of update.mock.calls) expect(values).not.toHaveProperty('email');
});
