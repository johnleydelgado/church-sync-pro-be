import { registrationChargeEntry, registrationRefundEntry, registrationDocNumber } from '../registrationEntries';

const opts = {
  day: '2026-10-05',
  docNumber: 'CSP-E-2026-10-05-1',
  memo: 'Church Sync Pro - PCO Registrations - 2026-10-05',
  clearing: { value: '1150040022', name: 'Clearing Account' },
  fees: { value: '5', name: 'Bank Charges', classRef: 'gf' },
};

test('doc numbers fit QuickBooks (21 chars)', () => {
  expect(registrationDocNumber('2026-10-05', 1, 'charge')).toBe('CSP-E-2026-10-05-1');
  expect(registrationDocNumber('2026-10-05', 12, 'refund')).toBe('CSP-ER-2026-10-05-12');
});

test('charges: gross to income per account+class, fee to fees, net to clearing', () => {
  const je = registrationChargeEntry(
    [
      { accountRef: '77', grossCents: 6000, feeCents: 159 },
      { accountRef: '77', grossCents: 6000, feeCents: 159 },
      { accountRef: '77', classRef: 'women', grossCents: 3000, feeCents: 95 },
    ],
    opts,
  );
  const lines = je.Line.map((l: any) => [
    l.JournalEntryLineDetail.PostingType,
    l.JournalEntryLineDetail.AccountRef.value,
    l.JournalEntryLineDetail.ClassRef?.value,
    l.Amount,
  ]);
  expect(lines).toEqual([
    ['Credit', '77', undefined, 120],
    ['Credit', '77', 'women', 30],
    ['Debit', '5', 'gf', 4.13],
    ['Debit', '1150040022', undefined, 145.87],
  ]);
  expect(je).toMatchObject({ TxnDate: '2026-10-05', DocNumber: 'CSP-E-2026-10-05-1' });
  // Without event names there is nothing to name a line with.
  expect(je.Line.filter((l: any) => 'Description' in l)).toEqual([]);
});

const described = (je: any) =>
  je.Line.map((l: any) => [
    l.JournalEntryLineDetail.PostingType,
    l.JournalEntryLineDetail.AccountRef.value,
    l.JournalEntryLineDetail.ClassRef?.value,
    l.Amount,
    l.Description,
  ]);

test('charges: one income line per event, named, in the order the events first appear', () => {
  // Active Church's 10/3/2026: one Event Income line from CSP, split by event by its bookkeepers.
  const she = 'SHE Conference 2026';
  const retreat = 'Young Adult Retreat 2027';
  const breakfast = "Active Church Men's Breakfast";
  const row = (event: string, grossCents: number, feeCents: number) => ({ accountRef: '77', classRef: 'gf', event, grossCents, feeCents });
  const je = registrationChargeEntry(
    [
      row(she, 6000, 160),
      row(retreat, 12500, 340),
      row(she, 6000, 160),
      row(breakfast, 1000, 29),
      row(she, 6000, 160),
      row(she, 6000, 160),
      row(breakfast, 1000, 29),
      row(she, 6000, 160),
    ],
    opts,
  );
  expect(described(je)).toEqual([
    ['Credit', '77', 'gf', 300, she],
    ['Credit', '77', 'gf', 125, retreat],
    ['Credit', '77', 'gf', 20, breakfast],
    ['Debit', '5', 'gf', 11.98, undefined],
    ['Debit', '1150040022', undefined, 433.02, undefined],
  ]);
});

test('the same event spelled with other spacing or capitals is one line, named as first seen', () => {
  const je = registrationChargeEntry(
    [
      { accountRef: '77', event: 'SHE Conference 2026', grossCents: 6000, feeCents: 0 },
      { accountRef: '77', event: '  she   conference 2026 ', grossCents: 4000, feeCents: 0 },
    ],
    opts,
  );
  expect(described(je)).toEqual([
    ['Credit', '77', undefined, 100, 'SHE Conference 2026'],
    ['Debit', '1150040022', undefined, 100, undefined],
  ]);
});

test('refunds: one debit per event, named', () => {
  const je = registrationRefundEntry(
    [
      { accountRef: '77', event: 'SHE Conference 2026', grossCents: -5500, feeCents: 0 },
      { accountRef: '77', event: 'Active Youth One Night', grossCents: -3500, feeCents: 0 },
      { accountRef: '77', event: 'SHE Conference 2026', grossCents: -5500, feeCents: 0 },
    ],
    { ...opts, docNumber: 'CSP-ER-2026-10-05-1' },
  );
  expect(described(je)).toEqual([
    ['Debit', '77', undefined, 110, 'SHE Conference 2026'],
    ['Debit', '77', undefined, 35, 'Active Youth One Night'],
    ['Credit', '1150040022', undefined, 145, undefined],
  ]);
});

test('refunds: income debited back, clearing credited', () => {
  const je = registrationRefundEntry([{ accountRef: '77', grossCents: -5500, feeCents: 0 }], {
    ...opts,
    docNumber: 'CSP-ER-2026-10-05-1',
  });
  expect(
    je.Line.map((l: any) => [l.JournalEntryLineDetail.PostingType, l.JournalEntryLineDetail.AccountRef.value, l.Amount]),
  ).toEqual([
    ['Debit', '77', 55],
    ['Credit', '1150040022', 55],
  ]);
});

test('refuses empty or unbalanced input', () => {
  expect(() => registrationChargeEntry([], opts)).toThrow();
  expect(() => registrationChargeEntry([{ accountRef: '77', grossCents: 100, feeCents: 200 }], opts)).toThrow(/exceed/);
  expect(() =>
    registrationChargeEntry([{ accountRef: '77', grossCents: 100, feeCents: 5 }], { ...opts, fees: { value: '' } }),
  ).toThrow(/fee account/);
});
