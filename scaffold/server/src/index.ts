import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { ensureIndexes } from './store.js';
import pigeonRouter from './webhooks/pigeon.js';

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Mount the Pigeon webhook router (uses its own express.raw body parser)
app.use(pigeonRouter);

// Everything else is yours.

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);

// Ensure MongoDB indexes before accepting traffic
await ensureIndexes();

server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});
