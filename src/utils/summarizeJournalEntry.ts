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
