// `useSandbox` reads process.env at call time, so each case sets the environment then
// re-imports the module under jest.isolateModules to pick up fresh module-level bindings.
const withEnv = (env: Record<string, string | undefined>): boolean => {
  const prev = { NODE_ENV: process.env.NODE_ENV, QBO_USE_SANDBOX: process.env.QBO_USE_SANDBOX };
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  let result = false;
  jest.isolateModules(() => {
    result = require('../quickBookApi').useSandbox();
  });
  process.env.NODE_ENV = prev.NODE_ENV;
  if (prev.QBO_USE_SANDBOX === undefined) delete process.env.QBO_USE_SANDBOX;
  else process.env.QBO_USE_SANDBOX = prev.QBO_USE_SANDBOX;
  return result;
};

describe('explicit QBO_USE_SANDBOX wins over NODE_ENV', () => {
  test('sandbox stays on for a stack named production', () => {
    expect(withEnv({ NODE_ENV: 'production', QBO_USE_SANDBOX: 'true' })).toBe(true);
  });

  test('real QBO can be selected outside NODE_ENV=production', () => {
    expect(withEnv({ NODE_ENV: 'staging', QBO_USE_SANDBOX: 'false' })).toBe(false);
  });

  test('only the exact string "false" opts in to real QuickBooks', () => {
    // Anything ambiguous must fail safe to the sandbox rather than a customer's real books.
    expect(withEnv({ NODE_ENV: 'production', QBO_USE_SANDBOX: 'no' })).toBe(true);
    expect(withEnv({ NODE_ENV: 'production', QBO_USE_SANDBOX: '0' })).toBe(true);
    expect(withEnv({ NODE_ENV: 'production', QBO_USE_SANDBOX: 'FALSE' })).toBe(false);
  });
});

describe('falls back to the previous NODE_ENV behaviour when unset', () => {
  test('production means real QBO', () => {
    expect(withEnv({ NODE_ENV: 'production', QBO_USE_SANDBOX: undefined })).toBe(false);
  });

  test('staging and development mean sandbox', () => {
    expect(withEnv({ NODE_ENV: 'staging', QBO_USE_SANDBOX: undefined })).toBe(true);
    expect(withEnv({ NODE_ENV: 'development', QBO_USE_SANDBOX: undefined })).toBe(true);
  });

  test('an empty value is treated as unset', () => {
    expect(withEnv({ NODE_ENV: 'staging', QBO_USE_SANDBOX: '' })).toBe(true);
  });
});
