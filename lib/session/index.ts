import 'server-only';
import { cookies } from 'next/headers';
import type Database from 'better-sqlite3';
import { newOpaqueToken, newUuid, sha256Hex } from '@/lib/crypto';
import { getDb } from '@/lib/db';
import { appendLedgerEvent } from '@/lib/ledger';

export const SESSION_COOKIE_NAME = 'tollgate_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionRecord {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  status: string;
}

export class SessionRequiredError extends Error {
  constructor(message = 'A valid Tollgate session is required') {
    super(message);
    this.name = 'SessionRequiredError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found in current session`);
    this.name = 'ResourceNotFoundError';
  }
}

function shouldUseSecureCookie(): boolean {
  const appUrl = process.env.APP_BASE_URL?.trim() ?? '';
  return process.env.NODE_ENV === 'production' && appUrl.startsWith('https://');
}

export function createSessionRecord(
  db: Database.Database,
  userAgent?: string | null
): { session: SessionRecord; rawToken: string } {
  const id = newUuid();
  const rawToken = newOpaqueToken(32);
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const createdAtIso = now.toISOString();
  const expiresAtIso = expiresAt.toISOString();
  const uaHash = userAgent ? sha256Hex(userAgent) : null;

  db.prepare(
    `INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at, user_agent_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`
  ).run(id, tokenHash, createdAtIso, createdAtIso, expiresAtIso, uaHash);

  appendLedgerEvent(db, {
    sessionId: id,
    eventType: 'SESSION_CREATED',
    actor: 'TOLLGATE',
    payload: {
      session_id: id,
      expires_at: expiresAtIso,
    },
    createdAt: createdAtIso,
  });

  return {
    session: {
      id,
      created_at: createdAtIso,
      last_seen_at: createdAtIso,
      expires_at: expiresAtIso,
      status: 'ACTIVE',
    },
    rawToken,
  };
}

export function findActiveSessionByToken(
  db: Database.Database,
  rawToken: string
): SessionRecord | null {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = sha256Hex(rawToken);
  const row = db
    .prepare(
      `SELECT id, created_at, last_seen_at, expires_at, status
       FROM sessions
       WHERE token_hash = ? AND status = 'ACTIVE'`
    )
    .get(tokenHash) as SessionRecord | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(`UPDATE sessions SET status = 'EXPIRED' WHERE id = ?`).run(row.id);
    return null;
  }

  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    row.id
  );
  return row;
}

/**
 * Reads the current session from the HttpOnly cookie without mutating cookies.
 * Safe for Server Components.
 */
export async function getCurrentSession(): Promise<SessionRecord | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;
  const db = getDb();
  return findActiveSessionByToken(db, rawToken);
}

/**
 * Reads or initializes an anonymous session and sets the HttpOnly SameSite=Lax cookie.
 * Use ONLY inside Route Handlers or Server Actions (where setting cookies is allowed).
 */
export async function getOrCreateSession(
  userAgent?: string | null
): Promise<{ session: SessionRecord; isNew: boolean }> {
  const cookieStore = await cookies();
  const existingToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const db = getDb();

  if (existingToken) {
    const existing = findActiveSessionByToken(db, existingToken);
    if (existing) {
      return { session: existing, isNew: false };
    }
  }

  const { session, rawToken } = createSessionRecord(db, userAgent);
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookie(),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  return { session, isNew: true };
}

/**
 * Requires an active session cookie in Route Handlers that operate on existing session data.
 */
export async function requireCurrentSession(): Promise<SessionRecord> {
  const session = await getCurrentSession();
  if (!session) {
    throw new SessionRequiredError();
  }
  return session;
}

/**
 * Guard helper ensuring database records belong to the active session.
 */
export function assertSessionOwned<T extends { session_id: string }>(
  row: T | undefined | null,
  sessionId: string,
  resourceName: string
): T {
  if (!row || row.session_id !== sessionId) {
    throw new ResourceNotFoundError(resourceName);
  }
  return row;
}

