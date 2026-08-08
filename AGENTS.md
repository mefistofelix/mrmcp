# MrMCP implementation guide

## Current release and files

MrMCP 0.10.80 consists of four root project files plus one versioned asset directory:

- `mrmcp.js` — Deno backend, MCP `2026-07-28`, OAuth/Basic authentication, SQLite, loopback UI and WebView launcher.
- `commands.yaml` — versioned editable extra-command catalog; keep it in the repository root, never under `assets/`.
- `README.md` — complete user/operator behavior and development changelog.
- `AGENTS.md` — implementation invariants and release checks.
- `assets/` — all static WebView/build assets, including `morphlex.js`, `mrmcp-logo.svg`, `mrmcp-logo.png`, `mrmcp.ico` and the numbered administration screenshots; do not duplicate them in the repository root.

The only public MCP protocol endpoint is `/mcp`. The public HTTPS listener also serves the read-only unauthenticated `/mrmcp-icon.png` branding asset referenced by MCP `serverInfo.icons`. The administration UI is loopback-only and starts from base port `127.0.0.1:7332`, using runtime `+50` fallback when that port is occupied.

## Desktop shell

Use only the direct Deno import `jsr:@webview/webview@0.9.0`.

- Do not add Tauri, Rust, Neutralinojs, Node.js, npm, a CLI or a scaffold project.
- Desktop mode is one OS process: the WebView stays on the main thread and the backend runs in a named Deno Worker/isolate loaded from the same `mrmcp.js`. Readiness and shutdown use typed Worker messages (`ready`, `shutdown`, `stopped`), not stdout parsing or a child process. Closing the WebView requests graceful backend shutdown and then terminates the Worker only as a bounded fallback. Worker wait timeouts must clear their timers when readiness/shutdown wins; after desktop cleanup completes, the main entrypoint exits explicitly so FFI or other residual handles cannot keep `mrmcp.exe` resident.
- The initial desktop size is 1180×760.
- Windows standalone builds must use both `deno compile --no-terminal` and `--icon assets/mrmcp.ico` so the compiled desktop application opens only the WebView, has the MrMCP executable icon and does not create a companion console window. Never omit either flag from release builds. Do not add runtime console-hiding code; source-mode `deno run` remains terminal-attached for development.
- Do not add a native tray or drag-and-drop bridge unless explicitly requested.
- Keep WebView/static resources in `assets/`; normal `/assets/...` GUI routes remain authenticated. The only public branding exception is exact HTTPS `GET /mrmcp-icon.png`, backed by `assets/mrmcp-logo.png`, so MCP clients can fetch `serverInfo.icons` without credentials. Source mode reads assets from disk; standalone builds embed them with `deno compile --include assets` so the same files resolve from Deno's virtual filesystem.
- Keep `commands.yaml` in the repository root, not `assets/`. Source mode reads/writes that physical file directly. Standalone builds must additionally compile with `--include commands.yaml`; treat the embedded copy only as a first-run template and materialize it beside the executable if the physical file is absent. Never overwrite an existing user-edited `commands.yaml` from the VFS template.
- Keep root records conventional: logical name, user-entered path, enabled state, edit and delete. Root paths may be absolute or relative; store the entered path string unchanged in SQLite and resolve relative values against `APP_DIR` only when an operation actually needs an absolute root. Validate Root/Command path existence/type on blur, never on every input keystroke. Invalid named-root paths must render red wherever that Root path is shown administratively. Session-to-root assignment belongs on the Roots page through server-routed drag/drop; do not put a root selector back on Sessions. The Roots assignment view labels the left column **Roots** and the right column **Sessions / No root assigned**. Session drag items keep Session id/client on the first line and Created, Last Activity, Status and `Tool Calls: N` together underneath; do not repeat generic OAuth/auth-kind text there. The Default-root card explains that it uses the program folder but does not print the absolute program-folder path.

## Database: direct current schema, no versioning

The repository is in development. There is no backward-compatibility layer and there is no database schema-version concept.

