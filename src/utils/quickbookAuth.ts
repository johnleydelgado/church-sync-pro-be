/* eslint-disable @typescript-eslint/no-var-requires */
const OAuthClient = require('intuit-oauth');

const { QBO_KEY: KEY, QBO_SECRET: SECRET } = process.env;

const quickbookAuth = new OAuthClient({
  clientId: KEY,
  clientSecret: SECRET,
  environment: 'sandbox',
  redirectUri: 'http://localhost:3000/qbo-planning-center-login',
});

export default quickbookAuth;
