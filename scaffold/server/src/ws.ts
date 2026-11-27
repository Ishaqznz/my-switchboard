import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { getDb } from './db.js';
import { getRedis, getSubscriber } from './redis.js';

const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_000;
const MAX_BUFFER = 1_048_576;
const GAP_WAIT_MS = 2_000;

// Map: workspace -> Set<WebSocket>
const workspaceSockets = new Map<string, Set<WebSocket>>();

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const entry = cookieHeader.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return entry ? entry.slice(name.length + 1) : null;
}

async function loadSession(sid: string): Promise<{ sub: string; workspaces: Array<{ id: string; role: string }> } | null> {
  try {
    const raw = await getRedis().get(`sb:sess:${sid}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Push all events seq > lastSent to the given socket. Returns new lastSent. */
async function pushNewEvents(ws: WebSocket, workspace: string, lastSent: number): Promise<number> {
  if (ws.readyState !== WebSocket.OPEN) return lastSent;
  try {
    const db = await getDb();
    const events = await db.collection('events')
      .find({ workspace, seq: { $gt: lastSent } })
      .sort({ seq: 1 })
      .toArray() as unknown as Array<{ seq: number; frame: Record<string, unknown> }>;

    if (!events.length) return lastSent;

    let newLast = lastSent;
    // Gap handling: wait up to GAP_WAIT_MS if seq is not contiguous from lastSent+1
    // Simple approach: just send in order, allowing gaps (seq may have gaps from crashes)
    for (const evt of events) {
      if (ws.readyState !== WebSocket.OPEN) break;
      if (ws.bufferedAmount > MAX_BUFFER) {
        console.warn(`ws buffer overflow workspace=${workspace}, closing`);
        ws.close();
        break;
      }
      ws.send(JSON.stringify(evt.frame));
      newLast = evt.seq;
    }
    return newLast;
  } catch {
    return lastSent;
  }
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // One Redis subscriber per process
  const sub = getSubscriber();

  // Track workspace subscriptions
  const subscribedWorkspaces = new Set<string>();

  function ensureSubscribed(workspace: string) {
    if (subscribedWorkspaces.has(workspace)) return;
    subscribedWorkspaces.add(workspace);
    sub.subscribe(`sb:events:${workspace}`, (err) => {
      if (err) console.error(`ws subscribe error workspace=${workspace}:`, err.message);
    });
  }

  // On Redis message: push new events to all sockets for that workspace
  sub.on('message', (channel: string, _message: string) => {
    const prefix = 'sb:events:';
    if (!channel.startsWith(prefix)) return;
    const workspace = channel.slice(prefix.length);
    const sockets = workspaceSockets.get(workspace);
    if (!sockets) return;
    for (const ws of sockets) {
      triggerPush(ws, workspace).catch(() => {});
    }
  });

  // Handle upgrade requests
  server.on('upgrade', async (req: IncomingMessage, socket: any, head: Buffer) => {
    // Parse workspace from URL
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const workspace = url.searchParams.get('workspace');
    const afterParam = url.searchParams.get('after');
    const after = afterParam !== null ? Number(afterParam) : undefined;

    // Authenticate
    const sid = parseCookie(req.headers.cookie, 'sb_sid');
    if (!sid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = await loadSession(sid).catch(() => null);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!workspace) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const isMember = session.workspaces.some((w) => w.id === workspace);
    if (!isMember) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Upgrade to WebSocket
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, workspace, after);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, workspace: string, after: number | undefined) => {
    // Register socket
    if (!workspaceSockets.has(workspace)) workspaceSockets.set(workspace, new Set());
    workspaceSockets.get(workspace)!.add(ws);
    ensureSubscribed(workspace);

    const state: WsState = { lastSent: after ?? 0, pushing: false, pending: false };
    (ws as any).__sbState = state;

    ws.on('error', (err) => console.error(`ws error workspace=${workspace}:`, err.message));
    ws.on('close', () => {
      workspaceSockets.get(workspace)?.delete(ws);
      clearInterval(heartbeat);
      clearInterval(poller);
    });

    // Initial replay
    triggerPush(ws, workspace).catch(() => {});

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'ping' }));
      if (ws.bufferedAmount > MAX_BUFFER) {
        ws.close();
      }
    }, HEARTBEAT_MS);

    // 1-second poll (catches events when Redis pub/sub is down)
    const poller = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      triggerPush(ws, workspace).catch(() => {});
    }, POLL_MS);
  });
}

interface WsState {
  lastSent: number;
  pushing: boolean;
  pending: boolean;
}

async function triggerPush(ws: WebSocket, workspace: string): Promise<void> {
  const state = (ws as any).__sbState as WsState | undefined;
  if (!state || ws.readyState !== WebSocket.OPEN) return;
  if (state.pushing) {
    state.pending = true;
    return;
  }
  state.pushing = true;
  try {
    do {
      state.pending = false;
      state.lastSent = await pushNewEvents(ws, workspace, state.lastSent);
    } while (state.pending && ws.readyState === WebSocket.OPEN);
  } finally {
    state.pushing = false;
  }
}
