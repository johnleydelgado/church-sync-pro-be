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
  MappedDonationLine,
  SettingsJsonProps,
  filterStripeElectronic,
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
  const refunded = (p.allDonations ?? []).filter((d) => d?.attributes?.refunded === true);
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
    const [row, created] = await UserSync.findOrCreate({
      where: { userId: p.userId, batchId: p.realBatchId, donationId: `refund:${day}` },
      defaults: { status: 'pending', userId: p.userId, batchId: p.realBatchId, donationId: `refund:${day}` },
    });
    if (!created && (row.status === 'posted' || row.status === 'pending')) continue;

    try {
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
      await row.update({ status: 'failed' });
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
      return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [] };
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId, batchId: realBatchId as string },
      attributes: ['id', 'batchId', 'donationId', 'status', 'createdAt'],
    });

    // Legacy Deposit-era short-circuit: old rows have `donationId = <QBO deposit Id>` (not a
    // `YYYY-MM-DD` day) with status 'posted'. The per-day dedup (`donationId === day`) never matches
    // those, so without this guard the automated path would re-post fresh JEs for an already-deposited
    // batch (double count). If any such legacy posted row exists, treat the batch as already synced.
    if (
      synchedBatchesData.some(
        (a) => a.status === 'posted' && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.donationId)),
      )
    ) {
      logger.info('syncBatchToJournalEntries: batch already synced via legacy Deposit path - skipping', {
        email,
        batchId: String(realBatchId),
      });
      return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [] };
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
    const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${batchId}/donations?include=designations,designations.fund`;
    const responseDonation = await axios.get(donationUrl, config);
    // return responseDonation.data;
    const included = (responseDonation.data.included ?? []) as any[];

    // Restrict to Stripe electronic giving BEFORE anything else touches the data.
    // The duplicate-designation summing below collapses every donation sharing a fund
    // into one and adds their amounts together. Run before this filter, a cash or cheque
    // gift to the same fund is folded into a card donation and rides through as online
    // giving - which the brief explicitly excludes.
    const allDonations = responseDonation.data.data as any[];
    const fData = filterStripeElectronic(allDonations);
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

    // Step 1: Map fund IDs to their related designations
    const fundIdToDesignations = includedDesignations.reduce((acc, designation) => {
      // Guard against malformed/partial PCO payloads: a designation may be missing its fund
      // relationship. Skip it rather than throwing a TypeError that aborts the whole batch.
      const fundId = designation.relationships?.fund?.data?.id;
      if (!fundId) {
        return acc;
      }
      if (!acc[fundId]) {
        acc[fundId] = [];
      }
      acc[fundId].push(designation);
      return acc;
    }, {});

    // Step 2: Find duplicates and sum their amounts
    Object.keys(fundIdToDesignations).forEach((fundId) => {
      if (fundIdToDesignations[fundId].length > 1) {
        // Found duplicates
        const summedAmount = fundIdToDesignations[fundId].reduce((sum, designation) => {
          const donationId = designation.id;
          const donation = fData.find((donation) =>
            donation.relationships?.designations?.data?.some((d) => d.id === donationId),
          );
          // Guard: the matching donation may be missing from a partial PCO payload. Skip it
          // (don't add to the sum) rather than throwing a TypeError that aborts the batch.
          if (!donation) {
            logger.warn('syncBatchToJournalEntries: donation not found for designation during dedup sum - skipping', {
              email,
              batchId: String(realBatchId),
              designationId: donationId,
              fundId,
            });
            return sum;
          }
          return sum + donation.attributes.amount_cents;
        }, 0);

        // Update the first donation with the summed amount and mark others for removal or update them as needed
        let isFirstUpdated = false;
        fundIdToDesignations[fundId].forEach((designation) => {
          const donationId = designation.id;
          const donationIndex = fData.findIndex((donation) =>
            donation.relationships?.designations?.data?.some((d) => d.id === donationId),
          );
          // Guard: no matching donation in a partial payload -> nothing to update/mark. Skip.
          if (donationIndex === -1) {
            return;
          }
          if (!isFirstUpdated) {
            fData[donationIndex].attributes.amount_cents = summedAmount;
            isFirstUpdated = true;
          } else {
            // Remove the duplicate donation or handle it as needed
            // For example, to remove, you can mark it and then filter out later
            fData[donationIndex]._remove = true; // Mark for removal
          }
        });
      }
    });

    // Optional: Remove marked donations
    const updatedData = fData.filter((donation) => !donation._remove);

    // Cheap batch-level fast-path: compute the distinct days that WOULD be posted from the RAW donations
    // (the filter/group helpers read `.attributes`, so they operate correctly on raw PCO donation objects).
    // If every such day is already synced for this (userId + realBatchId), skip the expensive
    // per-donation getFundInDonation enrichment + posting entirely (avoids an N+1 PCO refetch).
    if (!isEmpty(updatedData)) {
      // Refunds first: they are found on the UNFILTERED list (refunded donations never
      // pass the giving filter) and must run even when every giving day below is already
      // synced, which is exactly the case for a batch whose only news is a refund.
      const refundPass = await postRefundEntries({
        email: String(email), userId, realBatchId: String(realBatchId), config, allDonations,
        fundIdToName, settingsData, settingBankCharges, bank, orgTimeZone,
      });
      postedDays.push(...refundPass.posted);
      dayFailures.push(...refundPass.failures);

      const candidateDays = Object.keys(groupDonationsByDay(filterStripeElectronic(updatedData), orgTimeZone));
      const allDaysSynced =
        candidateDays.length > 0 &&
        candidateDays.every((day) => synchedBatchesData.some((a) => a.donationId === day && a.status === 'posted'));
      if (allDaysSynced) {
        return { batchId: String(realBatchId), postedDays, skippedDays: candidateDays, failedDays: [] };
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
        return { batchId: String(realBatchId), postedDays, skippedDays: Object.keys(byDay), failedDays: [] };
      }

      for (const [day, donations] of Object.entries(byDay)) {
        const mappedLines: MappedDonationLine[] = (donations as any[]).map((donation) => ({
          AccountRef: donation.accountRef,
          ClassRef: donation.classRef || undefined,
          amount_cents: Number(donation.attributes.amount_cents),
          fundName: donation.fund?.attributes?.name ?? '',
        }));

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

        // Sum the day's total Stripe fee (PCO fee_cents is per donation, typically negative).
        const totalFeeCents = (donations as any[]).reduce(
          (s, donation) => s + (Number(donation.attributes.fee_cents) || 0),
          0,
        );

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

        if (!created) {
          if (row.status === 'posted') {
            // Already synced for this (userId + realBatchId + day).
            skippedDays.push(day);
            continue;
          }
          if (row.status === 'pending') {
            // Another worker claimed this day and is mid-flight.
            skippedDays.push(day);
            continue;
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

            const payload = journalEntryPayload(validLines, {
              clearingAccountRef: { value: clearing.value, name: clearing.label },
              txnDate: day,
              memo: adjusting
                ? `Church Sync Pro - PCO Electronic Giving Adjustment - ${day}`
                : `Church Sync Pro - PCO Electronic Giving Sync - ${day}`,
              syncId: String(realBatchId),
              feesAccountRef,
              totalFeeCents,
            });

            const createdData: any = await automationJournalEntry(email as string, payload);
            const qboEntryId = createdData?.Id ? String(createdData.Id) : null;

            const contributionGross = validLines.reduce((sum, l) => sum + Number(l.amount_cents), 0);

            await ledger.update(
              {
                postedGrossCents: Number(ledger.postedGrossCents) + contributionGross,
                postedFeeCents: Number(ledger.postedFeeCents) + Math.abs(totalFeeCents || 0),
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

          await row.update({ status: 'posted', syncedData: je as any });
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

    return { batchId: String(realBatchId), postedDays, skippedDays, failedDays: [] };
  } catch (e) {
    // RE-THROW: do not swallow. The caller's per-user/per-batch try/catch records the failure.
    const error = e instanceof Error ? e.message : String(e);
    logger.error('syncBatchToJournalEntries: batch sync failed', { email, batchId: String(realBatchId), error });
    throw e;
  }
};
