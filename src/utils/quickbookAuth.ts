/* eslint-disable @typescript-eslint/no-var-requires */
const OAuthClient = require('intuit-oauth');

const { QBO_KEY: KEY, QBO_SECRET: SECRET, PC_REDIRECT, NODE_ENV } = process.env;

const quickbookAuth = new OAuthClient({
  clientId: KEY,
  clientSecret: SECRET,
  environment: NODE_ENV === 'development' ? 'sandbox' : 'production',
  redirectUri: PC_REDIRECT,
});

export default quickbookAuth;
