import { summarizeJournalEntry } from '../summarizeJournalEntry';

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