1. Do not introduce `DB_SCHEMA_VERSION`, `PRAGMA user_version` checks or any equivalent version gate.
2. Ensure current tables and indexes directly at startup with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`; additive structures must become available automatically on an existing database.
3. Never add `ALTER TABLE`, migration code, backfills or old-column detection.
4. Keep required-column checks tied to structures the current code actually needs; if an existing table has an incompatible shape, fail on that shape and tell developers to recreate `.mrmcp/mrmcp.sqlite`.
5. Never import legacy configuration keys or identifiers.
6. Never retain an old table or column only for compatibility.
7. Never accept legacy `opaque_` values, `server_opaque` arguments or transport-derived session identifiers.
8. A clean schema must create no named `default` root.
9. `contexts.id` is the numeric administrative primary key; `contexts.handle` remains the unique opaque bearer capability. Tool-call and process rows retain both `context_id` and `context_handle` snapshots. Context rows may also retain observational creation-client metadata (`auth_kind`, OAuth client id/name and User-Agent); that metadata never owns or authorizes the context.
10. Settings **Clear Operational Data** is a history/data cleanup, not a configuration reset: preserve `config`, `server_config`, `custom_tools`, all OAuth tables, `roots` and `contexts`; clear `logs` plus `logs_fts`, `process_runs`, `debug_logs` and `published_html`, reset metrics, and reset only the cleared log-table sequences. Dashboard **Empty Trash** permanently removes only the contents of `.mrmcp/trash` under the program folder and every configured Root. Both maintenance actions use one Promise barrier rather than an application queue: new Tool Calls wait, already in-flight Tool Calls finish, maintenance runs, then waiting Tool Calls continue. Managed processes already detached from a completed `exec_start` call do not count as in-flight Tool Calls. Maintenance dialogs are confirmation-only: after Confirm they close immediately and no completion dialog appears. Only the confirmed action button renders the spinner plus live in-flight/waiting counts from Deno-owned state, then returns to its normal label when maintenance finishes; the other maintenance button may be disabled but must keep its normal label. Dashboard always exposes the current `activeCallControls.size` as Tool Calls In Flight. Do not add browser polling or a browser-owned countdown. Clear Operational Data must not delete certificates, command files/catalog data, trash contents or other filesystem state; Empty Trash must not delete anything outside the managed trash directories.

## MCP 2026-07-28 and explicit context capabilities

Only protocol `2026-07-28` is advertised and accepted.

The protocol is stateless and sessionless at the transport layer:

- use `server/discover`;
- do not implement a successful legacy `initialize` path;
- do not advertise older protocol versions;
- do not send, consume or infer identity from `Mcp-Session-Id` or vendor session headers;
- every request must be understandable without a previous transport handshake.

Application state uses an explicit bearer capability:

- `create_context` is the only tool without a `context_handle` input and creates a globally unique `ctx_...` value;
- every other base and custom tool requires the same `context_handle` property;
- every output schema requires only `context_handle` as common metadata;
- every built-in tool must add an explicit tool-specific output schema and use `additionalProperties: false`; never regress to one permissive generic result schema;
- failed calls set `isError: true` and expose one human-readable `error` string; do not add duplicate status, execution, retry, recovery-tool or log-id fields;
- missing, invalid or expired handles never execute the requested operation and never mint a replacement automatically;
- valid handles execute and are repeated byte-for-byte in the result;
- contexts expire after 30 days without activity.

Authentication gates access to the server. After authentication, possession of a valid `context_handle` selects the context. Do not bind contexts, managed processes or JavaScript kernels to an OAuth client, Basic credential, owner key or transport identity.

The GUI label **Sessions** is operator terminology only. Never describe `context_handle` as a protocol or transport session. Session client metadata is best-effort observational information captured at context creation; do not infer a model, reasoning/thinking level or client ownership from it. A ChatGPT model or thinking-level change may result in a new context even inside the same chat.

## Authentication and authorization

Authentication is the only server-access decision.

- Authenticated clients receive all published tools.
- Anonymous clients receive none.
- Do not implement tool approvals, allow/deny regular expressions, enable lists, execution switches or per-tool policy rules.
- OAuth consent remains only to authorize the OAuth client.
- The public OAuth consent/error page must remain client-agnostic and server-rendered with the same Eta instance used by the administration UI. Dynamic client, scope, resource, redirect and hidden-form values go through Eta auto-escaping; do not rebuild the page with interpolated HTML strings or client-specific copy. Keep it as a compact centered one-screen card using the administration GUI dark palette, with compact client/scope/resource/return rows, green **Authorize Access**, red **Cancel**, matching branded invalid/expired state, and the direct standards-compliant redirect to the registered client callback after the decision. Size the card, typography, logo, spacing and actions from viewport-relative `vw`/`vh`/`vmin` units rather than fixed pixels, constrain the document to the viewport, and keep all details and both actions visible without scrolling in a normal desktop viewport; do not add a separate trust-notice block.
- `context_handle` is a bearer capability shared by any authenticated client that possesses it.

## Roots and current working directory

The GUI maintains named roots. A root may be assigned to many contexts, while each context stores exactly one current `root_id`.

- Root id `0` is the fallback directory containing `mrmcp.js`.
- New contexts start on root id `0`.
- Root assignment is managed only in the Roots GUI. Sessions shows the current root label/path read-only. Named-root paths shown in administrative UI remain in their stored form; `context_info` and actual filesystem/process execution resolve them to absolute paths only when needed.
- The public MCP tool is `context_info`, which returns the absolute current root and nullable `agent_guidance_path`; the path itself expresses whether guidance is present.
- `context_info` checks only the selected root's `AGENTS.md`, then `agents.md`; it returns an absolute path and never scans parent or child directories.
- Tool/server descriptions must direct the agent to call `context_info` after `create_context` and root changes, then read and follow `agent_guidance_path` when non-null.
- Changing a context root is unrestricted and affects new calls immediately.
- Existing background and interactive processes continue with their original working directory.
- Disabling or deleting a root moves associated contexts to root id `0` without terminating processes.
- Resolve the context and root once at the start of each call and use that fixed selection for the whole operation.

All relative paths and new child-process working directories must remain inside the selected root.

JavaScript kernels are lazy and keyed by `(server_id, context_handle, root_id)`. Switching roots selects or creates the matching kernel; switching back restores its previous state. Never share a kernel between different contexts.

## GUI architecture

Keep these sections:

- Dashboard;
- Clients;
- Sessions;
- Roots;
- Tool Calls;
- Commands;
- HTTP Log;
- Settings;
- Help.

Do not reintroduce Projects, Active calls, Custom tools or Approvals pages. Use emoji sparingly on navigation, headings, principal actions, destructive actions and state summaries; do not decorate technical values or every cell.

### UI design rationale and non-negotiable state model

The GUI uses one simple server-owned state machine. This rule exists because a previous unified-event refactor left sidebar clicks unable to change section: events were emitted, but there was no authoritative state transition and no guaranteed render path. Do not solve this class of problem with imperative DOM patches.

Every value that can change what the operator sees is graphical state and belongs to Deno, including apparently small values such as:

- the current sidebar section;
- which Tool-call or HTTP-log row is expanded;
- current filters, page number and page size;
- open/closed dialogs, confirmation targets and validation messages;
- form drafts, selected values, focus/selection metadata and per-section scroll positions;
- temporary outputs such as self-test results and live/reconnecting state.

Use stable identifiers for state that points at persistent data. An expanded row is stored as its database primary key, never as a row index, table position, DOM id derived from position or copied row object. This lets Eta reconstruct the same visible state after unrelated MCP, process or log activity.

The authoritative flow is always:

1. The WebView observes a user input and sends a normalized event envelope to Deno.
2. Deno validates and processes the event sequentially.
3. Deno updates `uiState` where required and performs database, filesystem, process, TLS, OAuth or command work.
4. Deno marks the UI dirty instead of rendering synchronously in the mutation path.
5. The render scheduler coalesces/throttles bursts and asynchronously builds the active view with Eta.
6. Deno sends the completed HTML plus restoration metadata over SSE.
7. The WebView applies that HTML through Morphlex and restores only the focus/scroll information supplied by Deno.

The same path applies to non-user events. A new MCP tool call, a log row, process output/completion, a root change, OAuth mutation, certificate update or settings change must update backend state/data and enqueue the same render pipeline. There must not be a separate “automatic refresh” implementation.

Eta is responsible for conditional UI composition. It selects the visible section from `uiState.currentSection` with ordinary conditionals and renders only that section. Data access must be lazy and section-scoped: the projection or helper for Tool calls queries Tool-call data only while Tool calls is active; HTTP-debug data is queried only while HTTP debug is active; the same rule applies to every section. Do not preload every page merely because a full `#app` HTML fragment will be sent.

