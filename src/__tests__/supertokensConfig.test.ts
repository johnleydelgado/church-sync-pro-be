/**
 * REQUIRED mode is what makes verifySession() itself refuse an unverified account; if a
 * refactor ever drops the recipe or flips it to OPTIONAL, the sign-up bug comes straight
 * back with no test failing anywhere else. The delivery override is pinned to our
 * SendGrid sender so the SuperTokens demo mailer is never used.
 */
jest.mock('supertokens-node/recipe/emailverification', () => ({
  __esModule: true,
  default: { init: jest.fn((cfg) => ({ recipe: 'emailverification', cfg })) },
}));
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({
  init: jest.fn(() => ({ recipe: 'tpep' })),
  Google: jest.fn(() => ({})),
}));
jest.mock('supertokens-node/recipe/emailpassword', () => ({
  __esModule: true,
  default: { init: jest.fn(() => ({ recipe: 'ep' })) },
}));
jest.mock('supertokens-node/recipe/session', () => ({ init: jest.fn(() => ({ recipe: 'session' })) }));
jest.mock('../db/models/user', () => ({ __esModule: true, default: {} }));
jest.mock('../services/verificationEmail', () => ({ sendVerificationEmail: jest.fn() }));

import EmailVerification from 'supertokens-node/recipe/emailverification';
import { sendVerificationEmail } from '../services/verificationEmail';
import { buildSupertokensConfig, emailVerificationConfig } from '../supertokensConfig';

const mockedInit = (EmailVerification as any).init as jest.Mock;
const mockedSend = sendVerificationEmail as unknown as jest.Mock;

describe('buildSupertokensConfig', () => {
  it('registers EmailVerification in REQUIRED mode alongside the auth and session recipes', () => {
    const cfg = buildSupertokensConfig();
    const recipes = cfg.recipeList.map((r: any) => r.recipe);
    expect(recipes).toEqual(['tpep', 'ep', 'emailverification', 'session']);
    expect(mockedInit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'REQUIRED' }));
  });
});

describe('emailVerificationConfig.emailDelivery', () => {
  const original = { sendEmail: jest.fn() };
  const delivery = emailVerificationConfig.emailDelivery!.override!(original as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('sends verification mail through SendGrid with the SDK-built link', async () => {
    await delivery.sendEmail({
      type: 'EMAIL_VERIFICATION',
      user: { id: 'st-1', email: 'pastor@church.org' },
      emailVerifyLink: 'http://localhost:3000/auth/verify-email?token=t&rid=emailverification',
      userContext: {},
    } as any);
    expect(mockedSend).toHaveBeenCalledWith({
      to: 'pastor@church.org',
      link: 'http://localhost:3000/auth/verify-email?token=t&rid=emailverification',
    });
    expect(original.sendEmail).not.toHaveBeenCalled();
  });
});
