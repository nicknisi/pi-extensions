import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, type Upload } from './uploads.js';

export interface Artifact {
  slug: string;
  title: string;
  custom_title: number;
  original_filename: string;
  current_version: number;
  is_public: number;
  is_bookmarked: number;
  created_at: string;
  updated_at: string;
}
export class Store {
  db: DatabaseSync;
  constructor(
    dataDir: string,
    public owner: string,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'artifacts.sqlite'));
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (existing && version !== 2) {
      this.db.close();
      throw new Error(
        'Incompatible development database. Keep a backup and select a new data directory. Existing data was not removed.',
      );
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS artifacts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, custom_title INTEGER NOT NULL DEFAULT 0, original_filename TEXT NOT NULL, current_version INTEGER NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, is_bookmarked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (slug TEXT NOT NULL REFERENCES artifacts ON DELETE CASCADE, version INTEGER NOT NULL, title TEXT NOT NULL, original_filename TEXT NOT NULL, archived_at TEXT, archived_by TEXT, PRIMARY KEY(slug,version));
      CREATE TABLE IF NOT EXISTS files (slug TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(slug,version,path), FOREIGN KEY(slug,version) REFERENCES versions ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      PRAGMA user_version=2;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get(slug: string): Artifact {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE slug=?').get(slug);
    if (!row) throw new HttpError(404, 'Not found');
    return row as unknown as Artifact;
  }
  guard(row: Artifact, match?: string) {
    if (match !== undefined && match !== `"${row.current_version}"`) throw new HttpError(412, 'Version conflict');
  }
  publish(upload: Upload, slug: string | undefined, match: string | undefined, key: string | undefined) {
    const fingerprint = JSON.stringify([slug ?? 'upload', match ?? null, upload.digest]);
    return this.transaction(() => {
      if (key) {
        const old = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new HttpError(409, 'Idempotency key reused with different content');
          return JSON.parse(String(old.result)) as { slug: string; current_version: number; is_public: boolean };
        }
        if (Number(this.db.prepare('SELECT count(*) AS n FROM operations').get()!.n) >= 10000)
          throw new HttpError(507, 'Operation limit reached');
      }
      const old = slug ? this.get(slug) : undefined;
      if (old) this.guard(old, match);
      else if (match !== undefined && match !== '"0"') throw new HttpError(412, 'Version conflict');
      const bytes = upload.files.reduce((n, f) => n + f.bytes.length, 0);
      const used = Number(this.db.prepare('SELECT coalesce(sum(length(bytes)),0) AS n FROM files').get()!.n);
      if (used + bytes > 1024 ** 3) throw new HttpError(507, 'Instance storage limit reached');
      if (old && old.current_version >= 100) throw new HttpError(507, 'History limit reached');
      if (!old && Number(this.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n) >= 1000)
        throw new HttpError(507, 'Artifact limit reached');
      const id = slug ?? randomBytes(6).toString('hex');
      const version = (old?.current_version ?? 0) + 1;
      const title = old?.custom_title ? old.title : upload.title;
      const now = new Date().toISOString();
      if (old) {
        this.db
          .prepare('UPDATE versions SET title=?, archived_at=?, archived_by=? WHERE slug=? AND version=?')
          .run(old.title, now, this.owner, id, old.current_version);
        this.db
          .prepare('UPDATE artifacts SET title=?,original_filename=?,current_version=?,updated_at=? WHERE slug=?')
          .run(title, upload.originalFilename, version, now, id);
      } else
        this.db
          .prepare(
            'INSERT INTO artifacts(slug,title,original_filename,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          )
          .run(id, title, upload.originalFilename, version, now, now);
      this.db
        .prepare('INSERT INTO versions(slug,version,title,original_filename) VALUES(?,?,?,?)')
        .run(id, version, title, upload.originalFilename);
      const insert = this.db.prepare('INSERT INTO files VALUES(?,?,?,?)');
      for (const file of upload.files) insert.run(id, version, file.path, file.bytes);
      const result = { slug: id, current_version: version, is_public: !!old?.is_public };
      if (key) this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  list() {
    return (
      this.db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC, rowid DESC').all() as unknown as Artifact[]
    ).map((row) => ({
      ...row,
      is_public: !!row.is_public,
      is_bookmarked: !!row.is_bookmarked,
      uploader_email: this.owner,
      comment_count: 0,
    }));
  }
  patch(slug: string, body: Record<string, unknown>, match?: string) {
    if (
      (!Object.hasOwn(body, 'title') && !Object.hasOwn(body, 'is_public')) ||
      Object.keys(body).some((k) => !['title', 'is_public'].includes(k)) ||
      (Object.hasOwn(body, 'title') && (typeof body.title !== 'string' || body.title.length > 1000)) ||
      (Object.hasOwn(body, 'is_public') && typeof body.is_public !== 'boolean')
    )
      throw new HttpError(400, 'Invalid metadata');
    return this.transaction(() => {
      const row = this.get(slug);
      this.guard(row, match);
      const title = typeof body.title === 'string' ? body.title.trim() : row.title;
      const publicValue = typeof body.is_public === 'boolean' ? Number(body.is_public) : row.is_public;
      this.db
        .prepare('UPDATE artifacts SET title=?,custom_title=?,is_public=?,updated_at=? WHERE slug=?')
        .run(
          title,
          body.title !== undefined ? Number(!!title) : row.custom_title,
          publicValue,
          new Date().toISOString(),
          slug,
        );
      return { ok: true, title, is_public: !!publicValue, current_version: row.current_version };
    });
  }
  versions(slug: string) {
    const row = this.get(slug);
    return {
      current_version: row.current_version,
      versions: this.db
        .prepare(
          'SELECT v.*, (SELECT count(*) FROM files f WHERE f.slug=v.slug AND f.version=v.version) AS file_count FROM versions v WHERE slug=? AND version<>? ORDER BY version DESC',
        )
        .all(slug, row.current_version)
        .map((v) => ({ ...v, prefix: `${slug}/versions/${v.version}/` })),
    };
  }
  restore(slug: string, version: number, match?: string) {
    const row = this.get(slug);
    const archive = this.db
      .prepare('SELECT * FROM versions WHERE slug=? AND version=? AND archived_at IS NOT NULL')
      .get(slug, version);
    if (!archive) throw new HttpError(404, 'Version not found');
    const files = this.db
      .prepare('SELECT path,bytes FROM files WHERE slug=? AND version=?')
      .all(slug, version)
      .map((f) => ({ path: String(f.path), bytes: Buffer.from(f.bytes as Uint8Array) }));
    return this.publish(
      { files, title: String(archive.title), originalFilename: String(archive.original_filename), digest: '' },
      slug,
      match ?? `"${row.current_version}"`,
      undefined,
    );
  }
}
