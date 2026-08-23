import { journalEntryPayload } from '../mapping';

// These cover the accounting invariant behind "one journal entry per day": when a day's
// donations arrive across more than one PCO batch, the first contribution posts the day's
// entry and each later contribution posts an *adjusting* entry for only its own amount.
// The entries for the date must then sum to the day's true total.
//
// The per-day lock and ledger bookkeeping that decide which of the two a contribution
// becomes live in syncEngine and are exercised against a real database, not here.

const opts = (memo: string) => ({
  clearingAccountRef: { value: '900', name: 'Stripe Clearing' },
  txnDate: '2026-05-01',
  memo,
  feesAccountRef: { value: 'fees', name: 'Stripe Processing Fees' },
});

const sumBy = (je: any, posting: 'Credit' | 'Debit', account?: string) =>
  je.Line.filter(
    (l: any) =>
      l.JournalEntryLineDetail.PostingType === posting &&
      (!account || l.JournalEntryLineDetail.AccountRef.value === account),
  ).reduce((s: number, l: any) => s + l.Amount, 0);

test('original plus adjusting entry sum to the full day total', () => {
  // Day total is the worked example: $699.20 gross, $10.58 fees, $688.62 to clearing.
  // It arrives as two batches: $500.00 (fee $7.58) first, then $199.20 (fee $3.00) late.
  const original = journalEntryPayload([{ AccountRef: '400', amount_cents: 50000 }], {
    ...opts('Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01'),
    totalFeeCents: -758,
  });
  const adjusting = journalEntryPayload([{ AccountRef: '400', amount_cents: 19920 }], {
    ...opts('Church Sync Pro - PCO Electronic Giving Adjustment - 2026-05-01'),
    totalFeeCents: -300,
  });

  expect(sumBy(original, 'Credit') + sumBy(adjusting, 'Credit')).toBeCloseTo(699.2, 2);
  expect(sumBy(original, 'Debit', 'fees') + sumBy(adjusting, 'Debit', 'fees')).toBeCloseTo(10.58, 2);
  expect(sumBy(original, 'Debit', '900') + sumBy(adjusting, 'Debit', '900')).toBeCloseTo(688.62, 2);
});

test('each entry balances on its own', () => {
  for (const [cents, fee] of [
    [50000, -758],
    [19920, -300],
  ]) {
    const je = journalEntryPayload([{ AccountRef: '400', amount_cents: cents }], {
      ...opts('memo'),
      totalFeeCents: fee,
    });
    expect(sumBy(je, 'Credit')).toBeCloseTo(sumBy(je, 'Debit'), 2);
  }
});

test('both entries carry the same TxnDate so they land on the same day in QBO', () => {
  const a = journalEntryPayload([{ AccountRef: '400', amount_cents: 50000 }], opts('sync'));
  const b = journalEntryPayload([{ AccountRef: '400', amount_cents: 19920 }], opts('adjustment'));
  expect(a.TxnDate).toBe('2026-05-01');
  expect(b.TxnDate).toBe(a.TxnDate);
});

test('an adjusting entry is distinguishable from the original by its memo', () => {
  const original = journalEntryPayload(
    [{ AccountRef: '400', amount_cents: 50000 }],
    opts('Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01'),
  );
  const adjusting = journalEntryPayload(
    [{ AccountRef: '400', amount_cents: 19920 }],
    opts('Church Sync Pro - PCO Electronic Giving Adjustment - 2026-05-01'),
  );
  expect(original.PrivateNote).toContain('Giving Sync');
  expect(adjusting.PrivateNote).toContain('Giving Adjustment');
});

test('a multi-fund day splits credits per account in both the original and the adjustment', () => {
  const je = journalEntryPayload(
    [
      { AccountRef: '400', amount_cents: 40000, fundName: 'Tithes' },
      { AccountRef: '401', amount_cents: 10000, fundName: 'Missions' },
    ],
    { ...opts('sync'), totalFeeCents: -758 },
  );
  expect(sumBy(je, 'Credit', '400')).toBeCloseTo(400, 2);
  expect(sumBy(je, 'Credit', '401')).toBeCloseTo(100, 2);
  expect(sumBy(je, 'Debit', '900')).toBeCloseTo(492.42, 2);
});
