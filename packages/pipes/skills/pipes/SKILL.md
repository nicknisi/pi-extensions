---
name: pipes
description: Recipes for the `pipes` tool. Use for a Google Sheets, Docs or Drive link, any call to the user's third-party accounts through WorkOS Pipes, and pipes errors (relay_provider_not_found, "not set up for users", HTTP 401).
---

# Pipes recipes

The `pipes` tool sends `<method> <path>` to a provider's default API host as the user, through WorkOS Relay. Choose the provider slug, then use the path from that provider's own REST API docs.

## Google Sheets link

A link looks like `docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>`.

1. **List the tabs.** Provider `google-sheets`, path `/v4/spreadsheets/<ID>?fields=properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`. The tab whose `sheetId` equals `<GID>` is the one the link shows; a link without a gid means the first tab.
2. **Read it.** Path `/v4/spreadsheets/<ID>/values/<TAB>` for the whole tab, or `/values/<TAB>!A1:F50` for a range. URL-encode the tab name: space `%20`, `'` `%27`, `!` `%21`.
3. **Work from the saved file.** A large tab comes back as a preview plus a file path; query that file with `jq` or read it instead of requesting the tab again.

The values API drops trailing empty rows, so fewer rows than `rowCount` is complete data.

## Google Drive and Docs

Drive endpoints (`/drive/v3/...`) belong to the `google-drive` provider; a `google-sheets` connection can't reach them, whatever scopes it holds.

- Find files: `/drive/v3/files?q=name%20contains%20'<words>'&fields=files(id,name,mimeType)`
- A Google Doc as text: `/drive/v3/files/<ID>/export?mimeType=text/plain`

## Other providers

Slugs are listed at https://workos.com/docs/pipes/providers. The path is the provider's normal REST path: `github` + `/user/repos`, `linear` + POST `/graphql`.

## Failures

- **Sign-in needed (402):** the tool opens the sign-in and retries on its own. Wait for the result.
- **`relay_provider_not_found` or "not set up for users":** the provider isn't configured for users in this WorkOS environment. Ask the user to add it in the WorkOS dashboard under Pipes with Connection access **User** and **Custom credentials**. A Google OAuth client must be a **Web application** whose Authorized redirect URIs include the redirect URI shown in that dialog.
- **HTTP 401 from WorkOS:** the API key is wrong or was rotated. `/pipes status` shows where the key is read from.
- **Writes:** the user approves each one in a dialog. Say what the write will change before calling it.
