/* eslint-disable @typescript-eslint/no-explicit-any */
import DailyJeSync from '../db/models/DailyJeSync';
import UserSettings from '../db/models/userSettings';
import quickBookApi from '../utils/quickBookApi';
import { parseSyncStartDay } from './dailyDonationSync';
import { getQboTokensForUser } from './qboClient';

/** Net cents one ledger day added to clearing: gross, less fees, less anything refunded back out. */
export const netCentsOf = (r: any): number =>
  Number(r?.postedGrossCents ?? 0) -
  Number(r?.postedFeeCents ?? 0) -
  (Number(r?.refundedGrossCents ?? 0) - Number(r?.refundedFeeCents ?? 0));

/**
 * The clearing account's LIVE balance from QuickBooks, including whatever the accountant has
 * cleared against bank deposits. CSP only ever sees what it adds, so a running sum of its own
 * entries grows forever and stops meaning anything once reconciliation starts. Returns null if
 * the account can't be read, and callers say so rather than showing a wrong number.
 */
export const readQboClearingBalance = async (email: string, accountId: string | undefined): Promise<number | null> => {
  if (!accountId) return null;
  try {
    const qb: any = quickBookApi(await getQboTokensForUser(email));
    const account: any = await new Promise((resolve, reject) =>
      qb.getAccount(accountId, (err: any, data: any) => (err ? reject(err) : resolve(data))),
    );
    const bal = Number(account?.CurrentBalance);
    return Number.isFinite(bal) ? bal : null;
  } catch {
    return null;
  }
};

/**
 * Record what the clearing account held when the church went live - net of anything CSP had
 * already posted, because the go-live date is often saved AFTER the first day has been posted
 * (Matt saved 9/15 with 9/15 already in the account). Without this number the statement cannot
 * tell a pre-existing balance from money left over by the old process.
 *
 * Returns the stored cents, or null - and stores null - when QuickBooks can't be read, so the
 * panel can say "not captured" instead of computing from a guess.
 */
export const captureClearingSnapshot = async (email: string, userId: number): Promise<number | null> => {
  const settings = await UserSettings.findOne({ where: { userId } });
  const bank = (settings?.settingBankData as unknown as any[]) || [];
  const clearing = bank.find((b) => b?.type === 'donation');
  const qboBalance = await readQboClearingBalance(email, clearing?.value);

  if (qboBalance === null) {
    await UserSettings.update({ clearingBalanceAtGoLiveCents: null, clearingSnapshotAt: null }, { where: { userId } });
    return null;
  }

  // Only postings on or after go-live are subtracted - the same set the statement adds back.
  // A pre-cutoff day someone posted on purpose is part of what the account held at go-live.
  // No go-live date means nothing is subtracted, which is also what the statement assumes.
  const goLiveDay = parseSyncStartDay(settings?.startDateAutomationFund);
  const rows = await DailyJeSync.findAll({ where: { userId } });
  const postedCents = rows
    .map((r: any) => r.toJSON())
    .filter((r: any) => !goLiveDay || String(r.day) >= goLiveDay)
    .reduce((sum: number, r: any) => sum + netCentsOf(r), 0);
  const snapshotCents = Math.round(qboBalance * 100) - postedCents;

  await UserSettings.update(
    { clearingBalanceAtGoLiveCents: snapshotCents, clearingSnapshotAt: new Date() },
    { where: { userId } },
  );
  return snapshotCents;
};
