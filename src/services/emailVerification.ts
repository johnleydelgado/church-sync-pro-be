/* eslint-disable @typescript-eslint/no-var-requires */
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');
import EmailVerification from 'supertokens-node/recipe/emailverification';

/**
 * Marks every SuperTokens user with this email as verified. Used when the address has
 * already been proven some other way (an invitation token that was mailed to it, or an
 * account that predates verification). Returns how many users were newly marked.
 */
export const markEmailVerified = async (email: string): Promise<number> => {
  const stUsers: Array<{ id: string }> = await ThirdPartyEmailPassword.getUsersByEmail(email);
  let marked = 0;
  for (const stUser of stUsers) {
    const token = await EmailVerification.createEmailVerificationToken(stUser.id, email);
    if (token.status === 'OK') {
      await EmailVerification.verifyEmailUsingToken(token.token);
      marked += 1;
    }
    // EMAIL_ALREADY_VERIFIED_ERROR: nothing to do.
  }
  return marked;
};
