// Vercel Serverless Function: POST /api/payment
// Square SDK を使用（config の SQUARE_ENVIRONMENT で Sandbox を指定可能）

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const retry = require('async-retry');
const { validatePaymentPayload } = require('../server/schema');
const { SquareError, client: square } = require('../server/square');
const config = require('../server/config');

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || config.SQUARE_ACCESS_TOKEN;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function getParsedBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = await readBody(req);
  return JSON.parse(raw || '{}');
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
    payload = await getParsedBody(req);
  } catch {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  console.log('Body:', payload);

  if (!validatePaymentPayload(payload)) {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  if (!SQUARE_ACCESS_TOKEN) {
    console.error('SQUARE_ACCESS_TOKEN is not set.');
    res.status(500).json({
      error: 'SQUARE_ACCESS_TOKEN not configured',
      hint: 'Vercel の Project → Settings → Environment Variables で SQUARE_ACCESS_TOKEN を設定し、再デプロイしてください。',
    });
    return;
  }

  const amountNum = payload.amount != null ? Number(payload.amount) : 940;
  const payment = {
    idempotencyKey: payload.idempotencyKey,
    locationId: payload.locationId,
    sourceId: payload.sourceId,
    amountMoney: { amount: amountNum, currency: 'JPY' },
  };

  if (payload.customerId) payment.customerId = payload.customerId;
  if (payload.verificationToken) payment.verificationToken = payload.verificationToken;

  if (payload.customerName || payload.productName) {
    const productName = (payload.productName || '注文').slice(0, 200);
    const customerName = (payload.customerName || '（未入力）').slice(0, 100);
    const customerNotes = (payload.customerNotes || '').trim().slice(0, 200);
    const note = customerNotes
      ? `${productName} / ${customerName} / ${customerNotes}`
      : `${productName} / ${customerName}`;
    payment.note = note.slice(0, 500);
  }

  const SQUARE_REQUEST_TIMEOUT_MS = 20000;

  try {
    await retry(async (bail, attempt) => {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('SQUARE_TIMEOUT')), SQUARE_REQUEST_TIMEOUT_MS);
        });
        const createPromise = square.payments.create(payment);
        const { payment: paymentResponse } = await Promise.race([
          createPromise,
          timeoutPromise,
        ]);

        res.status(200).json({
          success: true,
          payment: {
            id: paymentResponse.id,
            status: paymentResponse.status,
            receiptUrl: paymentResponse.receiptUrl,
            orderId: paymentResponse.orderId,
          },
        });
      } catch (ex) {
        if (ex instanceof SquareError) bail(ex);
        if (ex && ex.message === 'SQUARE_TIMEOUT') {
          bail(Object.assign(new Error('Payment request timed out'), { statusCode: 504 }));
        } else {
          throw ex;
        }
      }
    });
  } catch (ex) {
    if (ex instanceof SquareError) {
      const status = ex.statusCode || 400;
      const body = ex.errors ? { errors: ex.errors } : { error: ex.message || 'Payment failed' };
      res.status(status).json(body);
    } else if (ex && ex.statusCode === 504) {
      res.status(504).json({
        error: '通信がタイムアウトしました。しばらくして再度お試しください。',
      });
    } else {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};
