/* eslint-disable @typescript-eslint/no-explicit-any */
import { Op, QueryTypes } from 'sequelize';
import sequelize from '../../db';
import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import DailyJeSync from '../../db/models/DailyJeSync';
import PayoutReportUpload from '../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../db/models/PayoutTransaction';
import { automationJournalEntry } from '../../controller/automation';
import { parseSyncStartDay } from '../dailyDonationSync';
import { createLogger } from '../../utils/logger';
import { parsePayoutReport, PayoutRow } from './parsePayoutReport';
import { readRegistrationMapping, RegistrationMappingV2 } from './registrationMapping';
import { classifyRows, ClassifiedRow } from './classifyRows';
import { givingCoverage, loadDayCoverage, CoverageResult } from './givingCoverage';
import { registrationChargeEntry, registrationRefundEntry, registrationDocNumber } from './registrationEntries';

const logger = createLogger('payout-report');

/** Something the church has to set up first. The message says what, in the app's words. */
export class PayoutImportSetupError extends Error {}
/** Another upload for the same church is still being recorded. */
export class PayoutImportBusyError extends Error {}

/**
 * Stored statuses an upload never changes: the row is in QuickBooks, may be (`pending` - see
 * below), or a person now owns it. A row left `pending` means the process stopped between
 * QuickBooks accepting an entry and CSP recording that - QuickBooks may already have it, so
 * posting it again could double it. Those wait in the review list as "posting interrupted".
 */
export const FINAL_STATUSES = ['posted', 'pending', 'resolved', 'dismissed', 'held', 'giving_covered'];
/** Stored statuses an upload looks at again: QuickBooks said no, the start date moved, or the day was not posted yet. */
const RECHECKED_STATUSES = ['failed', 'before_start', 'giving_not_posted'];

export interface PayoutSetup {
  userId: number;
  registrationStartDay: string;
  givingStartDay: string | null;
  mapping: RegistrationMappingV2;
  clearing: { value: string; name?: string };
  fees: { value: string; name?: string; classRef?: string };
}

export interface PayoutSummary {
  file: { rows: number; firstDay: string | null; lastDay: string | null };
  registrations: {
    toPost: { count: number; gross: number; fees: number; net: number };
    alreadyRecorded: number;
    beforeStart: { count: number; net: number };
  };
  entries: {
    day: string;
    kind: 'charge' | 'refund';
    docNumber: string;
    count: number;
    gross: number;
    fees: number;
    net: number;
    qboEntryId?: string;
    error?: string;
  }[];
  giving: { covered: number; notPosted: { day: string; count: number; net: number; reason: string }[] };
  held: { line: number; day: string; type: string; source: string; fundOrSignup: string; net: number; reason: string }[];
}

export const loadSetup = async (email: string): Promise<PayoutSetup> => {
  const user: any = await Users.findOne({ where: { email } });
  if (!user) throw new PayoutImportSetupError('No church found for this account.');
  const s: any = await UserSettings.findOne({ where: { userId: user.id } });
  const registrationStartDay = parseSyncStartDay(s?.startDateAutomationRegistration);
  if (!registrationStartDay) {
    throw new PayoutImportSetupError('Set the date to record registrations from on Mapping → Registration first.');
  }
  const mapping = readRegistrationMapping(s?.settingRegistrationData);
  if (!mapping?.default.account) {
    throw new PayoutImportSetupError('Choose the income account for event payments on Mapping → Registration first.');
  }
  const bank = ((s?.settingBankData as any[]) ?? []).filter(Boolean);
  const donationSlot = bank.find((b) => b?.type === 'donation' && b?.value);
  const registrationSlot = bank.find((b) => b?.type === 'registration' && b?.value);
  const clearingSlot = registrationSlot ?? donationSlot;
  if (!clearingSlot) throw new PayoutImportSetupError('Choose the clearing account on Mapping → Bank first.');
  // The Clearing page, its statement and the switch-over track ONE account. Event money posted
  // to a different one would be counted there without ever having landed in it.
  if (donationSlot && registrationSlot && String(donationSlot.value) !== String(registrationSlot.value)) {
    throw new PayoutImportSetupError(
      'Event payments and giving must use the same clearing account. Set both to the same account on Mapping → Bank.',
    );
  }
  const charges = s?.settingBankCharges ?? {};
  return {
    userId: user.id,
    registrationStartDay,
    givingStartDay: parseSyncStartDay(s?.startDateAutomationFund),
    mapping,
    clearing: { value: String(clearingSlot.value), name: clearingSlot.label },
    fees: {
      value: String(charges?.account?.value ?? ''),
      name: charges?.account?.label,
      classRef: charges?.class?.value || undefined,
    },
  };
};

