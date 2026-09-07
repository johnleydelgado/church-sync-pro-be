import { dayKey, groupDonationsByDay, isStripeElectronic } from '../mapping';

// Executable record of the decisions the client confirmed by email.
// If one of these fails, the software has drifted from what they asked for.

const gift = (received_at: string, over: Record<string, unknown> = {}) => ({
  attributes: { payment_method: 'card', fee_cents: -300, payment_status: 'succeeded', received_at, ...over },
});

describe("a day is the donor's local date, in the church's timezone", () => {
  // "I would use the client's local timezone to define the day. That way, if a gift
  //  is made late in the evening, it's recorded on the date the donor actually made
  //  it rather than potentially rolling into the following day."

  test('8pm in New York stays on the 23rd, not the 24th', () => {
    expect(dayKey(gift('2026-08-24T00:00:00Z'), 'America/New_York')).toBe('2026-08-23');
  });

  test('11:30pm in New York stays on the 23rd', () => {
    expect(dayKey(gift('2026-08-24T03:30:00Z'), 'America/New_York')).toBe('2026-08-23');
  });

  test('9pm on the US west coast stays on the 23rd', () => {
    expect(dayKey(gift('2026-08-24T04:00:00Z'), 'America/Los_Angeles')).toBe('2026-08-23');
  });

  test('a daytime gift is unaffected', () => {
    expect(dayKey(gift('2026-08-23T14:00:00Z'), 'America/New_York')).toBe('2026-08-23');
  });

  test('churches ahead of UTC are handled too, not just behind', () => {
    // 7am Manila on the 24th is still 23:00Z on the 23rd.
    expect(dayKey(gift('2026-08-23T23:00:00Z'), 'Asia/Manila')).toBe('2026-08-24');
  });

  test('an evening and a morning gift land on different days, correctly', () => {
    const byDay = groupDonationsByDay(
      [gift('2026-08-24T00:30:00Z'), gift('2026-08-24T14:00:00Z')],
      'America/New_York',
    );
    expect(Object.keys(byDay).sort()).toEqual(['2026-08-23', '2026-08-24']);
  });

  test('falls back to the UTC date rather than dropping a donation', () => {
    expect(dayKey(gift('2026-08-24T00:00:00Z'), null)).toBe('2026-08-24');
    expect(dayKey(gift('2026-08-24T00:00:00Z'), 'Not/AZone')).toBe('2026-08-24');
  });

  test('a malformed timestamp does not throw', () => {
    expect(() => dayKey(gift('not-a-date'), 'America/New_York')).not.toThrow();
  });
});

describe('only completed online giving is posted', () => {
  // "we're only focused on online giving transactions ... processed through Stripe.
  //  We are not concerned with cash gifts, checks, or manually entered donations."

  test('card and bank payments count', () => {
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z'))).toBe(true);
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { payment_method: 'bank_account' }))).toBe(true);
  });

  test('cash and cheques never count', () => {
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { payment_method: 'cash', fee_cents: 0 }))).toBe(false);
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { payment_method: 'check', fee_cents: 0 }))).toBe(false);
  });

  test('a refunded gift never counts', () => {
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { refunded: true }))).toBe(false);
  });

  test('an incomplete payment never counts', () => {
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { payment_status: 'pending' }))).toBe(false);
    expect(isStripeElectronic(gift('2026-08-23T14:00:00Z', { payment_status: 'failed' }))).toBe(false);
  });
});
