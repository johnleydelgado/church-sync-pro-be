/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import { responseSuccess } from '../utils/response';
import { createLogger } from '../utils/logger';
import { PayoutReportFormatError } from '../services/payoutReport/parsePayoutReport';
import {
  importPayoutReport,
  previewPayoutReport,
  PayoutImportBusyError,
  PayoutImportSetupError,
} from '../services/payoutReport/importPayoutReport';
import {
  getPayoutStatus,
  listReview,
  listSignups,
  PayoutReviewError,
  recheckGiving,
  resolvePayoutRow,
} from '../services/payoutReport/reviewPayoutRows';

const logger = createLogger('payout-report');

const MAX_CSV_BYTES = 5 * 1024 * 1024;

const fail = (res: Response, e: unknown, fallback: string) => {
  if (e instanceof PayoutReportFormatError) return res.status(400).json({ success: false, message: e.message });
  if (e instanceof PayoutImportSetupError || e instanceof PayoutImportBusyError) {
    return res.status(409).json({ success: false, message: e.message });
  }
  if (e instanceof PayoutReviewError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error('payout report endpoint failed', { error: e instanceof Error ? e.message : String(e) });
  return res.status(500).json({ success: false, message: fallback });
};

type Handler = (req: SessionRequest, res: Response, actor: string, church: string) => Promise<unknown>;

/**
 * Hands the handler who is asking and for which church, and maps errors to answers. Both come from
 * the route guard (requireAccountAccess in routes/routers.ts), which has run first and checked the
 * caller may work on that church: the actor is the signed-in person's Users row, the church its
 * account row. Nothing is read from the request again.
 */
const forChurch =
  (handler: Handler, fallback = 'Something went wrong with the payout reports. Try again in a minute.') =>
  async (req: SessionRequest, res: Response) => {
    const actor = res.locals?.actor?.email;
    const church = res.locals?.churchAccess?.account?.email;
    if (!actor || !church) {
      logger.error('payout report route reached without its church guard', { path: req.path });
      return res.status(403).json({ success: false, message: "You don't have access to this church." });
    }
    try {
      return await handler(req, res, String(actor), String(church));
    } catch (e) {
      return fail(res, e, fallback);
    }
  };

const csvFrom = (req: SessionRequest): string => {
  const csvText = req.body?.csvText;
  if (typeof csvText !== 'string' || !csvText.trim()) {
    throw new PayoutReportFormatError('Choose a payout report file to upload.');
  }
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    throw new PayoutReportFormatError('That file is over 5 MB, which is too large for a payout report.');
  }
  return csvText;
};

const READ_FAILED = 'Could not read the payout report';

/** "Payouts in this file: from / to" - checked by the service, which says what is wrong in words. */
const payoutDatesFrom = (req: SessionRequest) => ({ payoutFrom: req.body?.payoutFrom, payoutTo: req.body?.payoutTo });

export const payoutReportPreview = forChurch(
  async (req, res, _actor, church) =>
    responseSuccess(res, await previewPayoutReport({ email: church, csvText: csvFrom(req), ...payoutDatesFrom(req) })),
  READ_FAILED,
);

export const payoutReportImport = forChurch(
  async (req, res, actor, church) =>
    responseSuccess(
      res,
      await importPayoutReport({
        email: church,
        fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : null,
        csvText: csvFrom(req),
        uploadedBy: actor, // who is signed in, never what the request says
        ...payoutDatesFrom(req),
      }),
    ),
  READ_FAILED,
);

export const payoutReportStatus = forChurch(async (_req, res, _actor, church) =>
  responseSuccess(res, await getPayoutStatus(church)),
);

export const payoutReportReview = forChurch(async (_req, res, _actor, church) =>
  responseSuccess(res, await listReview(church)),
);

export const payoutReportResolve = forChurch(async (req, res, actor, church) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id <= 0) throw new PayoutReviewError('id is required');
  return responseSuccess(
    res,
    await resolvePayoutRow({
      email: church,
      id,
      action: req.body?.action,
      account: req.body?.account ?? null,
      class: req.body?.class ?? null,
      note: req.body?.note ?? null,
      qboEntryId: req.body?.qboEntryId ?? null,
      resolvedBy: actor,
    }),
  );
});

export const payoutReportRecheckGiving = forChurch(async (_req, res, _actor, church) =>
  responseSuccess(res, await recheckGiving(church)),
);

export const payoutReportSignups = forChurch(async (_req, res, _actor, church) =>
  responseSuccess(res, await listSignups(church)),
);
