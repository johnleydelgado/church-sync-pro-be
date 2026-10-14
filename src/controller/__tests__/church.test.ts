/**
 * The /church endpoints behind the Churches page and the People tab: what each hands the church
 * service and how each failure is answered. Whether the caller may work on the church is
 * requireChurch's job (churchAccess tests); the handlers behind it take the church and the actor from
 * what it left on res.locals, never from the request. The service is faked - it has its own
 * integration test.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
jest.mock('../../services/churchAccess', () => ({ actorFromSession: jest.fn() }));
jest.mock('../../services/churches', () => {
  class ChurchServiceError extends Error {
    constructor(
      message: string,
      public readonly status = 400,
    ) {
      super(message);
      this.name = 'ChurchServiceError';
    }
  }
  return {
    ChurchServiceError,
    createChurch: jest.fn(),
    invitePerson: jest.fn(),
    listMyChurches: jest.fn(),
    listPeople: jest.fn(),
    removePerson: jest.fn(),
    setIntegrationAccess: jest.fn(),
    updateChurch: jest.fn(),
  };
});

import { createLogger } from '../../utils/logger';
import { actorFromSession } from '../../services/churchAccess';
import * as churches from '../../services/churches';
import { addChurch, churchPeople, editChurch, invite, myChurches, personAccess, removeFromChurch } from '../church';

const { ChurchServiceError } = churches;
const log = createLogger('test') as any;
const fromSession = actorFromSession as jest.Mock;
const svc = {
  list: churches.listMyChurches as jest.Mock,
  create: churches.createChurch as jest.Mock,
  update: churches.updateChurch as jest.Mock,
  people: churches.listPeople as jest.Mock,
  invite: churches.invitePerson as jest.Mock,
  access: churches.setIntegrationAccess as jest.Mock,
  remove: churches.removePerson as jest.Mock,
};

const NO_ACCOUNT = 'Your account was not found. Sign out and sign in again.';
const ACTOR = { id: 2, email: 'bk@example.test', role: 'bookkeeper' };
/** The church requireChurch checked: id 5, filed under account row 10. */
const ACCESS = {
  church: { id: 5, name: 'Grace Church' },
  account: { id: 10, email: 'grace@example.test' },
  membership: { id: 7, role: 'owner' },
};
/** A church id in the request that is NOT the one the guard checked: handlers must not use it. */
const OTHER_CHURCH_ID = 999;

const makeReq = (o: { body?: any; query?: any; userId?: string } = {}) =>
  ({
    body: o.body ?? {},
    query: o.query ?? {},
    path: '/church/x',
    session: { getUserId: () => o.userId ?? 'st-user-2' },
  }) as any;
