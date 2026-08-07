<p align="center"><img src="./assets/mrmcp-logo.png" alt="MrMCP" width="180"></p>

# MrMCP 0.10.62

MrMCP is a stateless Model Context Protocol server implemented in Deno. It exposes one authenticated MCP endpoint at `/mcp`, a loopback administration interface, filesystem and text-editing tools, an extra-command catalog, managed processes, a persistent JavaScript worker, OAuth and Basic authentication, TLS automation, and explicit `context_handle` capabilities for persistent application state.

### Tool Calls

Expanded process calls show a terminal-style command and combined output above the raw MCP input/result JSON, while the table keeps live status, duration and Session context visible.

![MrMCP Tool Calls view](./assets/mrmcp-screenshot1.png)

### Roots

Named roots and unassigned Sessions are managed in one drag-and-drop view, with activity, status and Tool Calls counts visible on each Session.

![MrMCP Roots and Sessions view](./assets/mrmcp-screenshot2.png)

The desktop window uses `jsr:@webview/webview@0.9.0`, imported directly by Deno. The project has no Node.js application, npm install, CLI scaffold, Rust, Tauri or Neutralinojs runtime.

## Project files

- `mrmcp.js` — backend, MCP endpoint, SQLite schema, administration UI and desktop launcher.
- `commands.yaml` — editable extra-command catalog. Source mode reads this root file directly; standalone builds embed it as the first-run template and materialize it beside `mrmcp.exe` only when no physical `commands.yaml` exists.
- `README.md` — user and operator documentation.
- `AGENTS.md` — implementation invariants and release checks.
- `assets/` — static WebView/build assets: `morphlex.js`, SVG/PNG branding, Windows ICO and administration screenshots.

## Requirements and startup

Requirements:

- Deno with `node:sqlite` support.
- Native dependencies required by `@webview/webview` on the target platform.
- Permission to listen on ports 80 and 443 when the public listeners are enabled.

Desktop GUI:

```bash
deno run -A --unstable-ffi mrmcp.js
```

Headless backend:

```bash
deno run -A mrmcp.js --backend
```

The administration interface is served at `http://127.0.0.1:7332/`. Desktop mode starts the backend as a Deno child process, waits for `MRMCP_READY`, opens the authenticated loopback URL in the WebView and terminates the child when the window closes. The initial window size is 1180×760.

The authenticated GUI serves `assets/` uniformly under `/assets/`. With `deno run`, those files come directly from the repository `assets/` directory. Standalone builds embed that directory with `deno compile --include assets`, so the WebView uses identical `/assets/...` URLs in source and standalone builds. `commands.yaml` is not a WebView asset: compile it separately with `--include commands.yaml`; on first standalone backend startup, MrMCP copies the embedded template beside the executable only if no editable physical `commands.yaml` exists there.

Windows standalone build:

```powershell
deno compile -A --unstable-ffi --no-terminal --include assets --include commands.yaml --icon assets/mrmcp.ico --output mrmcp.exe mrmcp.js
```

`--no-terminal` makes the Windows standalone executable a GUI application, so launching `mrmcp.exe` opens the WebView without an additional console window. Source-mode `deno run` remains a normal terminal process for development and diagnostics.

## MCP 2026-07-28 and stateless operation

MrMCP advertises and accepts only MCP `2026-07-28`.

That protocol revision removed the `initialize` / `initialized` handshake and the `Mcp-Session-Id` transport header. Every request is self-describing and independent. The protocol maintainers explicitly recommend that applications which need state across calls issue an ordinary explicit handle and require the model to pass it back as a tool argument.

References:

