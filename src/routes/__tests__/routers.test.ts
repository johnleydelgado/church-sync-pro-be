/**
 * Every route behind a session also checks the church it names (services/churchAccess.ts), unless
 * it is in UNGUARDED below with the reason. A route added without a guard fails here instead of
 * quietly trusting the email in the request. Read from the mounted router itself, so the check is on
 * what Express will run, not on what routers.ts appears to say.
 *
 * Controllers are stand-ins named after their exports; the guards are the real ones.
 */
function mockController() {
  const made: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string' || prop.startsWith('__') || prop === 'then') return undefined;
        if (!made[prop]) made[prop] = Object.defineProperty(() => undefined, 'name', { value: prop });
        return made[prop];
      },
    },
  );
}
jest.mock('../../controller', mockController);
jest.mock('../../controller/auth', mockController);
jest.mock('../../controller/planning-center', mockController);
jest.mock('../../controller/user', mockController);
jest.mock('../../controller/db', mockController);
jest.mock('../../controller/qbo', mockController);
jest.mock('../../controller/stripe', mockController);
jest.mock('../../controller/automation', mockController);
jest.mock('../../controller/payoutReport', mockController);
jest.mock('../../controller/journalEntry', mockController);
jest.mock('../../controller/church', mockController);
jest.mock('supertokens-node/recipe/session/framework/express', () => ({
  verifySession: () => Object.assign(() => undefined, { mockVerifySession: true }),
}));
// What services/churchAccess.ts loads; nothing here runs a request.
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ __esModule: true, default: {} }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/church', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/churchMember', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/user', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/tokens', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/tokenEntity', () => ({ __esModule: true, default: {} }));
jest.mock('../../db/models/bookkeeper', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import routers from '../routers';
import { isChurchGuard } from '../../services/churchAccess';

/** Behind a session but naming no church, on purpose. Keyed by handler. */
const UNGUARDED: Record<string, string> = {
  authQuickBook: 'OAuth start: no church yet; the token is filed by the guarded updateUserToken',
  authPlanningCenter: 'OAuth start: as authQuickBook',
  callBackQBO: 'OAuth callback: returns the token to the browser, which files it via updateUserToken',
  callBackPC: 'OAuth callback: as callBackQBO',
  healthCheck: 'answers whether the session exists, nothing else',
  createPaymentIntent: "the email is the subscription form's, not a church's",
  createUser: 'Google sign-up: no Users row exists yet to check against',
  myChurches: "lists the signed-in person's own churches, found from the session; names no church",
  addChurch: 'creates a church the signed-in person will own, found from the session; names no church',
};

/** With no session at all. Keyed by handler. */
const PUBLIC: Record<string, string> = {
  tesst: '`/` answers "working"',
  authStripe: 'Stripe OAuth start (Stripe Connect is not in use)',
  callBackStripe: 'Stripe OAuth callback',
  sendPasswordReset: 'before sign-in',
  resetPassword: 'before sign-in; the mailed token is the credential',
  checkValidInvitation: 'before sign-in; the invitation token is the credential',
  updateInvitationStatus: 'before sign-in; the invitation token is the credential',
};

/** Guards that ask for more than membership. Every other guarded route asks for 'member'. */
const NEEDS: Record<string, 'integrations' | 'owner'> = {
  updateUserToken: 'integrations',
  deleteUserToken: 'integrations',
  addTokenInUser: 'owner',
  updateUserData: 'owner',
  toggleUserActiveStatus: 'owner',
  sendEmailInvitation: 'owner',
  deleteBookeeper: 'owner',
  editChurch: 'owner',
  inviteToChurch: 'owner',
  personAccess: 'owner',
  removeFromChurch: 'owner',
};

type Mounted = { path: string; method: string; handler: string; chain: any[] };

const mounted: Mounted[] = (routers as any).stack
  .filter((layer: any) => layer.route)
  .map((layer: any) => {
    const chain = layer.route.stack.map((l: any) => l.handle);
    const method = Object.keys(layer.route.methods).join(',').toUpperCase();
    return { path: layer.route.path, method, handler: chain[chain.length - 1].name, chain };
  });

const hasSession = (r: Mounted) => r.chain.some((fn) => fn.mockVerifySession === true);
const guardsOf = (r: Mounted) => r.chain.filter(isChurchGuard);
const label = (r: Mounted) => `${r.path} -> ${r.handler}`;

it('reads the real router', () => {
  expect(mounted.length).toBeGreaterThan(50);
  expect(mounted.every((r) => r.handler)).toBe(true);
});

it('puts exactly one church guard between verifySession() and the handler on every session route', () => {
  const missing = mounted
    .filter((r) => hasSession(r) && !(r.handler in UNGUARDED))
    .filter((r) => {
      const guards = guardsOf(r);
      return !(
        guards.length === 1 &&
        r.chain.length === 3 &&
        r.chain[0].mockVerifySession === true &&
        r.chain[1] === guards[0]
      );
    })
    .map(label);
  expect(missing).toEqual([]);
});

it('leaves only the listed session routes unguarded, and every listed one exists', () => {
  const unguarded = mounted.filter((r) => hasSession(r) && guardsOf(r).length === 0).map((r) => r.handler);
  expect(unguarded.sort()).toEqual(Object.keys(UNGUARDED).sort());
});

it('has no route without a session other than the public ones and the scheduler', () => {
  const open = mounted
    .filter((r) => !hasSession(r) && r.chain[0].name !== 'requireAutomationKey')
    .map((r) => r.handler);
  expect(open.sort()).toEqual(Object.keys(PUBLIC).sort());
});

it('asks each guarded route for the right need', () => {
  const needs = Object.fromEntries(
    mounted.filter((r) => guardsOf(r).length).map((r) => [r.handler, guardsOf(r)[0].need]),
  );
  for (const [handler, need] of Object.entries(NEEDS)) expect([handler, needs[handler]]).toEqual([handler, need]);
  const others = Object.entries(needs).filter(([handler]) => !(handler in NEEDS));
  expect(others.filter(([, need]) => need !== 'member')).toEqual([]);
  expect(others.length).toBeGreaterThan(30);
});

it('mounts the /church routes as the API contract gives them', () => {
  const church = mounted
    .filter((r) => r.path.startsWith('/church/'))
    .map((r) => ({
      route: `${r.method} ${r.path}`,
      handler: r.handler,
      session: hasSession(r),
      need: guardsOf(r)[0]?.need ?? null,
      kind: guardsOf(r)[0]?.kind ?? null,
    }));
  // mine and create name no church: they work from the session alone (UNGUARDED above).
  const session = true;
  expect(church).toEqual([
    { route: 'GET /church/mine', handler: 'myChurches', session, need: null, kind: null },
    { route: 'POST /church/create', handler: 'addChurch', session, need: null, kind: null },
    { route: 'POST /church/update', handler: 'editChurch', session, need: 'owner', kind: 'church' },
    { route: 'GET /church/people', handler: 'churchPeople', session, need: 'member', kind: 'church' },
    { route: 'POST /church/people/invite', handler: 'inviteToChurch', session, need: 'owner', kind: 'church' },
    { route: 'POST /church/people/access', handler: 'personAccess', session, need: 'owner', kind: 'church' },
    { route: 'POST /church/people/remove', handler: 'removeFromChurch', session, need: 'owner', kind: 'church' },
  ]);
});

it('checks the church by churchId on the /church/ routes, and by account on every other route', () => {
  const guarded = mounted.filter((r) => guardsOf(r).length);
  const wrongKind = guarded
    .filter((r) => guardsOf(r)[0].kind !== (r.path.startsWith('/church/') ? 'church' : 'account'))
    .map((r) => `${label(r)} (${guardsOf(r)[0].kind})`);
  expect(wrongKind).toEqual([]);
  expect(guarded.filter((r) => guardsOf(r)[0].kind === 'church').length).toBe(5);
});

it('no longer mounts updateUser', () => {
  expect(mounted.map((r) => r.handler)).not.toContain('updateUser');
});
