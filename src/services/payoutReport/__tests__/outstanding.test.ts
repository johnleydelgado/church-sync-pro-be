/**
 * "Still in transit at month-end" - the arithmetic, from plain inputs (synthetic data only).
 * The rule for D: an item in a file paid out on or before D is not in transit; in a file paid out
 * after D, or in no file, it is.
 */
import {
  computeOutstanding,
  coverageOf,
  daysNeedingPlanningCenter,
  GlEntry,
  LedgerDay,
  OutstandingInput,
  PcoGift,
  planningCenterWindows,
  readGeneralLedger,
  resolvePostedGifts,
  StoredPayoutRow,
  UploadRange,
  usd,
} from '../outstanding';

// ---- builders (cents) ----
const upload = (id: number, payoutFrom: string | null, payoutTo: string | null, lastDay: string | null = null): UploadRange => ({
  id,
  payoutFrom,
  payoutTo,
  lastDay,
});
const givingRow = (id: number, day: string, gross: number, fee: number, uploadId: number | null, type = 'Charge'): StoredPayoutRow => ({
  rowKey: `donation:${id}:${type.toLowerCase()}:${day}:${gross}`,
  uploadId,
  day,
  type,
  source: 'Giving',
  name: `Donor ${id}`,
  fundOrSignup: 'General',
  grossCents: gross,
  feeCents: fee,
  netCents: gross - fee,
  status: 'giving_covered',
});
const regRow = (id: number, day: string, gross: number, fee: number, uploadId: number, status = 'posted'): StoredPayoutRow => ({
  rowKey: `registration:${id}:${gross < 0 ? 'refund' : 'charge'}:${day}:${gross}`,
  uploadId,
  day,
  type: gross < 0 ? 'Refund' : 'Charge',
  source: 'Registrations',
  name: `Person ${id}`,
  fundOrSignup: 'Retreat',
  grossCents: gross,
  feeCents: fee,
  netCents: gross - fee,
  status,
});
const gift = (id: number, gross: number, fee: number, completedAt: string | null = null, refunded = false, unmapped = false): PcoGift => ({
  id: String(id),
  grossCents: gross,
  feeCents: fee,
  completedAt,
  refunded,
  fund: unmapped ? 'Building Fund' : 'General',
  unmapped,
});
const ledger = (day: string, gross: number, fee: number, refundedGross = 0, refundedFee = 0): LedgerDay => ({
  day,
  postedGrossCents: gross,
  postedFeeCents: fee,
  refundedGrossCents: refundedGross,
  refundedFeeCents: refundedFee,
});
const base = (o: Partial<OutstandingInput> = {}): OutstandingInput => ({
  month: '2026-10',
  asOf: '2026-10-31',
  startDay: '2026-10-01',
  uploads: [],
  rows: [],
  ledgers: [],
  gifts: new Map(),
  examined: [],
  clearing: null,
  switchOver: null,
  ...o,
});
/** Planning Center read for exactly the days the report needs, as the loader does. */
const withPco = (input: OutstandingInput, byDay: Record<string, PcoGift[]>): OutstandingInput => {
  const days = daysNeedingPlanningCenter(input);
  return {
    ...input,
    gifts: new Map(Object.entries(byDay).filter(([d]) => days.includes(d))),
    examined: planningCenterWindows(days),
  };
};

const OCT = upload(1, '2026-10-01', '2026-10-31');
const NOV = upload(2, '2026-11-01', '2026-11-30');

