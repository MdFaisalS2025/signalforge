// Pure input validation for dashboard routes. No I/O, no framework types, no environment access.

// A request value failed validation. field names the input so an API route can report it without parsing text.
export class InvalidInput extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidInput';
    this.field = field;
  }
}

// Canonical 8-4-4-4-12 hexadecimal form. The version nibble is not checked, so UUIDv4 and UUIDv5 both pass.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Digits only, no leading zero, at most nine digits. This rejects signs, decimals, whitespace, hex, exponents,
// and any value long enough to be unbounded before it is converted to a number.
const INTEGER_PATTERN = /^[1-9][0-9]{0,8}$/;

export function parseIncidentId(input: unknown): string {
  if (typeof input !== 'string' || !UUID_PATTERN.test(input)) {
    throw new InvalidInput('incident_id', 'incident_id must be a UUID');
  }
  return input;
}

// parseLimit returns fallback when the value is absent. Otherwise it accepts an integer from 1 through max.
export function parseLimit(input: unknown, { fallback, max }: { fallback: number; max: number }): number {
  if (input === undefined) return fallback;
  const message = `limit must be an integer from 1 to ${max}`;
  if (typeof input !== 'string' || !INTEGER_PATTERN.test(input)) {
    throw new InvalidInput('limit', message);
  }
  const value = Number(input);
  if (value > max) throw new InvalidInput('limit', message);
  return value;
}
