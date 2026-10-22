/* eslint-disable @typescript-eslint/no-explicit-any */
import { Op } from 'sequelize';
import Users from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import DailyJeSync from '../../db/models/DailyJeSync';
import PayoutReportUpload from '../../db/models/PayoutReportUpload';
import PayoutTransaction from '../../db/models/PayoutTransaction';
import quickBookApi from '../../utils/quickBookApi';
import { getQboTokensForUser } from '../qboClient';
import { fetchDonationsForRange, localToday } from '../donationSweep';
import { parseSyncStartDay } from '../dailyDonationSync';
import { dayKey, wasStripeElectronic } from '../../utils/mapping';
import { createLogger } from '../../utils/logger';
import { addDays, monthEndOf, shortDay } from './days';
import { openPlanningCenter, PlanningCenterSession, todayAnywhere } from './planningCenterSession';
import {
  ClearingOnDay,
  computeOutstanding,
  DayWindow,
  daysNeedingPlanningCenter,
  GL_COLUMNS,
  isCspEntry,
  LedgerDay,
  OutstandingInput,
  OutstandingReport,
  PcoGift,
  planningCenterWindows,
  readGeneralLedger,
  StoredPayoutRow,
  UploadRange,
} from './outstanding';

const logger = createLogger('outstanding-deposits');

/** A request the report can't answer as asked; `status` is the HTTP status. */
export class OutstandingRequestError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) {
    super(message);
  }
}

export const PLANNING_CENTER_DOWN =
  "Planning Center didn't answer, so the giving lines can't be listed. Try again in a minute.";

/** Planning Center was needed for a day and could not be read: a 502 with PLANNING_CENTER_DOWN. */
export class PlanningCenterUnavailableError extends Error {
  constructor() {
    super(PLANNING_CENTER_DOWN);
  }
}

const longDay = (day: string) => shortDay(day, true);

const callQb = <T = any>(qb: any, fn: string, arg: any): Promise<T> =>
  new Promise((resolve, reject) => qb[fn](arg, (err: any, data: any) => (err ? reject(err) : resolve(data))));

/**
 * QuickBooks' Clearing account on D, and the entries in it CSP didn't make from `from` to D.
 *
 * The balance on D is the account's live CurrentBalance less everything dated after D, read from
 * the General Ledger detail report - not `reportTransactionList`, which ignores an account filter
 * and answers with the whole company. The report's own section header must name the account
 * (`readGeneralLedger`) before any of its figures are used. Anything QuickBooks can't answer becomes
 * `balanceCents: null` and a sentence, never an error: the in-transit list still stands without it.
 */
export const readClearingOnDay = async (
  email: string,
  slot: { value?: any; label?: any } | null,
  p: { from: string; asOf: string; today: string },
): Promise<ClearingOnDay> => {
  if (!slot?.value) {
    return {
      account: null,
      balanceCents: null,
      entries: [],
      message: 'Choose the clearing account on Mapping → Bank to see its QuickBooks balance.',
    };
  }
  const account = { id: String(slot.value), name: String(slot.label ?? '') };
  const unread = (message: string): ClearingOnDay => ({ account, balanceCents: null, entries: [], message });
  try {
    const qb: any = quickBookApi(await getQboTokensForUser(email));
    const facts: any = await callQb(qb, 'getAccount', account.id);
    const report = await callQb(qb, 'reportGeneralLedgerDetail', {
      account: account.id,
      start_date: p.from,
      // Far enough ahead to catch anything dated after today, which CurrentBalance also includes.
      end_date: `${Number(p.today.slice(0, 4)) + 5}-12-31`,
      columns: GL_COLUMNS,
    });
    if (!account.name && facts?.Name) account.name = String(facts.Name);
    const gl = readGeneralLedger(report, {
      Id: account.id,
      Name: facts?.Name,
      AcctNum: facts?.AcctNum,
      FullyQualifiedName: facts?.FullyQualifiedName,
    });
    if (gl === 'wrong_account') {
      logger.error('readClearingOnDay: the General Ledger report did not answer for the clearing account', {
        email,
        accountId: account.id,
      });
      return unread(`QuickBooks answered with another account's figures, so the Clearing balance on ${longDay(p.asOf)} isn't shown.`);
    }
    const current = Number(gl.withSubAccounts ? facts?.CurrentBalanceWithSubAccounts ?? facts?.CurrentBalance : facts?.CurrentBalance);
    if (!Number.isFinite(current)) {
      return unread(`QuickBooks didn't give the Clearing account's balance, so the balance on ${longDay(p.asOf)} isn't shown.`);
    }
    const afterD = gl.rows.filter((r) => r.date > p.asOf).reduce((s, r) => s + r.amountCents, 0);
    return {
      account,
      balanceCents: Math.round(current * 100) - afterD,
      entries: gl.rows.filter((r) => r.date <= p.asOf && !isCspEntry(r.docNumber)),
    };
  } catch (e) {
    logger.warn('readClearingOnDay: QuickBooks could not be read', { email, error: e instanceof Error ? e.message : String(e) });
    return unread(`QuickBooks didn't answer, so the Clearing balance on ${longDay(p.asOf)} isn't shown. Try again in a minute.`);
  }
};

