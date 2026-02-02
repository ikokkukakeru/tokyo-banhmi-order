// Vercel Serverless Function: POST /api/card
const retry = require('async-retry');
const { validateCreateCardPayload } = require('../server/schema');
const { SquareError, client: square } = require('../server/square');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  if (!validateCreateCardPayload(payload)) {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  try {
    await retry(async (bail, attempt) => {
      try {
        const cardReq = {
          idempotencyKey: payload.idempotencyKey,
          sourceId: payload.sourceId,
          card: { customerId: payload.customerId },
        };
        if (payload.verificationToken) cardReq.verificationToken = payload.verificationToken;

        const { result, statusCode } = await square.cardsApi.createCard(cardReq);

        result.card.expMonth = result.card.expMonth.toString();
        result.card.expYear = result.card.expYear.toString();
        result.card.version = result.card.version.toString();

        res.status(statusCode).json({ success: true, card: result.card });
      } catch (ex) {
        if (ex instanceof SquareError) bail(ex);
        else throw ex;
      }
    });
  } catch (ex) {
    if (ex instanceof SquareError && ex.errors) {
      res.status(400).json({ errors: ex.errors });
    } else {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};