The WebView is deliberately not a second application runtime. It must not decide what section is active, toggle expanded rows locally, retain dialog state, fetch business data, or patch UI state with `classList`, `hidden`, injected rows or hand-built HTML. Apart from transport bookkeeping and applying Morphlex output, visible changes originate from Deno-rendered Eta HTML.

If a new interaction appears to require browser-local state, first add an explicit field to Deno `uiState` and route the interaction through the normalized input dispatcher. Exceptions require a concrete technical reason and must be documented here.

### Deno owns all ephemeral UI state

The WebView must not own an application-state object. Do not add `globalThis.mrmcpUiState`, browser-side section state, browser-side pagination state, browser-side expanded-row state or browser-side dialog state.

Deno owns one ephemeral `uiState` object containing at least:

- `currentSection` and per-section scroll positions;
- focus/selection metadata;
- the optional Sessions OAuth-client filter;
- command filters and pagination;
- Tool-call query, Session-PK/status filters, pagination, self-test output and expanded log primary key;
- HTTP-debug filters and expanded row primary key;
- Root, Command and Settings drafts;
- active confirmation/message/form dialog;
- the last processed input sequence.

Database primary keys identify expanded rows. Never use a row index or DOM position.

### Thin WebView transport

The embedded browser has only transport and DOM-application responsibilities:

1. delegate user events;
2. serialize them to `/api/ui-input` over WebSocket;
3. receive `render` events from `/api/events` over SSE;
4. morph the complete `#app` HTML using Morphlex;
5. apply scroll/focus metadata sent by Deno.

