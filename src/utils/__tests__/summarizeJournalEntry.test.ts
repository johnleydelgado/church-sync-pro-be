import { summarizeDailyClaim, summarizeJournalEntry } from '../summarizeJournalEntry';

const credit = (amount: number, accountRef: string) => ({
  Amount: amount,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: {
    PostingType: 'Credit',
    AccountRef: { value: accountRef },
  },
});

const debit = (amount: number, accountRef: string) => ({
  Amount: amount,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: {
    PostingType: 'Debit',
    AccountRef: { value: accountRef },
  },
});

describe('summarizeJournalEntry', () => {
  test('worked example: credits 699.20, 10.58 fees debit, 688.62 clearing debit', () => {
    const syncedData = {
      Line: [credit(699.2, '400'), debit(10.58, 'fees'), debit(688.62, '900')],
      TxnDate: '2026-05-01',
      PrivateNote: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.gross).toBeCloseTo(699.2, 2);
    expect(summary.fees).toBeCloseTo(10.58, 2);
    expect(summary.net).toBeCloseTo(688.62, 2);
    expect(summary.credits).toEqual([{ accountRef: '400', amount: 699.2 }]);
    expect(summary.memo).toBe('Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01');
  });

  test('multiple credit accounts are summed for gross and listed per line', () => {
    const syncedData = {
      Line: [credit(525, '101'), credit(120, '102'), debit(645, '900')],
      PrivateNote: 'memo',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.gross).toBeCloseTo(645, 2);
    expect(summary.fees).toBe(0);
    expect(summary.net).toBeCloseTo(645, 2);
    expect(summary.credits).toEqual([
      { accountRef: '101', amount: 525 },
      { accountRef: '102', amount: 120 },
    ]);
  });

  test('no-fees case: one debit equals gross -> fees 0, net gross', () => {
    const syncedData = {
      Line: [credit(699.2, '400'), debit(699.2, '900')],
      PrivateNote: 'm',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.gross).toBeCloseTo(699.2, 2);
    expect(summary.fees).toBe(0);
    expect(summary.net).toBeCloseTo(699.2, 2);
  });

  test('with 2 debits the SMALLER is fees, the LARGER is clearing regardless of order', () => {
    const syncedData = {
      // clearing listed before fees
      Line: [credit(699.2, '400'), debit(688.62, '900'), debit(10.58, 'fees')],
      PrivateNote: 'm',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.fees).toBeCloseTo(10.58, 2);
    expect(summary.net).toBeCloseTo(688.62, 2);
  });

  test('coerces string Amount values to numbers', () => {
    const syncedData = {
      Line: [
        { Amount: '699.20', DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '400' } } },
        { Amount: '10.58', DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'fees' } } },
        { Amount: '688.62', DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '900' } } },
      ],
      PrivateNote: 'm',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.gross).toBeCloseTo(699.2, 2);
    expect(summary.fees).toBeCloseTo(10.58, 2);
    expect(summary.net).toBeCloseTo(688.62, 2);
    expect(summary.credits[0].amount).toBeCloseTo(699.2, 2);
  });

  test('empty / malformed payload returns safe zeros', () => {
    expect(summarizeJournalEntry(undefined)).toEqual({ gross: 0, fees: 0, net: 0, credits: [], memo: '' });
    expect(summarizeJournalEntry(null)).toEqual({ gross: 0, fees: 0, net: 0, credits: [], memo: '' });
    expect(summarizeJournalEntry({})).toEqual({ gross: 0, fees: 0, net: 0, credits: [], memo: '' });
    expect(summarizeJournalEntry({ Line: 'nope' } as any)).toEqual({ gross: 0, fees: 0, net: 0, credits: [], memo: '' });
  });

  test('malformed Amount values coerce to 0 rather than NaN', () => {
    const syncedData = {
      Line: [credit(Number('abc'), '400'), debit(Number('abc'), '900')],
      PrivateNote: 'm',
    };

    const summary = summarizeJournalEntry(syncedData);

    expect(summary.gross).toBe(0);
    expect(summary.fees).toBe(0);
    expect(summary.net).toBe(0);
    expect(summary.credits).toEqual([{ accountRef: '400', amount: 0 }]);
  });
});

