import { withRetry, defaultIsRetryable } from '../httpRetry';

/** Instant sleep so tests don't actually wait on timers. */
const instantSleep = jest.fn(async (_ms: number) => {});

/** Build an axios-style error with a response status (+ optional headers). */
const axiosError = (status: number, headers?: Record<string, string>) => ({
  isAxiosError: true,
  response: { status, headers: headers ?? {} },
});

/** Build a Stripe-style error with statusCode. */
const stripeError = (statusCode: number) => ({ statusCode, type: 'StripeAPIError' });

/** Build a network-style error (no response). */
const networkError = () => ({ request: {}, code: 'ECONNRESET', message: 'socket hang up' });

beforeEach(() => {
  instantSleep.mockClear();
});

describe('withRetry', () => {
  it('resolves on the first try and calls fn once', async () => {
    const fn = jest.fn(async () => 'ok');

    await expect(withRetry(fn, { sleep: instantSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(instantSleep).not.toHaveBeenCalled();
  });

  it('retries a 429 twice then succeeds (fn called 3 times)', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(axiosError(429))
      .mockRejectedValueOnce(axiosError(429))
      .mockResolvedValueOnce('done');

    await expect(withRetry(fn, { sleep: instantSleep })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(instantSleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 400 (fn called once, throws)', async () => {
    const err = axiosError(400);
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep: instantSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(instantSleep).not.toHaveBeenCalled();
  });

  it('exhausts retries on persistent 500 (retries + 1 calls, throws last error)', async () => {
    const err = axiosError(500);
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { retries: 3, sleep: instantSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(instantSleep).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After header on a 429 as the delay for that attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(axiosError(429, { 'retry-after': '2' })) // 2s => 2000ms
      .mockResolvedValueOnce('recovered');

    await expect(withRetry(fn, { sleep: instantSleep })).resolves.toBe('recovered');
    expect(instantSleep).toHaveBeenCalledTimes(1);
    expect(instantSleep).toHaveBeenCalledWith(2000);
  });

  it('retries network errors (no response)', async () => {
    const fn = jest.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce('up');

    await expect(withRetry(fn, { sleep: instantSleep })).resolves.toBe('up');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses injected random for deterministic backoff (no Retry-After)', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosError(503)).mockResolvedValueOnce('ok');

    // random = 0 => factor (0.5 + 0/2) = 0.5; baseMs 300 * 2^0 = 300 => 150ms
    await withRetry(fn, { sleep: instantSleep, random: () => 0, baseMs: 300 });
    expect(instantSleep).toHaveBeenCalledWith(150);
  });
});

describe('defaultIsRetryable', () => {
  it('returns true for 429, 500, 502, 503', () => {
    expect(defaultIsRetryable(axiosError(429))).toBe(true);
    expect(defaultIsRetryable(axiosError(500))).toBe(true);
    expect(defaultIsRetryable(axiosError(502))).toBe(true);
    expect(defaultIsRetryable(stripeError(503))).toBe(true);
  });

  it('returns false for non-429 4xx', () => {
    expect(defaultIsRetryable(axiosError(400))).toBe(false);
    expect(defaultIsRetryable(axiosError(401))).toBe(false);
    expect(defaultIsRetryable(axiosError(404))).toBe(false);
    expect(defaultIsRetryable(stripeError(403))).toBe(false);
  });

  it('returns true for network errors', () => {
    expect(defaultIsRetryable(networkError())).toBe(true);
  });
});
