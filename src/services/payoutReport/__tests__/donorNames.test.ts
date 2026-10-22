/**
 * Donor names for in-transit gifts no payout report names, from Planning Center's people endpoint.
 * Planning Center throttles, so a report looks people up a few at a time, each person once, and
 * stops at the first failure - the report stands without the names.
 */
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import axios from 'axios';
import { createLogger } from '../../../utils/logger';
import { lookupPersonNames, personName } from '../donorNames';

const get = axios.get as jest.Mock;
const log = createLogger('test') as any;
const CONFIG = { headers: { Authorization: 'Bearer pco' } };
const NO_RETRY = { retry: { retries: 0 } };
const person = (id: string, first: string | null, last: string | null) => ({
  data: { data: { type: 'Person', id, attributes: { first_name: first, last_name: last } } },
});
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const idOf = (url: string) => url.split('/').pop() as string;

beforeEach(() => jest.resetAllMocks());

test('personName: first and last as Planning Center shows them; nothing usable is null', () => {
  expect(personName({ attributes: { first_name: ' Ada ', last_name: 'Lovelace' } })).toBe('Ada Lovelace');
  expect(personName({ attributes: { first_name: 'Cher', last_name: null } })).toBe('Cher');
  expect(personName({ attributes: { first_name: '', last_name: '  ' } })).toBeNull();
  expect(personName(null)).toBeNull();
});

test('looks each person up once, from the Giving people endpoint, with the church token', async () => {
  get.mockImplementation(async (url: string) => person(idOf(url), `First${idOf(url)}`, `Last${idOf(url)}`));
  const names = await lookupPersonNames(CONFIG, ['11', '12', '11', '']);
  expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([
    'https://api.planningcenteronline.com/giving/v2/people/11',
    'https://api.planningcenteronline.com/giving/v2/people/12',
  ]);
  expect(get.mock.calls[0][1]).toBe(CONFIG);
  expect([...names.entries()].sort()).toEqual([
    ['11', 'First11 Last11'],
    ['12', 'First12 Last12'],
  ]);
});

test('a person no longer in Giving (404) is just blank; the others are still looked up', async () => {
  get.mockImplementation(async (url: string) => {
    if (idOf(url) === '2') throw httpError(404);
    return person(idOf(url), 'Name', idOf(url));
  });
  const names = await lookupPersonNames(CONFIG, ['1', '2', '3'], NO_RETRY);
  expect(names.get('1')).toBe('Name 1');
  expect(names.get('2')).toBeNull();
  expect(names.get('3')).toBe('Name 3');
  expect(log.warn).not.toHaveBeenCalled();
});

test('Planning Center failing stops the lookups, logs once, and returns what it has', async () => {
  let calls = 0;
  get.mockImplementation(async (url: string) => {
    calls += 1;
    if (calls === 2) throw httpError(401);
    return person(idOf(url), 'Name', idOf(url));
  });
  const names = await lookupPersonNames(CONFIG, ['1', '2', '3', '4', '5', '6'], { concurrency: 1, ...NO_RETRY });
  expect(calls).toBe(2);
  expect([...names.keys()]).toEqual(['1']);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0][0]).toMatch(/donor names/);
  expect(log.warn.mock.calls[0][1]).toMatchObject({ named: 1, wanted: 6, status: 401 });
});

test('a throttled call is retried (429 / 5xx) before giving up', async () => {
  let calls = 0;
  get.mockImplementation(async (url: string) => {
    calls += 1;
    if (calls === 1) throw httpError(429);
    return person(idOf(url), 'Name', idOf(url));
  });
  const names = await lookupPersonNames(CONFIG, ['1'], { retry: { retries: 2, sleep: async () => undefined } });
  expect(calls).toBe(2);
  expect(names.get('1')).toBe('Name 1');
});

test('never more than the concurrency limit in flight', async () => {
  let inFlight = 0;
  let most = 0;
  get.mockImplementation(async (url: string) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    return person(idOf(url), 'Name', idOf(url));
  });
  const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const names = await lookupPersonNames(CONFIG, ids, { concurrency: 3 });
  expect(names.size).toBe(12);
  expect(most).toBe(3);
});

test('at most `max` people per report; the rest stay blank and it is logged', async () => {
  get.mockImplementation(async (url: string) => person(idOf(url), 'Name', idOf(url)));
  const ids = Array.from({ length: 7 }, (_, i) => String(i + 1));
  const names = await lookupPersonNames(CONFIG, ids, { max: 5 });
  expect(get).toHaveBeenCalledTimes(5);
  expect(names.size).toBe(5);
  expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/more donors/), { wanted: 7, max: 5 });
});

test('nothing to look up, no calls', async () => {
  expect((await lookupPersonNames(CONFIG, [])).size).toBe(0);
  expect(get).not.toHaveBeenCalled();
});
