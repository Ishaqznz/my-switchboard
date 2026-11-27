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

## Decision Record 004: Final Submission & Commit SHA

- **Status:** Completed
- **Commit ID:** `73d8f342e52d18aaa69ac3c9e78f1f60329eca40`
- **Repository URL:** `https://github.com/Ishaqznz/my-switchboard.git`
- **Check Suite Score:** 71 / 75 (`CHECK_REPORT.json` committed)
- **Checklist:**
  - `README.md` present
  - `DECISIONS.md` present
  - `CHECK_REPORT.json` present
  - `switchboard.json` present
  - `ai-logs/` present
  - No `.env` or `node_modules` committed
