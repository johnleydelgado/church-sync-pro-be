/* eslint-disable @typescript-eslint/no-explicit-any */
import { isEmpty } from 'lodash';
import { withRetry } from '../utils/httpRetry';
import { createLogger } from '../utils/logger';
import axios from 'axios';
import { format } from 'date-fns';
import { automationJournalEntry, generatePcToken, getFundInDonation } from '../controller/automation';
import UserSync from '../db/models/UserSync';
import DailyJeSync from '../db/models/DailyJeSync';
import { refundJournalEntryPayload } from '../utils/mapping';
import sequelize from '../db';
import UserSettings from '../db/models/userSettings';
import {
  DesignationInfo,
  MappedDonationLine,
  SettingsJsonProps,
  donationLines,
  chargeableFeeCents,
  filterStripeElectronic,
  wasStripeElectronic,
  groupDonationsByDay,
  dayKey,
  journalEntryPayload,
} from '../utils/mapping';

const logger = createLogger('sync-engine');

export interface SyncBatchParams {
  user: any;
  batchId?: string;
  realBatchId: any;
  bankData: any;
  // Optional, currently unused metadata attached to each donation (kept for caller parity).
  dataBatch?: any;
}

export interface SyncBatchResult {
  batchId: string;
  postedDays: string[];
  skippedDays: string[];
  failedDays: string[];
  /**
   * How many of the batch's donations were online (Stripe-processed) giving. Zero means the
   * batch held only cash, cheques or gifts still in transit, so nothing was ever going to
   * reach QuickBooks. Callers need this to tell "synced" apart from "there was nothing to
   * sync" - reporting a cash-only batch as a successful sync sends people looking for
   * entries in QuickBooks that were never meant to exist.
   */
  eligibleDonations: number;
}

/**
 * Shared batch -> per-day Journal Entry engine used by BOTH the automated path (`dailySyncing`)
 * and the manual path (`manualSync`).
 *
 * Pipeline (unchanged from the original `dailySyncing`):
 *   PCO batch donation fetch (`?include=designations,designations.fund`)
 *     -> fund map + per-donation fallback (getFundInDonation)
 *     -> duplicate-designation summing
 *     -> Stripe-electronic filter
 *     -> group by calendar day
 *     -> clearing-account guard + unmapped-line filter
 *     -> claim-then-post each day via UserSync.findOrCreate on the unique index
 *
 * Records `UserSync.batchId = String(realBatchId)` for every posted day so the batch-list UI
 * checkmark (computed in controller/planning-center.ts `getBatches`) keeps working.
 *
 * Does NOT depend on Express req/res. Throws on any per-day failure so callers can record the
 * batch as failed.
 */
/**
 * The church's timezone, from `GET /giving/v2` (`attributes.time_zone`).
 *
 * Donations are grouped into days in this timezone, so an evening gift is
 * recorded on the date the donor actually gave rather than rolling into the
 * next day. Available under the `giving` scope we already hold, so it needs no
 * per-church setup. Returns null on any failure - dayKey then falls back to the
 * raw UTC date rather than failing the sync.
 */
