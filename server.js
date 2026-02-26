// micro provides http helpers
const { createError, json, send } = require('micro');
// microrouter provides http server routing
const { router, get, post } = require('microrouter');
// serve-handler serves static assets
const staticHandler = require('serve-handler');
// async-retry will retry failed API requests
const retry = require('async-retry');

// logger gives us insight into what's happening
const logger = require('./server/logger');
// schema validates incoming requests
const {
  validatePaymentPayload,
  validateCreateCardPayload,
} = require('./server/schema');
// square provides the API client and error types
const { SquareError, client: square } = require('./server/square');

async function createPayment(req, res) {
  const payload = await json(req);
  logger.debug(JSON.stringify(payload));
  // We validate the payload for specific fields. You may disable this feature
  // if you would prefer to handle payload validation on your own.
  if (!validatePaymentPayload(payload)) {
    throw createError(400, 'Bad Request');
  }

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Creating payment', { attempt });

      // Use amount from request payload (TOKYO BANH MI STAND menu selection)
      const amount = payload.amount != null ? BigInt(payload.amount) : 940n;
      const payment = {
        idempotencyKey: payload.idempotencyKey,
        locationId: payload.locationId,
        sourceId: payload.sourceId,
        amountMoney: {
          amount,
          currency: 'JPY',
        },
      };

      if (payload.customerId) {
        payment.customerId = payload.customerId;
      }

      // VerificationDetails is part of Secure Card Authentication.
      // This part of the payload is highly recommended (and required for some countries)
      // for 'unauthenticated' payment methods like Cards.
      if (payload.verificationToken) {
        payment.verificationToken = payload.verificationToken;
      }

      // Note for Square Dashboard: "商品名 / お名前 / 備考" (who ordered what)
      if (payload.customerName || payload.productName) {
        const productName = payload.productName || '注文';
        const customerName = payload.customerName || '（未入力）';
        const customerNotes = payload.customerNotes
          ? payload.customerNotes.trim()
          : '';
        payment.note = customerNotes
          ? `${productName} / ${customerName} / ${customerNotes}`
          : `${productName} / ${customerName}`;
      }

      const { payment: paymentResponse } =
        await square.payments.create(payment);
      logger.info('Payment succeeded!', { paymentResponse });

      send(res, 200, {
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
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(`Error creating payment on attempt ${attempt}: ${ex}`);
        throw ex; // to attempt retry
      }
    }
  });
}

async function storeCard(req, res) {
  const payload = await json(req);

  if (!validateCreateCardPayload(payload)) {
    throw createError(400, 'Bad Request');
  }

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Storing card', { attempt });

      const cardReq = {
        idempotencyKey: payload.idempotencyKey,
        sourceId: payload.sourceId,
        card: {
          customerId: payload.customerId,
        },
      };

      if (payload.verificationToken) {
        cardReq.verificationToken = payload.verificationToken;
      }

      const { result, statusCode } = await square.cardsApi.createCard(cardReq);

      logger.info('Store Card succeeded!', { result, statusCode });

      // cast 64-bit values to string
      // to prevent JSON serialization error during send method
      result.card.expMonth = result.card.expMonth.toString();
      result.card.expYear = result.card.expYear.toString();
      result.card.version = result.card.version.toString();

      send(res, statusCode, {
        success: true,
        card: result.card,
      });
    } catch (ex) {
      if (ex instanceof SquareError) {
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(
          `Error creating card-on-file on attempt ${attempt}: ${ex}`,
        );
        throw ex; // to attempt retry
      }
    }
  });
}

// serve static files like index.html and favicon.ico from public/ directory
async function serveStatic(req, res) {
  logger.debug('Handling request', req.path);
  await staticHandler(req, res, {
    public: 'public',
  });
}

// Adapter so Vercel-style api handlers (res.status().json()) work with micro's send()
function microAdapter(microRes) {
  let statusCode = 200;
  const headers = {};
  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(obj) {
      Object.entries(headers).forEach(([k, v]) => microRes.setHeader(k, v));
      send(microRes, statusCode, obj);
    },
    end() {
      if (!microRes.finished) {
        Object.entries(headers).forEach(([k, v]) => microRes.setHeader(k, v));
        microRes.statusCode = statusCode;
        microRes.end();
      }
    },
  };
}

// ローカル開発時: /api/config と /api/items を api/*.js のハンドラで処理（Vercel と共通）
async function handleApiConfig(req, res) {
  const adapter = microAdapter(res);
  const apiConfig = require('./api/config');
  await apiConfig(req, adapter);
}

async function handleApiItems(req, res) {
  const adapter = microAdapter(res);
  const apiItems = require('./api/items');
  await apiItems(req, adapter);
}

async function handleTerminalCheckout(req, res) {
  const adapter = microAdapter(res);
  const api = require('./api/terminal-checkout');
  await api(req, adapter);
}

async function handleTerminalCheckoutStatus(req, res) {
  const adapter = microAdapter(res);
  const api = require('./api/terminal-checkout-status');
  await api(req, adapter);
}

// export routes to be served by micro
module.exports = router(
  post('/payment', createPayment),
  post('/card', storeCard),
  get('/api/config', handleApiConfig),
  get('/api/items', handleApiItems),
  post('/api/terminal-checkout', handleTerminalCheckout),
  get('/api/terminal-checkout-status', handleTerminalCheckoutStatus),
  get('/*', serveStatic),
);
