import { requireAutomationKey } from '../automationAuth';

const VALID_KEY = 'super_secret_automation_key';

const makeRes = () => {
  const res: any = {
    statusCode: undefined,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.payload = body;
      return this;
    },
  };
  return res;
};

const makeReq = (headerValue?: string) => {
  const headers: Record<string, string> = {};
  if (headerValue !== undefined) {
    headers['x-automation-key'] = headerValue;
  }
  return { headers } as any;
};

describe('requireAutomationKey', () => {
  const originalKey = process.env.AUTOMATION_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AUTOMATION_API_KEY;
    } else {
      process.env.AUTOMATION_API_KEY = originalKey;
    }
  });

  test('returns 500 and does not call next when env key is unset', () => {
    delete process.env.AUTOMATION_API_KEY;
    const req = makeReq(VALID_KEY);
    const res = makeRes();
    const next = jest.fn();

    requireAutomationKey(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({ success: false, message: 'Automation API key not configured' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 and does not call next when header is missing', () => {
    process.env.AUTOMATION_API_KEY = VALID_KEY;
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    requireAutomationKey(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ success: false, message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 and does not call next when header is wrong', () => {
    process.env.AUTOMATION_API_KEY = VALID_KEY;
    const req = makeReq('wrong_key');
    const res = makeRes();
    const next = jest.fn();

    requireAutomationKey(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ success: false, message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next once and sends no status when header is correct', () => {
    process.env.AUTOMATION_API_KEY = VALID_KEY;
    const req = makeReq(VALID_KEY);
    const res = makeRes();
    const next = jest.fn();

    requireAutomationKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
    expect(res.payload).toBeUndefined();
  });
});
