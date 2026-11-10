/* eslint-disable @typescript-eslint/no-explicit-any */
import { Op } from 'sequelize';
import sequelize from '../../db';
import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import DailyJeSync from '../../db/models/DailyJeSync';
import PayoutReportUpload from '../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../db/models/PayoutTransaction';
import { parseSyncStartDay } from '../dailyDonationSync';
import { givingCoverage, loadDayCoverage, RETURNED_REASONS } from './givingCoverage';
import { donationIdOf, isGivingCharge, isGivingFailure, isGivingFee, returnCostCents } from './returnedGifts';
import {
  errorMessage,
  loadSetup,
  PayoutImportSetupError,
  PayoutSetup,
  postRegistrationGroup,
  PostedButNotRecordedError,
  relinkStoredReturnLines,
} from './importPayoutReport';

/** A review action that can't be done; `status` is the HTTP status the controller answers with. */
export class PayoutReviewError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export interface PayoutReviewRow {
  id: number;
  status: 'held' | 'giving_not_posted' | 'posting_interrupted';
  reason: string | null;
  line: number | null;
  day: string;
  type: string;
  source: string;
  name: string | null;
  fundOrSignup: string | null;
  description: string | null;
  gross: number;
  fee: number;
  net: number;
  accountRef: string | null;
  classRef: string | null;
  qboEntryId: string | null;
  uploadedAt: string;
  /**
   * For a gift the donor's bank returned (its charge line, reason `returned_*`): the day it came back
   * and what that cost in fees (dollars, positive = a cost) - null until a line taking it back is
   * uploaded.
   */
  returned?: { returnedOn: string | null; cost: number | null };
}

export interface PayoutStatus {
  lastUpload: {
    id: number;
    fileName: string | null;
    uploadedAt: string;
    firstDay: string | null;
    lastDay: string | null;
    /** The payout dates the file covers; null on uploads made before they were asked for. */
    payoutFrom: string | null;
    payoutTo: string | null;
    uploadedBy: string | null;
  } | null;
  needsReview: number;
  givingNotPosted: number;
  registrationStartDay: string | null;
  ready: boolean;
  notReadyReason: string | null;
}

const dollars = (cents: unknown) => Math.round(Number(cents ?? 0)) / 100;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d ?? ''));
const FEE_ACCOUNT_MISSING = 'Choose the account for Stripe fees on the Mapping page first.';

// A row is `pending` for the moments an upload takes to post it. One still pending after this long
// - or flagged by the poster itself - was interrupted, and only a person can say whether
// QuickBooks has it.
const INTERRUPTED_AFTER_MS = 5 * 60 * 1000;
const isInterrupted = (r: any, now = Date.now()): boolean =>
  r.status === 'pending' &&
  (r.reason === 'posting_interrupted' || now - new Date(r.updatedAt ?? 0).getTime() > INTERRUPTED_AFTER_MS);

const userIdFor = async (email: string): Promise<number> => {
  const user: any = await Users.findOne({ where: { email } });
  if (!user) throw new PayoutReviewError('No church found for this account.', 404);
  return Number(user.id);
};

const toReviewRow = (r: any, status: PayoutReviewRow['status']): PayoutReviewRow => ({
  id: Number(r.id),
  status,
  reason: status === 'posting_interrupted' ? 'posting_interrupted' : r.reason ?? null,
  line: r.line ?? null,
  day: r.day,
  type: r.type,
  source: r.source,
  name: r.name ?? null,
  fundOrSignup: r.fundOrSignup ?? null,
  description: r.description ?? null,
  gross: dollars(r.grossCents),
  fee: dollars(r.feeCents),
  net: dollars(r.netCents),
  accountRef: r.accountRef ?? null,
  classRef: r.classRef ?? null,
  qboEntryId: r.qboEntryId ?? null,
  uploadedAt: iso(r.createdAt),
});

