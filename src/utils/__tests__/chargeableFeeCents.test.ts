import { chargeableFeeCents, journalEntryPayload } from '../mapping';

// When a donor ticks "cover the processing fee", they are charged the gift plus the fee.
// Stripe still takes its cut, but it comes out of the donor's extra - the church receives the
// whole gift and never pays the fee. Planning Center marks that `fee_covered: true` while
// leaving `fee_cents` populated, so summing fees blindly books an expense the church did not
// incur and leaves the clearing account short of what Stripe actually deposits.
const gift = (cents: number, fee: number, covered = false) => ({
  attributes: { amount_cents: cents, fee_cents: fee, fee_covered: covered },
});

describe('chargeableFeeCents', () => {
  test('an ordinary gift charges its fee to the church', () => {
    expect(chargeableFeeCents([gift(10000, -320)])).toBe(-320);
  });

  test('a fee-covered gift charges nothing', () => {
    expect(chargeableFeeCents([gift(10000, -320, true)])).toBe(0);
  });

  test('a mixed day charges only the fees the church paid', () => {
    expect(chargeableFeeCents([gift(10000, -320), gift(10000, -320, true)])).toBe(-320);
  });

  test('missing or malformed fees do not corrupt the total', () => {
    expect(chargeableFeeCents([gift(10000, -320), { attributes: { amount_cents: 500 } } as any])).toBe(-320);
    expect(chargeableFeeCents([])).toBe(0);
    expect(chargeableFeeCents(null as any)).toBe(0);
  });
});

describe('the entry a fee-covered gift produces', () => {
  const lines = [{ AccountRef: '40', amount_cents: 10000, fundName: 'General' }];

  test('clearing equals the whole gift, and no fee is expensed', () => {
    const fee = chargeableFeeCents([gift(10000, -320, true)]);
    const je = journalEntryPayload(lines, {
      clearingAccountRef: { value: '10' },
      feesAccountRef: { value: '60' },
      totalFeeCents: fee,
      txnDate: '2026-09-09',
      memo: 'test',
    } as any);
    const amountFor = (acct: string) =>
      je.Line.filter((l: any) => l.JournalEntryLineDetail.AccountRef.value === acct).reduce(
        (s: number, l: any) => s + l.Amount,
        0,
      );
    // Stripe deposits the full $100 because the donor paid the $3.20 on top.
    expect(amountFor('40')).toBeCloseTo(100, 2);
    expect(amountFor('10')).toBeCloseTo(100, 2);
    expect(amountFor('60')).toBeCloseTo(0, 2);
  });

  test('a mixed day still balances, with clearing matching the real deposit', () => {
    const donations = [gift(10000, -320), gift(10000, -320, true)];
    const je = journalEntryPayload([{ AccountRef: '40', amount_cents: 20000, fundName: 'General' }], {
      clearingAccountRef: { value: '10' },
      feesAccountRef: { value: '60' },
      totalFeeCents: chargeableFeeCents(donations),
      txnDate: '2026-09-09',
      memo: 'test',
    } as any);
    const amountFor = (acct: string) =>
      je.Line.filter((l: any) => l.JournalEntryLineDetail.AccountRef.value === acct).reduce(
        (s: number, l: any) => s + l.Amount,
        0,
      );
    expect(amountFor('40')).toBeCloseTo(200, 2); // both gifts, in full
    expect(amountFor('60')).toBeCloseTo(3.2, 2); // only the uncovered fee
    expect(amountFor('10')).toBeCloseTo(196.8, 2); // $96.80 + $100.00, what Stripe deposits
  });
});
