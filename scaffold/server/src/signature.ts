import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyResult = 'ok' | 'bad' | 'expired';

interface VerifyOptions {
  header: string | undefined;
  rawBody: Buffer;
  secret: string;
  nowSeconds: number;
  toleranceSeconds: number;
}

/**
 * Verifies a Pigeon webhook signature.
 * Header format: t=<unix seconds>,v1=<hex>
 * Signed payload: "<t>.<rawBody>"
 */
export function verifySignature({
  header,
  rawBody,
  secret,
  nowSeconds,
  toleranceSeconds,
}: VerifyOptions): VerifyResult {
  // 1. Header must be present and a plain string (not duplicated -> array)
  if (!header || typeof header !== 'string') return 'bad';

  // 2. Parse header defensively
  const parts = header.split(',');
  let t: string | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) return 'bad';
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 't') t = val;
    if (key === 'v1') v1 = val;
  }

  if (!t || !v1) return 'bad';

  // 3. t must be a numeric integer
  if (!/^\d+$/.test(t)) return 'bad';
  const timestamp = parseInt(t, 10);
  if (!Number.isFinite(timestamp)) return 'bad';

  // 4. v1 must be valid hex of the right length (SHA256 = 32 bytes = 64 hex chars)
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return 'bad';

  // 5. Compute expected HMAC over "<t>.<rawBody>"
  const payload = Buffer.concat([
    Buffer.from(`${t}.`),
    rawBody,
  ]);
  const expected = createHmac('sha256', secret).update(payload).digest();

  // 6. Timing-safe compare — buffers are always the same length (32 bytes each)
  const actual = Buffer.from(v1, 'hex');
  if (expected.length !== actual.length) return 'bad';
  if (!timingSafeEqual(expected, actual)) return 'bad';

  // 7. Timestamp check (after signature is verified, so we don't leak timing info)
  const age = nowSeconds - timestamp;
  if (age > toleranceSeconds) return 'expired';
  // Allow small future skew (don't reject negative age)

  return 'ok';
}
