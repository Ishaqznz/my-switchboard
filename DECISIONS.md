# Switchboard Architecture & Decisions

See [NOTES.md](file:///c:/Users/ADMIN/Documents/goghl/starter/NOTES.md) for detailed architecture decision records.

### Summary
1. **Scaffold Layout:** Using `scaffold/server` and `scaffold/web`.
2. **Backend Tech Stack:** Node.js (Node 22+), Express, TypeScript (`tsx`), MongoDB, Redis (`ioredis`), WebSockets (`ws`), OIDC/PKCE (`jose`).
3. **Pigeon Integration:** Handling `message.inbound` and `message.status` webhooks with HMAC-SHA256 verification and replay protection.
4. **Tenant Isolation:** Workspace boundaries enforced on every query and WebSocket frame (`seq` integer ordering).
