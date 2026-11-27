import { getDb } from './db.js';

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

  // conversations: unique on (workspace, contact)
  await db.collection('conversations').createIndex(
    { workspace: 1, contact: 1 },
    { unique: true, name: 'conversations_workspace_contact' },
  );
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
 * Both steps are idempotent:
 *   - Mongo duplicate-key (11000) on insert -> already stored, treat as success.
 *   - Conversation upsert uses $setOnInsert + $max so out-of-order events are safe.
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
    // Duplicate key -> already stored from a previous delivery
    if (isDuplicateKeyError(err)) {
      result = 'duplicate';
    } else {
      throw err; // propagate so the caller returns 503
    }
  }

  // Step 2: upsert conversation (always run, even on duplicate message)
  // $setOnInsert: only on creation; $max: never move lastActivityAt backwards
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

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}
