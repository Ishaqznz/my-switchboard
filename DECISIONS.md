# Switchboard — Architecture & Key Decisions

## What We Built So Far
- **Project Structure (`scaffold/server` & `scaffold/web`):** Decoupled Express + TypeScript (ESM) backend and Vite + React frontend, sharing a single multi-tenant deployment (`ws_acme`, `ws_globex`) backed by MongoDB and Redis.
- **Pigeon Webhook Ingestion (`POST /webhooks/pigeon`):**
  - **Raw-Body Signature Verification (`src/signature.ts`):** Mounted `express.raw({ type: '*/*', limit: '1mb' })` exclusively on `/webhooks/pigeon` so HMAC-SHA256 is computed over the exact raw bytes received rather than re-serialized JSON. Uses `crypto.timingSafeEqual` after strict length and hex validation, and enforces a 5-minute replay tolerance (`toleranceSeconds = 300`) while allowing small future clock skew.
  - **Strict Defensive Status Mapping:** Returns `401` for missing/malformed/bad/expired signatures, `400` for unparseable JSON or missing envelope fields (`id`, `type`, `workspace`), `200` (ignore) for unknown event types or unknown workspaces, and `503` if MongoDB fails—never `5xx` on client errors and never `2xx` if storage fails.
  - **Crash-Safe Idempotent Storage (`src/store.ts`):** No in-memory deduplication state is used; all state lives in MongoDB so multiple server instances and crash/restart cycles behave identically. Unique indexes on `messages (workspace, messageId)` and `conversations (workspace, contact)` are awaited via `ensureIndexes()` before `server.listen()`.
  - **Two-Step Idempotent Pipeline:** Every delivery (including duplicates) inserts the message (treating Mongo duplicate-key `11000` as success) and then upserts the conversation using `$setOnInsert` (for `status`, `assignee`, `createdAt`) and `$max` (for `lastActivityAt`) so out-of-order events never move activity backwards and crashes between steps self-heal on Pigeon retry.

## What Is Deferred / Next
- `message.status` webhook handling (stubbed with `200` + `TODO`) will be wired into the outbound reply pipeline.
- OIDC/PKCE authentication, WebSocket real-time fanout (`seq`-ordered via Redis), and grader endpoints (`/__grader/*`) will be layered onto the same `store.ts` and `http.Server`.

## Assumptions
- **Clock skew:** Future-dated webhook timestamps (`nowSeconds - timestamp < 0`) are accepted as valid assuming small clock drift between Pigeon and the server.
- **Duplicate-key error detection:** MongoDB error code `11000` is used as the idempotency signal for already-stored `messages` documents.
