/**
 * Connecting QuickBooks or Planning Center starts at GET /authQB or /authPC, which hands the browser
 * the provider's sign-in address. The browser makes a fresh `state` for each connect (16 to 32 random
 * bytes as lowercase hex), keeps it, and refuses a return that carries any other - so a sign-in this
 * browser never started (an attacker's code, filing the attacker's books under this church) cannot be
 * finished here. These pin the server's half: no address without a well-formed state, and the
 * provider gets exactly that state. QuickBooks used to get a fixed 'intuit-test', Planning Center none.
 *
 * Stripe Connect (authStripe / callBackStripe) is gone: CSP cannot use it.
 */
// The real intuit-oauth client, so the address checked is the one Intuit receives; only its settings
// are the test's (quickbookAuth.ts reads them from the environment and the sandbox flag). A function
// declaration, not a const: jest hoists jest.mock() above everything else in the file.
function mockQuickbookAuth() {
  const OAuthClient = jest.requireActual('intuit-oauth');
  return {
    __esModule: true,
    default: new OAuthClient({
      clientId: 'qbo-client-id',
      clientSecret: 'qbo-client-secret',
      environment: 'sandbox',
      redirectUri: 'https://app.example.test/accounts-token/callback',
    }),
  };
}
jest.mock('../../utils/quickbookAuth', mockQuickbookAuth);
// auth.ts imports the Users model; nothing here reaches the database.
jest.mock('../../db/models/user', () => ({ __esModule: true, default: {} }));

import quickbookAuth from '../../utils/quickbookAuth';

const REDIRECT = 'https://app.example.test/accounts-token/callback';
const saved = { PC_CLIENT_ID: process.env.PC_CLIENT_ID, PC_REDIRECT: process.env.PC_REDIRECT };
// auth.ts reads the Planning Center settings once, when it loads: set them first, then load it.
process.env.PC_CLIENT_ID = 'pco-client-id';
process.env.PC_REDIRECT = REDIRECT;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const auth: typeof import('../auth') = require('../auth');

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() => jest.restoreAllMocks());

const SHORTEST = '0123456789abcdef'.repeat(2); // 16 bytes
const LONGEST = 'fedcba9876543210'.repeat(4); // 32 bytes

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};
type Start = 'authQuickBook' | 'authPlanningCenter';
const start = async (handler: Start, state: unknown) => {
  const res = makeRes();
  await auth[handler]({ query: state === undefined ? {} : { state } } as any, res);
  return res;
};
const addressSent = (res: any): string => res.send.mock.calls[0][0];

describe.each([
  ['QuickBooks (GET /authQB)', 'authQuickBook'],
  ['Planning Center (GET /authPC)', 'authPlanningCenter'],
] as [string, Start][])('%s', (_provider, handler) => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['31 characters (too short)', SHORTEST.slice(1)],
    ['65 characters (too long)', `0${LONGEST}`],
    ['uppercase hex', SHORTEST.toUpperCase()],
    ['not hex', `g${SHORTEST.slice(1)}`],
    ["the old fixed 'intuit-test'", 'intuit-test'],
    ['hex with a trailing newline', `${SHORTEST}\n`],
    ['hex with spaces around it', ` ${SHORTEST} `],
    ['hex with another parameter after it', `${SHORTEST}&state=${LONGEST}`],
    ['an array (?state=a&state=b)', [SHORTEST, LONGEST]],
    ['a one-item array (?state[]=a)', [SHORTEST]],
    ['an object (?state[a]=b)', { a: SHORTEST }],
  ])('refuses a state that is %s, with 400 and no address', async (_why, state) => {
    const authorizeUri = jest.spyOn(quickbookAuth, 'authorizeUri');
    const res = await start(handler, state);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Missing or invalid state' });
    expect(res.send).not.toHaveBeenCalled();
    expect(authorizeUri).not.toHaveBeenCalled();
  });

  it.each([
    ['32 characters (16 bytes)', SHORTEST],
    ['64 characters (32 bytes)', LONGEST],
  ])('sends the bare address, carrying exactly the state it was given: %s', async (_why, state) => {
    const res = await start(handler, state);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledTimes(1);
    // A plain string, as before: the browser's authApi hands response.data straight to the redirect.
    expect(typeof addressSent(res)).toBe('string');
    expect(new URL(addressSent(res)).searchParams.getAll('state')).toEqual([state]);
  });
});

it('QuickBooks: the rest of the address is unchanged (Intuit, this app, accounting + openid)', async () => {
  const res = await start('authQuickBook', LONGEST);
  const url = new URL(addressSent(res));
  expect(`${url.origin}${url.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    redirect_uri: REDIRECT,
    client_id: 'qbo-client-id',
    scope: 'com.intuit.quickbooks.accounting openid',
    state: LONGEST,
  });
});

it('Planning Center: the address is the one it always was, with &state= on the end', async () => {
  const res = await start('authPlanningCenter', LONGEST);
  expect(res.send).toHaveBeenCalledWith(
    `https://api.planningcenteronline.com/oauth/authorize?client_id=pco-client-id&redirect_uri=${REDIRECT}` +
      `&response_type=code&scope=giving+calendar&state=${LONGEST}`,
  );
});

it('no longer offers Stripe Connect (authStripe / callBackStripe): CSP cannot use it', () => {
  expect(auth).not.toHaveProperty('authStripe');
  expect(auth).not.toHaveProperty('callBackStripe');
});