interface Classified {
  rows: PayoutRow[];
  classified: ClassifiedRow[];
  coverage: Map<string, CoverageResult<PayoutRow>>; // giving rows, by rowKey
  stored: Map<string, { id: number; status: string }>; // rows of this file seen before, by rowKey
}

const classify = async (setup: PayoutSetup, email: string, csvText: string): Promise<Classified> => {
  const rows = parsePayoutReport(csvText);
  const stored = new Map<string, { id: number; status: string }>();
  const keys = rows.map((r) => r.rowKey);
  for (let i = 0; i < keys.length; i += 1000) {
    const found = await PayoutTransaction.findAll({
      where: { userId: setup.userId, rowKey: { [Op.in]: keys.slice(i, i + 1000) } },
      attributes: ['id', 'rowKey', 'status'],
    });
    for (const f of found as any[]) stored.set(String(f.rowKey), { id: Number(f.id), status: String(f.status) });
  }
  const knownKeys = new Set([...stored].filter(([, s]) => FINAL_STATUSES.includes(s.status)).map(([k]) => k));
  const classified = classifyRows(rows, {
    registrationStartDay: setup.registrationStartDay,
    mapping: setup.mapping,
    knownKeys,
  });
  const givingRows = classified.filter((c) => c.status === 'giving').map((c) => c.row);
  const daysToCheck = givingRows.filter((r) => !setup.givingStartDay || r.day >= setup.givingStartDay).map((r) => r.day);
  const days = await loadDayCoverage(email, setup.userId, daysToCheck);
  const coverage = new Map(
    givingCoverage(givingRows, { givingStartDay: setup.givingStartDay, days }).map((c) => [c.row.rowKey, c] as const),
  );
  return { rows, classified, coverage, stored };
};

const assertFeeAccount = (classified: ClassifiedRow[], setup: PayoutSetup) => {
  if (!setup.fees.value && classified.some((c) => c.status === 'to_post' && c.row.feeCents !== 0)) {
    throw new PayoutImportSetupError('Choose the account for Stripe fees on the Mapping page first.');
  }
};

const dollars = (cents: number) => Math.round(cents) / 100;
const kindOf = (row: PayoutRow): 'charge' | 'refund' => (row.type === 'Refund' ? 'refund' : 'charge');
const figures = (rows: PayoutRow[]) => ({
  count: rows.length,
  gross: dollars(rows.reduce((s, r) => s + r.grossCents, 0)),
  fees: dollars(rows.reduce((s, r) => s + r.feeCents, 0)),
  net: dollars(rows.reduce((s, r) => s + r.netCents, 0)),
});

/** One entry per day and kind - charges before refunds within a day. */
const groupForPosting = <T extends { row: PayoutRow }>(items: T[]) => {
  const groups = new Map<string, { day: string; kind: 'charge' | 'refund'; items: T[] }>();
  for (const item of items) {
    const key = `${item.row.day}|${kindOf(item.row)}`;
    const g = groups.get(key) ?? { day: item.row.day, kind: kindOf(item.row), items: [] as T[] };
    g.items.push(item);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.kind === 'charge' ? -1 : 1));
};

