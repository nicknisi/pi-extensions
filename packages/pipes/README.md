# @nicknisi/pi-pipes

Call third-party APIs as yourself from pi through [WorkOS Pipes](https://workos.com/docs/pipes) [Relay](https://workos.com/docs/pipes/relay). Pipes stores your OAuth connections (Google Sheets, Google Drive, GitHub, Slack, Linear, ~380 providers); Relay forwards each request with your token attached on WorkOS's side. Pi only ever holds a WorkOS API key, which this extension reads from your keychain and keeps out of the model's context.

## What it adds

- **`pipes` tool**: `provider` + `path` (+ optional `method`, `body`). Sends the request to `https://api.workos.com/relay/<provider><path>`, which reaches the provider's default API host as you.
  - **GET/HEAD run directly.** Any other method opens a confirmation dialog showing the request; without a UI (print/JSON mode) writes are refused.
  - **Sign-in in place.** When the provider isn't connected, Relay answers 402 with a sign-in link. The tool opens it, waits for the connection (status bar shows `waiting for <provider> sign-in…`), and retries the call.
  - **Large responses go to a file.** Bodies over `maxInlineChars` are saved under `$TMPDIR/pi-pipes/` and the tool returns a preview plus the path.
- **`/pipes` command**
  - `/pipes status`: config path, user, where the API key is read from.
  - `/pipes status <provider>`: connection state and granted scopes.
  - `/pipes connect <provider>`: open the sign-in and wait for it.
- **`pipes` skill**: provider recipes the model reaches when it needs them: Google Sheets links (finding the tab for a `gid`, reading values), Drive, and what each failure means.

## Setup

1. **A WorkOS environment with the provider configured.** In the WorkOS dashboard: Pipes → Connect provider → pick the provider → Connection access **User** → **Custom credentials**. WorkOS-provided ("shared") credentials are not available for Google providers, so you supply your own OAuth client.
2. **For Google: a Web application OAuth client.** In Google Cloud Console → Google Auth Platform → Clients, create a client of type **Web application** and add the provider's redirect URI (shown in the Pipes dialog, also `redirect_uri` from `GET /data-integrations/<slug>`) under Authorized redirect URIs. A Desktop client fails with `Error 400: redirect_uri_mismatch`. Use an **Internal** consent screen when the project lives in your company's Google org; External apps in testing mode lose access after 7 days.
3. **Config** at `~/.pi/agent/configs/pipes.json`:

   ```json
   {
     "userId": "user_01...",
     "openCommand": "open -na 'Google Chrome' --args --profile-directory='Profile 2'"
   }
   ```

4. **API key** in the macOS keychain (prompts for the value):

   ```bash
   security add-generic-password -U -s workos-pipes -a "$USER" -w
   ```

5. **Install**: `pi install npm:@nicknisi/pi-pipes`, or add the package path to `packages` in `~/.pi/agent/settings.json`.

Then `/pipes connect google-sheets` (or just ask pi to read a sheet; the tool signs you in on first use).

## Usage

```text
> what's in https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid> ?
pipes google-sheets /v4/spreadsheets/<id>?fields=sheets.properties(sheetId,title)
pipes google-sheets /v4/spreadsheets/<id>/values/Sheet%201
```

```text
pipes github /user/repos?per_page=5
pipes linear /graphql  method=POST  body={"query":"{ viewer { name } }"}   ← asks you first
```

## Config

`~/.pi/agent/configs/pipes.json` (or `$PI_CODING_AGENT_DIR/configs/pipes.json`):

| Field              | Default                                             | Meaning                                                                                     |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `userId`           | (required)                                          | WorkOS user whose connections Relay uses (`X-Relay-User`).                                  |
| `organizationId`   | none                                                | Scope connections to an organization (`X-Relay-Organization`).                              |
| `apiKeyCommand`    | `security find-generic-password -s workos-pipes -w` | Shell command that prints the WorkOS API key, e.g. `op read op://Private/workos-pipes/key`. |
| `openCommand`      | `open` (macOS) / `xdg-open`                         | Shell command for sign-in links; the URL is passed as its last argument.                    |
| `baseUrl`          | `https://api.workos.com`                            | WorkOS API origin.                                                                          |
| `maxInlineChars`   | `20000`                                             | Responses longer than this are saved to a file.                                             |
| `connectTimeoutMs` | `300000`                                            | How long a sign-in waits for approval.                                                      |

Environment overrides: `WORKOS_PIPES_API_KEY` (the key itself, skips `apiKeyCommand`), `WORKOS_PIPES_USER`, `WORKOS_PIPES_ORGANIZATION`, `WORKOS_PIPES_BASE_URL`.

## Non-pi use

`@nicknisi/pi-pipes/core` exports the Relay client with no pi dependency: `loadConfig`, `resolveApiKey`, `PipesClient` (`relay`, `connection`, `authorizeUrl`, `waitForConnection`).

## Caveats

- **Path routing, not `X-Relay-URL`.** Relay's docs recommend sending the full upstream URL in `X-Relay-URL`, but that rejects `sheets.googleapis.com` (`relay_provider_not_found`) while `/relay/google-sheets/v4/...` works. The tool always uses path routing, so paths are relative to the provider's default host.
- **One provider, one host.** Google Drive endpoints belong to `google-drive`; a `google-sheets` connection can't reach them even with Drive scopes.
- **Paths stay under `/relay/<provider>/`.** The API key authorizes the whole WorkOS API on the same origin, so paths with dot segments (`..`, `%2e%2e`), encoded slashes or backslashes are rejected before any request is sent. Sign-in links are opened only when they point at `baseUrl`'s origin, and `baseUrl` must be https.
- **Relay limits:** request bodies up to 5 MB, 30-second upstream timeout, redirects not followed.
- **The API key is environment-wide.** Any WorkOS API key can do everything in its environment, not just Relay. Use a sandbox environment dedicated to your own connections.
- macOS keychain is the default key store; on Linux set `apiKeyCommand` or `WORKOS_PIPES_API_KEY`.
