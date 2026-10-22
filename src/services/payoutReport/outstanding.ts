/* eslint-disable @typescript-eslint/no-explicit-any */
import { addDays, shortDay } from './days';

/**
 * "Still in transit at month-end": every gift and registration CSP put into the Clearing account
 * that Stripe had not paid out by a given day D, tied to QuickBooks' Clearing balance on D. Plan and
 * contract: docs/plans/2026-10-22-outstanding-deposits.md in the frontend repo.
 *
 * This file is the arithmetic only - no database, Planning Center or QuickBooks - so the rule can be
 * read and tested in one place and run against exported files. `outstandingReport.ts` loads the
 * inputs. Amounts are integer cents in, dollars out (signed: refunds negative).
 *
 * The rule, for D. The payout report's rows carry no payout date, but each upload records the PAYOUT
 * dates it was exported for, so an item
 *   - in a file whose payout range ends on or before D was paid out by D: not in transit;
 *   - in a file whose payout range starts after D was paid out after D: in transit at D;
 *   - in no file has not been paid out as far as CSP knows: in transit at D.
 * An item in several files takes its earliest payout range. Ranges never cross a month-end (the
 * upload refuses that), so for a month-end D no range straddles it.
 */

/** An upload's payout dates. Null on uploads made before they were asked for ("range unknown"). */
export interface UploadRange {
  id: number;
  payoutFrom: string | null;
  payoutTo: string | null;
  lastDay: string | null; // last charge date in the file
}

/** A payout-report row as stored in PayoutTransactions. */
export interface StoredPayoutRow {
  rowKey: string;
  uploadId: number | null;
  /** The upload with the earliest payout range the row has appeared in; null on older rows (use uploadId). */
  payoutUploadId?: number | null;
  day: string; // charge or refund date
  type: string; // 'Charge' | 'Refund' | ...
  source: string; // 'Giving' | 'Registrations' | ...
  name: string | null;
  fundOrSignup: string | null;
  grossCents: number;
  feeCents: number;
  netCents: number;
  status: string;
}

/** One day of CSP's own ledger (DailyJeSync): what it posted to Clearing for giving. */
export interface LedgerDay {
  day: string;
  postedGrossCents: number;
  postedFeeCents: number;
  refundedGrossCents: number;
  refundedFeeCents: number;
}

/**
 * One of Planning Center's gifts for a day, already through the posting engine's own test
 * (`wasStripeElectronic`: card or ACH, succeeded, a Stripe fee - refunded since or not), grouped by
 * the church's local day exactly as the engine groups them.
 */
export interface PcoGift {
  id: string;
  grossCents: number;
  feeCents: number; // positive
  completedAt: string | null;
  refunded: boolean;
  fund: string | null;
  /** None of its funds is mapped: the engine leaves such a gift out of the day's entry whole. */
  unmapped?: boolean;
}

/** A QuickBooks entry in the Clearing account (General Ledger detail), amount in the account's own sign. */
export interface GlEntry {
  date: string;
  type: string;
  docNumber: string;
  memo: string;
  amountCents: number;
}

/** QuickBooks' Clearing account on D. balanceCents null when it could not be read; message says why. */
export interface ClearingOnDay {
  account: { id: string; name: string } | null;
  balanceCents: number | null;
  message?: string;
  /** Entries CSP did not make (DocNumber not starting CSP-), from the report's start day to D. */
  entries: GlEntry[];
}

/** The switch-over, from the transition panel's settings. */
export interface SwitchOverFacts {
  goLiveDay: string;
  balanceAtGoLiveCents: number | null;
  truedUpAt: string | null;
}

export interface DayWindow {
  from: string;
  to: string;
}

export interface OutstandingInput {
  month: string; // YYYY-MM
  asOf: string; // D
  /** The church's sync start date - CSP's days begin here. Null: nothing to report. */
  startDay: string | null;
  uploads: UploadRange[];
  rows: StoredPayoutRow[];
  ledgers: LedgerDay[];
  /** Planning Center's gifts by local day, for the days in `examined`. */
  gifts: Map<string, PcoGift[]>;
  /** The days Planning Center was read for (a day in here with no entry in `gifts` had none). */
  examined: DayWindow[];
  clearing: ClearingOnDay | null;
  switchOver: SwitchOverFacts | null;
}

