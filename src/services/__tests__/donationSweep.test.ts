import axios from 'axios';

import { fetchDonationsForDay, localToday, nextDay, previousDay } from '../donationSweep';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const donation = (id: string, receivedAt: string) => ({
  id,
  attributes: { amount_cents: 10000, fee_cents: -320, payment_method: 'card', payment_status: 'succeeded', received_at: receivedAt },
});

describe('day arithmetic', () => {
  test('rolls over months and years', () => {
    expect(nextDay('2026-09-08')).toBe('2026-09-09');
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  test('handles a leap day', () => {
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2028-02-29')).toBe('2028-03-01');
  });
});

describe('the day the church is in', () => {
  test('is the local day, not the UTC one', () => {
    // 03:00 UTC on 9 September is still the evening of the 8th in Los Angeles.
    const at = new Date('2026-09-09T03:00:00Z');
    expect(localToday('America/Los_Angeles', at)).toBe('2026-09-08');
    expect(localToday('America/New_York', at)).toBe('2026-09-08');
    expect(localToday('UTC', at)).toBe('2026-09-09');
    // And ahead of UTC it can already be the next day.
    expect(localToday('Asia/Manila', at)).toBe('2026-09-09');
  });
});

describe('fetchDonationsForDay', () => {
  beforeEach(() => jest.clearAllMocks());

  test('asks for a half-open window using date-only strings', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [], included: [], meta: { total_count: 0 } } } as any);
    await fetchDonationsForDay({}, '2026-09-08');
    const url = mockedAxios.get.mock.calls[0][0] as string;
    // Half-open: `lte` on the end makes consecutive days overlap and posts money twice.
    expect(url).toContain('where[received_at][gte]=2026-09-08');
    expect(url).toContain('where[received_at][lt]=2026-09-09');
    expect(url).not.toContain('[lte]');
    // Date-only, so Planning Center applies the church's own timezone, DST included.
    expect(url).not.toMatch(/gte\]=\d{4}-\d{2}-\d{2}T/);
    // The meaning of this scope is undocumented; the engine's own filter decides what posts.
    expect(url).not.toContain('filter=succeeded');
    expect(url).toContain('include=designations,designations.fund');
  });

  test('follows every page', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          data: [donation('a', '2026-09-08T14:00:00Z')],
          included: [{ type: 'Fund', id: '1' }],
          meta: { total_count: 2 },
          links: { next: 'https://api.planningcenteronline.com/next-page' },
        },
      } as any)
      .mockResolvedValueOnce({
        data: { data: [donation('b', '2026-09-08T15:00:00Z')], included: [{ type: 'Fund', id: '2' }], meta: { total_count: 2 } },
      } as any);

    const { donations, included } = await fetchDonationsForDay({}, '2026-09-08');
    expect(donations.map((d) => d.id)).toEqual(['a', 'b']);
    expect(included).toHaveLength(2);
  });

  test('rejects a day that is not a date', async () => {
    await expect(fetchDonationsForDay({}, '8 September')).rejects.toThrow(/YYYY-MM-DD/);
  });

  // A misspelled `where` key is ignored by PCO, which then returns the whole ledger with a 200.
  // Posting that as one day would credit years of giving at once.
  test('refuses a result the date filter clearly did not apply to', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          donation('old1', '2023-04-04T14:00:00Z'),
          donation('old2', '2023-06-19T14:00:00Z'),
          donation('today', '2026-09-08T14:00:00Z'),
        ],
        included: [],
        meta: { total_count: 3 },
      },
    } as any);
    await expect(fetchDonationsForDay({}, '2026-09-08')).rejects.toThrow(/date filter did not apply/);
  });

  test('accepts a normal day', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [donation('a', '2026-09-08T14:00:00Z'), donation('b', '2026-09-08T23:30:00Z')],
        included: [],
        meta: { total_count: 2 },
      },
    } as any);
    const { donations } = await fetchDonationsForDay({}, '2026-09-08');
    expect(donations).toHaveLength(2);
  });
});
