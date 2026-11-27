import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { connectDb } from './db.js';
import { ensureIndexes } from './store.js';
import { startOutboxWorker, stopOutboxWorker } from './outbox.js';
import { setupWebSocket } from './ws.js';
import pigeonRouter from './webhooks/pigeon.js';
import graderRouter from './routes/grader.js';
import authRouter from './routes/auth.js';
import apiRouter from './routes/api.js';

// ─── Process safety ───────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  // Don't exit — let the process keep running
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  // Don't exit on unhandled rejections
});

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

// ─── Readiness gate ───────────────────────────────────────────────────────────

let ready = false;

app.get('/healthz', (_req, res) => {
  if (!ready) {
    res.status(503).json({ ok: false, message: 'starting up' });
    return;
  }
  res.json({ ok: true });
});

// ─── Webhook (raw body) ───────────────────────────────────────────────────────

app.use(pigeonRouter);

// ─── Grader endpoints ─────────────────────────────────────────────────────────

app.use('/__grader', graderRouter);

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.use(authRouter);

// ─── API routes ───────────────────────────────────────────────────────────────

app.use(apiRouter);

// ─── JSON error middleware ────────────────────────────────────────────────────

app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'malformed JSON body' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'request body too large' });
    return;
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal server error' });
});

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;

// Handle client connection errors gracefully
server.on('clientError', (err: NodeJS.ErrnoException, socket: any) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

setupWebSocket(server);

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  // Connect to Mongo with retry loop (backoff up to 10 s)
  await connectDb();
  // Ensure indexes (idempotent)
  await ensureIndexes();

  // Now accept traffic
  ready = true;

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });

  // Start outbox worker after listening
  startOutboxWorker();
}

// ─── SIGTERM: graceful shutdown ───────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  stopOutboxWorker();
  server.close(() => {
    console.log('server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(0), 10_000);
});

start().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