const getOrganisationTimeZone = async (config: any): Promise<string | null> => {
  try {
    const res = await withRetry(() => axios.get('https://api.planningcenteronline.com/giving/v2', config));
    return res.data?.data?.attributes?.time_zone ?? null;
  } catch (error) {
    logger.warn('syncBatchToJournalEntries: could not read organisation timezone, falling back to UTC dates', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

interface RefundPassParams {
  email: string;
  userId: number;
  realBatchId: string;
  config: any;
  allDonations: any[];
  fundIdToName: Record<string, string>;
  settingsData: any[];
  settingBankCharges: any;
  bank: { type: string; value: string; label: string }[];
  orgTimeZone: string | null;
}

/**
 * Posts reversing entries for refunded donations, grouped by the day the refund was
 * PROCESSED (the client's decision: "record them on the date they actually occur").
 *
 * Refunded donations never reach the giving entry - isStripeElectronic drops
 * `refunded === true` - so they are found here from the unfiltered batch list, and each
 * one's Refund record supplies the amount, any fee Stripe returned, and the refund
 * date. Claimed per (batch, refund-day) on UserSync exactly like giving days, so a
 * re-run cannot post the same reversal twice. Failures are returned, not thrown, so
 * one bad refund does not abort the batch's giving entries.
 */
const postRefundEntries = async (p: RefundPassParams): Promise<{ posted: string[]; failures: { day: string; error: string }[] }> => {
  const posted: string[] = [];
  const failures: { day: string; error: string }[] = [];
  // Only reverse money this engine could have posted. Selecting on `refunded === true`
  // alone reversed refunded CASH and CHEQUE gifts too - never recorded by any journal
  // entry - crediting the Stripe clearing account for a payout that never contained them.
  // In the live test organisation every cash and cheque donation reports `refundable: true`
  // while the one card donation reports false, so this is the common case, not the rare one.
  const refunded = (p.allDonations ?? []).filter(
    (d) => d?.attributes?.refunded === true && wasStripeElectronic(d),
  );
  if (refunded.length === 0) return { posted, failures };

  const clearing = (p.bank?.find((a) => a.type === 'donation') || {}) as { value?: string; label?: string };
  if (!clearing?.value) {
    logger.warn('postRefundEntries: no clearing account configured - skipping refunds', { email: p.email, batchId: p.realBatchId });
    return { posted, failures };
  }
  const feesValue = p.settingBankCharges?.account?.value ?? '';
  const feesAccountRef = feesValue
    ? { value: feesValue, name: p.settingBankCharges?.account?.label, classRef: p.settingBankCharges?.class?.value || undefined }
    : undefined;

  // day -> { lines, feeCents }
  const byDay: Record<string, { lines: MappedDonationLine[]; feeCents: number }> = {};
  for (const donation of refunded) {
    try {
      const res = await withRetry(() =>
        axios.get(
          `https://api.planningcenteronline.com/giving/v2/donations/${donation.id}/refund?include=designation_refunds`,
          p.config,
        ),
      );
      const refund = res.data?.data;
      const included = (res.data?.included ?? []).filter((x: any) => x.type === 'DesignationRefund');
      const day = dayKey({ attributes: { received_at: refund?.attributes?.refunded_at } }, p.orgTimeZone);
      if (!day) {
        logger.warn('postRefundEntries: refund has no refunded_at - skipping', { email: p.email, donationId: donation.id });
        continue;
      }
      // Per-fund split when PCO provides it; otherwise the whole refund goes against the
      // donation's own fund mapping.
      const splits = included.length
        ? included.map((dr: any) => ({ fundId: dr.relationships?.fund?.data?.id, cents: Number(dr.attributes?.amount_cents) || 0 }))
        : [{ fundId: donation.relationships?.designations?.data?.[0]?.id && undefined, cents: Number(refund?.attributes?.amount_cents) || 0 }];

      const bucket = (byDay[day] = byDay[day] ?? { lines: [], feeCents: 0 });
      for (const sp of splits) {
        const fundName = sp.fundId ? p.fundIdToName[sp.fundId] : undefined;
        const mapping = fundName ? p.settingsData.find((it: any) => it.fundName === fundName) : undefined;
        const accountRef = mapping?.account?.value ?? '';
        if (!accountRef || sp.cents <= 0) {
          logger.warn('postRefundEntries: refund line has no fund mapping - skipping line', { email: p.email, donationId: donation.id, fundId: sp.fundId });
          continue;
        }
        bucket.lines.push({ AccountRef: accountRef, ClassRef: mapping?.class?.value || undefined, amount_cents: sp.cents, fundName });
      }
      bucket.feeCents += Number(refund?.attributes?.fee_cents) || 0;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error('postRefundEntries: could not read refund', { email: p.email, donationId: donation.id, error });
      failures.push({ day: `refund:${donation.id}`, error });
    }
  }

  for (const [day, bucket] of Object.entries(byDay)) {
    if (bucket.lines.length === 0) continue;
    // Declared out here so the catch can still mark a claimed row failed.
    let row: any = null;
    try {
      // Claiming inside the try: this call can throw (unique-index race, connection loss),
      // and outside it that escaped the pass entirely and aborted the batch's giving
      // entries too - contradicting this function's contract of returning failures.
      const [claimed, created] = await UserSync.findOrCreate({
        where: { userId: p.userId, batchId: p.realBatchId, donationId: `refund:${day}` },
        defaults: { status: 'pending', userId: p.userId, batchId: p.realBatchId, donationId: `refund:${day}` },
      });
      row = claimed;
      if (!created && (row.status === 'posted' || row.status === 'pending')) continue;

      await DailyJeSync.findOrCreate({
        where: { userId: p.userId, day },
        defaults: { userId: p.userId, day, postedGrossCents: 0, postedFeeCents: 0, entryCount: 0 },
      });
      const je = await sequelize.transaction(async (tx) => {
        const ledger = await DailyJeSync.findOne({ where: { userId: p.userId, day }, transaction: tx, lock: tx.LOCK.UPDATE });
        if (!ledger) throw new Error(`DailyJeSync row missing for ${p.userId} ${day}`);
        const payload = refundJournalEntryPayload(bucket.lines, {
          clearingAccountRef: { value: clearing.value!, name: clearing.label },
          txnDate: day,
          memo: `Church Sync Pro - PCO Electronic Giving Refund - ${day}`,
          syncId: p.realBatchId,
          feesAccountRef,
          totalFeeCents: bucket.feeCents,
        });
        const createdData: any = await automationJournalEntry(p.email, payload);
        const qboEntryId = createdData?.Id ? String(createdData.Id) : null;
        const gross = bucket.lines.reduce((sum, l) => sum + Number(l.amount_cents), 0);
        await ledger.update(
          {
            refundedGrossCents: Number(ledger.refundedGrossCents ?? 0) + gross,
            refundedFeeCents: Number(ledger.refundedFeeCents ?? 0) + Math.abs(bucket.feeCents),
            entryCount: Number(ledger.entryCount) + 1,
            qboEntryIds: [...(ledger.qboEntryIds || []), ...(qboEntryId ? [qboEntryId] : [])],
            batchIds: [...new Set([...(ledger.batchIds || []), p.realBatchId])],
          },
          { transaction: tx },
        );
        return payload;
      });
      await row.update({ status: 'posted', syncedData: je as any });
      posted.push(`refund:${day}`);
      logger.info('postRefundEntries: posted refund entry', { email: p.email, batchId: p.realBatchId, day });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error('postRefundEntries: failed to post refund entry', { email: p.email, batchId: p.realBatchId, day, error });
      if (row) await row.update({ status: 'failed' });
      failures.push({ day: `refund:${day}`, error });
    }
  }
  return { posted, failures };
};

export const syncBatchToJournalEntries = async (params: SyncBatchParams): Promise<SyncBatchResult> => {
  const { user, batchId = '0', realBatchId, bankData, dataBatch } = params;

  const userDetails = user;
  const { email, id: userId } = userDetails;

  const jsonRes = { donation: [] as any }; //this is an array object
  // Default to [] so `.find`/`.length` are always safe even when no bank is configured (bankData null).
  const bank = (bankData as
    | {
        type: 'donation' | 'registration';
        value: string;
        label: string;
      }[]
    | null) || [];

  const postedDays: string[] = [];
  const skippedDays: string[] = [];
  let eligibleDonations = 0;

  // Per-day JE failures within this batch. Collected so the batch can surface a failure to the
  // caller instead of silently swallowing it.
  const dayFailures: { day: string; error: string }[] = [];

  try {
    const tokenEntity = await generatePcToken(String(email));

    const { access_token } = tokenEntity;

    const config = {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    };

    // Resolved once per batch and threaded through both grouping calls below.
    const orgTimeZone = await getOrganisationTimeZone(config);

    if (batchId === '0') {
      return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [], eligibleDonations };
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId, batchId: realBatchId as string },
      attributes: ['id', 'batchId', 'donationId', 'status', 'createdAt', 'postedGrossCents'],
    });

    // Legacy Deposit-era short-circuit: old rows have `donationId = <QBO deposit Id>` (not a
    // `YYYY-MM-DD` day) with status 'posted'. The per-day dedup (`donationId === day`) never matches
    // those, so without this guard the automated path would re-post fresh JEs for an already-deposited
    // batch (double count). If any such legacy posted row exists, treat the batch as already synced.
    if (
      synchedBatchesData.some(
        (a) =>
          a.status === 'posted' &&
          !/^\d{4}-\d{2}-\d{2}$/.test(String(a.donationId)) &&
          // `refund:<day>` rows are written by this engine, not the legacy Deposit path.
          // They also fail the day-shaped test, so without this a single posted refund
          // made the batch look already-deposited and blocked every later donation in it.
          !String(a.donationId).startsWith('refund:'),
      )
    ) {
      logger.info('syncBatchToJournalEntries: batch already synced via legacy Deposit path - skipping', {
        email,
        batchId: String(realBatchId),
      });
      return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [], eligibleDonations };
    }

    const settingsJson = await UserSettings.findOne({ where: { userId } });
    const settingsData = settingsJson.settingsData as any;
    // Stripe fee account config: { account: { value, label }, class: { value, label } }.
    const settingBankCharges = settingsJson.settingBankCharges as any;

    if (isEmpty(settingsJson)) {
      // return responseError({ res, code: 500, data: 'Settings not set !' });
    }

    // Side-load funds in the same request via a nested include (PCO JSON:API supports
    // `designations.fund`). The response's `included[]` then carries both `Designation`
    // entries (used by the duplicate-summing logic below) AND `Fund` entries, letting us
    // resolve every donation's fund name from this single payload instead of making two
    // sequential PCO calls per donation (the old getFundInDonation N+1).
    // Paginate. PCO defaults to per_page=25 and returns `links.next`, so a single GET
    // silently truncates any batch bigger than that - dropping donations from the day's
    // entry with no error. Retry each page: a bare GET meant one 429 aborted the batch.
    let donationUrl: string | null =
      `https://api.planningcenteronline.com/giving/v2/batches/${batchId}/donations?per_page=100&include=designations,designations.fund`;
    const donationPages: any[] = [];
    const included: any[] = [];
    while (donationUrl) {
      const page: any = await withRetry(() => axios.get(donationUrl as string, config));
      donationPages.push(...((page.data?.data ?? []) as any[]));
      included.push(...((page.data?.included ?? []) as any[]));
      donationUrl = page.data?.links?.next ?? null;
    }

    // Restrict to Stripe electronic giving BEFORE anything else touches the data.
    // The duplicate-designation summing below collapses every donation sharing a fund
    // into one and adds their amounts together. Run before this filter, a cash or cheque
    // gift to the same fund is folded into a card donation and rides through as online
    // giving - which the brief explicitly excludes.
    const allDonations = donationPages;
    const fData = filterStripeElectronic(allDonations);
    eligibleDonations = fData.length;
    if (fData.length !== allDonations.length) {
      logger.info('syncBatchToJournalEntries: excluded non-Stripe-electronic donations', {
        email,
        batchId: String(realBatchId),
        excluded: allDonations.length - fData.length,
        kept: fData.length,
      });
    }

    // The included[] designations still describe every donation in the batch, including the
    // ones just excluded. Narrow them to the donations that survived, so their designations
    // cannot be summed into an eligible donation.
    const eligibleDesignationIds = new Set<string>(
      fData.flatMap((d: any) => (d.relationships?.designations?.data ?? []).map((x: any) => x.id)),
    );

    // `included` now mixes Designation and Fund resource objects. The duplicate-summing
    // logic below only cares about designations, so narrow to those for that step.
    const includedDesignations = included.filter(
      (item: any) => item.type === 'Designation' && eligibleDesignationIds.has(item.id),
    );

    // fundId -> fundName, built once per batch from the included Fund resources.
    const fundIdToName: Record<string, string> = included.reduce((acc: Record<string, string>, item: any) => {
      if (item.type === 'Fund') {
        acc[item.id] = item.attributes?.name;
      }
      return acc;
    }, {});

    // designationId -> fundId, from each designation's relationships.fund.data.id. Combined with
    // fundIdToName this resolves a donation -> its designation(s) -> fund id -> fund name.
    const designationIdToFundId: Record<string, string> = includedDesignations.reduce(
      (acc: Record<string, string>, designation: any) => {
        const fundId = designation.relationships?.fund?.data?.id;
        if (fundId) {
          acc[designation.id] = fundId;
        }
        return acc;
      },
      {},
    );

    // designationId -> its own amount and fund. A gift split across funds has one
    // designation per fund, and the donation's amount_cents is their total.
    const designationIndex: Record<string, DesignationInfo> = includedDesignations.reduce(
      (acc: Record<string, DesignationInfo>, designation: any) => {
        const fundId = designation.relationships?.fund?.data?.id;
        acc[designation.id] = {
          fundName: fundId ? fundIdToName[fundId] : undefined,
          amountCents: Number(designation.attributes?.amount_cents),
        };
        return acc;
      },
      {},
    );

    // There used to be a duplicate-summing pass here: donations sharing a fund had their
    // amounts folded onto the first and the rest dropped from `updatedData`. The day's fee
    // total is summed over the survivors, so every dropped donation's `fee_cents` went with
    // them - gross stayed right while fees were understated and the clearing debit was
    // overstated by exactly the fees lost. It fired on any fund receiving more than one gift
    // in a day, which for a real church is most days. The summing was also redundant:
    // `journalEntryPayload` already aggregates lines by account.
    const updatedData = fData;

    // Cheap batch-level fast-path: compute the distinct days that WOULD be posted from the RAW donations
    // (the filter/group helpers read `.attributes`, so they operate correctly on raw PCO donation objects).
    // If every such day is already synced for this (userId + realBatchId), skip the expensive
    // per-donation getFundInDonation enrichment + posting entirely (avoids an N+1 PCO refetch).
    // Refunds run off the UNFILTERED list and must not depend on the batch also containing
    // eligible giving. A refunded donation never passes `isStripeElectronic`, so a batch whose
    // only news is a refund leaves `updatedData` empty - and while this sat inside that guard,
    // the reversing entry was never posted and the money stayed in the clearing account.
    if (!isEmpty(allDonations)) {
      const refundPass = await postRefundEntries({
        email: String(email), userId, realBatchId: String(realBatchId), config, allDonations,
        fundIdToName, settingsData, settingBankCharges, bank, orgTimeZone,
      });
      postedDays.push(...refundPass.posted);
      dayFailures.push(...refundPass.failures);
    }

    if (!isEmpty(updatedData)) {
      const daysNow = groupDonationsByDay(filterStripeElectronic(updatedData), orgTimeZone);
      const candidateDays = Object.keys(daysNow);
      // A day counts as done only if this batch has not GAINED money for it since it was
      // posted. Comparing only the posted flag made this fast-path skip a batch whose
      // donation set had grown, which is precisely what the pagination fix produces the
      // first time it fetches a batch that PCO had been truncating at 25.
      const alreadyCovered = (day: string) => {
        const claim = synchedBatchesData.find((a) => a.donationId === day && a.status === 'posted');
        if (!claim) return false;
        // Posted before the amounts were recorded: no baseline, so leave it alone.
        if (claim.postedGrossCents == null) return true;
        const grossNow = (daysNow[day] as any[]).reduce((sum, d) => sum + (Number(d?.attributes?.amount_cents) || 0), 0);
        return Number(claim.postedGrossCents) >= grossNow;
      };
      const allDaysSynced = candidateDays.length > 0 && candidateDays.every(alreadyCovered);
      if (allDaysSynced) {
        return { batchId: String(realBatchId), postedDays, skippedDays: candidateDays, failedDays: [], eligibleDonations };
      }
    }

    for (const donationsData of updatedData) {
      // Resolve the donation's fund from the single side-loaded payload:
      // donation -> its first designation id -> fund id -> fund name.
      const designationRefs = donationsData.relationships?.designations?.data ?? [];
      const designationId = designationRefs[0]?.id;
      const resolvedFundId = designationId ? designationIdToFundId[designationId] : undefined;
      const resolvedFundName = resolvedFundId ? fundIdToName[resolvedFundId] : undefined;

      // Defensive fallback: only if the fund is NOT present in the included payload (e.g. PCO
      // did not honor the nested include) do we fall back to the per-donation getFundInDonation
      // round-trip. This keeps correctness while still eliminating the N+1 in the common path.
      let fundsData: any[];
      if (resolvedFundName) {
        fundsData = [{ id: resolvedFundId, type: 'Fund', attributes: { name: resolvedFundName } }];
      } else {
        logger.warn('syncBatchToJournalEntries: fund not found in included payload, falling back to getFundInDonation', {
          email,
          batchId: String(realBatchId),
          donationId: donationsData.id,
        });
        fundsData = await getFundInDonation({
          donationId: Number(donationsData.id),
          access_token: String(access_token),
        });
      }

      const fundName = fundsData[0]?.attributes?.name;
      const settingsItem = settingsData.find((item: SettingsJsonProps) => item.fundName === fundName);
      const accountRef = settingsItem?.account?.value ?? '';
      const receivedFrom = settingsItem?.customer?.value ?? '';
      const classRef = settingsItem?.class?.value ?? '';
      const paymentCheck = donationsData.attributes.payment_check_number || '';
      const bankRef = bank.find((a) => a.type === 'donation') || {};

      // One line per designation, so a gift split across funds credits each its own share.
      // `fundName` is the fallback for a payload whose designations did not side-load.
      const lines = donationLines(donationsData, designationIndex, settingsData, fundName);

      const donationDate = donationsData?.attributes?.completed_at
        ? new Date(donationsData?.attributes?.completed_at)
        : new Date();

      const TxnDate = format(donationDate, 'yyyy-MM-dd');

      jsonRes.donation = [
        ...jsonRes.donation,
        {
          ...donationsData,
          TxnDate,
          fund: fundsData[0] || {},
          batch: dataBatch,
          accountRef,
          receivedFrom,
          classRef,
          paymentCheck,
          bankRef,
          lines,
        },
      ];
    }
    if (!isEmpty(jsonRes.donation)) {
      // New posting path: per-calendar-day Journal Entries for Stripe electronic giving.
      const stripeDonations = filterStripeElectronic(jsonRes.donation);
      const byDay = groupDonationsByDay(stripeDonations, orgTimeZone);

      // Clearing account = the donation-type bank entry (same value used for bankRef/DepositToAccountRef).
      const clearing = (bank?.find((a) => a.type === 'donation') || {}) as { value?: string; label?: string };

      if (!clearing?.value) {
        logger.warn('syncBatchToJournalEntries: no clearing (donation bank) account configured - skipping JE post', {
          email,
          batchId: String(realBatchId),
        });
        return { batchId: String(realBatchId), postedDays, skippedDays: Object.keys(byDay), failedDays: [], eligibleDonations };
      }

      for (const [day, donations] of Object.entries(byDay)) {
        const mappedLines: MappedDonationLine[] = (donations as any[]).flatMap((donation) =>
          donation.lines?.length
            ? (donation.lines as MappedDonationLine[])
            : [
                {
                  AccountRef: donation.accountRef,
                  ClassRef: donation.classRef || undefined,
                  amount_cents: Number(donation.attributes.amount_cents),
                  fundName: donation.fund?.attributes?.name ?? '',
                },
              ],
        );

        // Drop unmapped-fund lines (blank AccountRef) - QBO rejects JE lines with no AccountRef.
        const validLines = mappedLines.filter((l) => l.AccountRef);
        if (validLines.length < mappedLines.length) {
          logger.warn('syncBatchToJournalEntries: skipped unmapped-fund donation(s)', {
            email,
            batchId: String(realBatchId),
            day,
            skipped: mappedLines.length - validLines.length,
          });
        }
        if (validLines.length === 0) {
          skippedDays.push(day);
          continue;
        }

        // The day's Stripe fee, excluding gifts whose donor covered it - the church did not
        // pay those, and Stripe deposits the whole gift for them.
        const totalFeeCents = chargeableFeeCents(donations as any[]);

        // Resolve the fees account from settingBankCharges (same shape used in automation-helper.ts).
        const feesAccountValue = settingBankCharges?.account?.value ?? '';
        const feesAccountRef = feesAccountValue
          ? {
              value: feesAccountValue,
              name: settingBankCharges?.account?.label,
              classRef: settingBankCharges?.class?.value || undefined,
            }
          : undefined;

        // Day has fees but no fees account configured: can't split. Warn (don't throw); the JE will
        // debit the clearing account at gross.
        if (totalFeeCents !== 0 && !feesAccountValue) {
          logger.warn(
            'syncBatchToJournalEntries: fees present but no bank-charges account configured - JE will debit clearing at gross',
            {
              email,
              batchId: String(realBatchId),
              day,
              totalFeeCents,
            },
          );
        }

        // Atomic claim against the unique index on (userId, batchId, donationId).
        // Concurrent callers: exactly one creates the row, the other finds it.
        const [row, created] = await UserSync.findOrCreate({
          where: { userId, batchId: String(realBatchId), donationId: day },
          defaults: {
            status: 'pending',
            userId,
            batchId: String(realBatchId),
            donationId: day,
          },
        });

        // What this batch now says it owes the day, per revenue account. Compared against
        // what the same claim posted last time, so a batch whose donation set GREW can top
        // the day up instead of being skipped forever - which is what happened while the
        // claim was a bare flag: the un-paginated fetch truncated a batch at 25 donations,
        // and once the fix started returning all of them the extra money had nowhere to go.
        const currentByAccount: Record<string, number> = {};
        for (const l of validLines) {
          currentByAccount[l.AccountRef] = (currentByAccount[l.AccountRef] ?? 0) + Number(l.amount_cents);
        }
        const currentFeeCents = Math.abs(totalFeeCents || 0);
        const currentGrossCents = Object.values(currentByAccount).reduce((a, b) => a + b, 0);

        let linesToPost = validLines;
        let feeToPost = totalFeeCents;

        if (!created) {
          if (row.status === 'pending') {
            // Another worker claimed this day and is mid-flight.
            skippedDays.push(day);
            continue;
          }
          if (row.status === 'posted') {
            if (row.postedByAccount == null) {
              // Posted before this bookkeeping existed, so there is no baseline to compare
              // against. Treat it as complete rather than re-posting the whole day.
              skippedDays.push(day);
              continue;
            }

            const already = row.postedByAccount as Record<string, number>;
            const deltaLines = Object.entries(currentByAccount)
              .map(([account, cents]) => ({ account, delta: cents - (Number(already[account]) || 0) }))
              .filter((d) => d.delta > 0)
              .map((d) => {
                const template = validLines.find((v) => v.AccountRef === d.account);
                return {
                  AccountRef: d.account,
                  ClassRef: template?.ClassRef,
                  amount_cents: d.delta,
                  fundName: template?.fundName,
                } as MappedDonationLine;
              });

            if (deltaLines.length === 0) {
              // Nothing new. This is the ordinary re-run.
              skippedDays.push(day);
              continue;
            }

            const deltaFee = currentFeeCents - (Number(row.postedFeeCents) || 0);
            if (deltaFee < 0) {
              // Fees going down means money left the day, which is a refund - and refunds
              // have their own reversing entry. Never post a negative fee here.
              logger.warn('syncBatchToJournalEntries: fees decreased for an already-posted day - not adjusting fees', {
                email,
                batchId: String(realBatchId),
                day,
                postedFeeCents: Number(row.postedFeeCents) || 0,
                currentFeeCents,
              });
            }

            linesToPost = deltaLines;
            feeToPost = -Math.max(0, deltaFee);
            logger.info('syncBatchToJournalEntries: batch grew since it was last synced - posting the difference', {
              email,
              batchId: String(realBatchId),
              day,
              previousGrossCents: Number(row.postedGrossCents) || 0,
              currentGrossCents,
            });
          }
          // row.status === 'failed' -> retry: fall through and reuse this same row.
        }

        try {
          // One entry per day. The DailyJeSync row is the per-day ledger: it is locked for the
          // duration of the post so that two workers processing different PCO batches that both
          // contain donations for `day` cannot each post a "first" entry for it.
          //
          // If the day already has an entry, this batch's donations are new information arriving
          // late (a later-committed batch, or a correction). Rather than editing a posted
          // transaction - which would rewrite history an accountant may already have reconciled
          // against - we post an *adjusting* entry covering only this contribution. The entries
          // for the day then sum to the day's true total.
          //
          // Ensure the ledger row exists BEFORE opening the locking transaction. A
          // `SELECT ... FOR UPDATE` cannot lock a row that does not exist yet, and a unique
          // violation raised inside a Postgres transaction would abort the whole transaction
          // rather than being retryable. Creating it first means the lock below always has a
          // real row to take.
          await DailyJeSync.findOrCreate({
            where: { userId, day },
            defaults: { userId, day, postedGrossCents: 0, postedFeeCents: 0, entryCount: 0 },
          });

          const { je, isAdjusting } = await sequelize.transaction(async (tx) => {
            const ledger = await DailyJeSync.findOne({
              where: { userId, day },
              transaction: tx,
              lock: tx.LOCK.UPDATE,
            });

            if (!ledger) throw new Error(`DailyJeSync row missing for ${userId} ${day}`);

            const adjusting = Number(ledger.entryCount) > 0;

            const payload = journalEntryPayload(linesToPost, {
              clearingAccountRef: { value: clearing.value, name: clearing.label },
              txnDate: day,
              memo: adjusting
                ? `Church Sync Pro - PCO Electronic Giving Adjustment - ${day}`
                : `Church Sync Pro - PCO Electronic Giving Sync - ${day}`,
              syncId: String(realBatchId),
              feesAccountRef,
              totalFeeCents: feeToPost,
            });

            const createdData: any = await automationJournalEntry(email as string, payload);
            const qboEntryId = createdData?.Id ? String(createdData.Id) : null;

            const contributionGross = linesToPost.reduce((sum, l) => sum + Number(l.amount_cents), 0);

            await ledger.update(
              {
                postedGrossCents: Number(ledger.postedGrossCents) + contributionGross,
                postedFeeCents: Number(ledger.postedFeeCents) + Math.abs(feeToPost || 0),
                entryCount: Number(ledger.entryCount) + 1,
                qboEntryIds: [...(ledger.qboEntryIds || []), ...(qboEntryId ? [qboEntryId] : [])],
                batchIds: [...new Set([...(ledger.batchIds || []), String(realBatchId)])],
              },
              { transaction: tx },
            );

            return { je: payload, isAdjusting: adjusting };
          });

          if (isAdjusting) {
            logger.info('syncBatchToJournalEntries: posted adjusting entry for an already-synced day', {
              email,
              batchId: String(realBatchId),
              day,
            });
          }

          await row.update({
            status: 'posted',
            syncedData: je as any,
            postedGrossCents: currentGrossCents,
            postedFeeCents: currentFeeCents,
            postedByAccount: currentByAccount,
          });
          postedDays.push(day);
        } catch (err) {
          // Per-day failure: mark the row failed (retryable) and continue with other days,
          // but record the error so the batch-level catch surfaces it to the caller.
          const error = err instanceof Error ? err.message : String(err);
          logger.error('syncBatchToJournalEntries: failed to post JE', {
            email,
            batchId: String(realBatchId),
            day,
            error,
          });
          await row.update({ status: 'failed' });
          dayFailures.push({ day, error });
          continue;
        }
      }
    }

    // If any individual day failed to post, surface it as a batch-level failure so the caller
    // records this user/batch as failed rather than reporting success.
    if (!isEmpty(dayFailures)) {
      throw new Error(
        `syncBatchToJournalEntries: ${dayFailures.length} day(s) failed to post for batch ${realBatchId}: ${dayFailures
          .map((f) => `${f.day} (${f.error})`)
          .join('; ')}`,
      );
    }

    return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [], eligibleDonations };
  } catch (e) {
    // RE-THROW: do not swallow. The caller's per-user/per-batch try/catch records the failure.
    const error = e instanceof Error ? e.message : String(e);
    logger.error('syncBatchToJournalEntries: batch sync failed', { email, batchId: String(realBatchId), error });
    throw e;
  }
};
