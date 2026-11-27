import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { upsertConversation, appendEvent, isDuplicateKeyError } from './store.js';
import { mergeStatus, isValidDisplayStatus, type DisplayStatus } from './status.js';
import { config } from './config.js';

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const POLL_MS = 300;
const MAX_BACKOFF_MS = 5_000;
const GIVE_UP_MS = 15 * 60 * 1000; // 15 minutes

// ─── Pigeon rate limiter (per-workspace, Redis token bucket) ──────────────────

const BUCKET_CAPACITY = 7;
const REFILL_RATE = 3.5; // tokens/second

const LUA_ACQUIRE = `
local key = KEYS[1]
local coolKey = KEYS[2]
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])

-- Check cooldown first
local cool = redis.call('get', coolKey)
if cool then
  return tonumber(cool) - now
end

local data = redis.call('hmget', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or cap
local ts = tonumber(data[2]) or now

-- Refill
local elapsed = math.max(0, now - ts)
tokens = math.min(cap, tokens + elapsed * rate / 1000)
ts = now

if tokens < 1 then
  redis.call('hmset', key, 'tokens', tokens, 'ts', ts)
  redis.call('pexpire', key, 30000)
  return math.ceil((1 - tokens) / rate * 1000)
end

-- Consume one token
tokens = tokens - 1
redis.call('hmset', key, 'tokens', tokens, 'ts', ts)
redis.call('pexpire', key, 30000)
return 0
`;

/** Returns 0 if OK to send, or ms to wait. */
export async function acquireRateLimit(workspace: string): Promise<number> {
  const redis = getRedis();
  const now = Date.now();
  const result = await redis.eval(
    LUA_ACQUIRE,
    2,
    `sb:bucket:${workspace}`,
    `sb:cool:${workspace}`,
    String(now),
    String(BUCKET_CAPACITY),
    String(REFILL_RATE),
  );
  return Math.max(0, Number(result));
}

/** Set a cooldown from a Retry-After header value (seconds). */
async function setCooldown(workspace: string, retryAfterSeconds: number): Promise<void> {
  const redis = getRedis();
  const untilMs = Date.now() + retryAfterSeconds * 1000 + 500; // small buffer
  const pttl = retryAfterSeconds * 1000 + 1000;
  await redis.set(`sb:cool:${workspace}`, String(untilMs), 'PX', pttl);
}

// ─── Pigeon client ────────────────────────────────────────────────────────────

interface PigeonSendResult {
  outcome: 'sent' | 'rate_limited' | 'server_error' | 'unknown' | 'client_error';
  pigeonId?: string;
  retryAfter?: number;
  errorCode?: number;
}

async function sendToPigeon(
  workspace: string,
  to: string,
  text: string,
  clientRef: string,
): Promise<PigeonSendResult> {
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) return { outcome: 'client_error', errorCode: 404 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': clientRef,
      },
      body: JSON.stringify({ to, text, client_ref: clientRef }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 200) {
      const body = await res.json() as { id: string };
      return { outcome: 'sent', pigeonId: body.id };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
      return { outcome: 'rate_limited', retryAfter };
    }
    if (res.status >= 500) {
      return { outcome: 'server_error', errorCode: res.status };
    }
    return { outcome: 'client_error', errorCode: res.status };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    // Timeout/network = unknown (may have been accepted)
    return { outcome: isAbort ? 'unknown' : 'unknown' };
  }
}

// ─── Outbox CRUD ──────────────────────────────────────────────────────────────

