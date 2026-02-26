// Vercel Serverless: GET /api/terminal-checkout-status?checkout_id=xxx
// ターミナルチェックアウトの状態を取得（ポーリング用）

const config = require('../server/config');

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || config.SQUARE_ACCESS_TOKEN;

const SQUARE_BASE_URL =
  process.env.SQUARE_ENVIRONMENT === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

const SQUARE_API_VERSION = '2024-11-20';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const checkout_id =
    (req.query && req.query.checkout_id) ||
    (req.url ? new URL(req.url, 'http://localhost').searchParams.get('checkout_id') : null);

  if (!checkout_id) {
    res.status(400).json({ error: 'checkout_id is required' });
    return;
  }

  if (!SQUARE_ACCESS_TOKEN) {
    res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' });
    return;
  }

  try {
    const square_res = await fetch(
      `${SQUARE_BASE_URL}/v2/terminals/checkouts/${encodeURIComponent(checkout_id)}`,
      {
        method: 'GET',
        headers: {
          'Square-Version': SQUARE_API_VERSION,
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const data = await square_res.json();

    if (!square_res.ok) {
      res.status(square_res.status).json(data.errors ? { errors: data.errors } : { error: data.message || 'Failed' });
      return;
    }

    const checkout = data.checkout;
    res.status(200).json({
      status: checkout?.status,
      orderId: checkout?.order_id,
      paymentIds: checkout?.payment_ids || [],
    });
  } catch (ex) {
    console.error('Terminal checkout status error:', ex);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
