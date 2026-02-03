// Vercel Serverless Function: POST /api/payment
// Square REST API を直接 fetch で呼び出し（サーバーレスで SDK がハングする問題を回避）

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const { validatePaymentPayload } = require('../server/schema');
const config = require('../server/config');

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || config.SQUARE_ACCESS_TOKEN;

const SQUARE_BASE_URL =
  process.env.SQUARE_ENVIRONMENT === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

const SQUARE_API_VERSION = '2024-11-20';
const SQUARE_REQUEST_TIMEOUT_MS = 20000;

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
  const body = {
    idempotency_key: payload.idempotencyKey,
    location_id: payload.locationId,
    source_id: payload.sourceId,
    amount_money: { amount: amountNum, currency: 'JPY' },
  };

  if (payload.customerId) body.customer_id = payload.customerId;
  if (payload.verificationToken) body.verification_token = payload.verificationToken;

  if (payload.customerName || payload.productName) {
    const productName = (payload.productName || '注文').slice(0, 200);
    const customerName = (payload.customerName || '（未入力）').slice(0, 100);
    const customerNotes = (payload.customerNotes || '').trim().slice(0, 200);
    const note = customerNotes
      ? `${productName} / ${customerName} / ${customerNotes}`
      : `${productName} / ${customerName}`;
    body.note = note.slice(0, 500);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SQUARE_REQUEST_TIMEOUT_MS);

  try {
    const squareRes = await fetch(`${SQUARE_BASE_URL}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await squareRes.json();

    if (!squareRes.ok) {
      const status = squareRes.status;
      const errBody = data.errors ? { errors: data.errors } : { error: data.message || 'Payment failed' };
      res.status(status).json(errBody);
      return;
    }

    const paymentResponse = data.payment;
    res.status(200).json({
      success: true,
      payment: {
        id: paymentResponse.id,
        status: paymentResponse.status,
        receiptUrl: paymentResponse.receipt_url,
        orderId: paymentResponse.order_id,
      },
    });
  } catch (ex) {
    clearTimeout(timeoutId);
    if (ex.name === 'AbortError') {
      res.status(504).json({
        error: '通信がタイムアウトしました。しばらくして再度お試しください。',
      });
      return;
    }
    console.error('Square API error:', ex);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