export type ItemKind = 'gift' | 'gift_refund' | 'registration' | 'registration_refund' | 'day_unresolved';
/** When an item was paid out. `from` is null for an upload whose payout dates are unknown. */
export interface PaidOut {
  from: string | null;
  to: string;
}
export interface OutstandingItem {
  day: string;
  kind: ItemKind;
  ref: string | null; // 'Donation #123' / 'Registration #456'
  name: string | null;
  fundOrEvent: string | null;
  gross: number;
  fee: number;
  net: number;
  /** null: not paid out yet as far as CSP knows. Otherwise the payouts it was paid out in (after D). */
  paidOut: PaidOut | null;
}
export interface GroupTotals {
  count: number;
  gross: number;
  fee: number;
  net: number;
}
export interface DifferenceNote {
  kind: 'switch_over' | 'not_csp';
  text: string;
  amount: number;
  entries?: { date: string; type: string; amount: number; memo: string; docNumber: string }[];
}
export interface OutstandingReport {
  month: string;
  asOf: string;
  /** Set when there is nothing to report (before the sync start date, nothing posted yet). */
  message?: string;
  coverage: { complete: boolean; from: string | null; missing: DayWindow[] };
  qbo: { account: { id: string; name: string } | null; balance: number | null; message?: string };
  inTransit: { net: number; gifts: GroupTotals; registrations: GroupTotals };
  difference: number | null;
  differenceNotes: DifferenceNote[];
  notInQuickBooksYet: { day: string; count: number; gross: number; net: number }[];
  items: OutstandingItem[];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const dollars = (cents: number) => Math.round(cents) / 100;

const longDay = (day: string) => shortDay(day, true);

/** "$1,234.56" / "-$1,234.56". */
export const usd = (cents: number): string => {
  const abs = Math.abs(Math.round(cents));
  const s = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${s}` : s;
};

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

/** Statuses of rows CSP posted to Clearing itself (as registration entries): upload or review list. */
const IN_CLEARING = ['posted', 'resolved'];

const ID_IN_KEY = /^(donation|registration):(\d+):/;

const paidOutOf = (row: StoredPayoutRow, uploads: Map<number, UploadRange>): PaidOut => {
  const id = row.payoutUploadId ?? row.uploadId;
  const u = id == null ? undefined : uploads.get(Number(id));
  if (u?.payoutFrom && u?.payoutTo) return { from: u.payoutFrom, to: u.payoutTo };
  // Range unknown (an upload from before the payout dates were asked for): treated as paid out by
  // the last charge date in its file. Coverage counts these uploads as gaps, so the report says
  // its total is incomplete wherever this guess matters.
  return { from: null, to: u?.lastDay ?? row.day };
};

const paidBy = (p: PaidOut | null | undefined, day: string) => !!p && p.to <= day;

const earlier = (a: PaidOut, b: PaidOut) => (a.to !== b.to ? a.to < b.to : (a.from ?? a.to) < (b.from ?? b.to));

interface Placed {
  row: StoredPayoutRow;
  id: string | null; // Planning Center id from the row key
  paidOut: PaidOut;
}

interface RowIndex {
  /** Giving charges by donation id - the earliest payout range among the files it is in. */
  giftPaid: Map<string, Placed>;
  /** Giving charges by the file's charge date. */
  givingByDay: Map<string, Placed[]>;
  /** Giving refunds by the file's refund date. */
  givingRefundsByDay: Map<string, Placed[]>;
  /** Rows CSP posted to Clearing as registration entries. */
  registrations: Placed[];
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

const indexRows = (rows: StoredPayoutRow[], uploads: UploadRange[]): RowIndex => {
  const byId = new Map(uploads.map((u) => [Number(u.id), u]));
  const idx: RowIndex = { giftPaid: new Map(), givingByDay: new Map(), givingRefundsByDay: new Map(), registrations: [] };
  for (const row of rows) {
    const m = ID_IN_KEY.exec(String(row.rowKey));
    const placed: Placed = { row, id: m ? m[2] : null, paidOut: paidOutOf(row, byId) };
    if (row.source === 'Giving' && row.type === 'Charge') {
      push(idx.givingByDay, row.day, placed);
      if (placed.id) {
        const seen = idx.giftPaid.get(placed.id);
        if (!seen || earlier(placed.paidOut, seen.paidOut)) idx.giftPaid.set(placed.id, placed);
      }
    } else if (row.source === 'Giving' && row.type === 'Refund') {
      push(idx.givingRefundsByDay, row.day, placed);
    }
    if (IN_CLEARING.includes(row.status)) idx.registrations.push(placed);
  }
  return idx;
};

// ---------------------------------------------------------------------------------------------
// Coverage

/** Which days from `from` to `to` the uploads' payout ranges cover. Unknown ranges cover nothing. */
export const coverageOf = (from: string, to: string, uploads: UploadRange[]) => {
  const ranges = uploads
    .filter((u) => u.payoutFrom && u.payoutTo)
    .map((u) => ({ from: (u.payoutFrom as string) > from ? (u.payoutFrom as string) : from, to: (u.payoutTo as string) < to ? (u.payoutTo as string) : to }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  const missing: DayWindow[] = [];
  let cursor = from;
  for (const r of ranges) {
    if (cursor > to) break;
    if (r.from > cursor) missing.push({ from: cursor, to: addDays(r.from, -1) });
    if (r.to >= cursor) cursor = addDays(r.to, 1);
  }
  if (cursor <= to) missing.push({ from: cursor, to });
  return { complete: missing.length === 0, from, missing };
};

// ---------------------------------------------------------------------------------------------
// Which days need Planning Center

const postedNet = (l: LedgerDay) => Number(l.postedGrossCents) - Number(l.postedFeeCents);

/**
 * The days (start..D) the report must read from Planning Center.
 *
 * A posted day whose posted net equals the net of its giving rows in files paid out by D is done
 * by the files alone. Every other posted day needs Planning Center's gift list to say which gifts
 * are still in transit. So does any day with a giving line an upload found not (fully) posted: the
 * files alone can't settle it (a paid gift that was never posted can match an unpaid one that was),
 * and it is where giving "not in QuickBooks yet" is.
 */
export const daysNeedingPlanningCenter = (p: {
  asOf: string;
  startDay: string | null;
  ledgers: LedgerDay[];
  rows: StoredPayoutRow[];
  uploads: UploadRange[];
}): string[] => {
  const start = p.startDay;
  if (!start || p.asOf < start) return [];
  const inPeriod = (day: string) => day >= start && day <= p.asOf;
  const idx = indexRows(p.rows, p.uploads);
  const unsettled = p.ledgers
    .filter((l) => inPeriod(l.day) && Number(l.postedGrossCents) > 0)
    .filter((l) => {
      const paid = (idx.givingByDay.get(l.day) ?? []).filter((x) => paidBy(x.paidOut, p.asOf));
      return sum(paid, (x) => Number(x.row.netCents)) !== postedNet(l);
    })
    .map((l) => l.day);
  const notPostedWhenUploaded = p.rows
    .filter((r) => r.source === 'Giving' && r.type === 'Charge' && r.status === 'giving_not_posted' && inPeriod(r.day))
    .map((r) => r.day);
  return [...new Set([...unsettled, ...notPostedWhenUploaded])].sort();
};

/**
 * Days grouped into Planning Center reads: one read per run of days no more than `gap` days apart,
 * each at most `span` days long.
 */
export const planningCenterWindows = (days: string[], gap = 7, span = 92): DayWindow[] => {
  const sorted = [...new Set(days)].sort();
  const out: DayWindow[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d <= addDays(last.to, gap) && d <= addDays(last.from, span - 1)) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Which of a day's gifts are in Clearing

const byCompletedLatestFirst = (a: PcoGift, b: PcoGift) => {
  if (a.completedAt === b.completedAt) return b.id.localeCompare(a.id);
  if (!a.completedAt) return 1;
  if (!b.completedAt) return -1;
  return b.completedAt.localeCompare(a.completedAt);
};

/**
 * Which of a day's gifts CSP's posted total is made of. CSP keeps day totals, not gift ids.
 *
 * A gift in an unmapped fund is never part of it: the engine leaves such a gift out whole. Of the
 * rest:
 *  - Planning Center's total equals what was posted: every gift is in Clearing (a gift refunded
 *    since stays in - its refund is a separate entry on the refund day).
 *  - Without the gifts refunded since, it equals what was posted: those were refunded before the
 *    day was posted, so never in it.
 *  - Planning Center has more (late ACH not added yet): the gifts that completed last were not
 *    there when the day was posted - drop them, latest first, until what is left equals the posted
 *    total.
 * Settled gifts left out are "not in QuickBooks yet". When nothing adds up exactly (a failed ACH
 * after posting), or two different sets of gifts would, the answer is null: the day is shown as one
 * line rather than guessed at.
 */
export const resolvePostedGifts = (
  gifts: PcoGift[],
  postedGrossCents: number,
): { posted: PcoGift[]; notYet: PcoGift[] } | null => {
  const gross = (gs: PcoGift[]) => sum(gs, (g) => g.grossCents);
  const postable = gifts.filter((g) => !g.unmapped);
  const live = gifts.filter((g) => !g.refunded);
  const answer = (posted: PcoGift[]) => ({ posted, notYet: live.filter((g) => !posted.includes(g)) });
  if (postedGrossCents === 0) return answer([]);

  const candidates: PcoGift[][] = [];
  const livePostable = postable.filter((g) => !g.refunded);
  if (gross(postable) === postedGrossCents) candidates.push(postable);
  if (gross(livePostable) === postedGrossCents) candidates.push(livePostable);
  const latestFirst = [...livePostable].sort(byCompletedLatestFirst);
  for (const base of [postable, livePostable]) {
    let kept = base;
    let total = gross(base);
    for (const g of latestFirst) {
      if (total <= postedGrossCents) break;
      kept = kept.filter((k) => k !== g);
      total -= g.grossCents;
      if (total === postedGrossCents) {
        candidates.push(kept);
        break;
      }
    }
  }
  const key = (gs: PcoGift[]) => gs.map((g) => g.id).sort().join(',');
  const distinct = [...new Map(candidates.map((c) => [key(c), c])).values()];
  return distinct.length === 1 ? answer(distinct[0]) : null;
};

// ---------------------------------------------------------------------------------------------
// The report

const zeroTotals = (): GroupTotals => ({ count: 0, gross: 0, fee: 0, net: 0 });

const qboBlock = (c: ClearingOnDay | null): OutstandingReport['qbo'] => ({
  account: c?.account ?? null,
  balance: c?.balanceCents == null ? null : dollars(c.balanceCents),
  ...(c?.message ? { message: c.message } : {}),
});

const emptyReport = (input: OutstandingInput, from: string | null, message: string): OutstandingReport => ({
  month: input.month,
  asOf: input.asOf,
  message,
  coverage: { complete: true, from, missing: [] },
  qbo: qboBlock(input.clearing),
  inTransit: { net: 0, gifts: zeroTotals(), registrations: zeroTotals() },
  difference: null,
  differenceNotes: [],
  notInQuickBooksYet: [],
  items: [],
});

const KIND_ORDER: ItemKind[] = ['gift', 'gift_refund', 'day_unresolved', 'registration', 'registration_refund'];

interface CentsItem extends Omit<OutstandingItem, 'gross' | 'fee' | 'net'> {
  grossCents: number;
  feeCents: number;
  netCents: number;
}

const fromRow = (p: Placed, kind: ItemKind, paidOut: PaidOut | null): CentsItem => ({
  day: p.row.day,
  kind,
  ref: p.id ? `${p.row.source === 'Registrations' ? 'Registration' : 'Donation'} #${p.id}` : null,
  name: p.row.name ?? null,
  fundOrEvent: p.row.fundOrSignup ?? null,
  grossCents: Number(p.row.grossCents),
  feeCents: Number(p.row.grossCents) - Number(p.row.netCents),
  netCents: Number(p.row.netCents),
  paidOut,
});

