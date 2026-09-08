import axios from 'axios';

import { createLogger } from '../utils/logger';
import withRetry from '../utils/httpRetry';

const logger = createLogger('donation-sweep');

const PCO_DONATIONS = 'https://api.planningcenteronline.com/giving/v2/donations';

export interface SweepPage {
  donations: any[];
  included: any[];
}

/**
 * Fetch every donation Planning Center dates to one local day.
 *
 * Three things about this query are load-bearing, each established against the live API rather
 * than inferred, because getting any of them wrong loses or duplicates real money:
 *
 * 1. **Date-only strings, not instants.** PCO interprets `2026-09-08` in the ORGANISATION's
 *    timezone and handles daylight saving itself. Explicit `Z` instants disagree with it by a
 *    whole day: the four donations completed at `2024-02-09T05:08:03Z` are returned by
 *    `where[completed_at]=2024-02-08` and NOT by `2024-02-09`, because they fall on 8 February
 *    in America/Los_Angeles. Passing dates this way also makes the server's day and this
 *    engine's `dayKey(donation, orgTimeZone)` agree by construction.
 *
 * 2. **Half-open `[gte, lt)`.** With `lte` on the end, consecutive days overlap and the same
 *    donation is returned by both - proven live: donations 171050122 ($60.00) and 171050228
 *    ($20.00) appear in the windows for both 4 and 5 April 2023. Since posting is delta-based,
 *    a donation counted twice posts real money twice. `gt` on the start is the mirror hazard:
 *    date-only gifts sit exactly at org midnight, so `gt` drops all of them.
 *
 * 3. **No `filter=succeeded`.** Its meaning is undocumented (`scope_help` is null in both graph
 *    versions) and unverifiable against the only organisation available. An unvalidated
 *    `filter=` value returns HTTP 200 with every row, so a typo there is silent. The engine's
 *    own `isStripeElectronic` remains the authority on what may be posted.
 */
export const fetchDonationsForDay = async (config: any, day: string): Promise<SweepPage> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`fetchDonationsForDay: expected a YYYY-MM-DD day, got "${day}"`);
  }
  const next = nextDay(day);

  let url: string | null =
    `${PCO_DONATIONS}?per_page=100&include=designations,designations.fund` +
    `&where[received_at][gte]=${day}&where[received_at][lt]=${next}`;

  const donations: any[] = [];
  const included: any[] = [];
  let pages = 0;
  let reportedTotal: number | null = null;

  while (url) {
    const res: any = await withRetry(() => axios.get(url as string, config));
    donations.push(...((res.data?.data ?? []) as any[]));
    included.push(...((res.data?.included ?? []) as any[]));
    if (reportedTotal === null && typeof res.data?.meta?.total_count === 'number') {
      reportedTotal = res.data.meta.total_count;
    }
    url = res.data?.links?.next ?? null;
    pages += 1;
    if (pages > 200) throw new Error(`fetchDonationsForDay: refusing to page past ${pages} pages for ${day}`);
  }

  // A misspelled `where` key is ignored by PCO and returns the organisation's ENTIRE history
  // with HTTP 200. For a daily entry that is the difference between one day and every gift the
  // church has ever received, so refuse rather than post it. Cheap, and it fails loudly.
  const outsideWindow = donations.filter((d) => {
    const at = String(d?.attributes?.received_at ?? '');
    return at && (at.slice(0, 10) < day || at.slice(0, 10) > next);
  });
  if (outsideWindow.length > donations.length / 2) {
    throw new Error(
      `fetchDonationsForDay: ${outsideWindow.length} of ${donations.length} donations fall outside ${day} - ` +
        `the date filter did not apply, refusing to use this result`,
    );
  }

  if (reportedTotal !== null && reportedTotal !== donations.length) {
    logger.warn('fetchDonationsForDay: fetched count does not match the reported total', {
      day,
      reportedTotal,
      fetched: donations.length,
      pages,
    });
  }

  return { donations, included };
};

/** The next calendar day, as a date-only string. Pure string maths, no timezone involved. */
export const nextDay = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
};

/** The previous calendar day, as a date-only string. */
export const previousDay = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
};

/**
 * Today in a given timezone, as the church would name it. The nightly run settles the day
 * BEFORE this one: at 8am on Wednesday, Tuesday is the day that is over.
 */
export const localToday = (timeZone: string, now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
