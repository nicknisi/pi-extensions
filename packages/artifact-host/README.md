# @nicknisi/pi-artifact-host

Standalone Node 24+ Drop-compatible artifact host. It uses built-in HTTP, bounded `Request.formData`, and SQLite BLOB transactions. It has no Pi runtime, framework, ORM, Cloudflare, or third-party runtime dependency.

This independently implemented reference targets Drop at `e924002df3e0cd88c6a18c03e45ecc4c2c88c14a`. Existing clients must configure the server URL and `Authorization: Bearer` transport instead of their hardcoded hosts and Cloudflare authentication. Wire fixtures are not proof that actual upstream clients were executed. No WorkOS source, branding, fonts, or bundles are included. Comments and review endpoints are deferred to phase 2.

## Start

```sh
# Generate a private token in your secret manager. Keep it out of HTML and URLs.
# Configure ARTIFACT_HOST_TOKEN_SHA256 with its SHA-256 hex digest.
pi-artifact-host --data-dir ./data --port 8080
```

The default listener is `127.0.0.1`. Loopback-only development can derive its canonical origin from the listening socket, including port 0. Production must configure an HTTPS canonical origin, even when a reverse proxy connects to local HTTP:

```sh
pi-artifact-host --host 0.0.0.0 --port 8080 --data-dir /data \
  --canonical-url https://artifacts.example --owner-email owner@example.com
```

Environment equivalents are `ARTIFACT_HOST_HOST`, `ARTIFACT_HOST_PORT`, `ARTIFACT_HOST_DATA_DIR`, `ARTIFACT_HOST_CANONICAL_URL`, and `ARTIFACT_HOST_OWNER_EMAIL`. The owner defaults to `owner@localhost` for development. Untrusted Host, forwarded, or email headers never choose absolute URLs or establish identity.

Programmatic lifecycle:

```js
import { startHost } from '@nicknisi/pi-artifact-host';
const host = await startHost({ dataDir, tokenSha256, host: '127.0.0.1', port: 0 });
console.log(host.origin);
await host.close();
```

`canonicalUrl` and `ownerEmail` are optional additions to the existing configuration. Importing the package opens no resources. Use one process per data directory.

## HTTP contract

`openapi.json` is the published contract. All `/api/` routes require the owner bearer, including listings and history. Cookies and capabilities never authorize management.

| Method      | Path                                         | Behavior                                                                                                                          |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST        | `/api/upload`                                | Repeated multipart `files`, JSON-array `paths`, optional `title`. Returns `{slug,url,current_version,is_public}`. Starts private. |
| GET         | `/api/recent`                                | `scope=all                                                                                                                        | mine`, `page`, `pageSize=10 | 25  | 100`. Clamped newest-first pagination. |
| GET         | `/api/links`                                 | Owner catalog with boolean visibility/bookmark fields and configured uploader identity.                                           |
| GET         | `/api/links/:slug`                           | Additive current metadata read used by Pi.                                                                                        |
| PATCH       | `/api/links/:slug`                           | JSON `title` and/or boolean `is_public`.                                                                                          |
| DELETE      | `/api/links/:slug`                           | Atomic removal of metadata, bytes, bookmarks and archives.                                                                        |
| POST        | `/api/links/:slug/file`                      | Multipart replacement with stable slug and archived previous assets.                                                              |
| POST/DELETE | `/api/links/:slug/bookmark`                  | Idempotent bookmark toggle.                                                                                                       |
| GET         | `/api/links/:slug/versions`                  | Descending archived versions and logical prefixes.                                                                                |
| POST        | `/api/links/:slug/versions/:version/restore` | Archive current content and restore bytes into a new version.                                                                     |
| GET/HEAD    | `/:slug/`, `/:slug/:path`                    | Trusted viewer and current assets. Anonymous only when public.                                                                    |

A lone root HTML file becomes `index.html`, including when it has companion assets. Companion paths remain relative. Uploads otherwise require an `index.html`. Unsafe, duplicate, dot, traversal, encoded-separator, conflicting file/directory and overly deep paths are rejected before mutation. Titles are extracted from HTML unless supplied. Renaming sets a custom title preserved across replacements and restores. Clearing a custom title permits future upload titles again. `comment_count` is zero because review storage is not implemented.