The browser must not call `/api/state`, `/api/render` or section-specific JSON endpoints. It must not execute database, filesystem, process, TLS, OAuth or command business logic. Local clipboard writes are allowed because they carry no persistent or graphical application state. Native drag `DataTransfer` may transiently carry only a numeric Session PK to a server-rendered root drop target; it must not add/remove classes, move nodes, retain assignment state or otherwise alter visible UI locally.

### One backend input and render pipeline

Deno processes WebView inputs sequentially. The dispatcher updates `uiState`, performs the requested backend action and queues a render when required. Backend-originated changes from MCP calls, logs, managed processes, Roots, OAuth, TLS, settings and commands enter the same queue through `emitUiChange`.

Rendering must not occur synchronously in mutation paths:

- use a short throttle to coalesce bursts;
- permit only one render at a time;
- if another event arrives during rendering, perform one subsequent pass;
- yield before expensive work;
- use Eta asynchronous rendering when available;
- broadcast the completed full `#app` HTML through SSE.

Do not add interval polling, refresh timers, auto-refresh controls, manual refresh paths or multiple independent render queues.

### Selective rendering and data access

Eta selects the active section from Deno `uiState.currentSection`. `buildUiRenderModel()` may query only the current section’s data:

- Dashboard: endpoint summary and aggregates, including Trash/Untrash activity derived from completed Tool Call logs.
- Sessions: contexts and their single current root, optionally filtered by stored OAuth client id; root information is read-only.
- Roots: root records plus the minimal context rows required to group Sessions by current `root_id` and render the Default-root bucket.
- Commands: command catalog page only.
- Tool calls: context filter values, paginated rows and at most one selected detail row.
- HTTP debug: setting, filtered rows and at most one selected detail row.
- OAuth: OAuth clients plus context counts and lifecycle timestamps derived from existing client/token/context tables: client creation, first/last Session creation, latest access-token issue and latest refresh-token use.
- Settings: runtime settings only.
- Help: static operator guidance plus the already-available settings projection; no section-specific database query.

Inactive sections must neither render nor query their tables. Sidebar selection, expanded rows, dialogs, confirmations and drafts are all Eta output derived from Deno state.

### Dialogs and drafts

Root, Command, Settings, confirmation and message state belongs to Deno. Input events update the corresponding server draft even when no immediate render is needed, so an unrelated MCP/SSE update cannot erase partially entered values. Root/Command path checks run only on blur; the blur event must carry the next focus target (or explicit null) so a validation render cannot steal focus. Confirmations and errors must be Eta-rendered dialogs, not browser `confirm()` or `alert()` calls. For every managed dialog kind, Eta owns open/closed state and renders the `open` attribute from `uiState.dialog`; never call `showModal()`/`show()` or close a dialog imperatively in browser JavaScript. Use server-rendered markup plus CSS overlay for modal presentation; Escape may only send a close intent back to Deno.

## Tool-call UI

- Display and filter by the numeric operator Session primary key, never the long `context_handle` or generic context label.
- Apply text, Session, status and page-size filter changes automatically through Deno-owned state; do not add a Tool-call Search button or a second refresh path.
- Give Tool Call pagination, the table, every compact row and every expanded detail row stable DOM ids derived from the log database primary key so Morphlex preserves row identity when new calls are inserted ahead of existing rows.
- Show terminal chrome only when the selected Tool Call has an actual process-like result (managed exec-family calls or custom commands carrying process command/output data); filesystem, search and control calls must not show an empty terminal section.
- Process-like expanded rows show command/cwd, optional input `stdin` in its dedicated panel, then the combined terminal `output` block before MCP input/result JSON; label base64 stdin without decoding it for display, and prefer live managed-process output when the linked process is still in memory. Normalize stdout/stderr before buffering or storage: strip ANSI/OSC/control sequences and preserve standalone carriage-return progress updates as separate lines rather than overwriting prior text. Do not retain a second raw process-output copy or expose a raw-output option. Every process-output chunk marks the Tool Calls scope dirty through the normal coalesced render queue; do not add polling. Separately requested stdout/stderr belong in MCP Result JSON, not duplicated in the terminal block.
- Use numbered pagination above the table.
- Keep input/output JSON out of compact rows.
- Render details only for the selected primary key.
- Show Terminate/Force controls only for genuinely cancellable work.
- Display complete timestamps plus compact relative ages.
- Keep `failed` and `invalid` semantically distinct. `failed` is red and represents an accepted call that failed during execution or an execution-level rejection; `invalid` is purple and represents a request that reached MrMCP but was rejected before tool execution by MCP protocol, tool-name, context or input-schema validation. The Tool Calls status filter and the compact header must expose `invalid`; the header count is clickable through the same Deno-owned navigation/filter path as running/failed.
- Keep published tool input schemas strict. Never relax `additionalProperties`, required fields, types or bounds merely to observe bad clients. Mirror the published input schema server-side before execution so a client that dispatches an invalid call anyway is logged as `invalid` and not executed. Preserve the received input, exact validation message and the MCP/JSON-RPC result returned to that client where a response body exists.

