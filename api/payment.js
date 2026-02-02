// Vercel Serverless Function: POST /api/payment
const retry = require('async-retry');
const {
  validatePaymentPayload,
} = require('../server/schema');
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

  if (!validatePaymentPayload(payload)) {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  try {
    await retry(async (bail, attempt) => {
      try {
        const amount = payload.amount != null ? BigInt(payload.amount) : 940n;
        const payment = {
          idempotencyKey: payload.idempotencyKey,
          locationId: payload.locationId,
          sourceId: payload.sourceId,
          amountMoney: { amount, currency: 'JPY' },
        };

        if (payload.customerId) payment.customerId = payload.customerId;
        if (payload.verificationToken) payment.verificationToken = payload.verificationToken;

        if (payload.customerName || payload.productName) {
          const productName = payload.productName || '注文';
          const customerName = payload.customerName || '（未入力）';
          const customerNotes = payload.customerNotes ? payload.customerNotes.trim() : '';
          payment.note = customerNotes
            ? `${productName} / ${customerName} / ${customerNotes}`
            : `${productName} / ${customerName}`;
        }

        const { payment: paymentResponse } = await square.payments.create(payment);

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
        if (ex instanceof SquareError) {
          bail(ex);
        } else {
          throw ex;
        }
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