/**
 * Planning Center's gifts for the given windows, by the church's local day, selected exactly as the
 * posting engine selects them (`wasStripeElectronic`: card or ACH, succeeded, a Stripe fee - here
 * refunded or not, since a gift refunded after it was posted is still in that day's entry).
 */
export const loadPlanningCenterGifts = async (
  pc: PlanningCenterSession,
  windows: DayWindow[],
): Promise<Map<string, PcoGift[]>> => {
  const out = new Map<string, PcoGift[]>();
  if (!windows.length) return out;
  const config = await pc.config();
  const zone = await pc.timeZone();
  if (!config || !zone) throw new PlanningCenterUnavailableError();
  for (const w of windows) {
    let page: { donations: any[]; included: any[] };
    try {
      // A day either side: Planning Center windows by date, the engine groups by the church's day.
      page = await fetchDonationsForRange(config, addDays(w.from, -1), addDays(w.to, 1));
    } catch (e) {
      logger.warn('loadPlanningCenterGifts: Planning Center could not be read', {
        window: w,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new PlanningCenterUnavailableError();
    }
    const fundName = new Map<string, string>();
    const designationFund = new Map<string, string>();
    for (const item of page.included ?? []) {
      if (item?.type === 'Fund') fundName.set(String(item.id), String(item.attributes?.name ?? ''));
      if (item?.type === 'Designation' && item.relationships?.fund?.data?.id) {
        designationFund.set(String(item.id), String(item.relationships.fund.data.id));
      }
    }
    for (const d of page.donations ?? []) {
      if (!wasStripeElectronic(d)) continue;
      const day = dayKey(d, zone);
      if (!day || day < w.from || day > w.to) continue;
      const list = out.get(day) ?? [];
      if (list.some((g) => g.id === String(d.id))) continue;
      const funds = [
        ...new Set(
          ((d.relationships?.designations?.data ?? []) as any[])
            .map((r) => fundName.get(designationFund.get(String(r?.id)) ?? ''))
            .filter(Boolean),
        ),
      ];
      const a = d.attributes ?? {};
      list.push({
        id: String(d.id),
        grossCents: Number(a.amount_cents) || 0,
        feeCents: Math.abs(Number(a.fee_cents) || 0),
        completedAt: a.completed_at ?? null,
        refunded: a.refunded === true,
        fund: funds.length ? funds.join(', ') : null,
      });
      out.set(day, list);
    }
  }
  return out;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const toLedger = (r: any): LedgerDay => ({
  day: String(r.day),
  postedGrossCents: Number(r.postedGrossCents ?? 0),
  postedFeeCents: Number(r.postedFeeCents ?? 0),
  refundedGrossCents: Number(r.refundedGrossCents ?? 0),
  refundedFeeCents: Number(r.refundedFeeCents ?? 0),
});
const postedAnything = (r: any) =>
  Number(r.postedGrossCents ?? 0) > 0 || Number(r.refundedGrossCents ?? 0) > 0 || Number(r.registrationGrossCents ?? 0) > 0 || Number(r.registrationRefundGrossCents ?? 0) > 0;

/**
 * GET /user/payoutReport/outstanding: everything CSP put into Clearing that Stripe had not paid out
 * by the month's end (or today, for a month still running), tied to QuickBooks' Clearing balance
 * that day. Read-only.
 */
export const getOutstandingDeposits = async (p: { email: string; month: unknown; now?: Date }): Promise<OutstandingReport> => {
  const month = String(p.month ?? '');
  if (!MONTH.test(month)) throw new OutstandingRequestError('month must be YYYY-MM');
  const now = p.now ?? new Date();
  const user: any = await Users.findOne({ where: { email: p.email } });
  if (!user) throw new OutstandingRequestError('No church found for this account.', 404);
  const userId = Number(user.id);
  const settings: any = await UserSettings.findOne({ where: { userId } });
  const pc = openPlanningCenter(p.email);

  // D: the month's last day - or the church's today, while that is still to come.
  const monthEnd = monthEndOf(`${month}-01`);
  const { earliest } = todayAnywhere(now);
  let today = earliest;
  if (monthEnd >= earliest) {
    const zone = await pc.timeZone();
    today = zone ? localToday(zone, now) : earliest;
  }
  const asOf = monthEnd > today ? today : monthEnd;

  const ledgerRows = ((await DailyJeSync.findAll({ where: { userId, day: { [Op.lte]: asOf } } })) as any[]).map((r) =>
    typeof r?.toJSON === 'function' ? r.toJSON() : r,
  );
  const ledgers = ledgerRows.map(toLedger);
  const goLiveDay = parseSyncStartDay(settings?.startDateAutomationFund);
  const startDay = goLiveDay ?? ledgerRows.filter(postedAnything).map((r) => String(r.day)).sort()[0] ?? null;

  const bank = ((settings?.settingBankData as any[]) ?? []).filter(Boolean);
  const slot = bank.find((b) => b?.type === 'donation' && b?.value) ?? bank.find((b) => b?.type === 'registration' && b?.value) ?? null;

  const input: OutstandingInput = {
    month,
    asOf,
    startDay,
    uploads: [],
    rows: [],
    ledgers,
    gifts: new Map(),
    examined: [],
    clearing: null,
    switchOver: null,
  };
  if (!startDay || asOf < startDay) {
    return computeOutstanding({
      ...input,
      clearing: { account: slot ? { id: String(slot.value), name: String(slot.label ?? '') } : null, balanceCents: null, entries: [] },
    });
  }

  input.uploads = ((await PayoutReportUpload.findAll({
    where: { userId },
    attributes: ['id', 'payoutFrom', 'payoutTo', 'lastDay'],
  })) as any[]).map(
    (u): UploadRange => ({ id: Number(u.id), payoutFrom: u.payoutFrom ?? null, payoutTo: u.payoutTo ?? null, lastDay: u.lastDay ?? null }),
  );
  input.rows = ((await PayoutTransaction.findAll({
    where: { userId },
    attributes: ['rowKey', 'uploadId', 'day', 'type', 'source', 'name', 'fundOrSignup', 'grossCents', 'feeCents', 'netCents', 'status'],
  })) as any[]).map(
    (r): StoredPayoutRow => ({
      rowKey: String(r.rowKey),
      uploadId: r.uploadId == null ? null : Number(r.uploadId),
      day: String(r.day),
      type: String(r.type),
      source: String(r.source),
      name: r.name ?? null,
      fundOrSignup: r.fundOrSignup ?? null,
      // BIGINT arrives from Postgres as a string.
      grossCents: Number(r.grossCents),
      feeCents: Number(r.feeCents),
      netCents: Number(r.netCents),
      status: String(r.status),
    }),
  );

  // Planning Center only for the days the payout files don't settle.
  input.examined = planningCenterWindows(daysNeedingPlanningCenter(input));
  input.gifts = await loadPlanningCenterGifts(pc, input.examined);

  input.clearing = await readClearingOnDay(p.email, slot, { from: startDay, asOf, today });
  input.switchOver = goLiveDay
    ? {
        goLiveDay,
        balanceAtGoLiveCents: settings?.clearingBalanceAtGoLiveCents == null ? null : Number(settings.clearingBalanceAtGoLiveCents),
        truedUpAt: settings?.transitionTruedUpAt ? new Date(settings.transitionTruedUpAt).toISOString() : null,
      }
    : null;
  return computeOutstanding(input);
};
