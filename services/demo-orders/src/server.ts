import Fastify, { FastifyInstance } from 'fastify';
import { validateOrderRequest } from './validation.js';
import { PaymentsClientError } from './paymentsClient.js';
import type { PaymentsClient } from './paymentsClient.js';

export function buildServer(deps: { paymentsClient: PaymentsClient }): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/orders', async (request, reply) => {
    const result = validateOrderRequest(request.body);
    if (!result.ok) {
      return reply.code(400).send({ error: 'invalid_request', message: result.message });
    }

    const { order_id, amount_cents } = result.value;

    try {
      await deps.paymentsClient.charge(order_id, amount_cents);
    } catch (err) {
      if (err instanceof PaymentsClientError) {
        return reply.code(502).send({ order_id, status: 'failed', reason: 'payment_unavailable' });
      }
      // An unrelated programming error is not a payment failure — let it
      // propagate so Fastify's default error handling applies (500), rather
      // than silently reporting it as a payment-unavailable outcome.
      throw err;
    }

    return reply.code(201).send({ order_id, status: 'created', payment_status: 'approved' });
  });

  return app;
}
