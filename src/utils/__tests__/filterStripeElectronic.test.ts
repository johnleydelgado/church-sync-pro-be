import { filterStripeElectronic, isStripeElectronic } from '../mapping';

const donation = (over: any = {}) => ({
  attributes: { payment_method: 'card', fee_cents: -30, amount_cents: 5000, ...over },
});

test('keeps card donations processed by Stripe (has fee)', () => {
  expect(filterStripeElectronic([donation()]).length).toBe(1);
});
test('keeps ACH/bank_account via Stripe', () => {
  expect(filterStripeElectronic([donation({ payment_method: 'bank_account' })]).length).toBe(1);
});
test('excludes cash and check', () => {
  expect(
    filterStripeElectronic([
      donation({ payment_method: 'cash', fee_cents: 0 }),
      donation({ payment_method: 'check', fee_cents: 0 }),
    ]).length,
  ).toBe(0);
});
test('excludes manually entered card with no Stripe fee or source', () => {
  expect(filterStripeElectronic([donation({ payment_method: 'card', fee_cents: 0 })]).length).toBe(0);
});
test('keeps card when a stripe payment_source is present even without fee', () => {
  const d: any = donation({ fee_cents: 0 });
  d.payment_source = { attributes: { name: 'Stripe' } };
  expect(filterStripeElectronic([d]).length).toBe(1);
});
test('keeps donations whose fee_cents arrives as a string (PCO quirk)', () => {
  expect(filterStripeElectronic([donation({ fee_cents: '-30' })]).length).toBe(1);
});
test('excludes refunded card donations even when they have a Stripe fee', () => {
  expect(filterStripeElectronic([donation({ refunded: true })]).length).toBe(0);
});
test('returns empty array for empty input without throwing', () => {
  expect(filterStripeElectronic([])).toEqual([]);
});

// Only completed giving belongs in a journal entry. A pending card payment that is
// booked as income inflates revenue and adds to a clearing balance that can never
// clear, because the money never arrives.
describe('payment completion', () => {
  const card = (extra: Record<string, unknown>) => ({
    attributes: { payment_method: 'card', fee_cents: -300, ...extra },
  });

  test('excludes a pending donation', () => {
    expect(isStripeElectronic(card({ payment_status: 'pending' }))).toBe(false);
  });

  test('excludes a failed donation', () => {
    expect(isStripeElectronic(card({ payment_status: 'failed' }))).toBe(false);
  });

  test('includes a succeeded donation', () => {
    expect(isStripeElectronic(card({ payment_status: 'succeeded' }))).toBe(true);
  });

  test('status match is case-insensitive', () => {
    expect(isStripeElectronic(card({ payment_status: 'SUCCEEDED' }))).toBe(true);
  });

  test('treats a missing payment_status as complete rather than dropping real income', () => {
    expect(isStripeElectronic(card({}))).toBe(true);
    expect(isStripeElectronic(card({ payment_status: null }))).toBe(true);
    expect(isStripeElectronic(card({ payment_status: '' }))).toBe(true);
  });

  test('completion does not override the other exclusions', () => {
    expect(isStripeElectronic(card({ payment_status: 'succeeded', refunded: true }))).toBe(false);
    expect(
      isStripeElectronic({ attributes: { payment_method: 'cash', payment_status: 'succeeded', fee_cents: -300 } }),
    ).toBe(false);
  });
});

// Regression: a cash gift to the SAME fund as a card gift used to be folded into it.
// syncEngine sums duplicate designations per fund, and that summing ran before this
// filter, so the combined amount passed as online giving. Caught against real Planning
// Center data: a $250.00 cash gift inflated a $199.20 card entry to $449.20.
// The engine now filters first; these assertions pin the filter's half of that contract.
describe('mixed payment methods in one batch', () => {
  const donation = (method: string, cents: number, fee: number) => ({
    attributes: { payment_method: method, amount_cents: cents, fee_cents: fee, payment_status: 'succeeded' },
  });

  test('keeps only the electronic donations when methods are mixed', () => {
    const batch = [
      donation('card', 50000, -758),
      donation('cash', 25000, 0),
      donation('bank_account', 19920, -300),
      donation('check', 9900, 0),
    ];
    const kept = filterStripeElectronic(batch);
    expect(kept).toHaveLength(2);
    expect(kept.map((d: any) => d.attributes.amount_cents).sort((a, b) => a - b)).toEqual([19920, 50000]);
  });

  test('a zero-fee cash gift never qualifies, whatever fund it targets', () => {
    expect(isStripeElectronic(donation('cash', 25000, 0))).toBe(false);
    expect(isStripeElectronic(donation('check', 25000, 0))).toBe(false);
  });
});

// Regression: the method list said 'bank_account', which Planning Center never emits.
// Verified against the live Giving API on 2026-09-08: payment_method is one of
// 'cash', 'check', 'card', 'ach'. Every ACH gift was therefore dropped in silence —
// on a real church's giving that is a large share of the money (recurring bank
// transfers), so the day's entry would have been short by all of it.
describe('ACH donations, the value Planning Center actually returns', () => {
  const ach = (over: Record<string, unknown> = {}) => ({
    attributes: {
      payment_method: 'ach',
      amount_cents: 35000,
      fee_cents: -87,
      payment_status: 'succeeded',
      ...over,
    },
  });

  test('a settled ACH gift is online giving', () => {
    expect(isStripeElectronic(ach())).toBe(true);
  });

  test('an ACH gift still in transit is left for a later run', () => {
    expect(isStripeElectronic(ach({ payment_status: 'pending', fee_cents: 0 }))).toBe(false);
  });

  test('a refunded ACH gift is not posted as giving', () => {
    expect(isStripeElectronic(ach({ refunded: true }))).toBe(false);
  });

  test('ACH and card are both kept when a batch mixes them with cash', () => {
    const kept = filterStripeElectronic([
      ach(),
      { attributes: { payment_method: 'card', amount_cents: 19920, fee_cents: -300, payment_status: 'succeeded' } },
      { attributes: { payment_method: 'cash', amount_cents: 25000, fee_cents: 0, payment_status: 'succeeded' } },
    ]);
    expect(kept.map((d: any) => d.attributes.amount_cents).sort((a, b) => a - b)).toEqual([19920, 35000]);
  });
});
