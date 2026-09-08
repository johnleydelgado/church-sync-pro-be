import { Sequelize } from 'sequelize';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enVariables = require('./config/config.json');

const env = process.env.NODE_ENV || 'development';

// The integration tests run against a throwaway Postgres, not any configured environment.
// Built from the environment rather than config.json, which is gitignored because it holds
// real credentials - so a checkout without it can still run the tests.
const testConfig = {
  username: process.env.TEST_DB_USER || 'admin',
  password: process.env.TEST_DB_PASSWORD || '1234',
  database: process.env.TEST_DB_NAME || 'csp_test',
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 55433),
  dialect: 'postgres',
  logging: false,
};

const config = env === 'test' ? testConfig : enVariables[env];
const sequelize = new Sequelize(config.database, config.username, config.password, config);

export default sequelize;
