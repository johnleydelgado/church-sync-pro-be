/**
 * httpRetry — small, dependency-free retry/backoff helper for outbound HTTP calls
 * (axios + Stripe SDK). Retries only transient failures (network errors, 429, 5xx)
 * with exponential backoff + jitter, honoring `Retry-After` on 429 responses.
 */

export interface RetryInfo {
  /** Zero-based attempt index that just failed (0 = first attempt). */
  attempt: number;
  /** Delay (ms) that will be waited before the next attempt. */
  delayMs: number;
  /** The error that triggered the retry. */
  error: unknown;
}

export interface WithRetryOptions {
  /** Number of retries after the initial attempt. Default 3 (=> up to 4 total calls). */
  retries?: number;
  /** Base backoff in ms. Default 300. */
  baseMs?: number;
  /** Max backoff cap in ms. Default 5000. */
  maxMs?: number;
  /** Decide whether a given error is retryable. Defaults to `defaultIsRetryable`. */
  isRetryable?: (err: unknown) => boolean;
  /** Called right before sleeping for a retry. */
  onRetry?: (info: RetryInfo) => void;
  /** Sleep implementation (injectable for deterministic tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source in [0, 1) for jitter (injectable for deterministic tests). Default Math.random. */
  random?: () => number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_MS = 300;
const DEFAULT_MAX_MS = 5000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pull an HTTP status code out of an error regardless of source:
 * - axios:  err.response.status
 * - Stripe: err.statusCode (or err.status)
 */
const getStatus = (err: any): number | undefined => {
  if (err == null) return undefined;
  return err?.response?.status ?? err?.statusCode ?? err?.status;
};

/** True if the error has no HTTP response at all (network/connection error). */
const isNetworkError = (err: any): boolean => {
  if (err == null) return false;
  // axios marks transport-level failures with a request but no response.
  if (err.request && !err.response && getStatus(err) === undefined) return true;
  const code = err?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED'
  );
};

/**
 * Default retry predicate: retry on network errors and HTTP 429 / 5xx.
 * Never retry other 4xx.
 */
export const defaultIsRetryable = (err: unknown): boolean => {
  const status = getStatus(err);
  if (status === undefined) return isNetworkError(err);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
};

/** Read a `Retry-After` header (seconds) off an axios/Stripe-style error, in ms. */
const getRetryAfterMs = (err: any): number | undefined => {
  const headers = err?.response?.headers ?? err?.headers;
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isNaN(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
};

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Resolves with `fn`'s value, or throws the last error after exhausting retries.
 */
export const withRetry = async <T>(fn: () => Promise<T>, opts: WithRetryOptions = {}): Promise<T> => {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const hasRetriesLeft = attempt < retries;
      if (!hasRetriesLeft || !isRetryable(err)) {
        throw err;
      }

      // Honor Retry-After on 429; otherwise exponential backoff with jitter.
      const status = getStatus(err);
      const retryAfterMs = status === 429 ? getRetryAfterMs(err) : undefined;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + random() / 2);
      const delayMs = retryAfterMs ?? backoff;

      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw lastError;
};

export default withRetry;
