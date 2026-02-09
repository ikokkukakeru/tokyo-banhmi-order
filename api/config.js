// Vercel Serverless Function: GET /api/config
// Square の環境・アプリID・ロケーションID・Square.js URL を返す（本番/サンドボックス切り替え用）

const is_sandbox = process.env.SQUARE_ENVIRONMENT === 'sandbox';

const application_id =
  process.env.SQUARE_APPLICATION_ID ||
  process.env.APPLICATION_ID ||
  (is_sandbox ? 'sandbox-sq0idb-oKEv1VNR-uF3ECUHWG5WCA' : '');

const location_id =
  process.env.LOCATION_ID ||
  (is_sandbox ? 'LSB41KX7QNYRJ' : '');

const square_js_url = is_sandbox
  ? 'https://sandbox.web.squarecdn.com/v1/square.js'
  : 'https://web.squarecdn.com/v1/square.js';

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

  res.status(200).json({
    squareEnvironment: is_sandbox ? 'sandbox' : 'production',
    applicationId: application_id,
    locationId: location_id,
    squareJsUrl: square_js_url,
  });
};
