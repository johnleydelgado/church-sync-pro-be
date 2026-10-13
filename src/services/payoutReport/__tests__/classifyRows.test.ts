import { classifyRows } from '../classifyRows';
import { PayoutRow } from '../parsePayoutReport';
import { readRegistrationMapping } from '../registrationMapping';

const mapping = readRegistrationMapping({ version: 2, default: { account: { value: '77' } }, events: [] })!;
const row = (o: Partial<PayoutRow>): PayoutRow => ({
  line: 2,
  day: '2026-10-05',
  type: 'Charge',
  source: 'Registrations',
  name: 'N',
  fundOrSignup: 'SHE',
  grossCents: 6000,
  feeCents: 159,
  netCents: 5841,
  paymentMethod: 'card',
  campus: '',
  description: 'Registration #1',
  externalId: 'registration:1',
  rowKey: 'registration:1:charge:2026-10-05:6000',
  ...o,
});
const ctx = { registrationStartDay: '2026-10-01', mapping, knownKeys: new Set<string>() };

test('a new registration charge on/after the start date is posted to its account', () => {
  expect(classifyRows([row({})], ctx)[0]).toMatchObject({ status: 'to_post', accountRef: '77' });
});
test('a charge before the start date is left alone', () => {
  expect(classifyRows([row({ day: '2026-09-28' })], ctx)[0]).toMatchObject({ status: 'before_start' });
});
test('a refund on/after the start date posts, even when the charge was earlier', () => {
  expect(classifyRows([row({ type: 'Refund', grossCents: -5500, feeCents: 0, netCents: -5500 })], ctx)[0].status).toBe(
    'to_post',
  );
});
test('a row already imported is reported, not posted again', () => {
  const known = { ...ctx, knownKeys: new Set(['registration:1:charge:2026-10-05:6000']) };
  expect(classifyRows([row({})], known)[0].status).toBe('already_recorded');
});
test('giving rows are handed to the giving check', () => {
  expect(classifyRows([row({ source: 'Giving' })], ctx)[0].status).toBe('giving');
});
test.each([
  [{ source: 'Stripe' }, 'unrecognised_source'],
  [{ type: 'Dispute' }, 'unrecognised_type'],
  [{ netCents: 5000 }, 'amounts_do_not_add_up'],
  [{ grossCents: -6000, netCents: -6159 }, 'unexpected_sign'],
  [{ type: 'Refund', grossCents: -5500, feeCents: 150, netCents: -5650 }, 'refund_with_fee'],
])('odd rows are held: %o', (o, reason) => {
  expect(classifyRows([row(o as any)], ctx)[0]).toMatchObject({ status: 'held', reason });
});
test('no account mapped holds the row', () => {
  const none = { ...ctx, mapping: readRegistrationMapping({ version: 2, default: { account: null }, events: [] })! };
  expect(classifyRows([row({})], none)[0]).toMatchObject({ status: 'held', reason: 'no_account_mapped' });
});
