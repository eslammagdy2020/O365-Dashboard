import session from 'express-session';
import type { RequestHandler } from 'express';
import type { Database } from 'better-sqlite3';
import type { SessionData } from 'express-session';
import type { AppConfig } from '../config/env.js';

type StoredSession = SessionData & { cookie: SessionData['cookie'] };

export class SqliteSessionStore extends session.Store {
  constructor(private readonly database: Database) {
    super();
    database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }

  get(sid: string, callback: (error?: unknown, session?: SessionData | null) => void): void {
    try {
      const row = this.database
        .prepare('SELECT sess_json, expires_at FROM sessions WHERE sid = ? AND expires_at > ?')
        .get(sid, new Date().toISOString()) as
        { sess_json: string; expires_at: string } | undefined;
      callback(undefined, row ? (JSON.parse(row.sess_json) as SessionData) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    try {
      const stored = value as StoredSession;
      const expiresAt = stored.cookie?.expires
        ? new Date(stored.cookie.expires).toISOString()
        : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      this.database
        .prepare(
          'INSERT INTO sessions (sid, sess_json, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess_json = excluded.sess_json, expires_at = excluded.expires_at',
        )
        .run(sid, JSON.stringify(value), expiresAt);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  destroy(sid: string, callback?: (error?: unknown) => void): void {
    try {
      this.database.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  override touch(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    try {
      const stored = value as StoredSession;
      const expiresAt = stored.cookie?.expires
        ? new Date(stored.cookie.expires).toISOString()
        : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      this.database.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }
}

export function createSessionMiddleware(config: AppConfig, database: Database): RequestHandler {
  const backend = new URL(config.REDIRECT_URI);
  return session({
    name: 'occ.sid',
    secret: config.SESSION_SECRET,
    store: new SqliteSessionStore(database),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: backend.protocol === 'https:',
    },
  });
}
