/* eslint-disable @typescript-eslint/no-explicit-any */
import { generatePcToken } from '../../controller/automation';
import { getOrgTimeZone } from '../dailyDonationSync';
import { localToday } from '../donationSweep';

/**
 * One request's way into a church's Planning Center: the request config and the church's timezone,
 * each fetched at most once and only when first asked for. Null means Planning Center can't be
 * read (no connection, a refused token, no timezone reported) - the caller decides what that means.
 */
export interface PlanningCenterSession {
  config(): Promise<any | null>;
  timeZone(): Promise<string | null>;
}

export const openPlanningCenter = (email: string): PlanningCenterSession => {
  let config: Promise<any | null> | null = null;
  let zone: Promise<string | null> | null = null;
  const getConfig = () => {
    if (!config) {
      config = (async () => {
        try {
          const token: any = await generatePcToken(email);
          return token?.access_token ? { headers: { Authorization: `Bearer ${token.access_token}` } } : null;
        } catch {
          return null;
        }
      })();
    }
    return config;
  };
  const getZone = () => {
    if (!zone) {
      zone = (async () => {
        const c = await getConfig();
        if (!c) return null;
        try {
          return (await getOrgTimeZone(c)) ?? null;
        } catch {
          return null;
        }
      })();
    }
    return zone;
  };
  return { config: getConfig, timeZone: getZone };
};

/**
 * Today's date at the two ends of the world: UTC-12 (where a day starts last) and UTC+14 (where it
 * starts first). Any church's local today lies between them, so a date outside that band can be
 * judged without knowing the church's timezone.
 */
export const todayAnywhere = (now: Date) => ({
  earliest: localToday('Etc/GMT+12', now),
  latest: localToday('Etc/GMT-14', now),
});