const daysOf = (w: DayWindow): string[] => {
  const out: string[] = [];
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * The report for D from plain inputs. The caller must have read Planning Center for every day
 * `daysNeedingPlanningCenter` returns; a needed day it did not read shows as one unresolved line.
 */
export const computeOutstanding = (input: OutstandingInput): OutstandingReport => {
  const D = input.asOf;
  const start = input.startDay;
  if (!start) return emptyReport(input, null, "CSP hasn't posted anything to Clearing yet, so nothing is in transit.");
  if (D < start) {
    return emptyReport(
      input,
      start,
      `CSP's sync starts on ${longDay(start)}, after ${longDay(D)}, so nothing of CSP's was in Clearing then.`,
    );
  }

  const idx = indexRows(input.rows, input.uploads);
  const ledgerByDay = new Map(input.ledgers.map((l) => [l.day, l]));
  const needed = new Set(daysNeedingPlanningCenter(input));
  const examinedDays = new Set(input.examined.flatMap(daysOf));
  const days = [
    ...new Set([...input.ledgers.map((l) => l.day), ...examinedDays].filter((d) => d >= start && d <= D)),
  ].sort();

  const items: CentsItem[] = [];
  const notYet: OutstandingReport['notInQuickBooksYet'] = [];

  for (const day of days) {
    const l = ledgerByDay.get(day);
    const postedGross = Number(l?.postedGrossCents ?? 0);
    const postedFee = Number(l?.postedFeeCents ?? 0);
    const gifts = input.gifts.get(day) ?? (examinedDays.has(day) ? [] : null);
    const resolved = gifts ? resolvePostedGifts(gifts, postedGross) : null;

    if (resolved?.notYet.length) {
      const g = sum(resolved.notYet, (x) => x.grossCents);
      notYet.push({
        day,
        count: resolved.notYet.length,
        gross: dollars(g),
        net: dollars(g - sum(resolved.notYet, (x) => x.feeCents)),
      });
    }

    if (needed.has(day)) {
      if (gifts && resolved) {
        for (const g of resolved.posted) {
          const paid = idx.giftPaid.get(g.id);
          if (paidBy(paid?.paidOut, D)) continue;
          items.push({
            day,
            kind: 'gift',
            ref: `Donation #${g.id}`,
            name: paid?.row.name ?? null,
            fundOrEvent: g.fund ?? paid?.row.fundOrSignup ?? null,
            grossCents: g.grossCents,
            feeCents: g.feeCents,
            netCents: g.grossCents - g.feeCents,
            paidOut: paid?.paidOut ?? null,
          });
        }
      } else {
        // Can't tell which gifts the posted total is made of: one line for whatever of it is not
        // known to be paid out by D.
        // Only gifts the engine could have posted count as paid, and never more than was posted.
        const ids = gifts ? new Set(gifts.filter((g) => !g.unmapped).map((g) => g.id)) : null;
        const paid = ids
          ? [...ids].map((id) => idx.giftPaid.get(id)).filter((x): x is Placed => !!x && paidBy(x.paidOut, D))
          : (idx.givingByDay.get(day) ?? []).filter((x) => paidBy(x.paidOut, D));
        const grossCents = Math.max(0, postedGross - sum(paid, (x) => Number(x.row.grossCents)));
        const netCents = Math.max(0, postedGross - postedFee - sum(paid, (x) => Number(x.row.netCents)));
        if (grossCents !== 0 || netCents !== 0) {
          items.push({
            day,
            kind: 'day_unresolved',
            ref: null,
            name: null,
            fundOrEvent: null,
            grossCents,
            feeCents: grossCents - netCents,
            netCents,
            paidOut: null,
          });
        }
      }
    }

    // Giving refunds CSP posted on this day: a reversing entry, out of Clearing, until Stripe takes
    // it from a payout (a Type=Refund row in a file).
    const refundedGross = Number(l?.refundedGrossCents ?? 0);
    if (refundedGross > 0) {
      const reversedNet = refundedGross - Number(l?.refundedFeeCents ?? 0);
      const rows = idx.givingRefundsByDay.get(day) ?? [];
      const paid = rows.filter((x) => paidBy(x.paidOut, D));
      const paidNet = -sum(paid, (x) => Number(x.row.netCents));
      // More taken from payouts than CSP reversed means refunds CSP never posted (an unmapped
      // fund): nothing of CSP's is left in transit for the day.
      if (paidNet < reversedNet) {
        if (-sum(rows, (x) => Number(x.row.netCents)) === reversedNet) {
          for (const r of rows) if (!paidBy(r.paidOut, D)) items.push(fromRow(r, 'gift_refund', r.paidOut));
        } else {
          const grossCents = Math.min(0, -(refundedGross + sum(paid, (x) => Number(x.row.grossCents))));
          const netCents = -(reversedNet - paidNet);
          items.push({
            day,
            kind: 'gift_refund',
            ref: null,
            name: null,
            fundOrEvent: null,
            grossCents,
            feeCents: grossCents - netCents,
            netCents,
            paidOut: null,
          });
        }
      }
    }
  }

  // Registrations: recorded only from payout reports, so each has a payout range.
  for (const r of idx.registrations) {
    if (r.row.day > D || paidBy(r.paidOut, D)) continue;
    items.push(fromRow(r, Number(r.row.grossCents) < 0 ? 'registration_refund' : 'registration', r.paidOut));
  }

  items.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      String(a.ref ?? '').localeCompare(String(b.ref ?? '')),
  );

  const group = (kinds: ItemKind[], counted: ItemKind) => {
    const xs = items.filter((i) => kinds.includes(i.kind));
    return {
      count: xs.filter((i) => i.kind === counted).length,
      grossCents: sum(xs, (i) => i.grossCents),
      feeCents: sum(xs, (i) => i.feeCents),
      netCents: sum(xs, (i) => i.netCents),
    };
  };
  const gifts = group(['gift', 'gift_refund', 'day_unresolved'], 'gift');
  const regs = group(['registration', 'registration_refund'], 'registration');
  const inTransitCents = gifts.netCents + regs.netCents;
  const totals = (g: ReturnType<typeof group>): GroupTotals => ({
    count: g.count,
    gross: dollars(g.grossCents),
    fee: dollars(g.feeCents),
    net: dollars(g.netCents),
  });

  const coverage = coverageOf(start, D, input.uploads);
  const balance = input.clearing?.balanceCents ?? null;
  const differenceCents = balance === null ? null : balance - inTransitCents;

  return {
    month: input.month,
    asOf: D,
    coverage,
    qbo: qboBlock(input.clearing),
    inTransit: { net: dollars(inTransitCents), gifts: totals(gifts), registrations: totals(regs) },
    difference: differenceCents === null ? null : dollars(differenceCents),
    differenceNotes:
      differenceCents === null ? [] : differenceNotes(differenceCents, input, start, coverage.complete),
    notInQuickBooksYet: notYet,
    items: items.map(({ grossCents, feeCents, netCents, ...rest }) => ({
      ...rest,
      gross: dollars(grossCents),
      fee: dollars(feeCents),
      net: dollars(netCents),
    })),
  };
};

