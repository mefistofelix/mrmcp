# MRMCP 0.10.22

Single-file Deno MCP desktop server with a local WebView administration GUI.

## Runtime

Run beside `morphlex.js`:

```sh
deno run -A --unstable-ffi --unstable-worker-options mrmcp.js
```

Target runtime: Deno 2.9.x. During `deno run`, runtime data is stored in `.mrmcp` beside the script. In a `deno compile` standalone executable, runtime data and `commands.yaml` are stored beside the executable, while the embedded `morphlex.js` resource is read from the compiled module filesystem.

The ZIP contains only:

```text
mrmcp.js
morphlex.js
commands.yaml
AGENTS.md
```

The root-level `commands.yaml` beside `mrmcp.js` is the live extra-command catalog. The backend and GUI read and write that same file directly; it is not copied into `.mrmcp`. Executables remain in `.mrmcp/bin`.

Eta is imported server-side from `jsr:@bgub/eta`. Morphlex 1.4.0 is the exact local file supplied by the operator and is never loaded from a CDN at runtime.

## Fixed listeners

The listener topology is not configurable from the GUI:

- `0.0.0.0:80` — plain HTTP, exclusively for `/.well-known/acme-challenge/<token>`.
- `0.0.0.0:443` — HTTPS for MCP, OAuth, metadata and Basic-authenticated MCP URLs.
- `127.0.0.1:<guiPort>` — local GUI and WebView assets only.

The GUI port is fixed at `7332`. It has no URL argument or environment-variable override and is never publicly bound.

Port 80 must return `404` for every request other than an active ACME HTTP-01 token. It must never expose MCP, OAuth, GUI or metadata routes.

## HTTP response compression

The public HTTPS wrapper negotiates `br` and `gzip` from `Accept-Encoding`, respects quality values and prefers Brotli when qualities are equal. Compression applies only to compressible JSON/text/JavaScript/YAML/XML/SVG responses whose declared body size is at least 1024 bytes.

Rules:

- add `Vary: Accept-Encoding` to compressible responses;
- do not compress responses below 1024 bytes;
- do not compress binary/already-compressed media such as raster images, PDF, archives, executables or databases;
- do not transform responses with `Content-Encoding`, `Content-Range`, or `Cache-Control: no-transform`;
- remove `Content-Length` when a streaming compressor is applied;
- use streaming Node-compatible Brotli/gzip transforms rather than buffering large MCP results;
- HTTP/TLS compression are distinct; TLS-level compression must not be enabled.

## TLS lifecycle

Production paths:

```text
.mrmcp/fullchain.pem
.mrmcp/privkey.pem
```

Fallback paths:

```text
.mrmcp/selfsigned.pem
.mrmcp/selfsigned-key.pem
```

Rules:

1. Inspect the production certificate on disk before contacting ACME.
2. Reuse it when its chain, validity period and current IPv4/sslip identities are valid.
3. Do not create an ACME order until the certificate reaches its renewal point.
4. Renewal is scheduled at two thirds of the certificate lifetime.
5. Persist the next permitted attempt in SQLite config so a restart cannot cause request spam.
6. Parse both the ACME `Retry-After` header and `retry after ... UTC` error details.
7. A rate-limited request is deferred until the reported reset time plus one minute.
8. Other ACME failures use a six-hour backoff.
9. A manual GUI request obeys the same renewal and backoff gates.
10. If no trusted production certificate is usable, create or reuse the separate self-signed certificate and keep HTTPS listening on port 443.
11. Never overwrite the production certificate with the self-signed fallback.
12. ChatGPT and other public clients will reject the self-signed fallback; it exists only to keep the HTTPS listener and local diagnostics alive.

Relevant persistent status keys include:

```text
tls_last_request_at
tls_last_request_status
tls_last_request_valid
tls_last_issued_at
tls_next_attempt_at
tls_rate_limit_reset_at
tls_renewal_due_at
tls_last_error
```

The dashboard must prominently show:

- active certificate kind;
- active certificate validity and trust;
- expiration;
- last ACME request;
- last ACME result and whether it produced a valid certificate;
- last successful certificate;
- renewal due time;
- rate-limit reset time;
- next ACME attempt;
- listener and ACME errors.

## External service configuration

The GUI may configure:

- public IPv4 lookup URLs;
- sslip-compatible DNS suffix;
- ACME directory URL;
- Let's Encrypt email;
- optional public HTTPS base URL.

Defaults:

```text
https://api.ipify.org?format=json
sslip.io
https://acme-v02.api.letsencrypt.org/directory
```