## Processes and PATH

The system-PATH setting is enabled by default.

- `exec` and `exec_start` must describe `args` as the exact ordered argv passed verbatim to the executable; agents should consult the command's `--help` rather than reinterpret uncertain option syntax.
- `exec`, `exec_start`, `exec_poll` and custom-command result schemas expose one combined terminal-like `output` stream by default and tell agents to read it with status/exit code. Append stdout/stderr chunks in the order MrMCP observes them arriving from the two OS pipes. `separate_streams: true` optionally adds the individual streams; `exec_poll` uses `output_offset` for the combined stream and stream-specific offsets only when separation is requested. `exec_list` history remains combined-only.
- ON: prepend `.mrmcp/bin` to the supplied or inherited `PATH`.
- OFF: use only `.mrmcp/bin` in the child `PATH`.
- Use `ComSpec` on Windows and `SHELL` or `/bin/sh` on Unix.
- On Windows, spawn managed `exec` / `exec_start` children through `node:child_process.spawn` with `windowsHide: true` and adapt Node stdio streams to the existing Web Stream process pipeline. Do not regress to a spawn path that flashes a console window or steals WebView focus. Non-Windows managed processes may continue to use `Deno.Command`.
- Managed termination must use the runtime child-process `kill()` API directly. Do not spawn `taskkill`, `kill`, `pkill` or another platform helper and do not claim portable recursive process-tree termination: Deno/Node core provides no cross-platform tree-kill API. `SIGTERM` and `SIGKILL` remain distinct requests on Unix; on Windows Node may terminate the direct child without Unix signal semantics. Parent exit must still release a foreground MCP response after the bounded output-drain path even when descendants retain inherited handles.
- Explicit GUI/`exec_kill` termination uses `termination_source: "user"`; timeout and server-shutdown requests use `timeout` and `server`, while an externally observable termination uses `external`. Keep `requested_signal` distinct from the actually observed `signal`; do not invent an observed signal when Windows reports none.
- Keep managed process access scoped to the exact `context_handle`; retain the root and cwd snapshot captured at process start.
- `query_tool_calls` is read-only and scoped to the exact `context_handle`. It returns only calls that reached MrMCP and excludes its own currently running log row. Keep `limit` bounded to 1–50 with default 10; `tool` and `status` are exact filters including `invalid`, `query` is a case-insensitive literal substring search across the complete stored log row, and `before_id` is the stable backward-pagination cursor. Filters are combinable. Use it to distinguish server-side execution/validation from upstream/client-wrapper rejection; never claim it can reveal a wrapper policy reason that was not sent to MrMCP.

## Published files/HTML and MCP App widgets

`publish_file` is the only supported path for presenting generated/existing files to ChatGPT users. Keep the contract deliberately singular:

- the tool creates one temporary HTTPS download URL and returns it as `structuredContent.uri`;
- the `publish_file` descriptor attaches the MCP App/Smart App output template;
- the widget reads `structuredContent.uri` directly; it must not depend on MCP `resource_link` content;
- image MIME types are displayed by the widget with a normal HTML `<img src="...">`; non-image MIME types get an **Open File** action;
- do not emit Base64 image content and do not reintroduce `return_mode=inline|link|both`;
- do not add `exec.return_files*` shortcuts: a command creates a file, then the agent explicitly calls `publish_file` so the correct widget is attached to the correct tool result;
- tool descriptions must tell agents to call `publish_file` directly rather than reading binary files, Base64-encoding them or constructing alternate preview payloads.

`publish_html` is the generic agent-generated UI path:

- persist every published document in the `published_html` SQLite table with a random unguessable id, title, HTML, requested height, context handle and creation time; it must survive server restarts;
- return a persistent HTTPS `/published-html/<id>` URL in `structuredContent.uri` and attach the dedicated versioned `HTML_PREVIEW_UI_URI` MCP App template;
- the outer MCP App declares the MrMCP public origin in `frameDomains` and loads the persisted document in a nested iframe;
- the nested iframe may allow scripts, forms, modals and popup links, but must never add `allow-same-origin`; generated HTML must not gain access to the MCP App or host DOM;
- do not impose a MrMCP CSP on the persisted HTML response. Self-contained HTML/CSS/JavaScript is the portable default; external resources/network calls remain host/browser/CSP/CORS dependent and tool descriptions must say so explicitly rather than treating the current ChatGPT “CSP disabled” state as a contract;
- the normal MCP request-body limit bounds the HTML input; do not add a separate alternate transport unless there is a concrete need.