describe('the rule', () => {
  // Oct 28: three gifts posted. 101 paid out in October, 102 in November, 103 in no file.
  const input = withPco(
    base({
      uploads: [OCT, NOV],
      ledgers: [ledger('2026-10-28', 17000, 564)],
      rows: [givingRow(101, '2026-10-28', 10000, 300, 1), givingRow(102, '2026-10-28', 5000, 175, 2)],
    }),
    { '2026-10-28': [gift(101, 10000, 300), gift(102, 5000, 175), gift(103, 2000, 89)] },
  );
  const r = computeOutstanding(input);

  test('paid by D: out; paid after D: in, with its payouts; in no file: in, "not paid out yet"', () => {
    expect(r.items).toEqual([
      { day: '2026-10-28', kind: 'gift', ref: 'Donation #102', name: 'Donor 102', fundOrEvent: 'General', gross: 50, fee: 1.75, net: 48.25, paidOut: { from: '2026-11-01', to: '2026-11-30' } },
      { day: '2026-10-28', kind: 'gift', ref: 'Donation #103', name: null, fundOrEvent: 'General', gross: 20, fee: 0.89, net: 19.11, paidOut: null },
    ]);
    expect(r.inTransit).toEqual({
      net: 67.36,
      gifts: { count: 2, gross: 70, fee: 2.64, net: 67.36 },
      registrations: { count: 0, gross: 0, fee: 0, net: 0 },
    });
  });

  test('the same items as of Nov 30: the November payouts are paid by then', () => {
    const nov = computeOutstanding(withPco({ ...input, month: '2026-11', asOf: '2026-11-30' }, {
      '2026-10-28': [gift(101, 10000, 300), gift(102, 5000, 175), gift(103, 2000, 89)],
    }));
    expect(nov.items.map((i) => i.ref)).toEqual(['Donation #103']);
  });

  test('a day whose giving is all in files paid out by D is not looked up at all', () => {
    const paidDay = base({
      uploads: [OCT],
      ledgers: [ledger('2026-10-10', 15000, 475), ledger('2026-10-30', 4000, 146)],
      rows: [givingRow(1, '2026-10-10', 10000, 300, 1), givingRow(2, '2026-10-10', 5000, 175, 1)],
    });
    expect(daysNeedingPlanningCenter(paidDay)).toEqual(['2026-10-30']);
  });

  test('pre-go-live days are not CSP\'s and never appear, even if posted', () => {
    const r2 = computeOutstanding(
      withPco(base({ startDay: '2026-10-15', ledgers: [ledger('2026-10-10', 5000, 175), ledger('2026-10-20', 2000, 89)] }), {
        '2026-10-10': [gift(1, 5000, 175)],
        '2026-10-20': [gift(2, 2000, 89)],
      }),
    );
    expect(r2.items.map((i) => i.ref)).toEqual(['Donation #2']);
  });

  test('a month with no uploads: coverage incomplete and every posted item reads "not paid out yet"', () => {
    const r3 = computeOutstanding(
      withPco(base({ ledgers: [ledger('2026-10-05', 5000, 175), ledger('2026-10-06', 2000, 89)] }), {
        '2026-10-05': [gift(1, 5000, 175)],
        '2026-10-06': [gift(2, 2000, 89)],
      }),
    );
    expect(r3.coverage).toEqual({ complete: false, from: '2026-10-01', missing: [{ from: '2026-10-01', to: '2026-10-31' }] });
    expect(r3.items.map((i) => [i.ref, i.paidOut])).toEqual([
      ['Donation #1', null],
      ['Donation #2', null],
    ]);
    expect(r3.inTransit.net).toBe(67.36);
  });
});

describe('overlapping uploads', () => {
  test('an item in several files takes its earliest payout range', () => {
    const early = upload(3, '2026-11-01', '2026-11-15');
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [NOV, early],
          ledgers: [ledger('2026-10-31', 5000, 175)],
          rows: [givingRow(7, '2026-10-31', 5000, 175, 2), { ...givingRow(7, '2026-10-31', 5000, 175, 3), rowKey: 'donation:7:charge:2026-10-31:5000#2' }],
        }),
        { '2026-10-31': [gift(7, 5000, 175)] },
      ),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].paidOut).toEqual({ from: '2026-11-01', to: '2026-11-15' });
  });

  test('overlapping ranges cover their union', () => {
    expect(coverageOf('2026-10-01', '2026-10-31', [upload(1, '2026-10-01', '2026-10-20'), upload(2, '2026-10-10', '2026-10-31')])).toEqual({
      complete: true,
      from: '2026-10-01',
      missing: [],
    });
  });
});

describe('coverage', () => {
  test('gaps are named; ranges outside the period and unknown ranges count for nothing', () => {
    const c = coverageOf('2026-09-15', '2026-10-31', [
      upload(1, '2026-09-01', '2026-09-30'),
      upload(2, null, null, '2026-10-12'), // before the dates were asked for: a gap
      upload(3, '2026-10-15', '2026-10-20'),
      upload(4, '2026-12-01', '2026-12-31'),
    ]);
    expect(c).toEqual({
      complete: false,
      from: '2026-09-15',
      missing: [
        { from: '2026-10-01', to: '2026-10-14' },
        { from: '2026-10-21', to: '2026-10-31' },
      ],
    });
  });

  test('the report carries it, from the sync start date to D', () => {
    const r = computeOutstanding(base({ startDay: '2026-09-15', uploads: [upload(1, '2026-09-01', '2026-09-30')] }));
    expect(r.coverage).toEqual({ complete: false, from: '2026-09-15', missing: [{ from: '2026-10-01', to: '2026-10-31' }] });
  });

  test('an upload with no payout dates: its rows count as paid out by its last charge date', () => {
    const legacy = upload(9, null, null, '2026-10-20');
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [legacy],
          ledgers: [ledger('2026-10-18', 5000, 175), ledger('2026-10-29', 3000, 117)],
          rows: [givingRow(1, '2026-10-18', 5000, 175, 9)],
        }),
        { '2026-10-29': [gift(2, 3000, 117)] },
      ),
    );
    expect(r.items.map((i) => i.ref)).toEqual(['Donation #2']);
  });
});

