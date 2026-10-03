import axios from 'axios';

export interface PaymentsClient {
  charge(orderId: string, amountCents: number): Promise<{ paymentStatus: 'approved' }>;
}

export class PaymentsClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PaymentsClientError';
  }
}

interface ChargeResponseBody {
  order_id: string;
  payment_status: string;
}

function isChargeResponseBody(value: unknown): value is ChargeResponseBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).order_id === 'string' &&
    typeof (value as Record<string, unknown>).payment_status === 'string'
  );
}

export function createAxiosPaymentsClient(baseUrl: string, timeoutMs: number): PaymentsClient {
  return {
    async charge(orderId: string, amountCents: number) {
      let response;
      try {
        response = await axios.post(
          `${baseUrl}/payments/charge`,
          { order_id: orderId, amount_cents: amountCents },
          { timeout: timeoutMs },
        );
      } catch (cause) {
        // Network failure, connection refusal, or a non-2xx status (axios' default
        // validateStatus rejects outside the 2xx range) all land here. No retry —
        // this is the one and only attempt.
        throw new PaymentsClientError('payments request failed', { cause });
      }

      const body: unknown = response.data;
      if (!isChargeResponseBody(body) || body.order_id !== orderId || body.payment_status !== 'approved') {
        throw new PaymentsClientError('unexpected payments response body');
      }

      return { paymentStatus: 'approved' };
    },
  };
}
