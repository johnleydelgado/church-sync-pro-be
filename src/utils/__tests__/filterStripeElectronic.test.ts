import { filterStripeElectronic } from '../mapping';

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
