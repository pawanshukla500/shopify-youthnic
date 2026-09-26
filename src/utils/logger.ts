import winston from 'winston';
import { config } from '../config';

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'shopify-oms' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const ts = info.timestamp;
          const level = info.level;
          const msg = info.message;
          const meta = Object.keys(info)
            .filter((k) => !['timestamp', 'level', 'message', 'service'].includes(k))
            .reduce((obj, k) => {
              obj[k] = info[k];
              return obj;
            }, {} as Record<string, unknown>);
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${ts} [${level}]: ${msg}${metaStr}`;
        })
      ),
    }),
  ],
});

export default logger;