const makeRes = (locals: any) => {
  const res: any = { locals };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const call = async (handler: any, req: any, locals: any = { actor: ACTOR, churchAccess: ACCESS }) => {
  const res = makeRes(locals);
  await handler(req, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};
const ok = (data: unknown) => ({ code: 200, body: expect.objectContaining({ success: true, data }) });
const failed = (code: number, message: string) => ({ code, body: { success: false, message } });

beforeEach(() => {
  jest.resetAllMocks();
});

describe('myChurches', () => {
  it("lists the signed-in person's churches", async () => {
    const list = [{ id: 5, name: 'Grace Church', role: 'owner' }];
    fromSession.mockResolvedValue(ACTOR);
    svc.list.mockResolvedValue(list);
    expect(await call(myChurches, makeReq({ userId: 'st-abc' }), {})).toEqual(ok(list));
    expect(fromSession).toHaveBeenCalledWith('st-abc');
    expect(svc.list).toHaveBeenCalledWith(ACTOR);
  });

  it('answers 403 "sign in again" when the session has no Users row', async () => {
    fromSession.mockResolvedValue(null);
    expect(await call(myChurches, makeReq(), {})).toEqual(failed(403, NO_ACCOUNT));
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('answers 500 with a plain sentence, no internals, when something unexpected breaks', async () => {
    fromSession.mockResolvedValue(ACTOR);
    svc.list.mockRejectedValue(new Error('relation "Churches" does not exist'));
    expect(await call(myChurches, makeReq(), {})).toEqual(
      failed(500, 'Could not load your churches. Try again in a minute.'),
    );
    expect(log.error).toHaveBeenCalled();
  });

  it('answers 500 when the session lookup itself fails', async () => {
    fromSession.mockRejectedValue(new Error('SuperTokens core unreachable'));
    expect(await call(myChurches, makeReq(), {})).toEqual(
      failed(500, 'Could not load your churches. Try again in a minute.'),
    );
  });
});

describe('addChurch', () => {
  it('adds the church for the signed-in person and returns it', async () => {
    const created = { id: 6, name: 'Hope Church', role: 'owner' };
    fromSession.mockResolvedValue(ACTOR);
    svc.create.mockResolvedValue(created);
    expect(await call(addChurch, makeReq({ body: { name: 'Hope Church' } }), {})).toEqual(ok(created));
    expect(svc.create).toHaveBeenCalledWith(ACTOR, 'Hope Church');
  });

  it('answers 403 "sign in again" when the session has no Users row', async () => {
    fromSession.mockResolvedValue(null);
    expect(await call(addChurch, makeReq({ body: { name: 'Hope Church' } }), {})).toEqual(failed(403, NO_ACCOUNT));
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("passes the service's 409 and 400 on with their sentences", async () => {
    fromSession.mockResolvedValue(ACTOR);
    svc.create.mockRejectedValueOnce(new ChurchServiceError('You already have a church called Hope Church.', 409));
    expect(await call(addChurch, makeReq({ body: { name: 'Hope Church' } }), {})).toEqual(
      failed(409, 'You already have a church called Hope Church.'),
    );
    svc.create.mockRejectedValueOnce(new ChurchServiceError('Enter the church name.'));
    expect(await call(addChurch, makeReq({ body: { name: ' ' } }), {})).toEqual(failed(400, 'Enter the church name.'));
  });

  it('answers 500 "Could not add the church." for anything else', async () => {
    fromSession.mockResolvedValue(ACTOR);
    svc.create.mockRejectedValue(new Error('deadlock detected'));
    expect(await call(addChurch, makeReq({ body: { name: 'Hope Church' } }), {})).toEqual(
      failed(500, 'Could not add the church. Try again in a minute.'),
    );
  });
});

describe('editChurch', () => {
  it('updates the church the guard checked, as the actor it found, with the name and active flag', async () => {
    svc.update.mockResolvedValue(undefined);
    const req = makeReq({ body: { churchId: OTHER_CHURCH_ID, name: 'Grace Chapel', isActive: false } });
    expect(await call(editChurch, req)).toEqual(ok('ok'));
    expect(svc.update).toHaveBeenCalledWith(ACCESS, ACTOR, { name: 'Grace Chapel', isActive: false });
    expect(svc.update.mock.calls[0][0]).toBe(ACCESS);
    expect(svc.update.mock.calls[0][1]).toBe(ACTOR);
  });

  it('leaves out what the request did not send', async () => {
    svc.update.mockResolvedValue(undefined);
    await call(editChurch, makeReq({ body: { churchId: 5, isActive: true } }));
    expect(svc.update.mock.calls[0][2]).toEqual({ name: undefined, isActive: true });
  });

  it("passes the service's 409, 403 and 404 on with their sentences", async () => {
    svc.update.mockRejectedValueOnce(new ChurchServiceError('You already have a church called Hope Church.', 409));
    expect(await call(editChurch, makeReq({ body: { churchId: 5, name: 'Hope Church' } }))).toEqual(
      failed(409, 'You already have a church called Hope Church.'),
    );
    svc.update.mockRejectedValueOnce(new ChurchServiceError('Only an owner of this church can do that.', 403));
    expect(await call(editChurch, makeReq({ body: { churchId: 5, name: 'X' } }))).toEqual(
      failed(403, 'Only an owner of this church can do that.'),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'church action refused',
      expect.objectContaining({ actorId: 2, accountId: 10 }),
    );
    svc.update.mockRejectedValueOnce(new ChurchServiceError('Church not found.', 404));
    expect(await call(editChurch, makeReq({ body: { churchId: 5, name: 'X' } }))).toEqual(
      failed(404, 'Church not found.'),
    );
  });

  it('answers 500 "Could not update the church." for anything else', async () => {
    svc.update.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(await call(editChurch, makeReq({ body: { churchId: 5, name: 'X' } }))).toEqual(
      failed(500, 'Could not update the church. Try again in a minute.'),
    );
  });
});

describe('churchPeople', () => {
  it('lists the people on the church the guard checked, marking the actor it found', async () => {
    const people = [{ memberId: 7, role: 'owner', email: 'bk@example.test', status: 'active', isYou: true }];
    svc.people.mockResolvedValue(people);
    expect(await call(churchPeople, makeReq({ query: { churchId: String(OTHER_CHURCH_ID) } }))).toEqual(ok(people));
    expect(svc.people).toHaveBeenCalledWith(ACCESS, ACTOR);
    expect(svc.people.mock.calls[0][0]).toBe(ACCESS);
  });

  it('answers 500 "Could not load the people on this church." for anything unexpected', async () => {
    svc.people.mockRejectedValue(new Error('connection terminated'));
    expect(await call(churchPeople, makeReq({ query: { churchId: '5' } }))).toEqual(
      failed(500, 'Could not load the people on this church. Try again in a minute.'),
    );
  });
});

describe('invite', () => {
  it('invites the address sent to the church the guard checked, and returns the result', async () => {
    const result = { memberId: 8, addedExisting: false, inviteLink: 'https://x.test/invite?t=1', emailSent: false };
    svc.invite.mockResolvedValue(result);
    const req = makeReq({ body: { churchId: OTHER_CHURCH_ID, email: 'new@example.test' } });
    expect(await call(invite, req)).toEqual(ok(result));
    expect(svc.invite).toHaveBeenCalledWith(ACCESS, 'new@example.test');
    expect(svc.invite.mock.calls[0][0]).toBe(ACCESS);
  });

  it("passes the service's 409 and 400 on with their sentences", async () => {
    svc.invite.mockRejectedValueOnce(new ChurchServiceError('new@example.test is already on this church.', 409));
    expect(await call(invite, makeReq({ body: { churchId: 5, email: 'new@example.test' } }))).toEqual(
      failed(409, 'new@example.test is already on this church.'),
    );
    svc.invite.mockRejectedValueOnce(new ChurchServiceError('Enter a valid email address.'));
    expect(await call(invite, makeReq({ body: { churchId: 5, email: 'nope' } }))).toEqual(
      failed(400, 'Enter a valid email address.'),
    );
  });

  it('answers 500 "Could not send the invite." for anything else', async () => {
    svc.invite.mockRejectedValue(new Error('INVITATION_URL is not set'));
    expect(await call(invite, makeReq({ body: { churchId: 5, email: 'new@example.test' } }))).toEqual(
      failed(500, 'Could not send the invite. Try again in a minute.'),
    );
  });
});

describe('personAccess', () => {
  it('sets integration access for the member named, on the church the guard checked', async () => {
    svc.access.mockResolvedValue(undefined);
    const req = makeReq({ body: { churchId: OTHER_CHURCH_ID, memberId: 8, integrationAccessEnabled: true } });
    expect(await call(personAccess, req)).toEqual(ok('ok'));
    expect(svc.access).toHaveBeenCalledWith(ACCESS, 8, true);
    expect(svc.access.mock.calls[0][0]).toBe(ACCESS);
  });

  it("passes the service's 400 for an owner row and 404 for someone not on the church", async () => {
    svc.access.mockRejectedValueOnce(
      new ChurchServiceError('Owners can always connect QuickBooks and Planning Center.'),
    );
    expect(
      await call(personAccess, makeReq({ body: { churchId: 5, memberId: 7, integrationAccessEnabled: false } })),
    ).toEqual(failed(400, 'Owners can always connect QuickBooks and Planning Center.'));
    svc.access.mockRejectedValueOnce(new ChurchServiceError('That person is not on this church.', 404));
    expect(
      await call(personAccess, makeReq({ body: { churchId: 5, memberId: 99, integrationAccessEnabled: true } })),
    ).toEqual(failed(404, 'That person is not on this church.'));
  });

  it('answers 500 "Could not change their access." for anything else', async () => {
    svc.access.mockRejectedValue(new Error('boom'));
    expect(
      await call(personAccess, makeReq({ body: { churchId: 5, memberId: 8, integrationAccessEnabled: true } })),
    ).toEqual(failed(500, 'Could not change their access. Try again in a minute.'));
  });
});

describe('removeFromChurch', () => {
  it('removes the member named from the church the guard checked', async () => {
    svc.remove.mockResolvedValue(undefined);
    expect(await call(removeFromChurch, makeReq({ body: { churchId: OTHER_CHURCH_ID, memberId: 8 } }))).toEqual(
      ok('ok'),
    );
    expect(svc.remove).toHaveBeenCalledWith(ACCESS, 8);
    expect(svc.remove.mock.calls[0][0]).toBe(ACCESS);
  });

  it("passes the service's 409 for the last owner on with its sentence", async () => {
    svc.remove.mockRejectedValue(new ChurchServiceError('A church needs at least one owner.', 409));
    expect(await call(removeFromChurch, makeReq({ body: { churchId: 5, memberId: 7 } }))).toEqual(
      failed(409, 'A church needs at least one owner.'),
    );
  });

  it('answers 500 "Could not remove them." for anything else', async () => {
    svc.remove.mockRejectedValue(new Error('boom'));
    expect(await call(removeFromChurch, makeReq({ body: { churchId: 5, memberId: 8 } }))).toEqual(
      failed(500, 'Could not remove them. Try again in a minute.'),
    );
  });
});

describe('a handler reached without requireChurch in front of it', () => {
  const guardedHandlers: [string, any, jest.Mock][] = [
    ['editChurch', editChurch, svc.update],
    ['churchPeople', churchPeople, svc.people],
    ['invite', invite, svc.invite],
    ['personAccess', personAccess, svc.access],
    ['removeFromChurch', removeFromChurch, svc.remove],
  ];

  it.each(guardedHandlers)('%s refuses rather than act on a church nobody checked', async (_name, handler, service) => {
    const req = makeReq({ body: { churchId: 5, memberId: 8, email: 'x@example.test', name: 'X' } });
    expect(await call(handler, req, {})).toEqual(failed(403, "You don't have access to this church."));
    expect(await call(handler, req, { churchAccess: ACCESS })).toEqual(
      failed(403, "You don't have access to this church."),
    );
    expect(service).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('church route reached without its church guard', { path: '/church/x' });
  });
});
