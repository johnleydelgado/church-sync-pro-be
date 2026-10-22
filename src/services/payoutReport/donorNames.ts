/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import withRetry, { WithRetryOptions } from '../../utils/httpRetry';
import { createLogger } from '../../utils/logger';

const logger = createLogger('outstanding-deposits');

const PEOPLE = 'https://api.planningcenteronline.com/giving/v2/people';

/**
 * What Planning Center calls a gift with no person: its `person` relationship is null and the web
 * interface shows "Anonymous Donor" (Giving API docs, Donation -> person).
 */
export const ANONYMOUS_DONOR = 'Anonymous Donor';

/** A Giving Person's name as Planning Center shows it: first and last. Null when it has neither. */
export const personName = (person: any): string | null => {
  const a = person?.attributes ?? {};
  const name = [a.first_name, a.last_name]
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return name || null;
};

/**
 * Donor names for Planning Center person ids, from GET /giving/v2/people/{id}.
 *
 * One request per person: donations can't include their person, and the people list can be
 * filtered only by first and last name (Giving API docs: Person `can_query`), not by id. So the
 * lookup is bounded: each person once, `concurrency` requests at a time (Planning Center throttles,
 * and back-to-back loads have drawn 500s), at most `max` people per call, each request retried on
 * 429 / 5xx by `withRetry`. A person no longer in Giving (404) is just blank. Any other failure stops
 * the rest and is logged once: the caller keeps what it has and leaves the remaining names blank.
 */
export const lookupPersonNames = async (
  config: any,
  ids: string[],
  opts: { concurrency?: number; max?: number; retry?: WithRetryOptions } = {},
): Promise<Map<string, string | null>> => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const max = opts.max ?? 100;
  const wanted = unique.slice(0, max);
  if (unique.length > max) {
    logger.warn('lookupPersonNames: more donors than one report looks up; the rest stay blank', { wanted: unique.length, max });
  }
  const names = new Map<string, string | null>();
  let failure: any = null;
  let next = 0;
  const worker = async () => {
    while (!failure && next < wanted.length) {
      const id = wanted[next++];
      try {
        const res: any = await withRetry(() => axios.get(`${PEOPLE}/${encodeURIComponent(id)}`, config), opts.retry);
        names.set(id, personName(res?.data?.data));
      } catch (e: any) {
        if (e?.response?.status === 404) names.set(id, null);
        else if (!failure) failure = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), wanted.length) }, worker));
  if (failure) {
    logger.warn('lookupPersonNames: Planning Center did not answer; the remaining donor names stay blank', {
      named: names.size,
      wanted: wanted.length,
      status: failure?.response?.status ?? null,
      error: failure instanceof Error ? failure.message : String(failure),
    });
  }
  return names;
};