/**
 * The difference (QuickBooks' balance on D less what is in transit), explained where CSP knows why:
 * the balance the account already held when CSP took over, then anything else as "QuickBooks has
 * $X that CSP's records don't account for", with the entries in Clearing CSP didn't make so the
 * team can look.
 */
const differenceNotes = (
  differenceCents: number,
  input: OutstandingInput,
  start: string,
  coverageComplete: boolean,
): DifferenceNote[] => {
  if (differenceCents === 0) return [];
  const notes: DifferenceNote[] = [];
  const D = input.asOf;
  const s = input.switchOver;
  let explained = 0;
  if (s && s.goLiveDay <= D && s.balanceAtGoLiveCents != null && Number(s.balanceAtGoLiveCents) !== 0) {
    const S = Number(s.balanceAtGoLiveCents);
    explained = S;
    const held =
      S > 0
        ? `QuickBooks already held ${usd(S)} in Clearing when CSP took over on ${longDay(s.goLiveDay)}.`
        : `Clearing was already ${usd(-S)} below zero when CSP took over on ${longDay(s.goLiveDay)}.`;
    notes.push({
      kind: 'switch_over',
      text:
        `${held} That isn't CSP's money, so it isn't in this list.` +
        (s.truedUpAt ? ` The switch-over true-up was marked done on ${longDay(s.truedUpAt.slice(0, 10))}.` : ''),
      amount: dollars(S),
    });
  }
  const rest = differenceCents - explained;
  if (rest !== 0) {
    const lead =
      rest > 0
        ? `QuickBooks has ${usd(rest)} in Clearing on ${longDay(D)} that CSP's records don't account for.`
        : `QuickBooks has ${usd(-rest)} less in Clearing on ${longDay(D)} than CSP's records account for.`;
    const entries = input.clearing?.entries ?? [];
    notes.push({
      kind: 'not_csp',
      text:
        `${lead} ` +
        (entries.length
          ? `These are the entries in Clearing from ${longDay(start)} to ${longDay(D)} that CSP didn't make; a deposit recorded for a different amount than its payout shows up here too.`
          : `There are no entries in Clearing from ${longDay(start)} to ${longDay(D)} that CSP didn't make.`) +
        (coverageComplete ? '' : ' Payout reports are missing for part of this period, so some of this may be money that was paid out.'),
      amount: dollars(rest),
      entries: entries.map((e) => ({
        date: e.date,
        type: e.type,
        amount: dollars(e.amountCents),
        memo: e.memo,
        docNumber: e.docNumber,
      })),
    });
  }
  return notes;
};

