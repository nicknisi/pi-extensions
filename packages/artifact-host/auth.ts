import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Store } from './store.js';
import { HttpError } from './uploads.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
export const COOKIE = 'artifact_viewer';
export class ViewingAuth {
  constructor(
    private store: Store,
    generation: string,
    private now = Date.now,
  ) {
    const db = store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS viewing_tickets (hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS viewing_sessions (hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS read_capabilities (hash TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES viewing_sessions(hash) ON DELETE CASCADE,slug TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL);`);
    store.transaction(() => {
      const old = db.prepare("SELECT value FROM auth_meta WHERE key='generation'").get();
      if (old?.value !== generation) {
        db.exec('DELETE FROM viewing_tickets; DELETE FROM viewing_sessions;');
        db.prepare("INSERT OR REPLACE INTO auth_meta VALUES('generation',?)").run(generation);
      }
    });
  }
  clean() {
    const db = this.store.db,
      now = this.now();
    db.prepare('DELETE FROM viewing_tickets WHERE expires<=?').run(now);
    db.prepare('DELETE FROM viewing_sessions WHERE expires<=?').run(now);
    db.prepare('DELETE FROM read_capabilities WHERE expires<=?').run(now);
  }
  bound() {
    this.clean();
    const row = this.store.db
      .prepare(
        'SELECT (SELECT count(*) FROM viewing_tickets)+(SELECT count(*) FROM viewing_sessions)+(SELECT count(*) FROM read_capabilities) AS n',
      )
      .get()!;
    if (Number(row.n) >= 3000) throw new HttpError(429, 'Viewing session limit');
  }
  ticket(target: unknown) {
    if (typeof target !== 'string' || !/^\/[a-z0-9]{8,16}\/$/.test(target))
      throw new HttpError(400, 'Invalid viewer return path');
    this.store.get(target.split('/')[1]!);
    this.bound();
    const value = secret();
    this.store.db.prepare('INSERT INTO viewing_tickets VALUES(?,?,?)').run(hash(value), this.now() + 60000, target);
    return value;
  }
  consume(value: string) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new HttpError(401, 'Invalid or expired sign-in');
    return this.store.transaction(() => {
      this.bound();
      const ticket = this.store.db
        .prepare('DELETE FROM viewing_tickets WHERE hash=? AND expires>? RETURNING target')
        .get(hash(value), this.now());
      if (!ticket) throw new HttpError(401, 'Invalid or expired sign-in');
      const session = this.newSession();
      return { ...session, target: String(ticket.target) };
    });
  }
  newSession() {
    this.bound();
    const value = secret(),
      expires = this.now() + 30 * 60000;
    this.store.db.prepare('INSERT INTO viewing_sessions VALUES(?,?)').run(hash(value), expires);
    return { value, hash: hash(value), expires };
  }
  session(req: IncomingMessage): { hash: string; expires: number } | undefined {
    const matches = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.startsWith(COOKIE + '='));
    if (matches.length !== 1) return;
    const value = matches[0]!.slice(COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) return;
    const row = this.store.db
      .prepare('SELECT * FROM viewing_sessions WHERE hash=? AND expires>?')
      .get(hash(value), this.now());
    return row ? { hash: String(row.hash), expires: Number(row.expires) } : undefined;
  }
  capability(session: { hash: string; expires: number }, slug: string, version: number) {
    this.bound();
    const value = secret();
    this.store.db
      .prepare('INSERT INTO read_capabilities VALUES(?,?,?,?,?)')
      .run(hash(value), session.hash, slug, version, Math.min(session.expires, this.now() + 5 * 60000));
    return value;
  }
  allows(value: string, slug: string, version: number) {
    if (!/^[a-f0-9]{64}$/.test(value)) return false;
    return !!this.store.db
      .prepare(
        'SELECT c.hash FROM read_capabilities c JOIN viewing_sessions s ON c.session=s.hash WHERE c.hash=? AND c.slug=? AND c.version=? AND c.expires>? AND s.expires>?',
      )
      .get(hash(value), slug, version, this.now(), this.now());
  }
  logout(req: IncomingMessage) {
    const session = this.session(req);
    if (session) this.store.db.prepare('DELETE FROM viewing_sessions WHERE hash=?').run(session.hash);
  }
}
