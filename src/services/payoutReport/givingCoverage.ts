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
  refundedGrossCents: number; // what CSP has reversed on the day (refunds are dated the refund day)
}
export type CoverageRow = Pick<PayoutRow, 'externalId' | 'day' | 'type' | 'grossCents'>;
export interface CoverageResult<R extends CoverageRow = CoverageRow> {
  row: R;
  status: 'giving_covered' | 'giving_not_posted';
  reason?: string;
}

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
    if (!d || !d.pcoIds.has(id)) return { row, status: 'giving_not_posted', reason: 'not_in_planning_center' };
    if (d.postedGrossCents <= 0) return { row, status: 'giving_not_posted', reason: 'day_not_posted' };
    if (d.postedGrossCents < d.pcoGrossCents) return { row, status: 'giving_not_posted', reason: 'day_partly_posted' };
    return { row, status: 'giving_covered' };
  });
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
    // Planning Center filters received_at by UTC date, while days here are the church's local days:
    // pad a day either side so a late-evening gift on the first or last day is not missed.
    const { donations } = await fetchDonationsForRange(config, shiftDay(sorted[0], -1), shiftDay(sorted[sorted.length - 1], 1));
    return {
      settled: groupDonationsByDay(filterStripeElectronic(donations), tz),
      known: groupDonationsByDay((donations ?? []).filter(wasStripeElectronic), tz),
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
  const sorted = [...new Set(dayList)].sort();
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
      refundedGrossCents: Number(ledger?.refundedGrossCents ?? 0),
    });
  }
  return out;
};