// ---------------------------------------------------------------------------------------------
// QuickBooks' General Ledger detail report

const COLUMN_KEYS = ['tx_date', 'txn_type', 'doc_num', 'memo', 'subt_nat_amount'] as const;
/** What `reportGeneralLedgerDetail` is asked for, in this order. */
export const GL_COLUMNS = COLUMN_KEYS.join(',');

export interface QboAccountFacts {
  Id: string;
  Name?: string;
  AcctNum?: string;
  FullyQualifiedName?: string;
}

/**
 * The Clearing account's rows from a General Ledger detail report - or 'wrong_account' when the
 * report has sections and none of them is that account. `reportTransactionList` ignores an account
 * filter and returns the whole company with HTTP 200; this report honours it, but its own section
 * header is the proof, so the figure is never used without it. No sections at all means the account
 * had no activity in the range.
 */
export const readGeneralLedger = (
  report: any,
  account: QboAccountFacts,
): { rows: GlEntry[]; withSubAccounts: boolean } | 'wrong_account' | 'unreadable' => {
  const cols: any[] = report?.Columns?.Column ?? [];
  const keyOf = (c: any) =>
    String((c?.MetaData ?? []).find((m: any) => m?.Name === 'ColKey')?.Value ?? c?.ColType ?? '').toLowerCase();
  const at: Record<string, number> = {};
  COLUMN_KEYS.forEach((k, i) => {
    const found = cols.findIndex((c) => keyOf(c) === k);
    at[k] = found >= 0 ? found : i;
  });

  const names = new Set(
    [
      account.Name,
      account.FullyQualifiedName,
      account.AcctNum && account.Name ? `${account.AcctNum} ${account.Name}` : null,
      account.AcctNum && account.FullyQualifiedName ? `${account.AcctNum} ${account.FullyQualifiedName}` : null,
    ]
      .filter(Boolean)
      .map((n) => String(n).trim().toLowerCase()),
  );
  const isAccount = (section: any) => {
    const h = section?.Header?.ColData?.[0];
    if (!h) return false;
    if (h.id != null && String(h.id) === String(account.Id)) return true;
    return names.has(String(h.value ?? '').trim().toLowerCase());
  };

  let sawSection = false;
  const find = (rows: any[]): any => {
    for (const r of rows ?? []) {
      if (!r?.Header && !r?.Rows) continue;
      sawSection = true;
      if (isAccount(r)) return r;
      const inner = find(r?.Rows?.Row);
      if (inner) return inner;
    }
    return null;
  };
  const section = find(report?.Rows?.Row ?? []);
  if (!section) return sawSection ? 'wrong_account' : { rows: [], withSubAccounts: false };

  // Never a silent zero: a dated row whose date or amount is not where the columns say makes the
  // whole report unreadable, rather than a balance that leaves that row out.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const AMOUNT = /^-?\d[\d,]*(\.\d+)?$|^-?\.\d+$/;
  let withSubAccounts = false;
  let unreadable = false;
  const out: GlEntry[] = [];
  const walk = (rows: any[]) => {
    for (const r of rows ?? []) {
      if (r?.Rows?.Row) {
        withSubAccounts = true;
        walk(r.Rows.Row);
        continue;
      }
      const cells = r?.ColData;
      if (!Array.isArray(cells)) continue;
      const date = String(cells[at.tx_date]?.value ?? '').trim();
      if (!DAY.test(date)) {
        // "Beginning Balance" and the like carry no date anywhere; a date elsewhere means the
        // columns are not what they seem.
        if (cells.some((c: any) => DAY.test(String(c?.value ?? '').trim()))) unreadable = true;
        continue;
      }
      const raw = String(cells[at.subt_nat_amount]?.value ?? '').trim();
      if (!AMOUNT.test(raw)) {
        unreadable = true;
        continue;
      }
      out.push({
        date,
        type: String(cells[at.txn_type]?.value ?? ''),
        docNumber: String(cells[at.doc_num]?.value ?? ''),
        memo: String(cells[at.memo]?.value ?? ''),
        amountCents: Math.round(Number(raw.replace(/,/g, '')) * 100),
      });
    }
  };
  walk(section?.Rows?.Row ?? []);
  return unreadable ? 'unreadable' : { rows: out, withSubAccounts };
};

/** CSP's own entries: CSP-<day>-<n>, CSP-R-, CSP-E-, CSP-ER-. */
export const isCspEntry = (docNumber: string) => /^CSP-/i.test(String(docNumber ?? '').trim());
