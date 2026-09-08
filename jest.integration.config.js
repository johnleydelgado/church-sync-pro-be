/**
 * Integration tests: the real sync engine against a real Postgres, with Planning Center
 * and QuickBooks faked. Separate from the unit suite because it needs a database.
 *
 *   docker run -d --name csp-test-pg -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=1234 \
 *     -e POSTGRES_DB=csp_test -p 55433:5432 postgres:15
 *   npx sequelize-cli db:migrate --url postgres://admin:1234@127.0.0.1:55433/csp_test \
 *     --migrations-path src/db/migrations
 *   npm run test:integration
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.integration.test.ts'],
  testTimeout: 30000,
  maxWorkers: 1, // shared database
};
