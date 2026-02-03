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

const crypto = require('crypto');

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

  const amount_num = payload.amount != null ? Number(payload.amount) : 940;
  const location_id = process.env.LOCATION_ID || payload.locationId;
  const product_name = (payload.productName || 'レモングラスチキンバインミー').slice(0, 200);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SQUARE_REQUEST_TIMEOUT_MS);

  const square_headers = {
    'Square-Version': SQUARE_API_VERSION,
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. 注文の作成 POST /v2/orders
    const order_idempotency_key = crypto.randomUUID();
    const order_body = {
      idempotency_key: order_idempotency_key,
      order: {
        location_id,
        line_items: [
          {
            name: product_name,
            quantity: '1',
            base_price_money: { amount: amount_num, currency: 'JPY' },
          },
        ],
      },
    };

    const order_res = await fetch(`${SQUARE_BASE_URL}/v2/orders`, {
      method: 'POST',
      headers: square_headers,
      body: JSON.stringify(order_body),
      signal: controller.signal,
    });
    const order_data = await order_res.json();

    if (!order_res.ok) {
      clearTimeout(timeoutId);
      const err_body = order_data.errors ? { errors: order_data.errors } : { error: order_data.message || 'Order creation failed' };
      res.status(order_res.status).json(err_body);
      return;
    }

    const order_id = order_data.order?.id;
    if (!order_id) {
      clearTimeout(timeoutId);
      res.status(500).json({ error: 'Order created but no order id in response' });
      return;
    }

    // 2. 支払いの作成 POST /v2/payments（order_id を付与）
    const payment_body = {
      idempotency_key: payload.idempotencyKey,
      location_id: payload.locationId,
      source_id: payload.sourceId,
      amount_money: { amount: amount_num, currency: 'JPY' },
      order_id,
    };

    if (payload.customerId) payment_body.customer_id = payload.customerId;
    if (payload.verificationToken) payment_body.verification_token = payload.verificationToken;

    if (payload.customerName || payload.productName) {
      const customer_name = (payload.customerName || '（未入力）').slice(0, 100);
      const customer_notes = (payload.customerNotes || '').trim().slice(0, 200);
      const note = customer_notes
        ? `${product_name} / ${customer_name} / ${customer_notes}`
        : `${product_name} / ${customer_name}`;
      payment_body.note = note.slice(0, 500);
    }

    const payment_res = await fetch(`${SQUARE_BASE_URL}/v2/payments`, {
      method: 'POST',
      headers: square_headers,
      body: JSON.stringify(payment_body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const payment_data = await payment_res.json();

    if (!payment_res.ok) {
      const err_body = payment_data.errors ? { errors: payment_data.errors } : { error: payment_data.message || 'Payment failed' };
      res.status(payment_res.status).json(err_body);
      return;
    }

    const payment_response = payment_data.payment;
    res.status(200).json({
      success: true,
      payment: {
        id: payment_response.id,
        status: payment_response.status,
        receiptUrl: payment_response.receipt_url,
        orderId: payment_response.order_id,
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
