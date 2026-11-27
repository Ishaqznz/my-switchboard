# Switchboard

A multi-tenant, reliable shared customer support inbox built for harsh real-world network conditions (delayed/dropped requests, replayed events, hostile providers, and sudden process terminations).

---

## Prerequisites

- **Node.js**: >= 22.0.0 (Node 22 or 24 recommended)
- **Docker & Docker Compose**: For local infrastructure services (MongoDB, Redis, Pigeon messaging simulator, Mock IdP, Paybox)
- **Git** with Bash / `sh` available in `PATH`

---

## Quick Start (Clean Clone)

### 1. Clone the Repository

```bash
git clone https://github.com/Ishaqznz/my-switchboard.git
cd my-switchboard
```

### 2. Environment Configuration

Copy the example environment configuration into `.env` (the defaults work out-of-the-box with the local Docker containers and test harness):

```bash
cp .env.example .env
```

### 3. Start Infrastructure Dependencies

Start the required backing services (MongoDB, Redis, Pigeon messaging simulator, Mock IdP, Paybox):

```bash
npm run up
```

Verify that all dependencies and ports are ready:

```bash
npm run doctor
```

> **Without Docker?** You can run `npm run mocks` with standard Node.js and point `MONGO_URL` and `REDIS_URL` in `.env` to your local MongoDB and Redis instances.

### 4. Install Dependencies

Install dependencies for both backend and frontend:

```bash
npm run scaffold:install
```

---

## Running in Development

### Start the Server (Backend)

The server runs Express with TypeScript (ESM, NodeNext) using `tsx`:

```bash
npm run scaffold:server
```
Server listens on `http://localhost:4000` (or the port specified by `$PORT`).

### Start the Web Application (Frontend)

```bash
npm run scaffold:web
```
Frontend runs with Vite on `http://localhost:5173`.

---

## Running the Automated Test Harness & Grader Checks

> **Important:** Stop your local dev server (`Ctrl+C`) before running any checks. The test harness launches and manages isolated server instances on custom ports behind an internal round-robin load balancer.

### Run Level 1 Check (Inbound Webhooks, Outbox, Atomicity, Outages)
```bash
npm run check
```

### Run Specific Levels (e.g. Level 5: Login, Isolation & WebSockets)
```bash
npm run check -- --levels 5
```

### Run Full Grader Suite
```bash
npm run check:full
```
This runs the full test suite (Levels 1, 2, 3, and 5) across multiple simulated instances and writes `CHECK_REPORT.json`.

---

## Architecture & Implementation Overview

- **Raw HMAC Webhook Ingestion (`POST /webhooks/pigeon`):**
  Uses `express.raw()` for strict binary HMAC-SHA256 signature verification over exact incoming bytes. Enforces replay protection (5-minute tolerance) and handles duplicate/out-of-order events idempotently.
- **Persistent Outbox & Token Bucket Rate Limiting (`scaffold/server/src/outbox.ts`):**
  Shared Redis Lua token bucket (capacity 7, 3.5 tokens/sec refill). Background lease-based outbox worker claims outbound replies with atomic timeouts, exponential backoff, jitter, and automatic `429 Retry-After` cooldown handling.
- **OIDC Authentication & Tenant Isolation (`scaffold/server/src/routes/auth.ts`):**
  PKCE (S256) authentication with signed state cookies, RS256 `id_token` verification via IdP JWKS, Redis sessions (8-hour TTL), and workspace membership validation on all routes.
- **Real-Time WebSocket Event Stream (`scaffold/server/src/ws.ts`):**
  Streams sequence-ordered (`seq`) events via Redis pub/sub (`sb:events:<workspace>`) with per-socket serialization to guarantee monotonic order and lossless gap replay upon reconnection.

For full architectural reasoning and decisions, see [DECISIONS.md](DECISIONS.md).

---

## Test Users (Mock IdP)

Login does not require passwords; click any user on the mock IdP page:

| User | `sub` | Workspaces | Role |
| :--- | :--- | :--- | :--- |
| **Asha Rao** (`asha@acme.test`) | `u_asha` | `ws_acme` | Admin |
| **Ben Ortiz** (`ben@acme.test`) | `u_ben` | `ws_acme` | Agent |
| **Chloe Martin** (`chloe@globex.test`) | `u_chloe` | `ws_globex` | Admin |
| **Dev Patel** (`dev@globex.test`) | `u_dev` | `ws_globex` | Agent |
| **Eli Novak** (`eli@contractor.test`) | `u_eli` | `ws_acme`, `ws_globex` | Multi-workspace Agent |
