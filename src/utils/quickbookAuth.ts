/* eslint-disable @typescript-eslint/no-var-requires */
const OAuthClient = require('intuit-oauth');
import { useSandbox } from './quickBookApi';

const { QBO_KEY: KEY, QBO_SECRET: SECRET, PC_REDIRECT } = process.env;

// Must agree with quickBookApi's sandbox choice. Authorizing against a real Intuit company
// and then calling the sandbox API (or the reverse) leaves the connection pointing at books
// the rest of the app cannot read or write.
const quickbookAuth = new OAuthClient({
  clientId: KEY,
  clientSecret: SECRET,
  environment: useSandbox() ? 'sandbox' : 'production',
  redirectUri: PC_REDIRECT,
});

export default quickbookAuth;
