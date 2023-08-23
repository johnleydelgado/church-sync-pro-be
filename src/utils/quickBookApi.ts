/* eslint-disable @typescript-eslint/no-var-requires */
import { REALM_ID } from '../constant/config';

const QuickBooks = require('node-quickbooks');

export interface tokenProps {
  ACCESS_TOKEN: string;
  REFRESH_TOKEN: string;
  REALM_ID: string;
}

const { QBO_KEY: KEY, QBO_SECRET: SECRET, NODE_ENV } = process.env;

const quickBookApi = ({ ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID }: tokenProps) =>
  new QuickBooks(
    KEY,
    SECRET,
    ACCESS_TOKEN,
    false, // no token secret for oAuth 2.0
    REALM_ID,
    NODE_ENV === 'production' ? false : true, // use the sandbox?
    NODE_ENV === 'production' ? false : true, // enable debugging?
    null, // set minorversion, or null for the latest version
    '2.0', // oAuth version
    REFRESH_TOKEN,
  );

export default quickBookApi;
