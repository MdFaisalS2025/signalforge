export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface ChargeRequestBody {
  order_id: string;
  amount_cents: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function validateChargeRequest(body: unknown): ValidationResult<ChargeRequestBody> {
  const candidate = (body ?? {}) as Record<string, unknown>;

  if (candidate.order_id === undefined || candidate.order_id === null) {
    return { ok: false, message: 'order_id is required' };
  }
  if (!isValidUuid(candidate.order_id)) {
    return { ok: false, message: 'order_id must be a valid UUID' };
  }
  if (candidate.amount_cents === undefined || candidate.amount_cents === null) {
    return { ok: false, message: 'amount_cents is required' };
  }
  if (typeof candidate.amount_cents !== 'number' || !Number.isInteger(candidate.amount_cents) || candidate.amount_cents <= 0) {
    return { ok: false, message: 'amount_cents must be a positive integer' };
  }

  return { ok: true, value: { order_id: candidate.order_id, amount_cents: candidate.amount_cents } };
}
