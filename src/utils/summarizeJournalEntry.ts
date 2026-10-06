/* eslint-disable @typescript-eslint/no-explicit-any */

export interface JournalEntryCreditSummary {
  accountRef: string;
  amount: number;
  /**
   * The QuickBooks account's name, resolved from the church's fund mapping. The stored journal
   * payload carries only the account id on its credit lines, so without this the page had
   * nothing to show and fell back to the words "Revenue account" - useless to a bookkeeper
   * looking at a day with several funds.
   */
  accountName?: string;
}

export interface JournalEntrySummary {
  gross: number;
  fees: number;
  net: number;
  credits: JournalEntryCreditSummary[];
  memo: string;
}

// Coerce any incoming Amount (which may arrive as a string from QBO/JSON) to a finite number.
const toAmount = (value: any): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const EMPTY: JournalEntrySummary = { gross: 0, fees: 0, net: 0, credits: [], memo: '' };

/**
 * Summarize a single QBO JournalEntry `syncedData` payload (as produced by `journalEntryPayload`).
 *
 * - `gross`  = sum of the Credit line Amounts (revenue, gross).
 * - `fees`   = the fees Debit amount (the smaller of two debits); 0 when there is only one debit.
 * - `net`    = the clearing Debit amount (the larger/only debit) = gross - fees.
 * - `credits` = per Credit line `{ accountRef, amount }`.
 * - `memo`   = the PrivateNote.
 *
 * Defensive by design: coerces Amounts to numbers and returns safe zeros for empty/malformed input.
 */
export const summarizeJournalEntry = (syncedData: any): JournalEntrySummary => {
  const lines = syncedData?.Line;
  if (!syncedData || !Array.isArray(lines)) {
    return { ...EMPTY, credits: [], memo: String(syncedData?.PrivateNote ?? '') };
  }

  const credits: JournalEntryCreditSummary[] = [];
  const debitAmounts: number[] = [];

  for (const line of lines) {
    const detail = line?.JournalEntryLineDetail;
    const postingType = detail?.PostingType;
    const amount = toAmount(line?.Amount);
    if (postingType === 'Credit') {
      credits.push({ accountRef: String(detail?.AccountRef?.value ?? ''), amount });
    } else if (postingType === 'Debit') {
      debitAmounts.push(amount);
    }
  }

  const gross = credits.reduce((sum, c) => sum + c.amount, 0);

  // At most two debits: the larger is the clearing (net) debit, the smaller is fees.
  // With a single debit, fees=0 and net=that debit.
  let fees = 0;
  let net = 0;
  if (debitAmounts.length >= 2) {
    const sorted = [...debitAmounts].sort((a, b) => a - b);
    net = sorted[sorted.length - 1];
    fees = sorted[sorted.length - 2];
  } else if (debitAmounts.length === 1) {
    net = debitAmounts[0];
    fees = 0;
  }

  return {
    gross,
    fees,
    net,
    credits,
    memo: String(syncedData.PrivateNote ?? ''),
  };
};

/** The day-keyed claim row (`UserSync`) the engine keeps for each posted day. */
export interface DailyClaimLike {
  syncedData?: any;
  postedGrossCents?: number | string | null;
  postedFeeCents?: number | string | null;
  postedByAccount?: Record<string, number | string> | null;
}

/** The day's ledger row (`DailyJeSync`): how many entries were posted, and their QuickBooks ids. */
export interface DayLedgerLike {
  entryCount?: number | string | null;
  qboEntryIds?: string[] | null;
}

/**
 * Summarize a whole posted day for the Daily Sync page.
 *
 * A day can take more than one journal entry: giving that settles after the day was posted
 * (ACH, mostly) goes in as an adjusting entry, and the engine then overwrites the claim's
 * `syncedData` with that adjusting entry. Summarising `syncedData` alone therefore showed only
 * the latest entry - Active Church's 2026-09-15 read $486.70 when $1,391.15 had been posted.
 *
 * The claim also carries the running totals the engine uses to post only the difference
 * (`postedGrossCents`, `postedFeeCents`, `postedByAccount`), which are the day's cumulative
 * figures, so those are used whenever they exist. A claim posted before they were recorded
 * falls back to its single stored entry.
 */
export const summarizeDailyClaim = (claim: DailyClaimLike, ledger?: DayLedgerLike | null): JournalEntrySummary => {
  const latest = summarizeJournalEntry(claim?.syncedData);
  if (claim?.postedGrossCents == null) return latest;

  const grossCents = Math.round(toAmount(claim.postedGrossCents));
  const feeCents = Math.round(toAmount(claim.postedFeeCents));
  const entryCount = Math.max(1, Math.round(toAmount(ledger?.entryCount ?? 1)));

  // Per-account running totals. Without them, the latest entry's lines are the day's lines only
  // when the day has a single entry; otherwise show none rather than a misleading partial list.
  let credits: JournalEntryCreditSummary[];
  if (claim.postedByAccount) {
    credits = Object.entries(claim.postedByAccount).map(([accountRef, cents]) => ({
      accountRef: String(accountRef),
      amount: Math.round(toAmount(cents)) / 100,
    }));
  } else {
    credits = entryCount === 1 ? latest.credits : [];
  }

  const ids = (ledger?.qboEntryIds ?? []).filter(Boolean);
  const memo =
    entryCount > 1
      ? `Posted as ${entryCount} QuickBooks entries${ids.length ? `: #${ids.join(', #')}` : ''}`
      : latest.memo;

  return {
    gross: grossCents / 100,
    fees: feeCents / 100,
    net: (grossCents - feeCents) / 100,
    credits,
    memo,
  };
};