describe('partial posting', () => {
  test('an exact subset: the latest-completed gifts were not there yet - "not in QuickBooks yet"', () => {
    const r = computeOutstanding(
      withPco(base({ ledgers: [ledger('2026-10-30', 15000, 475)] }), {
        '2026-10-30': [
          gift(1, 10000, 300, '2026-10-30T15:00:00Z'),
          gift(2, 5000, 175, '2026-10-30T16:00:00Z'),
          gift(3, 20000, 30, '2026-11-04T09:00:00Z'), // ACH that settled after the day was posted
        ],
      }),
    );
    expect(r.items.map((i) => i.ref)).toEqual(['Donation #1', 'Donation #2']);
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-30', count: 1, gross: 200, net: 199.7 }]);
  });

  test('no exact subset: one line for the day, never a guess', () => {
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [OCT],
          ledgers: [ledger('2026-10-30', 15000, 475)],
          rows: [givingRow(1, '2026-10-30', 10000, 300, 1)],
        }),
        {
          '2026-10-30': [
            gift(1, 10000, 300, '2026-10-30T15:00:00Z'),
            gift(2, 7000, 200, '2026-10-30T16:00:00Z'), // 100 + 70 > 150, and no gift makes 150
          ],
        },
      ),
    );
    expect(r.items).toEqual([
      { day: '2026-10-30', kind: 'day_unresolved', ref: null, name: null, fundOrEvent: null, gross: 50, fee: 1.75, net: 48.25, paidOut: null },
    ]);
    expect(r.notInQuickBooksYet).toEqual([]);
  });

  test('a failed ACH after posting (Planning Center has less than was posted): an unresolved line, never dropped', () => {
    const r = computeOutstanding(
      withPco(base({ ledgers: [ledger('2026-10-29', 25000, 330)] }), {
        '2026-10-29': [gift(1, 5000, 300)], // the $200 ACH no longer reads succeeded
      }),
    );
    expect(r.items).toEqual([
      { day: '2026-10-29', kind: 'day_unresolved', ref: null, name: null, fundOrEvent: null, gross: 250, fee: 3.3, net: 246.7, paidOut: null },
    ]);
  });

  test('resolvePostedGifts: refunded since posting stays in; refunded before posting never was', () => {
    const a = gift(1, 10000, 300);
    const b = gift(2, 5000, 175, null, true);
    expect(resolvePostedGifts([a, b], 15000)).toEqual({ posted: [a, b], notYet: [] });
    expect(resolvePostedGifts([a, b], 10000)).toEqual({ posted: [a], notYet: [] });
    expect(resolvePostedGifts([a, b], 0)).toEqual({ posted: [], notYet: [a] });
    expect(resolvePostedGifts([a, b], 20000)).toBeNull();
  });

  test('a late ACH on a fully paid-out day is caught when the day is looked up', () => {
    // Posted 100 (paid in October); a $50 ACH settled later and is not posted.
    const input = base({ uploads: [OCT], ledgers: [ledger('2026-10-31', 10000, 300)], rows: [givingRow(1, '2026-10-31', 10000, 300, 1)] });
    expect(daysNeedingPlanningCenter(input)).toEqual([]);
    const r = computeOutstanding(input);
    expect(r.items).toEqual([]);
  });
});

describe('what the engine never posted', () => {
  test('a gift in an unmapped fund was left out whole: never in Clearing, "not in QuickBooks yet", even if paid out', () => {
    // A $100 and B $60 posted; U $40 (unmapped fund) completed first and was paid out in September.
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [OCT],
          ledgers: [ledger('2026-10-30', 16000, 500)],
          rows: [givingRow(1, '2026-10-30', 10000, 300, 1), givingRow(3, '2026-10-30', 4000, 150, 1)],
        }),
        {
          '2026-10-30': [
            gift(3, 4000, 150, '2026-10-30T09:00:00Z', false, true),
            gift(1, 10000, 300, '2026-10-30T10:00:00Z'),
            gift(2, 6000, 200, '2026-10-30T11:00:00Z'),
          ],
        },
      ),
    );
    expect(r.items.map((i) => [i.kind, i.ref, i.net])).toEqual([['gift', 'Donation #2', 58]]);
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-30', count: 1, gross: 40, net: 38.5 }]);
  });

  test('two different sets of gifts would both explain the posted total: one line, not a guess', () => {
    // p1, p2 posted; R refunded before posting; L late ACH. "p1 + R" and "p1 + p2" both make 100.
    const gifts = [
      gift(1, 5000, 100, '2026-10-30T09:00:00Z'),
      gift(2, 5000, 100, '2026-10-30T10:00:00Z'),
      gift(3, 5000, 100, '2026-10-30T08:00:00Z', true),
      gift(4, 5000, 100, '2026-11-03T08:00:00Z'),
    ];
    expect(resolvePostedGifts(gifts, 10000)).toBeNull();
    const r = computeOutstanding(withPco(base({ ledgers: [ledger('2026-10-30', 10000, 200)] }), { '2026-10-30': gifts }));
    expect(r.items.map((i) => [i.kind, i.net])).toEqual([['day_unresolved', 98]]);
  });

  test("an unresolved day never takes off more than was posted (paid gifts CSP didn't post)", () => {
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [OCT],
          ledgers: [ledger('2026-10-30', 10000, 300)],
          rows: [givingRow(1, '2026-10-30', 10000, 300, 1), givingRow(2, '2026-10-30', 7000, 200, 1)],
        }),
        // Planning Center has 1 and 2 (both paid in October) but only 1 was posted - and 2 did not complete last.
        { '2026-10-30': [gift(1, 10000, 300, '2026-10-30T12:00:00Z'), gift(2, 7000, 200, '2026-10-30T09:00:00Z'), gift(5, 3000, 100, '2026-10-30T13:00:00Z')] },
      ),
    );
    expect(r.items).toEqual([]);
  });

  test('a paid refund row CSP never reversed does not make a positive refund line', () => {
    const r = computeOutstanding(
      base({
        uploads: [OCT],
        ledgers: [ledger('2026-10-20', 0, 0, 5000, 0)],
        rows: [givingRow(5, '2026-10-20', -5000, 0, 1, 'Refund'), givingRow(6, '2026-10-20', -2000, 0, 1, 'Refund')],
      }),
    );
    expect(r.items).toEqual([]);
  });
});

