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

const toDollars = (cents: number | string | null | undefined) => Math.round(Number(cents ?? 0)) / 100;

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

    const entries: DailyJournalEntry[] = syncRows.map((row) => {
      const r = row.toJSON() as any;
      const summary = summarizeJournalEntry(r.syncedData);
      return {
        date: r.donationId,
        status: r.status,
        gross: summary.gross,
        fees: summary.fees,
        net: summary.net,
        credits: summary.credits,
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
