/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, Response } from 'express';
import { Op } from 'sequelize';
import Users from '../db/models/user';
import UserSettings from '../db/models/userSettings';
import UserSync from '../db/models/UserSync';
import SyncRun from '../db/models/SyncRun';
import { responseSuccess } from '../utils/response';
import { summarizeJournalEntry } from '../utils/summarizeJournalEntry';

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

    // Running clearing balance = sum of net across POSTED entries.
    const clearingBalance = entries
      .filter((e) => e.status === 'posted')
      .reduce((sum, e) => sum + e.net, 0);

    const lastRun = await SyncRun.findOne({ order: [['startedAt', 'DESC']] });

    return responseSuccess(res, {
      automation: {
        isEnabled: Boolean(settings?.isAutomationEnable),
        lastRunAt: lastRun ? (lastRun.toJSON() as any).startedAt ?? null : null,
        lastRunStatus: lastRun ? (lastRun.toJSON() as any).status ?? null : null,
      },
      clearingBalance,
      entries,
    });
  } catch (e) {
    console.log('ERROR: ', e);
    return responseSuccess(res, emptyResponse());
  }
};