IPv6 is unsupported. The public base override must use HTTPS on port 443.

## OAuth

Projects may enable OAuth independently.

OAuth requirements:

- Authorization Code and Refresh Token grants.
- PKCE `S256` for the initial authorization-code exchange.
- Access tokens last one year (`31536000` seconds) to minimize client reauthentication and refresh traffic.
- Refresh tokens are persisted in SQLite without an absolute expiry and are reusable rather than rotated, prioritizing reliable long-lived ChatGPT sessions and retry tolerance.
- Exact project resource binding.
- Exact redirect URI matching.
- Dynamic client registration.
- Current ChatGPT callback recovery only for
  `https://chatgpt.com/connector/oauth/<id>`.
- `GET /oauth/authorize` accepts browser navigation from ChatGPT.
- Consent `POST /oauth/authorize` uses a five-minute, one-time server nonce bound to the exact OAuth request.
- MCP endpoints retain strict Origin validation when an Origin is supplied.

## Projects and workspaces

A project has:

- slug and display name;
- enabled state;
- OAuth and Basic authentication options;
- execution policy;
- enabled MCP tools;
- one or more named filesystem roots.

A workspace session selects exactly one named root. All file and `cwd` values are ordinary paths relative to that root. Paths may not escape it.

## File and process tools

File tools support individual and batched read, write, edit, replacement, copy, move, delete, search and metadata operations.

Process tools:

```text
exec
exec_start
exec_poll
exec_write
exec_kill
exec_list
```

`exec` and `exec_start` accept `cwd` relative to the selected workspace root. Prefer `program` plus `args`; use `shell_command` only for shell syntax such as pipelines or redirection.

### Returning generated files to the conversation

MRMCP does not expose a command-specific screenshot tool. Agents use the ordinary command catalog and `exec`. `exec.return_files` remains the direct standard-MCP attachment path:

```json
{
  "program": "screenshot-cmd",
  "args": ["-o", "screenshot.png"],
  "return_files": ["screenshot.png"]
}
```

Paths in `return_files` are resolved relative to the command `cwd`; absolute paths are accepted only inside the selected workspace root. After successful command completion, each file receives a short-lived HTTPS `resource_link`. Raster images within the combined 8 MiB inline budget are also returned as native MCP `image` content so the assistant can inspect them directly. The workspace files themselves are not deleted.

When the user should receive a visible sandboxed preview in an MCP Apps-capable host, create the file first and then call `publish_file` separately. `publish_file` is the render tool and is linked to the versioned UI resource `ui://mrmcp/image-preview-v3.html`; `exec` is deliberately not linked to a UI because most executions do not produce a visual artifact.

Use `publish_file` when the file already exists or was created by a different tool. Its `return_mode` is explicit:

- `link` is the default and preferred mode for the MCP App preview. It returns a temporary HTTPS `resource_link`, which the app assigns directly to an ordinary HTML `<img src>`;
- `inline` remains standard native MCP `ImageContent` for clients that explicitly need Base64 image content, but creates no URL and therefore cannot drive the minimal MCP App preview;
- `both` explicitly returns both forms for an eligible raster image, while the MCP App still ignores the Base64 block and uses only the resource-link URL.

No image is resized, recompressed, transcoded or otherwise optimized. The MCP App contains no Base64 conversion, `data:` URL or binary fallback. If the HTTPS resource cannot be loaded, it reports an expired/unavailable link and the file must be published again.

MRMCP implements a deliberately minimal Resources surface only for the MCP Apps image-preview template:

- `resources/list` exposes the single predeclared `ui://mrmcp/image-preview-v3.html` UI resource;
- `resources/read` returns its self-contained HTML as `text/html;profile=mcp-app`;
- no resource templates, subscriptions, filesystem resource registry or general file-reading resource API is implemented.

The `publish_file` tool descriptor links to that resource through the standard `_meta.ui.resourceUri` field and also includes ChatGPT's compatibility alias `_meta["openai/outputTemplate"]`. The iframe uses the standard `ui/initialize` request with `appInfo` and `appCapabilities`, followed by `ui/notifications/initialized`, and consumes `ui/notifications/tool-result`. Its HTML is intentionally image-only and minimal: the resource-link URL is assigned directly to `<img src>`, the image consumes the full available width, controls are compact overlays, and supported hosts can switch to fullscreen through `ui/request-display-mode`. The UI resource CSP authorizes only the configured MRMCP public origin for external image assets.