export async function createReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  if (!(workspace in config.pigeon.apiKeys)) {
    throw Object.assign(new Error('Unknown workspace'), { status: 404 });
  }
  if (!text || text.length > 2000) {
    throw Object.assign(new Error('text must be 1-2000 chars'), { status: 400 });
  }
  if (!clientRef || clientRef.length > 100) {
    throw Object.assign(new Error('client_ref must be 1-100 chars'), { status: 400 });
  }

  const db = await getDb();
  const now = new Date();

  // Step 1: insert outbox row (idempotent via unique index)
  try {
    await db.collection('outbox').insertOne({
      workspace,
      contact,
      text,
      clientRef,
      status: 'queued' as DisplayStatus,
      sendState: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      leaseOwner: null,
      pigeonId: null,
      lastError: null,
      createdAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Duplicate: already queued, that's fine
  }

  // Step 2: upsert conversation
  await upsertConversation(workspace, contact, now);

  // Step 3: append queued event
  await appendEvent(workspace, `status:${clientRef}:queued`, {
    type: 'message.status',
    contact,
    client_ref: clientRef,
    status: 'queued',
  });
}

// ─── Outbox worker ────────────────────────────────────────────────────────────

function jitter(ms: number): number {
  return ms * (0.75 + 0.5 * Math.random());
}

async function processOneRow(): Promise<boolean> {
  const db = await getDb();
  const now = new Date();

  const row = await db.collection('outbox').findOneAndUpdate(
    {
      sendState: 'pending',
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
    },
    {
      $set: { leaseUntil: new Date(Date.now() + config.leaseMs), leaseOwner: WORKER_ID },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
  ) as unknown as {
    workspace: string; contact: string; text: string; clientRef: string;
    status: DisplayStatus; attempts: number; createdAt: Date;
  } | null;

  if (!row) return false;

  const { workspace, contact, text, clientRef, attempts, createdAt } = row;

  // Give up after 15 minutes
  if (Date.now() - createdAt.getTime() > GIVE_UP_MS) {
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { sendState: 'dead', status: 'failed', leaseOwner: null, leaseUntil: null } },
    );
    await appendEvent(workspace, `status:${clientRef}:failed`, {
      type: 'message.status',
      contact,
      client_ref: clientRef,
      status: 'failed',
    });
    return true;
  }

  // Check rate limit
  const wait = await acquireRateLimit(workspace);
  if (wait > 0) {
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { leaseOwner: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + wait) } },
    );
    return true;
  }

  // Send
  const result = await sendToPigeon(workspace, contact, text, clientRef);

  if (result.outcome === 'sent') {
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { sendState: 'done', pigeonId: result.pigeonId, leaseOwner: null, leaseUntil: null } },
    );
    console.log(`outbox sent clientRef=${clientRef} pigeonId=${result.pigeonId}`);
  } else if (result.outcome === 'rate_limited') {
    const ra = result.retryAfter ?? 5;
    await setCooldown(workspace, ra);
    const retryAt = new Date(Date.now() + jitter(ra * 1000 + 500));
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { leaseOwner: null, leaseUntil: null, nextAttemptAt: retryAt, lastError: '429' } },
    );
  } else if (result.outcome === 'client_error') {
    // Non-retriable: mark failed
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { sendState: 'dead', status: 'failed', leaseOwner: null, leaseUntil: null, lastError: String(result.errorCode) } },
    );
    await appendEvent(workspace, `status:${clientRef}:failed`, {
      type: 'message.status',
      contact,
      client_ref: clientRef,
      status: 'failed',
    });
  } else {
    // server_error or unknown: exponential backoff, never give up early
    const backoff = Math.min(jitter(500 * Math.pow(2, Math.min(attempts - 1, 5))), MAX_BACKOFF_MS);
    const retryAt = new Date(Date.now() + backoff);
    await db.collection('outbox').updateOne(
      { workspace, clientRef },
      { $set: { leaseOwner: null, leaseUntil: null, nextAttemptAt: retryAt, lastError: result.outcome } },
    );
  }

  return true;
}

let workerRunning = false;

export async function startOutboxWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  const loop = async () => {
    if (!workerRunning) return;
    try {
      // Process up to workerConcurrency rows in parallel
      const tasks = Array.from({ length: config.workerConcurrency }, () => processOneRow());
      await Promise.all(tasks);
    } catch (err) {
      console.error('outbox worker error:', err);
    }
    setTimeout(loop, POLL_MS);
  };

  setTimeout(loop, POLL_MS);
  console.log(`outbox worker started (id=${WORKER_ID})`);
}

export function stopOutboxWorker(): void {
  workerRunning = false;
}

// ─── Webhook: message.status handler ─────────────────────────────────────────

export async function handleStatusWebhook(
  workspace: string,
  clientRef: string,
  pigeonStatus: string,
  eventId: string,
): Promise<void> {
  if (!isValidDisplayStatus(pigeonStatus)) return; // unknown status -> ignore

  const db = await getDb();
  const row = await db.collection('outbox').findOne({ workspace, clientRef }) as unknown as {
    contact: string; status: DisplayStatus;
  } | null;

  if (!row) return; // not found -> ignore

  const newStatus = mergeStatus(row.status, pigeonStatus as DisplayStatus);
  if (newStatus !== row.status) {
    // Forward-only: conditional update
    await db.collection('outbox').updateOne(
      { workspace, clientRef, status: row.status },
      { $set: { status: newStatus } },
    );
  }

  // Append event (idempotent)
  await appendEvent(workspace, `status:${clientRef}:${pigeonStatus}`, {
    type: 'message.status',
    contact: row.contact,
    client_ref: clientRef,
    status: pigeonStatus,
  });
}
