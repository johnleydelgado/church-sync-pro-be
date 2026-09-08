import { syncBatchToJournalEntries } from './syncEngine';
import { fetchDonationsForDay, localToday, previousDay } from './donationSweep';
import { generatePcToken } from '../controller/automation';
import UserSettings from '../db/models/userSettings';
import { createLogger } from '../utils/logger';

const logger = createLogger('daily-donation-sync');

/** How many already-settled days to re-examine on each run. */
export const DEFAULT_CATCH_UP_DAYS = 10;

export type SkipReason =
  | 'automation_off'
  | 'no_settings'
  | 'no_fund_mapping'
  | 'no_clearing_account'
  | 'no_pco_token'
  | 'no_org_timezone';

export interface DailySyncResult {
  email: string;
  status: 'synced' | 'skipped' | 'failed';
  reason?: SkipReason;
  error?: string;
  daysExamined: string[];
  postedDays: string[];
  failedDays: string[];
}

/**
 * Parse the sync start date a church set on the mapping page.
 *
 * The column is a `varchar` and the frontend writes `MM-DD-YYYY`, but nothing enforces that, so
 * older or hand-edited rows can hold other shapes. The nightly path used to run this through
 * `new Date(...)`, which parses in the CONTAINER's timezone - neither UTC nor the church's - and
 * returns Invalid Date for anything unexpected, which then silently compared false against every
 * donation. Returns a date-only string, or null when the value cannot be trusted.
 */
export const parseSyncStartDay = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const mdy = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]}-${mdy[2]}`;
  const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return null;
};

/**
 * Settle one church's recent days of online giving.
 *
 * Runs each morning and posts the day that has just ended: at 8am on Wednesday, Tuesday. It
 * then re-examines the preceding days, because money arrives late - an ACH gift given Tuesday is
 * still `pending` on Wednesday morning and only settles a few days later. Re-settling a day is
 * free when nothing changed: the engine compares the day's total against what it already posted
 * and posts only a difference, so a quiet day produces no entry at all.
 *
 * Donations come from the organisation-level endpoint, never from batches. Planning Center puts
 * cash, cheques and imports into batches; online giving is not batched, so a batch sweep cannot
 * see the very money this feature exists to post.
 */
export const runDailyDonationSync = async (
  user: any,
  opts: {
    now: Date;
    catchUpDays?: number;
    /**
     * Settle these exact days instead of "yesterday and the ones before it". Used to re-run a
     * day by hand - after fixing a fund mapping, say, or to check a day an operator is unsure
     * about. It changes WHICH days are settled, never what a day means: the window, the
     * timezone and the posting rules are identical to the nightly run.
     */
    days?: string[];
  },
): Promise<DailySyncResult> => {
  const email = String(user.email);
  const base: DailySyncResult = { email, status: 'skipped', daysExamined: [], postedDays: [], failedDays: [] };

  const settings = await UserSettings.findOne({ where: { userId: user.id } });
  if (!settings) return { ...base, reason: 'no_settings' };
  if (!settings.isAutomationEnable) return { ...base, reason: 'automation_off' };

  const settingsData = (settings.settingsData as unknown as any[]) ?? [];
  if (!settingsData.length) return { ...base, reason: 'no_fund_mapping' };

  const bank = (settings.settingBankData as unknown as any[]) ?? [];
  const clearing = bank.find((b: any) => b?.type === 'donation');
  if (!clearing?.value) return { ...base, reason: 'no_clearing_account' };

  let config: any;
  try {
    const tokenEntity = await generatePcToken(email);
    if (!tokenEntity?.access_token) return { ...base, reason: 'no_pco_token' };
    config = { headers: { Authorization: `Bearer ${tokenEntity.access_token}` } };
  } catch (e) {
    return { ...base, reason: 'no_pco_token' };
  }

  // The church's own timezone decides which day a gift belongs to, and Planning Center applies
  // it server-side when the window is a date-only string. Without it the window and the
  // engine's own day grouping could disagree, so refuse rather than guess at UTC.
  const orgTimeZone = await getOrgTimeZone(config);
  if (!orgTimeZone) return { ...base, reason: 'no_org_timezone' };

  const today = localToday(orgTimeZone, opts.now);
  const catchUp = Math.max(0, opts.catchUpDays ?? DEFAULT_CATCH_UP_DAYS);
  const startBound = parseSyncStartDay(settings.startDateAutomationFund);

  // Yesterday first, then backwards. Yesterday is the day this run exists to post; the rest is
  // catching up money that has settled since.
  let days: string[] = [];
  if (opts.days?.length) {
    const malformed = opts.days.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (malformed.length) throw new Error(`runDailyDonationSync: not a day: ${malformed.join(', ')}`);
    // An explicitly requested day is honoured even if it precedes the church's sync start
    // date - the operator asking for it is the authority, not the default bound.
    days = [...opts.days];
  } else {
    let day = previousDay(today);
    for (let i = 0; i <= catchUp; i += 1) {
      if (startBound && day < startBound) break;
      days.push(day);
      day = previousDay(day);
    }
  }

  if (!days.length) {
    logger.info('runDailyDonationSync: nothing in range', { email, today, startBound });
    return { ...base, status: 'synced' };
  }

  const postedDays: string[] = [];
  const failedDays: string[] = [];

  for (const d of days) {
    try {
      const { donations, included } = await fetchDonationsForDay(config, d);
      const result = await syncBatchToJournalEntries({
        user,
        // `daily:<day>` is the claim scope. The unique index on
        // (userId, batchId, donationId) then gives exactly one row per church per day, and it
        // is stable because it comes from `received_at`, which never moves - unlike
        // `completed_at`, which jumps forward when an ACH gift settles.
        batchId: d,
        realBatchId: `daily:${d}`,
        bankData: bank,
        donations,
        included,
        orgTimeZone,
      });
      postedDays.push(...result.postedDays);
      failedDays.push(...result.failedDays);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error('runDailyDonationSync: day failed', { email, day: d, error });
      failedDays.push(d);
    }
  }

  return {
    email,
    status: failedDays.length ? 'failed' : 'synced',
    daysExamined: days,
    postedDays,
    failedDays,
  };
};

/** The organisation's timezone, e.g. America/Denver. Null when PCO does not report one. */
const getOrgTimeZone = async (config: any): Promise<string | null> => {
  const axios = (await import('axios')).default;
  try {
    const res: any = await axios.get('https://api.planningcenteronline.com/giving/v2', config);
    return res.data?.data?.attributes?.time_zone ?? null;
  } catch {
    return null;
  }
};