The `/download/<token>/<filename>` endpoint uses random 256-bit in-memory bearer tokens, defaults to a 24-hour lifetime, accepts values from 30 seconds through seven days, supports optional one-time links, never discloses local paths and streams the original file with no-cache security headers. The longer default allows normal ChatGPT chat navigation and MCP App reconstruction without the old five-minute expiry, but tokens still disappear when MRMCP restarts. MIME inference uses the pinned Deno standard-library package `jsr:@std/media-types@1.1.0` from the filename extension, with only narrow project-specific overrides. Browser-previewable images (including SVG), text, JSON/XML, PDF, audio and video use `Content-Disposition: inline`; archives, executables, databases and unknown binary formats remain attachments. SVG and other active XML/HTML documents are served with a restrictive sandbox CSP, while previewable resources receive cross-origin headers. Existing workspace files are never deleted when tokens expire.

`publish_file` is enabled once for all existing projects during the 0.10.10 startup normalization. ChatGPT still keeps its own approved action snapshot, so the MCP app/connector must be refreshed or rescanned after restarting the updated server.

## Extra command catalog

`.mrmcp/bin` is prepended to `PATH`.

Explicit command metadata is stored outside SQLite in:

```text
commands.yaml
```

The root-level `commands.yaml` beside `mrmcp.js` is the authoritative live catalog populated with the default Win64 entries. The GUI edits this file directly. `.mrmcp` contains runtime state and `.mrmcp/bin` contains executable files, but no second command-catalog copy is used.

The live catalog file is intentionally read and parsed every time the catalog is listed, a logical command is resolved, metadata is saved or deleted, or a configured binary is downloaded. Do not introduce an in-memory catalog cache unless explicitly requested later.

Agent-facing MCP instructions and tool descriptions direct clients to call `list_commands` by purpose before falling back to PowerShell, `cmd` or an improvised shell workaround. Every command returned by `list_commands` is already present and executable; `exec.program` must receive its `logical_name` directly without a preceding `where.exe`, `which`, `Get-Command` or filesystem probe. MRMCP resolves catalog names before normal platform `PATH`, including aliases whose physical filename differs, such as `handle` resolving to `handle64.exe`. The bundled `screenshot-cmd` description explicitly marks it as the preferred Windows screenshot path and explains `exec.return_files` / `publish_file` delivery.
 The bundled `mermaid` logical command resolves to the native Rust `arielc.exe` binary and is the preferred catalog tool for text-to-SVG Mermaid diagrams and supported chart-like Mermaid formats.

YAML schema (deliberately without a format-version field):

```yaml
commands:
  - logical_name: git
    description: Distributed version-control CLI.
    download_url: https://example.com/git.exe
    documentation_url: https://git-scm.com/docs
    enabled: true
```

Fields:

- `logical_name` — command name exposed to agents and accepted by structured execution; on Windows the executable suffix is optional;
- `path` — optional relative destination below `.mrmcp/bin`, including nested directories; when omitted or blank it defaults to `logical_name`; on Windows `.exe`, `.com`, `.cmd` and `.bat` may be omitted;
- `description` — optional agent-facing explanation;
- `download_url` — optional HTTP/HTTPS source used by the GUI download button;
- `documentation_url` — optional HTTP/HTTPS documentation link shown by the GUI;
- `enabled` — whether the explicit entry may be exposed and resolved; omission defaults to enabled.

The GUI reads and writes this same file through the command APIs; there is no separate GUI-side store or SQLite copy. Its path field is optional and follows the same `logical_name` default. When the configured path equals the logical name, the writer omits `path` from YAML. On Windows, extensionless configured paths resolve existing files by trying `.exe`, `.com`, `.cmd` and `.bat` in that order.

The command model remains hybrid and shallow:

- executable files directly inside `.mrmcp/bin` are discovered automatically;
- discovery never enters subdirectories;
- automatic entries have empty descriptions;
- explicit YAML entries may point to nested paths;
- a YAML entry overrides automatic entries with the same logical name or resolved executable path;
- missing, disabled or non-executable YAML entries appear only in the GUI;
- MCP `list_commands` returns only commands that can currently run;
- structured `exec` resolves YAML logical names before normal platform `PATH`.

Downloading:

