// Vercel Serverless: POST /api/terminal-checkout
// 注文を作成し、Square Terminal にチェックアウトを送信（店頭でカード決済）

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const { validatePaymentPayload } = require('../server/schema');
const config = require('../server/config');

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || config.SQUARE_ACCESS_TOKEN;
const SQUARE_TERMINAL_DEVICE_ID =
  process.env.SQUARE_TERMINAL_DEVICE_ID || '';

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
    req.on('data', (chunk) => {
      body += chunk;
    });
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

  // ターミナル用: sourceId は不要。amount, locationId は必須
  if (
    payload.amount == null ||
    !payload.locationId
  ) {
    res.status(400).json({ error: 'Bad Request', detail: 'amount and locationId are required' });
    return;
  }

  if (!SQUARE_ACCESS_TOKEN) {
    res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' });
    return;
  }

  if (!SQUARE_TERMINAL_DEVICE_ID) {
    res.status(500).json({
      error: 'SQUARE_TERMINAL_DEVICE_ID not configured',
      hint: 'Vercel / .env.sandbox に SQUARE_TERMINAL_DEVICE_ID（ターミナル端末の device_id）を設定してください。',
    });
    return;
  }

  const amount_num = Number(payload.amount) || 940;
  const location_id = process.env.LOCATION_ID || payload.locationId;
  const catalog_object_id = payload.catalog_object_id
    ? String(payload.catalog_object_id).trim()
    : null;
  const product_name = (payload.productName || 'バインミー').slice(0, 200);
  const pickup_display_name = (payload.customerName || 'Customer').slice(0, 100);

  const square_headers = {
    'Square-Version': SQUARE_API_VERSION,
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SQUARE_REQUEST_TIMEOUT_MS);

  try {
    // 1. 注文作成（payment.js と同じ）
    const order_idempotency_key = crypto.randomUUID();
    let order_line_items;

    if (Array.isArray(payload.line_items) && payload.line_items.length > 0) {
      order_line_items = payload.line_items.map((item) => {
        const id_from_item =
          item.catalog_object_id ||
          item.catalogObjectId ||
          item.variationId ||
          item.variation_id;
        const quantity = String(item.quantity != null ? item.quantity : '1');
        if (id_from_item) {
          return { catalog_object_id: String(id_from_item), quantity };
        }
        return {
          name: (item.name || product_name).slice(0, 512),
          quantity,
          base_price_money: {
            amount: Number(item.base_price_money?.amount ?? amount_num),
            currency: item.base_price_money?.currency || 'JPY',
          },
        };
      });
    } else if (catalog_object_id) {
      order_line_items = [{ catalog_object_id, quantity: '1' }];
    } else {
      order_line_items = [
        {
          name: product_name,
          quantity: '1',
          base_price_money: { amount: amount_num, currency: 'JPY' },
        },
      ];
    }

    const order_body = {
      idempotency_key: order_idempotency_key,
      order: {
        location_id,
        line_items: order_line_items,
        fulfillments: [
          {
            type: 'PICKUP',
            state: 'PROPOSED',
            pickup_details: {
              recipient: { display_name: pickup_display_name },
              pickup_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
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
      res
        .status(order_res.status)
        .json(order_data.errors ? { errors: order_data.errors } : { error: order_data.message || 'Order creation failed' });
      return;
    }

    const order_id = order_data.order?.id;
    if (!order_id) {
      clearTimeout(timeoutId);
      res.status(500).json({ error: 'Order created but no order id in response' });
      return;
    }

    // 2. Terminal Checkout 作成（ターミナルに送信）
    const checkout_idempotency = crypto.randomUUID().slice(0, 64);
    const customer_name = (payload.customerName || '（未入力）').slice(0, 100);
    const customer_notes = (payload.customerNotes || '').trim().slice(0, 200);
    const note = customer_notes
      ? `${product_name} / ${customer_name} / ${customer_notes}`
      : `${product_name} / ${customer_name}`;

    const checkout_body = {
      idempotency_key: checkout_idempotency,
      checkout: {
        amount_money: { amount: amount_num, currency: 'JPY' },
        order_id,
        reference_id: order_id.slice(-8),
        note: note.slice(0, 500),
        device_options: {
          device_id: SQUARE_TERMINAL_DEVICE_ID,
          show_itemized_cart: true,
        },
      },
    };

    const term_res = await fetch(`${SQUARE_BASE_URL}/v2/terminals/checkouts`, {
      method: 'POST',
      headers: square_headers,
      body: JSON.stringify(checkout_body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const term_data = await term_res.json();

    if (!term_res.ok) {
      res
        .status(term_res.status)
        .json(term_data.errors ? { errors: term_data.errors } : { error: term_data.message || 'Terminal checkout failed' });
      return;
    }

    const checkout_id = term_data.checkout?.id;
    const status = term_data.checkout?.status || 'PENDING';

    res.status(200).json({
      success: true,
      checkoutId: checkout_id,
      orderId: order_id,
      status,
    });
  } catch (ex) {
    clearTimeout(timeoutId);
    if (ex.name === 'AbortError') {
      res.status(504).json({ error: 'Request timed out' });
      return;
    }
    console.error('Terminal checkout error:', ex);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
