import {
  ReturnLine,
  donationIdOf,
  isGivingFailure,
  isGivingFee,
  linkReturnLines,
  returnCostCents,
  stripePaymentIdOf,
} from '../returnedGifts';

// The lines exactly as Active Church's October 2026 file has them (donor name replaced).
const PAY = 'py_3UMpawCdJd3pVWd30z8502Yi';
const charge = (o: Partial<ReturnLine> = {}): ReturnLine => ({
  rowKey: 'donation:404799338:charge:2026-10-04:60000',
  day: '2026-10-04',
  type: 'Charge',
  source: 'Giving',
  name: 'Pat Donor',
  fundOrSignup: 'Tithes & Offerings',
  description: 'Donation #404799338 - Pat Donor - Tithes & Offerings ($600.00)',
  grossCents: 60000,
  netCents: 59970,
  ...o,
});
const failure = (o: Partial<ReturnLine> = {}): ReturnLine => ({
  rowKey: 'raw:failure-sha',
  day: '2026-10-05',
  type: 'Charge failure',
  source: 'Giving',
  name: 'Pat Donor',
  fundOrSignup: 'Tithes & Offerings',
  description: `Funds reversed due to payment ${PAY} failed`,
  grossCents: -60000,
  netCents: -60075,
  ...o,
});
const fee = (o: Partial<ReturnLine> = {}): ReturnLine => ({
  rowKey: 'raw:fee-sha',
  day: '2026-10-05',
  type: 'Fee',
  source: 'Giving',
  name: 'Pat Donor',
  fundOrSignup: 'Tithes & Offerings',
  description: `Application fee refund for ${PAY}`,
  grossCents: 0,
  netCents: 5,
  ...o,
});
const RETURNED = new Set(['404799338']);

describe('reading the lines', () => {
  test('the Stripe payment id comes from the description', () => {
    expect(stripePaymentIdOf(failure())).toBe(PAY);
    expect(stripePaymentIdOf(fee())).toBe(PAY);
    expect(stripePaymentIdOf(charge())).toBeNull();
  });
  test('the real failure and fee lines name no donation', () => {
    expect(donationIdOf(failure())).toBeNull();
    expect(donationIdOf(charge())).toBe('404799338');
  });
  test('line types', () => {
    expect(isGivingFailure(failure())).toBe(true);
    expect(isGivingFailure({ ...failure(), grossCents: 100 })).toBe(false);
    expect(isGivingFailure({ ...failure(), source: 'Registrations' })).toBe(false);
    expect(isGivingFee(fee())).toBe(true);
    expect(isGivingFee({ ...fee(), type: 'Fees' })).toBe(false);
  });
});

describe('linkReturnLines', () => {
  test("October's return: the failure finds its gift, the fee follows the failure", () => {
    const links = linkReturnLines([failure(), fee()], [charge()], RETURNED);
    expect(Object.fromEntries(links.gift)).toEqual({ 'raw:failure-sha': '404799338', 'raw:fee-sha': '404799338' });
    expect(links.unlinked.size).toBe(0);
  });

  test('names and funds match regardless of case and spacing', () => {
    const links = linkReturnLines([failure({ name: 'pat  donor ' })], [charge()], RETURNED);
    expect(links.gift.get('raw:failure-sha')).toBe('404799338');
  });

  test('the same donor giving the same amount twice: only the gift Planning Center marks returned', () => {
    const other = charge({
      rowKey: 'donation:500:charge:2026-10-03:60000',
      day: '2026-10-03',
      description: 'Donation #500 - Pat Donor',
    });
    const links = linkReturnLines([failure()], [other, charge()], RETURNED);
    expect(links.gift.get('raw:failure-sha')).toBe('404799338');
  });

  test('two gifts that both came back and look the same: left for a person', () => {
    const other = charge({ rowKey: 'donation:500:charge:2026-10-03:60000', day: '2026-10-03' });
    const links = linkReturnLines([failure(), fee()], [other, charge()], new Set(['404799338', '500']));
    expect(Object.fromEntries(links.unlinked)).toEqual({
      'raw:failure-sha': 'returned_ambiguous',
      'raw:fee-sha': 'returned_ambiguous',
    });
  });

  test("a matching gift Planning Center doesn't mark returned: unconfirmed, never guessed", () => {
    expect(linkReturnLines([failure()], [charge()], new Set()).unlinked.get('raw:failure-sha')).toBe(
      'returned_unconfirmed',
    );
  });

  test('no gift like it uploaded: without charge', () => {
    expect(linkReturnLines([failure()], [], RETURNED).unlinked.get('raw:failure-sha')).toBe('returned_without_charge');
    expect(
      linkReturnLines([failure()], [charge({ grossCents: 50000 })], RETURNED).unlinked.get('raw:failure-sha'),
    ).toBe('returned_without_charge');
    expect(
      linkReturnLines([failure()], [charge({ name: 'Someone Else' })], RETURNED).unlinked.get('raw:failure-sha'),
    ).toBe('returned_without_charge');
  });

  test('a charge after the failure, or more than 14 days before it, is not the one', () => {
    expect(
      linkReturnLines([failure()], [charge({ day: '2026-10-06' })], RETURNED).unlinked.get('raw:failure-sha'),
    ).toBe('returned_without_charge');
    expect(
      linkReturnLines([failure()], [charge({ day: '2026-09-20' })], RETURNED).unlinked.get('raw:failure-sha'),
    ).toBe('returned_without_charge');
  });

  test('a fee that names no failure is not a returned gift line', () => {
    const links = linkReturnLines([fee({ description: 'Application fee refund for py_OTHER' })], [charge()], RETURNED);
    expect(links.gift.size + links.unlinked.size).toBe(0);
  });

  test('a fee whose failure could not be tied waits with it, for the same reason', () => {
    const links = linkReturnLines([failure(), fee()], [], RETURNED);
    expect(links.unlinked.get('raw:fee-sha')).toBe('returned_without_charge');
  });
});

describe('returnCostCents', () => {
  test('October: $599.70 in, $600.75 back, $0.05 fee refunded - it cost $1.00', () => {
    expect(returnCostCents(charge(), [failure(), fee()])).toBe(100);
  });
  test('unknown until a line taking it back is uploaded', () => {
    expect(returnCostCents(charge(), [])).toBeNull();
    expect(returnCostCents(charge(), [fee()])).toBeNull();
  });
});