- the GUI exposes `Download` only when `download_url` is configured and also provides `Download all` for all enabled configured downloads;
- overwrite confirmation is requested only when the resolved destination file already exists;
- successful downloads are silent, while individual and aggregate failures are reported;
- direct-file responses are downloaded to a temporary file and then moved below `.mrmcp/bin`; on Windows an extensionless path reuses an existing suffixed target, otherwise the suffix is inferred from `Content-Disposition` or the final URL and defaults to `.exe`;
- ZIP responses are read as archives, the executable whose basename matches `path` or `logical_name` is selected, extracted, and stored at the configured destination; a sole executable entry is accepted as a fallback, while ambiguous archives fail instead of installing an arbitrary file;
- ZIP extraction supports stored and deflate entries, rejects encrypted, multi-disk and ZIP64 archives, and limits the downloaded archive to 512 MiB;
- parent directories are created automatically;
- an existing target is replaced only after explicit GUI confirmation; completed temporary files are committed transactionally, normal failures clean temporary artifacts, and Windows replacement preserves/restores the previous file if the final move fails;
- on Linux and other non-Windows systems the downloaded file is set to mode `0755`, so it is executable;
- command paths may never escape `.mrmcp/bin`;
- download and documentation URLs must use HTTP or HTTPS.

The `command_catalog` SQLite table is no longer part of the schema. There is no automatic import or migration of command metadata previously stored in SQLite; this release assumes a clean compatible database and configuration.

## JavaScript REPL tools

MRMCP exposes:

```text
js
js_add_node_module_dir
js_reset
```

These tools do not spawn Node. Each authenticated client, project and workspace receives a persistent Deno Worker.

The kernel supports:

- persistent globals;
- captured console output;
- `nodeRepl.write`;
- Node-compatible `require` where Deno supports it;
- asynchronous `importModule`;
- additional project or `node_modules` directories;
- timeout termination;
- explicit reset;
- one-hour idle expiry.

Treat `js` with the same trust level as process execution.

## GUI architecture

- Eta renders the initial page and every dynamic fragment on the server.
- Templates use `<? ... ?>` and `<?= ... ?>`.
- The browser does not render templates.
- Browser updates request HTML fragments from `/api/render`.
- Local Morphlex applies fragment changes while preserving edited form state; the GUI never performs a full-page reload for automatic updates.
- Automatic refresh preserves the document viewport and nested scroll positions. While an MCP tool-call or HTTP detail row is open, or text in that list is selected/focused, the corresponding list refresh is paused until the row is closed or the user requests a manual refresh.
- The GUI CSP permits only local scripts and connections.
- HTTP debug logging is disabled by default and controlled only from the HTTP debug page.
- The GUI calls the execution history **MCP tool calls**, matching the protocol method `tools/call`.
- Every parsed `tools/call` attempt reaching a project endpoint is logged, including `publish_file`, unknown or disabled tools, malformed requests and authentication failures.
- Both MCP tool calls and HTTP debug requests use an explicit `id INTEGER PRIMARY KEY AUTOINCREMENT`; that same numeric ID is shown in the GUI and returned as the execution log ID.
- Databases created by 0.10.11 are upgraded once by rebuilding `logs` and preserving each existing numeric `rowid` as the new primary-key `id`; no UUID log identifier remains.
- The HTTP debug list displays its numeric primary key.
- Clicking either kind of row opens or closes escaped JSON immediately below that row and provides clipboard copy actions; details must not render in a detached pane at the bottom of the page.
- MCP tool-call details show Input JSON, the actual sanitized MCP result JSON returned to the client, standard error/error and call metadata. Inline image/blob payloads are represented by their encoded length rather than persisted, and temporary download tokens are redacted.

## Persistence and migrations

SQLite database:

```text
.mrmcp/mrmcp.sqlite
```

Basic-auth passwords are stored as plaintext in the existing `basic_secret_enc` column for schema compatibility. OAuth authorization codes, access tokens and refresh tokens remain one-way hashed because they do not use a master key. The additive `oauth_refresh_tokens` table is created automatically on startup; refresh tokens have no absolute expiry, while access tokens expire after one year.

Automatic general database migrations are intentionally disabled. Compatibility exceptions are limited to the 0.10.11 `logs` conversion from UUID primary keys plus implicit `rowid` to an explicit numeric primary key and the additive 0.10.22 `oauth_refresh_tokens` table. Every other schema incompatibility must stop startup with a clear message. Configuration-key additions do not require a schema migration.

MRMCP does not create, read, migrate, or delete `.mrmcp/master.key`. Legacy encrypted Basic passwords and databases requiring conversion are unsupported; use a fresh compatible database.

## Required release checks

Before publishing:

