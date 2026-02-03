// Vercel Serverless Function: POST /api/payment
// Square SDK を使わず API 直接呼び出しで V1_ERROR を回避

const retry = require('async-retry');
const { validatePaymentPayload } = require('../server/schema');
const config = require('../server/config');

// Vercel では process.env を直接参照（config は .env ファイル前提のため）
const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || config.SQUARE_ACCESS_TOKEN;

// Vercel では NODE_ENV=production になるため、Sandbox を使う場合は明示する
const useSandbox =
  process.env.SQUARE_ENVIRONMENT === 'sandbox' ||
  (process.env.NODE_ENV !== 'production' && process.env.SQUARE_ENVIRONMENT !== 'production');

const SQUARE_BASE = useSandbox
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

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
    console.error('SQUARE_ACCESS_TOKEN is not set. Set it in Vercel: Project → Settings → Environment Variables.');
    res.status(500).json({
      error: 'SQUARE_ACCESS_TOKEN not configured',
      hint: 'Vercel の Project → Settings → Environment Variables で SQUARE_ACCESS_TOKEN を設定し、再デプロイしてください。',
    });
    return;
  }

  const amountNum = payload.amount != null ? Number(payload.amount) : 940;
  const squareBody = {
    source_id: payload.sourceId,
    idempotency_key: payload.idempotencyKey,
    location_id: payload.locationId,
    amount_money: { amount: amountNum, currency: 'JPY' },
  };

  if (payload.customerId) squareBody.customer_id = payload.customerId;
  if (payload.verificationToken) squareBody.verification_token = payload.verificationToken;

  if (payload.customerName || payload.productName) {
    const productName = (payload.productName || '注文').slice(0, 200);
    const customerName = (payload.customerName || '（未入力）').slice(0, 100);
    const customerNotes = (payload.customerNotes || '').trim().slice(0, 200);
    const note = customerNotes
      ? `${productName} / ${customerName} / ${customerNotes}`
      : `${productName} / ${customerName}`;
    squareBody.note = note.slice(0, 500);
  }

  try {
    await retry(async (bail, attempt) => {
      const response = await fetch(`${SQUARE_BASE}/v2/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(squareBody),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('Square API error:', response.status, data);
        const err = new Error(data.message || 'Payment failed');
        err.statusCode = response.status;
        err.errors = data.errors;
        bail(err);
        return;
      }

      const payment = data.payment;
      res.status(200).json({
        success: true,
        payment: {
          id: payment.id,
          status: payment.status,
          receiptUrl: payment.receipt_url,
          orderId: payment.order_id,
        },
      });
    });
  } catch (ex) {
    const status = ex.statusCode || 400;
    const body = ex.errors ? { errors: ex.errors } : { error: ex.message || 'Payment failed' };
    res.status(status).json(body);
  }
};
