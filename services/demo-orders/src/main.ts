import './instrument.js'; // must be the first line — registers telemetry before any
                          // application module (and therefore Fastify/axios/http) loads

const SHUTDOWN_TIMEOUT_MILLIS = 10000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function start() {
  const port = Number(requireEnv('PORT'));
  const paymentsUrl = requireEnv('PAYMENTS_URL');
  const paymentsTimeoutMs = Number(process.env.PAYMENTS_TIMEOUT_MS ?? '3000');

  const { buildServer } = await import('./server.js');
  const { createAxiosPaymentsClient } = await import('./paymentsClient.js');
  const { shutdownTelemetry } = await import('./instrument.js');

  const paymentsClient = createAxiosPaymentsClient(paymentsUrl, paymentsTimeoutMs);
  const app = buildServer({ paymentsClient });

  await app.listen({ port, host: '0.0.0.0' });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Graceful shutdown timed out')), SHUTDOWN_TIMEOUT_MILLIS),
    );

    try {
      await Promise.race([
        (async () => {
          await app.close();
          await shutdownTelemetry();
        })(),
        timeout,
      ]);
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

start();
