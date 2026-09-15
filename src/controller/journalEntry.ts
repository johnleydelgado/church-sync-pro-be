/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, Response } from 'express';
import { Op } from 'sequelize';
import Users from '../db/models/user';
import UserSettings from '../db/models/userSettings';
import UserSync from '../db/models/UserSync';
import SyncRun from '../db/models/SyncRun';
import { responseSuccess } from '../utils/response';
import { summarizeJournalEntry } from '../utils/summarizeJournalEntry';
import DailyJeSync from '../db/models/DailyJeSync';
import { getQboTokensForUser } from '../services/qboClient';
import quickBookApi from '../utils/quickBookApi';
import { fetchDonationsForDay, fetchDonationsForRange } from '../services/donationSweep';
import { getOrgTimeZone, parseSyncStartDay, runDailyDonationSync } from '../services/dailyDonationSync';
import { generatePcToken } from './automation';
import {
  chargeableFeeCents,
  filterStripeElectronic,
  groupDonationsByDay,
  stripeGivingDayDetail,
} from '../utils/mapping';

const toDollars = (cents: number | string | null | undefined) => Math.round(Number(cents ?? 0)) / 100;

/**
 * Widest range the Stripe giving table will ask Planning Center for in one go.
 *
 * A year covers reviewing a full giving year or backfilling one, which is the realistic outer
 * bound for this page. The limit exists at all because the sweep is a single paginated request:
 * a church with a decade of history would otherwise ask for all of it the moment someone dragged
 * the date picker back, and wait minutes for a page it did not mean to open.
 */
const MAX_RANGE_DAYS = 366;

/** Inclusive day count between two date-only strings. Pure UTC maths, no timezone involved. */
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

/**
 * The clearing account's LIVE balance from QuickBooks, including whatever the
 * accountant has cleared against bank deposits. CSP only ever sees what it adds,
 * so a running sum of its own entries grows forever and stops meaning anything
 * once reconciliation starts. Returns null if the account can't be read, and the
 * caller says so rather than showing a wrong number.
 */
