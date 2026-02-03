// Vercel Serverless Function: GET /api/items
// Square Catalog API を fetch で呼び出し、商品（ITEM）一覧を返す

BigInt.prototype.toJSON = function () {
  return this.toString();
};

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

  if (!SQUARE_ACCESS_TOKEN) {
    console.error('SQUARE_ACCESS_TOKEN is not set.');
    res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' });
    return;
  }

  try {
    const url = `${SQUARE_BASE_URL}/v2/catalog/list?types=ITEM`;
    const square_res = await fetch(url, {
      method: 'GET',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await square_res.json();

    if (!square_res.ok) {
      console.error('Square Catalog API error:', square_res.status, data);
      res.status(500).json(data);
      return;
    }

    res.status(200).json(data);
  } catch (ex) {
    console.error('Square Catalog API error:', ex);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
