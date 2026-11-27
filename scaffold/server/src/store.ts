import { getDb } from './db.js';
import { getRedis } from './redis.js';

/**
 * Ensures required indexes exist. Call once at startup before server.listen.
 * Idempotent: createIndex is a no-op if the index already exists.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // messages: unique on (workspace, messageId) for idempotent inserts
  await db.collection('messages').createIndex(
    { workspace: 1, messageId: 1 },
    { unique: true, name: 'messages_workspace_messageId' },
  );
  // Sort order for snapshot: by occurredAt, messageId
  await db.collection('messages').createIndex({ workspace: 1, contact: 1, occurredAt: 1, messageId: 1 });

  // conversations: unique on (workspace, contact)
  await db.collection('conversations').createIndex(
    { workspace: 1, contact: 1 },
    { unique: true, name: 'conversations_workspace_contact' },
  );
  await db.collection('conversations').createIndex({ workspace: 1, lastActivityAt: -1, _id: -1 });

  // events: unique on (workspace, dedupeKey) and (workspace, seq)
  await db.collection('events').createIndex(
    { workspace: 1, dedupeKey: 1 },
    { unique: true, name: 'events_workspace_dedupeKey' },
  );
  await db.collection('events').createIndex(
    { workspace: 1, seq: 1 },
    { unique: true, name: 'events_workspace_seq' },
  );

  // counters: _id = workspace
  await db.collection('counters').createIndex({ _id: 1 });

  // outbox
  await db.collection('outbox').createIndex(
    { workspace: 1, clientRef: 1 },
    { unique: true, name: 'outbox_workspace_clientRef' },
  );
  await db.collection('outbox').createIndex({ sendState: 1, nextAttemptAt: 1 });

  console.log('MongoDB indexes ensured');
}

export interface InboundMessageData {
  workspace: string;
  messageId: string;
  contact: string;
  text: string;
  occurredAt: Date;
  eventId: string;
}

/**
 * Stores an inbound message and upserts its conversation.
 * Both steps are idempotent.
 * Returns 'stored' | 'duplicate'.
 */
export async function storeInboundMessage(
  data: InboundMessageData,
): Promise<'stored' | 'duplicate'> {
  const db = await getDb();
  const now = new Date();
  let result: 'stored' | 'duplicate' = 'stored';

  // Step 1: insert message (idempotent)
  try {
    await db.collection('messages').insertOne({
      workspace: data.workspace,
      messageId: data.messageId,
      contact: data.contact,
      text: data.text,
      occurredAt: data.occurredAt,
      eventId: data.eventId,
      direction: 'inbound',
      receivedAt: now,
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      result = 'duplicate';
    } else {
      throw err;
    }
  }

  // Step 2: upsert conversation (always run, even on duplicate message)
  await db.collection('conversations').updateOne(
    { workspace: data.workspace, contact: data.contact },
    {
      $setOnInsert: {
        workspace: data.workspace,
        contact: data.contact,
        status: 'open',
        assignee: null,
        createdAt: now,
      },
      $max: { lastActivityAt: data.occurredAt },
    },
    { upsert: true },
  );

  return result;
}

// ─── Event log ───────────────────────────────────────────────────────────────

/** Atomically allocate the next seq for a workspace. */
export async function nextSeq(workspace: string): Promise<number> {
  const db = await getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db.collection('counters') as any).findOneAndUpdate(
    { _id: workspace },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return (result as unknown as { seq: number }).seq as number;
}

export type EventFrame =
  | { seq: number; type: 'message.inbound'; contact: string; message_id: string; text: string; occurred_at: string }
  | { seq: number; type: 'message.status'; contact: string; client_ref: string; status: string }
  | { seq: number; type: 'conversation.assigned'; contact: string; assignee: string }
  | { seq: number; type: 'conversation.status'; contact: string; status: 'open' | 'closed' };

export type EventFrameInput = Omit<EventFrame, 'seq'> | Record<string, unknown>;

/**
 * Idempotent event append. If dedupeKey already exists, return existing doc.
 * Otherwise allocate seq, insert event, publish Redis wake-up.
 */
export async function appendEvent(
  workspace: string,
  dedupeKey: string,
  frameWithoutSeq: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();

  // Check if already stored (idempotent)
  const existing = await db.collection('events').findOne({ workspace, dedupeKey });
  if (existing) return;

  // Allocate seq, then insert
  const seq = await nextSeq(workspace);
  const frame = { seq, ...frameWithoutSeq } as EventFrame;

  try {
    await db.collection('events').insertOne({
      workspace,
      seq,
      dedupeKey,
      frame,
      createdAt: new Date(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return; // race: already inserted
    throw err;
  }

  // Publish wake-up to WebSocket clients (best-effort)
  try {
    await getRedis().publish(`sb:events:${workspace}`, String(seq));
  } catch {
    // Redis down: clients will catch up via 1 s poll
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}

// ─── Conversations ───────────────────────────────────────────────────────────

export async function upsertConversation(
  workspace: string,
  contact: string,
  lastActivityAt: Date,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection('conversations').updateOne(
    { workspace, contact },
    {
      $setOnInsert: {
        workspace,
        contact,
        status: 'open',
        assignee: null,
        createdAt: now,
      },
      $max: { lastActivityAt },
    },
    { upsert: true },
  );
}

/** Claim a conversation atomically. Returns the resulting assignee. */
export async function claimConversation(
  workspace: string,
  contact: string,
  agentId: string,
): Promise<{ assignee: string | null }> {
  const db = await getDb();
  const now = new Date();

  // ONE atomic operation: only claim if unassigned or already owned by this agent
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const doc = await db.collection('conversations').findOneAndUpdate(
        { workspace, contact, $or: [{ assignee: null }, { assignee: agentId }] },
        {
          $set: { assignee: agentId },
          $setOnInsert: {
            workspace,
            contact,
            status: 'open',
            createdAt: now,
            lastActivityAt: now,
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return { assignee: (doc as unknown as { assignee: string | null } | null)?.assignee ?? agentId };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // Document was created by another worker with different assignee -> read current
        break;
      }
      throw err;
    }
  }
  // If we can't claim, fetch current assignee
  const doc = await db.collection('conversations').findOne({ workspace, contact });
  return { assignee: (doc as unknown as { assignee: string | null } | null)?.assignee ?? null };
}

/** Update conversation status (open/closed). */
export async function setConversationStatus(
  workspace: string,
  contact: string,
  status: 'open' | 'closed',
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection('conversations').updateOne(
    { workspace, contact },
    {
      $set: { status },
      $setOnInsert: {
        workspace,
        contact,
        assignee: null,
        createdAt: now,
        lastActivityAt: now,
      },
      $max: { lastActivityAt: now },
    },
    { upsert: true },
  );
}