describe('days whose giving was not all posted when a file came in', () => {
  test('a giving line the upload found not posted makes the day looked up, even when its net matches', () => {
    // Posted: gift 1 ($50, unpaid). The October file has gift 2 ($50 late ACH, paid, never posted).
    const input = base({
      uploads: [OCT],
      ledgers: [ledger('2026-10-29', 5000, 175)],
      rows: [{ ...givingRow(2, '2026-10-29', 5000, 175, 1), status: 'giving_not_posted' }],
    });
    expect(daysNeedingPlanningCenter(input)).toEqual(['2026-10-29']);
    const r = computeOutstanding(
      withPco(input, { '2026-10-29': [gift(1, 5000, 175, '2026-10-29T10:00:00Z'), gift(2, 5000, 175, '2026-11-02T10:00:00Z')] }),
    );
    expect(r.items.map((i) => i.ref)).toEqual(['Donation #1']);
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-29', count: 1, gross: 50, net: 48.25 }]);
  });

  test('also when the day was not posted at all', () => {
    const input = base({ uploads: [OCT], rows: [{ ...givingRow(2, '2026-10-29', 5000, 175, 1), status: 'giving_not_posted' }] });
    const r = computeOutstanding(withPco(input, { '2026-10-29': [gift(2, 5000, 175)] }));
    expect(r.items).toEqual([]);
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-29', count: 1, gross: 50, net: 48.25 }]);
  });
});

describe('when a row was paid out', () => {
  test('the upload with the earliest payout dates it appeared in, over the one that created it', () => {
    const r = computeOutstanding(
      withPco(
        base({
          uploads: [NOV, OCT],
          ledgers: [ledger('2026-10-30', 5000, 175)],
          rows: [{ ...givingRow(1, '2026-10-30', 5000, 175, 2), payoutUploadId: 1 }],
        }),
        { '2026-10-30': [gift(1, 5000, 175)] },
      ),
    );
    expect(r.items).toEqual([]);
  });
});

describe('refunds', () => {
  test('a refund posted on or before D and taken from a payout after D is a negative line', () => {
    const r = computeOutstanding(
      base({
        uploads: [OCT, NOV],
        ledgers: [ledger('2026-10-29', 0, 0, 5000, 0)],
        rows: [givingRow(5, '2026-10-29', -5000, 0, 2, 'Refund')],
      }),
    );
    expect(r.items).toEqual([
      { day: '2026-10-29', kind: 'gift_refund', ref: 'Donation #5', name: 'Donor 5', fundOrEvent: 'General', gross: -50, fee: 0, net: -50, paidOut: { from: '2026-11-01', to: '2026-11-30' } },
    ]);
    expect(r.inTransit.gifts).toEqual({ count: 0, gross: -50, fee: 0, net: -50 });
  });

  test('a refund already taken from a payout by D is not', () => {
    const r = computeOutstanding(
      base({ uploads: [OCT], ledgers: [ledger('2026-10-20', 0, 0, 5000, 0)], rows: [givingRow(5, '2026-10-20', -5000, 0, 1, 'Refund')] }),
    );
    expect(r.items).toEqual([]);
  });

  test('a refund in no file is one line for the day', () => {
    const r = computeOutstanding(base({ ledgers: [ledger('2026-10-29', 0, 0, 5000, 150)] }));
    expect(r.items).toEqual([
      { day: '2026-10-29', kind: 'gift_refund', ref: null, name: null, fundOrEvent: null, gross: -50, fee: -1.5, net: -48.5, paidOut: null },
    ]);
  });

  test('a refunded gift and its refund both in transit net to the fee', () => {
    const r = computeOutstanding(
      withPco(base({ ledgers: [ledger('2026-10-28', 10000, 300), ledger('2026-10-30', 0, 0, 10000, 0)] }), {
        '2026-10-28': [gift(1, 10000, 300, null, true)],
      }),
    );
    expect(r.items.map((i) => [i.kind, i.net])).toEqual([
      ['gift', 97],
      ['gift_refund', -100],
    ]);
    expect(r.inTransit.net).toBe(-3);
  });
});

