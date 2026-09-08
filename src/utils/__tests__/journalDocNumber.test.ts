import { journalDocNumber, journalEntryPayload, refundJournalEntryPayload } from '../mapping';

// QuickBooks shows this as "Journal no.". Left unset it is blank, and the entry can then only
// be referred to by an internal id that does not appear in most reports - so a bookkeeper
// asking "which entry is this?" has nothing to quote.
describe('journalDocNumber', () => {
  test('names the day and the entry within it', () => {
    expect(journalDocNumber('2026-09-08', 1)).toBe('CSP-2026-09-08-1');
    expect(journalDocNumber('2026-09-08', 2)).toBe('CSP-2026-09-08-2');
  });

  test('marks a refund reversal distinctly', () => {
    expect(journalDocNumber('2026-09-08', 1, 'refund')).toBe('CSP-R-2026-09-08-1');
  });

  test('stays inside QuickBooks\' 21-character limit', () => {
    expect(journalDocNumber('2026-09-08', 99, 'refund').length).toBeLessThanOrEqual(21);
    expect(journalDocNumber('2026-12-31', 999, 'refund').length).toBeLessThanOrEqual(21);
  });

  test('a day\'s entries never share a number', () => {
    const numbers = [
      journalDocNumber('2026-09-08', 1),
      journalDocNumber('2026-09-08', 2, 'refund'),
      journalDocNumber('2026-09-08', 3),
    ];
    expect(new Set(numbers).size).toBe(3);
  });
});

describe('the number reaches QuickBooks', () => {
  const lines = [{ AccountRef: '40', amount_cents: 10000, fundName: 'General' }];
  const opts = (docNumber?: string) => ({
    clearingAccountRef: { value: '10' },
    feesAccountRef: { value: '60' },
    totalFeeCents: -320,
    txnDate: '2026-09-08',
    memo: 'test',
    docNumber,
  }) as any;

  test('as DocNumber on a giving entry', () => {
    expect(journalEntryPayload(lines, opts('CSP-2026-09-08-1')).DocNumber).toBe('CSP-2026-09-08-1');
  });

  test('as DocNumber on a refund entry', () => {
    expect(refundJournalEntryPayload(lines, opts('CSP-R-2026-09-08-1')).DocNumber).toBe('CSP-R-2026-09-08-1');
  });

  // Omitted rather than sent empty, so QuickBooks keeps its own behaviour for older callers.
  test('and is absent entirely when not supplied', () => {
    expect('DocNumber' in journalEntryPayload(lines, opts(undefined))).toBe(false);
  });
});
