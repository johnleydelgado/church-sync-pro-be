/**
 * "Payouts in this file: from / to" - the payout dates a payout report was exported for. Required
 * on every new upload, because it is the only record of when the file's rows were paid out.
 */
jest.mock('../../../controller/automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../dailyDonationSync', () => ({ getOrgTimeZone: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

import { generatePcToken } from '../../../controller/automation';
import { getOrgTimeZone } from '../../dailyDonationSync';
import { PayoutReportFormatError } from '../parsePayoutReport';
import { assertPayoutRange, payoutRangeProblem } from '../payoutRange';

const token = generatePcToken as jest.Mock;
const zone = getOrgTimeZone as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  token.mockResolvedValue({ access_token: 'pco' });
});

describe('payoutRangeProblem (today is the church local day)', () => {
  const today = '2026-10-22';

  test.each([
    ['a month', '2026-09-01', '2026-09-30'],
    ['one day', '2026-10-01', '2026-10-01'],
    ['part of a month', '2026-10-01', '2026-10-15'],
    ['up to today', '2026-10-01', '2026-10-22'],
    ['a February in a leap year', '2024-02-01', '2024-02-29'],
  ])('accepts %s', (_name, from, to) => {
    expect(payoutRangeProblem(from, to, today)).toBeNull();
  });

  test('both dates are required', () => {
    const msg = 'Enter the dates of the payouts in this file: from and to.';
    expect(payoutRangeProblem(undefined, undefined, today)).toBe(msg);
    expect(payoutRangeProblem('2026-09-01', '', today)).toBe(msg);
    expect(payoutRangeProblem(null, '2026-09-30', today)).toBe(msg);
  });

  test.each([['2026-9-1'], ['2026-09-31'], ['09/01/2026'], ['2026-02-29']])('a date that is not a real YYYY-MM-DD (%s)', (bad) => {
    expect(payoutRangeProblem(bad, '2026-09-30', today)).toBe('The payout dates must be real dates (YYYY-MM-DD).');
  });

  test('reversed', () => {
    expect(payoutRangeProblem('2026-09-30', '2026-09-01', today)).toBe(
      'The payout dates are the wrong way round: Sep 30 is after Sep 1.',
    );
  });

  test('to in the future', () => {
    expect(payoutRangeProblem('2026-10-01', '2026-10-23', today)).toBe(
      "The last payout date, Oct 23, is in the future. Enter the date of the last payout in this file.",
    );
  });

  test('straddling a month-end says where to split it', () => {
    expect(payoutRangeProblem('2026-09-15', '2026-10-05', today)).toBe(
      "These payouts run from Sep 15 to Oct 5, across a month-end. Split it at the month-end: CSP can't tell which side of Sep 30 each row falls on.",
    );
  });

  test('straddling a year-end names the years', () => {
    expect(payoutRangeProblem('2025-12-15', '2026-01-05', today)).toBe(
      "These payouts run from Dec 15, 2025 to Jan 5, 2026, across a month-end. Split it at the month-end: CSP can't tell which side of Dec 31, 2025 each row falls on.",
    );
  });

  test('the same month of another year is still a straddle', () => {
    expect(payoutRangeProblem('2025-10-01', '2026-10-01', today)).toMatch(/across a month-end/);
  });
});

describe('assertPayoutRange', () => {
  // 2026-10-22 18:00 UTC: Oct 22 in the Americas, Oct 23 in Kiritimati (UTC+14).
  const now = new Date('2026-10-22T18:00:00Z');

  test('a range well in the past never asks Planning Center', async () => {
    await expect(assertPayoutRange('c@x.test', '2026-09-01', '2026-09-30', now)).resolves.toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(token).not.toHaveBeenCalled();
  });

  test('a date after today everywhere is refused without asking', async () => {
    await expect(assertPayoutRange('c@x.test', '2026-10-01', '2026-10-24', now)).rejects.toThrow(PayoutReportFormatError);
    expect(token).not.toHaveBeenCalled();
  });

  test('near today, the church timezone decides: tomorrow in Denver is refused', async () => {
    zone.mockResolvedValue('America/Denver');
    await expect(assertPayoutRange('c@x.test', '2026-10-01', '2026-10-23', now)).rejects.toThrow(
      'The last payout date, Oct 23, is in the future.',
    );
    expect(token).toHaveBeenCalledWith('c@x.test');
  });

  test('near today, the church timezone decides: already today in Kiritimati is accepted', async () => {
    zone.mockResolvedValue('Pacific/Kiritimati');
    await expect(assertPayoutRange('c@x.test', '2026-10-01', '2026-10-23', now)).resolves.toEqual({
      from: '2026-10-01',
      to: '2026-10-23',
    });
  });

  test("Planning Center unreachable near today: a date that is today somewhere is not refused", async () => {
    token.mockRejectedValue(new Error('no token'));
    await expect(assertPayoutRange('c@x.test', '2026-10-01', '2026-10-23', now)).resolves.toEqual({
      from: '2026-10-01',
      to: '2026-10-23',
    });
  });

  test('other problems are refused before any lookup', async () => {
    await expect(assertPayoutRange('c@x.test', '2026-10-05', '2026-10-01', now)).rejects.toThrow('wrong way round');
    await expect(assertPayoutRange('c@x.test', undefined, undefined, now)).rejects.toThrow('Enter the dates');
    expect(token).not.toHaveBeenCalled();
  });
});