1. Run syntax checks on the complete source.
2. Extract and syntax-check the browser module.
3. Extract and syntax-check the Deno Worker module.
4. Execute the fresh SQLite schema and run `PRAGMA integrity_check`; also test the one-time 0.10.11 tool-call log primary-key conversion.
5. Confirm exactly four ZIP members, including the live root-level `commands.yaml`.
6. Confirm no public HTTP MCP route exists.
7. Confirm fixed binds for ports 80 and 443 and local-only GUI binding.
8. Confirm no port controls remain in Settings.
9. Confirm the self-signed paths are separate from production paths.
10. Confirm ACME backoff and retry timestamps are persistent.
11. Test Brotli/gzip negotiation, quality-value selection, the 1024-byte threshold, `Vary: Accept-Encoding`, and binary/no-transform exclusions.
12. Compile a standalone executable with `--include morphlex.js` and confirm `.mrmcp` plus `commands.yaml` resolve beside the executable.


## 0.10.1 OAuth consent submission

Some ChatGPT authorization contexts submit the consent form with an opaque or ChatGPT Origin even though the page itself is served by MRMCP. Therefore OAuth consent must not depend on the browser `Origin` header.

- `GET /oauth/authorize` creates a cryptographically random consent nonce.
- The nonce is held only in memory for five minutes.
- It is bound to client ID, redirect URI, resource, scope and PKCE challenge.
- The form returns it as a hidden `consent_token`.
- `POST /oauth/authorize` consumes the nonce exactly once.
- Missing, expired, reused or mismatched consent tokens are rejected.
- The MCP `/mcp/<project>` endpoint keeps its separate strict Origin validation.


## 0.10.2 runtime and policy changes

- Deno must be started with `--unstable-worker-options` because backend and JavaScript-kernel Workers inherit permissions.
- The GUI is always `http://127.0.0.1:7332/`; `guiPort` and `MRMCP_GUI_PORT` are unsupported.
- New projects, including a freshly created Default project, use `confirm_mode=allow`.
- Existing project policy choices are preserved.
- Basic-auth passwords are stored in plaintext in SQLite.
- No master-key migration or legacy Basic-password conversion is performed; incompatible old data must be discarded.
- Active-process views contain only `starting` and `running` processes.
- Completed processes remain available temporarily to MCP polling/history internals but disappear immediately from the GUI Active calls page.
- Tool calls left active by an unclean shutdown are marked `orphaned` at startup.

## Changelog

### 0.10.23

- Added negotiated HTTP response compression for public MCP and metadata traffic using Brotli or gzip according to `Accept-Encoding` quality values, while excluding OAuth and cookie-setting responses.
- Added a 1024-byte compression threshold, `Vary: Accept-Encoding`, and exclusions for binary, already encoded, partial and `no-transform` responses.
- Kept compression streaming through Node-compatible zlib transforms so large text and JSON results are not buffered solely for compression.
- Added standalone `deno compile` support: runtime data and `commands.yaml` resolve beside the executable while `morphlex.js` can be embedded with `--include morphlex.js`.
- Expanded `README.md` into a user guide covering Deno execution/compilation, project permissions, ChatGPT Web developer-mode setup, write-action enablement, sslip.io/Let's Encrypt architecture, compression behavior and every built-in tool argument.

### 0.10.22

- Added OAuth Refresh Token grant support to discovery, dynamic client registration and `/oauth/token`.
- Added persistent one-way-hashed refresh tokens bound to client, project, resource and scope.
- Made refresh tokens reusable and without an absolute expiry so ChatGPT can recover sessions across MRMCP restarts without repeated approval prompts.
- Increased access-token lifetime from one hour to one year (`31536000` seconds), strongly reducing refresh traffic even when a client does not persist refresh tokens correctly; existing stored access tokens are extended to at least one year from the first upgraded startup.
- Kept refresh-token renewal tolerant of clients that omit `client_id` during renewal by using the client identity already bound to the token.
- Added refresh-token cleanup when OAuth is disabled, a project is deleted or a client is revoked; active refresh tokens also prevent automatic client-registration cleanup.
- Added access and refresh token counts to the OAuth clients GUI.
- Added the additive `oauth_refresh_tokens` SQLite table and advanced the schema user version to 12.

### 0.10.21

- Replaced the preview with a minimal URL-only MCP App: it assigns the HTTPS `resource_link` directly to `<img src>` and contains no Base64 parsing, `data:` URL or fallback image reconstruction.
- Maximized visible image area with zero outer padding, full available width, no metadata footer and only two compact overlay controls for fullscreen and opening the original.
- Added standard MCP Apps fullscreen support through `ui/request-display-mode`; supported hosts can use the overlay button or double-click the image to enter or leave fullscreen.
- Changed the versioned resource URI to `ui://mrmcp/image-preview-v3.html` to invalidate stale host caches and kept `prefersBorder: false` to avoid redundant outer chrome.
- Changed `publish_file` default delivery from `both` to `link`; `inline` and `both` remain available standard MCP modes but the MCP App intentionally consumes only the resource-link URL.
- Increased temporary-link default lifetime from five minutes to 24 hours and the configurable maximum to seven days so previews survive normal chat navigation; tokens remain in memory only and still disappear on MRMCP restart.
- Added self-tests ensuring the MCP App template contains resource-link handling and no Base64/data-URL implementation.
- Kept original file bytes unchanged: no resize, recompression, transcoding or other image optimization was introduced.

