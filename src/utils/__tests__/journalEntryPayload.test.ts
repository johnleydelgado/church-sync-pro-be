import { journalEntryPayload } from '../mapping';

const mapped = [
  { AccountRef: '101', ClassRef: '5', amount_cents: 500000, fundName: 'General Tithes' },
  { AccountRef: '102', ClassRef: '5', amount_cents: 120000, fundName: 'Missions' },
  { AccountRef: '101', ClassRef: '5', amount_cents: 25000, fundName: 'General Tithes' },
];

test('builds a balanced journal entry: credits per account, single clearing debit', () => {
  const je = journalEntryPayload(mapped, {
    clearingAccountRef: { value: '900', name: 'Funds in Transit' },
    txnDate: '2026-05-01',
    memo: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01',
  });
  const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit');
  const debits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');
  expect(credits.length).toBe(2);
  expect(debits.length).toBe(1);
  const acct101 = credits.find((l: any) => l.JournalEntryLineDetail.AccountRef.value === '101');
  expect(acct101.Amount).toBe(5250);
  expect(debits[0].Amount).toBe(6450);
  expect(debits[0].JournalEntryLineDetail.AccountRef.value).toBe('900');
  expect(je.TxnDate).toBe('2026-05-01');
  expect(je.PrivateNote).toContain('2026-05-01');
});

test('credit total equals debit total (balanced)', () => {
  const je = journalEntryPayload(mapped, {
    clearingAccountRef: { value: '900' },
    txnDate: '2026-05-01',
    memo: 'm',
  });
  const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit');
  const debit = je.Line.find((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');
  const creditSum = credits.reduce((s: number, l: any) => s + l.Amount, 0);
  expect(creditSum).toBeCloseTo(debit.Amount, 2);
});

test('debit equals the exact sum of rounded credits for odd whole-cent amounts', () => {
  const je = journalEntryPayload(
    [
      { AccountRef: '101', amount_cents: 333 },
      { AccountRef: '102', amount_cents: 334 },
    ],
    { clearingAccountRef: { value: '900' }, txnDate: '2026-05-01', memo: 'm' },
  );
  const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit');
  const debit = je.Line.find((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');
  const creditSum = credits.reduce((s: number, l: any) => s + l.Amount, 0);
  expect(debit.Amount).toBe(creditSum);
});

test('throws on fractional amount_cents (input corruption)', () => {
  expect(() =>
    journalEntryPayload(
      [
        { AccountRef: '101', amount_cents: 100.5 },
        { AccountRef: '102', amount_cents: 200.5 },
      ],
      { clearingAccountRef: { value: '900' }, txnDate: '2026-05-01', memo: 'm' },
    ),
  ).toThrow(/rounding mismatch/);
});

test('throws when there are no donation lines', () => {
  expect(() =>
    journalEntryPayload([], { clearingAccountRef: { value: '900' }, txnDate: '2026-05-01', memo: 'm' }),
  ).toThrow(/no donation lines/);
});

test('throws on a NaN amount_cents (malformed amount)', () => {
  expect(() =>
    journalEntryPayload(
      [
        { AccountRef: '101', amount_cents: Number('abc') },
        { AccountRef: '102', amount_cents: 200 },
      ],
      { clearingAccountRef: { value: '900' }, txnDate: '2026-05-01', memo: 'm' },
    ),
  ).toThrow(/Invalid journal entry total/);
});

test('throws on an all-zero set ($0 total)', () => {
  expect(() =>
    journalEntryPayload(
      [
        { AccountRef: '101', amount_cents: 0 },
        { AccountRef: '102', amount_cents: 0 },
      ],
      { clearingAccountRef: { value: '900' }, txnDate: '2026-05-01', memo: 'm' },
    ),
  ).toThrow(/Invalid journal entry total/);
});

test('splits Stripe fees: credits gross, debits fees + NET clearing (worked example)', () => {
  const je = journalEntryPayload([{ AccountRef: '400', ClassRef: 'cls', amount_cents: 69920, fundName: 'Tithes & Offerings' }], {
    clearingAccountRef: { value: '900', name: 'Stripe Clearing Account' },
    txnDate: '2026-05-01',
    memo: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01',
    feesAccountRef: { value: 'fees', name: 'Stripe Processing Fees', classRef: 'cls' },
    totalFeeCents: -1058,
  });

  const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit');
  const debits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');

  // One gross credit to the revenue account.
  expect(credits.length).toBe(1);
  expect(credits[0].Amount).toBe(699.2);
  expect(credits[0].JournalEntryLineDetail.AccountRef.value).toBe('400');

  // Two debit lines: fees + clearing.
  expect(debits.length).toBe(2);

  const feeLine: any = debits.find((l: any) => l.JournalEntryLineDetail.AccountRef.value === 'fees');
  expect(feeLine.Amount).toBe(10.58);
  expect(feeLine.JournalEntryLineDetail.ClassRef.value).toBe('cls');

  const clearingLine: any = debits.find((l: any) => l.JournalEntryLineDetail.AccountRef.value === '900');
  expect(clearingLine.Amount).toBe(688.62);

  // Balanced: total debits == total credits == 699.20.
  const creditSum = credits.reduce((s: number, l: any) => s + l.Amount, 0);
  const debitSum = debits.reduce((s: number, l: any) => s + l.Amount, 0);
  expect(debitSum).toBeCloseTo(creditSum, 2);
  expect(debitSum).toBeCloseTo(699.2, 2);

  expect(je.TxnDate).toBe('2026-05-01');
  expect(je.PrivateNote).toContain('2026-05-01');
});

test('fees present but feesAccountRef omitted -> no fee line, clearing = gross (back-compat)', () => {
  const je = journalEntryPayload([{ AccountRef: '400', amount_cents: 69920 }], {
    clearingAccountRef: { value: '900' },
    txnDate: '2026-05-01',
    memo: 'm',
    totalFeeCents: -1058,
  });
  const debits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');
  expect(debits.length).toBe(1);
  expect(debits[0].JournalEntryLineDetail.AccountRef.value).toBe('900');
  expect(debits[0].Amount).toBe(699.2); // full gross, no fee split
});

test('throws when fees exceed gross', () => {
  expect(() =>
    journalEntryPayload([{ AccountRef: '400', amount_cents: 1000 }], {
      clearingAccountRef: { value: '900' },
      txnDate: '2026-05-01',
      memo: 'm',
      feesAccountRef: { value: 'fees' },
      totalFeeCents: -2000,
    }),
  ).toThrow(/Fees .* exceed gross/);
});

test('appends syncId to the memo when provided', () => {
  const je = journalEntryPayload(mapped, {
    clearingAccountRef: { value: '900' },
    txnDate: '2026-05-01',
    memo: 'base memo',
    syncId: 'sync-123',
  });
  expect(je.PrivateNote).toBe('base memo | sync-123');
});
