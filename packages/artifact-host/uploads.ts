import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const FILE_LIMIT = 25 * 1024 * 1024;
export const BODY_LIMIT = FILE_LIMIT + 1024 * 1024;
export const SLUG = /^[a-z0-9]{8,16}$/;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function safePath(path: string): boolean {
  return (
    Buffer.byteLength(path) <= 1024 &&
    path.split('/').length <= 16 &&
    path.split('/').every((p) => !!p && !p.startsWith('.') && !/[\\%?#:\x00-\x1f\x7f]/.test(p))
  );
}
export async function readBody(req: IncomingMessage, limit = 16384): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, 'Request too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON required');
  try {
    const value = JSON.parse((await readBody(req)).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON');
  }
}
export interface Asset {
  path: string;
  bytes: Buffer;
}
export interface Upload {
  files: Asset[];
  title: string;
  originalFilename: string;
  digest: string;
}
export async function multipart(req: IncomingMessage): Promise<Upload> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Multipart required');
  const raw = await readBody(req, BODY_LIMIT);
  let form: FormData;
  try {
    form = await new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(raw),
    }).formData();
  } catch {
    throw new HttpError(400, 'Invalid multipart');
  }
  const parts = form.getAll('files');
  const pathsPart = form.getAll('paths');
  const titles = form.getAll('title');
  if (
    !parts.length ||
    parts.length > 256 ||
    pathsPart.length !== 1 ||
    titles.length > 1 ||
    [...form.keys()].some((k) => !['files', 'paths', 'title'].includes(k))
  )
    throw new HttpError(400, 'Invalid multipart fields');
  let paths: unknown;
  try {
    paths = JSON.parse(String(pathsPart[0]));
  } catch {
    throw new HttpError(400, 'Invalid paths');
  }
  if (
    !Array.isArray(paths) ||
    paths.length !== parts.length ||
    paths.some((p) => typeof p !== 'string' || !safePath(p)) ||
    new Set(paths).size !== paths.length
  )
    throw new HttpError(400, 'Unsafe or duplicate paths');
  const files: Asset[] = [];
  let size = 0;
  for (const [i, part] of parts.entries()) {
    if (typeof part === 'string') throw new HttpError(400, 'File required');
    size += part.size;
    if (size > FILE_LIMIT) throw new HttpError(413, 'File bytes exceed 25 MiB');
    files.push({ path: paths[i], bytes: Buffer.from(await part.arrayBuffer()) });
  }
  const originalFilename = files[0]!.path;
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path));
  if (htmlFiles.length === 1 && !htmlFiles[0]!.path.includes('/')) htmlFiles[0]!.path = 'index.html';
  if (!files.some((f) => f.path === 'index.html')) throw new HttpError(400, 'An index.html entry is required');
  if (files.some((f) => files.some((other) => other.path.startsWith(f.path + '/'))))
    throw new HttpError(400, 'Conflicting paths');
  const supplied = titles[0];
  if (supplied !== undefined && (typeof supplied !== 'string' || supplied.length > 1000))
    throw new HttpError(400, 'Invalid title');
  const title = (
    supplied ||
    files
      .find((f) => f.path === 'index.html')!
      .bytes.toString('utf8')
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.trim() ||
    originalFilename
  ).slice(0, 1000);
  const hash = createHash('sha256').update(JSON.stringify([title, originalFilename]));
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(JSON.stringify([f.path, f.bytes.length])).update(f.bytes);
  return { files, title, originalFilename, digest: hash.digest('hex') };
}
export function mime(path: string): string {
  return (
    (
      {
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.txt': 'text/plain; charset=utf-8',
        '.pdf': 'application/pdf',
      } as Record<string, string>
    )[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}