### 0.10.20

- Added the stable MCP Apps `io.modelcontextprotocol/ui` extension for a sandboxed file-preview view attached only to `publish_file`.
- Added the predeclared `ui://mrmcp/file-preview-v1.html` resource with MIME type `text/html;profile=mcp-app`, standard `_meta.ui.resourceUri` tool linkage and the ChatGPT `openai/outputTemplate` compatibility alias.
- Implemented minimal authenticated `resources/list` and `resources/read` handlers solely for the UI template; no general file resource registry, templates or subscriptions were added.
- Added a self-contained HTML5 image/file viewer that consumes `ui/notifications/tool-result`, supports the ChatGPT `window.openai.toolOutput` compatibility path, previews HTTPS `resource_link` images and falls back to native MCP `ImageContent` data when available.
- Declared the current MRMCP public origin in the MCP App resource CSP so linked PNG, JPEG, WebP, GIF and SVG files can load inside the host sandbox.
- Kept all pre-existing standard `inline`, `link` and `both` delivery modes unchanged and added no resize, recompression, transcoding or nonstandard smart-snippet format.
- Updated agent instructions to create screenshots or diagrams through catalog commands and call `publish_file` separately when the MCP App preview is desired.

### 0.10.19

- Replaced the hand-maintained MIME extension table with the pinned Deno standard-library `@std/media-types` database, retaining only narrow overrides for MRMCP-specific source/database extensions.
- Served SVG, other images, text, JSON/XML, PDF, audio and video links with `Content-Disposition: inline`; kept archives, executables, databases and unknown binary files as attachments.
- Added restrictive sandbox CSP headers for SVG and other active XML/HTML documents while preserving cross-origin preview headers.
- Kept standard MCP image output unchanged: `ImageContent.data` is raw Base64 with no `data:image/...;base64,` prefix; Codex may translate tool image bytes into an internal Responses API data URL, but that is a host-side representation rather than another MCP wire format.
- Generated image Markdown fallbacks for linked SVG files as well as raster images.

### 0.10.18

- Expanded the `uv` catalog description with exact `exec` tool-call forms for running Python files and Python source supplied through `stdin` using `args: ["run", "-"]`.
- Documented PEP 723 inline dependency metadata and uv's automatic isolated dependency resolution.
- Added an agent-facing Matplotlib example that writes `chart.png` and returns it through `exec.return_files`.
- Clarified the `exec.args`, `exec.stdin`, foreground-exec description and server instructions so agents prefer `uv` over shell here-documents, PowerShell or temporary Python source files.

### 0.10.17

- Made the root-level `commands.yaml` beside `mrmcp.js` the authoritative live catalog again; the backend and GUI no longer seed or use `.mrmcp/commands.yaml`.
- Added the `d2` logical command without a download URL, resolving an operator-provided `.mrmcp/bin/d2.exe` or suffix-free equivalent.

### 0.10.16

- Added the `mermaid` logical command backed by the native Rust `arielc` executable.
- Added a direct Win64 ZIP download and agent-facing guidance for rendering Mermaid diagrams and chart-like formats to SVG without Node.js, Puppeteer or a browser.
- Kept D2 and gnuplot out of the default catalog because their official Windows artifacts are currently distributed as tar/MSI or installer packages rather than a directly extractable standalone ZIP compatible with the existing downloader.

### 0.10.15

- Clarified throughout the server instructions and tool schemas that every command returned by `list_commands` is directly invokable through `exec.program` by logical name.
- Explicitly prohibited redundant availability probes with `where.exe`, `which`, `Get-Command` or filesystem searches for catalog commands.
- Documented that logical names are resolved before operating-system `PATH` and may intentionally map to a differently named executable, for example `handle` to `handle64.exe`.
- Added explicit invocation metadata to `list_commands` results (`exec_program`, `directly_invokable`, `path_lookup_required`) and normalized `logical_name` for automatic commands.

### 0.10.14

