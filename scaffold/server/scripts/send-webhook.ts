/**
 * Dev helper: signs and POSTs a Pigeon webhook to your server.
 *
 * Usage (from scaffold/server):
 *   npx tsx scripts/send-webhook.ts [flags]
 *
 * Flags:
 *   --tamper          alter the body after signing (should -> 401)
 *   --old             use a timestamp 6 minutes in the past (should -> 401)
 *   --dup             send the same event twice (both should -> 200)
 *   --type <t>        event type (default: message.inbound)
 *   --workspace <w>   workspace id (default: ws_acme)
 *   --raw '<str>'     send a raw non-JSON body (correctly signed, should -> 400)
 */

// Load .env from repo root so config picks up the secret
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env: defaults apply
}

import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const TARGET = process.env.WEBHOOK_URL ?? `http://localhost:${config.port}/webhooks/pigeon`;
const SECRET = config.pigeon.webhookSecret;

const eventType = opt('--type', 'message.inbound');
const workspace = opt('--workspace', 'ws_acme');
const rawOverride = flag('--raw') ? opt('--raw', 'not json') : null;

const eventId = `evt_devtool_${Date.now()}`;
const messageId = `pmsg_devtool_${Date.now()}`;

const bodyObj = {
  id: eventId,
  type: eventType,
  workspace,
  occurred_at: new Date().toISOString(),
  data: { message_id: messageId, from: '+14155550101', text: 'Hello from send-webhook' },
};

const bodyStr = rawOverride ?? JSON.stringify(bodyObj);
const bodyBuf = Buffer.from(bodyStr);

const timestampSeconds = flag('--old')
  ? Math.floor(Date.now() / 1000) - 360 // 6 minutes ago -> should 401
  : Math.floor(Date.now() / 1000);

function sign(t: number, body: Buffer): string {
  const payload = Buffer.concat([Buffer.from(`${t}.`), body]);
  const v1 = createHmac('sha256', SECRET).update(payload).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function sendOnce(label: string, body: Buffer, header: string) {
  console.log(`\n→ [${label}] POST ${TARGET}`);
  console.log(`  x-pigeon-signature: ${header}`);
  console.log(`  body: ${body.toString().slice(0, 120)}`);

  const res = await fetch(TARGET, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pigeon-event-id': eventId,
      'x-pigeon-signature': header,
    },
    body,
  });

  const text = await res.text();
  console.log(`  ← ${res.status} ${text}`);
}

// Build signature on the original body
let sigHeader = sign(timestampSeconds, bodyBuf);
let sendBody = bodyBuf;

if (flag('--tamper')) {
  // Sign first, then alter the body — should produce 401
  sendBody = Buffer.from(bodyStr.replace('Hello', 'TAMPERED'));
  console.log('⚠️  Tampering body after signing');
}

await sendOnce('send 1', sendBody, sigHeader);

if (flag('--dup')) {
  console.log('\n↩  --dup: sending same event again...');
  await sendOnce('send 2 (dup)', sendBody, sigHeader);
}
