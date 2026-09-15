import { stripeGivingDayDetail } from '../mapping';

// Shaped like the sweep's own payload: donations carry designation refs, and `included[]`
// side-loads the Designation and Fund resources those refs point at.
const donation = (id: string, cents: number, fee: number, over: any = {}, designationIds: string[] = [`${id}-d`]) => ({
  type: 'Donation',
  id,
  attributes: {
    amount_cents: cents,
    fee_cents: fee,
    payment_method: 'card',
    payment_method_sub: 'credit',
    payment_status: 'succeeded',
    fee_covered: false,
    refunded: false,
    received_at: '2026-09-08T14:02:11Z',
    completed_at: '2026-09-08T14:02:13Z',
    ...over,
  },
  relationships: { designations: { data: designationIds.map((did) => ({ type: 'Designation', id: did })) } },
});

const fund = (id: string, name: string) => ({ type: 'Fund', id, attributes: { name } });

const designation = (id: string, cents: number, fundId?: string) => ({
  type: 'Designation',
  id,
  attributes: { amount_cents: cents },
  ...(fundId ? { relationships: { fund: { data: { type: 'Fund', id: fundId } } } } : {}),
});

describe('stripeGivingDayDetail', () => {
  // The brief excludes cash, cheques and hand-entered gifts: they never reach the clearing
  // account, so listing them under a day's Stripe giving invites a church to reconcile money
  // Stripe will never deposit.
  test('cash and cheque never appear', () => {
    const detail = stripeGivingDayDetail(
      [
        donation('1', 10000, -320),
        donation('2', 2000, 0, { payment_method: 'cash' }),
        donation('3', 40000, 0, { payment_method: 'check' }),
      ],
      [fund('901', 'General'), designation('1-d', 10000, '901')],
    );
    expect(detail.donations.map((d) => d.id)).toEqual(['1']);
    expect(detail.totals).toEqual({ gross: 100, fees: 3.2, net: 96.8, count: 1 });
  });

  // PCO reports fee_cents negative. A table showing "-3.20" under a Fees column reads as a
  // refund of the fee; the row has to state the cost.
  test('the fee arrives positive and the row still nets out', () => {
    const [row] = stripeGivingDayDetail([donation('1', 10000, -320)], []).donations;
    expect(row.fee).toBe(3.2);
    expect(row.gross).toBe(100);
    expect(row.net).toBe(96.8);
  });

  // A donor covering the fee made a larger gift; the church still paid Stripe, so the fee is
  // charged exactly as it is on any other gift. See the docblock on chargeableFeeCents.
  test('a fee-covered gift is charged its fee like any other', () => {
    const [row] = stripeGivingDayDetail(
      [donation('1', 20470, -470, { fee_covered: true })],
      [],
    ).donations;
    expect(row.feeCovered).toBe(true);
    expect(row.fee).toBe(4.7);
    expect(row.net).toBe(200);
  });

  test('a split gift lists each designation in dollars', () => {
    const [row] = stripeGivingDayDetail(
      [donation('1', 10000, -320, {}, ['1-a', '1-b'])],
      [
        fund('901', 'General'),
        fund('902', 'Missions'),
        designation('1-a', 6000, '901'),
        designation('1-b', 4000, '902'),
      ],
    ).donations;
    expect(row.designations).toEqual([
      { fundName: 'General', amount: 60 },
      { fundName: 'Missions', amount: 40 },
    ]);
    expect(row.designations.reduce((s, d) => s + d.amount, 0)).toBe(row.gross);
  });

  // PCO does not always honour the nested include. Dropping the breakdown entirely would show a
  // $100 gift whose designations add up to nothing.
  test('an unresolvable fund falls back to a named line at the full amount', () => {
    const noInclude = stripeGivingDayDetail([donation('1', 7500, -250)], []).donations[0];
    expect(noInclude.designations).toEqual([{ fundName: 'Unknown fund', amount: 75 }]);

    const noFund = stripeGivingDayDetail([donation('1', 7500, -250)], [designation('1-d', 7500)]).donations[0];
    expect(noFund.designations).toEqual([{ fundName: 'Unknown fund', amount: 75 }]);
  });

  test('carries the fields that say how a gift was paid', () => {
    const [row] = stripeGivingDayDetail([donation('171986861', 100, -32, { payment_method_sub: null })], []).donations;
    expect(row).toMatchObject({
      id: '171986861',
      receivedAt: '2026-09-08T14:02:11Z',
      completedAt: '2026-09-08T14:02:13Z',
      paymentMethod: 'card',
      paymentMethodSub: null,
      paymentStatus: 'succeeded',
    });
  });

  test('an ACH gift still settling has no completed_at and reports null', () => {
    const [row] = stripeGivingDayDetail(
      [donation('1', 5000, -30, { payment_method: 'ach', completed_at: null })],
      [],
    ).donations;
    expect(row.completedAt).toBeNull();
    expect(row.paymentMethod).toBe('ach');
  });

  // Rounded dollars added together drift; the day total has to match the entry that gets posted.
  test('totals are summed in cents, not in rounded dollars', () => {
    const detail = stripeGivingDayDetail(
      [donation('1', 333, -11), donation('2', 333, -11), donation('3', 333, -11)],
      [],
    );
    expect(detail.totals).toEqual({ gross: 9.99, fees: 0.33, net: 9.66, count: 3 });
  });

  test('a day with no giving returns empty rows and zero totals', () => {
    expect(stripeGivingDayDetail([], [])).toEqual({
      donations: [],
      totals: { gross: 0, fees: 0, net: 0, count: 0 },
    });
  });
});
