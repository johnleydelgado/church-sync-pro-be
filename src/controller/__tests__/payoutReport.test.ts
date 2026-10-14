/**
 * The payout-report endpoints: who is recorded as acting, what they accept, and how each failure is
 * answered. Whether the caller may work on the church is the route guard's job (churchAccess tests);
 * these handlers run after it. The services are faked - their behaviour has its own integration tests.
 */
jest.mock('supertokens-node/recipe/thirdpartyemailpassword', () => ({ __esModule: true, default: { getUserById: jest.fn() } }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({ __esModule: true, default: { getUserById: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('../../services/payoutReport/importPayoutReport', () => {
  class PayoutImportSetupError extends Error {}
  class PayoutImportBusyError extends Error {}
  return { PayoutImportSetupError, PayoutImportBusyError, previewPayoutReport: jest.fn(), importPayoutReport: jest.fn() };
});
jest.mock('../../services/payoutReport/reviewPayoutRows', () => {
  class PayoutReviewError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  }
  return {
    PayoutReviewError,
    getPayoutStatus: jest.fn(),
    listReview: jest.fn(),
    listSignups: jest.fn(),
    recheckGiving: jest.fn(),
    resolvePayoutRow: jest.fn(),
  };
});

import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { PayoutReportFormatError } from '../../services/payoutReport/parsePayoutReport';
import * as importer from '../../services/payoutReport/importPayoutReport';
import * as review from '../../services/payoutReport/reviewPayoutRows';
import {
  payoutReportImport,
  payoutReportPreview,
  payoutReportRecheckGiving,
  payoutReportResolve,
  payoutReportReview,
  payoutReportSignups,
  payoutReportStatus,
} from '../payoutReport';

const CHURCH = 'church@example.test';
const BOOKKEEPER = 'bk@example.test';
const tpep = (ThirdPartyEmailPassword as any).getUserById as jest.Mock;
const ep = (EmailPassword as any).getUserById as jest.Mock;
const svc = {
  preview: importer.previewPayoutReport as jest.Mock,
  import: importer.importPayoutReport as jest.Mock,
  status: review.getPayoutStatus as jest.Mock,
  review: review.listReview as jest.Mock,
  signups: review.listSignups as jest.Mock,
  recheck: review.recheckGiving as jest.Mock,
  resolve: review.resolvePayoutRow as jest.Mock,
};

const makeReq = (o: { body?: any; query?: any; signedIn?: boolean } = {}) =>
  ({ body: o.body ?? {}, query: o.query ?? {}, session: o.signedIn === false ? undefined : { getUserId: () => 'st-1' } } as any);
const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const call = async (handler: any, req: any) => {
  const res = makeRes();
  await handler(req, res);
  return { code: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};
const CSV = 'Date,Type,Source,Name,Fund/Signup,Gross,Fee,Net,Payment method,Campus,Description\n';

beforeEach(() => {
  jest.resetAllMocks();
  tpep.mockResolvedValue({ id: 'st-1', email: CHURCH }); // signed in as the church itself
  ep.mockResolvedValue(undefined);
});

describe('who is asking', () => {
  test('the church itself', async () => {
    svc.status.mockResolvedValue({ ready: true });
    const { code, body } = await call(payoutReportStatus, makeReq({ query: { email: CHURCH } }));
    expect(code).toBe(200);
    expect(body).toMatchObject({ success: true, data: { ready: true } });
    expect(svc.status).toHaveBeenCalledWith(CHURCH);
  });

  test('a session whose user cannot be found is refused', async () => {
    tpep.mockResolvedValue(undefined);
    const { code, body } = await call(payoutReportReview, makeReq({ query: { email: CHURCH } }));
    expect(code).toBe(403);
    expect(body).toEqual({ success: false, message: "You don't have access to this church." });
    expect(svc.review).not.toHaveBeenCalled();
  });

  test('no church email is a bad request', async () => {
    const { code } = await call(payoutReportSignups, makeReq({ query: {} }));
    expect(code).toBe(400);
  });
});

describe('upload', () => {
  test('preview passes the file for the church named, not the caller', async () => {
    tpep.mockResolvedValue({ id: 'st-1', email: BOOKKEEPER });
    svc.preview.mockResolvedValue({ file: { rows: 0 } });
    const { code } = await call(payoutReportPreview, makeReq({ body: { email: CHURCH, csvText: CSV } }));
    expect(code).toBe(200);
    expect(svc.preview).toHaveBeenCalledWith({ email: CHURCH, csvText: CSV });
  });

  test('import records the signed-in user as the uploader, whatever the request says', async () => {
    tpep.mockResolvedValue({ id: 'st-1', email: BOOKKEEPER });
    svc.import.mockResolvedValue({ uploadId: 3 });
    await call(payoutReportImport, makeReq({ body: { email: CHURCH, csvText: CSV, fileName: 'oct.csv', uploadedBy: 'someone@else.test' } }));
    expect(svc.import).toHaveBeenCalledWith({ email: CHURCH, fileName: 'oct.csv', csvText: CSV, uploadedBy: BOOKKEEPER });
  });

  test.each([
    ['no file', undefined],
    ['an empty file', '   '],
    ['a file over 5 MB', 'x'.repeat(5 * 1024 * 1024 + 1)],
  ])('%s is a bad request', async (_name, csvText) => {
    const { code, body } = await call(payoutReportImport, makeReq({ body: { email: CHURCH, csvText } }));
    expect(code).toBe(400);
    expect(body.success).toBe(false);
    expect(svc.import).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  test.each([
    ['not a payout report', () => new PayoutReportFormatError('This is not a Planning Center payout report.'), 400],
    ['setup missing', () => new (importer as any).PayoutImportSetupError('Choose the clearing account on Mapping → Bank first.'), 409],
    ['another upload running', () => new (importer as any).PayoutImportBusyError('Another payout report is being recorded.'), 409],
  ])('%s -> %s with the message', async (_name, makeError, code) => {
    const error = makeError();
    svc.import.mockRejectedValue(error);
    const res = await call(payoutReportImport, makeReq({ body: { email: CHURCH, csvText: CSV } }));
    expect(res.code).toBe(code);
    expect(res.body).toEqual({ success: false, message: error.message });
  });

  test('a review error answers with its own status', async () => {
    svc.resolve.mockRejectedValue(new (review as any).PayoutReviewError('This line was already handled.', 409));
    const res = await call(payoutReportResolve, makeReq({ body: { email: CHURCH, id: 5, action: 'post' } }));
    expect(res).toEqual({ code: 409, body: { success: false, message: 'This line was already handled.' } });
  });

  test('anything else is a 500 that says nothing internal', async () => {
    svc.import.mockRejectedValue(new Error('relation "PayoutTransactions" does not exist'));
    const res = await call(payoutReportImport, makeReq({ body: { email: CHURCH, csvText: CSV } }));
    expect(res).toEqual({ code: 500, body: { success: false, message: 'Could not read the payout report' } });
    svc.status.mockRejectedValue(new Error('connection refused'));
    const status = await call(payoutReportStatus, makeReq({ query: { email: CHURCH } }));
    expect(status).toEqual({ code: 500, body: { success: false, message: 'Something went wrong with the payout reports. Try again in a minute.' } });
  });
});

describe('review actions', () => {
  test('resolve passes the action through and records who did it', async () => {
    svc.resolve.mockResolvedValue({ id: 5, status: 'dismissed' });
    const { code } = await call(
      payoutReportResolve,
      makeReq({ body: { email: CHURCH, id: '5', action: 'dismiss', note: 'by hand', resolvedBy: 'someone@else.test' } }),
    );
    expect(code).toBe(200);
    expect(svc.resolve).toHaveBeenCalledWith({
      email: CHURCH,
      id: 5,
      action: 'dismiss',
      account: null,
      class: null,
      note: 'by hand',
      qboEntryId: null,
      resolvedBy: CHURCH,
    });
  });

  test('resolve without a row id is a bad request', async () => {
    const { code } = await call(payoutReportResolve, makeReq({ body: { email: CHURCH, action: 'dismiss' } }));
    expect(code).toBe(400);
    expect(svc.resolve).not.toHaveBeenCalled();
  });

  test('check again and signups', async () => {
    svc.recheck.mockResolvedValue({ checked: 1, nowCovered: 1, stillNotPosted: 0 });
    svc.signups.mockResolvedValue(['SHE Conference 2026']);
    expect((await call(payoutReportRecheckGiving, makeReq({ body: { email: CHURCH } }))).body.data).toEqual({ checked: 1, nowCovered: 1, stillNotPosted: 0 });
    expect((await call(payoutReportSignups, makeReq({ query: { email: CHURCH } }))).body.data).toEqual(['SHE Conference 2026']);
  });
});
