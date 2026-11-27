import { Router } from 'express';
import express from 'express';
import { config } from '../config.js';
import { verifySignature } from '../signature.js';
import { storeInboundMessage, appendEvent } from '../store.js';
import { handleStatusWebhook } from '../outbox.js';

const router = Router();

// Raw body is required so HMAC is computed over the exact bytes received.
router.post(
  '/webhooks/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const eventId = req.headers['x-pigeon-event-id'];
    const sigHeader = req.headers['x-pigeon-signature'];

    // Header may arrive as an array if duplicated — treat that as malformed
    const sigStr = Array.isArray(sigHeader) ? undefined : sigHeader;
    const rawBody: Buffer = req.body as Buffer;
    const nowSeconds = Math.floor(Date.now() / 1000);

    // 1–2. Verify signature + timestamp
    const sigResult = verifySignature({
      header: sigStr,
      rawBody,
      secret: config.pigeon.webhookSecret,
      nowSeconds,
      toleranceSeconds: 300, // 5 minutes
    });

    if (sigResult === 'bad' || sigResult === 'expired') {
      console.log(`webhook rejected event=${eventId ?? '?'} reason=${sigResult}`);
      res.status(401).json({ error: sigResult });
      return;
    }

    // 3. Parse body
    let evt: unknown;
    try {
      evt = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.log(`webhook 400 event=${eventId ?? '?'} reason=unparseable`);
      res.status(400).json({ error: 'unparseable body' });
      return;
    }

    if (
      typeof evt !== 'object' ||
      evt === null ||
      typeof (evt as Record<string, unknown>).id !== 'string' ||
      typeof (evt as Record<string, unknown>).type !== 'string' ||
      typeof (evt as Record<string, unknown>).workspace !== 'string'
    ) {
      console.log(`webhook 400 event=${eventId ?? '?'} reason=invalid shape`);
      res.status(400).json({ error: 'invalid body shape' });
      return;
    }

    const { id, type, workspace } = evt as {
      id: string; type: string; workspace: string;
      occurred_at?: string; data?: unknown;
    };

    // 4. Unknown event type -> 200, ignore
    if (type !== 'message.inbound' && type !== 'message.status') {
      console.log(`webhook ignored event=${id} type=${type} reason=unknown-type`);
      res.status(200).json({ ok: true });
      return;
    }

    // 5. Unknown workspace -> 200, ignore
    if (!(workspace in config.pigeon.apiKeys)) {
      console.log(`webhook ignored event=${id} workspace=${workspace} reason=unknown-workspace`);
      res.status(200).json({ ok: true });
      return;
    }

    // 6. message.status -> handle delivery receipts
    if (type === 'message.status') {
      const statusEvt = evt as {
        id: string; workspace: string;
        data: { client_ref: string; status: string; message_id?: string };
      };
      try {
        await handleStatusWebhook(
          workspace,
          statusEvt.data.client_ref,
          statusEvt.data.status,
          statusEvt.id,
        );
        console.log(`webhook event=${id} type=message.status status=${statusEvt.data.status} clientRef=${statusEvt.data.client_ref}`);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error(`webhook 503 event=${id} error=`, err);
        res.status(503).json({ error: 'storage failure' });
      }
      return;
    }

    // 7. message.inbound for a known workspace -> store
    const body = evt as {
      id: string; workspace: string; occurred_at: string;
      data: { message_id: string; from: string; text: string };
    };

    try {
      // Step A: store message + upsert conversation
      const outcome = await storeInboundMessage({
        workspace: body.workspace,
        messageId: body.data.message_id,
        contact: body.data.from,
        text: body.data.text,
        occurredAt: new Date(body.occurred_at),
        eventId: body.id,
      });

      // Step B: append event to event log (idempotent, runs even on duplicate)
      await appendEvent(workspace, `inbound:${body.data.message_id}`, {
        type: 'message.inbound',
        contact: body.data.from,
        message_id: body.data.message_id,
        text: body.data.text,
        occurred_at: body.occurred_at,
      });

      console.log(`webhook event=${body.id} type=message.inbound workspace=${workspace} outcome=${outcome}`);
      res.status(200).json({ ok: true });
    } catch (err) {
      // 8. MongoDB failure -> 503 so Pigeon retries
      console.error(`webhook 503 event=${body.id} error=`, err);
      res.status(503).json({ error: 'storage failure' });
    }
  },
);

export default router;
