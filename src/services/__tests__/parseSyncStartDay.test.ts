import { parseSyncStartDay } from '../dailyDonationSync';

// The column is a varchar the mapping page writes as MM-DD-YYYY, and nothing enforces that.
// The nightly path used to run it through `new Date(...)`, which parses in the CONTAINER's
// timezone - neither UTC nor the church's - and yields Invalid Date for anything unexpected,
// which then compared false against every donation without saying so. Production holds two
// MM-DD-YYYY strings and one NULL today.
describe('parseSyncStartDay', () => {
  test('reads the format the mapping page writes', () => {
    expect(parseSyncStartDay('01-01-2024')).toBe('2024-01-01');
    expect(parseSyncStartDay('07-01-2023')).toBe('2023-07-01');
    expect(parseSyncStartDay('12-31-2025')).toBe('2025-12-31');
  });

  test('also reads an ISO date, with or without a time', () => {
    expect(parseSyncStartDay('2024-03-05')).toBe('2024-03-05');
    expect(parseSyncStartDay('2024-03-05T00:00:00Z')).toBe('2024-03-05');
  });

  test('returns null rather than a wrong date for anything else', () => {
    expect(parseSyncStartDay(null)).toBeNull();
    expect(parseSyncStartDay(undefined)).toBeNull();
    expect(parseSyncStartDay('')).toBeNull();
    expect(parseSyncStartDay('   ')).toBeNull();
    expect(parseSyncStartDay('not a date')).toBeNull();
    expect(parseSyncStartDay('1/1/2024')).toBeNull();
    expect(parseSyncStartDay(20240101 as any)).toBeNull();
  });

  test('does not shift the day, whatever the server timezone', () => {
    // `new Date('01-01-2024')` on a UTC+8 host yields 2023-12-31T16:00Z - a day early.
    expect(parseSyncStartDay('01-01-2024')).toBe('2024-01-01');
  });
});