const summarize = (c: Classified, entries: PayoutSummary['entries']): PayoutSummary => {
  const toPost = c.classified.filter((x) => x.status === 'to_post').map((x) => x.row);
  const beforeStart = c.classified.filter((x) => x.status === 'before_start').map((x) => x.row);
  const known = c.classified.filter((x) => x.status === 'already_recorded');
  const days = c.rows.map((r) => r.day).sort();

  let covered = known.filter((x) => x.row.source === 'Giving').length; // settled by an earlier upload
  const notPosted = new Map<string, { day: string; count: number; netCents: number; reason: string }>();
  for (const cov of c.coverage.values()) {
    if (cov.status === 'giving_covered') {
      covered++;
      continue;
    }
    const reason = cov.reason ?? 'day_not_posted';
    const key = `${cov.row.day}|${reason}`;
    const n = notPosted.get(key) ?? { day: cov.row.day, count: 0, netCents: 0, reason };
    n.count++;
    n.netCents += cov.row.netCents;
    notPosted.set(key, n);
  }

  const reg = figures(toPost);
  return {
    file: { rows: c.rows.length, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null },
    registrations: {
      toPost: { count: reg.count, gross: reg.gross, fees: reg.fees, net: reg.net },
      // Rows a person is handling (held, dismissed) are in the review list, not "recorded".
      alreadyRecorded: known.filter(
        (x) => x.row.source !== 'Giving' && !['held', 'dismissed'].includes(c.stored.get(x.row.rowKey)?.status ?? ''),
      ).length,
      beforeStart: { count: beforeStart.length, net: figures(beforeStart).net },
    },
    entries,
    giving: {
      covered,
      notPosted: [...notPosted.values()]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((n) => ({ day: n.day, count: n.count, net: dollars(n.netCents), reason: n.reason })),
    },
    held: c.classified
      .filter((x) => x.status === 'held')
      .map((x) => ({
        line: x.row.line,
        day: x.row.day,
        type: x.row.type,
        source: x.row.source,
        fundOrSignup: x.row.fundOrSignup,
        net: dollars(x.row.netCents),
        reason: x.reason ?? 'unrecognised',
      })),
  };
};

/** QuickBooks errors arrive as { Fault: { Error: [{ Message, Detail }] } }, not as Error. */
export const errorMessage = (e: any): string => {
  const fault = e?.Fault?.Error?.[0] ?? e?.fault?.error?.[0];
  if (fault) return [fault.Message ?? fault.message, fault.Detail ?? fault.detail].filter(Boolean).join(': ');
  return e instanceof Error ? e.message : String(e);
};

/** QuickBooks has the entry but CSP could not record that it does. Never retry automatically. */
export class PostedButNotRecordedError extends Error {
  constructor(message: string, public qboEntryId: string | null, public docNumber: string) {
    super(message);
  }
}

export interface GroupLine {
  id: number;
  grossCents: number;
  feeCents: number;
  accountRef: string;
  classRef?: string | null;
}

/**
 * Posts one registration entry (charges or refunds for one day) and records it on the day ledger
 * and the rows, under the same row lock the giving engine takes for that day - so the doc number
 * sequence and the running totals can't race either of them.
 */
