import crypto from 'node:crypto';

/**
 * Generates a cryptographically strong UUID v4.
 */
export function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * Generates a URL-safe cryptographically random token for session cookies.
 */
export function newOpaqueToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Computes lowercase hex SHA-256 of UTF-8 input.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Recursively converts any JSON-serializable value into a canonical object
 * with deterministically sorted keys so hashes are reproducible.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const entry = record[key];
    if (entry !== undefined) {
      out[key] = canonicalizeValue(entry);
    }
  }
  return out;
}

/**
 * Serializes a value into deterministic canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

/**
 * Computes SHA-256 of canonical JSON representation of a value.
 */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Formats integer minor units (cents) as a decimal string with 2 fractional digits.
 */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Invalid non-negative integer cents amount: ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Parses a PayPal decimal money string (e.g. "449.00" or "10.5") into integer cents.
 * Rejects malformed strings or >2 decimal places to avoid rounding discrepancies.
 */
export function parseMoneyToCents(amountStr: string): number {
  const trimmed = amountStr.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal money string: "${amountStr}"`);
  }
  const whole = Number.parseInt(match[1], 10);
  const frac = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100 + Number.parseInt(frac, 10);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Money amount exceeds safe integer range: "${amountStr}"`);
  }
  return cents;
}

