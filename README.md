<p align="center"><img src="./assets/mrmcp-logo.png" alt="MrMCP" width="180"></p>

# MrMCP 0.11.4

MrMCP is a stateless Model Context Protocol server implemented in Bun. It exposes one authenticated `/mcp` endpoint, Workspace-scoped Sessions, filesystem and process tools, OAuth/Basic authentication, TLS automation, and a native GPUIX administration UI.


## Features

- MCP `2026-07-28` with explicit `chat_session` Session capabilities.
- Named Workspaces with drag-and-drop Session assignment.
- Persistent ChatGPT subagents through `subagents`: independent worker chats, Session-scoped messages/results, bounded waits and a native Subagents page.
- Persistent ChatGPT goals through `chat_set_goal`: send a follow-up after Tool Call inactivity, using the user's system Chrome through CDP Ext reverse mode. Sessions shows the association, timer state and Stop goal control.
- AAF desktop automation through `desktop_auto`, including zero/one/many model-visible WebP/PNG screenshots mixed with structured OCR, geometry and state output; the local Automation page reuses **Payload-retained** Tool Calls/screenshots for inspection and can replay a scenario directly as a local user action without creating another Tool Call.
- Browser control through [`cdp.js`](https://github.com/mefistofelix/cdp.js) and batched `cdp_call`: dedicated Chromium/CDP, existing debugging endpoints, or Chrome extension control without a debugging port. `cdp_ext:true` opens/reuses system Chrome through token-bound URL bootstrap; the user installs CDP Ext once, with no extension ID or endpoint to enter. Custom profiles and explicit extension installation remain available, alongside passive `reverse` attachment. Agent and user choose the mode. Existing tabs, `chrome.*` APIs, native groups, permitted CDP operations and request notifications use the existing subscription/poll, diagnostics and Replay tools. See [options and setup](TOOLS.md#cdp_call).
- Explicit persistent Global/Session/Workspace key-value memory through `memory_find` and `memory_set`, with explicitly typed JSON/text values, TTL and a local Memory manager.
- Filesystem, text search/editing, reversible trash and generated-file publishing.
- Incremental document retrieval through `document_grep`, backed by [rag.js](https://github.com/mefistofelix/rag.js): Turso fulltext/vector/hybrid search, Xberg extraction/local embeddings, local PaddleOCR and page/UTF-8 citations. MrMCP applies globstar/MIME/`.gitignore` scopes. Settings → Search edits `search.yaml`; embedding models download only for explicit vector/hybrid searches; PaddleOCR models download only when OCR is needed, with no additional software or API key.
- Foreground and persistent processes with progress streaming when requested.
- Persistent JavaScript kernels scoped to Session + Workspace.
- Separate stdio MCP catalog `mcp.yaml` and **MCP Servers** GUI. `exec_mcp` forwards raw JSON-RPC requests with automatic handshake, per-command/idle-TTL/until-quit process reuse and hidden terminals. The default LibGen/Anna’s Archive engine is maintained `jmrplens/libgen-mcp` v2.2.1; use `tools/list` to discover its current search/download schemas.
- Extra command catalog through `commands.yaml`, with OS/CPU variants, native yt-dlp, Google Workspace `gws` downloads (including Drive/Gmail), and whisper.cpp CLI with its multilingual model.
- `proxy_get` provides paginated proxy discovery, weighted random/round robin selection and persistent reported outcome statistics. Settings → Proxies edits `proxies.yaml`.
- User-managed MCP guided prompts through `guided_prompts.yaml`, with Eta templates, two editable starter examples (one argument-free and one parameterized), and a built-in template/model help view.
- OpenRouter JSON API through `openrouter_req`, with the API key configured on the dedicated OpenRouter GUI page; model discovery and non-streaming requests work without a Workspace.
- OAuth and Basic authentication. OAuth client registrations remain valid until explicitly deleted; ChatGPT reconnect can recover its cached registration after a data reset for either documented callback format, with fresh consent and PKCE.
- Automatic TLS/certificate handling.
- Tool Call and optional HTTP diagnostic logs. Tool Call history has independent **Disk / Memory** storage and **Payload / Metadata** retention policies. Disk history survives restart; Memory history uses volatile Turso TEMP storage. Payload stores exactly the canonical MCP JSON-RPC request and response packets once; Metadata stores neither packet. The fullscreen Tool Call debugger interprets nested JSON/YAML, multiline text, readable Base64 and images only while viewing a row, without persisting decoded copies. Disk retention is configured in hours and Memory retention in minutes. Functional process/CDP/Memory/Published/Trash state, authentication, Sessions, Workspaces and configuration are never disabled or made volatile by the Tool Call logging policy.
- Native React/GPUIX desktop UI with compact dark panels, overlay dropdowns, keyboard navigation and OS directory drops. State and drafts stay in the backend; direct asynchronous actions let navigation and typing continue during independent operations. Tray and OS notification delivery are temporarily disabled while GPUIX lacks those APIs; preferences remain saved.
- One MIME-aware `publish` MCP App helper for Workspace paths, direct text and Base64 bytes, with persistent deduplicated `.mrmcp/publish/` files, inline/download presentation hints, multi-Workspace publication references and a local Published manager for filtering, native opening and deletion.

## Requirements

- Bun 1.4.3 or newer for source mode; release binaries include the runtime.
- Windows x64, Linux x64 or macOS Apple Silicon for the native GUI.
- Permission to bind public ports 80 and 443 when those listeners are enabled.

## Run

Install source dependencies with `bun install`. Update Auto.js/CDP.js with `bun update @mefistofelix/auto.js @mefistofelix/cdp.js` when needed.

Desktop GUI:

```bash
bun mrmcp.js
```

Headless backend:

```bash
bun mrmcp.js --backend
```

Register a Workspace without starting the server:

```bash
bun mrmcp.js --add-workspace "Workspace name" "/path/to/workspace"
```

The desktop UI is local-only and opens no GUI TCP listener. Public MCP/OAuth traffic uses HTTP/HTTPS listeners; occupied base ports fall back in `+50` steps without rewriting configuration.

Document search also works without an open Workspace: Search `default_path` defaults to Desktop/`_default`, created on the first search. Indices persist under `.mrmcp/search`, with a separate `_default` namespace and one hash per real source path. This leaves the Session unassigned; ordinary file/process tools still need a Workspace. Settings → Search shows the effective default source path.

Settings shows the absolute **Data Directory** path in every tab. Portable builds keep `.mrmcp` beside the executable; source mode keeps it beside `mrmcp.js`; the macOS app uses `~/Library/Application Support/MrMCP/.mrmcp`.

If the database schema is incompatible at startup, the desktop asks whether to **Start Fresh** or **Quit**, showing both the current folder and proposed backup path. Start Fresh renames the entire `.mrmcp` folder to a sibling `.mrmcp.backup-YYYYMMDD-HHmmss` folder (with a suffix when necessary), then creates new settings, credentials and data. Existing backups are never replaced, and Quit preserves the current data. Headless and one-shot modes require terminal confirmation; unattended runs stop with recovery instructions.

## Workspaces and Sessions

MrMCP keeps transport state stateless. Persistent application state is selected explicitly with a `chat_session`.

1. Call `init_chat_session()` once to create a chat Session without opening a Workspace.
2. Pass its exact `chat_session` on every subsequent tool call, including discovery and diagnostics.
3. Call `list_workspaces(chat_session)` and then `open_workspace(chat_session, name)` when a Workspace is needed. Use `create=true` only to explicitly create a missing Workspace as an empty Desktop folder.
4. To switch Workspace, call `open_workspace` with the same `chat_session` and another name; the Session identity stays unchanged.

File operations, new processes, configured commands and JavaScript kernels require an open Workspace. Desktop/CDP automation, discovery, diagnostics, memory, Telegram and text/Base64 publication can run before one is selected. Invalid or expired session values fail without creating replacements.

`open_workspace` also returns the Workspace name, absolute working directory, optional `agent_guidance_path`, whether this call created the Workspace, and a compact Memory summary containing live counts plus up to five latest keys for Global, Workspace and Session scope. Guidance resolution prefers Workspace-root `AGENTS.md` / `agents.md` and falls back to `CLAUDE.md` / `Claude.md` / `claude.md`; when the returned path is present, read and follow it before repository work.

The administration UI displays Sessions with short numeric ids. The opaque `ctx_...` value remains the MCP bearer capability. A Session may move between Workspaces, while historical Tool Calls retain the Workspace snapshot captured when each call started.

`chat_set_goal(chat_session, goal, timeout_seconds?, chatgpt_chat_id?)` enables automatic follow-ups for a ChatGPT
conversation. Install [CDP Ext](https://github.com/mefistofelix/cdp.js#reverse-chrome-extension-transport)
yourself in your system Chrome: load its cdp_ext directory from chrome://extensions in Developer mode,
sign in to ChatGPT normally and reload CDP Ext after updating its files. CDP.js 0.5.0 opens or reuses
that system browser through a token-bound loopback URL carrying its logical name and endpoint.
No extension ID, endpoint or separate login/profile is configured. Goals use the page React cache,
without monitoring history responses or WebSocket traffic.

Use **Settings → Goals → Save CDP Ext folder** to export the bundled extension, including offline.
The destination is editable and defaults to `cdp_ext` beside MrMCP's catalogs. In `chrome://extensions`,
enable Developer mode, select **Load unpacked** and choose that folder. Keep its path stable.
For updates, export to the same folder, confirm replacement and press **Reload** in Chrome.

Settings retains enable (on), default timeout (5 minutes), missing-match retry at startup (off) and
Stop-before-send (off). Browser bootstrap and logical goal-tab acquisition happen only when a
match or due/manual delivery needs them. MrMCP creates/reuses one logical goals tab
in a purple **MrMCP Goals** group. Settings/status inspection creates nothing. Reconnects reuse the
owned tab; recycled browser tab IDs cannot adopt personal tabs. Disable/Quit leaves Chrome and tabs open.

Each nonempty set for an unassociated Session requests one bounded scan of up to 20 rendered recent
chat links. Open candidates one at a time and match the exact chat_session in their active-branch
React conversation cache, with rendered tool details as a fallback. Failed attempts require another
set or manual debug action; startup retries remain opt-in. Optional `chatgpt_chat_id` takes the
conversation ID from its `/c/<id>` URL and bypasses the scan. Omission retains the existing ID. Site
sign-in failures suspend the affected goal; sign in normally and retry explicitly. Website changes
can require adapter updates. Goal state is independent of history retention and no schema change is needed.

Once linked, Tool Call arrivals/completions and observed changes in the ChatGPT turn reset inactivity. Every in-flight Tool Call in any Session linked to the same conversation suspends delivery, including long calls; a full timeout starts after completion. MrMCP recognizes completed turns from explicit model markers, while an unchanged streaming/busy state can become idle and receive a follow-up after the timeout. The first observed running turn receives one conservative baseline interval. Only the shared tab is observed; other conversations are inspected when visited. Turn completion does not mean the goal has been achieved and does not clear it. Stop-before-send optionally interrupts a stalled response, while drafts and dialogs are preserved. The scheduler checks every five seconds and moves to other goals after submission confirmation, without waiting for an answer. Set `goal:""` or use **Sessions → Stop goal** to stop; uncertain delivery suspends further sends until inspection and an explicit new set. Goals/associations persist through restart and history cleanup. See the [complete Goals contract](TOOLS.md#chat_set_goal).

## Subagents

The `subagents` tool creates reusable ChatGPT worker chats with explicit tasks/shared context,
messages, status/wait, final reports, Stop and Resume. Each worker initializes its own Session and
inherits the selected Workspace; workers share files and must coordinate edits. Configure CDP Ext
and the installed MrMCP ChatGPT app's asdk_app_… ID/display name in **Settings → Goals**. Keep system
Chrome signed in; CDP.js opens or reuses it on demand. Workers use a separate cyan **MrMCP Subagents** tab group, independently of the
Goals enable switch. There is no model API, separate browser profile or additional quota.

**Subagents** lists workers with parent/child Session, state and text filters, pagination, task,
Workspace, activity, model evidence, pending messages, running Tool Calls and detached processes.
Open details for the task/context, timestamps, result, errors and paginated message/report history;
queue a message, Stop or Resume there. Reports are collected through the tool rather than injected
into the parent's chat. Restart pauses workers and uncertain sends are never replayed automatically.
State survives history cleanup. See the [complete contract](TOOLS.md#subagents).

## Tools

Session and Workspace:

- `init_chat_session`, `chat_set_goal`, `chat_goal_debug`, `subagents`, `list_workspaces`, `open_workspace`, `tools_log` — chat initialization/goals, Workspace selection and history inspection.
- `workspace_dev_preferences_write` — only on explicit user request, copy sidecar `DEV_PREF.md` from beside MrMCP into the current Workspace when that file is absent; never overwrite an existing project file or return preference content.

Desktop and browser automation:

- `desktop_auto` — execute one AAF YAML scenario through Auto.js; arbitrary final state is preserved and retained screenshots are returned directly as MCP image content for model vision.
- `cdp_call` — send an always-present `calls[]` batch spanning browsers/targets; each entry may omit `browser` to use the persistent `main` profile. `browser` accepts a name string or an object with required `name` plus `headless`, `executable_path`, `user_data_dir`, `args`, an existing debugging `port` with optional `host`, `http_url` discovery or a direct `websocket_url`. `target` also accepts an object with required `name`, native `create_params` and switches for Runtime, Network, Page, ServiceWorker, focus, binding and BackgroundService setup (`initialize:false` skips all optional setup); advanced options are reused by name for the current server run and must be supplied again after restart. Every operation uses `{method,params}`, with standard CDP names or local XPath extensions `_.click` / `_.find`; standard `Page.captureScreenshot` may optionally return a Base64 screenshot post-processed through the public Auto.js `auto.vips` API to scaled WebP (current encoder Q=80) while preserving all normal CDP screenshot params.
- `cdp_subs`, `cdp_poll` — add/remove runtime subscriptions (including `*`, target/method-prefix and full-message regex filters) and read bounded CDP traffic through ascending cursors or ad-hoc polling.

Memory:

- `memory_find` — search one or many memory scopes, or `*` for Global + current Session + all Workspaces, by exact/prefix key, literal or regex text, set date and stable pagination.
- `memory_set` — set/replace/delete text values with explicit `json=true|false`; JSON text is validated before storage, with optional TTL in the selected Global, Session or Workspace scope.

The desktop **Memory** page filters stored values by scope, Session, Workspace, set date and text, labels JSON vs TEXT, and allows creation, full value/type/TTL inspection, editing and confirmed deletion. New entries explicitly choose Global scope or an existing Session/Workspace owner. JSON values use an editable JSON tree with node-level operations; text values use the plain text editor, and switching TEXT ↔ JSON never discards the current draft value. Expired TTL rows are removed automatically; Clear Operational Data preserves Memory.

Filesystem:

- `fs_glob`, `fs_grep`, `fs_read`, `fs_navigate`, `fs_stat`
- `fs_write`, `fs_edit`, `fs_text_convert_encoding_eol` — explicit lossless charset/EOL/BOM conversion for named existing text files, with unchanged detection and no implicit repository normalization.
- `fs_mkdir`, `fs_copy`, `fs_move`, `fs_trash`, `fs_untrash`
- `publish` — publish exactly one Workspace path, text string or Base64 payload with a required MIME type, optional filename/title/description and an `auto|inline|download` presentation hint.

The `fs_*` surface is multi-file where appropriate, stateless for navigation/pagination, uses opaque file fingerprints for optimistic concurrency, and reports independent per-entry outcomes instead of cross-entry rollback. `fs_glob` defaults to lightweight path/type pages and adds size/timestamps/link targets only with `metadata=true`; `fs_grep` pages by explicit result count with stateless `resume_after`, while `fs_read` keeps its per-file text ceiling and per-file `next_start_line` continuation without an aggregate batch byte budget. See `TOOLS.md` for the complete tool contracts and rationale.

Filesystem and retrieval tools provide compact text summaries of result counts, errors and continuations alongside the complete structured result. `fs_grep` reports the effective `max_file_bytes` and page-local `skipped_large_files`, making incomplete search coverage visible even when no matches are returned. Use the available Cymbal catalog command for symbol/caller exploration and the filesystem tools for textual search and file operations.

Settings → **Files** controls automatic encoding detection for reading and searching: **Initial 16 KiB** (default, faster) or **Complete file** (more thorough). Sample mode retries full detection when confidence is low or its charset cannot decode the entire file, but can still miss later charset clues. File edits and conversions always use complete detection; an explicit encoding skips detection.

Settings → **Process** can disable Git's automatic CRLF conversion by injecting `core.autocrlf=false` (enabled by default). Existing CRLF checkouts created with `autocrlf=true` may appear modified under this policy without any file edit; switch the option off to use the repository/machine policy. `.gitattributes` and explicit `git -c` options still apply. Saving unrelated settings leaves the MCP listeners running.

Commands and execution:

- `discover_commands` returns the complete available extra-command catalog in YAML order, with descriptions and documentation links. Agent discovery can be globally enabled/disabled from the Commands page without changing the catalog or executables.
- `exec`, `exec_start`, `exec_attach`, `exec_write`, `exec_kill`, `exec_list`, `exec_status`
- `js`, `js_add_node_module_dir`, `js_reset`
- `tools_schema` — inspect canonical live MCP descriptors; `tools_log` — query Tool Calls that reached the current Session across both Disk and Memory history, using `detail=summary` by default or `detail=full` to retrieve the retained canonical `mcp_request` / `mcp_response` packets.
- `telegram_req` — make one generic pre-authenticated Telegram Bot API JSON request using the Bot token configured by the user on the dedicated **✈️ Telegram** sidebar page.
- `openrouter_req` — make an authenticated OpenRouter JSON API request using the key saved on the OpenRouter page; model discovery, chat, responses and embeddings require only a Session. Returns provider JSON, status, usage and errors; streaming is unsupported.

Filesystem removal is reversible: `fs_trash`/`fs_untrash` use explicit `trash_id` transactions instead of a permanent delete tool. All Workspaces share the single MrMCP-managed `APP_DIR/.mrmcp/trash/` payload store; MrMCP never creates `.mrmcp` metadata directories inside named Workspaces. Trash transaction/item metadata lives in Turso (`trash_transactions` / `trash_items`) with original path, cached type and cached byte size for non-directory payloads; directory size is deliberately left unknown to avoid recursively scanning a tree before a rename; no JSON manifest copy is written. The desktop **Trash** page uses the DB for inventory/sidebar counts and checks each tracked payload live on disk, making missing payloads explicit while preserving their cached metadata until deleted. Restore/delete and Empty Trash remain independent of Tool Call logging.

Foreground `exec` defaults to **45 seconds** but `timeout_ms` may be raised up to **1 hour**. High request timeouts deserve care: some clients/proxies/gateways retry or replay long requests (a ~60-second replay boundary was observed in ChatGPT testing). `exec` and `exec_start` therefore accept optional client-chosen `operation_id`: within the same Session and tool, identical retries reuse the original process while it is active and for **5 minutes after completion**; different process arguments with the same live key are rejected, and the key may be reused normally after the grace period. This key is transient replay protection, not a permanent Session-wide identifier. Prefer `exec_start` for long or non-idempotent jobs and poll with `exec_status` or bounded `exec_attach` calls. `exec_attach` defaults to 45 seconds, allows up to 1 hour, and returns `wait_timed_out=true` when only the attachment wait expires while the persistent child remains running; shorter repeated attaches avoid overlapping retry windows. Persistent processes use the integer `exec_id` returned by `exec_start`; a replay-protected `exec_start` returns that same `exec_id`. Follow-up process tools require the same Session `chat_session`. Process runtime/history is owned by the process subsystem and remains independent of Tool Call Disk/Memory storage, payload retention, retention pruning and Tool Call Clear.

## Guided prompts

`guided_prompts.yaml` is the authoritative guided-prompt catalog exposed through MCP `prompts/list` and `prompts/get`. The local Guided Prompts page creates, edits and deletes entries directly in that file. Templates use Eta and receive prompt arguments plus sanitized server/runtime context; when a prompt declares and receives a valid `chat_session`, the template also gets that Session and its current Workspace. The Guided Prompts page has a dedicated Template Help view with the YAML shape, Eta examples and model fields.

## Authentication and networking

Authenticated OAuth or Basic clients receive the published tools; anonymous clients do not.

The only public MCP protocol endpoint is `/mcp`. MrMCP advertises MCP `2026-07-28` and does not use `Mcp-Session-Id` transport sessions. Ordinary calls return JSON. Foreground process calls can use request-scoped SSE progress when `_meta.progressToken` is supplied, while the final result still contains the complete transcript; request-scoped process waits default below common retry boundaries but may be explicitly increased; persistent `exec_start` remains the recommended path for long work because its child is independent of one HTTP request lifetime.

Base public ports are:

- HTTP `80` — ACME HTTP-01.
- HTTPS `443` — MCP, OAuth and metadata.

ACME HTTP-01 is available only while the effective HTTP listener remains on port 80.

## Desktop application

Desktop mode runs GPUIX and the backend directly in one Bun process/event loop, without a backend Worker or
render-message copies. The main database uses Turso’s public asynchronous driver; transactions retain exclusive
connection ownership. Application state, validation, dialogs, drafts and actions stay in the backend. Native
providers and external child processes retain their own execution mechanisms.

Bun compiles inline JSX in mrmcp.js with a small local declaration factory and file-level pragmas, without
extra JSX configuration. The official React/GPUIX renderer reconciles the immutable keyed widget declarations
and skips unchanged subtrees. Flex/Grid layout and scrolling stay native; explicit column widths avoid
expensive intrinsic layout. Dropdowns use the official GPUIX Select components. Dialogs keep title/actions
visible while their body scrolls. There is no application scrollbar or geometry polling loop. GPUIX 0.10
currently scrolls without visible scrollbar thumbs; support awaits the public package. Precise trackpad
motion stays native and line-wheel steps are enhanced.

The administrative GUI has no WebView, DOM, HTML generation/parsing, Morphlex, Tauri bridge or network
listener. Eta loads only for editable guided_prompts.yaml templates. OAuth consent and published MCP Apps
remain web content.

Closing the window stops the backend and its managed processes. Tray, hide-on-close and native OS notification delivery are temporarily unavailable; the Notifications tab retains the saved preferences and explains their suspended state. Directory drops and Session-to-Workspace drag/drop remain supported. JSON values use the native tree and an editable JSON source view. GPUIX currently exposes no reliable minimize/visibility event, so backend projections may continue while minimized; native focus and selection remain with GPUIX.

Windows builds use Bun's console-hiding and executable-icon build flags. macOS Apple Silicon is distributed as an ad-hoc signed app bundle in a DMG. macOS Intel is no longer supported.

The standalone embeds a compressed, target-specific copy of the unchanged public dependency packages and their licenses. The first native-package use extracts them atomically to a content-addressed cache: Windows `%LOCALAPPDATA%/MrMCP/runtime`, macOS `~/Library/Caches/MrMCP/runtime`, Linux `$XDG_CACHE_HOME/mrmcp/runtime` (or `~/.cache/mrmcp/runtime`). Rebuilds with unchanged dependencies reuse this cache. No external Bun, Node, Python or model server needs installation. Search indices, browser profiles and embedding models retain their existing `.mrmcp` paths.

Build locally with `bun .github/build.mjs`; validate with `bun .github/check.mjs`, or add `--semantic --standalone` for actual embeddings/OCR/CDP and standalone checks.

## Release binaries

A version tag matching `mrmcp.js` `VERSION` triggers `.github/workflows/release.yml`. The GitHub Release contains:

- `mrmcp-windows-x64.exe`
- `mrmcp-linux-x64`
- `mrmcp-macos-arm64.dmg`

The macOS app is currently ad-hoc signed; warning-free first launch of an Internet-downloaded build requires Developer ID signing and Apple notarization.

## Project files

- `mrmcp.js` — server, tools, Turso, local UI and desktop launcher.
- `commands.yaml` — editable extra-command catalog.
- `guided_prompts.yaml` — editable MCP guided-prompt catalog and Eta templates.
- `proxies.yaml` — proxy entries, public list sources and cooldown configuration, editable in Settings → Proxies.
- `search.yaml` — document search, embeddings and OCR configuration, editable in Settings → Search.
- `README.md` — current user/operator overview.
- `CHANGELOG.md` — release history.
- `AGENTS.md` — implementation invariants, backend-authoritative native GUI/state contracts and release checks.
- `LICENSE` — MIT license for MrMCP and JSONEditor third-party license notice/text.
- `package.json`, `bun.lock` — existing runtime dependencies and reproducible installation; Auto.js/CDP.js retain unversioned public imports and latest update policy.
- `.github/build.mjs`, `.github/check.mjs` — target packaging and isolated integration checks.
- `.github/workflows/` — native build/release automation.
- `assets/` — branding/icons and historical screenshots/vendor assets. Retired WebView scripts are not loaded or compiled.

Runtime data lives under `.mrmcp`. Packaged macOS builds keep mutable state, `commands.yaml`, `guided_prompts.yaml`, `search.yaml` and `proxies.yaml` under `~/Library/Application Support/MrMCP/` rather than inside the application bundle. Document indices live under `.mrmcp/search/` and survive operational history cleanup. Local embeddings are enabled by default (`provider: local`, `model: fast`). The first vector/hybrid search automatically downloads the model (~24 MB), then cached models work offline inside each Rag profile’s `models/embeddings` folder under `.mrmcp/search/`; opening/saving Settings downloads nothing and fulltext never downloads an embedding model. Choose `model: multilingual` for Italian and other languages (~1.1 GB). Existing edited configurations are preserved: Settings → Search → **Use local embeddings**, then Save, switches an existing install. Ollama and OpenAI-compatible endpoints remain optional. Searchable PDF pages use embedded text. OCR defaults to rag.js/Xberg PaddleOCR (PP-OCRv6 small), with lazy local models in each profile’s `models/paddle` folder; `ocr: native` explicitly selects OS OCR and `ocr: disabled` turns OCR off. Existing YAML is preserved; **Use PaddleOCR**, then Save, switches an existing install. Use the catalog yt-dlp command to download subtitles, then index the saved Workspace files. Proxy outcomes must be reported explicitly through proxy_get. The optional native OCR provider depends on the OS's installed recognition support. Paddle’s auto language profile has fixed coverage; it is not universal script detection.

The Turso main database uses schema 6 and native full-text indices instead of SQLite FTS5, including persistent proxy statistics. Earlier schemas require Start Fresh, which archives the entire previous data directory; there is no automatic migration or import. One process owns a data directory at a time: close the running instance before a separate --add-workspace invocation. Existing editable YAML catalogs are preserved; update their platform definitions manually when keeping an older catalog.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MrMCP is licensed under the [MIT License](./LICENSE). The same file retains JSONEditor's Apache-2.0 notice and full license text; dependencies retain their respective licenses.
