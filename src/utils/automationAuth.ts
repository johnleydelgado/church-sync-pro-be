import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Express middleware protecting the all-tenant automation endpoints with a shared secret.
 *
 * Fails closed: if AUTOMATION_API_KEY is not configured on the server, every request is
 * rejected with 500 rather than being allowed through. Otherwise the provided
 * `x-automation-key` header is compared against the expected key using a timing-safe
 * comparison to avoid leaking the secret through response-time differences.
 */
export const requireAutomationKey = (req: Request, res: Response, next: NextFunction): void => {
  const expectedKey = process.env.AUTOMATION_API_KEY;

  if (!expectedKey) {
    res.status(500).json({ success: false, message: 'Automation API key not configured' });
    return;
  }

  const providedHeader = req.headers['x-automation-key'];
  const providedKey = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;

  if (typeof providedKey !== 'string' || providedKey.length === 0) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  const expectedBuffer = Buffer.from(expectedKey);
  const providedBuffer = Buffer.from(providedKey);

  // timingSafeEqual throws if the buffers differ in length, so guard first.
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  next();
};
