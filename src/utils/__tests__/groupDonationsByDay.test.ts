import { groupDonationsByDay } from '../mapping';

test('groups donations by received_at calendar day', () => {
  const d = (received: string, cents: number) => ({ attributes: { received_at: received, amount_cents: cents } });
  const groups = groupDonationsByDay([
    d('2026-05-01T10:00:00-05:00', 5000),
    d('2026-05-01T22:30:00-05:00', 1200),
    d('2026-05-02T09:00:00-05:00', 750),
  ]);
  expect(Object.keys(groups).sort()).toEqual(['2026-05-01', '2026-05-02']);
  expect(groups['2026-05-01'].length).toBe(2);
  expect(groups['2026-05-02'].length).toBe(1);
});
test('ignores donations with no date', () => {
  const groups = groupDonationsByDay([{ attributes: {} } as any]);
  expect(Object.keys(groups).length).toBe(0);
});
test('falls back to created_at when received_at is absent', () => {
  const groups = groupDonationsByDay([
    { attributes: { created_at: '2026-05-03T08:00:00-05:00', amount_cents: 1000 } } as any,
  ]);
  expect(Object.keys(groups)).toEqual(['2026-05-03']);
  expect(groups['2026-05-03'].length).toBe(1);
});
test('returns empty object for empty input without throwing', () => {
  expect(groupDonationsByDay([])).toEqual({});
});
