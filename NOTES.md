# Switchboard Decision Log & Technical Notes

This document records the architectural and technical decisions made for the Switchboard application build.

---

## Decision Record 001: Project Architecture & Environment

- **Status:** Accepted
- **Context:**
  The project is **Switchboard**, a shared team inbox where simulated customers message over Pigeon, and human support agents manage conversations across multiple isolated business workspaces.
- **Decision:**
  - Standardize on the official `scaffold/` layout:
    - `scaffold/server`: Express + TypeScript backend listening on `process.env.PORT` with MongoDB and Redis.
    - `scaffold/web`: Vite + React frontend for support agents.
  - Retain the test harness (`harness/`), mock identity provider (`idp/`), and simulated Pigeon messaging provider (`pigeon/`).
  - Configure root `switchboard.json` pointing to `npm run scaffold:install` and `npm --prefix scaffold/server start`.

---

## Decision Record 002: Backend Libraries & Dependencies

- **Status:** Accepted
- **Context:**
  The backend must satisfy level checks 1 through 5:
  1. Pigeon Webhooks with HMAC-SHA256 signature verification over raw request body.
  2. IdP Authentication via OIDC and PKCE (S256).
  3. Real-time updates over WebSockets (`/ws?workspace=<id>`).
  4. Outbound replies with rate-limiting, idempotency, and outage recovery.
- **Decision:**
  - Added `ws` and `@types/ws` for real-time WebSocket connection handling.
  - Added `cors` and `@types/cors` for secure cross-origin communication with the Vite client (`http://localhost:5173`).
  - Added `cookie-parser` and `@types/cookie-parser` for reading session cookies across both HTTP APIs and WebSocket upgrade handshakes.
  - Added `jose` for lightweight OIDC token and claims verification.
  - Leveraged `mongodb` and `ioredis` for multi-tenant persistence and distributed state/locking.

---

## Decision Record 003: Version Control & Submission Compliance

- **Status:** Accepted
- **Context:**
  The repository must comply with the submission guidelines:
  - Private repository while building at `https://github.com/Ishaqznz/my-switchboard.git`.
  - Maintain `NOTES.md`, `DECISIONS.md`, and `ai-logs/`.
  - Exclude `.env` and `node_modules` from Git.
