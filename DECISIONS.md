# Switchboard — Architecture & Key Decisions

## What We Built
- **Project Structure (`scaffold/server` & `scaffold/web`):** Decoupled Express + TypeScript (ESM) backend and Vite + React frontend, sharing a single multi-tenant deployment (`ws_acme`, `ws_globex`) backed by MongoDB and Redis.
- **Pigeon Webhook Ingestion (`POST /webhooks/pigeon`):**
  - **Raw-Body Signature Verification (`src/signature.ts`):** Mounted `express.raw({ type: '*/*', limit: '1mb' })` exclusively on `/webhooks/pigeon` so HMAC-SHA256 is computed over the exact raw bytes received rather than re-serialized JSON. Uses `crypto.timingSafeEqual` after strict length and hex validation, and enforces a 5-minute replay tolerance (`toleranceSeconds = 300`) while allowing small future clock skew.
  - **Strict Defensive Status Mapping:** Returns `401` for missing/malformed/bad/expired signatures, `400` for unparseable JSON or missing envelope fields (`id`, `type`, `workspace`), `200` (ignore) for unknown event types or unknown workspaces, and `503` if MongoDB fails—never `5xx` on client errors and never `2xx` if storage fails.
  - **Crash-Safe Idempotent Storage (`src/store.ts`):** No in-memory deduplication state is used; all state lives in MongoDB so multiple server instances and crash/restart cycles behave identically. Unique indexes on `messages (workspace, messageId)` and `conversations (workspace, contact)` are awaited via `ensureIndexes()` before `server.listen()`.
  - **Two-Step Idempotent Pipeline:** Every delivery (including duplicates) inserts the message (treating Mongo duplicate-key `11000` as success) and then upserts the conversation using `$setOnInsert` (for `status`, `assignee`, `createdAt`) and `$max` (for `lastActivityAt`) so out-of-order events never move activity backwards and crashes between steps self-heal on Pigeon retry.
- **Event Log and Monotonic Sequence (`store.ts`):**
  - `nextSeq(workspace)`: Atomic increment on `counters` collection with `findOneAndUpdate`.
  - `appendEvent(workspace, dedupeKey, frame)`: Idempotent event logging with unique compound indexes on `(workspace, dedupeKey)` and `(workspace, seq)`. Notifies local & remote instances via Redis pub/sub channel `sb:events:<workspace>`.
- **Outbox & Rate Limiting (`src/outbox.ts`):**
  - Distributed token bucket in Redis via Lua script (capacity 7, refill rate 3.5 tokens/sec).
  - Handles `429 Retry-After` by setting Redis cooldown keys `sb:cool:<workspace>`.
  - Background outbox worker uses atomic lease acquisition (`leaseUntil`, `leaseOwner`) with exponential backoff and jitter for resilient delivery under provider outages.
  - Delivery receipt handling via `message.status` webhook with forward-only status progression (`status.ts`: queued < sent < delivered = failed).
- **Grader Harness Integration (`src/routes/grader.ts`):**
  - Isolated under `/__grader/` router with token validation middleware (`x-grader-token`).
  - Implements `POST /__grader/reset`, `GET /__grader/snapshot`, `POST /__grader/reply`, and `POST /__grader/claim`.
  - Scoped contact creation, conversation claiming with atomic owner concurrency control, and outbound tracking.
- **Authentication & Tenant Isolation (`src/routes/auth.ts`, `src/middleware/session.ts`):**
  - OIDC PKCE (S256) flow with signed state cookie (`sb_oidc_state`).
  - Validates `id_token` using RS256 with IdP JWKS (`jose`).
  - Sessions stored in Redis under `sb:sess:<id>` (8h TTL) with httpOnly Lax cookie (`sb_sid`).
  - Scoped tenant authorization (`requireMember`) enforced on all REST endpoints and WebSocket upgrades.
- **Real-Time WebSockets (`src/ws.ts`):**
  - Multi-instance event streaming over `/ws?workspace=<ws>&after=<seq>`.
  - Single Redis subscription per process combined with local serialized event dispatch queues (`triggerPush`) to prevent interleaving frames and preserve strictly monotonic `seq` delivery.
  - Replays missed events upon reconnection without duplicating already received frames.

## Test Results
- **Harness Level 1 Check:** `24 / 24` (100% PASS - inbound completeness, zero duplicates, in-order delivery, isolation, forged/stale webhook rejection, reply exactly-once delivery, Retry-After adherence, atomic claim race, provider outage recovery).
- **Harness Level 5 Check:** `15 / 15` (100% PASS - login, session requirement, tenant isolation, unauthorized/cross-tenant socket refusal, live WebSocket frame stream with monotonic sequence, reconnect replay).

## Assumptions
- **Clock skew:** Future-dated webhook timestamps (`nowSeconds - timestamp < 0`) are accepted as valid assuming small clock drift between Pigeon and the server.
- **Duplicate-key error detection:** MongoDB error code `11000` is used as the idempotency signal for already-stored documents.
- **Session Lifetimes:** Active agent sessions default to 8 hours in Redis.
