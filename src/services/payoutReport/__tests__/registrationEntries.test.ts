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
