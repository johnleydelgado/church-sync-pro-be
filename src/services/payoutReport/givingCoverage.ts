/* eslint-disable @typescript-eslint/no-explicit-any */
import { Op } from 'sequelize';
import DailyJeSync from '../../db/models/DailyJeSync';
import { generatePcToken } from '../../controller/automation';
import { fetchDonationsForRange } from '../donationSweep';
import { getOrgTimeZone } from '../dailyDonationSync';
import { filterStripeElectronic, groupDonationsByDay, wasStripeElectronic } from '../../utils/mapping';
import { createLogger } from '../../utils/logger';
import { PayoutRow } from './parsePayoutReport';

const logger = createLogger('payout-report');

export interface DayCoverage {
  pcoGrossCents: number; // settled, unrefunded Stripe giving that day - what the engine posts
  postedGrossCents: number; // giving CSP has put in QuickBooks for the day (all its entries)
  pcoIds: Set<string>; // settled Stripe gifts received that day, refunded since or not
  knownGrossCents: number; // the gross of those: everything CSP can have posted for the day
  refundedGrossCents: number; // what CSP has reversed on the day (refunds are dated the refund day)
  failedIds: Set<string>; // card or ACH gifts received that day that failed: a bank gift that was returned
}
export type CoverageRow = Pick<PayoutRow, 'externalId' | 'day' | 'type' | 'grossCents'>;
export interface CoverageResult<R extends CoverageRow = CoverageRow> {
  row: R;
  status: 'giving_covered' | 'giving_not_posted';
  reason?: string;
  /** The day Planning Center files the gift on, when that is not the file's date (a late-evening gift). */
  day?: string;
}

/**
 * A gift the donor's bank returned (Planning Center marks it failed), by what CSP's own posting says:
 * - `returned_gift`: its day holds nothing posted, or exactly Planning Center's total without it - so
 *   the gift was never in QuickBooks, and only what the return cost in fees is left to book;
 * - `returned_after_posting`: its day holds more than Planning Center counts - CSP posted it before it
 *   came back, so QuickBooks still has it;
 * - `returned_day_unsettled`: its day is only partly posted, so CSP can't tell yet.
 */
export const RETURNED_REASONS = ['returned_gift', 'returned_after_posting', 'returned_day_unsettled'];

/**
 * Matt's rule, for the giving half of a payout: a giving line counts as recorded only when CSP has
 * posted its whole day. CSP keeps day totals, not gift ids, so "whole day posted" is the proof:
 * the gift is one of Planning Center's settled Stripe gifts that day, and what CSP posted for the
 * day covers at least that day's gross. A refund line is covered when CSP has reversed at least
 * the file's refunds for its day.
 */
export const givingCoverage = <R extends CoverageRow>(
  rows: R[],
  ctx: { givingStartDay: string | null; days: Map<string, DayCoverage> | null },
): CoverageResult<R>[] => {
  const refundsByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.type === 'Refund') refundsByDay.set(r.day, (refundsByDay.get(r.day) ?? 0) + Math.abs(Number(r.grossCents) || 0));
  }
  return rows.map((row): CoverageResult<R> => {
    if (ctx.givingStartDay && row.day < ctx.givingStartDay) return { row, status: 'giving_covered', reason: 'before_giving_start' };
    if (!ctx.days) return { row, status: 'giving_not_posted', reason: 'planning_center_unreachable' };
    const d = ctx.days.get(row.day);
    if (row.type === 'Refund') {
      return (d?.refundedGrossCents ?? 0) >= (refundsByDay.get(row.day) ?? 0)
        ? { row, status: 'giving_covered' }
        : { row, status: 'giving_not_posted', reason: 'refund_not_posted' };
    }
    const id = String(row.externalId ?? '').replace(/^donation:/, '');
    // The file's date and Planning Center's day for a gift can differ by one (2026-10-15 at 11:53pm
    // Pacific was 10/16 in the file), so the gift is looked for on the day either side too.
    const near = [row.day, shiftDay(row.day, -1), shiftDay(row.day, 1)];
    const home = near.find((day) => ctx.days?.get(day)?.pcoIds.has(id));
    if (home) {
      const at = home === row.day ? {} : { day: home };
      if (ctx.givingStartDay && home < ctx.givingStartDay) return { row, status: 'giving_covered', reason: 'before_giving_start', ...at };
      const h = ctx.days.get(home)!;
      if (h.postedGrossCents <= 0) return { row, status: 'giving_not_posted', reason: 'day_not_posted', ...at };
      if (h.postedGrossCents < h.pcoGrossCents) return { row, status: 'giving_not_posted', reason: 'day_partly_posted', ...at };
      return { row, status: 'giving_covered', ...at };
    }
    const failedDay = near.find((day) => ctx.days?.get(day)?.failedIds?.has(id));
    if (failedDay) {
      if (ctx.givingStartDay && failedDay < ctx.givingStartDay) return { row, status: 'giving_covered', reason: 'before_giving_start' };
      const f = ctx.days.get(failedDay)!;
      const at = failedDay === row.day ? {} : { day: failedDay };
      const posted = f.postedGrossCents;
      const reason =
        posted === 0 || posted === f.knownGrossCents
          ? 'returned_gift'
          : posted > f.knownGrossCents
          ? 'returned_after_posting'
          : 'returned_day_unsettled';
      return { row, status: 'giving_not_posted', reason, ...at };
    }
    return { row, status: 'giving_not_posted', reason: 'not_in_planning_center' };
  });
};

