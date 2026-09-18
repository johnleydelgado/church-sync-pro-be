/* eslint-disable @typescript-eslint/no-var-requires */
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');
const Session = require('supertokens-node/recipe/session');
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import type { TypeInput as EmailVerificationInput } from 'supertokens-node/recipe/emailverification/types';

import User from './db/models/user';
import { formFields } from './constant/forms';
import { sendVerificationEmail } from './services/verificationEmail';

const apiPort = process.env.API_PORT || 8080;
export const apiDomain = process.env.API_URL || `http://localhost:${apiPort}`;
const websitePort = process.env.WEBSITE_PORT || 3000;
export const websiteDomain = process.env.WEBSITE_URL || `http://localhost:${websitePort}`;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, API_KEYS } = process.env;

interface ResultObject {
  [key: string]: string;
}

// REQUIRED means verifySession() itself refuses a session whose email is not verified, so
// the backend enforces this, not just the sign-up page. Accounts that predate this must be
// marked verified before it reaches an environment: scripts/verifyExistingUsers.ts.
export const emailVerificationConfig: EmailVerificationInput = {
  mode: 'REQUIRED',
  emailDelivery: {
    override: (originalImplementation) => ({
      ...originalImplementation,
      sendEmail: async (input) => {
        await sendVerificationEmail({ to: input.user.email, link: input.emailVerifyLink });
      },
    }),
  },
};

export const buildSupertokensConfig = () => ({
  framework: 'express' as const,
  supertokens: {
    // TODO: This is a core hosted for demo purposes. You can use this, but make sure to change it to your core instance URI eventually.
    // connectionURI: 'http://localhost:3567',
    connectionURI: apiDomain,
    apiKey: API_KEYS, // OR can be undefined
  },
  appInfo: {
    // learn more about this on https://supertokens.com/docs/thirdpartyemailpassword/appinfo
    appName: 'Church Sync Pro', // TODO: Your app name
    apiDomain, // TODO: Change to your app's API domain
    websiteDomain, // TODO: Change to your app's website domain
    apiBasePath: '/auth',
    websiteBasePath: '/auth',
  },
  recipeList: [
    ThirdPartyEmailPassword.init({
      signUpFeature: {
        formFields: formFields,
      },
      providers: [
        // We have provided you with development keys which you can use for testsing.
        // IMPORTANT: Please replace them with your own OAuth keys for production use.
        ThirdPartyEmailPassword.Google({
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: GOOGLE_CLIENT_SECRET,
        }),
      ],
      override: {
        apis: (originalImplementation) => {
          return {
            ...originalImplementation,
            emailPasswordSignUpPOST: async function (input) {
              if (originalImplementation.emailPasswordSignUpPOST === undefined) {
                throw Error('Should never come here');
              }

              // First we call the original implementation
              const response = await originalImplementation.emailPasswordSignUpPOST(input);
              console.log('----1', response);
              // If sign up was successful
              if (response.status === 'OK') {
                // We can get the form fields from the input like this
                const formFields = input.formFields;
                const result = formFields.reduce((obj, item) => {
                  obj[item.id] = item.value;
                  return obj;
                }, {});
                const isEmailExist = await User.findOne({ where: { email: result.email } });
                if (isEmailExist === null) {
                  await User.create({ ...result, isActive: true });
                } else {
                  await User.update({ ...result }, { where: { email: result.email } });
                }
              }

              return response;
            },
            // override the email password sign in API
            emailPasswordSignInPOST: async function (input) {
              if (originalImplementation.emailPasswordSignInPOST === undefined) {
                throw Error('Should never come here');
              }
              const response = await originalImplementation.emailPasswordSignInPOST(input);
              if (response.status === 'OK') {
                // TODO: some post sign in logic
              }

              return response;
            },
          };
        },
      },
    }),
    EmailPassword.init({
      signUpFeature: {
        formFields: formFields,
      },
      override: {
        apis: (originalImp) => {
          return {
            ...originalImp,
            signUpPOST: async function (input) {
              if (originalImp.signUpPOST === undefined) {
                throw Error('Should never come here');
              }
              // First we call the original implementation of signUpPOST.
              const response = await originalImp.signUpPOST(input);

              // Post sign up response, we check if it was successful
              if (response.status === 'OK') {
                // These are the input form fields values that the user used while signing up
                const formFields = input.formFields;
                const result = formFields.reduce<ResultObject>((obj, item) => {
                  obj[item.id] = item.value;
                  return obj;
                }, {});
                const isEmailExist = await User.findOne({ where: { email: result.email } });
                if (isEmailExist === null) {
                  await User.create({ ...result, isActive: true });
                } else {
                  await User.update({ ...result }, { where: { email: result.email } });
                }
              }
              return response;
            },
          };
        },
      },
    }),
    EmailVerification.init(emailVerificationConfig),
    Session.init(), // initializes session features
  ],
});
