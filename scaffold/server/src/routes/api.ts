import { Router } from 'express';
import express from 'express';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { createReply } from '../outbox.js';
import { claimConversation, appendEvent, setConversationStatus } from '../store.js';
import { requireSession, requireMember } from '../middleware/session.js';

const router = Router();
router.use(express.json({ limit: '1mb' }));

// ─── GET /api/me ──────────────────────────────────────────────────────────────

router.get('/api/me', requireSession, (req, res) => {
  res.json({ sub: req.session!.sub, workspaces: req.session!.workspaces });
});

// ─── GET /api/conversations ───────────────────────────────────────────────────

router.get('/api/conversations', requireSession, requireMember('workspace'), async (req, res) => {
  const workspace = req.query.workspace as string;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const cursor = req.query.cursor as string | undefined;

  try {
    const db = await getDb();

    // Read current max seq for this workspace
    const counter = await (db.collection('counters') as any).findOne({ _id: workspace }) as { seq: number } | null;
    const seq = counter?.seq ?? 0;

    const filter: Record<string, unknown> = { workspace };
    if (cursor) {
      try {
        const { laa, id } = JSON.parse(Buffer.from(cursor, 'base64').toString());
        filter.$or = [
          { lastActivityAt: { $lt: new Date(laa) } },
          { lastActivityAt: new Date(laa), _id: { $lt: id } },
        ];
      } catch {
        // ignore bad cursor
      }
    }

    const items = await db.collection('conversations')
      .find(filter)
      .sort({ lastActivityAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray() as unknown as Array<{
        _id: unknown; workspace: string; contact: string;
        status: string; assignee: string | null;
        lastActivityAt: Date; createdAt: Date;
      }>;

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ laa: last.lastActivityAt, id: last._id })).toString('base64');
    }

    res.json({ seq, items, nextCursor });
  } catch (err) {
    console.error('GET /api/conversations error:', err);
    res.status(503).json({ error: 'storage failure' });
  }
});

// ─── GET /api/messages ────────────────────────────────────────────────────────

router.get('/api/messages', requireSession, requireMember('workspace'), async (req, res) => {
  const workspace = req.query.workspace as string;
  const contact = req.query.contact as string;

  if (!contact) {
    res.status(400).json({ error: 'contact required' });
    return;
  }

  try {
    const db = await getDb();

    const counter = await (db.collection('counters') as any).findOne({ _id: workspace }) as { seq: number } | null;
    const seq = counter?.seq ?? 0;

    // Inbound messages
    const inbound = await db.collection('messages')
      .find({ workspace, contact, direction: 'inbound' })
      .sort({ occurredAt: 1 })
      .toArray() as unknown as Array<{ messageId: string; text: string; occurredAt: Date; direction: string }>;

    // Outbound (from outbox)
    const outbound = await db.collection('outbox')
      .find({ workspace, contact })
      .sort({ createdAt: 1 })
      .toArray() as unknown as Array<{ clientRef: string; text: string; status: string; createdAt: Date }>;

    // Merge and sort by time
    const all = [
      ...inbound.map((m) => ({ type: 'inbound' as const, id: m.messageId, text: m.text, time: m.occurredAt })),
      ...outbound.map((m) => ({ type: 'outbound' as const, id: m.clientRef, text: m.text, status: m.status, time: m.createdAt })),
    ].sort((a, b) => a.time.getTime() - b.time.getTime());

    res.json({ seq, messages: all });
  } catch (err) {
    console.error('GET /api/messages error:', err);
    res.status(503).json({ error: 'storage failure' });
  }
});

// ─── POST /api/claim ──────────────────────────────────────────────────────────

router.post('/api/claim', requireSession, async (req, res) => {
  const { workspace, contact } = req.body ?? {};
  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(400).json({ error: 'invalid workspace' });
    return;
  }
  if (!req.session!.workspaces.some((w) => w.id === workspace)) {
    res.status(403).json({ error: 'not a member of this workspace' });
    return;
  }
  if (typeof contact !== 'string' || !contact) {
    res.status(400).json({ error: 'contact required' });
    return;
  }
  try {
    const { assignee } = await claimConversation(workspace, contact, req.session!.sub);
    if (assignee === req.session!.sub) {
      await appendEvent(workspace, `assigned:${contact}:${req.session!.sub}`, {
        type: 'conversation.assigned', contact, assignee: req.session!.sub,
      }).catch(() => {});
      res.status(200).json({ ok: true, assignee });
    } else {
      res.status(409).json({ error: 'already claimed', assignee });
    }
  } catch (err) {
    console.error('POST /api/claim error:', err);
    res.status(503).json({ error: 'storage failure' });
  }
});

// ─── POST /api/close & /api/reopen ───────────────────────────────────────────

router.post('/api/close', requireSession, async (req, res) => {
  const { workspace, contact } = req.body ?? {};
  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(400).json({ error: 'invalid workspace' });
    return;
  }
  if (!req.session!.workspaces.some((w) => w.id === workspace)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  try {
    await setConversationStatus(workspace, contact, 'closed');
    await appendEvent(workspace, `conv:${contact}:closed:1`, {
      type: 'conversation.status', contact, status: 'closed',
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'storage failure' });
  }
});

router.post('/api/reopen', requireSession, async (req, res) => {
  const { workspace, contact } = req.body ?? {};
  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(400).json({ error: 'invalid workspace' });
    return;
  }
  if (!req.session!.workspaces.some((w) => w.id === workspace)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  try {
    await setConversationStatus(workspace, contact, 'open');
    await appendEvent(workspace, `conv:${contact}:open:1`, {
      type: 'conversation.status', contact, status: 'open',
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'storage failure' });
  }
});

// ─── POST /api/reply ──────────────────────────────────────────────────────────

router.post('/api/reply', requireSession, async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) {
    res.status(400).json({ error: 'invalid workspace' });
    return;
  }
  if (!req.session!.workspaces.some((w) => w.id === workspace)) {
    res.status(403).json({ error: 'forbidden' });
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
    res.status(503).json({ error: 'storage failure' });
  }
});

export default router;
