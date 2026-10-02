import Fastify, { FastifyInstance } from 'fastify';
import { validateChargeRequest } from './validation.js';
import { recordHttpRequest } from './metrics.js';

const CHARGE_ROUTE = '/payments/charge';

export function buildServer(): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/payments/charge', async (request, reply) => {
    const start = process.hrtime.bigint();
    const recordOutcome = (statusCode: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      recordHttpRequest(CHARGE_ROUTE, 'POST', statusCode, durationSeconds);
    };

    const result = validateChargeRequest(request.body);
    if (!result.ok) {
      recordOutcome(400);
      return reply.code(400).send({ error: 'invalid_request', message: result.message });
    }

    recordOutcome(200);
    return reply.code(200).send({ order_id: result.value.order_id, payment_status: 'approved' });
  });

  return app;
}
