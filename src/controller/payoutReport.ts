/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express';
import { Op } from 'sequelize';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Users from '../db/models/user';
import bookkeeper from '../db/models/bookkeeper';
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

/** The signed-in user's email. The app runs both recipes, so ask each. */
const sessionEmail = async (req: SessionRequest): Promise<string | null> => {
  const id = req.session?.getUserId();
  if (!id) return null;
  const user: any = (await ThirdPartyEmailPassword.getUserById(id)) ?? (await EmailPassword.getUserById(id));
  return user?.email ? String(user.email) : null;
};

/**
 * May `actor` act for the church whose account is `church`? The church itself, or a bookkeeper it
 * invited who accepted. These endpoints post to the church's QuickBooks, so - unlike the older
 * endpoints, which trust the email in the request - they check.
 */
export const canActFor = async (actor: string, church: string): Promise<boolean> => {
  if (actor.trim().toLowerCase() === church.trim().toLowerCase()) return true;
  const client: any = await Users.findOne({ where: { email: church } });
  if (!client) return false;
  const actorUser: any = await Users.findOne({ where: { email: actor } });
  const link = await bookkeeper.findOne({
    where: {
      clientId: client.id,
      inviteAccepted: true,
      [Op.or]: [{ email: actor }, ...(actorUser ? [{ userId: actorUser.id }] : [])],
    },
  });
  return Boolean(link);
};

const fail = (res: Response, e: unknown) => {
  if (e instanceof PayoutReportFormatError) return res.status(400).json({ success: false, message: e.message });
  if (e instanceof PayoutImportSetupError || e instanceof PayoutImportBusyError) {
    return res.status(409).json({ success: false, message: e.message });
  }
  if (e instanceof PayoutReviewError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error('payout report endpoint failed', { error: e instanceof Error ? e.message : String(e) });
  return res.status(500).json({ success: false, message: 'Could not read the payout report' });
};

type Handler = (req: SessionRequest, res: Response, actor: string, church: string) => Promise<unknown>;

/** Resolves who is asking and for which church, refuses anyone else, and maps errors to answers. */
const forChurch =
  (where: 'body' | 'query', handler: Handler) =>
  async (req: SessionRequest, res: Response) => {
    const church = String((where === 'body' ? req.body?.email : req.query?.email) ?? '').trim();
    if (!church) return res.status(400).json({ success: false, message: 'email is required' });
    try {
      const actor = await sessionEmail(req);
      if (!actor || !(await canActFor(actor, church))) {
        return res.status(403).json({ success: false, message: "You don't have access to this church." });
      }
      return await handler(req, res, actor, church);
    } catch (e) {
      return fail(res, e);
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

export const payoutReportPreview = forChurch('body', async (req, res, _actor, church) =>
  responseSuccess(res, await previewPayoutReport({ email: church, csvText: csvFrom(req) })),
);

export const payoutReportImport = forChurch('body', async (req, res, actor, church) =>
  responseSuccess(
    res,
    await importPayoutReport({
      email: church,
      fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : null,
      csvText: csvFrom(req),
      uploadedBy: actor, // who is signed in, never what the request says
    }),
  ),
);

export const payoutReportStatus = forChurch('query', async (_req, res, _actor, church) =>
  responseSuccess(res, await getPayoutStatus(church)),
);

export const payoutReportReview = forChurch('query', async (_req, res, _actor, church) =>
  responseSuccess(res, await listReview(church)),
);

export const payoutReportResolve = forChurch('body', async (req, res, actor, church) => {
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

export const payoutReportRecheckGiving = forChurch('body', async (_req, res, _actor, church) =>
  responseSuccess(res, await recheckGiving(church)),
);

export const payoutReportSignups = forChurch('query', async (_req, res, _actor, church) =>
  responseSuccess(res, await listSignups(church)),
);
