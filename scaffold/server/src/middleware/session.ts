import type { Request, Response, NextFunction } from 'express';
import { getRedis } from '../redis.js';

export interface SessionData {
  sub: string;
  name: string;
  email: string;
  workspaces: Array<{ id: string; role: string }>;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      session?: SessionData;
    }
  }
}

function parseSidCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const entry = cookieHeader.split(';').map((s) => s.trim()).find((s) => s.startsWith('sb_sid='));
  if (!entry) return null;
  return entry.slice('sb_sid='.length) || null;
}

/** Reads sb_sid cookie, looks up Redis, attaches session to req. 401 if missing. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const sid = parseSidCookie(req.headers.cookie);
  if (!sid) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }

  let data: SessionData | null = null;
  try {
    const raw = await getRedis().get(`sb:sess:${sid}`);
    if (raw) data = JSON.parse(raw) as SessionData;
  } catch {
    // Redis down: treat as unauthenticated
  }

  if (!data) {
    res.status(401).json({ error: 'session expired or invalid' });
    return;
  }

  req.session = data;
  next();
}

/** Returns middleware that checks workspace membership. Must be used after requireSession. */
export function requireMember(workspaceParam: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const workspace = req.query[workspaceParam] as string || (req.body && req.body[workspaceParam]);
    if (!workspace) {
      res.status(400).json({ error: 'workspace required' });
      return;
    }
    const isMember = req.session!.workspaces.some((w) => w.id === workspace);
    if (!isMember) {
      res.status(403).json({ error: 'not a member of this workspace' });
      return;
    }
    next();
  };
}
