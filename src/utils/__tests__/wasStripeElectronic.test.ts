import { isStripeElectronic, wasStripeElectronic } from '../mapping';

// The refund pass reverses a donation by debiting revenue and crediting the Stripe clearing
// account. That is only correct for money a journal entry actually put there. Selecting on
// `refunded === true` alone reversed refunded cash and cheque gifts too, driving the clearing
// account negative against a Stripe payout that never contained them. In the live test
// organisation every cash and cheque donation is refundable and the one card donation is not,
// so this was the common case rather than an edge case.
const d = (over: Record<string, unknown>) => ({
  attributes: { payment_method: 'card', payment_status: 'succeeded', fee_cents: -320, refunded: false, ...over },
});

describe('wasStripeElectronic', () => {
  test('a refunded card gift is reversible - the engine posted it', () => {
    expect(wasStripeElectronic(d({ refunded: true }))).toBe(true);
    expect(isStripeElectronic(d({ refunded: true }))).toBe(false);
  });

  test('a refunded ACH gift is reversible', () => {
    expect(wasStripeElectronic(d({ payment_method: 'ach', refunded: true }))).toBe(true);
  });

  test('a refunded cash gift is NOT - no entry ever recorded it', () => {
    expect(wasStripeElectronic(d({ payment_method: 'cash', fee_cents: 0, refunded: true }))).toBe(false);
  });

  test('a refunded cheque gift is NOT', () => {
    expect(wasStripeElectronic(d({ payment_method: 'check', fee_cents: 0, refunded: true }))).toBe(false);
  });

  test('a refunded card gift with no fee is NOT - it never met the giving test either', () => {
    expect(wasStripeElectronic(d({ fee_cents: 0, refunded: true }))).toBe(false);
  });

  test('the two agree on everything except the refund flag', () => {
    const live = d({});
    expect(isStripeElectronic(live)).toBe(true);
    expect(wasStripeElectronic(live)).toBe(true);
    const pending = d({ payment_status: 'pending' });
    expect(isStripeElectronic(pending)).toBe(false);
    expect(wasStripeElectronic(pending)).toBe(false);
  });
});