const readQboClearingBalance = async (email: string, accountId: string | undefined): Promise<number | null> => {
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

// Match day-keyed donationId rows (YYYY-MM-DD ...); legacy deposit-id rows are ignored.
const DAY_ID_PATTERN = '____-__-__%';

interface DailyJournalEntry {
  date: string;
  status: string;
  gross: number;
  fees: number;
  net: number;
  credits: { accountRef: string; amount: number }[];
  memo: string;
  batchId: string;
}

const emptyResponse = () => ({
  automation: { isEnabled: false, lastRunAt: null as string | null, lastRunStatus: null as string | null },
  clearingBalance: 0,
  qboClearingBalance: null as number | null,
  clearingAccountName: null as string | null,
  entries: [] as DailyJournalEntry[],
});

export const getDailyJournalEntries = async (req: Request, res: Response) => {
  const { email } = req.query;
  try {
    const userData = await Users.findOne({ where: { email: email as string } });

    if (!userData) {
      return responseSuccess(res, emptyResponse());
    }

    const userId = (userData.toJSON() as any).id;
    const settings = await UserSettings.findOne({ where: { userId } });

    // Day-keyed journal entry rows for this user, newest first.
    const syncRows = await UserSync.findAll({
      where: {
        userId,
        donationId: { [Op.like]: DAY_ID_PATTERN },
      },
      order: [['donationId', 'DESC']],
    });

    // QuickBooks account id -> the name the church chose for it, from their fund mapping.
    // The stored journal payload keeps only ids on its credit lines.
    const accountNames = new Map<string, string>();
    for (const item of ((settings?.settingsData as unknown as any[]) ?? [])) {
      const value = item?.account?.value;
      const label = item?.account?.label;
      if (value && label) accountNames.set(String(value), String(label));
    }

    const entries: DailyJournalEntry[] = syncRows.map((row) => {
      const r = row.toJSON() as any;
      const summary = summarizeJournalEntry(r.syncedData);
      return {
        date: r.donationId,
        status: r.status,
        gross: summary.gross,
        fees: summary.fees,
        net: summary.net,
        credits: summary.credits.map((c) => ({
          ...c,
          accountName: accountNames.get(String(c.accountRef)),
        })),
        memo: summary.memo,
        batchId: r.batchId,
      };
    });

    // What CSP has posted to clearing, cumulatively. This is NOT the account balance:
    // it never decreases when deposits are reconciled. The live figure is read from
    // QuickBooks below so the UI can show a number that stays true over time.
    const clearingBalance = entries
      .filter((e) => e.status === 'posted')
      .reduce((sum, e) => sum + e.net, 0);
    const bankData = (settings?.settingBankData as unknown as any[]) || [];
    const clearingAccount = bankData.find((b) => b?.type === 'donation');
    const qboClearingBalance = await readQboClearingBalance(String(email), clearingAccount?.value);

    const lastRun = await SyncRun.findOne({ order: [['startedAt', 'DESC']] });

    return responseSuccess(res, {
      automation: {
        isEnabled: Boolean(settings?.isAutomationEnable),
        lastRunAt: lastRun ? (lastRun.toJSON() as any).startedAt ?? null : null,
        lastRunStatus: lastRun ? (lastRun.toJSON() as any).status ?? null : null,
      },
      clearingBalance,
      qboClearingBalance,
      clearingAccountName: clearingAccount?.label ?? null,
      entries,
    });
  } catch (e) {
    console.log('ERROR: ', e);
    return responseSuccess(res, emptyResponse());
  }
};


/**
 * Monthly clearing-account statement - the paper trail the client's accountants
 * reconcile against at month end ("just like a bank account").
 *
 * Every line is something CSP itself posted, keyed to the QuickBooks entry ids and
 * Planning Center batch ids behind it. Opening/closing are CSP's cumulative net
 * additions, which is what the accountant compares to the clearing account's
 * activity in QuickBooks; the live QuickBooks balance is returned alongside so the
 * difference (deposits already reconciled) is visible rather than implied.
 */
export const getClearingStatement = async (req: Request, res: Response) => {
  const email = String(req.query.email ?? '');
  const month = String(req.query.month ?? ''); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: 'month must be YYYY-MM' });
  }
  try {
    const user = await Users.findOne({ where: { email } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const settings = await UserSettings.findOne({ where: { userId: user.id } });
    const bankData = (settings?.settingBankData as unknown as any[]) || [];
    const clearingAccount = bankData.find((b) => b?.type === 'donation');

    const rows = await DailyJeSync.findAll({ where: { userId: user.id }, order: [['day', 'ASC']] });
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const netOf = (r: any) =>
      Number(r.postedGrossCents ?? 0) - Number(r.postedFeeCents ?? 0)
      - (Number(r.refundedGrossCents ?? 0) - Number(r.refundedFeeCents ?? 0));

    const before = rows.filter((r: any) => r.day < monthStart);
    const within = rows.filter((r: any) => r.day >= monthStart && r.day <= monthEnd);
    const openingCents = before.reduce((s: number, r: any) => s + netOf(r), 0);

    let running = openingCents;
    const lines = within.map((r: any) => {
      const net = netOf(r);
      running += net;
      return {
        date: r.day,
        gross: toDollars(r.postedGrossCents),
        fees: toDollars(r.postedFeeCents),
        refundsGross: toDollars(r.refundedGrossCents),
        refundsFees: toDollars(r.refundedFeeCents),
        net: toDollars(net),
        runningBalance: toDollars(running),
        entries: Number(r.entryCount ?? 0),
        qboEntryIds: r.qboEntryIds ?? [],
        batchIds: r.batchIds ?? [],
      };
    });
    const totals = {
      gross: toDollars(within.reduce((s: number, r: any) => s + Number(r.postedGrossCents ?? 0), 0)),
      fees: toDollars(within.reduce((s: number, r: any) => s + Number(r.postedFeeCents ?? 0), 0)),
      refundsGross: toDollars(within.reduce((s: number, r: any) => s + Number(r.refundedGrossCents ?? 0), 0)),
      refundsFees: toDollars(within.reduce((s: number, r: any) => s + Number(r.refundedFeeCents ?? 0), 0)),
      net: toDollars(within.reduce((s: number, r: any) => s + netOf(r), 0)),
    };
    const closingCents = running;
    const qboBalance = await readQboClearingBalance(email, clearingAccount?.value);

    return responseSuccess(res, {
      month,
      clearingAccount: clearingAccount ? { value: clearingAccount.value, name: clearingAccount.label } : null,
      opening: toDollars(openingCents),
      lines,
      totals,
      closing: toDollars(closingCents),
      qboBalance,
      // Positive = deposits the accountant has already reconciled out of clearing.
      difference: qboBalance === null ? null : Math.round((toDollars(closingCents) - qboBalance) * 100) / 100,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Could not build the statement' });
  }
};

/**
 * Each day's Stripe-processed giving, straight from Planning Center, with whatever CSP has
 * already posted for that day alongside it.
 *
 * This backs the Stripe page's table. It is deliberately READ-ONLY and deliberately sourced
 * from Planning Center rather than from Stripe: CSP has no Stripe Connect grant for a church's
 * own account, so the payouts endpoint it used to call returned nothing at all and the page sat
 * empty. Planning Center already knows every gift Stripe processed, and its `fee_cents` is the
 * same fee Stripe charged - so the giving side of the ledger is fully knowable without Stripe.
 *
 * The arithmetic is the journal entry's, so the numbers a church reads here are the numbers that
 * will be posted:
 *
 *     gross   the donations, as the donor's receipt shows them
 *     fees    what Stripe took (`chargeableFeeCents`, covered fees included)
 *     net     what Stripe will deposit - the amount that lands in the clearing account
 *
 * `status` is what CSP has done about the day, not what Planning Center thinks: `posted` once a
 * journal entry exists, `failed` if an attempt errored, and `pending` for a day that has giving
 * but no entry yet - which is the whole point of showing unposted days here.
 */
export const getStripeGivingByDay = async (req: Request, res: Response) => {
  const email = String(req.query.email ?? '');
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ success: false, message: 'from must not be after to' });
  }
  // A church with years of history would otherwise ask Planning Center for all of it in one
  // request the moment someone widens the date picker.
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    return res.status(400).json({ success: false, message: `range must be ${MAX_RANGE_DAYS} days (one year) or fewer` });
  }

  try {
    const userData = await Users.findOne({ where: { email } });
    if (!userData) return responseSuccess(res, { days: [], unavailable: 'no_user' });

    const userId = (userData.toJSON() as any).id;

    let config: any;
    try {
      const tokenEntity = await generatePcToken(email);
      if (!tokenEntity?.access_token) return responseSuccess(res, { days: [], unavailable: 'no_pco_token' });
      config = { headers: { Authorization: `Bearer ${tokenEntity.access_token}` } };
    } catch {
      return responseSuccess(res, { days: [], unavailable: 'no_pco_token' });
    }

    // The church's own timezone decides which day a gift belongs to. Without it this page would
    // group by UTC and disagree with the entries the nightly run actually posts.
    const orgTimeZone = await getOrgTimeZone(config);
    if (!orgTimeZone) return responseSuccess(res, { days: [], unavailable: 'no_org_timezone' });

    // The church's sync start date - everything before it is giving they have decided not to
    // bring across. The nightly run already stops there; returning it lets the page say so
    // instead of listing a month of history as work still outstanding.
    // parseSyncStartDay returns null for an unset or unparseable value, which means no cutoff.
    const settings = await UserSettings.findOne({ where: { userId } });
    const syncStartDay = parseSyncStartDay(settings?.startDateAutomationFund);

    const { donations } = await fetchDonationsForRange(config, from, to);
    const stripeOnly = filterStripeElectronic(donations);
    const byDay = groupDonationsByDay(stripeOnly, orgTimeZone);

    // What CSP has already done about these days. `donationId` holds the day for daily rows.
    const syncRows = await UserSync.findAll({
      where: { userId, donationId: { [Op.between]: [from, to] } },
    });
    const postedByDay = new Map<string, any>();
    for (const row of syncRows) {
      const r = row.toJSON() as any;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(r.donationId))) postedByDay.set(String(r.donationId), r);
    }

    const days = Object.keys(byDay)
      .sort()
      .reverse()
      .map((day) => {
        const items = byDay[day];
        const grossCents = items.reduce((s, d) => s + (Number(d?.attributes?.amount_cents) || 0), 0);
        // chargeableFeeCents keeps PCO's negative sign; the ledger wants a positive debit.
        const feeCents = Math.abs(chargeableFeeCents(items));
        const posted = postedByDay.get(day);
        return {
          date: day,
          donations: items.length,
          gross: toDollars(grossCents),
          fees: toDollars(feeCents),
          net: toDollars(grossCents - feeCents),
          status: posted?.status ?? 'pending',
          postedGross: posted ? toDollars(posted.postedGrossCents ?? 0) : 0,
        };
      });

    return responseSuccess(res, { days, orgTimeZone, syncStartDay, from, to });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log('getStripeGivingByDay ERROR:', message);
    // Surfaced rather than swallowed: an empty table that means "Planning Center refused the
    // query" must not look like an empty table that means "no giving that week".
    return res.status(502).json({ success: false, message });
  }
};