describe('registrations', () => {
  test('posted rows in Clearing paid out after D; recorded rows paid by D and rows CSP did not post are not', () => {
    const r = computeOutstanding(
      base({
        uploads: [OCT, NOV],
        rows: [
          regRow(1, '2026-10-30', 6000, 159, 2), // charged Oct 30, paid out in November
          regRow(2, '2026-10-05', 6000, 159, 1), // paid out in October
          regRow(3, '2026-10-30', 3000, 95, 2, 'held'), // not in QuickBooks
          regRow(4, '2026-10-30', 3000, 95, 2, 'resolved'), // posted from the review list
          regRow(5, '2026-10-31', -2500, 0, 2), // refund, taken from a November payout
          regRow(6, '2026-11-02', 6000, 159, 2), // after D
        ],
      }),
    );
    expect(r.items.map((i) => [i.day, i.kind, i.ref, i.net, i.paidOut?.from])).toEqual([
      ['2026-10-30', 'registration', 'Registration #1', 58.41, '2026-11-01'],
      ['2026-10-30', 'registration', 'Registration #4', 29.05, '2026-11-01'],
      ['2026-10-31', 'registration_refund', 'Registration #5', -25, '2026-11-01'],
    ]);
    expect(r.inTransit.registrations).toEqual({ count: 2, gross: 65, fee: 2.54, net: 62.46 });
  });
});