export const postRegistrationGroup = async (p: {
  email: string;
  setup: Pick<PayoutSetup, 'userId' | 'clearing' | 'fees'>;
  day: string;
  kind: 'charge' | 'refund';
  lines: GroupLine[];
  uploadId?: number | null;
  finalStatus?: 'posted' | 'resolved';
  extra?: Record<string, unknown>;
}): Promise<{ docNumber: string; qboEntryId: string | null }> => {
  const { userId } = p.setup;
  await DailyJeSync.findOrCreate({
    where: { userId, day: p.day },
    defaults: { userId, day: p.day, postedGrossCents: 0, postedFeeCents: 0, entryCount: 0 },
  });
  let accepted: { qboEntryId: string | null; docNumber: string } | null = null;
  try {
    return await sequelize.transaction(async (tx) => {
      const ledger: any = await DailyJeSync.findOne({ where: { userId, day: p.day }, transaction: tx, lock: tx.LOCK.UPDATE });
      if (!ledger) throw new Error(`DailyJeSync row missing for ${userId} ${p.day}`);
      const seq = Number(ledger.registrationEntryCount ?? 0) + 1;
      const docNumber = registrationDocNumber(p.day, seq, p.kind);
      const opts = {
        day: p.day,
        docNumber,
        memo: `Church Sync Pro - PCO Registrations${p.kind === 'refund' ? ' Refund' : ''} - ${p.day}${
          p.uploadId ? ` | upload:${p.uploadId}` : ''
        }`,
        clearing: p.setup.clearing,
        fees: p.setup.fees,
      };
      const lines = p.lines.map((l) => ({
        accountRef: String(l.accountRef),
        classRef: l.classRef || undefined,
        grossCents: Number(l.grossCents),
        feeCents: Number(l.feeCents),
      }));
      const je = p.kind === 'refund' ? registrationRefundEntry(lines, opts) : registrationChargeEntry(lines, opts);

      const created: any = await automationJournalEntry(p.email, je);
      const qboEntryId = created?.Id ? String(created.Id) : null;
      accepted = { qboEntryId, docNumber };

      const gross = lines.reduce((s, l) => s + Math.abs(l.grossCents), 0);
      const fee = lines.reduce((s, l) => s + Math.abs(l.feeCents), 0);
      const entryIds = [...((ledger.registrationEntryIds as string[]) ?? []), ...(qboEntryId ? [qboEntryId] : [])];
      await ledger.update(
        p.kind === 'refund'
          ? {
              registrationRefundGrossCents: Number(ledger.registrationRefundGrossCents ?? 0) + gross,
              registrationRefundFeeCents: Number(ledger.registrationRefundFeeCents ?? 0) + fee,
              registrationEntryCount: seq,
              registrationEntryIds: entryIds,
            }
          : {
              registrationGrossCents: Number(ledger.registrationGrossCents ?? 0) + gross,
              registrationFeeCents: Number(ledger.registrationFeeCents ?? 0) + fee,
              registrationEntryCount: seq,
              registrationEntryIds: entryIds,
            },
        { transaction: tx },
      );
      await PayoutTransaction.update(
        { status: p.finalStatus ?? 'posted', qboEntryId, reason: null, ...(p.extra ?? {}) } as any,
        { where: { id: p.lines.map((l) => l.id) }, transaction: tx },
      );
      return { docNumber, qboEntryId };
    });
  } catch (e) {
    if (!accepted) throw e;
    const a = accepted as { qboEntryId: string | null; docNumber: string };
    // QuickBooks has it; CSP's records rolled back. Leave the rows `pending` (never retried) and,
    // if the database lets us, note which entry it was so the review list can say.
    try {
      await PayoutTransaction.update({ qboEntryId: a.qboEntryId, reason: 'posting_interrupted' } as any, {
        where: { id: p.lines.map((l) => l.id) },
      });
    } catch {
      /* the review list still shows the rows as interrupted */
    }
    logger.error('postRegistrationGroup: QuickBooks accepted the entry but CSP could not record it', {
      email: p.email,
      day: p.day,
      kind: p.kind,
      qboEntryId: a.qboEntryId,
      error: errorMessage(e),
    });
    throw new PostedButNotRecordedError(
      `QuickBooks has entry ${a.docNumber}${a.qboEntryId ? ` (#${a.qboEntryId})` : ''} but CSP could not record it. It is in the review list.`,
      a.qboEntryId,
      a.docNumber,
    );
  }
};

const rowFields = (row: PayoutRow) => ({
  rowKey: row.rowKey,
  line: row.line,
  day: row.day,
  type: row.type.slice(0, 32),
  source: row.source.slice(0, 64),
  name: row.name ? row.name.slice(0, 256) : null,
  fundOrSignup: row.fundOrSignup ? row.fundOrSignup.slice(0, 512) : null,
  grossCents: row.grossCents,
  feeCents: row.feeCents,
  netCents: row.netCents,
  paymentMethod: row.paymentMethod ? row.paymentMethod.slice(0, 32) : null,
  description: row.description || null,
});

/** Rows this upload does not post: stored once, and re-checked when an earlier upload left them open. */
const storeOtherRows = async (c: Classified, uploadId: number, userId: number) => {
  const fresh: any[] = [];
  const recheck: { id: number; prev: string; status: string; reason: string | null }[] = [];
  for (const item of c.classified) {
    let status: string;
    let reason: string | null = null;
    if (item.status === 'before_start') status = 'before_start';
    else if (item.status === 'held') {
      status = 'held';
      reason = item.reason ?? null;
    } else if (item.status === 'giving') {
      const cov = c.coverage.get(item.row.rowKey);
      status = cov?.status ?? 'giving_not_posted';
      reason = cov?.reason ?? null;
    } else continue; // to_post rows were claimed above; already_recorded rows are settled
    const prev = c.stored.get(item.row.rowKey);
    if (!prev) fresh.push({ ...rowFields(item.row), userId, uploadId, status, reason });
    else if (RECHECKED_STATUSES.includes(prev.status)) recheck.push({ id: prev.id, prev: prev.status, status, reason });
  }
  if (fresh.length) await PayoutTransaction.bulkCreate(fresh, { ignoreDuplicates: true });
  for (const r of recheck) {
    await PayoutTransaction.update({ status: r.status, reason: r.reason, uploadId } as any, {
      where: { id: r.id, status: r.prev },
    });
  }
};

// Namespace for this feature's advisory locks (the second key is the church's user id).
const LOCK_NAMESPACE = 74010;

/**
 * One upload at a time per church. Non-blocking: a second upload while the first is still
 * posting is told so, rather than waiting on a database connection - and then finding every
 * row already recorded, which is what it would see anyway.
 */
const withChurchLock = <T>(userId: number, fn: () => Promise<T>): Promise<T> =>
  sequelize.transaction(async (tx) => {
    const [row]: any[] = await sequelize.query('SELECT pg_try_advisory_xact_lock(:ns, :userId) AS locked', {
      replacements: { ns: LOCK_NAMESPACE, userId },
      type: QueryTypes.SELECT,
      transaction: tx,
    });
    if (!row?.locked) {
      throw new PayoutImportBusyError('Another payout report is being recorded for this church right now. Try again in a minute.');
    }
    return fn();
  });

/** What an import would do. Reads only - nothing is stored or posted. */
export const previewPayoutReport = async (p: { email: string; csvText: string }): Promise<PayoutSummary> => {
  const setup = await loadSetup(p.email);
  const c = await classify(setup, p.email, p.csvText);
  assertFeeAccount(c.classified, setup);

  const groups = groupForPosting(c.classified.filter((x) => x.status === 'to_post'));
  const days = [...new Set(groups.map((g) => g.day))];
  const ledgers = days.length
    ? await DailyJeSync.findAll({
        where: { userId: setup.userId, day: { [Op.in]: days } },
        attributes: ['day', 'registrationEntryCount'],
      })
    : [];
  const entriesSoFar = new Map((ledgers as any[]).map((l) => [String(l.day), Number(l.registrationEntryCount ?? 0)]));
  const entries = groups.map((g) => {
    const seq = (entriesSoFar.get(g.day) ?? 0) + 1;
    entriesSoFar.set(g.day, seq);
    return { day: g.day, kind: g.kind, docNumber: registrationDocNumber(g.day, seq, g.kind), ...figures(g.items.map((i) => i.row)) };
  });
  return summarize(c, entries);
};

/**
 * Records a payout report: posts every registration charge and refund it has not seen, once,
 * stores the giving check and anything it could not recognise, and returns what it did.
 */
export const importPayoutReport = async (p: {
  email: string;
  fileName?: string | null;
  csvText: string;
  uploadedBy?: string | null;
}): Promise<PayoutSummary & { uploadId: number }> => {
  const setup = await loadSetup(p.email);
  return withChurchLock(setup.userId, async () => {
    const c = await classify(setup, p.email, p.csvText);
    assertFeeAccount(c.classified, setup);
    const days = c.rows.map((r) => r.day).sort();
    const upload: any = await PayoutReportUpload.create({
      userId: setup.userId,
      fileName: p.fileName ? String(p.fileName).slice(0, 512) : null,
      uploadedBy: p.uploadedBy ? String(p.uploadedBy).slice(0, 256) : null,
      rowCount: c.rows.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
    });

    // 1. Claim the registration rows to post. The unique (userId, rowKey) index decides who posts a
    //    row; a row an earlier upload left failed or before the start date is claimed atomically.
    const claimed: { row: PayoutRow; id: number; accountRef: string; classRef?: string }[] = [];
    for (const item of c.classified.filter((x) => x.status === 'to_post')) {
      const [rec, created] = await PayoutTransaction.findOrCreate({
        where: { userId: setup.userId, rowKey: item.row.rowKey },
        defaults: {
          ...rowFields(item.row),
          userId: setup.userId,
          uploadId: upload.id,
          status: 'pending',
          accountRef: item.accountRef,
          classRef: item.classRef ?? null,
        } as any,
      });
      const target = { row: item.row, id: Number((rec as any).id), accountRef: String(item.accountRef), classRef: item.classRef };
      if (created) {
        claimed.push(target);
        continue;
      }
      const prev = String((rec as any).status);
      const [n] = RECHECKED_STATUSES.includes(prev)
        ? await PayoutTransaction.update(
            { status: 'pending', uploadId: upload.id, accountRef: item.accountRef, classRef: item.classRef ?? null, reason: null } as any,
            { where: { id: target.id, status: prev } },
          )
        : [0];
      if (n === 1) claimed.push(target);
      else item.status = 'already_recorded';
    }

    // 2. One QuickBooks entry per day and kind.
    const entries: PayoutSummary['entries'] = [];
    for (const g of groupForPosting(claimed)) {
      const ids = g.items.map((i) => i.id);
      const fig = figures(g.items.map((i) => i.row));
      try {
        const res = await postRegistrationGroup({
          email: p.email,
          setup,
          day: g.day,
          kind: g.kind,
          lines: g.items.map((i) => ({
            id: i.id,
            grossCents: i.row.grossCents,
            feeCents: i.row.feeCents,
            accountRef: i.accountRef,
            classRef: i.classRef,
          })),
          uploadId: upload.id,
        });
        entries.push({ day: g.day, kind: g.kind, docNumber: res.docNumber, ...fig, ...(res.qboEntryId ? { qboEntryId: res.qboEntryId } : {}) });
      } catch (e) {
        if (e instanceof PostedButNotRecordedError) {
          entries.push({
            day: g.day,
            kind: g.kind,
            docNumber: e.docNumber,
            ...fig,
            ...(e.qboEntryId ? { qboEntryId: e.qboEntryId } : {}),
            error: e.message,
          });
          continue;
        }
        const message = errorMessage(e);
        logger.error('importPayoutReport: QuickBooks did not take the entry', { email: p.email, day: g.day, kind: g.kind, error: message });
        await PayoutTransaction.update({ status: 'failed', reason: message.slice(0, 64) } as any, {
          where: { id: ids, status: 'pending' },
        });
        entries.push({ day: g.day, kind: g.kind, docNumber: '', ...fig, error: message });
      }
    }

    // 3. Everything else, and the summary.
    await storeOtherRows(c, upload.id, setup.userId);
    const summary = summarize(c, entries);
    await upload.update({ summary });
    return { ...summary, uploadId: Number(upload.id) };
  });
};