Both widget resource URIs are versioned when their HTML/behavior changes so clients do not reuse stale cached widget markup.

## Text-editing tools

Support UTF-8, UTF-16LE, UTF-16BE, Windows-1252 and Latin-1, including BOM and `LF`/`CRLF`/`CR` controls.

Prefer:

1. `glob` and `grep` for discovery and search;
2. `edit` for ordered exact edits per file and atomic changes across files;
3. `replace` for repeated literal or regex changes across a glob;
4. `write_file` / `write_files` for complete content;
5. `js` / `exec` only for parsing, computation or transformations that cannot be expressed by the structured tools.

Do not invoke shell commands, `uv` or Python to list, search, inspect, edit or replace files when the structured MrMCP tools cover the operation. Tool descriptions and `server/discover` instructions must reinforce this precedence.

`glob` must support exclusions plus explicit hidden/dependency traversal. `grep` must additionally support literal/regex matching, case sensitivity, context lines, encoding, file-size limits and content/file/count modes. `replace` must support the same traversal controls, preview mode, atomic rollback and an optional exact `expected_replacements` total.

`edit` must read each file once, apply its edit list sequentially to the evolving in-memory text, validate each `expected_occurrences`, write each file once, and roll back all files if any write fails. Duplicate file entries are invalid.

Preserve source encoding, BOM and line endings unless conversion is explicitly requested.

Filesystem removal is trash-only; do not reintroduce a permanent delete tool. `trash_paths` accepts explicit paths and/or one glob, supports files and directories, collapses nested selections, and moves each action under the selected Root's reserved `.mrmcp/trash/<action_id>/` with sibling `.mrmcp/trash/<action_id>.json`. Never create a top-level `.trash` directory. Exclude the entire `.mrmcp` metadata directory from explicit trash targets and trash globs. Action ids use local date/time to the second with an incrementing numeric suffix only on collision. The manifest stays minimal (`action_id`, creation time and original paths); do not add hashes or redundant integrity metadata. Assume `.mrmcp/trash` is managed by MrMCP, but keep the preflight required to guarantee `untrash_action` restores the entire action or nothing and rolls back any mid-restore moves. Neither `trash_paths` nor `untrash_action` is destructive; do not add them to `destructiveHint`. Dashboard Trash/Untrash counters and latest-action details must be derived from completed persistent Tool Call logs rather than duplicated into another table; failed attempts do not count, and a successful Untrash displays its reconstructed trash path as historical because the action directory has been removed.

## Documentation requirements

README must describe current behavior, not only past changes. It must include:

- startup and files;
- protocol rationale and explicit context capability lifecycle;
- the distinction between GUI Sessions and protocol sessions;
- authentication and database policy;
- roots, commands, processes, text encoding and TLS;
- the event-driven UI and ephemeral state model;
- a development changelog, with reverted architecture experiments clearly marked as superseded.

Update README, AGENTS, the source header and `VERSION` together for every release. The release commit itself must use the explicit Git commit message `release X.Y.Z` matching the version/tag being published; do not use a generic or unrelated commit message for a release. Invoke Git/GitHub CLI through MrMCP `exec` with `program` + `args`; never add a `shell` boolean/field, because it is not part of the tool schema. After creating the release tag, prefer one direct combined push with `git push origin main X.Y.Z`; this exact form is valid and verified. Split branch/tag pushes only when Git itself returns an execution error, not when a tool invocation was rejected before reaching MrMCP.

## Release checks