- Added `publish_file.return_mode` with `inline`, `link` and `both` delivery modes; default remains `both`.
- Made `publish_file` content contain only the selected MCP blocks, without an appended text block; inline-only also creates no download token or URL and omits structured content for a minimal image-only result.
- Kept linked publication available for every regular file; `both` falls back to link-only for non-raster or oversized files.
- Preserved exact source image bytes with no resize, recompression, transcoding or other optimization.
- Expanded `publish_file` descriptions so agents deliberately choose inline inspection, link materialization, or both and never manually encode binary files.
- Strengthened server, `list_commands`, `exec`, `program` and `shell_command` instructions to prefer MRMCP extra commands before PowerShell/cmd workarounds.
- Marked `screenshot-cmd` as the preferred Windows screenshot executable and documented the `exec.return_files` and `publish_file` flow in its catalog description.

### 0.10.13

- Added an **Output JSON** preview column to the MCP tool-call table beside the existing input preview.
- Expanded MCP tool-call rows into separate Input JSON, MCP result JSON, standard-error/error and call-metadata sections directly below the selected row.
- Persisted the actual MCP `CallToolResult` shape returned to the client in `result_json`, while replacing image/blob Base64 payloads with their encoded length and redacting temporary download tokens.
- Added dedicated Copy JSON controls for input and output while retaining a Copy full row action.
- Included `result_json` and `resolved_json` in tool-call text search and rebuilt the FTS payload once.
- Confirmed that automatic updates use Morphlex rather than a page reload, preserved the document and nested JSON scroll positions, and paused automatic log-list replacement while a detail row is being inspected.
- Simplified inline image blocks to the minimal standard `type`, `data` and `mimeType` fields and added returned Markdown/URL fallbacks for hosts that do not visibly render native MCP images.

### 0.10.12

- Replaced the MCP tool-call log UUID primary key plus implicit SQLite `rowid` with an explicit numeric `id INTEGER PRIMARY KEY AUTOINCREMENT`.
- Made the GUI, detail API, approvals and MCP `execution_log_id` use the same numeric primary key.
- Added a one-time compatibility upgrade that preserves existing 0.10.11 tool-call rows by copying their prior numeric `rowid` into the new `id`.
- Rebuilt the tool-call FTS index after that compatibility upgrade.

The retained versioned release series starts at 0.6.0.

### 0.10.11

- Renamed the GUI execution history to **MCP tool calls**, matching the MCP `tools/call` request name.
- Logged every parsed project-routed tool-call attempt, including `publish_file`, disabled or unknown tools, malformed requests and authentication failures.
- Displayed numeric database IDs in both the MCP tool-call table and HTTP debug table while retaining stable execution UUIDs internally.
- Replaced detached bottom JSON panes with expandable details directly below the selected row, including Close and Copy JSON controls that survive automatic refreshes.
- Served raster-image download URLs with inline disposition and cross-origin image headers while keeping non-image files as attachments.

### 0.10.10

- Removed the dedicated `screenshot` MCP tool; screenshots and every other generated artifact now use ordinary commands plus generic file return.
- Added `exec.return_files` with temporary `resource_link` output and native inline MCP images for raster files.
- Made returned paths resolve from the command working directory while enforcing the selected workspace root.
- Expanded the `exec` and `publish_file` descriptions so agents know to attach generated binary files instead of reading or Base64-encoding them.
- Enabled `publish_file` once for every existing project and removed stale base-tool selections such as the old dedicated screenshot action.
- Explicitly kept `resources/list`, `resources/read`, subscriptions and templates unimplemented; tool-call content blocks remain the transfer mechanism.

### 0.10.8

- Added a GUI `Download all` action for every enabled catalog command with a configured download URL.
- Asked for overwrite confirmation only when the resolved target file already exists.
- Removed download success alerts and report only individual or aggregate failures.
- Kept downloads transactional through temporary files, cleanup on every failure and Windows backup/restore replacement.
- Suppressed automatic filesystem entries whose resolved path is already owned by a catalog command, preventing aliases such as `handle` and `handle64` from appearing twice.

### 0.10.7

- Added a bundled default `commands.yaml` with the requested Win64 command catalog and agent-facing descriptions.
- Seeded `.mrmcp/commands.yaml` from the bundled template only when no runtime catalog exists.
- Added automatic extraction of the matching executable from Win64 ZIP downloads so the GUI Download button installs archive-distributed CLIs correctly.
- Kept existing runtime command configuration untouched on upgrades and restarts.

### 0.10.6