const isFailedCardOrAch = (d: any): boolean => {
  const a = d?.attributes ?? {};
  return ['card', 'ach'].includes(String(a.payment_method ?? '').toLowerCase()) && String(a.payment_status ?? '').toLowerCase() === 'failed';
};

const shiftDay = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

/** Planning Center's donations around the given days, or null when it can't be read. */
const fetchPlanningCenterDays = async (email: string, sorted: string[]) => {
  try {
    const token: any = await generatePcToken(email);
    if (!token?.access_token) return null;
    const config = { headers: { Authorization: `Bearer ${token.access_token}` } };
    const tz = await getOrgTimeZone(config);
    if (!tz) return null;
    // Planning Center reads these date-only bounds in the church's time zone, which is how the days
    // here are grouped too (donationSweep.ts). A day of margin either side costs little and keeps the
    // first and last days whole should the two ever disagree about a gift's day.
    const { donations } = await fetchDonationsForRange(config, shiftDay(sorted[0], -1), shiftDay(sorted[sorted.length - 1], 1));
    return {
      settled: groupDonationsByDay(filterStripeElectronic(donations), tz),
      known: groupDonationsByDay((donations ?? []).filter(wasStripeElectronic), tz),
      failed: groupDonationsByDay((donations ?? []).filter(isFailedCardOrAch), tz),
    };
  } catch (e) {
    logger.warn('loadDayCoverage: could not read Planning Center', { email, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
};

/**
 * Planning Center's settled Stripe gifts and CSP's day ledger for the given days. Null when
 * Planning Center can't be read - callers must then say "couldn't check", never "all clear".
 * A database failure is NOT that, so it is left to throw.
 */
export const loadDayCoverage = async (
  email: string,
  userId: number,
  dayList: string[],
): Promise<Map<string, DayCoverage> | null> => {
  if (!dayList.length) return new Map();
  // The day either side too: a gift may be filed on a neighbouring day (see givingCoverage).
  const sorted = [...new Set(dayList.flatMap((d) => [shiftDay(d, -1), d, shiftDay(d, 1)]))].sort();
  const pco = await fetchPlanningCenterDays(email, sorted);
  if (!pco) return null;

  const ledgers = await DailyJeSync.findAll({
    where: { userId, day: { [Op.in]: sorted } },
    attributes: ['day', 'postedGrossCents', 'refundedGrossCents'],
  });
  const ledgerByDay = new Map<string, any>();
  for (const l of ledgers as any[]) {
    const j = typeof l?.toJSON === 'function' ? l.toJSON() : l;
    ledgerByDay.set(String(j.day), j);
  }

  const out = new Map<string, DayCoverage>();
  for (const day of sorted) {
    const ledger = ledgerByDay.get(day);
    out.set(day, {
      pcoGrossCents: (pco.settled[day] ?? []).reduce((s: number, g: any) => s + (Number(g?.attributes?.amount_cents) || 0), 0),
      postedGrossCents: Number(ledger?.postedGrossCents ?? 0),
      pcoIds: new Set((pco.known[day] ?? []).map((g: any) => String(g.id))),
      knownGrossCents: (pco.known[day] ?? []).reduce((s: number, g: any) => s + (Number(g?.attributes?.amount_cents) || 0), 0),
      refundedGrossCents: Number(ledger?.refundedGrossCents ?? 0),
      failedIds: new Set((pco.failed[day] ?? []).map((g: any) => String(g.id))),
    });
  }
  return out;
};