1. Syntax-check `mrmcp.js` as an ES module.
2. Extract and syntax-check the embedded browser module and JavaScript worker.
3. Compile/render every Eta fragment with representative data, including all nine sections and every dialog kind.
4. Verify sidebar input travels over WebSocket, changes Deno `uiState.currentSection`, queues a render and produces SSE HTML.
5. Verify the browser bundle contains no application-state object, business logic or administrative JSON fetches.
6. Verify expanded Tool-call and HTTP rows survive relevant backend renders by database primary key.
7. Verify `buildUiRenderModel()` queries only the active section.
8. Verify input events update Deno drafts before unrelated backend renders.
9. Verify the render queue coalesces bursts, never renders concurrently and performs a follow-up pass when dirtied during rendering.
10. Build/open SQLite state and verify current required tables/indexes are ensured without any `DB_SCHEMA_VERSION`/`PRAGMA user_version` gate; additive tables must appear on an existing compatible database.
11. Confirm no migrations, `ALTER TABLE`, legacy identifiers or old configuration imports exist.
12. Confirm only MCP `2026-07-28` is advertised and no transport-session headers are used.
13. Confirm missing/valid/invalid/expired context-handle paths do or do not execute exactly as documented.
14. Confirm no approval, `allow_re`, `deny_re` or tool-enable policy remains.
15. Confirm no UI polling interval, auto-refresh control or manual refresh path exists; Tool-call filters must update through the single Deno render queue.
16. Confirm backend log, context, root, process, debug, OAuth, settings and TLS mutations enter the same Deno render queue.
17. Confirm every visible open/close/select/navigation transition is represented in Deno `uiState` and is produced by Eta, not by an imperative browser DOM mutation.
18. Confirm expanded-row state uses database primary keys and remains correct when pagination or new rows change table order.
19. Confirm inactive sections perform no section-specific database queries during a render.
20. Confirm the WebView only sends normalized input envelopes (including blur with the next focus target), receives SSE renders, invokes Morphlex and restores Deno-supplied focus/scroll metadata.
21. Confirm `context_info` returns the current absolute root and the root-level `AGENTS.md` / `agents.md` path when present, and returns `null` when absent.
22. Confirm every built-in tool exposes a strict tool-specific output schema layered on the common context envelope.
23. Confirm `glob`, `grep` and `replace` implement every documented traversal, exclusion, encoding, size-limit and expected-count argument without shell, `uv` or Python helpers.
24. Confirm published tool input schemas remain strict and unchanged by diagnostic logging; an invalid call that does reach `/mcp` must be rejected before execution, stored with status `invalid`, retain its input/error/result, render purple, and be reachable from both the Tool Calls status filter and the clickable header invalid count.
24. Confirm no Tauri, Rust, Neutralinojs, npm project or CLI files exist.
25. Confirm Session rows, Tool-call rows and the Tool-call Session filter use `contexts.id` / `logs.context_id`, while MCP requests still use the opaque handle.
26. Confirm OAuth client rows count `contexts.oauth_client_id` matches and their View sessions action opens Sessions with that client filter; clearing the filter restores all Sessions.
27. Confirm current-day GUI timestamps omit the calendar date while preserving time and any relative-age suffix.
28. Confirm the Roots page groups Sessions by `root_id`, labels the right-hand root-id-0 group **Sessions / No root assigned**, renders Session id/client alone on the first drag-item line and Created, Last Activity, Status and `Tool Calls: N` together underneath without generic OAuth/auth-kind text, omits the absolute program-folder path from the Default-root card, accepts native drag/drop to named roots or root id `0`, routes the assignment through Deno, and the Sessions page has no root selector. Confirm named-root paths preserve the exact stored absolute/relative string in the GUI while runtime operations resolve relative values against `APP_DIR`, and invalid named-root paths render red in both Roots and Sessions.
29. Confirm browser drag handling only transports the numeric Session PK/target root and performs no imperative visible DOM mutation.
30. Confirm the archive contains exactly the four root project files plus the versioned `assets/` directory, with Morphlex and all branding/static files there and no duplicate assets in the root; `commands.yaml` remains a root configuration file, not an asset.
31. Confirm standalone builds include both `assets/` and root `commands.yaml`, and that first standalone startup materializes `commands.yaml` beside the executable only when absent without overwriting an existing file. Confirm MCP `serverInfo` always contains the public HTTPS `${publicBase()}/mrmcp-icon.png` PNG icon and that exact path is fetchable without authentication only on the HTTPS listener; ordinary `/assets/...` routes remain authenticated.
32. Verify `trash_paths` creates one `.mrmcp/trash/<action_id>/` plus sibling `.json` inside the selected Root, never creates top-level `.trash`, excludes `.mrmcp` metadata from explicit/glob selections, supports files/directories and globs, collapses nested selections, and leaves no partial trash action after rollback.
33. Verify `untrash_action` preflights the complete action and either restores every path or restores none; confirm both trash tools have `destructiveHint: false` and no permanent filesystem-delete tool is published.
34. Verify `exec`/`exec_start` schemas describe argv as verbatim ordered arguments, expose combined normalized `output`, and add individual stdout/stderr only when `separate_streams: true` is requested. Normalization happens before buffering/storage, removes ANSI/OSC/control sequences without erasing prior progress states, and converts standalone `\r` to a line break. There is no raw-output option or retained raw process-output copy; `exec_poll` offsets advance directly over the normalized stream. On Windows, verify managed children use `node:child_process.spawn(..., { windowsHide: true })`, completion observes the child `exit` rather than waiting indefinitely for inherited pipe closure, and termination uses only the managed child runtime `kill()` API with no `taskkill`/platform helper or false process-tree guarantee.
35. Verify `query_tool_calls` returns only prior rows for the supplied `context_handle`, excludes its own current row, enforces limit 1–50/default 10, combines exact tool/status filters with literal full-record text search and `before_id` backward pagination, and makes no claim about upstream requests that never reached MrMCP.
36. Verify process-like Tool Call rows render command/cwd, optional raw stdin panel and normalized combined output above MCP JSON; base64 stdin must be labeled rather than display-decoded. Prefer live process output when available, enqueue process-output chunks and process-exit changes through the normal coalesced render path, show observable termination origin/requested/observed signal, and render no terminal block for non-process tools. Explicit GUI/`exec_kill` termination is `user`, timeout is `timeout`, server shutdown is `server`, and observable outside termination is `external`. A parent exit must complete the foreground client response even when descendants keep inherited stdout/stderr handles open; ordinary nonzero exits must not be mislabeled as external kills.
37. Verify Tool Call pagination/table/compact rows/detail rows use stable ids keyed by log database primary key and a live insert does not replace unrelated existing rows during Morphlex reconciliation.
38. Verify visible GUI headings, action buttons and dialog titles use consistent Title Case while ordinary field labels/body prose remain sentence case. Keep explanatory GUI copy short and operational: state what the control/view does and the user-visible consequence; avoid implementation prose when a shorter meaning-first sentence is sufficient.
39. Confirm desktop mode creates no backend OS child: one `mrmcp.exe` owns the WebView main thread plus backend Deno Worker, Worker readiness/shutdown use messages, readiness/shutdown timeout timers are cleared when no longer needed, and window close releases the Worker before the desktop main entrypoint exits explicitly. Verify GUI/HTTP/HTTPS listeners retry occupied base ports at +50 without persisting fallback ports; this resolves only listener collisions, so parallel test instances are expected to run from separate program directories for separate `.mrmcp` data. The compact header must keep related state grouped: brand/version, live/fallback plus effective ports in HTTP/HTTPS/GUI order, `💬 N active` with up to four latest `#Session(total Tool Calls)` entries using a five-minute Tool Call activity window, then `🛠️` Tool Calls in-flight, total and error counts. Where useful, header values are clickable only through normalized browser inputs handled by Deno: ports → Settings, active → unfiltered Sessions, recent Session → Tool Calls filtered by Session, in-flight → running Tool Calls, total → unfiltered Tool Calls, errors → failed Tool Calls. These shortcuts must update Deno `uiState` and use the normal Eta/SSE/Morphlex render path; never add browser-owned filters, querystring state or imperative DOM changes. Keep existing icons concise and differentiate related text semantically: active green, in-flight yellow when nonzero, errors red when nonzero, totals/session counters blue-neutral, and zero alert counts muted. ACME HTTP-01 is disabled unless effective HTTP remains port 80. Confirm the Windows standalone build uses both `--no-terminal` and `--icon assets/mrmcp.ico`, and source-mode `deno run` remains terminal-attached for development.
40. Verify Root/Command path existence/type checks run on blur rather than per keystroke, render inline warnings without blocking Root save, preserve the next focused control through the render, and keep Command path validation errors inline without closing the dialog.
41. Verify every managed Root/Command/Confirm/Message dialog is opened solely by Eta-rendered `open` state plus CSS overlay, with no browser `showModal()`/`show()`/imperative close path; Escape only sends a Deno close intent.
42. Verify `publish_file` exposes no return-mode selector, Base64 image payload or MCP `resource_link`; its structured result contains the temporary HTTPS `uri`, its tool descriptor points to the versioned MCP App widget, and the widget reads `structuredContent.uri`, uses `<img>` for images and an Open File link for other MIME types. Confirm `exec` exposes no `return_files*` shortcut.
43. Verify `publish_html` persists rows in `published_html`, returns a persistent unguessable HTTPS URI, remains fetchable after closing/reopening the SQLite connection/server, points to the dedicated MCP App widget, and renders through a nested iframe whose sandbox allows scripts/forms/modals/popups but never `allow-same-origin`. Confirm the outer widget declares the MrMCP origin in `frameDomains` and the tool description states that external networking is host/browser/CSP/CORS dependent.
44. Verify the Dashboard Trash card derives its count and latest action/path from actual `.mrmcp/trash/<action_id>` directories across the program folder and every configured Root, so Empty Trash immediately produces zero with no stale path detail even when historical `trash_paths` Tool Call logs remain. Untrash count/details remain historical Tool Call activity and its path is labeled historical. Verify Settings Clear Operational Data and Dashboard Empty Trash use the shared Promise maintenance barrier: in-flight Tool Calls finish, new calls wait, maintenance runs, then waiting calls continue. Confirmation dialogs close immediately, no completion dialog appears, only the active action button shows spinner/live in-flight+waiting counts, and Dashboard Tool Calls In Flight tracks `activeCallControls.size` without browser polling.
45. Run the desktop WebView on a machine with Deno and platform dependencies.
46. Verify the public OAuth consent and invalid/expired-request pages render through the shared Eta instance with auto-escaped dynamic values, generic MrMCP branding, centered decision content, green **Authorize Access** and red **Cancel** buttons without button emoji, and no client-specific or intermediate success page. Confirm approve/deny still redirect directly to the registered OAuth callback with the standard code/error parameters.
