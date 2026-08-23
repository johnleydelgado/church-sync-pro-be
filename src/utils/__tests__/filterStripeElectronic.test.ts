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
