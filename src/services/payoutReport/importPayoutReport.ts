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
import { givingCoverage, loadDayCoverage, CoverageResult, RETURNED_REASONS } from './givingCoverage';
import {
  ReturnLine,
  donationIdOf,
  isGivingCharge,
  isGivingFailure,
  linkReturnLines,
  preStartReturnLines,
  returnCostCents,
} from './returnedGifts';
import { registrationChargeEntry, registrationRefundEntry, registrationDocNumber } from './registrationEntries';
import { assertPayoutRange, assertRowsWithinPayouts, PayoutRange } from './payoutRange';

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

export interface PreviousUpload {
  id: number;
  fileName: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  firstDay: string | null;
  lastDay: string | null;
  payoutFrom: string | null;
  payoutTo: string | null;
}

export interface PayoutSummary {
  /** firstDay / lastDay are the charge dates in the file; payoutFrom / payoutTo the payout dates it covers. */
  file: { rows: number; firstDay: string | null; lastDay: string | null; payoutFrom: string; payoutTo: string };
  /**
   * Earlier uploads covering any of the same dates, and how many of this file's lines they already
   * brought in. Re-uploading is safe - those lines are skipped - but people should see it coming.
   */
  overlap: { rowsSeenBefore: number; previousUploads: PreviousUpload[] };
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
  /**
   * Gifts the donor's bank returned. `state` is what CSP's posting says: `returned_gift` (never in
   * QuickBooks - only `cost` is left to book), `returned_after_posting` (CSP posted it first, so
   * QuickBooks still has it) or `returned_day_unsettled` (its day isn't fully posted yet). `cost` is
   * null until a line taking the gift back is uploaded. Nothing here is posted by CSP.
   */
  returned: {
    ref: string;
    givenOn: string;
    returnedOn: string | null;
    gift: number;
    /** The Stripe fee on the gift's charge: what CSP booked with it, if it posted the gift. */
    fee: number;
    cost: number | null;
    state: string;
  }[];
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
  links: Map<string, string>; // Stripe's lines for a returned gift -> the gift's donation id
  returned: PayoutSummary['returned'];
  /** Stored charges of gifts this file showed returned, refiled as the import records the file. */
  chargeUpdates: ChargeUpdate[];
}

interface ChargeUpdate {
  id: number;
  prevStatus: string;
  status: string;
  reason: string;
}

const toReturnLine = (r: any): ReturnLine => ({
  rowKey: String(r.rowKey),
  day: String(r.day),
  type: String(r.type),
  source: String(r.source),
  name: r.name ?? null,
  fundOrSignup: r.fundOrSignup ?? null,
  description: r.description ?? null,
  grossCents: Number(r.grossCents), // BIGINT arrives as a string from the database
  netCents: Number(r.netCents),
  feeCents: Number(r.feeCents ?? 0),
});

const STORED_CHARGE_FIELDS = [
  'id',
  'rowKey',
  'day',
  'type',
  'source',
  'name',
  'fundOrSignup',
  'description',
  'grossCents',
  'feeCents',
  'netCents',
  'status',
  'reason',
];

/** Stored gift charges with these donor names (where a return's gift is looked for). */
const storedChargesNamed = async (userId: number, names: string[]): Promise<any[]> =>
  names.length
    ? ((await PayoutTransaction.findAll({
        where: { userId, source: 'Giving', type: 'Charge', name: { [Op.in]: names }, rowKey: { [Op.like]: 'donation:%' } } as any,
        attributes: STORED_CHARGE_FIELDS,
      })) as any[])
    : [];

/**
 * Planning Center's word now on stored charges (rowKey -> the giving check's reason), asked fresh: a
 * stored reason can predate the gift coming back. Null when Planning Center can't be read.
 */