Optional `If-Match: "2"` guards content versions. Upload accepts `"0"`. Optional `Idempotency-Key` on upload/replacement replays identical accepted operations, including across restarts. Different content under the same key is 409, stale versions are 412. ETags are quoted integers. Pi always sends these guards. Legacy omissions use serialized last-accepted writes. Visibility and title changes do not advance content versions. A retry can return its original version after a newer replacement, so consumers should verify current metadata. Tombstones are retained after deletion and never recreate deleted artifacts.

## Private browser viewing

```sh
pi-artifact-host login --url https://artifacts.example \
  --return-path /YOURSLUG/ --token-env ARTIFACT_OWNER_TOKEN
```

The command reads the bearer from the named environment variable and prints a short-lived viewing URL, not the bearer. Pi's local Share menu also provides an explicit viewing sign-in control. Do not save or log sign-in URLs.

`POST /api/owner/viewing-tickets` mints a hashed-at-rest, 60-second ticket. Opening it shows a confirmation form. Confirming performs a same-origin POST, atomically consumes the ticket, sets a random HttpOnly, SameSite=Strict cookie, and redirects to its fixed local target. This extra confirmation prevents cross-site sign-in mutation. HTTPS cookies are Secure. Only explicit literal-loopback HTTP development omits Secure.

Sessions expire after 30 minutes. Private wrappers mint five-minute capabilities scoped to the exact slug and current version, never exceeding session expiry. Relative CSS, module JS and images load beneath `/_view/:capability/:slug/`. Capabilities expire on replacement, session expiry/logout or token rotation. The wrapper labels private viewing read-only and offers reload and sign-out. Same-origin `POST /owner/logout` revokes the current session and its capabilities.

Without authorization, ordinary private navigation reveals no title or content. Executable content has an opaque-origin iframe sandbox with scripts only, plus a response-level CSP sandbox on every direct file response, including SVG. The iframe is credentialless. Public and capability assets allow uncredentialed CORS for module loading, never credentialed wildcard access. No archive or database route exists. Malicious content can disclose its own read capability, but cannot use it to read another slug/version or invoke management. Use a dedicated host origin, TLS, and no sensitive unrelated applications on that origin.

## Limits and persistence

Limits reject without silent eviction: 25 MiB total file bytes/upload, 26 MiB multipart envelope, 256 files, 1024 UTF-8 bytes/path, 16 segments, 1000 title characters, 1000 artifacts, 100 versions/artifact including current, 1 GiB aggregate current/history bytes, 10000 retained idempotency records, four concurrent multipart bodies, 600 authenticated API requests/minute, 3000 live viewing records. Request/header timeouts and 100 connections bound concurrent requests. JSON bodies are capped at 16 KiB. Storage exhaustion returns 507. Expired viewing records are cleaned opportunistically.

SQLite WAL with synchronous FULL stores complete asset sets and archive metadata in one transaction. Failed upload/replace/restore leaves prior content intact. Stop the process before copying the entire data directory, or use SQLite's online backup API. Never copy only the database while discarding its live WAL. Keep the directory on persistent local storage, owned by the non-root runtime user and inaccessible to other users. The Dockerfile uses Node 24 and a `/data` volume. Build after `pnpm build` with `docker build packages/artifact-host`, then provide trusted canonical configuration, the token digest and persistent storage separately. No deployment is performed by this package.

The unreleased custom JSON API is removed. An incompatible development database is rejected with an actionable message. Existing data is never deleted or silently migrated. Back it up and select a fresh data directory if intentionally starting a new host.

## Verification

```sh
pnpm exec vitest run packages/artifact-host packages/artifacts
pnpm typecheck
pnpm lint
pnpm build
node packages/artifact-host/pack-smoke.mjs
node packages/artifacts/hosted-smoke.mjs
```

The pack smoke installs into a temporary directory outside the workspace and exercises the real CLI, multipart upload, private default, visibility PATCH and public reading without Pi installed. The hosted smoke exposes the actual local Share UI and temporary host for a separate browser operator. HTTP tests cover compatibility, rollback, restart, guard recovery, auth isolation and sandbox headers. They do not claim real-browser isolation verification or independent review.
