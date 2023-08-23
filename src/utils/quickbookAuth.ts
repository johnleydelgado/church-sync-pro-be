/* eslint-disable @typescript-eslint/no-var-requires */
const OAuthClient = require('intuit-oauth');

const { QBO_KEY: KEY, QBO_SECRET: SECRET, PC_REDIRECT, NODE_ENV } = process.env;

const quickbookAuth = new OAuthClient({
  clientId: KEY,
  clientSecret: SECRET,
  environment: NODE_ENV === 'production' ? 'production' : 'sandbox',
  redirectUri: PC_REDIRECT,
});

export default quickbookAuth;
