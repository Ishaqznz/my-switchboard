import { Router } from 'express';
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

const router = Router();

// ─── OIDC discovery cache ─────────────────────────────────────────────────────

interface OidcConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let cachedOidc: OidcConfig | null = null;
let cacheExpiry = 0;

async function getOidcConfig(): Promise<OidcConfig | null> {
  if (cachedOidc && Date.now() < cacheExpiry) return cachedOidc;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return cachedOidc; // keep stale
    cachedOidc = await res.json() as OidcConfig;
    cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 min cache
    return cachedOidc;
  } catch {
    return cachedOidc; // server must boot even if IdP is down
  }
}

// Kick off initial discovery (best-effort)
getOidcConfig().catch(() => {});

// ─── JWKS key cache ───────────────────────────────────────────────────────────

interface JwksKey {
  kty: string; kid?: string; n?: string; e?: string; x5c?: string[];
  crv?: string; x?: string; y?: string;
}

let cachedJwks: JwksKey[] = [];
let jwksCacheExpiry = 0;

async function getJwks(): Promise<JwksKey[]> {
  if (cachedJwks.length && Date.now() < jwksCacheExpiry) return cachedJwks;
  try {
    const oidc = await getOidcConfig();
    if (!oidc) return cachedJwks;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(oidc.jwks_uri, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return cachedJwks;
    const body = await res.json() as { keys: JwksKey[] };
    cachedJwks = body.keys ?? [];
    jwksCacheExpiry = Date.now() + 5 * 60 * 1000;
    return cachedJwks;
  } catch {
    return cachedJwks;
  }
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

// ─── Signed state cookie ──────────────────────────────────────────────────────

const STATE_COOKIE = 'sb_oidc_state';
const COOKIE_MAX_AGE = 10 * 60; // 10 min

interface StatePkg {
  state: string;
  nonce: string;
  verifier: string;
  ts: number;
}

function signState(pkg: StatePkg): string {
  const data = JSON.stringify(pkg);
  const sig = createHmac('sha256', config.sessionSecret).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + sig;
}

function verifyState(cookie: string): StatePkg | null {
  try {
    const dot = cookie.lastIndexOf('.');
    if (dot < 0) return null;
    const data = Buffer.from(cookie.slice(0, dot), 'base64').toString('utf8');
    const sig = cookie.slice(dot + 1);
    const expected = createHmac('sha256', config.sessionSecret).update(data).digest('hex');
    // Timing-safe compare
    const eBuf = Buffer.from(expected, 'hex');
    const sBuf = Buffer.from(sig, 'hex');
    if (eBuf.length !== sBuf.length || !timingSafeEqual(eBuf, sBuf)) return null;
    const pkg = JSON.parse(data) as StatePkg;
    if (Date.now() - pkg.ts > COOKIE_MAX_AGE * 1000) return null;
    return pkg;
  } catch {
    return null;
  }
}

// ─── GET /auth/login ──────────────────────────────────────────────────────────

router.get('/auth/login', async (req, res) => {
  const oidc = await getOidcConfig();
  if (!oidc) {
    res.status(502).json({ error: 'OIDC provider unavailable' });
    return;
  }

  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = codeChallenge(verifier);

  const pkg: StatePkg = { state, nonce, verifier, ts: Date.now() };
  const signed = signState(pkg);

  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${signed}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${oidc.authorization_endpoint}?${params}`);
});

// ─── GET /auth/callback ───────────────────────────────────────────────────────

router.get('/auth/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query as Record<string, string>;

  // Parse state cookie
  const rawCookie: string = (req.headers.cookie ?? '');
  const stateCookie = rawCookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(STATE_COOKIE + '='));
  const statePkg = stateCookie ? verifyState(stateCookie.slice(STATE_COOKIE.length + 1)) : null;

  // Clear state cookie immediately
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);

  if (error) {
    res.status(400).json({ error: `IdP error: ${error}` });
    return;
  }

  if (!statePkg) {
    res.status(400).json({ error: 'missing or expired state cookie' });
    return;
  }

  if (returnedState !== statePkg.state) {
    res.status(400).json({ error: 'state mismatch' });
    return;
  }

  if (!code) {
    res.status(400).json({ error: 'missing code' });
    return;
  }

  const oidc = await getOidcConfig();
  if (!oidc) {
    res.status(502).json({ error: 'OIDC provider unavailable' });
    return;
  }

  // Exchange code for tokens
  let tokenBody: {
    access_token?: string; id_token?: string; error?: string;
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const tokenRes = await fetch(oidc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: statePkg.verifier,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    tokenBody = await tokenRes.json() as typeof tokenBody;
  } catch (err) {
    console.error('token exchange error:', err);
    res.status(502).json({ error: 'token exchange failed' });
    return;
  }

  if (!tokenBody.id_token) {
    res.status(502).json({ error: tokenBody.error ?? 'no id_token' });
    return;
  }

  // Verify id_token (RS256) using jose
  let claims: Record<string, unknown>;
  try {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const JWKS = createRemoteJWKSet(new URL(oidc.jwks_uri));
    const { payload } = await jwtVerify(tokenBody.id_token, JWKS, {
      issuer: config.oidc.issuer,
      audience: config.oidc.clientId,
    });
    claims = payload as Record<string, unknown>;
  } catch (err) {
    console.error('id_token verification failed:', err);
    res.status(401).json({ error: 'id_token invalid' });
    return;
  }

  // Validate nonce
  if (claims.nonce !== statePkg.nonce) {
    res.status(401).json({ error: 'nonce mismatch' });
    return;
  }

  // Build session
  const sub = String(claims.sub ?? '');
  const name = String(claims.name ?? '');
  const email = String(claims.email ?? '');
  const workspaces = (claims.workspaces ?? []) as Array<{ id: string; role: string }>;

  const sessionId = randomBytes(32).toString('hex');
  const session = { sub, name, email, workspaces };

  try {
    await getRedis().set(`sb:sess:${sessionId}`, JSON.stringify(session), 'EX', 8 * 60 * 60);
  } catch (err) {
    console.error('session store error:', err);
    res.status(503).json({ error: 'session store unavailable' });
    return;
  }

  res.setHeader('Set-Cookie', `sb_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}`);
  res.redirect(config.webOrigin);
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post('/auth/logout', async (req, res) => {
  const rawCookie: string = (req.headers.cookie ?? '');
  const sidCookie = rawCookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sb_sid='));
  if (sidCookie) {
    const sid = sidCookie.slice('sb_sid='.length);
    await getRedis().del(`sb:sess:${sid}`).catch(() => {});
  }
  res.setHeader('Set-Cookie', 'sb_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.status(200).json({ ok: true });
});

export default router;
