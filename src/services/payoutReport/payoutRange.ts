import { localToday } from '../donationSweep';
import { isRealDay, monthEndOf, shortDay } from './days';
import { PayoutReportFormatError } from './parsePayoutReport';
import { openPlanningCenter, todayAnywhere } from './planningCenterSession';

/** The payout dates a payout report was exported for, YYYY-MM-DD, inclusive. */
export interface PayoutRange {
  from: string;
  to: string;
}

/**
 * Why a payout range can't be used, as a sentence the upload screen shows as is - or null when it
 * can. `today` is the church's local day.
 *
 * A range may not cross a month-end: the file's rows carry no payout date, so CSP could not tell
 * which rows were paid out on or before the month-end and which after - which is exactly what the
 * month-end report needs to know.
 */
export const payoutRangeProblem = (from: unknown, to: unknown, today: string): string | null => {
  if (from == null || to == null || from === '' || to === '') {
    return 'Enter the dates of the payouts in this file: from and to.';
  }
  if (!isRealDay(from) || !isRealDay(to)) return 'The payout dates must be real dates (YYYY-MM-DD).';
  const years = from.slice(0, 4) !== to.slice(0, 4);
  if (from > to) {
    return `The payout dates are the wrong way round: ${shortDay(from, years)} is after ${shortDay(to, years)}.`;
  }
  if (to > today) {
    return `The last payout date, ${shortDay(to)}, is in the future. Enter the date of the last payout in this file.`;
  }
  if (from.slice(0, 7) !== to.slice(0, 7)) {
    return (
      `These payouts run from ${shortDay(from, years)} to ${shortDay(to, years)}, across a month-end. ` +
      `Split it at the month-end: CSP can't tell which side of ${shortDay(monthEndOf(from), years)} each row falls on.`
    );
  }
  return null;
};

/**
 * The upload's payout range, checked - or a PayoutReportFormatError (a 400 with the sentence).
 *
 * "In the future" means after the church's local today. Planning Center (the only place CSP learns
 * the church's timezone) is asked only when the last date is within the day or so where that depends
 * on the timezone; if it can't answer then, a date that is already today somewhere is accepted rather
 * than refusing a good upload over a lookup.
 */
export const assertPayoutRange = async (
  email: string,
  from: unknown,
  to: unknown,
  now: Date = new Date(),
): Promise<PayoutRange> => {
  const { earliest, latest } = todayAnywhere(now);
  const problem = payoutRangeProblem(from, to, latest);
  if (problem) throw new PayoutReportFormatError(problem);
  const range = { from: from as string, to: to as string };
  if (range.to <= earliest) return range;
  const zone = await openPlanningCenter(email).timeZone();
  const today = zone ? localToday(zone, now) : latest;
  const late = payoutRangeProblem(range.from, range.to, today);
  if (late) throw new PayoutReportFormatError(late);
  return range;
};
