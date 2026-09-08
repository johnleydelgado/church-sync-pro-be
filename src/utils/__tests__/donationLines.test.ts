import { donationLines, journalEntryPayload } from '../mapping';

const SETTINGS = [
  { fundName: 'General', account: { value: '10', label: 'Tithes & Offerings' }, class: { value: 'C1', label: 'Main' }, customer: { value: '', label: '' } },
  { fundName: 'Missions', account: { value: '20', label: 'Missions Income' }, class: { value: '', label: '' }, customer: { value: '', label: '' } },
];

const donation = (cents: number, designationIds: string[]) => ({
  id: 'd1',
  attributes: { amount_cents: cents },
  relationships: { designations: { data: designationIds.map((id) => ({ id })) } },
});

describe('donationLines', () => {
  test('a single-fund gift produces one line at the full amount', () => {
    const lines = donationLines(donation(50000, ['g1']), { g1: { fundName: 'General', amountCents: 50000 } }, SETTINGS);
    expect(lines).toEqual([{ AccountRef: '10', ClassRef: 'C1', amount_cents: 50000, fundName: 'General' }]);
  });

  // Regression: only the first designation was read, and it was paired with the
  // donation's total - so a split gift credited everything to one fund.
  test('a split gift credits each fund its own share', () => {
    const lines = donationLines(
      donation(10000, ['g1', 'g2']),
      { g1: { fundName: 'General', amountCents: 6000 }, g2: { fundName: 'Missions', amountCents: 4000 } },
      SETTINGS,
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => [l.AccountRef, l.amount_cents])).toEqual([
      ['10', 6000],
      ['20', 4000],
    ]);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(10000);
  });

  test('a split gift reaches QuickBooks as two credit lines that still balance', () => {
    const lines = donationLines(
      donation(10000, ['g1', 'g2']),
      { g1: { fundName: 'General', amountCents: 6000 }, g2: { fundName: 'Missions', amountCents: 4000 } },
      SETTINGS,
    );
    const je = journalEntryPayload(lines, {
      clearingAccountRef: { value: '99' },
      feesAccountRef: { value: '55' },
      totalFeeCents: -320,
      TxnDate: '2026-09-08',
      memo: 'test',
    } as any);
    const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit');
    const debits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit');
    expect(credits.map((l: any) => [l.JournalEntryLineDetail.AccountRef.value, l.Amount])).toEqual([
      ['10', 60],
      ['20', 40],
    ]);
    expect(credits.reduce((s: number, l: any) => s + l.Amount, 0)).toBeCloseTo(100, 2);
    expect(debits.reduce((s: number, l: any) => s + l.Amount, 0)).toBeCloseTo(100, 2);
  });

  test('an unresolvable designation falls back to the donation total, never to zero', () => {
    const lines = donationLines(donation(7500, ['missing']), {}, SETTINGS, 'General');
    expect(lines).toEqual([{ AccountRef: '10', ClassRef: 'C1', amount_cents: 7500, fundName: 'General' }]);
  });

  // A partial payload must not silently post less than the donor gave.
  test('designations that do not add up to the gift are not trusted', () => {
    const lines = donationLines(
      donation(10000, ['g1', 'g2']),
      { g1: { fundName: 'General', amountCents: 6000 } },
      SETTINGS,
      'General',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amount_cents).toBe(10000);
  });

  test('a fund with no mapping yields a blank AccountRef for the caller to drop', () => {
    const lines = donationLines(donation(1000, ['g9']), { g9: { fundName: 'Building', amountCents: 1000 } }, SETTINGS);
    expect(lines[0].AccountRef).toBe('');
    expect(lines[0].fundName).toBe('Building');
  });
});

// Regression, caught in review before shipping: emitting one line per designation meant a
// split gift whose second fund was unmapped posted only the mapped share, while the whole
// donation's fee was still charged to the day. Revenue came out short and the clearing
// account could never again match what Stripe deposited.
describe('split gifts with an unmapped fund', () => {
  const split = donation(10000, ['g1', 'g2']);
  const designations = {
    g1: { fundName: 'General', amountCents: 6000 },
    g2: { fundName: 'Youth Camp', amountCents: 4000 }, // not in SETTINGS
  };

  test('posts the full gift rather than only the mapped share', () => {
    const lines = donationLines(split, designations, SETTINGS, 'General');
    expect(lines).toHaveLength(1);
    expect(lines[0].amount_cents).toBe(10000);
    expect(lines[0].AccountRef).toBe('10');
  });

  test('the day still reconciles: credits equal gross, clearing equals gross minus fees', () => {
    const lines = donationLines(split, designations, SETTINGS, 'General');
    const je = journalEntryPayload(lines, {
      clearingAccountRef: { value: '99' },
      feesAccountRef: { value: '55' },
      totalFeeCents: -320,
      TxnDate: '2026-09-08',
      memo: 'test',
    } as any);
    const amt = (t: string) =>
      je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === t).reduce((s: number, l: any) => s + l.Amount, 0);
    expect(amt('Credit')).toBeCloseTo(100, 2);
    expect(amt('Debit')).toBeCloseTo(100, 2);
    const clearing = je.Line.find((l: any) => l.JournalEntryLineDetail.AccountRef.value === '99');
    expect(clearing.Amount).toBeCloseTo(96.8, 2);
  });

  test('a gift with no mapped fund at all still drops out, as it did before', () => {
    const lines = donationLines(split, { g1: { fundName: 'Youth Camp', amountCents: 10000 } }, SETTINGS, 'Youth Camp');
    expect(lines[0].AccountRef).toBe('');
  });
});
