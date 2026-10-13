import { readRegistrationMapping, accountForSignup, legacyRegistrationList } from '../registrationMapping';

const v2 = {
  version: 2,
  default: { account: { value: '77', label: '44000 Event Income' }, class: null },
  events: [{ signup: 'SHE Conference 2026', account: { value: '78', label: 'Women' }, class: { value: 'c9', label: 'Women' } }],
};

test('legacy (Stripe-era) data is not a v2 mapping', () => {
  expect(readRegistrationMapping([{ registration: 'x', account: {} }])).toBeNull();
  expect(readRegistrationMapping(null)).toBeNull();
});

test('an event override wins, matched case- and space-insensitively', () => {
  expect(accountForSignup(readRegistrationMapping(v2)!, '  she conference 2026 ')).toEqual({
    accountRef: '78',
    classRef: 'c9',
    via: 'event',
  });
});

test('anything else falls back to the default', () => {
  expect(accountForSignup(readRegistrationMapping(v2)!, 'Magic Mountain')).toEqual({
    accountRef: '77',
    classRef: undefined,
    via: 'default',
  });
});

test('no default and no override means nothing to post to', () => {
  const m = readRegistrationMapping({ version: 2, default: { account: null }, events: [] })!;
  expect(accountForSignup(m, 'Any')).toBeNull();
});

test('the old Stripe-era code sees its list, or nothing once the v2 mapping is saved', () => {
  const old = [{ registration: 'Camp', account: { value: '1' } }];
  expect(legacyRegistrationList(old)).toBe(old);
  expect(legacyRegistrationList(v2)).toEqual([]);
  expect(legacyRegistrationList(null)).toEqual([]);
});