describe('QuickBooks and the difference', () => {
  // In transit on Oct 31: gift 1 ($100, fee $3), posted Oct 30 and in no payout report: $97.00.
  const inTransitDay = (o: Partial<OutstandingInput> = {}) =>
    withPco(base({ ledgers: [ledger('2026-10-30', 10000, 300)], ...o }), { '2026-10-30': [gift(1, 10000, 300)] });
  const entry = (date: string, amountCents: number, type = 'Deposit', docNumber = '', memo = 'memo'): GlEntry => ({
    date,
    type,
    docNumber,
    memo,
    amountCents,
  });
  const clearing = (balanceCents: number | null, entries: GlEntry[] = []) => ({ account: { id: '175', name: 'Clearing' }, balanceCents, entries });
  // October's payout report: giving and registrations, a charge refunded, and a line held for review.
  const OCT_ROWS: StoredPayoutRow[] = [
    givingRow(10, '2026-10-05', 50000, 1500, 1), // net 485.00
    regRow(11, '2026-10-06', 20000, 500, 1), // net 195.00
    regRow(12, '2026-10-07', -2500, 0, 1), // refund -25.00
    { ...givingRow(13, '2026-10-08', -1000, 0, 1, 'Dispute'), status: 'held' }, // -10.00
  ]; // paid out in October: 645.00
  const notesOf = (balanceCents: number, entries: GlEntry[], o: Partial<OutstandingInput> = {}) =>
    computeOutstanding(inTransitDay({ uploads: [OCT], rows: OCT_ROWS, clearing: clearing(balanceCents, entries), ...o }));

  test('tied: no difference, no notes', () => {
    const r = computeOutstanding(inTransitDay({ clearing: clearing(9700) }));
    expect(r.qbo).toEqual({ account: { id: '175', name: 'Clearing' }, balance: 97 });
    expect(r.difference).toBe(0);
    expect(r.differenceNotes).toEqual([]);
  });

  test("QuickBooks can't be read: balance and difference are null and the message is passed on", () => {
    const r = computeOutstanding(inTransitDay({ clearing: { ...clearing(null), message: "QuickBooks didn't answer." } }));
    expect(r.qbo).toEqual({ account: { id: '175', name: 'Clearing' }, balance: null, message: "QuickBooks didn't answer." });
    expect(r.difference).toBeNull();
    expect(r.differenceNotes).toEqual([]);
    expect(r.inTransit.net).toBe(97);
  });

  test('switch-over; deposits summarised in one line against the payout reports; other entries listed', () => {
    const r = notesOf(
      9700 + 50000 + 47500,
      [
        entry('2026-10-08', -40000),
        entry('2026-10-12', -24500),
        entry('2026-10-14', 48000, 'Journal Entry', 'TRUEUP-1', 'Deposit correction'), // memo says Deposit; type decides
        entry('2026-10-20', -500, 'Transfer'),
      ],
      { switchOver: { goLiveDay: '2026-10-01', balanceAtGoLiveCents: 50000, truedUpAt: '2026-10-14T10:00:00.000Z' } },
    );
    expect(r.difference).toBe(975);
    expect(r.differenceNotes).toEqual([
      {
        kind: 'switch_over',
        text: "QuickBooks already held $500.00 in Clearing when CSP took over on Oct 1, 2026. That isn't CSP's money, so it isn't in this list. The switch-over true-up was marked done on Oct 14, 2026.",
        amount: 500,
      },
      {
        kind: 'deposits',
        text: 'Your payout reports show Stripe paid out $645.00 between Oct 1 and Oct 31, 2026. Deposits recorded against Clearing in that time total $645.00.',
        amount: 0,
      },
      {
        kind: 'not_csp',
        text: "These entries in Clearing from Oct 1 to Oct 31, 2026 weren't made by CSP and aren't deposits. Together they add $475.00 to Clearing.",
        amount: 475,
        entries: [
          { date: '2026-10-14', type: 'Journal Entry', amount: 480, memo: 'Deposit correction', docNumber: 'TRUEUP-1' },
          { date: '2026-10-20', type: 'Transfer', amount: -5, memo: 'memo', docNumber: '' },
        ],
      },
    ]);
  });

  test('a payout not recorded as a deposit: positive, like the difference it explains', () => {
    const r = notesOf(9700 + 4500, [entry('2026-10-08', -40000), entry('2026-10-12', -20000)]);
    expect(r.difference).toBe(45);
    expect(r.differenceNotes).toEqual([
      {
        kind: 'deposits',
        text:
          'Your payout reports show Stripe paid out $645.00 between Oct 1 and Oct 31, 2026. Deposits recorded against Clearing in that time total $600.00. ' +
          "They're $45.00 apart: a payout not recorded as a deposit yet, or recorded for a different amount.",
        amount: 45,
      },
    ]);
  });

  test('more deposited than paid out: negative', () => {
    const r = notesOf(9700 - 100, [entry('2026-10-08', -64600)]);
    expect(r.difference).toBe(-1);
    expect(r.differenceNotes).toEqual([expect.objectContaining({ kind: 'deposits', amount: -1, text: expect.stringContaining("They're $1.00 apart:") })]);
  });

  test('a cent apart is apart; to the cent is not', () => {
    const cent = notesOf(9700 - 1, [entry('2026-10-08', -64501)]);
    expect(cent.differenceNotes).toEqual([expect.objectContaining({ kind: 'deposits', amount: -0.01, text: expect.stringContaining("They're $0.01 apart:") })]);
    const exact = notesOf(9700 + 7, [entry('2026-10-08', -64500), entry('2026-10-09', 7, 'Journal Entry')]);
    expect(exact.differenceNotes.find((n) => n.kind === 'deposits')).toEqual(
      expect.objectContaining({ amount: 0, text: expect.not.stringContaining('apart') }),
    );
  });

  test('payout reports missing for part of the period: the payout total says it is incomplete, and until when', () => {
    const r = notesOf(9700 + 2000, [entry('2026-10-08', -62500)], { uploads: [upload(1, '2026-10-01', '2026-10-20')] });
    expect(r.differenceNotes).toEqual([
      {
        kind: 'deposits',
        text:
          'Your payout reports show Stripe paid out $645.00 between Oct 1 and Oct 31, 2026. Deposits recorded against Clearing in that time total $625.00. ' +
          "They're $20.00 apart, but the payout total is incomplete until the payout reports for Oct 21 to Oct 31 are uploaded.",
        amount: 20,
      },
    ]);
    const tied = notesOf(9700, [entry('2026-10-08', -64500)], { uploads: [upload(1, '2026-10-01', '2026-10-20')] });
    expect(tied.difference).toBe(0); // no notes when there is nothing to explain
    const even = notesOf(9700 + 3, [entry('2026-10-08', -64500), entry('2026-10-09', 3, 'Journal Entry')], {
      uploads: [upload(1, '2026-10-01', '2026-10-20')],
    });
    expect(even.differenceNotes[0].text).toBe(
      'Your payout reports show Stripe paid out $645.00 between Oct 1 and Oct 31, 2026. Deposits recorded against Clearing in that time total $645.00. ' +
        'The payout total is incomplete until the payout reports for Oct 21 to Oct 31 are uploaded.',
    );
  });

  test('no payout reports at all: the deposits are named, and why they cannot be checked', () => {
    const r = computeOutstanding(inTransitDay({ clearing: clearing(9700 - 64500, [entry('2026-10-08', -64500)]) }));
    expect(r.differenceNotes).toEqual([
      {
        kind: 'deposits',
        text: "No payout reports for Oct 1 to Oct 31 have been uploaded yet, so the $645.00 of deposits recorded against Clearing in that time can't be checked against what Stripe paid out.",
        amount: -645,
      },
    ]);
  });

  test('a report whose payouts start before the sync start date is not counted: CSP cannot split it', () => {
    const r = computeOutstanding(
      inTransitDay({
        startDay: '2026-09-15',
        uploads: [upload(9, '2026-09-01', '2026-09-30'), OCT],
        rows: [givingRow(20, '2026-09-20', 30000, 900, 9), ...OCT_ROWS],
        clearing: clearing(9700 - 29100, [entry('2026-09-22', -29100), entry('2026-10-08', -64500)]),
      }),
    );
    expect(r.differenceNotes).toEqual([
      {
        kind: 'deposits',
        text:
          'Your payout reports show Stripe paid out $645.00 between Sep 15 and Oct 31, 2026. Deposits recorded against Clearing in that time total $936.00. ' +
          "They're $291.00 apart, but the payout total is incomplete until the payout reports for Sep 15 to Sep 30 are uploaded.",
        amount: -291,
      },
    ]);
  });

  test('nothing to compare and no other entries: no deposits note and no entries note', () => {
    const r = computeOutstanding(inTransitDay({ clearing: clearing(9800) }));
    expect(r.difference).toBe(1);
    expect(r.differenceNotes).toEqual([]);
  });

  test('a payout report with no rows in it and no deposits is nothing to compare', () => {
    const r = computeOutstanding(inTransitDay({ uploads: [OCT], clearing: clearing(9800, [entry('2026-10-09', 100, 'Journal Entry', 'JE9')]) }));
    expect(r.differenceNotes.map((n) => [n.kind, n.amount])).toEqual([['not_csp', 1]]);
  });

  test('entries that take money out of Clearing say so', () => {
    const r = notesOf(9700 - 250, [entry('2026-10-08', -64500), entry('2026-10-19', -250, 'Transfer')]);
    expect(r.differenceNotes.find((n) => n.kind === 'not_csp')?.text).toBe(
      "These entries in Clearing from Oct 1 to Oct 31, 2026 weren't made by CSP and aren't deposits. Together they take $2.50 out of Clearing.",
    );
  });

  test('a switch-over after D, or with no captured balance, is not a note', () => {
    const r = notesOf(9700 + 100, [entry('2026-10-08', -64500), entry('2026-10-09', 100, 'Journal Entry')], {
      switchOver: { goLiveDay: '2026-10-01', balanceAtGoLiveCents: null, truedUpAt: null },
    });
    expect(r.differenceNotes.map((n) => n.kind)).toEqual(['deposits', 'not_csp']);
  });
});