const askAboutStoredCharges = async (
  email: string,
  userId: number,
  givingStartDay: string | null,
  charges: any[],
): Promise<Map<string, string | undefined> | null> => {
  const out = new Map<string, string | undefined>();
  if (!charges.length) return out;
  const lines = charges.map(toReturnLine);
  const days = await loadDayCoverage(
    email,
    userId,
    lines.filter((c) => !givingStartDay || c.day >= givingStartDay).map((c) => c.day),
  );
  if (days === null) return null;
  const asked = lines.map((c) => ({ ...c, externalId: `donation:${donationIdOf(c)}` }));
  for (const res of givingCoverage(asked, { givingStartDay, days })) out.set(res.row.rowKey, res.reason);
  return out;
};

/** Gifts (donation ids) that already have a return line tied to them: a gift is returned once. */
const giftsWithReturn = async (userId: number, ids: string[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  const rows = (await PayoutTransaction.findAll({
    where: { userId, giftDonationId: { [Op.in]: ids }, type: { [Op.iLike]: '%fail%' } } as any,
    attributes: ['giftDonationId'],
  })) as any[];
  return new Set(rows.map((r) => String(r.giftDonationId)));
};

/**
 * Where a stored charge goes once its gift is known to be returned: one item for a person (held), or
 * a giving line "Check again" looks at once its day is posted. Lines a person already handled, or that
 * were posted as something else, are left alone (null).
 */
const chargeTarget = (status: string, reason: string | undefined): { status: string; reason: string } | null => {
  if (!['giving_covered', 'giving_not_posted', 'held'].includes(status)) return null;
  if (reason === 'returned_gift' || reason === 'returned_after_posting') return { status: 'held', reason };
  if (reason === 'returned_day_unsettled') return { status: 'giving_not_posted', reason };
  return null;
};

/**
 * Returned gifts (docs/plans/2026-11-10-payout-bounces.md): ties Stripe's "Charge failure" / "Fee"
 * lines to their gift - this file's charges, or ones an earlier upload stored (Planning Center asked
 * afresh about those) - and settles every line by updating `classified` and `coverage`:
 * - a returned gift's charge becomes one item for a person, held with its state (`returned_gift`,
 *   `returned_after_posting`); `returned_day_unsettled` waits like a day not yet posted;
 * - Stripe's lines tied to a gift are covered by it (`returned_gift_line`), keeping the link;
 * - Stripe's lines CSP can't tie wait for a person with the reason (or `planning_center_unreachable`).
 * Stored charges to refile are returned as `chargeUpdates`; the import applies them. Posts nothing.
 */
const settleReturnedGifts = async (
  setup: Pick<PayoutSetup, 'userId' | 'givingStartDay'>,
  email: string,
  classified: ClassifiedRow[],
  coverage: Map<string, CoverageResult<PayoutRow>>,
  planningCenterReached: boolean,
): Promise<Pick<Classified, 'links' | 'returned' | 'chargeUpdates'>> => {
  const { userId, givingStartDay } = setup;
  const stripeLines = classified.filter((c) => c.status === 'returned_line');
  const fileCharges = classified.filter((c) => c.status === 'giving' && isGivingCharge(c.row));
  const returnedReason = (c: ClassifiedRow) => coverage.get(c.row.rowKey)?.reason ?? '';
  const returnedIds = new Set(
    fileCharges.filter((c) => RETURNED_REASONS.includes(returnedReason(c))).map((c) => donationIdOf(c.row)!).filter(Boolean),
  );

  // A return can come in the month after its gift: look among the charges earlier uploads stored.
  const fileKeys = new Set(fileCharges.map((c) => c.row.rowKey));
  const names = [...new Set(stripeLines.filter((c) => isGivingFailure(c.row)).map((c) => c.row.name).filter(Boolean))];
  const stored = (await storedChargesNamed(userId, names)).filter((r) => !fileKeys.has(String(r.rowKey)));
  const asked = await askAboutStoredCharges(email, userId, givingStartDay, stored);
  const reached = planningCenterReached && asked !== null;
  const storedReason = (r: any) => asked?.get(String(r.rowKey));
  for (const r of stored) if (RETURNED_REASONS.includes(storedReason(r) ?? '')) returnedIds.add(donationIdOf({ rowKey: String(r.rowKey) })!);

  const allCharges = [...fileCharges.map((c) => toReturnLine(c.row)), ...stored.map(toReturnLine)];
  const links = linkReturnLines(
    stripeLines.map((c) => toReturnLine(c.row)),
    allCharges,
    returnedIds,
    await giftsWithReturn(userId, [...returnedIds]),
  );
  const preStart = preStartReturnLines(
    stripeLines.map((c) => toReturnLine(c.row)),
    allCharges,
    givingStartDay,
  );
  const linesByGift = new Map<string, ReturnLine[]>();
  for (const c of stripeLines) {
    const gift = links.gift.get(c.row.rowKey);
    if (gift) {
      linesByGift.set(gift, [...(linesByGift.get(gift) ?? []), toReturnLine(c.row)]);
      c.status = 'giving';
      coverage.set(c.row.rowKey, { row: c.row, status: 'giving_covered', reason: 'returned_gift_line' });
    } else if (links.unlinked.has(c.row.rowKey) && preStart.has(c.row.rowKey)) {
      // The gift is from before the sync start date: left alone, like the rest of that giving.
      c.status = 'giving';
      coverage.set(c.row.rowKey, { row: c.row, status: 'giving_covered', reason: 'before_giving_start' });
    } else {
      c.status = 'held';
      const why = links.unlinked.get(c.row.rowKey);
      c.reason = why && !reached ? 'planning_center_unreachable' : why ?? 'unrecognised_type';
    }
  }

  const returned: PayoutSummary['returned'] = [];
  const item = (id: string, charge: ReturnLine, state: string) => {
    const lines = linesByGift.get(id) ?? [];
    const cost = returnCostCents(charge, lines);
    const back = lines.filter(isGivingFailure).map((l) => l.day).sort();
    returned.push({
      ref: `Donation #${id}`,
      givenOn: charge.day,
      returnedOn: back.length ? back[back.length - 1] : null,
      gift: dollars(charge.grossCents),
      fee: dollars(Number(charge.feeCents ?? 0)),
      cost: cost === null ? null : dollars(cost),
      state,
    });
  };
  const inFile = new Set<string>();
  for (const c of fileCharges) {
    const reason = returnedReason(c);
    if (!RETURNED_REASONS.includes(reason)) continue;
    const id = donationIdOf(c.row)!;
    inFile.add(id);
    item(id, toReturnLine(c.row), reason);
    // The gift is the one item a person settles; `returned_day_unsettled` stays a giving line that
    // "Check again" looks at once the day is posted.
    if (reason !== 'returned_day_unsettled') {
      c.status = 'held';
      c.reason = reason;
      coverage.delete(c.row.rowKey);
    }
  }
  const chargeUpdates: ChargeUpdate[] = [];
  for (const id of linesByGift.keys()) {
    if (inFile.has(id)) continue;
    const charge = stored.find((r) => donationIdOf({ rowKey: String(r.rowKey) }) === id);
    // A gift a person already handled is not announced again (its new lines are tied to it quietly).
    if (!charge || charge.status === 'dismissed') continue;
    const reason = storedReason(charge) ?? 'returned_gift';
    item(id, toReturnLine(charge), reason);
    const target = chargeTarget(String(charge.status), reason);
    if (target && (target.status !== charge.status || target.reason !== charge.reason)) {
      chargeUpdates.push({ id: Number(charge.id), prevStatus: String(charge.status), ...target });
    }
  }
  return { links: links.gift, returned, chargeUpdates };
};

/** Stored charges refiled by the returned-gift rules, each only if nothing else moved it meanwhile. */
const applyChargeUpdates = async (updates: ChargeUpdate[]) => {
  for (const u of updates) {
    await PayoutTransaction.update({ status: u.status, reason: u.reason } as any, { where: { id: u.id, status: u.prevStatus } });
  }
};

/**
 * Ties stored return lines that are still open (held, no gift) to their gift: lines an upload couldn't
 * tie because the gift came in a later upload, Planning Center couldn't be read, or they were stored
 * before CSP knew returned gifts. Planning Center is asked afresh about the candidate gifts, and a gift
 * found returned is refiled as the item for a person. Run by "Check again" and after every upload.
 * Changes nothing when Planning Center can't be read. Returns the gifts (donation ids) it tied lines to.
 */
export const relinkStoredReturnLines = async (email: string, userId: number, givingStartDay: string | null): Promise<Set<string>> => {
  const open = (await PayoutTransaction.findAll({
    where: {
      userId,
      source: 'Giving',
      status: 'held',
      giftDonationId: null,
      [Op.or]: [{ type: { [Op.iLike]: '%fail%' } }, { type: { [Op.iLike]: 'fee' } }],
    } as any,
    attributes: ['id', 'rowKey', 'day', 'type', 'source', 'name', 'fundOrSignup', 'description', 'grossCents', 'netCents', 'reason'],
  })) as any[];
  const failures = open.filter((r) => isGivingFailure(toReturnLine(r)));
  if (!failures.length) return new Set();
  const charges = await storedChargesNamed(userId, [...new Set(failures.map((f) => f.name).filter(Boolean))] as string[]);
  const asked = await askAboutStoredCharges(email, userId, givingStartDay, charges);
  if (asked === null) return new Set();
  const returnedIds = new Set(
    charges.filter((c) => RETURNED_REASONS.includes(asked.get(String(c.rowKey)) ?? '')).map((c) => donationIdOf({ rowKey: String(c.rowKey) })!),
  );
  const links = linkReturnLines(open.map(toReturnLine), charges.map(toReturnLine), returnedIds, await giftsWithReturn(userId, [...returnedIds]));
  const preStart = preStartReturnLines(open.map(toReturnLine), charges.map(toReturnLine), givingStartDay);
  const tied = new Set<string>();
  for (const l of open) {
    const gift = links.gift.get(String(l.rowKey));
    if (gift) {
      const [n] = await PayoutTransaction.update(
        { status: 'giving_covered', reason: 'returned_gift_line', giftDonationId: gift } as any,
        { where: { id: Number(l.id), status: 'held' } },
      );
      if (n === 1) tied.add(gift);
      continue;
    }
    const why = links.unlinked.get(String(l.rowKey));
    if (why && preStart.has(String(l.rowKey))) {
      // The gift is from before the sync start date: left alone, like the rest of that giving.
      await PayoutTransaction.update({ status: 'giving_covered', reason: 'before_giving_start' } as any, {
        where: { id: Number(l.id), status: 'held' },
      });
    } else if (why && why !== l.reason) {
      await PayoutTransaction.update({ reason: why } as any, { where: { id: Number(l.id), status: 'held' } });
    }
  }
  const updates: ChargeUpdate[] = [];
  for (const c of charges) {
    if (!tied.has(donationIdOf({ rowKey: String(c.rowKey) }) ?? '')) continue;
    const target = chargeTarget(String(c.status), asked.get(String(c.rowKey)));
    if (target && (target.status !== c.status || target.reason !== c.reason)) {
      updates.push({ id: Number(c.id), prevStatus: String(c.status), ...target });
    }
  }
  await applyChargeUpdates(updates);
  return tied;
};

const classify = async (setup: PayoutSetup, email: string, csvText: string, payouts: PayoutRange): Promise<Classified> => {
  const rows = parsePayoutReport(csvText);
  assertRowsWithinPayouts(rows, payouts);
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
  const returned = await settleReturnedGifts(setup, email, classified, coverage, days !== null);
  return { rows, classified, coverage, stored, ...returned };
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

/** Uploads whose charge dates overlap [firstDay, lastDay], newest first. */
const earlierUploads = async (
  userId: number,
  firstDay: string | null,
  lastDay: string | null,
  excludeId?: number,
): Promise<PreviousUpload[]> => {
  if (!firstDay || !lastDay) return [];
  const rows = await PayoutReportUpload.findAll({
    where: {
      userId,
      firstDay: { [Op.lte]: lastDay },
      lastDay: { [Op.gte]: firstDay },
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 5,
  });
  return (rows as any[]).map((u) => ({
    id: Number(u.id),
    fileName: u.fileName ?? null,
    uploadedAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
    uploadedBy: u.uploadedBy ?? null,
    firstDay: u.firstDay ?? null,
    lastDay: u.lastDay ?? null,
    payoutFrom: u.payoutFrom ?? null,
    payoutTo: u.payoutTo ?? null,
  }));
};

const summarize = (
  c: Classified,
  entries: PayoutSummary['entries'],
  previousUploads: PreviousUpload[],
  payouts: PayoutRange,
): PayoutSummary => {
  const toPost = c.classified.filter((x) => x.status === 'to_post').map((x) => x.row);
  const beforeStart = c.classified.filter((x) => x.status === 'before_start').map((x) => x.row);
  const known = c.classified.filter((x) => x.status === 'already_recorded');
  const days = c.rows.map((r) => r.day).sort();

  // Settled by an earlier upload - not lines a person is still looking at.
  let covered = known.filter(
    (x) => x.row.source === 'Giving' && !['held', 'dismissed', 'failed', 'pending'].includes(c.stored.get(x.row.rowKey)?.status ?? ''),
  ).length;
  const notPosted = new Map<string, { day: string; count: number; netCents: number; reason: string }>();
  for (const cov of c.coverage.values()) {
    // A returned gift and its lines are listed under `returned`, not as giving in or out of QuickBooks.
    if (cov.reason === 'returned_gift_line' || RETURNED_REASONS.includes(cov.reason ?? '')) continue;
    if (cov.status === 'giving_covered') {
      covered++;
      continue;
    }
    const reason = cov.reason ?? 'day_not_posted';
    // The day Planning Center files the gift on: the day to look at in Daily Giving.
    const day = cov.day ?? cov.row.day;
    const key = `${day}|${reason}`;
    const n = notPosted.get(key) ?? { day, count: 0, netCents: 0, reason };
    n.count++;
    n.netCents += cov.row.netCents;
    notPosted.set(key, n);
  }

  const reg = figures(toPost);
  return {
    file: {
      rows: c.rows.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      payoutFrom: payouts.from,
      payoutTo: payouts.to,
    },
    overlap: { rowsSeenBefore: c.rows.filter((r) => c.stored.has(r.rowKey)).length, previousUploads },
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
    returned: c.returned,
    held: c.classified
      // A returned gift's own line is its `returned` entry.
      .filter((x) => x.status === 'held' && !RETURNED_REASONS.includes(x.reason ?? ''))
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
  const recheck: { id: number; prev: string; status: string; reason: string | null; giftDonationId: string | null }[] = [];
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
    const giftDonationId = c.links.get(item.row.rowKey) ?? null;
    if (!prev) fresh.push({ ...rowFields(item.row), userId, uploadId, status, reason, giftDonationId });
    else if (RECHECKED_STATUSES.includes(prev.status)) recheck.push({ id: prev.id, prev: prev.status, status, reason, giftDonationId });
  }
  if (fresh.length) await PayoutTransaction.bulkCreate(fresh, { ignoreDuplicates: true });
  for (const r of recheck) {
    await PayoutTransaction.update({ status: r.status, reason: r.reason, uploadId, giftDonationId: r.giftDonationId } as any, {
      where: { id: r.id, status: r.prev },
    });
  }
};

/**
 * Every row of this file was paid out within its payout dates. A row that appears in several files
 * takes the earliest range (the month-end report's rule) - of two ending the same day, the narrower,
 * as `earlier` in outstanding.ts does - so point it at this upload unless it is already in one whose
 * payouts ended sooner, or ended the same day and began no earlier. Re-uploading a file with
 * corrected, earlier dates therefore corrects its rows.
 */
const markPaidOutIn = async (userId: number, uploadId: number, payouts: PayoutRange, rows: PayoutRow[]) => {
  const keys = [...new Set(rows.map((r) => r.rowKey))];
  for (let i = 0; i < keys.length; i += 1000) {
    await sequelize.query(
      `UPDATE "PayoutTransactions" t SET "payoutUploadId" = :uploadId
        WHERE t."userId" = :userId AND t."rowKey" IN (:keys)
          AND NOT EXISTS (
            SELECT 1 FROM "PayoutReportUploads" u
             WHERE u.id = t."payoutUploadId" AND u."payoutTo" IS NOT NULL
               AND (u."payoutTo" < :payoutTo OR (u."payoutTo" = :payoutTo AND u."payoutFrom" >= :payoutFrom))
          )`,
      { replacements: { uploadId, userId, keys: keys.slice(i, i + 1000), payoutTo: payouts.to, payoutFrom: payouts.from } },
    );
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

/**
 * The payout dates the file was exported for ("Payouts in this file: from / to"). Required on every
 * upload: the rows carry charge dates only, so this is the one record of when they were paid out,
 * which the month-end "still in transit" report reads.
 */
export interface UploadPayoutDates {
  payoutFrom?: unknown;
  payoutTo?: unknown;
  /** For tests: the moment "in the future" is judged against. */
  now?: Date;
}

/** What an import would do. Reads only - nothing is stored or posted. */
export const previewPayoutReport = async (
  p: { email: string; csvText: string } & UploadPayoutDates,
): Promise<PayoutSummary> => {
  const payouts = await assertPayoutRange(p.email, p.payoutFrom, p.payoutTo, p.now);
  const setup = await loadSetup(p.email);
  const c = await classify(setup, p.email, p.csvText, payouts);
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
  const fileDays = c.rows.map((r) => r.day).sort();
  return summarize(
    c,
    entries,
    await earlierUploads(setup.userId, fileDays[0] ?? null, fileDays[fileDays.length - 1] ?? null),
    payouts,
  );
};

/**
 * Records a payout report: posts every registration charge and refund it has not seen, once,
 * stores the giving check and anything it could not recognise, and returns what it did.
 */
export const importPayoutReport = async (
  p: {
    email: string;
    fileName?: string | null;
    csvText: string;
    uploadedBy?: string | null;
  } & UploadPayoutDates,
): Promise<PayoutSummary & { uploadId: number }> => {
  const payouts = await assertPayoutRange(p.email, p.payoutFrom, p.payoutTo, p.now);
  const setup = await loadSetup(p.email);
  return withChurchLock(setup.userId, async () => {
    const c = await classify(setup, p.email, p.csvText, payouts);
    assertFeeAccount(c.classified, setup);
    const days = c.rows.map((r) => r.day).sort();
    const upload: any = await PayoutReportUpload.create({
      userId: setup.userId,
      fileName: p.fileName ? String(p.fileName).slice(0, 512) : null,
      uploadedBy: p.uploadedBy ? String(p.uploadedBy).slice(0, 256) : null,
      rowCount: c.rows.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      payoutFrom: payouts.from,
      payoutTo: payouts.to,
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

    // 3. Everything else, when each row was paid out, and the summary.
    await storeOtherRows(c, upload.id, setup.userId);
    // Returned gifts: refile stored charges this file showed returned, then tie any return lines still
    // open - from this upload or earlier ones - now that this file's gifts are stored too.
    await applyChargeUpdates(c.chargeUpdates);
    await relinkStoredReturnLines(p.email, setup.userId, setup.givingStartDay);
    await markPaidOutIn(setup.userId, Number(upload.id), payouts, c.rows);
    const previous = await earlierUploads(setup.userId, days[0] ?? null, days[days.length - 1] ?? null, Number(upload.id));
    const summary = summarize(c, entries, previous, payouts);
    await upload.update({ summary });
    return { ...summary, uploadId: Number(upload.id) };
  });
};
