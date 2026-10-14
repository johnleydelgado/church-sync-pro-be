/**
 * A church added from the Churches page files its data under a Users row with an
 * @accounts.churchsyncpro.invalid address. Signing up with one of those would take that row over
 * (the overrides update an existing Users row by email), so both sign-up APIs refuse it before
 * SuperTokens creates anything. SDK 13.x forwards GENERAL_ERROR to the browser as is.
 */
jest.mock('supertokens-node/recipe/emailverification', () => ({
  __esModule: true,
  default: { init: jest.fn(() => ({})) },
}));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({
  init: jest.fn(() => ({})),
  Google: jest.fn(() => ({})),
}));
jest.mock('supertokens-node/recipe/emailpassword', () => ({
  __esModule: true,
  default: { init: jest.fn(() => ({})) },
}));
jest.mock('supertokens-node/recipe/session', () => ({ init: jest.fn(() => ({})) }));
jest.mock('../db/models/user', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
}));
jest.mock('../services/verificationEmail', () => ({ sendVerificationEmail: jest.fn() }));

import User from '../db/models/user';
import { buildSupertokensConfig } from '../supertokensConfig';

const tpepInit = jest.requireMock('supertokens-node/recipe/thirdpartyemailpassword').init as jest.Mock;
const epInit = jest.requireMock('supertokens-node/recipe/emailpassword').default.init as jest.Mock;

const signUp = (email: string) => ({
  formFields: [
    { id: 'email', value: email },
    { id: 'password', value: 'a-long-password-1' },
    { id: 'churchName', value: 'Grace' },
  ],
  options: {},
  userContext: {},
});

beforeEach(() => jest.clearAllMocks());

describe.each([
  ['ThirdPartyEmailPassword', tpepInit, 'emailPasswordSignUpPOST'],
  ['EmailPassword', epInit, 'signUpPOST'],
])('%s sign-up', (_recipe, init, method) => {
  const apisOver = (original: Record<string, jest.Mock>) => {
    buildSupertokensConfig();
    return init.mock.calls[0][0].override.apis(original);
  };

  it('refuses a church account address before SuperTokens or the Users table is touched', async () => {
    const original = { [method]: jest.fn() };
    const apis = apisOver(original);
    await expect(apis[method](signUp('Church-ABC@Accounts.ChurchSyncPro.invalid'))).resolves.toEqual({
      status: 'GENERAL_ERROR',
      message: 'This email address cannot be used.',
    });
    expect(original[method]).not.toHaveBeenCalled();
    expect((User as any).findOne).not.toHaveBeenCalled();
    expect((User as any).create).not.toHaveBeenCalled();
    expect((User as any).update).not.toHaveBeenCalled();
  });

  it('hands any other address to SuperTokens', async () => {
    const original = { [method]: jest.fn().mockResolvedValue({ status: 'EMAIL_ALREADY_EXISTS_ERROR' }) };
    const apis = apisOver(original);
    await expect(apis[method](signUp('pastor@church.org'))).resolves.toEqual({ status: 'EMAIL_ALREADY_EXISTS_ERROR' });
    expect(original[method]).toHaveBeenCalledTimes(1);
  });
});