describe('placing a row in its payout reports', () => {
  test('of two reports ending the same day, the narrower one', () => {
    const r = computeOutstanding(
      withPco(
        base({
          startDay: '2026-09-01',
          month: '2026-09',
          asOf: '2026-09-14',
          uploads: [upload(1, '2026-09-01', '2026-09-30'), upload(2, '2026-09-15', '2026-09-30')],
          ledgers: [ledger('2026-09-10', 5000, 175)],
          rows: [givingRow(1, '2026-09-10', 5000, 175, 1), { ...givingRow(1, '2026-09-10', 5000, 175, 2), rowKey: 'donation:1:charge:2026-09-10:5000#2' }],
        }),
        { '2026-09-10': [gift(1, 5000, 175)] },
      ),
    );
    expect(r.items.map((i) => i.paidOut)).toEqual([{ from: '2026-09-15', to: '2026-09-30' }]);
  });
});

describe('nothing to report', () => {
  test('a month before the sync start date is an empty report that says so', () => {
    const r = computeOutstanding(base({ month: '2026-08', asOf: '2026-08-31', startDay: '2026-09-15', ledgers: [ledger('2026-08-20', 5000, 175)] }));
    expect(r).toMatchObject({
      month: '2026-08',
      asOf: '2026-08-31',
      message: "CSP's sync starts on Sep 15, 2026, after Aug 31, 2026, so nothing of CSP's was in Clearing then.",
      items: [],
      difference: null,
      inTransit: { net: 0 },
    });
  });

  test('no sync start date and nothing posted', () => {
    expect(computeOutstanding(base({ startDay: null })).message).toBe("CSP hasn't posted anything to Clearing yet, so nothing is in transit.");
  });
});

describe('Planning Center reads', () => {
  test('days close together share one read; far apart or too long, separate', () => {
    expect(planningCenterWindows(['2026-10-31', '2026-10-27', '2026-10-28', '2026-09-20'])).toEqual([
      { from: '2026-09-20', to: '2026-09-20' },
      { from: '2026-10-27', to: '2026-10-31' },
    ]);
    expect(planningCenterWindows(['2026-01-01', '2026-01-05', '2026-01-09'], 7, 5)).toEqual([
      { from: '2026-01-01', to: '2026-01-05' },
      { from: '2026-01-09', to: '2026-01-09' },
    ]);
  });

  test('a needed day Planning Center was not read for is one unresolved line, not silence', () => {
    const r = computeOutstanding(base({ ledgers: [ledger('2026-10-30', 10000, 300)] }));
    expect(r.items.map((i) => [i.kind, i.net])).toEqual([['day_unresolved', 97]]);
  });

  test('a whole day not posted, inside a window read anyway, is "not in QuickBooks yet"', () => {
    const input = base({ ledgers: [ledger('2026-10-27', 10000, 300), ledger('2026-10-31', 2000, 89)] });
    const r = computeOutstanding({
      ...input,
      gifts: new Map([
        ['2026-10-27', [gift(1, 10000, 300)]],
        ['2026-10-29', [gift(2, 4000, 146)]],
        ['2026-10-31', [gift(3, 2000, 89)]],
      ]),
      examined: planningCenterWindows(daysNeedingPlanningCenter(input)),
    });
    expect(r.notInQuickBooksYet).toEqual([{ day: '2026-10-29', count: 1, gross: 40, net: 38.54 }]);
    expect(r.items.map((i) => i.ref)).toEqual(['Donation #1', 'Donation #3']);
  });
});