/**
 * One day's Stripe giving, gift by gift.
 *
 * What opens under a day on the Stripe giving page. `getStripeGivingByDay` answers how much a
 * day raised; this answers which gifts made it up, which is the question a bookkeeper actually
 * has when a day's total is not the number they expected - and the one they previously had to
 * leave CSP and open Planning Center to answer.
 *
 * Same window, same Stripe-electronic filter and same fee arithmetic as the day totals and the
 * posted entry, because it is the same day sweep the nightly run uses. Read-only; nothing here
 * posts.
 */
export const getStripeGivingDayDetail = async (req: Request, res: Response) => {
  const email = String(req.query.email ?? '');
  const day = String(req.query.day ?? '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ success: false, message: 'day must be YYYY-MM-DD' });
  }

  try {
    const userData = await Users.findOne({ where: { email } });
    if (!userData) return responseSuccess(res, { donations: [], unavailable: 'no_user' });

    let config: any;
    try {
      const tokenEntity = await generatePcToken(email);
      if (!tokenEntity?.access_token) return responseSuccess(res, { donations: [], unavailable: 'no_pco_token' });
      config = { headers: { Authorization: `Bearer ${tokenEntity.access_token}` } };
    } catch {
      return responseSuccess(res, { donations: [], unavailable: 'no_pco_token' });
    }

    // Planning Center resolves the date-only window in the church's own timezone, and the day
    // list above this groups by the same zone. Guessing at UTC here would list gifts the day
    // it expands does not count.
    const orgTimeZone = await getOrgTimeZone(config);
    if (!orgTimeZone) return responseSuccess(res, { donations: [], unavailable: 'no_org_timezone' });

    const { donations, included } = await fetchDonationsForDay(config, day);

    return responseSuccess(res, { day, orgTimeZone, ...stripeGivingDayDetail(donations, included) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log('getStripeGivingDayDetail ERROR:', message);
    // Surfaced rather than swallowed, same as the day list: an empty table that means "Planning
    // Center refused the query" must not look like one that means "no giving that day".
    return res.status(502).json({ success: false, message });
  }
};

/**
 * Post one day's Stripe giving to QuickBooks by hand.
 *
 * The manual counterpart to the 8am run, and deliberately the SAME engine: same window, same
 * Stripe-electronic filter, same claim, same delta arithmetic. A day posted here is
 * indistinguishable from one the scheduler posted, and posting a day twice is a no-op because
 * the engine compares the day's total against what it already posted and writes only the
 * difference.
 */
export const postStripeGivingDay = async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '');
  const day = String(req.body?.day ?? '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ success: false, message: 'day must be YYYY-MM-DD' });
  }

  try {
    const userData = await Users.findOne({ where: { email } });
    if (!userData) return res.status(404).json({ success: false, message: 'User not found' });

    const result = await runDailyDonationSync(userData.toJSON() as any, {
      now: new Date(),
      days: [day],
      manual: true,
    });

    return responseSuccess(res, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log('postStripeGivingDay ERROR:', message);
    return res.status(502).json({ success: false, message });
  }
};