/** What is waiting for a person: held lines, giving not in QuickBooks yet, interrupted posts. */
export const listReview = async (
  email: string,
): Promise<{ held: PayoutReviewRow[]; givingNotPosted: PayoutReviewRow[]; postingInterrupted: PayoutReviewRow[] }> => {
  const userId = await userIdFor(email);
  const rows = await PayoutTransaction.findAll({
    where: { userId, status: { [Op.in]: ['held', 'giving_not_posted', 'pending'] } },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const now = Date.now();
  const all = (rows as any[]).map((r) => (typeof r.toJSON === 'function' ? r.toJSON() : r));
  const returnedOf = await returnedGiftFacts(userId, all);
  const withReturned = (r: any, status: PayoutReviewRow['status']) => {
    const row = toReviewRow(r, status);
    const facts = returnedOf.get(Number(r.id));
    return facts ? { ...row, returned: facts } : row;
  };
  return {
    held: all.filter((r) => r.status === 'held').map((r) => withReturned(r, 'held')),
    givingNotPosted: all.filter((r) => r.status === 'giving_not_posted').map((r) => withReturned(r, 'giving_not_posted')),
    postingInterrupted: all.filter((r) => isInterrupted(r, now)).map((r) => toReviewRow(r, 'posting_interrupted')),
  };
};

/**
 * When each returned gift in the list came back and what that cost: from Stripe's lines the upload tied
 * to it (`giftDonationId`). Keyed by the charge row's id.
 */
const returnedGiftFacts = async (userId: number, rows: any[]) => {
  const charges = rows.filter((r) => RETURNED_REASONS.includes(String(r.reason ?? '')) && isGivingCharge({ source: r.source, type: r.type, grossCents: Number(r.grossCents) }));
  const out = new Map<number, { returnedOn: string | null; cost: number | null }>();
  if (!charges.length) return out;
  const ids = charges.map((r) => donationIdOf({ rowKey: String(r.rowKey) })).filter((x): x is string => !!x);
  const lines = (await PayoutTransaction.findAll({
    where: { userId, giftDonationId: { [Op.in]: ids } } as any,
    attributes: ['giftDonationId', 'day', 'type', 'source', 'grossCents', 'netCents'],
  })) as any[];
  for (const r of charges) {
    const id = donationIdOf({ rowKey: String(r.rowKey) });
    const own = lines
      .filter((l) => String(l.giftDonationId) === id)
      .map((l) => ({ day: String(l.day), type: String(l.type), source: String(l.source), grossCents: Number(l.grossCents), netCents: Number(l.netCents) }));
    const back = own.filter(isGivingFailure).map((l) => l.day).sort();
    const cost = returnCostCents({ netCents: Number(r.netCents) }, own);
    out.set(Number(r.id), { returnedOn: back.length ? back[back.length - 1] : null, cost: cost === null ? null : dollars(cost) });
  }
  return out;
};

/** Only lines CSP can post the way it posts everything else: net = gross - fee, a charge's fee within it, a refund with no fee. */
const assertPostable = (row: any) => {
  // A gift's charge is posted by Daily Giving, and a returned gift's lines are booked by a person -
  // never coded here as a line of its own (that would book a gift as income a second time).
  const line = { source: String(row.source), type: String(row.type), grossCents: Number(row.grossCents) };
  if (isGivingCharge(line) || isGivingFailure(line) || isGivingFee(line)) {
    throw new PayoutReviewError("CSP doesn't post giving lines from here. Book it in QuickBooks yourself if it's needed, then mark it handled.");
  }
  const gross = Number(row.grossCents);
  const fee = Number(row.feeCents);
  const net = Number(row.netCents);
  if (net !== gross - fee) {
    throw new PayoutReviewError("Gross minus fee doesn't equal net, so CSP can't post this line. Record it yourself and mark it handled.");
  }
  const charge = gross > 0 && fee >= 0 && fee <= gross;
  const refund = gross < 0 && fee === 0;
  if (!charge && !refund) throw new PayoutReviewError("CSP can't post a line like this. Record it yourself and mark it handled.");
};

const setupFor = async (email: string, row: any): Promise<PayoutSetup> => {
  const setup = await loadSetup(email);
  if (Number(row.feeCents) !== 0 && !setup.fees.value) throw new PayoutImportSetupError(FEE_ACCOUNT_MISSING);
  return setup;
};

/** Posts one line as its own entry; on a QuickBooks refusal runs `onRefused` and says so. */
const postOne = async (p: {
  email: string;
  row: any;
  setup: PayoutSetup;
  accountRef: string;
  classRef: string | null;
  finalStatus: 'posted' | 'resolved';
  extra: Record<string, unknown>;
  onRefused: (message: string) => Promise<unknown>;
}) => {
  const gross = Number(p.row.grossCents);
  try {
    const res = await postRegistrationGroup({
      email: p.email,
      setup: p.setup,
      day: p.row.day,
      kind: gross < 0 ? 'refund' : 'charge',
      lines: [{ id: Number(p.row.id), grossCents: gross, feeCents: Number(p.row.feeCents), accountRef: p.accountRef, classRef: p.classRef }],
      uploadId: p.row.uploadId ?? null,
      finalStatus: p.finalStatus,
      extra: { ...p.extra, accountRef: p.accountRef, classRef: p.classRef },
    });
    return {
      id: Number(p.row.id),
      status: p.finalStatus,
      docNumber: res.docNumber,
      ...(res.qboEntryId ? { qboEntryId: res.qboEntryId } : {}),
    };
  } catch (e) {
    if (e instanceof PostedButNotRecordedError) throw new PayoutReviewError(e.message, 409);
    const message = errorMessage(e);
    await p.onRefused(message);
    throw new PayoutReviewError(`QuickBooks did not take the entry: ${message}`, 409);
  }
};

const ledgerDefaults = (userId: number, day: string) => ({ userId, day, postedGrossCents: 0, postedFeeCents: 0, entryCount: 0 });

/** A person found the interrupted entry in QuickBooks: record it as CSP would have. */
const markPosted = async (row: any, entryId: string, by: Record<string, unknown>) => {
  await DailyJeSync.findOrCreate({ where: { userId: row.userId, day: row.day }, defaults: ledgerDefaults(row.userId, row.day) });
  await sequelize.transaction(async (tx) => {
    const ledger: any = await DailyJeSync.findOne({ where: { userId: row.userId, day: row.day }, transaction: tx, lock: tx.LOCK.UPDATE });
    const [n] = await PayoutTransaction.update({ status: 'posted', qboEntryId: entryId, reason: null, ...by } as any, {
      where: { id: row.id, status: 'pending' },
      transaction: tx,
    });
    if (n !== 1) throw new PayoutReviewError('This line was already handled.', 409);
    const gross = Math.abs(Number(row.grossCents));
    const fee = Math.abs(Number(row.feeCents));
    const ids: string[] = (ledger.registrationEntryIds as string[]) ?? [];
    const isNew = !ids.includes(entryId);
    const refund = Number(row.grossCents) < 0;
    await ledger.update(
      {
        ...(refund
          ? {
              registrationRefundGrossCents: Number(ledger.registrationRefundGrossCents ?? 0) + gross,
              registrationRefundFeeCents: Number(ledger.registrationRefundFeeCents ?? 0) + fee,
            }
          : {
              registrationGrossCents: Number(ledger.registrationGrossCents ?? 0) + gross,
              registrationFeeCents: Number(ledger.registrationFeeCents ?? 0) + fee,
            }),
        registrationEntryCount: Number(ledger.registrationEntryCount ?? 0) + (isNew ? 1 : 0),
        registrationEntryIds: isNew ? [...ids, entryId] : ids,
      },
      { transaction: tx },
    );
  });
};

export type ResolveAction = 'post' | 'dismiss' | 'mark_posted' | 'post_now';

/** The review list's actions. Each claims its row first, so a double click can't act twice. */
export const resolvePayoutRow = async (p: {
  email: string;
  id: number;
  action: ResolveAction;
  account?: { value?: string; label?: string } | null;
  class?: { value?: string; label?: string } | null;
  note?: string | null;
  qboEntryId?: string | null;
  resolvedBy?: string | null;
}): Promise<{ id: number; status: string; qboEntryId?: string; docNumber?: string }> => {
  const userId = await userIdFor(p.email);
  const row: any = await PayoutTransaction.findOne({ where: { id: p.id, userId } });
  if (!row) throw new PayoutReviewError('That line is no longer in the review list.', 404);
  const by = { resolvedBy: p.resolvedBy ? String(p.resolvedBy).slice(0, 256) : null, resolvedAt: new Date() };
  const classRef = p.class?.value ? String(p.class.value) : null;

  switch (p.action) {
    case 'dismiss': {
      const note = String(p.note ?? '').trim();
      if (!note) throw new PayoutReviewError('Add a note saying how this was handled.');
      if (!['held', 'giving_not_posted'].includes(row.status)) {
        throw new PayoutReviewError('Only lines waiting for review can be marked handled.', 409);
      }
      const [n] = await PayoutTransaction.update({ status: 'dismissed', note: note.slice(0, 2000), ...by } as any, {
        where: { id: row.id, status: row.status },
      });
      if (n !== 1) throw new PayoutReviewError('This line was already handled.', 409);
      return { id: Number(row.id), status: 'dismissed' };
    }

    case 'post': {
      if (row.status !== 'held') throw new PayoutReviewError('Only held lines can be posted from the review list.', 409);
      const accountRef = p.account?.value ? String(p.account.value) : '';
      if (!accountRef) throw new PayoutReviewError('Choose the account to post this line to.');
      assertPostable(row);
      const setup = await setupFor(p.email, row);
      const heldReason = row.reason ?? null;
      // Out of `held` and into `pending`, which uploads never touch, before QuickBooks is called.
      const [n] = await PayoutTransaction.update({ status: 'pending', reason: 'posting_now' } as any, {
        where: { id: row.id, status: 'held' },
      });
      if (n !== 1) throw new PayoutReviewError('This line was already handled.', 409);
      return postOne({
        email: p.email,
        row,
        setup,
        accountRef,
        classRef,
        finalStatus: 'resolved',
        extra: by,
        onRefused: () =>
          PayoutTransaction.update({ status: 'held', reason: heldReason } as any, { where: { id: row.id, status: 'pending' } }),
      });
    }

    case 'mark_posted': {
      if (!isInterrupted(row)) throw new PayoutReviewError('Only an interrupted line can be marked posted.', 409);
      const entryId = String(p.qboEntryId ?? '')
        .trim()
        .replace(/^#/, '');
      if (!entryId) throw new PayoutReviewError('Enter the number of the entry you found in QuickBooks.');
      await markPosted(row, entryId.slice(0, 64), by);
      return { id: Number(row.id), status: 'posted', qboEntryId: entryId.slice(0, 64) };
    }

    case 'post_now': {
      if (!isInterrupted(row)) throw new PayoutReviewError('Only an interrupted line can be posted again.', 409);
      const accountRef = p.account?.value ? String(p.account.value) : row.accountRef ? String(row.accountRef) : '';
      if (!accountRef) throw new PayoutReviewError('Choose the account to post this line to.');
      assertPostable(row);
      const setup = await setupFor(p.email, row);
      // Claim it: still `pending` (so no upload picks it up), but marked as being posted now.
      const [n] = await PayoutTransaction.update({ reason: 'posting_now', updatedAt: new Date() } as any, {
        where: {
          id: row.id,
          status: 'pending',
          [Op.or]: [{ reason: null }, { reason: { [Op.ne]: 'posting_now' } }],
        },
      });
      if (n !== 1) throw new PayoutReviewError('This line is already being posted.', 409);
      return postOne({
        email: p.email,
        row,
        setup,
        accountRef,
        classRef: classRef ?? (row.classRef ? String(row.classRef) : null),
        finalStatus: 'posted',
        extra: by,
        // QuickBooks has no entry and refused this one: a normal failure, retried by the next upload.
        onRefused: (message) =>
          PayoutTransaction.update({ status: 'failed', reason: message.slice(0, 64) } as any, {
            where: { id: row.id, status: 'pending' },
          }),
      });
    }

    default:
      throw new PayoutReviewError('Unknown action.');
  }
};

/** "Check again": re-runs the giving check for lines whose day was not (fully) in QuickBooks. */
export const recheckGiving = async (
  email: string,
): Promise<{ checked: number; nowCovered: number; stillNotPosted: number; returnedFiled: number }> => {
  const userId = await userIdFor(email);
  const settings: any = await UserSettings.findOne({ where: { userId } });
  const givingStartDay = parseSyncStartDay(settings?.startDateAutomationFund);
  const stored = (await PayoutTransaction.findAll({ where: { userId, status: 'giving_not_posted' } })) as any[];

  const rows = stored.map((r) => ({
    id: Number(r.id),
    externalId: String(r.rowKey).split(':').slice(0, 2).join(':'),
    day: String(r.day),
    type: String(r.type),
    grossCents: Number(r.grossCents),
  }));
  let nowCovered = 0;
  const filed = new Set<string>(); // returned gifts filed for a person, by donation id
  if (rows.length) {
    const days = await loadDayCoverage(
      email,
      userId,
      rows.filter((r) => !givingStartDay || r.day >= givingStartDay).map((r) => r.day),
    );
    for (const res of givingCoverage(rows, { givingStartDay, days })) {
      // A gift found to be returned is settled by a person, as the upload files it (held, with its state).
      const held = res.reason === 'returned_gift' || res.reason === 'returned_after_posting';
      const [n] = await PayoutTransaction.update({ status: held ? 'held' : res.status, reason: res.reason ?? null } as any, {
        where: { id: res.row.id, status: 'giving_not_posted' },
      });
      if (n === 1 && res.status === 'giving_covered') nowCovered++;
      if (n === 1 && held) filed.add(res.row.externalId.replace(/^donation:/, ''));
    }
  }
  // Return lines still open (their gift came later, or Planning Center couldn't be read): tie them now.
  for (const id of await relinkStoredReturnLines(email, userId, givingStartDay)) filed.add(id);
  const stillNotPosted = rows.length
    ? await PayoutTransaction.count({ where: { id: rows.map((r) => r.id), status: 'giving_not_posted' } })
    : 0;
  return { checked: rows.length, nowCovered, stillNotPosted, returnedFiled: filed.size };
};

/** The Clearing page card: last report loaded, what needs a person, and whether uploads can run. */
export const getPayoutStatus = async (email: string): Promise<PayoutStatus> => {
  const userId = await userIdFor(email);
  const settings: any = await UserSettings.findOne({ where: { userId } });
  const last: any = await PayoutReportUpload.findOne({
    where: { userId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const held = await PayoutTransaction.count({ where: { userId, status: 'held' } });
  const pending = await PayoutTransaction.findAll({ where: { userId, status: 'pending' }, attributes: ['status', 'reason', 'updatedAt'] });
  const interrupted = (pending as any[]).filter((r) => isInterrupted(r)).length;
  const givingNotPosted = await PayoutTransaction.count({ where: { userId, status: 'giving_not_posted' } });

  let ready = true;
  let notReadyReason: string | null = null;
  try {
    const setup = await loadSetup(email);
    if (!setup.fees.value) {
      ready = false;
      notReadyReason = FEE_ACCOUNT_MISSING;
    }
  } catch (e) {
    if (!(e instanceof PayoutImportSetupError)) throw e;
    ready = false;
    notReadyReason = e.message;
  }

  return {
    lastUpload: last
      ? {
          id: Number(last.id),
          fileName: last.fileName ?? null,
          uploadedAt: iso(last.createdAt),
          firstDay: last.firstDay ?? null,
          lastDay: last.lastDay ?? null,
          payoutFrom: last.payoutFrom ?? null,
          payoutTo: last.payoutTo ?? null,
          uploadedBy: last.uploadedBy ?? null,
        }
      : null,
    needsReview: held + interrupted,
    givingNotPosted,
    registrationStartDay: parseSyncStartDay(settings?.startDateAutomationRegistration),
    ready,
    notReadyReason,
  };
};

/** Registration signup names seen in uploads so far - the Mapping page offers them for per-event accounts. */
export const listSignups = async (email: string): Promise<string[]> => {
  const userId = await userIdFor(email);
  const rows = (await PayoutTransaction.findAll({
    where: { userId, source: 'Registrations', fundOrSignup: { [Op.ne]: null } },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('fundOrSignup')), 'fundOrSignup']],
    raw: true,
  })) as any[];
  return rows
    .map((r) => String(r.fundOrSignup ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
};