describe('readGeneralLedger', () => {
  const account = { Id: '175', Name: 'Clearing Account', AcctNum: '175000' };
  const columns = {
    Column: [
      { ColTitle: 'Date', ColType: 'Date', MetaData: [{ Name: 'ColKey', Value: 'tx_date' }] },
      { ColTitle: 'Transaction Type', ColType: 'String', MetaData: [{ Name: 'ColKey', Value: 'txn_type' }] },
      { ColTitle: 'Num', ColType: 'String', MetaData: [{ Name: 'ColKey', Value: 'doc_num' }] },
      { ColTitle: 'Memo/Description', ColType: 'String', MetaData: [{ Name: 'ColKey', Value: 'memo' }] },
      { ColTitle: 'Amount', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'subt_nat_amount' }] },
    ],
  };
  const row = (date: string, type: string, num: string, memo: string, amount: string) => ({
    type: 'Data',
    ColData: [{ value: date }, { value: type }, { value: num }, { value: memo }, { value: amount }],
  });
  const section = (header: any, rows: any[]) => ({ type: 'Section', Header: { ColData: [header, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [] } });

  test('reads the rows of the section that names the account, skipping the beginning balance', () => {
    const report = {
      Columns: columns,
      Rows: {
        Row: [
          section({ value: '175000 Clearing Account' }, [
            { type: 'Data', ColData: [{ value: 'Beginning Balance' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }] },
            row('2026-10-01', 'Journal Entry', 'CSP-2026-10-01-1', 'Church Sync Pro', '904.45'),
            row('2026-10-03', 'Deposit', '', 'Stripe payout', '-1,250.00'),
          ]),
        ],
      },
    };
    expect(readGeneralLedger(report, account)).toEqual({
      rows: [
        { date: '2026-10-01', type: 'Journal Entry', docNumber: 'CSP-2026-10-01-1', memo: 'Church Sync Pro', amountCents: 90445 },
        { date: '2026-10-03', type: 'Deposit', docNumber: '', memo: 'Stripe payout', amountCents: -125000 },
      ],
      withSubAccounts: false,
    });
  });

  test('another account only (the filter did not apply): refused', () => {
    const report = { Columns: columns, Rows: { Row: [section({ value: '10000 Checking' }, [row('2026-10-01', 'Deposit', '', '', '5.00')])] } };
    expect(readGeneralLedger(report, account)).toBe('wrong_account');
  });

  test('the whole company: only the Clearing section is read', () => {
    const report = {
      Columns: columns,
      Rows: {
        Row: [
          section({ value: '10000 Checking' }, [row('2026-10-01', 'Deposit', '', '', '5.00')]),
          section({ value: 'Something else', id: '175' }, [row('2026-10-02', 'Journal Entry', 'CSP-2026-10-02-1', '', '1.00')]),
        ],
      },
    };
    expect(readGeneralLedger(report, account)).toMatchObject({ rows: [{ date: '2026-10-02', amountCents: 100 }] });
  });

  test('no sections at all: no activity in the range', () => {
    expect(readGeneralLedger({ Columns: columns, Rows: {} }, account)).toEqual({ rows: [], withSubAccounts: false });
  });

  test('an amount that is not a number: unreadable, never zero', () => {
    const report = { Columns: columns, Rows: { Row: [section({ value: '175000 Clearing Account' }, [row('2026-10-01', 'Deposit', '', '', 'n/a')])] } };
    expect(readGeneralLedger(report, account)).toBe('unreadable');
  });

  test('a dated row whose date is not where the columns say: unreadable', () => {
    const shifted = { type: 'Data', ColData: [{ value: 'Deposit' }, { value: '2026-10-01' }, { value: '' }, { value: '' }, { value: '5.00' }] };
    const report = { Columns: columns, Rows: { Row: [section({ value: '175000 Clearing Account' }, [shifted])] } };
    expect(readGeneralLedger(report, account)).toBe('unreadable');
  });

  test('columns by position when the report does not label them', () => {
    const report = { Columns: { Column: [] }, Rows: { Row: [section({ value: 'Clearing Account' }, [row('2026-10-01', 'Deposit', 'D1', 'm', '2.50')])] } };
    expect(readGeneralLedger(report, account)).toEqual({
      rows: [{ date: '2026-10-01', type: 'Deposit', docNumber: 'D1', memo: 'm', amountCents: 250 }],
      withSubAccounts: false,
    });
  });
});

test('usd', () => {
  expect(usd(123456789)).toBe('$1,234,567.89');
  expect(usd(-5)).toBe('-$0.05');
  expect(usd(0)).toBe('$0.00');
});
