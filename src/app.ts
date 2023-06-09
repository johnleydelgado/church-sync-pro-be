/* eslint-disable @typescript-eslint/no-var-requires */
import express from 'express';
import routes from './routes';
import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
const supertokens = require('supertokens-node');
const Session = require('supertokens-node/recipe/session');
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';

import User from './db/models/user';
import { formFields } from './constant/forms';
import { getallUsers } from './controller/automation';
// import { getallUsers } from './controller/automation';
const { middleware, errorHandler } = require('supertokens-node/framework/express');

const apiPort = process.env.API_PORT || 8080;
const apiDomain = process.env.API_URL || `http://localhost:${apiPort}`;
const websitePort = process.env.WEBSITE_PORT || 3000;
const websiteDomain = process.env.WEBSITE_URL || `http://localhost:${websitePort}`;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, API_KEYS } = process.env;

interface ResultObject {
  [key: string]: string;
}

console.log('apiDomain', {
  framework: 'express',
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
});

supertokens.init({
  framework: 'express',
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
                  await User.create({ ...result });
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
                console.log('isEmailExist', isEmailExist);
                if (isEmailExist === null) {
                  await User.create({ ...result });
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
    Session.init(), // initializes session features
  ],
});

const app = express();

interface errorObj extends Error {
  name: string;
  stack: any;
}

app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));
app.use(
  cors({
    origin: websiteDomain,
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  }),
);
app.use(middleware());

// your own error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log('ERROR SUPER TOKEN: ', err);
});

app.use('/csp', routes);

cron.schedule('* * * * *', () => {
  // This function will run every minute
  getallUsers();
  console.log('Running cron job...');
});

app.use((err: errorObj, req: Request, res: Response, next: NextFunction) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(401).send(err.message);
  }

  if (err) {
    console.log(err.stack || err);
    return res.status(500).send(err.message);
  }

  return next();
});

export default app;
