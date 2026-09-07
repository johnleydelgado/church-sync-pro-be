import { refundJournalEntryPayload, journalEntryPayload } from '../mapping';

// Client decision: "For refunds, let's record them on the date they actually occur."
// A refund is a reversing entry on the refund date - never an edit to the original day.

const opts = (over: Record<string, unknown> = {}) => ({
  clearingAccountRef: { value: '900', name: 'Stripe Clearing' },
  txnDate: '2026-09-05',
  memo: 'Church Sync Pro - PCO Electronic Giving Refund - 2026-09-05',
  feesAccountRef: { value: 'fees', name: 'Stripe Processing Fees' },
  ...over,
});
const sum = (je: any, posting: string, acct?: string) =>
  je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === posting && (!acct || l.JournalEntryLineDetail.AccountRef.value === acct))
    .reduce((s: number, l: any) => s + l.Amount, 0);

test('a refund reverses the original: debit revenue, credit clearing', () => {
  const je = refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 5000 }], opts({ totalFeeCents: 0 }));
  expect(sum(je, 'Debit', '400')).toBeCloseTo(50, 2);
  expect(sum(je, 'Credit', '900')).toBeCloseTo(50, 2);
  expect(sum(je, 'Credit', 'fees')).toBe(0); // Stripe kept its fee: nothing returned
  expect(je.TxnDate).toBe('2026-09-05');
});

test('a returned fee is credited back to the fees account and reduces the clearing credit', () => {
  const je = refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 5000 }], opts({ totalFeeCents: -150 }));
  expect(sum(je, 'Debit', '400')).toBeCloseTo(50, 2);
  expect(sum(je, 'Credit', 'fees')).toBeCloseTo(1.5, 2);
  expect(sum(je, 'Credit', '900')).toBeCloseTo(48.5, 2);
});

test('every refund entry balances', () => {
  for (const fee of [0, -150, -758]) {
    const je = refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 69920 }], opts({ totalFeeCents: fee }));
    expect(sum(je, 'Debit')).toBeCloseTo(sum(je, 'Credit'), 2);
  }
});

test('a partial refund across two funds debits each fund for its share', () => {
  const je = refundJournalEntryPayload(
    [{ AccountRef: '400', amount_cents: 3000 }, { AccountRef: '401', amount_cents: 2000 }],
    opts({ totalFeeCents: 0 }),
  );
  expect(sum(je, 'Debit', '400')).toBeCloseTo(30, 2);
  expect(sum(je, 'Debit', '401')).toBeCloseTo(20, 2);
  expect(sum(je, 'Credit', '900')).toBeCloseTo(50, 2);
});

test('the memo distinguishes a refund from giving and from an adjustment', () => {
  const je = refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 5000 }], opts({ syncId: '42' }));
  expect(je.PrivateNote).toContain('Refund');
  expect(je.PrivateNote).toContain('| 42');
});

test('a full refund exactly undoes the original giving entry, net of the kept fee', () => {
  const original = journalEntryPayload([{ AccountRef: '400', amount_cents: 5000 }], { ...opts({ memo: 'sync' }), totalFeeCents: -150 });
  const refund = refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 5000 }], opts({ totalFeeCents: 0 }));
  // Revenue is fully reversed...
  expect(sum(original, 'Credit', '400') - sum(refund, 'Debit', '400')).toBeCloseTo(0, 2);
  // ...but clearing is left short by the fee Stripe kept, which is the real-world outcome.
  expect(sum(original, 'Debit', '900') - sum(refund, 'Credit', '900')).toBeCloseTo(-1.5, 2);
});

test('rejects an empty or zero refund and a returned fee larger than the refund', () => {
  expect(() => refundJournalEntryPayload([], opts())).toThrow(/no refund lines/);
  expect(() => refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 0 }], opts())).toThrow(/Invalid refund entry total/);
  expect(() => refundJournalEntryPayload([{ AccountRef: '400', amount_cents: 100 }], opts({ totalFeeCents: -500 }))).toThrow(/exceeds refund/);
});
