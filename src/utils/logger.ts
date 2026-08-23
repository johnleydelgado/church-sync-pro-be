/* eslint-disable @typescript-eslint/no-var-requires */
const winston = require('winston');

/**
 * Shared structured logger.
 *
 * Previously each module that wanted logging created its own winston instance inline,
 * so config drifted and most of the codebase fell back to console.log. One factory
 * keeps level, format and transport consistent, and `module` makes entries greppable
 * in Cloud Run.
 */
export const createLogger = (moduleName: string) =>
  winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    defaultMeta: { module: moduleName },
    transports: [new winston.transports.Console()],
  });

export default createLogger;
