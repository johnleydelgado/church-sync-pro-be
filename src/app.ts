/* eslint-disable @typescript-eslint/no-var-requires */
import express from 'express';
import routes from './routes';
import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
const supertokens = require('supertokens-node');
import { buildSupertokensConfig, apiDomain, websiteDomain } from './supertokensConfig';
const { middleware, errorHandler } = require('supertokens-node/framework/express');

// Boot diagnostics only. The SuperTokens apiKey must never be logged - Cloud Run
// log entries are readable by anyone with project viewer access.
console.log('supertokens config', { apiDomain, websiteDomain, apiKeyConfigured: Boolean(process.env.API_KEYS) });

supertokens.init(buildSupertokensConfig());

const app = express();

interface errorObj extends Error {
  name: string;
  stack: any;
}

app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));
app.use(
  cors({
    origin: websiteDomain,
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  }),
);
app.use(middleware());

// your own error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log('ERROR SUPER TOKEN: ', err);
});

app.use('/csp', routes);

// cron.schedule('*/5 * * * *', () => {
//   // This function will run every minute
//   getallUsers();
//   console.log('Running cron job...');
// });

app.use((err: errorObj, req: Request, res: Response, next: NextFunction) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(401).send(err.message);
  }

  if (err) {
    console.log(err.stack || err);
    return res.status(500).send(err.message);
  }

  return next();
});

export default app;
