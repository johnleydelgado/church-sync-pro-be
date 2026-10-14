import { Response } from 'express';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import type Users from '../db/models/user';
import { responseSuccess } from '../utils/response';
import { actorFromSession } from '../services/churchAccess';
import type { ChurchAccess } from '../services/churchAccess';
import {
  ChurchServiceError,
  createChurch,
  invitePerson,
  listMyChurches,
  listPeople,
  removePerson,
  setIntegrationAccess,
  updateChurch,
} from '../services/churches';
import { createLogger } from '../utils/logger';
import { withoutAddresses } from '../utils/withoutAddresses';

const logger = createLogger('church-endpoints');

/**
 * The Churches page and the People tab (routes/routers.ts, churchRoutes). The rules live in
 * services/churches.ts; this file only reads the request and turns errors into answers.
 *
 * /church/mine and /church/create name no church: they work from the signed-in person alone. Every
 * other route runs requireChurch first, which checks the churchId in the request and leaves the
 * church and the person on res.locals. Those handlers read them from there and never read
 * churchId themselves, so they can only touch the church that was checked.
 */

const NO_ACCOUNT = 'Your account was not found. Sign out and sign in again.';
const NO_ACCESS = "You don't have access to this church.";

const refused = (res: Response, message: string) => res.status(403).json({ success: false, message });

const fail = (req: SessionRequest, res: Response, e: unknown, fallback: string, ids: Record<string, unknown> = {}) => {
  if (e instanceof ChurchServiceError) {
    // The route's guard let them through but the service said no: the route asks for the wrong need.
    if (e.status === 403) logger.warn('church action refused', { path: req.path, ...ids });
    return res.status(e.status).json({ success: false, message: e.message });
  }
  logger.error(fallback, {
    path: req.path,
    ...ids,
    error: withoutAddresses(e instanceof Error ? e.message : String(e)),
  });
  return res.status(500).json({ success: false, message: `${fallback} Try again in a minute.` });
};

type Endpoint = (req: SessionRequest, res: Response) => Promise<unknown>;

/** The wrappers below return anonymous functions; name each after its export for stack traces. */
const named = (name: string, fn: Endpoint): Endpoint => Object.defineProperty(fn, 'name', { value: name });

type AsActor = (req: SessionRequest, res: Response, actor: Users) => Promise<unknown>;

/** For the routes that name no church: the signed-in person's own Users row, or 403. */
const asSignedIn = (name: string, handler: AsActor, fallback: string) =>
  named(name, async (req, res) => {
    let actor: Users | null = null;
    try {
      actor = await actorFromSession(req.session?.getUserId());
      if (!actor) {
        logger.warn('church action refused: no Users row for the session', { path: req.path });
        return refused(res, NO_ACCOUNT);
      }
      return await handler(req, res, actor);
    } catch (e) {
      return fail(req, res, e, fallback, { actorId: actor?.id });
    }
  });

type OnChurch = (req: SessionRequest, res: Response, access: ChurchAccess, actor: Users) => Promise<unknown>;

/** For the routes behind requireChurch: the church and the person it checked. */
const onCheckedChurch = (name: string, handler: OnChurch, fallback: string) =>
  named(name, async (req, res) => {
    const access: ChurchAccess | undefined = res.locals?.churchAccess;
    const actor: Users | undefined = res.locals?.actor;
    if (!access || !actor) {
      logger.error('church route reached without its church guard', { path: req.path });
      return refused(res, NO_ACCESS);
    }
    try {
      return await handler(req, res, access, actor);
    } catch (e) {
      return fail(req, res, e, fallback, { actorId: actor.id, accountId: access.account?.id });
    }
  });

/** GET /church/mine -> MyChurch[] */
export const myChurches = asSignedIn(
  'myChurches',
  async (_req, res, actor) => responseSuccess(res, await listMyChurches(actor)),
  'Could not load your churches.',
);

/** POST /church/create { name } -> MyChurch */
export const addChurch = asSignedIn(
  'addChurch',
  async (req, res, actor) => responseSuccess(res, await createChurch(actor, req.body?.name)),
  'Could not add the church.',
);

/** POST /church/update { churchId, name?, isActive? } -> 'ok' (owner) */
export const editChurch = onCheckedChurch(
  'editChurch',
  async (req, res, access, actor) => {
    await updateChurch(access, actor, { name: req.body?.name, isActive: req.body?.isActive });
    return responseSuccess(res, 'ok');
  },
  'Could not update the church.',
);

/** GET /church/people?churchId= -> ChurchPerson[] (member) */
export const churchPeople = onCheckedChurch(
  'churchPeople',
  async (_req, res, access, actor) => responseSuccess(res, await listPeople(access, actor)),
  'Could not load the people on this church.',
);

/** POST /church/people/invite { churchId, email } -> InviteResult (owner) */
export const inviteToChurch = onCheckedChurch(
  'inviteToChurch',
  async (req, res, access) => responseSuccess(res, await invitePerson(access, req.body?.email)),
  'Could not send the invite.',
);

/** POST /church/people/access { churchId, memberId, integrationAccessEnabled } -> 'ok' (owner) */
export const personAccess = onCheckedChurch(
  'personAccess',
  async (req, res, access) => {
    await setIntegrationAccess(access, req.body?.memberId, req.body?.integrationAccessEnabled);
    return responseSuccess(res, 'ok');
  },
  'Could not change their access.',
);

/** POST /church/people/remove { churchId, memberId } -> 'ok' (owner) */
export const removeFromChurch = onCheckedChurch(
  'removeFromChurch',
  async (req, res, access) => {
    await removePerson(access, req.body?.memberId);
    return responseSuccess(res, 'ok');
  },
  'Could not remove them.',
);