- Made the extra-command `path` optional in both YAML and the GUI.
- Defaulted an absent or blank path to `logical_name`.
- Omitted `path` from generated YAML when it equals that default.
- Allowed Windows logical names and configured paths to omit `.exe`, `.com`, `.cmd` and `.bat`.
- Resolved existing suffixed Windows binaries automatically and inferred the downloaded suffix when needed.

### 0.10.5

- Fixed the GUI header to the top of the WebView using CSS only.
- Added the corresponding document-flow offset so page content never slides underneath the header.
- No JavaScript scroll handling is used.

### 0.10.2

- Removed `.mrmcp/master.key` encryption without migration support; deployments must start from a fresh compatible database.
- Added required `--unstable-worker-options` startup flag.
- Fixed GUI port at 7332 with no launcher or environment override.
- Changed new-project confirmation policy to Allow.
- Simplified the Active calls page: the interaction panel is hidden until a process is selected and no form is shown when the list is empty.
- Removed the unnecessary top-level `version` field from `commands.yaml`.
- Removed completed processes from active GUI projections and orphaned stale calls on startup.
- Added this complete retained-release changelog.

### 0.10.1

- Replaced unreliable OAuth consent Origin validation with a five-minute, one-time nonce bound to client, callback, resource, scope and PKCE challenge.
- Kept strict Origin validation on MCP project endpoints.

### 0.10.0

- Fixed public listener topology: ACME-only HTTP on IPv4 port 80, MCP/OAuth HTTPS on IPv4 port 443 and local-only GUI.
- Removed public listener port controls from Settings.
- Added certificate inspection and reuse before ACME ordering.
- Added persistent renewal scheduling, retry/backoff and Let's Encrypt rate-limit reset handling.
- Added a separate self-signed fallback so HTTPS continues listening when no trusted certificate is available.
- Expanded dashboard TLS validity, last-request, renewal and rate-limit diagnostics.

### 0.9.4

- Moved Origin enforcement from global routing to the MCP endpoint.
- Allowed ChatGPT to navigate to the OAuth authorization page cross-origin while retaining protection for consent submission.

### 0.9.3

- Moved HTTP-debug enablement from general Settings to the HTTP debug page.
- Hardened OAuth request validation, resource/scope binding, PKCE, issuer responses and token exchange.
- Added narrowly scoped recovery for ChatGPT dynamic registrations and rotated ChatGPT callback identifiers.
- Added explicit OAuth failure reasons.

### 0.9.2

- Adopted the hybrid extra-command model.
- Automatically exposed executable files only at the first level of `.mrmcp/bin`.
- Kept nested command paths explicit through catalog entries.
- Made catalog entries override automatic commands with the same logical name.

### 0.9.1

- Removed recursive command discovery.
- Made command descriptions optional.
- Hid missing, disabled and non-executable catalog commands from agents while retaining GUI warnings.

### 0.9.0

- Added persistent Deno-worker JavaScript tools compatible in name with Codex `node_repl`: `js`, `js_add_node_module_dir` and `js_reset`.
- Added logical command names, nested paths, descriptions, enablement and catalog-based structured execution.
- Added searchable, paginated command administration.

### 0.8.1

- Added the first searchable command metadata catalog and GUI Commands page.
- Added installed/missing status and Windows executable-suffix normalization.
- Refined compact MCP tool descriptions.

### 0.8.0

- Moved Eta exclusively server-side using JSR and `<? ... ?>` templates.
- Vendored the supplied Morphlex 1.4.0 for local client-side DOM updates.
- Made browser UI updates server-rendered fragments.
- Enforced local-only GUI and IPv4-only public behavior.
- Made IPv4 lookup, sslip suffix and ACME directory configurable.
- Added `.mrmcp/bin` PATH precedence, `list_commands` and explicit `cwd` support for command execution.

### 0.7.1

- Removed browser CDN imports and unsafe runtime template compilation.
- Served the browser module locally under a self-only CSP.
- Replaced client rendering with local, escaped rendering and stable fragment updates.

### 0.7.0

- Consolidated named project roots and one selected root per workspace session.
- Added batched filesystem operations and managed foreground/background process tools.
- Refined modern and legacy MCP discovery/initialization behavior.
- Improved project-scoped OAuth, Basic authentication, execution policies and observability.

### 0.6.0

- First retained release artifact.
- Established the single-file Deno/WebView application, SQLite persistence and project GUI.
- Added project roots/workspaces, filesystem tools, process execution, approvals and execution logs.
- Added OAuth dynamic registration, PKCE tokens, Basic authentication and MCP protocol compatibility.
- Added public-IP/sslip ACME certificate support and HTTP/HTTPS listener management.