- [The 2026-07-28 Specification — No handshake or sessions](https://blog.modelcontextprotocol.io/posts/2026-07-28/#no-handshake-or-sessions)
- [SEP-2567 — Sessionless MCP via Explicit State Handles](https://modelcontextprotocol.io/seps/2567-sessionless-mcp)
- [SEP-2575 — Make MCP Stateless](https://modelcontextprotocol.io/seps/2575-stateless-mcp)

MrMCP implements that application-level pattern with an explicit `create_context` tool and a required `context_handle` argument on every other tool. The handle is an opaque bearer capability, not a transport session identifier.

### Create and reuse a context

1. Call `create_context` without `context_handle`.
2. MrMCP creates and returns a globally unique, unguessable `ctx_...` value.
3. Call `context_info` with that handle before repository work.
4. `context_info` returns the current absolute root and, when present, the root-level `AGENTS.md` or `agents.md` path to read and follow.
5. Pass the exact handle unchanged in `context_handle` on every later MrMCP tool call. Call `context_info` again after the operator changes the Session root.
6. A missing, unknown or expired handle does not execute the requested operation and does not mint a replacement automatically. Recover with `create_context`, then repeat the requested call.

Successful tool results repeat only the bearer capability as common metadata:

```json
{
  "context_handle": "ctx_..."
}
```

A missing, invalid or expired handle returns `isError: true` with an `error` message explaining that `create_context` must be called. No replacement handle is minted automatically. Contexts expire after 30 days without activity.

The handle itself selects the context after authentication. MrMCP does not bind contexts, processes or JavaScript kernels to the OAuth client or Basic credential that created them. Any authenticated client possessing a valid handle can use that context. The context row records best-effort metadata about the client that created it (authentication kind, OAuth client id/name when available, and User-Agent) for operator visibility only; those fields are not authorization or ownership controls.

### Why the GUI says “Sessions”

The administration interface labels contexts **Sessions** because that is convenient for operators. Each row is identified in the GUI by a short numeric primary key; the long `ctx_...` bearer capability remains internal to MCP calls. This is only a GUI term. MrMCP does not implement protocol sessions and does not use `Mcp-Session-Id`.

The Sessions table also shows best-effort creation-client metadata. MCP does not reliably expose the ChatGPT model or thinking/reasoning level, so MrMCP does not invent those values. Changing model or thinking level in the same ChatGPT conversation may cause ChatGPT to create another MCP context, so the same GUI Session is not guaranteed to persist across such changes.

## Authentication and tool access

Authentication controls access to MrMCP; `context_handle` selects persistent state after authentication.

- Authenticated OAuth or Basic clients receive every published built-in and custom tool.
- Anonymous clients receive no tools and cannot execute operations.
- There are no tool approvals, enable lists, execution switches, `allow_re`, `deny_re` or user-defined per-tool policies.
- OAuth consent authorizes the client itself, not an individual tool call.

The only public MCP endpoint is `/mcp`. OAuth protected-resource metadata is exposed for that single resource.

## Database policy

SQLite is treated directly as persistent application state; MrMCP does not maintain a database schema version or gate startup on `PRAGMA user_version`.

- The database is `.mrmcp/mrmcp.sqlite` beside the application.
- Startup ensures current tables and indexes with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so additive structures become available automatically on an existing database.
- There are no `ALTER TABLE` migrations, backfills, aliases, old-key imports or legacy identifier acceptance.
- Startup still verifies the columns that current code actually requires. If an existing table has an incompatible shape, stop MrMCP and recreate `.mrmcp/mrmcp.sqlite` rather than adding compatibility code.

The current schema gives every context a numeric administrative primary key in `contexts.id` while retaining a unique opaque `context_handle` for MCP calls. Tool-call and process rows store both the numeric `context_id` snapshot used by the GUI and the opaque handle used by the protocol. Contexts additionally store the creation authentication kind, OAuth client id/name when available, and User-Agent as observational GUI metadata. A context stores exactly one current `root_id`; root id `0` denotes the program directory.

## Roots and filesystem isolation

The Roots page lets the operator register named directories and assign one current root to each Session. Root paths may be absolute or relative; MrMCP stores the entered value unchanged, and resolves relative roots against the program folder only when the Root is actually used. Path existence/type validation runs when the path field loses focus and never blocks saving; invalid named-root paths are shown in red anywhere the administrative UI displays them. The page is split into **📁 Roots** on the left and **💬 Sessions** with **No root assigned** on the right. Each named-root card contains its current Session assignments. Session drag items keep the first line to Session id/client only and render Created, Last Activity, Status and `Tool Calls: N` together as compact metadata underneath; generic OAuth text is omitted there. The Default-root card explains that unassigned Sessions use the program folder without printing that folder's absolute path.

- Drag a Session from the right-hand Sessions column into a named root to assign it.
- Drag a Session from a named root back to the right-hand Sessions column to remove its named-root association; root id `0` is stored immediately.
- Dragging directly between named roots reassigns the Session in one step.
- Disabled roots remain visible for editing/deletion but cannot receive Sessions.
- The Sessions page shows the current root name and path as read-only information; assignment is performed only from Roots.
- A root may be assigned to any number of contexts.
- Every context always has exactly one effective root.
- A new context starts on the fallback root beside `mrmcp.js`.
- Changing a Session's root affects new tool calls immediately.
- Existing background or interactive processes continue in the directory where they started.
- Disabling or deleting a root moves currently associated contexts to the fallback root without terminating processes.

The public `context_info` tool returns the absolute root directory currently assigned to the supplied context plus a nullable absolute `agent_guidance_path`. A non-null path means guidance is present; no separate boolean is needed. MrMCP checks only the root-level `AGENTS.md`, then `agents.md`; it does not scan parent or child directories. When the path is present, the agent must read and follow that file before modifying the repository. Root identifiers, available roots and other administrative metadata are not exposed through MCP tools.

All relative paths and new child-process working directories must remain inside the root captured at the start of the tool call.

## Built-in tools

Context and location:

- `create_context`;
- `context_info`;
- `query_tool_calls` — query calls that actually reached MrMCP for the same `context_handle`, with exact tool/status filters, literal full-record text search, stable backward pagination and a bounded result limit.

Filesystem and text:

- `read_file`, `read_files`, `write_file`, `write_files`;
- `glob`, `grep`, `edit`, `replace`;
- `file_info`, `create_directory`, `copy_path`, `move_path`, `trash_paths`, `untrash_action`;
- `publish_file`, `publish_html`.

`publish_file` is the single supported file-presentation path for ChatGPT. After a file has been created, call `publish_file` with its path instead of reading it as Base64 or trying to manufacture an inline/image/resource-link response. MrMCP creates a temporary HTTPS URL in the tool's structured result and attaches its MCP App widget. The widget renders `image/*` files with an ordinary HTML `<img src="...">`; PDFs, archives, databases and other MIME types get a compact **Open File** action. Raw MCP `resource_link` and inline-Base64 preview modes are intentionally not exposed because the working ChatGPT presentation path is the attached widget. `exec` therefore does not have `return_files` shortcuts: create the output with `exec`, then call `publish_file` explicitly.

`publish_html` is the generic interactive-presentation path. The agent supplies a complete HTML document plus an optional title/height; MrMCP stores it in the `published_html` SQLite table and returns a persistent unguessable HTTPS URL, so the resource continues to work after a server restart. Its attached MCP App loads that URL inside a second iframe sandboxed with scripts, forms, modals and popup links enabled but without `allow-same-origin`, keeping the generated document isolated from the MCP App and ChatGPT host DOM; origin-dependent storage/cookie APIs may consequently be unavailable. Self-contained HTML/CSS/JavaScript is the portable choice. Remote images, fonts, scripts/modules, `fetch`/WebSocket calls and other network dependencies can depend on the current host's CSP/browser behavior and normal CORS rules, so agents should not assume external networking is portable. The entire MCP request, including the HTML string and JSON envelope, remains subject to MrMCP's current 2 MiB request-body limit.

Commands and persistent execution:

- `list_commands`;
- `exec`, `exec_start`, `exec_poll`, `exec_write`, `exec_kill`, `exec_list`;
- `js`, `js_add_node_module_dir`, `js_reset`.

`edit` accepts multiple files and multiple ordered exact edits per file. Each file is read once, its edits are applied sequentially in memory, every expected occurrence count is validated, and all files are written atomically with rollback.

Command execution tools (`exec`, `exec_start`, `exec_poll` and custom commands) return a terminal-like `output` stream by default. MrMCP appends chunks from stdout and stderr to that field in the order the two OS pipes are observed producing data, so the agent normally has one stream to read together with `status` and `exit_code`. Set `separate_streams: true` when the individual `stdout` and `stderr` streams are specifically useful; `exec_poll` uses `output_offset` for incremental reads of the combined stream. `exec_list` history exposes combined output only.

`query_tool_calls` reads only the supplied Session's `context_handle` history and excludes its own currently running call. `limit` defaults to 10 and is bounded to 1–50; `tool` and `status` are exact filters; `query` is a case-insensitive literal substring search across the complete stored log row; `before_id` returns only older stable log ids for backward pagination. Filters can be combined. The tool proves which requests reached MrMCP and shows their input, resolved result/output, status, timing and errors. A request rejected by a client/platform wrapper before MCP dispatch cannot be present, and MrMCP cannot expose an upstream reason code that was never delivered to the server.

`trash_paths` is the removal path for files and directories. It accepts explicit root-relative `paths`, an optional root-relative `glob`, or both. Each call creates `.mrmcp/trash/<action_id>/` plus sibling metadata `.mrmcp/trash/<action_id>.json` inside the selected Root; the action id is the local date/time to the second with `-2`, `-3`, ... added only on collision. `.mrmcp` is reserved metadata and is excluded from trash selections/globs. Nested selections are collapsed so moving a selected directory does not separately move its children. `untrash_action(action_id)` restores the whole action or restores nothing: it preflights every original target first and rolls back any moves if a restore step fails. MrMCP intentionally exposes no permanent filesystem-delete tool; removal is reversible through trash actions.

`glob`, `grep` and `replace` are intended to remove the need for improvised `uv`, Python or shell scripts during ordinary repository work:

- `glob` supports a start path, glob pattern, exclusions, hidden files, dependency directories and a result limit;
- `grep` supports literal or regular-expression matching, case sensitivity, globs, exclusions, context lines, hidden/dependency traversal, encoding selection, file-size limits and `content`, `files_with_matches` or `count` output;
- `replace` supports the same traversal controls, literal or regex replacements, preview mode, encoding/BOM/line-ending preservation, atomic rollback and an optional exact `expected_replacements` guard.

Every built-in tool publishes a strict tool-specific output schema. The only common field is `context_handle`; failed calls additionally use `isError: true` and an `error` string. Internal log identifiers and derived status flags are not exposed through tool results.

JavaScript kernels are created lazily and keyed by `(context_handle, root_id)`. Switching a Session to another root uses or creates that context-root kernel; switching back reuses its previous state. Different contexts never share JavaScript globals even when they use the same root.

Custom commands are described in `commands.yaml` and resolve below `.mrmcp/bin`. Executables found directly in that directory are also discoverable.

## Process environment

The setting **Include the system PATH in spawned processes and commands** is enabled by default.

- ON: `.mrmcp/bin` is prepended to the supplied or inherited system `PATH`.
- OFF: child processes receive only `.mrmcp/bin` in `PATH`.
- Other environment variables remain available.
- Shell expressions use `ComSpec` on Windows and `SHELL`, with `/bin/sh` as the Unix fallback.

## Text encoding and editing

Text tools support:

- UTF-8;
- UTF-16LE;
- UTF-16BE;
- Windows-1252;
- Latin-1;
- BOM preservation, insertion or removal;
- `LF`, `CRLF` and `CR` preservation or conversion.

Preferred editing order:

1. `edit` for one or more ordered exact edits per file and atomic multi-file changes;
2. `replace` for repeated literal or regular-expression replacements across files;
3. `write_file` / `write_files` for complete content;
4. `js` / `exec` only when the transformation genuinely requires parsing, computation or other programmatic logic.

## Administration interface

The interface contains:

- Dashboard;
- Clients;
- Sessions;
- Roots;
- Tool Calls;
- Commands;
- HTTP Log;
- Settings;
- Help.

Projects, Active calls, Custom tools and Approvals are intentionally absent. The Dashboard also exposes reversible-removal activity directly from completed Tool Call logs: separate Trash and Untrash cards show the completed-operation count plus the latest completion time, `action_id` and absolute trash path. For Untrash the displayed trash path is historical because a successful restore removes that action directory. Failed attempts do not increment either counter. The GUI header and favicon use the MrMCP balloon+folder brand mark; the native window title remains **🧩 MrMCP**. Emoji are limited to navigation, headings, principal actions, destructive actions and compact states.

### Deno-owned event-driven rendering model

The GUI has no polling timer, auto-refresh setting, browser-side data fetch loop or duplicate refresh path. Deno is the only owner of graphical state.

The backend keeps one ephemeral `uiState` object containing:

- the current section and per-section scroll positions;
- focus and selection information needed after a morph;
- the optional OAuth-client filter on Sessions;
- command search, page, page size and availability filter;
- Tool-call query, Session-PK/status filters, numbered page and expanded database primary key;
- HTTP-debug filters and expanded database primary key;
- active dialog, confirmation or message;
- in-progress Root, Command and Settings drafts;
- self-test output and the last processed browser-input sequence.

The WebView does not keep an application-state object and does not query administrative JSON endpoints. Its responsibilities are deliberately narrow:

1. delegate click, change, input, blur/focus, submit, keyboard, scroll and native drag/drop events;
2. serialize those events and send them to Deno over `/api/ui-input` WebSocket; the drag data carries only the numeric Session PK and never mutates visible DOM state;
3. receive complete server-rendered UI HTML over `/api/events` SSE;
4. apply the HTML to `#app` with Morphlex;
5. restore the scroll and focus values supplied by Deno.

Deno processes browser events sequentially. It updates `uiState`, executes database/filesystem/process actions, and schedules a render only when required. MCP calls, process changes, logs, OAuth changes, TLS changes and other backend subsystems use the same render scheduler.

Rendering is queued rather than performed synchronously inside the triggering operation. A short throttle coalesces bursts, only one render runs at a time, and additional requests received during a render cause one subsequent pass. Eta rendering uses its asynchronous API when available. When rendering completes, Deno broadcasts one `render` SSE event containing the full `#app` HTML and the authoritative scroll/focus metadata.

Eta chooses the active section with a conditional. `buildUiRenderModel()` queries only the data required by that section, then Eta renders the sidebar, active section, dialogs and section-specific rows. Inactive sections are neither rendered nor queried. Expanded Tool-call and HTTP rows are identified by their unique database primary key and are reconstructed by Eta after relevant backend events.

Native confirmation and alert state is not kept in the browser. Confirmations, errors and forms are represented in Deno `uiState`; Eta alone decides whether every Root, Command, Confirm or Message dialog exists and renders it with the `open` attribute. The browser never calls `showModal()` or otherwise opens/closes dialogs imperatively; a CSS overlay provides modal presentation and Escape is only transported back to Deno as a close intent. The browser may perform a local clipboard write and may use the native drag `DataTransfer` object transiently to carry a Session PK to a root drop target; neither operation carries persistent or graphical application state.

### Help

The Help page documents the current ChatGPT Web setup flow for a custom MCP app: enabling Developer mode, entering the remote HTTPS `/mcp` endpoint, authenticating (OAuth is the preferred ChatGPT path), scanning tools, understanding MrMCP's authenticated full-tool access model, and configuring write/modify action controls where the ChatGPT plan/workspace exposes them. As of this build, OpenAI documents full MCP write/modify support for Business, Enterprise and Edu, while Pro custom MCP access is limited to read/fetch; the Help page notes that availability can change. It also warns that model or thinking-level changes may result in a fresh MCP context.

### Tool-call log

The Tool Calls page supports:

- filter by numeric GUI Session PK and status;
- automatically apply the full-text query and every filter change without a Search button;
- numbered pagination above the table;
- complete timestamps with compact relative ages;
- compact rows without inline input/output JSON;
- Eta-rendered expanded details keyed by stable log database ids so Morphlex preserves row identity during live inserts;
- a Terminal block above MCP JSON only when the call result is actually process-like; ordinary filesystem, search and control tools do not render terminal chrome;
- terminal command/cwd plus the combined `output` stream, preferring live in-memory process output when available; process chunks enter the same coalesced Deno render queue so an expanded running call updates without polling; separately requested stdout/stderr remain available in MCP Result JSON;
- Terminate and Force controls only when cancellation is real.

## TLS and connectivity

MrMCP uses fixed public listeners:

- port 80 for ACME HTTP-01 challenges;
- port 443 for MCP, OAuth and metadata;
- loopback port 7332 for the administration UI.

The Settings and Dashboard pages display listener state, active certificate, validity, trust, expiry, ACME request history, backoff and next attempt. A valid certificate already stored in `.mrmcp` is reused.

## Development changelog

### 0.10.62

- Renamed the current `recent_tool_calls` tool to `query_tool_calls` with no compatibility alias, matching its role as a filterable history query rather than only a recent-items fetch.
- Kept `limit` at default 10 / maximum 50 and added combinable exact `tool`, exact `status`, case-insensitive literal `query` across the complete stored log record, and stable `before_id` backward pagination.
- Added Dashboard Trash and Untrash activity cards derived from completed Tool Call logs, showing total completed operations plus the latest completion time, action/folder id and absolute trash path; the Untrash path is explicitly historical after restoration.
- No SQLite schema change; the Dashboard derives this information from existing persistent Tool Call logs.

### 0.10.61

- Added `publish_html` for agent-generated interactive HTML/CSS/JavaScript, presented through its own MCP App widget and nested sandboxed iframe.
- Persisted published HTML in SQLite with an unguessable `/published-html/html_...` URL, so previously published content survives MrMCP restarts.
- Kept the nested document isolated by omitting `allow-same-origin`; scripts, forms, modals and popup links are available, while external network resources remain host/browser/CORS dependent and self-contained HTML is the portable default.
- Removed database schema versioning entirely: there is no `DB_SCHEMA_VERSION` or `PRAGMA user_version` startup gate. Additive tables/indexes are ensured with `IF NOT EXISTS`, while genuinely incompatible existing table shapes still fail on the actual required columns.

### 0.10.60

- Made the attached MCP App/Smart App widget the single supported `publish_file` presentation path in ChatGPT.
- Removed `return_mode=inline|link|both`, Base64 image payloads and raw MCP `resource_link` output from `publish_file`; the tool now returns one temporary HTTPS `uri` in `structuredContent` for the widget to consume.
- Updated the widget to render image MIME types through a normal HTML `<img src=uri>` and non-image files through an **Open File** action.
- Removed `exec.return_files*`; commands create files and `publish_file` presents them, so agents have one unambiguous delivery workflow.
- Bumped the widget resource URI to `ui://mrmcp/file-preview-v4.html` to avoid stale cached widget HTML.
- No SQLite schema change.

### 0.10.59

- Made all Root, Command, Confirm and Message dialogs fully Deno/Eta-owned: Eta renders `open`, the WebView no longer calls `showModal()`, and CSS supplies the modal overlay without browser-side dialog state.
- Moved Root and Command path validation from per-keystroke rendering to blur-time validation, preserving draft updates while typing and carrying the next focus target through the render pipeline so validation cannot steal focus/caret.
- Marked invalid named-root paths red in both Roots and Sessions, with the validation reason available as a tooltip.
- Simplified Roots drag/drop Session items: the first line now contains only Session id/client, while Created, Last Activity, Status and `Tool Calls: N` share one compact metadata row; generic OAuth text was removed.
- Moved reversible trash storage under each Root's reserved `.mrmcp/trash/` metadata directory instead of a top-level `.trash/` directory.
- No SQLite schema change.

### 0.10.58

- Fixed Roots Session cards so Created and Last Activity timestamps are preserved from the projection and rendered correctly.
- Added each Session's Tool Calls count to Roots assignment cards.
- Removed the redundant absolute program-folder path from the Default-root card; the existing explanatory text is sufficient.
- Root paths may now be absolute or relative. The exact entered string is stored in SQLite; relative roots are resolved against the program folder only at runtime when filesystem/process operations need an absolute path.
- Root path existence/type validation is now a live red warning beside the field and does not block saving an otherwise valid Root. Command path warnings use the same inline style and keep the dialog open instead of replacing it with a generic Error dialog.
- No SQLite schema change.

### 0.10.57

- Compiled the Windows standalone executable with Deno `--no-terminal`, so launching `mrmcp.exe` opens only the WebView and does not create a companion console window.
- Kept source-mode `deno run` unchanged so development and backend diagnostics can still use a normal terminal.
- No SQLite schema change.

### 0.10.56

- Added `recent_tool_calls`, scoped to the exact `context_handle`, so agents can inspect calls that actually reached MrMCP without querying SQLite; requests blocked upstream before MCP dispatch are necessarily absent.
- Made process `output` the default terminal-like stream, combining stdout and stderr in observed arrival order; `separate_streams: true` optionally adds the individual streams, and `exec_poll` supports a combined `output_offset`.
- Restricted Tool Call terminal rendering to process-like results and changed the terminal block to the combined output stream above MCP JSON.
- Normalized GUI page headings, action buttons and dialog titles to consistent Title Case, including **Tool Calls** and **HTTP Log**.
- No SQLite schema change.

### 0.10.55

- Clarified `exec`/`exec_start` argument-vector semantics: `args` is passed verbatim and in order, and agents should consult `--help` instead of rewriting uncertain CLI syntax.
- Clarified process output schemas so `stdout` and `stderr` are explicitly diagnostic outputs that should be read together with status and exit code.
- Added a terminal-style block above MCP JSON in expanded `exec`, `exec_start` and `exec_poll` Tool Call rows, showing command, cwd, stdout and stderr; live in-memory process output is preferred when available.
- Added stable DOM ids for Tool Call pagination, table, compact rows and expanded detail rows so Morphlex keys existing rows by database primary key instead of rematching them by table position during live inserts.
- No SQLite schema change.

### 0.10.54

- Began versioning the root `commands.yaml` catalog instead of leaving it hidden by the root ignore rule.
- Kept `commands.yaml` outside `assets/`: source mode edits the root file directly, while standalone builds embed it separately with `--include commands.yaml` only as a first-run template.
- On standalone backend startup, materialize the embedded `commands.yaml` beside the executable only when that physical file is absent; existing user edits are never overwritten.
- No SQLite schema change.

### 0.10.53

- Added reversible `trash_paths` for files, directories and glob selections. Each call stores one timestamped action below `.mrmcp/trash/` with a sibling JSON manifest and returns its `action_id`.
- Added `untrash_action(action_id)` with all-or-nothing restore semantics and rollback on a mid-restore failure.
- Kept trash actions intentionally simple: no hashes or redundant integrity metadata; MrMCP assumes `.mrmcp/trash` is managed only by MrMCP while retaining the preflight needed for transactional restore.
- `trash_paths` and `untrash_action` are not annotated as destructive because they move data reversibly; removed the permanent `delete_path` tool so filesystem removal is trash-only.
- No SQLite schema change.

### 0.10.52

- Moved GUI/browser resources into a single versioned `assets/` directory: Morphlex, SVG/PNG branding, the multi-resolution Windows ICO and the administration screenshot.
- Added authenticated `/assets/...` static serving that reads the same paths from disk under `deno run` and from Deno's virtual filesystem when `assets/` is embedded with `--include assets`.
- Removed the inline brand SVG/data URL from `mrmcp.js`; the GUI header and favicon now reference `assets/mrmcp-logo.svg`, while the native window title remains **🧩 MrMCP**.
- Moved README screenshots into `assets/` and kept them separate from the logo assets.
- Recompiled the Windows executable with `--include assets --icon assets/mrmcp.ico`.
- No SQLite schema change.

### 0.10.51

- Centralized Session root assignment on the Roots page: **📁 Roots** appear on the left with their associated Sessions, while **💬 Sessions / No root assigned** appears on the right; Session items show creation and last-access timestamps.
- Added bidirectional drag-and-drop assignment between the Default root and named roots, plus direct root-to-root reassignment; Deno remains authoritative and the browser transports only the Session PK and target root id.
- Removed the root selector from Sessions; the current root label and path remain visible there as read-only information.
- Updated the sidebar labels/order to **Clients**, **Sessions**, **Roots**, **Tool Calls**, **Commands**, **HTTP Log** and compacted the Commands table actions vertically.
- No SQLite schema change.

### 0.10.50

- Moved OAuth clients directly below Dashboard in the sidebar.
- Added a Session count to each OAuth client row and a **View sessions** action that opens Sessions filtered by that OAuth `client_id`; the filter remains visible until cleared.
- Changed GUI date formatting so timestamps from the current local day show only the time, while older/future dates keep their calendar date and existing relative-age suffixes remain unchanged.

### 0.10.49

- Added best-effort creation-client metadata to Sessions: authentication kind, OAuth client id/name when available, and User-Agent. Model and thinking/reasoning level are intentionally not inferred because MCP does not reliably expose them.
- Added a Sessions continuity notice explaining that changing ChatGPT model or thinking level may create a new MCP context even inside the same conversation.
- Added a Help section with ChatGPT Web Developer-mode, custom MCP app, OAuth, tool-scan and write-action setup guidance.
- Moved Tool calls directly below Sessions in the sidebar and retained the one-click per-Session filtered Tool-call view.
- Updated the clean SQLite table shape for creation-client metadata; incompatible development databases needed to be recreated.

### 0.10.48

- Added a numeric primary key to every GUI Session while preserving the opaque `ctx_...` capability for MCP protocol calls.
- Stored the Session PK on Tool-call and process rows so logs keep a stable short identifier even after a Session is deleted.
- Changed the Sessions table, Tool-call Session column and Session filter to show the numeric PK instead of the long handle or generic `context` label.
- Renamed the root-id-0 selector option to **Default root**.
- Removed the Tool-call Search button; text, Session, status and page-size filter changes now refresh automatically through the existing Deno-owned render pipeline.
- Updated the clean SQLite table shape for numeric Session and Tool-call identifiers.

### 0.10.47

- Reduced the public tool-result envelope to the required `context_handle` plus tool-specific fields.
- Removed redundant `context_status`, `operation_executed`, `retry_required`, `recovery_tool` and recovery `message` fields; errors now use `isError: true` and one `error` string.
- Removed public `execution_log_id` values while retaining complete internal administration logs.
- Removed `agent_guidance_present`; a nullable `agent_guidance_path` now expresses both presence and location.
- Replaced the internal GUI context status string with a direct `expired` boolean.
- Removed constant success flags and array-length duplicates from `create_directory`, `delete_path`, `glob`, `grep` and `replace` results.

### 0.10.46

- Replaced `get_cwd` with `context_info`, which returns the current absolute root and the optional root-level `AGENTS.md` / `agents.md` guidance path.
- Directed agents to call `context_info` after context creation and root changes, then read and follow `agent_guidance_path` when present.
- Added explicit tool-specific output schemas instead of one permissive generic result schema.
- Expanded `glob`, `grep` and `replace` with exclusions, hidden/dependency traversal, file-size and encoding controls; `replace` also gained an exact `expected_replacements` guard.
- Updated tool descriptions and server instructions to prefer structured file tools and avoid shell, `uv` or Python for covered operations.

### 0.10.45

- Replaced `server_opaque` with the public bearer capability `context_handle` and added `create_context`.
- Removed authenticated-client ownership from contexts, processes and JavaScript kernels; possession of a valid handle selects the context after authentication.
- Replaced the MCP `workspace` tool with the minimal `get_cwd` tool. Root assignment remains exclusively in the Sessions/Roots administration UI.
- Made each context reference exactly one current `root_id`, freely reassignable; a root may serve many contexts and existing processes are left untouched when the assignment changes.
- Scoped lazy persistent JavaScript kernels by context and root.
- Replaced `list_files`, `search_files`, `edit_file`, `edit_files` and `replace_files` with `glob`, `grep`, `edit` and `replace`.
- Fixed multi-edit semantics: ordered edits for the same file are now applied to one in-memory document and all files are committed atomically with rollback.
- Added root snapshots to tool-call and process logs and updated the corresponding clean SQLite table shapes.

### 0.10.43

- Expanded `AGENTS.md` with the full UI-state design rationale and failure mode that motivated the architecture.
- Made explicit that every visible state transition, including navigation and row expansion, is Deno-owned and Eta-rendered.
- Documented normalized user/backend event handling, primary-key-based expanded rows, lazy section-scoped queries and the single throttled asynchronous render queue.
- Added release checks that reject imperative browser UI state and inactive-section data loading.

### 0.10.42

- Moved every ephemeral graphical state value from the WebView into the Deno backend.
- Replaced browser-side `globalThis.mrmcpUiState`, `/api/state` and `/api/render` calls with a WebSocket input channel and an SSE HTML output channel.
- Added a single sequential Deno input dispatcher for navigation, forms, filters, pagination, expanded rows, dialogs, focus and scroll.
- Added a throttled/coalescing asynchronous render queue; backend and MCP events use the same queue.
- Changed the WebView into a thin event sender and Morphlex HTML receiver.
- Made confirmations and error messages server-owned Eta dialogs.

### 0.10.41

- Added a real global ephemeral UI state object.
- Restored the missing unified `dispatchUiEvent` implementation that prevented sidebar navigation.
- Moved current section, filters, pages, expanded row primary keys, dialogs and self-test output into the state object.
- Eta now conditionally renders only the current section; Morphlex applies every UI transition.
- Added section-specific server projections so inactive pages do not query their tables.
- Moved expanded Tool call and HTTP details from imperative DOM insertion into Eta templates.
- Expanded README and AGENTS documentation, including the MCP 2026-07-28 stateless rationale.

### 0.10.40

- Added a restrained emoji vocabulary for faster visual scanning.

### 0.10.39

- Removed experimental root drag-and-drop and diagnostics.
- Restored conventional root creation, editing, enable/disable and deletion.

### 0.10.38

- Reduced the initial desktop window to 1180×760.

### 0.10.37

- Standardized visible branding as **MrMCP** and added the 🧩 header/window icon.

### 0.10.36

- Replaced GUI polling with SSE-driven Eta → Morphlex updates.

### 0.10.35

- Renamed the operator view to Sessions.
- Removed the global default-root option; unassigned values use the `mrmcp.js` directory.

### 0.10.34

- Returned the desktop launcher to direct `@webview/webview` after superseded Tauri and Neutralino experiments.

### 0.10.32–0.10.33 — superseded experiments

- Explored Neutralino-based desktop shells; fully removed in 0.10.34.

### 0.10.29 — superseded experiment

- Explored a Tauri v2 desktop shell; fully removed in 0.10.34.

### 0.10.30–0.10.31

- Replaced transport-derived session identity with explicit tool arguments for the stateless protocol.
- Stabilized the final field name as `context_handle` and removed “context” terminology from agent-facing schemas.

### 0.10.28

- Removed tool-call approvals and every associated queue, state and database field.
- Removed `allow_re` and `deny_re`; authentication became the only tool-access boundary.

### 0.10.27

- Added session-oriented administration, root assignment, tool-call pagination and termination controls.
- Added encoding, BOM and line-ending controls to text tools.
- Added the system-PATH process setting.

### 0.10.24–0.10.26

- Added relative ages beside log timestamps.
- Consolidated to one `/mcp` endpoint.
- Introduced early session/root and event-log improvements that were later adapted to explicit opaque handles.
