import Fastify, { FastifyInstance } from 'fastify';
import { validateChargeRequest } from './validation.js';
import { recordHttpRequest } from './metrics.js';
import { logEvent } from './logger.js';
import type { FaultMode } from './config.js';

const CHARGE_ROUTE = '/payments/charge';

function extractOrderId(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'order_id' in body) {
    const value = (body as Record<string, unknown>).order_id;
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

export function buildServer(options: { faultMode: FaultMode } = { faultMode: 'disabled' }): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/payments/charge', async (request, reply) => {
    const start = process.hrtime.bigint();
    const recordOutcome = (statusCode: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      recordHttpRequest(CHARGE_ROUTE, 'POST', statusCode, durationSeconds);
    };

    if (options.faultMode === 'enabled') {
      recordOutcome(500);
      logEvent('error', 'charge failed', { order_id: extractOrderId(request.body), status_code: 500 });
      return reply.code(500).send({ error: 'injected_fault' });
    }

    const result = validateChargeRequest(request.body);
    if (!result.ok) {
      recordOutcome(400);
      // Never invent a real order_id for a rejected request, and never log
      // the raw request body — only the order_id field, if it happened to
      // be a string, plus the validation failure reason.
      logEvent('warn', 'charge request validation failed', { order_id: extractOrderId(request.body), reason: result.message });
      return reply.code(400).send({ error: 'invalid_request', message: result.message });
    }

    const { order_id } = result.value;
    logEvent('info', 'request received', { order_id });

    recordOutcome(200);
    logEvent('info', 'request completed', { order_id, status_code: 200 });
    return reply.code(200).send({ order_id, payment_status: 'approved' });
  });

  return app;
}
