import express, { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { createReply, acquireRateLimit } from '../outbox.js';
import { claimConversation, appendEvent } from '../store.js';

const router = Router();

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireGraderToken(req: any, res: any, next: any) {
  if (req.headers['x-grader-token'] !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

router.use(requireGraderToken);
router.use(express.json({ limit: '1mb' }));

// ─── POST /__grader/reset ──────────────────────────────────────────────────────

router.post('/reset', async (_req, res) => {
  try {
    const db = await getDb();
    // Drop all app collections
    await Promise.all([
      db.collection('messages').deleteMany({}),
      db.collection('conversations').deleteMany({}),
      db.collection('events').deleteMany({}),
      db.collection('counters').deleteMany({}),
      db.collection('outbox').deleteMany({}),
    ]);

    // Delete all sb:* Redis keys EXCEPT sb:sess:*
    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'sb:*', 'COUNT', '100');
      cursor = next;
      const toDelete = keys.filter((k) => !k.startsWith('sb:sess:'));
      if (toDelete.length > 0) {
        await redis.del(...toDelete);
      }
    } while (cursor !== '0');

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('grader reset error:', err);
    res.status(503).json({ error: 'reset failed' });
  }
});

// ─── GET /__grader/snapshot ───────────────────────────────────────────────────

router.get('/snapshot', async (_req, res) => {
  try {
    const db = await getDb();
    const workspaces = Object.keys(config.pigeon.apiKeys);

    const result: Record<string, {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
    }> = {};

    for (const ws of workspaces) {
      result[ws] = { contacts: {}, outbound: {} };
    }

    // Gather inbound messages (sorted by occurredAt, then messageId)
    const messages = await db.collection('messages')
      .find({ workspace: { $in: workspaces } })
      .sort({ occurredAt: 1, messageId: 1 })
      .toArray() as unknown as Array<{
        workspace: string; messageId: string; contact: string;
        occurredAt: Date; direction: string;
      }>;

    for (const msg of messages) {
      const ws = msg.workspace;
      if (!result[ws]) continue;
      if (!result[ws].contacts[msg.contact]) {
        result[ws].contacts[msg.contact] = { inbound: [], assignee: null };
      }
      if (msg.direction === 'inbound') {
        result[ws].contacts[msg.contact].inbound.push(msg.messageId);
      }
    }

    // Gather conversations (for assignee)
    const convos = await db.collection('conversations')
      .find({ workspace: { $in: workspaces } })
      .toArray() as unknown as Array<{ workspace: string; contact: string; assignee: string | null }>;

    for (const c of convos) {
      const ws = c.workspace;
      if (!result[ws]) continue;
      if (!result[ws].contacts[c.contact]) {
        result[ws].contacts[c.contact] = { inbound: [], assignee: null };
      }
      result[ws].contacts[c.contact].assignee = c.assignee ?? null;
    }

    // Gather outbox (for outbound status)
    const outbox = await db.collection('outbox')
      .find({ workspace: { $in: workspaces } })
      .toArray() as unknown as Array<{ workspace: string; contact: string; clientRef: string; status: string }>;

    for (const row of outbox) {
      const ws = row.workspace;
      if (!result[ws]) continue;
      result[ws].outbound[row.clientRef] = row.status;
      // Also ensure contact exists in contacts
      if (!result[ws].contacts[row.contact]) {
        result[ws].contacts[row.contact] = { inbound: [], assignee: null };
      }
    }

    res.status(200).json({ workspaces: result });
  } catch (err) {
    console.error('grader snapshot error:', err);
    res.status(503).json({ error: 'snapshot failed' });
  }
});

// ─── POST /__grader/reply ─────────────────────────────────────────────────────

router.post('/reply', async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};

  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(422).json({ error: 'unknown workspace' });
    return;
  }
  if (typeof contact !== 'string' || !contact) {
    res.status(422).json({ error: 'contact required' });
    return;
  }
  if (typeof text !== 'string' || !text) {
    res.status(422).json({ error: 'text required' });
    return;
  }
  if (typeof client_ref !== 'string' || !client_ref) {
    res.status(422).json({ error: 'client_ref required' });
    return;
  }

  try {
    await createReply(workspace, contact, text, client_ref);
    res.status(202).json({ ok: true });
  } catch (err: any) {
    if (err?.status >= 400 && err?.status < 500) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('grader reply error:', err);
    res.status(503).json({ error: 'storage failure' });
  }
});

// ─── POST /__grader/claim ─────────────────────────────────────────────────────

router.post('/claim', async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};

  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(422).json({ error: 'unknown workspace' });
    return;
  }
  if (typeof contact !== 'string' || !contact) {
    res.status(422).json({ error: 'contact required' });
    return;
  }
  if (typeof agent !== 'string' || !agent) {
    res.status(422).json({ error: 'agent required' });
    return;
  }

  try {
    const { assignee } = await claimConversation(workspace, contact, agent);
    if (assignee === agent) {
      // Append assigned event (idempotent)
      await appendEvent(workspace, `assigned:${contact}:${agent}`, {
        type: 'conversation.assigned',
        contact,
        assignee: agent,
      }).catch(() => {}); // best-effort
      res.status(200).json({ ok: true, assignee });
    } else {
      res.status(409).json({ error: 'already claimed', assignee });
    }
  } catch (err) {
    console.error('grader claim error:', err);
    res.status(503).json({ error: 'storage failure' });
  }
});

export default router;