/**
 * A day's row on the Daily Sync page. When giving settles after a day was first posted (ACH,
 * mostly), the engine posts an adjusting entry and overwrites the claim's `syncedData` with
 * THAT entry - so summarising `syncedData` alone showed only the latest entry. Active Church's
 * 2026-09-15 read $486.70 to clearing when CSP had posted $1,391.15 across two entries.
 */
describe('summarizeDailyClaim', () => {
  // The adjusting entry that was the latest thing posted for 2026-09-15 in production.
  const adjustingEntry = {
    Line: [credit(487.6, '1150040010'), debit(0.9, 'fees'), debit(486.7, '1150040022')],
    PrivateNote: 'Church Sync Pro - PCO Electronic Giving Adjustment - 2026-09-15',
  };

  test("a day posted as two entries reads as the day's total, not the latest entry", () => {
    const summary = summarizeDailyClaim(
      {
        syncedData: adjustingEntry,
        postedGrossCents: 141346,
        postedFeeCents: 2231,
        postedByAccount: { '1150040010': 141346 },
      },
      { entryCount: 2, qboEntryIds: ['20963', '21008'] },
    );

    expect(summary.gross).toBe(1413.46);
    expect(summary.fees).toBe(22.31);
    expect(summary.net).toBe(1391.15);
    expect(summary.credits).toEqual([{ accountRef: '1150040010', amount: 1413.46 }]);
    expect(summary.memo).toBe('Posted as 2 QuickBooks entries: #20963, #21008');
  });

  test('every revenue account is listed with its cumulative amount', () => {
    const summary = summarizeDailyClaim(
      {
        syncedData: adjustingEntry,
        postedGrossCents: 64500,
        postedFeeCents: 1500,
        postedByAccount: { '101': 52500, '102': 12000 },
      },
      { entryCount: 3, qboEntryIds: ['1', '2', '3'] },
    );

    expect(summary.credits).toEqual([
      { accountRef: '101', amount: 525 },
      { accountRef: '102', amount: 120 },
    ]);
    expect(summary.net).toBe(630);
  });

  test('Postgres BIGINT strings are read as numbers', () => {
    const summary = summarizeDailyClaim(
      {
        syncedData: adjustingEntry,
        postedGrossCents: '141346' as any,
        postedFeeCents: '2231' as any,
        postedByAccount: { '1150040010': '141346' as any },
      },
      { entryCount: '2' as any, qboEntryIds: ['20963', '21008'] },
    );

    expect(summary.gross).toBe(1413.46);
    expect(summary.net).toBe(1391.15);
    expect(summary.credits).toEqual([{ accountRef: '1150040010', amount: 1413.46 }]);
  });

  test('a day with a single entry keeps that entry and its memo', () => {
    const only = {
      Line: [credit(1220.03, '400'), debit(6.52, 'fees'), debit(1213.51, '900')],
      PrivateNote: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-09-16',
    };
    const summary = summarizeDailyClaim(
      { syncedData: only, postedGrossCents: 122003, postedFeeCents: 652, postedByAccount: { '400': 122003 } },
      { entryCount: 1, qboEntryIds: ['21009'] },
    );

    expect(summary).toEqual({
      gross: 1220.03,
      fees: 6.52,
      net: 1213.51,
      credits: [{ accountRef: '400', amount: 1220.03 }],
      memo: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-09-16',
    });
  });

  test('a claim posted before the running totals were recorded falls back to its entry', () => {
    const claim = { syncedData: adjustingEntry, postedGrossCents: null, postedFeeCents: null, postedByAccount: null };

    expect(summarizeDailyClaim(claim, undefined)).toEqual(summarizeJournalEntry(adjustingEntry));
  });

  test('totals without a per-account breakdown show no credits rather than the latest entry\'s', () => {
    const summary = summarizeDailyClaim(
      { syncedData: adjustingEntry, postedGrossCents: 141346, postedFeeCents: 2231, postedByAccount: null },
      { entryCount: 2, qboEntryIds: ['20963', '21008'] },
    );

    expect(summary.gross).toBe(1413.46);
    expect(summary.credits).toEqual([]);
  });

  test('a multi-entry day with no recorded ids still says how many entries there are', () => {
    const summary = summarizeDailyClaim(
      { syncedData: adjustingEntry, postedGrossCents: 141346, postedFeeCents: 2231, postedByAccount: { a: 141346 } },
      { entryCount: 2, qboEntryIds: [] },
    );

    expect(summary.memo).toBe('Posted as 2 QuickBooks entries');
  });
});
