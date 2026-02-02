const { config } = require('dotenv');

const logger = require('./logger');

// package.json sets NODE_ENV in its scripts
const isProduction = process.env.NODE_ENV === 'production';

// load configuration based on environment
const { error, parsed } = config({
  path: isProduction ? '.env.production' : '.env.sandbox',
});

if (error) {
  // likely file missing
  logger.error(`Error loading configuration: ${error}`);
}

// PROTIP: get more insight by running in debug mode: `DEBUG=* npm run dev`
logger.debug('Parsed configuration:', parsed);

// export secrets: from .env file when present, else from process.env (e.g. Vercel)
module.exports = {
  ...(parsed || {}),
  // Vercel etc.: use process.env when no .env file
  SQUARE_ACCESS_TOKEN: parsed?.SQUARE_ACCESS_TOKEN ?? process.env.SQUARE_ACCESS_TOKEN,
  isProduction,
};
