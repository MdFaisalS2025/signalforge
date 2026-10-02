import Fastify, { FastifyInstance } from 'fastify';
import { validateChargeRequest } from './validation.js';

export function buildServer(): FastifyInstance {
  const app = Fastify();

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/payments/charge', async (request, reply) => {
    const result = validateChargeRequest(request.body);
    if (!result.ok) {
      return reply.code(400).send({ error: 'invalid_request', message: result.message });
    }

    return reply.code(200).send({ order_id: result.value.order_id, payment_status: 'approved' });
  });

  return app;
}
