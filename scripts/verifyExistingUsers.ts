/**
 * Marks every account that exists today as email-verified. Run ONCE per environment
 * BEFORE deploying a backend with EmailVerification in REQUIRED mode, otherwise every
 * existing login is refused with "invalid claim". Safe to re-run.
 *
 *   NODE_ENV=development DOTENV_CONFIG_PATH=.env            npx ts-node -r dotenv/config scripts/verifyExistingUsers.ts
 *   NODE_ENV=staging     DOTENV_CONFIG_PATH=.env.staging    npx ts-node -r dotenv/config scripts/verifyExistingUsers.ts
 *   NODE_ENV=uat-prd     DOTENV_CONFIG_PATH=.env.production npx ts-node -r dotenv/config scripts/verifyExistingUsers.ts
 *
 * API_URL / API_KEYS in the env file must point at that environment's SuperTokens core.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const supertokens = require('supertokens-node');
import { buildSupertokensConfig } from '../src/supertokensConfig';
import { markEmailVerified } from '../src/services/emailVerification';
import Users from '../src/db/models/user';

const main = async () => {
  supertokens.init(buildSupertokensConfig());
  const users = (await Users.findAll({ attributes: ['email'], raw: true })) as unknown as Array<{ email: string }>;
  let marked = 0;
  for (const { email } of users) {
    const n = await markEmailVerified(email);
    if (n > 0) {
      marked += n;
      console.log(`verified ${email}`);
    }
  }
  console.log(`${users.length} accounts checked, ${marked} newly marked verified`);
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
