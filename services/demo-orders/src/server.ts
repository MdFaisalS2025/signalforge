import Fastify, { FastifyInstance } from 'fastify';
import { validateOrderRequest } from './validation.js';
import { PaymentsClientError } from './paymentsClient.js';
import type { PaymentsClient } from './paymentsClient.js';
import { recordHttpRequest } from './metrics.js';
import { logEvent } from './logger.js';

const ORDERS_ROUTE = '/orders';

function extractOrderId(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'order_id' in body) {
    const value = (body as Record<string, unknown>).order_id;
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

export function buildServer(deps: { paymentsClient: PaymentsClient }): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/orders', async (request, reply) => {
    const start = process.hrtime.bigint();
    const recordOutcome = (statusCode: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      recordHttpRequest(ORDERS_ROUTE, 'POST', statusCode, durationSeconds);
    };

    const result = validateOrderRequest(request.body);
    if (!result.ok) {
      recordOutcome(400);
      // Never invent a real order_id for a rejected request, and never log
      // the raw request body — only the order_id field, if it happened to
      // be a string, plus the validation failure reason.
      logEvent('warn', 'order request validation failed', { order_id: extractOrderId(request.body), reason: result.message });
      return reply.code(400).send({ error: 'invalid_request', message: result.message });
    }

    const { order_id, amount_cents } = result.value;
    logEvent('info', 'request received', { order_id });

    try {
      await deps.paymentsClient.charge(order_id, amount_cents);
    } catch (err) {
      if (err instanceof PaymentsClientError) {
        recordOutcome(502);
        // No error cause or stack trace is logged — only order_id and the
        // documented outcome status code.
        logEvent('error', 'payment failed', { order_id, status_code: 502 });
        return reply.code(502).send({ order_id, status: 'failed', reason: 'payment_unavailable' });
      }
      // An unrelated programming error is not a payment failure — let it
      // propagate so Fastify's default error handling applies (500), rather
      // than silently reporting it as a payment-unavailable outcome.
      throw err;
    }

    recordOutcome(201);
    logEvent('info', 'request completed', { order_id, status_code: 201 });
    return reply.code(201).send({ order_id, status: 'created', payment_status: 'approved' });
  });

  return app;
}
