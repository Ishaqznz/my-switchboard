import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature } from './signature.js';

const SECRET = 'whsec_test_secret';
const TOLERANCE = 300; // 5 minutes

function makeHeader(t: number, body: Buffer, secret = SECRET): string {
  const payload = Buffer.concat([Buffer.from(`${t}.`), body]);
  const v1 = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${t},v1=${v1}`;
}

const NOW = 1_700_000_000;
const BODY = Buffer.from('{"hello":"world"}');

describe('verifySignature', () => {
  it('valid signature returns ok', () => {
    const header = makeHeader(NOW, BODY);
    const result = verifySignature({
      header,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'ok');
  });

  it('tampered body returns bad', () => {
    const header = makeHeader(NOW, BODY);
    const tampered = Buffer.from('{"hello":"TAMPERED"}');
    const result = verifySignature({
      header,
      rawBody: tampered,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });

  it('wrong secret returns bad', () => {
    const header = makeHeader(NOW, BODY, 'wrong_secret');
    const result = verifySignature({
      header,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });

  it('malformed header (no t=) returns bad', () => {
    const result = verifySignature({
      header: 'v1=abc123',
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });

  it('missing header returns bad', () => {
    const result = verifySignature({
      header: undefined,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });

  it('non-hex v1 returns bad', () => {
    const result = verifySignature({
      header: `t=${NOW},v1=${'zz'.repeat(32)}`,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });

  it('timestamp exactly 5 minutes old returns ok', () => {
    const t = NOW - 300; // exactly 300s = 5 minutes
    const header = makeHeader(t, BODY);
    const result = verifySignature({
      header,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'ok');
  });

  it('timestamp 5 minutes and 1 second old returns expired', () => {
    const t = NOW - 301;
    const header = makeHeader(t, BODY);
    const result = verifySignature({
      header,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'expired');
  });

  it('fresh timestamp with bad signature returns bad', () => {
    const goodHeader = makeHeader(NOW, BODY);
    // flip one char in v1
    const badHeader = goodHeader.slice(0, -1) + (goodHeader.endsWith('a') ? 'b' : 'a');
    const result = verifySignature({
      header: badHeader,
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
      toleranceSeconds: TOLERANCE,
    });
    assert.equal(result, 'bad');
  });
});
