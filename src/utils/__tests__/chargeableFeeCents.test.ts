import { chargeableFeeCents, journalEntryPayload } from '../mapping';

// A donor who "covers the fee" is not paying Stripe on the church's behalf - they are making a
// larger gift. Planning Center bumps a $200.00 gift to a $204.70 charge and records the donation
// at the gross $204.70, which is what the donor's statement shows. The church stays the merchant
// of record and incurs the whole $4.70, so the ordinary arithmetic already produces the right
// entry. Excluding covered fees was briefly implemented here and was wrong twice over: it
// overstated the clearing account against a deposit that will only ever be $200.00, and it
// netted a processing fee against contribution revenue, which GAAP does not permit.
const gift = (cents: number, fee: number, covered = false) => ({
  attributes: { amount_cents: cents, fee_cents: fee, fee_covered: covered },
});

describe('chargeableFeeCents', () => {
  test('an ordinary gift charges its fee', () => {
    expect(chargeableFeeCents([gift(10000, -320)])).toBe(-320);
  });

  test('a fee-covered gift charges its fee too - the church still paid Stripe', () => {
    expect(chargeableFeeCents([gift(20470, -470, true)])).toBe(-470);
  });

  test('a mixed day sums every fee', () => {
    expect(chargeableFeeCents([gift(10000, -320), gift(20470, -470, true)])).toBe(-790);
  });

  test('missing or malformed fees do not corrupt the total', () => {
    expect(chargeableFeeCents([gift(10000, -320), { attributes: { amount_cents: 500 } } as any])).toBe(-320);
    expect(chargeableFeeCents([])).toBe(0);
    expect(chargeableFeeCents(null as any)).toBe(0);
  });
});

describe('the entry a fee-covered gift produces', () => {
  const amountFor = (je: any, acct: string) =>
    je.Line.filter((l: any) => l.JournalEntryLineDetail.AccountRef.value === acct).reduce(
      (s: number, l: any) => s + l.Amount,
      0,
    );
  const build = (lines: any[], donations: any[]) =>
    journalEntryPayload(lines, {
      clearingAccountRef: { value: '10' },
      feesAccountRef: { value: '60' },
      totalFeeCents: chargeableFeeCents(donations),
      txnDate: '2026-09-09',
      memo: 'test',
    } as any);

  // PCO's worked example: a $200.00 gift the donor bumps to $204.70. Stripe deposits $200.00.
  test('credits the gross, expenses the fee, and lands the deposit in clearing', () => {
    const je = build([{ AccountRef: '40', amount_cents: 20470, fundName: 'General' }], [gift(20470, -470, true)]);
    expect(amountFor(je, '40')).toBeCloseTo(204.7, 2); // the gift, as the donor's statement shows it
    expect(amountFor(je, '60')).toBeCloseTo(4.7, 2); // what Stripe took
    expect(amountFor(je, '10')).toBeCloseTo(200, 2); // what Stripe deposits
  });

  test('a mixed day still matches the real deposits', () => {
    const donations = [gift(10000, -320), gift(20470, -470, true)];
    const je = build([{ AccountRef: '40', amount_cents: 30470, fundName: 'General' }], donations);
    expect(amountFor(je, '40')).toBeCloseTo(304.7, 2);
    expect(amountFor(je, '60')).toBeCloseTo(7.9, 2);
    // $96.80 from the ordinary gift plus $200.00 from the covered one.
    expect(amountFor(je, '10')).toBeCloseTo(296.8, 2);
  });
});
