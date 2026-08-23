/* eslint-disable @typescript-eslint/no-var-requires */
const QuickBooks = require('node-quickbooks');

export interface tokenProps {
  ACCESS_TOKEN: string;
  REFRESH_TOKEN: string;
  REALM_ID: string;
}

const { QBO_KEY: KEY, QBO_SECRET: SECRET, NODE_ENV, QBO_USE_SANDBOX } = process.env;

/**
 * Whether to talk to the QuickBooks *sandbox* rather than a real company file.
 *
 * `QBO_USE_SANDBOX` decides this explicitly. It exists because deployment-environment naming
 * and "which QuickBooks am I writing to" are separate questions: an environment named
 * "production" may still be a test stack that must never post to a customer's real books.
 * Tying the two together makes real-QBO writes an accident waiting to happen.
 *
 * When unset, falls back to the previous behaviour (real QBO only when NODE_ENV=production)
 * so existing deployments are unaffected until they opt in.
 */
export const useSandbox = (): boolean => {
  if (QBO_USE_SANDBOX !== undefined && QBO_USE_SANDBOX !== '') {
    return String(QBO_USE_SANDBOX).toLowerCase() !== 'false';
  }
  return NODE_ENV !== 'production';
};

const quickBookApi = ({ ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID }: tokenProps) =>
  new QuickBooks(
    KEY,
    SECRET,
    ACCESS_TOKEN,
    false, // no token secret for oAuth 2.0
    REALM_ID,
    useSandbox(), // use the sandbox?
    useSandbox(), // enable debugging?
    null, // set minorversion, or null for the latest version
    '2.0', // oAuth version
    REFRESH_TOKEN,
  );

export default quickBookApi;
