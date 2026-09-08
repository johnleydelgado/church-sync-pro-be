import { isStripeElectronic, filterStripeElectronic } from '../mapping';

// These are verbatim records from the Planning Center Giving API, pulled from the
// live organisation on 2026-09-08. They exist to pin the *shape* PCO actually
// returns: an assumed `payment_method` value ('bank_account') once silently
// excluded every ACH gift, and nothing in the test suite caught it because every
// fixture was written from the same assumption.

const realCardDonation = {
  id: '171986861',
  attributes: {
    amount_cents: 100,
    amount_currency: 'USD',
    completed_at: '2023-04-11T23:10:01Z',
    created_at: '2023-04-11T23:10:01Z',
    fee_cents: -32,
    fee_covered: false,
    fee_currency: 'USD',
    memo: null,
    payment_brand: 'Visa',
    payment_channel: 'admin',
    payment_check_dated_at: null,
    payment_check_number: null,
    payment_last4: '9625',
    payment_method: 'card',
    payment_method_sub: 'credit',
    payment_status: 'succeeded',
    received_at: '2023-04-11T23:09:59Z',
    refundable: false,
    refunded: false,
    updated_at: '2023-04-18T00:35:39Z',
  },
};

const realCashDonation = {
  id: '171048983',
  attributes: {
    amount_cents: 2000,
    fee_cents: 0,
    payment_method: 'cash',
    payment_status: 'succeeded',
    received_at: '2023-04-04T13:44:54Z',
    refunded: false,
  },
};

const realCheckDonation = {
  id: '171679248',
  attributes: {
    amount_cents: 40000,
    fee_cents: 0,
    payment_method: 'check',
    payment_status: 'succeeded',
    received_at: '2023-04-10T07:00:00Z',
    refunded: false,
  },
};

describe('records as Planning Center really returns them', () => {
  test('the Stripe-processed card gift is recognised', () => {
    expect(isStripeElectronic(realCardDonation)).toBe(true);
  });

  test('cash and cheque are not', () => {
    expect(isStripeElectronic(realCashDonation)).toBe(false);
    expect(isStripeElectronic(realCheckDonation)).toBe(false);
  });

  test('the whole organisation reduces to the one Stripe gift', () => {
    const kept = filterStripeElectronic([realCashDonation, realCheckDonation, realCardDonation]);
    expect(kept.map((d: any) => d.id)).toEqual(['171986861']);
  });

  // The payment source is named "Planning Center", never "Stripe" — the STRIPE tag in
  // the Giving UI is not this field. A non-zero fee is what marks Stripe's involvement.
  test('a card gift with no fee is not treated as Stripe money', () => {
    const noFee = { attributes: { ...realCardDonation.attributes, fee_cents: 0 } };
    expect(isStripeElectronic(noFee)).toBe(false);
  });
});
