# MrMCP implementation guide

## Current release and files

MrMCP 0.10.100 consists of four root project files, one release workflow and one versioned asset directory:

- `mrmcp.js` — Deno backend, MCP `2026-07-28`, OAuth/Basic authentication, SQLite, local Tauriless UI and desktop launcher.
- `commands.yaml` — versioned editable extra-command catalog; keep it in the repository root, never under `assets/`.
- `README.md` — complete user/operator behavior and development changelog.
- `AGENTS.md` — implementation invariants and release checks.
- `.github/workflows/release.yml` — tag-driven GitHub release automation. It must verify `VERSION == tag`, use Deno 2.9.5, cross-compile exactly the Windows x64, Linux x64, macOS x64 and macOS arm64 standalone executables, then create/update the GitHub Release with those four project-built binary assets and no project-generated archives/checksum files.
- `assets/` — all static WebView/build assets, including `morphlex.js`, `mrmcp-logo.svg`, `mrmcp-logo.png`, `mrmcp.ico` and the numbered administration screenshots; do not duplicate them in the repository root.

The only public MCP protocol endpoint is `/mcp`. The public HTTPS listener also serves the read-only unauthenticated `/mrmcp-icon.png` branding asset referenced by MCP `serverInfo.icons`. The administration UI is local-only through Tauriless' `tauri` asset protocol and opens no GUI network listener.

## Desktop shell

Load Tauriless only through the pinned literal dynamic import `await import("npm:@mefistofelix/tauriless@0.1.12")` inside `desktop()`, after the backend Worker has started. Never restore a top-level Tauriless import: Tauriless eagerly calls `Deno.dlopen` during module evaluation, so the same `mrmcp.js` being evaluated by the main isolate and backend Worker would load the native bridge twice in one process; on macOS that can register duplicate Objective-C classes and break WebView bootstrap. Keep the version pinned because Windows startup and notification identity depend on Tauriless' pre-WebView `tauriless:set-app-user-model-id` bridge.

- Do not add a hand-written FFI wrapper, vendored Tauriless native binaries, a Rust/Tauri scaffold, Neutralinojs, a Node.js application, npm project files or a CLI. Tauriless is consumed only as the normal npm JS library and owns its native binding internally.
- Desktop mode is one OS process: Tauriless stays on the main OS thread and is drained by Deno every ~16 ms, while the backend runs in a named Deno Worker/isolate loaded from the same `mrmcp.js`. Readiness and shutdown use typed Worker messages (`ready`, `shutdown`, `stopped`), not stdout parsing or a child process. Tauriless serves the GUI through `asset-request` / `tauriless:asset-response` with inline `content`; the GUI has no loopback HTTP listener, login token, cookie, session or CSRF layer. Browser inputs use Tauri `plugin:event|emit`; Deno renders in the Worker, posts the render to the main thread, and the main thread delivers it with `plugin:event|emit_to`. WebView bootstrap must register only the MrMCP host→WebView render event and then emit the bootstrap input; do not gate bootstrap on a browser-side `tauri://close-requested` listener or read `__TAURI_INTERNALS__.metadata.currentWindow` during startup. Native close-request handling belongs to the Tauriless main-thread drain. The main thread also owns native window visibility detection and sends typed `ui-visibility` messages to the Worker. Hidden or minimized windows must not cause backend UI projection, Eta rendering, HTML construction or Worker→WebView render delivery; Deno state/data still updates and the render queue remains dirty until one fresh full-state render is requested when the window becomes visible and non-minimized again. Closing the Tauriless window requests graceful backend shutdown and then terminates the Worker only as a bounded fallback. Worker wait timeouts must clear their timers when readiness/shutdown wins; after desktop cleanup completes, the main entrypoint exits explicitly so FFI or other residual handles cannot keep `mrmcp.exe` resident.
- The initial desktop size is 1180×760.
- Release standalone builds are Windows x64, Linux x64, macOS x64 and macOS arm64 and are produced by `.github/workflows/release.yml` using Deno 2.9.5 cross-compilation. Tauriless 0.1.12 bundles `win32-x64`, `linux-x64`, `darwin-x64` and `darwin-arm64` native bridges. Because Deno 2.9 applies a default 24-hour minimum dependency age, release CI must pass `--minimum-dependency-age=0` to check/compile so a newly published pinned Tauriless version can be released immediately. Windows standalone builds must use both `deno compile --no-terminal` and `--icon assets/mrmcp.ico` so the compiled desktop application opens only the WebView, has the MrMCP executable icon and does not create a companion console window. Never omit either flag from release builds. Do not add runtime console-hiding code; source-mode `deno run` remains terminal-attached for development.
- Keep the native desktop integrations enabled: set the main window icon through `plugin:window|set_icon` using in-memory RGBA data; create one MrMCP tray icon whose menu contains only Quit; attach the menu event channel to the Quit item itself and identify menu/tray actions from their event payloads, never from hard-coded Tauri callback/channel ids; a left tray click toggles the main window visible/hidden and does not open the menu, but if the window is minimized it restores and focuses it instead of hiding it; a normal window close request hides the window instead of terminating MrMCP. Enable native window drag/drop: dropped directories are forwarded to the backend and automatically added as enabled Workspaces, dropped non-directories are ignored, and a path already represented by any Workspace is a no-op. Auto-created Workspace names start from the final directory name and use the first free `Name`, `Name #2`, `Name #3`, ... form. Workspace names are globally unique database keys through `UNIQUE(name)`. Desktop OS notifications are independently controlled by persisted Session, Workspace and Tool Call settings, each enabled by default and initially falling back to the legacy global value on existing installs until the per-type values are saved. Session notifications represent logical lifecycle events: **New Session** when a Session is first created, **Session Active** when a Session starts a Tool Call after at least 10 minutes without one, and **Workspace Opened** whenever `open_workspace` successfully attaches that Session to a Workspace. Incoming valid Tool Calls use the Tool Call setting. Invalid/rejected Tool Calls receive an outcome notification instead of a duplicate generic start notification, and valid Tool Calls that later fail receive an additional final failure notification. Successful native directory-drop additions and dropped directories that already correspond to existing Workspaces use the Workspace setting; one drop produces one notification summarizing added and already-existing Workspaces. Windows already supplies the MrMCP application identity, so notification titles must never redundantly prefix `MrMCP`. Every notification body that names a Session must use the same easy-to-scan multiline identity: `💬 Session #<id>`, then list lines for `📁 <Workspace>`, `🕒 <creation age>` and `🛠️ <N> Tool Calls`. Use emoji-led event titles such as `✨ New Session`, `🟢 Session Active`, `📂 Workspace Opened`, `🛠️ Tool Call #<id>`, `⚠️ Invalid Tool Call #<id>` and `❌ Tool Call Failed #<id>`; the Tool Call number belongs in the notification title, not beside the tool name in the body. For Tool Call notifications, put the shared compact `tool · args` summary on the first body line so Windows toast truncation cannot hide it; put the Session identity immediately after that summary, then progress/error details. Invalid/failure bodies append one compact `⚠️` error line after tool/command details. When the original MCP request supplied `_meta.progressToken`, every Tool Call start/outcome notification also appends `📡 Progress requested`; do not place that transport flag inside the tool argument preview. Use bullets/newlines when a notification contains multiple facts or Workspace names. The Tauriless main thread performs every native notification call. On Windows it must call `tauriless:set-app-user-model-id` with `{ appId: Deno.execPath(), name: "MrMCP" }` after the drain loop starts but before the first WebView exists; non-Windows builds must not send this Windows-only command. Notifications themselves continue through the unmodified `plugin:notification|notify` command.
- Keep WebView/static resources in `assets/`. The desktop GUI may inline the small CSS/JavaScript/logo payload into the Tauriless asset response; do not reintroduce GUI HTTP routes merely to serve them. The only public branding path is exact HTTPS `GET /mrmcp-icon.png`, backed by `assets/mrmcp-logo.png`, so MCP clients can fetch `serverInfo.icons` without credentials. Source mode reads assets from disk; standalone builds embed them with `deno compile --include assets` so the same files resolve from Deno's virtual filesystem.
- Keep `commands.yaml` in the repository root, not `assets/`. Source mode reads/writes that physical file directly. Standalone builds must additionally compile with `--include commands.yaml`; treat the embedded copy only as a first-run template and materialize it beside the executable if the physical file is absent. Never overwrite an existing user-edited `commands.yaml` from the VFS template.
- Keep Workspace records conventional: globally unique name, user-entered path, enabled state, edit and delete. The `roots` table remains the internal persistence name, but visible GUI and MCP terminology is always **Workspace**. Workspace paths may be absolute or relative; store the entered path string unchanged in SQLite and resolve relative values against `APP_DIR` only when an operation actually needs an absolute path. Validate Workspace and Command path existence/type on blur, never through browser-native validation UI. Field errors render inline beside the relevant field and disable Save; generic operational errors use a small Deno-owned on-screen balloon, never an error modal/alert popup. Session-to-Workspace reassignment belongs on the Workspaces page through server-routed drag/drop; do not put a Workspace selector back on Sessions. Session drag items keep Session id/client on the first line and Created, Last Activity, Status and `Tool Calls: N` together underneath; do not repeat generic OAuth/auth-kind text there.

## Database: direct current schema, no versioning

The repository is in development. There is no backward-compatibility layer and there is no database schema-version concept.

1. Do not introduce `DB_SCHEMA_VERSION`, `PRAGMA user_version` checks or any equivalent version gate.
2. Ensure current tables and indexes directly at startup with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`; additive structures must become available automatically on an existing database.
3. Never add `ALTER TABLE`, migration code, backfills or old-column detection.
4. Keep required-column checks tied to structures the current code actually needs; if an existing table has an incompatible shape, fail on that shape and tell developers to recreate `.mrmcp/mrmcp.sqlite`.
5. Never import legacy configuration keys or identifiers.
6. Never retain an old table or column only for compatibility.
7. Never accept legacy `opaque_` values, `server_opaque` arguments or transport-derived session identifiers.
8. A clean schema must create no named `default` Workspace and `roots.name` must be globally unique with `UNIQUE(name)`, never `UNIQUE(server_id,name)`.
9. `contexts.id` is the numeric administrative Session primary key; `contexts.handle` remains the unique opaque Session bearer capability. Tool-call and process rows retain both `context_id` and `context_handle` snapshots. Context rows may also retain observational creation-client metadata (`auth_kind`, OAuth client id/name and User-Agent); that metadata never owns or authorizes the Session. Keep Tool Call transport metadata separate from tool arguments in additive `tool_call_transport(log_id PRIMARY KEY, progress_requested)` with `ON DELETE CASCADE`; `input_json` remains the exact tool argument object. `logs.id` is also the public persistent-execution `exec_id` returned by `exec_start`; therefore its SQLite AUTOINCREMENT sequence must never be reset or reused during the lifetime of a server data directory.
10. Settings **Clear Operational Data** is a history/data cleanup, not a configuration reset: preserve `config`, `server_config`, `custom_tools`, all OAuth tables, `roots` and `contexts`; clear `logs` plus `logs_fts`, `process_runs`, `debug_logs` and `published_html`, reset metrics, and reset the `debug_logs` sequence only. Never reset the `logs` sequence because live detached executions may still hold those ids and future `exec_id` values must remain unique/monotonic. Dashboard **Empty Trash** permanently removes only the contents of `.mrmcp/trash` under the program folder and every configured Workspace. Both maintenance actions use one Promise barrier rather than an application queue: new Tool Calls wait, already in-flight Tool Calls finish, maintenance runs, then waiting Tool Calls continue. Managed processes already detached from a completed `exec_start` call do not count as in-flight Tool Calls. Maintenance dialogs are confirmation-only: after Confirm they close immediately and no completion dialog appears. Only the confirmed action button renders the spinner plus live in-flight/waiting counts from Deno-owned state, then returns to its normal label when maintenance finishes; the other maintenance button may be disabled but must keep its normal label. Dashboard always exposes the current `activeCallControls.size` as Tool Calls In Flight. Do not add browser polling or a browser-owned countdown. Clear Operational Data must not delete certificates, command files/catalog data, trash contents or other filesystem state; Empty Trash must not delete anything outside the managed trash directories.

## MCP 2026-07-28 and explicit Session capabilities

Only protocol `2026-07-28` is advertised and accepted.

The protocol is stateless and sessionless at the transport layer:

- use `server/discover`;
- do not implement a successful legacy `initialize` path;
- do not advertise older protocol versions;
- do not send, consume or infer identity from `Mcp-Session-Id` or vendor session headers;
- every request must be understandable without a previous transport handshake;
- keep one `/mcp` POST endpoint. Ordinary RPCs and foreground `exec`/custom commands without `_meta.progressToken` return one `application/json` response. With `_meta.progressToken` plus SSE acceptance, foreground `exec` and custom commands return request-scoped `text/event-stream`; `exec_attach` may return request-scoped SSE with or without a progress token because its no-progress mode can long-poll. Never add the deprecated persistent HTTP+SSE `/sse`/GET transport;
- request-scoped process progress uses only standard `notifications/progress` for requests that supplied `_meta.progressToken`. Batch normalized combined process output at a hard 16 KiB maximum or 100 ms, whichever happens first; send no empty progress events, flush any remainder before the final JSON-RPC result, then close the SSE response. The final `exec` result always contains the complete transcript; progress is an additional delivery path, not the only copy;
- HTTP content compression belongs to Deno. Both public `Deno.serve` listeners must use `automaticCompression: true`; do not add a hand-written zlib/Brotli/gzip response middleware, `Content-Length` gate, chunk encoder or compressor-flush layer. Deno owns content-encoding negotiation/compressibility and the HTTP runtime owns framing. Current Deno leaves `text/event-stream` uncompressed even when ordinary compressible text/JSON responses negotiate gzip/Brotli; preserve that native behavior rather than adding an SSE-only compressor.

Application state uses an explicit Session bearer capability:

- `list_workspaces` is a sessionless read-only discovery tool. It accepts no `context_handle` and returns only the enabled Workspace names that may be passed to `open_workspace`;
- `open_workspace` also has no required `context_handle` input; it requires a globally unique enabled Workspace `name` as a free string, never an enum of currently configured names, and accepts optional `current_context_handle`. An active current handle is reused while its Session is moved to that Workspace; an omitted, empty, unknown or expired current handle creates a new Session there. The tool always returns the effective `ctx_...` value;
- `open_workspace` directly returns the selected `workspace_name`, absolute `cwd` and nullable Workspace-level `agent_guidance_path`; read that file when non-null;
- every other base and custom tool requires the same `context_handle` property;
- every output schema except `list_workspaces` requires only `context_handle` as common metadata; `list_workspaces` returns only its Workspace-name list;
- every built-in tool must add an explicit tool-specific output schema and use `additionalProperties: false`; never regress to one permissive generic result schema;
- failed calls set `isError: true` and expose one human-readable `error` string; do not add duplicate status, execution, retry, recovery-tool or log-id fields;
- on tools that require `context_handle`, missing, invalid or expired handles never execute the requested operation and never mint a replacement automatically; `open_workspace` is the deliberate exception for its optional `current_context_handle`, where an unusable value creates a new Session;
- valid handles execute and are repeated byte-for-byte in the result;
- Sessions expire after 30 days without activity.

Authentication gates access to the server. After authentication, `list_workspaces` may be used without a Session; for Session-bound tools, possession of a valid `context_handle` selects the Session and its current Workspace. Do not bind Sessions, managed processes or JavaScript kernels to an OAuth client, Basic credential, owner key or transport identity.

Never describe `context_handle` as a protocol or transport session identifier. Session client metadata is best-effort observational information captured when `open_workspace` creates the Session; do not infer a model, reasoning/thinking level or client ownership from it. A ChatGPT model or thinking-level change may result in a new Session even inside the same chat.

## Authentication and authorization

Authentication is the only server-access decision.

- Authenticated clients receive all published tools.
- Anonymous clients receive none.
- Do not implement tool approvals, allow/deny regular expressions, enable lists, execution switches or per-tool policy rules.
- OAuth consent remains only to authorize the OAuth client.
- The public OAuth consent/error page must remain client-agnostic and server-rendered with the same Eta instance used by the administration UI. Dynamic client, scope, resource, redirect and hidden-form values go through Eta auto-escaping; do not rebuild the page with interpolated HTML strings or client-specific copy. Keep it as a compact centered one-screen card using the administration GUI dark palette, with compact client/scope/resource/return rows, green **Authorize Access**, red **Cancel**, matching branded invalid/expired state, and the direct standards-compliant redirect to the registered client callback after the decision. On desktop keep the panel around half the viewport width and size typography from a combination of `vw` and `vh`; do not derive primary consent typography from `vmin`, because a short landscape viewport makes it unacceptably small. Keep logo, spacing and actions viewport-relative, constrain the document to the viewport, and keep all details and both actions visible without scrolling in a normal desktop viewport. Do not add a separate trust-notice block or redundant footer.
- `context_handle` is a bearer capability shared by any authenticated client that possesses it.

## Workspaces and current working directory

The GUI maintains named Workspaces. Workspace names are globally unique; a Workspace may be assigned to many Sessions, while each Session stores exactly one current internal `root_id`.

- Internal Workspace id `0` is the program-folder fallback containing `mrmcp.js`; it is not a named Workspace accepted by `open_workspace`.
- `open_workspace(name, current_context_handle?)` requires an enabled named Workspace. Its published `name` input must remain a free `string`, never a dynamic `enum` of configured Workspace names; existence/enabled validation happens when the tool runs. With an active current handle it reassigns that same Session immediately and preserves the handle; otherwise it creates a new Session attached to the Workspace.
- Workspace reassignment is available both through `open_workspace` and the Workspaces GUI. Sessions shows the current Workspace name/path read-only. Stored relative paths are resolved against `APP_DIR` only when an operation needs an absolute path.
- `open_workspace` checks only the selected Workspace's `AGENTS.md`, then `agents.md`; it returns the absolute guidance path and never scans parent or child directories.
- Tool/server descriptions must direct the agent to use the Workspace identity/guidance fields returned directly by `open_workspace` and read and follow `agent_guidance_path` when non-null. Published tool/input/output schema descriptions should be product-neutral; reserve the `MrMCP` name for actual server identity, branding, UI/resource identity, or behavior where the product name is semantically necessary.
- Changing a Session Workspace affects new calls immediately. Existing background and interactive processes continue with their original working directory.
- Disabling or deleting a Workspace moves associated Sessions to internal id `0` without terminating processes; such Sessions remain visible for operator reassignment but new Sessions cannot be opened into id `0` through `open_workspace`.
- Resolve the Session and Workspace once at the start of each call and use that fixed selection for the whole operation.

All relative paths and new child-process working directories must remain inside the selected Workspace.

JavaScript kernels are lazy and keyed internally by `(server_id, context_handle, root_id)`. Switching Workspaces selects or creates the matching kernel; switching back restores its previous state. Never share a kernel between different Sessions.

## GUI architecture

Keep these sections:

- Dashboard;
- Clients;
- Sessions;
- Workspaces;
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
5. If the native window is hidden or minimized, stop there: retain only the dirty state while all authoritative Deno/DB/runtime state continues changing normally.
6. If the native window is visible and non-minimized, the render scheduler coalesces/throttles bursts and asynchronously builds the active view with Eta.
7. The backend Worker posts the completed HTML plus restoration metadata to the main thread, which emits it to the WebView over the Tauri event bus.
8. The WebView applies that HTML through Morphlex and restores only the focus/scroll information supplied by Deno. A hidden→visible transition forces one current full-state render; never replay intermediate hidden updates.

The same path applies to non-user events. A new MCP tool call, a log row, process output/completion, a Workspace change, OAuth mutation, certificate update or settings change must update backend state/data and enqueue the same render pipeline. There must not be a separate “automatic refresh” implementation.

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
- Workspace, Command and Settings drafts plus inline field-validation state;
- active confirmation/form dialog and non-modal notice balloon;
- the last processed input sequence.

Database primary keys identify expanded rows. Never use a row index or DOM position.

### Thin WebView transport

The embedded browser has only transport and DOM-application responsibilities:

1. delegate user events;
2. serialize them and emit them through Tauri `plugin:event|emit`;
3. receive render payloads through Tauri `plugin:event|listen` after the main thread sends them with `plugin:event|emit_to`;
4. morph the complete `#app` HTML using Morphlex;
5. apply scroll/focus metadata sent by Deno.

The browser must not call `/api/state`, `/api/render` or section-specific JSON endpoints. It must not execute database, filesystem, process, TLS, OAuth or command business logic. Local clipboard writes are allowed because they carry no persistent or graphical application state. Native drag `DataTransfer` may transiently carry only a numeric Session PK to a server-rendered Workspace drop target; it must not add/remove classes, move nodes, retain assignment state or otherwise alter visible UI locally.

### One backend input and render pipeline

Deno processes WebView inputs sequentially. The browser may coalesce rapid text-input drafts before crossing the Tauri event bridge, but action/change/blur/submit/navigation events must flush pending input first so the latest edit is never lost. The dispatcher updates `uiState`, performs the requested backend action and queues a render when required. Backend-originated changes from MCP calls, logs, managed processes, Workspaces, OAuth, TLS, settings and commands enter the same queue through `emitUiChange`.

Rendering must not occur synchronously in mutation paths:

- use a short throttle to coalesce bursts;
- permit only one render at a time;
- if another event arrives during rendering, perform one subsequent pass;
- yield before expensive work;
- gate the expensive path on native `visible && !minimized`; while false, retain `uiRenderQueued` only and do not call `buildUiRenderModel()`, Eta, HTML construction or Worker/WebView render delivery;
- if visibility becomes false during an already-started render, discard its finished payload and leave the queue dirty;
- when visibility becomes true, force one fresh complete render from the current Deno state regardless of how many hidden changes occurred;
- use Eta asynchronous rendering when available;
- send the completed full `#app` HTML through the Worker → main-thread → Tauri event path only while visible.

Do not add interval polling, refresh timers, auto-refresh controls, manual refresh paths, hidden-render replay queues or multiple independent render queues.

### Selective rendering and data access

Eta selects the active section from Deno `uiState.currentSection`. `buildUiRenderModel()` may query only the current section’s data:

- Dashboard: endpoint summary and aggregates, Trash/Untrash activity, plus the compact active/recent Tool Call table. That table includes every in-flight Tool Call and calls completed within the last five seconds, using the same bounded tool/argument summary, Session id, elapsed time and persisted `progress_requested` marker. Keep a fixed viewport of five Tool Call rows with internal scrolling. Clicking a live/recent row sends only its stable log id to Deno; Deno clears Tool Call filters, selects the correct paginated log page, opens that exact detail row and supplies a one-shot `scroll_target` restoration hint so the browser only scrolls the already-rendered selected row into view. Deno schedules one-shot renders while calls are active and at completed-row TTL expiry; CSS may fade a completed row, but the browser must not own the timer/countdown or poll.
- Sessions: Sessions and their single current Workspace, optionally filtered by stored OAuth client id; Workspace information is read-only.
- Workspaces: Workspace records plus the minimal Session rows required to group Sessions by current internal `root_id` and render the program-folder fallback bucket.
- Commands: command catalog page only.
- Tool calls: context filter values, paginated rows and at most one selected detail row.
- HTTP debug: recording setting, filtered stored rows and at most one selected detail row. Turning recording off must only stop new `debug_logs` inserts; existing rows remain queryable, filterable and expandable until explicitly cleared. When recording is enabled, insert the HTTP row immediately on request arrival with an in-flight state, then update that same primary key after `ServeHandlerInfo.completed` resolves/rejects. For streamed responses, capture bounded response text while forwarding the actual response body; never `clone()`/drain an SSE body before returning it, and cancellation of the capture wrapper must propagate to the upstream response stream.
- OAuth: OAuth clients plus context counts and lifecycle timestamps derived from existing client/token/context tables: client creation, first/last Session creation, latest access-token issue and latest refresh-token use.
- Settings: runtime settings only.
- Help: static operator guidance plus the already-available settings projection; no section-specific database query.

Inactive sections must neither render nor query their tables. Sidebar selection, expanded rows, dialogs, confirmations and drafts are all Eta output derived from Deno state.

### Dialogs, validation and drafts

Workspace, Command, Settings and confirmation state belongs to Deno. Input events update the corresponding server draft even when no immediate render is needed, so an unrelated MCP/render update cannot erase partially entered values. Workspace/Command path checks run on blur; synchronous name/URL/settings validation may update from coalesced input events. Never rely on browser-native `required`, `pattern`, URL/email validation bubbles, `alert()` or `confirm()` for application validation. Field-specific errors render as concise red text beside the field and disable the corresponding Save action until valid. Generic operational errors render as a small non-modal Deno-owned red notice balloon, never an error modal. Eta owns confirmation/form open state and renders the `open` attribute from `uiState.dialog`; never call `showModal()`/`show()` or close a dialog imperatively in browser JavaScript. Use server-rendered markup plus CSS overlay for confirmation/form presentation; Escape may only send a close intent back to Deno.

## Tool-call UI

- Display and filter by the numeric operator Session primary key, never the long `context_handle` or generic context label.
- Apply text, Session, status and page-size filter changes automatically through Deno-owned state; do not add a Tool-call Search button or a second refresh path.
- Give Tool Call pagination, the table, every compact row and every expanded detail row stable DOM ids derived from the log database primary key so Morphlex preserves row identity when new calls are inserted ahead of existing rows.
- Show terminal chrome only when the selected Tool Call has an actual process-like result (managed exec-family calls or custom commands carrying process command/output data); filesystem, search and control calls must not show an empty terminal section.
- Process-like expanded rows show command/cwd, optional input `stdin` in its dedicated panel, then the combined terminal `output` block before JSON details; label base64 stdin without decoding it for display, and prefer live managed-process output when the linked process is still in memory. Every expanded completed Tool Call must expose the raw tool return value separately from the final MCP Result JSON, including the `exec*` family. Normalize stdout/stderr before buffering or storage: strip ANSI/OSC/control sequences and preserve standalone carriage-return progress updates as separate lines rather than overwriting prior text. Do not retain a second raw process-output copy or expose a raw-output option. Every process-output chunk marks the Tool Calls scope dirty through the normal coalesced render queue; do not add polling. Separately requested stdout/stderr belong in the return/MCP JSON, not duplicated in the terminal block.
- Use numbered pagination above the table.
- Keep input/output JSON out of compact rows. Every compact Tool Call row and desktop Tool Call notification must show the tool name plus a bounded argument preview. Omit `context_handle` and `current_context_handle` from that preview; show at most six useful top-level arguments, limit each rendered value to 48 characters, cap the preview at 180 characters and append `… +N args` when useful arguments are omitted. For `exec*`, retain the command-aware preview: executable basename plus compact argv, resolving related process calls back to their command when available. If `tool_call_transport.progress_requested` is true, show a separate **📡 Progress requested** marker in the compact row and expanded detail; never merge it into `input_json` or the argument preview.
- Render details only for the selected primary key. Every Tool Call for which a published descriptor exists must persist that exact descriptor in the additive `tool_call_descriptors` table; the expanded row renders title/description plus input/output schemas in a right-side Agent Tool Definition panel. Compare the stored descriptor with the tool descriptor currently published by the server and show **CURRENT** only for an exact match, otherwise **OUTDATED** (including when the tool is no longer published). Old rows without a snapshot show a concise unavailable state rather than reconstructing a newer descriptor.
- Show Terminate/Force controls only for genuinely cancellable work.
- Display complete timestamps plus compact relative ages.
- Keep `failed` and `invalid` semantically distinct. `failed` is red and represents an accepted call that failed during execution or an execution-level rejection; `invalid` is purple and represents a request that reached MrMCP but was rejected before tool execution by MCP protocol, tool-name, context or input-schema validation. The Tool Calls status filter and the compact header must expose `invalid`; the header count is clickable through the same Deno-owned navigation/filter path as running/failed. Every status option in the Tool Calls dropdown must use the semantic row color (`completed` green, `failed` red, `invalid` purple, `running` yellow), and the server-rendered selected value must retain that color without browser-owned state.
- Keep published tool input schemas strict. Never relax `additionalProperties`, required fields, types or bounds merely to observe bad clients. Mirror the published input schema server-side before execution so a client that dispatches an invalid call anyway is logged as `invalid` and not executed. Preserve the received input, exact validation message and the MCP/JSON-RPC result returned to that client where a response body exists.

## Processes and PATH

The system-PATH setting is enabled by default.

- `exec` and `exec_start` must describe `args` as the exact ordered argv passed verbatim to the executable; agents should consult the command's `--help` rather than reinterpret uncertain option syntax.
- `exec` is foreground/request-scoped and retains the complete normalized combined stdout/stderr transcript until the call ends. Without `_meta.progressToken` it returns one final JSON result after process exit. With `_meta.progressToken` and SSE support it also emits incremental progress in 16 KiB/100 ms batches, then returns the same complete transcript in the final result. A client disconnect/cancellation terminates that child. Foreground custom commands use the same progress behavior.
- Persistent execution uses `exec_start`, `exec_attach`, `exec_write`, `exec_kill`, `exec_list` and `exec_status`. `exec_start` accepts no client-chosen process label. Its returned `exec_id` is exactly the numeric Tool Call log id allocated for that `exec_start`; it is monotonic/unique and every follow-up lookup is scoped by exact `(context_handle, exec_id)`. Keep the internal random `process_id` and OS PID only for database/GUI/diagnostics. `exec_start` starts immediately, retains the complete normalized stdout/stderr transcript, keeps stdin open, records client stdin writes internally and returns JSON without streaming.
- `exec_attach(exec_id)` consumes unread combined output through an internal cursor and exposes no public offset. With `_meta.progressToken`, emit all unread backlog through progress, continue emitting live output until the child exits/kills, then return the entire unread transcript covered by that attachment with `remaining_bytes: 0`. Without `_meta.progressToken`, return existing unread data immediately up to 16 KiB; otherwise long-poll until output arrives, then return once 16 KiB are available or 100 ms have elapsed after the first new data. `remaining_bytes` is the exact UTF-8 byte count already buffered after the returned chunk. Agents immediately call again while it is nonzero; with zero plus `status: running`, another call waits for future output/termination. Killing/failing while attached must wake the call and preserve the final available output/status. Only one attachment may be active per exec id. Disconnecting attach detaches only and never terminates the persistent child.
- `exec_write(exec_id)` writes/closes stdin and `exec_kill(exec_id)` terminates only persistent children in the same Session. `exec_list` exposes only currently running persistent executions for the exact `context_handle`; never include completed records there. `exec_status(exec_id)` is read-only/non-consuming and must work for running and retained completed/failed/timed-out/killed records, with `output=none|all|tail`, bounded `tail_lines`, and optional matching stdout/stderr selection through `separate_streams`. Completed in-memory records are retained by the existing 24-hour cleanup window and do not survive server restart. No MCP process input/result may expose internal `process_id` or OS PID.
- ON: prepend `.mrmcp/bin` to the supplied or inherited `PATH`.
- OFF: use only `.mrmcp/bin` in the child `PATH`.
- Use `ComSpec` on Windows and `SHELL` or `/bin/sh` on Unix.
- On Windows, spawn managed `exec` / `exec_start` children through `node:child_process.spawn` with `windowsHide: true` and adapt Node stdio streams to the existing Web Stream process pipeline. Do not regress to a spawn path that flashes a console window or steals WebView focus. Non-Windows managed processes may continue to use `Deno.Command`.
- Managed termination must use the runtime child-process `kill()` API directly. Do not spawn `taskkill`, `kill`, `pkill` or another platform helper and do not claim portable recursive process-tree termination: Deno/Node core provides no cross-platform tree-kill API. `SIGTERM` and `SIGKILL` remain distinct requests on Unix; on Windows Node may terminate the direct child without Unix signal semantics. Parent exit must still release a foreground MCP response after the bounded output-drain path even when descendants retain inherited handles.
- Explicit GUI/`exec_kill` termination uses `termination_source: "user"`; foreground request disconnect/cancellation uses `client`; timeout and server-shutdown requests use `timeout` and `server`, while an externally observable termination uses `external`. Keep `requested_signal` distinct from the actually observed `signal`; do not invent an observed signal when Windows reports none.
- Keep managed process access scoped to the exact `context_handle`; retain the Workspace and cwd snapshot captured at process start.
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

Filesystem removal is trash-only; do not reintroduce a permanent delete tool. `trash_paths` accepts explicit paths and/or one glob, supports files and directories, collapses nested selections, and moves each action under the selected Workspace's reserved `.mrmcp/trash/<action_id>/` with sibling `.mrmcp/trash/<action_id>.json`. Never create a top-level `.trash` directory. Exclude the entire `.mrmcp` metadata directory from explicit trash targets and trash globs. Action ids use local date/time to the second with an incrementing numeric suffix only on collision. The manifest stays minimal (`action_id`, creation time and original paths); do not add hashes or redundant integrity metadata. Assume `.mrmcp/trash` is managed by MrMCP, but keep the preflight required to guarantee `untrash_action` restores the entire action or nothing and rolls back any mid-restore moves. Neither `trash_paths` nor `untrash_action` is destructive; do not add them to `destructiveHint`. Dashboard Trash/Untrash counters and latest-action details must be derived from completed persistent Tool Call logs rather than duplicated into another table; failed attempts do not count, and a successful Untrash displays its reconstructed trash path as historical because the action directory has been removed.

## Documentation requirements

README must describe current behavior, not only past changes. It must include:

- startup and files;
- protocol rationale and explicit context capability lifecycle;
- the distinction between GUI Sessions and protocol sessions;
- authentication and database policy;
- Workspaces, commands, processes, text encoding and TLS;
- the event-driven UI and ephemeral state model;
- a development changelog, with reverted architecture experiments clearly marked as superseded.

Update README, AGENTS, the source header and the `VERSION` constant in `mrmcp.js` together for every release. The release commit message must be descriptive, not a generic `release X.Y.Z`: include the version plus a short summary of the primary change, for example `0.10.82: color Tool Call status filter options`. Keep it concise but specific enough that `git log` explains what changed without opening the commit. Invoke Git/GitHub CLI through MrMCP `exec` with `program` + `args`; never add a `shell` boolean/field, because it is not part of the tool schema. After creating the release tag, prefer one direct combined push with `git push origin main X.Y.Z`; the pushed version tag is the publication trigger. Do not manually create/upload the normal GitHub Release afterward: `.github/workflows/release.yml` verifies the tag against `VERSION`, cross-compiles the four release executables and publishes them. Split branch/tag pushes only when Git itself returns an execution error, not when a tool invocation was rejected before reaching MrMCP.

## Release checks

1. Syntax-check `mrmcp.js` as an ES module.
2. Extract and syntax-check the embedded browser module and JavaScript worker.
3. Compile/render every Eta fragment with representative data, including all nine sections and every dialog kind.
4. Verify sidebar input travels through `plugin:event|emit` to Tauriless, reaches the backend Worker, changes Deno `uiState.currentSection`, queues a render, and returns through `plugin:event|emit_to`.
5. Verify the browser bundle contains no application-state object, business logic or administrative JSON fetches.
6. Verify expanded Tool-call and HTTP rows survive relevant backend renders by database primary key.
7. Verify `buildUiRenderModel()` queries only the active section.
8. Verify input events update Deno drafts before unrelated backend renders.
9. Verify the render queue coalesces bursts, never renders concurrently and performs a follow-up pass when dirtied during rendering. Verify hidden/minimized desktop state suppresses `buildUiRenderModel()`, Eta/HTML construction and Worker→WebView render delivery while preserving dirty/backend state; restoring visibility must produce exactly one fresh current-state synchronization, and a render that finishes after visibility is lost must be discarded rather than delivered.
10. Build/open SQLite state and verify current required tables/indexes are ensured without any `DB_SCHEMA_VERSION`/`PRAGMA user_version` gate; additive tables must appear on an existing compatible database.
11. Confirm no migrations, `ALTER TABLE`, legacy identifiers or old configuration imports exist.
12. Confirm only MCP `2026-07-28` is advertised and no transport-session headers are used. Verify `/mcp` remains POST-only, non-streaming RPCs return JSON, process-streaming calls can return request-scoped SSE with the final JSON-RPC result on the same response, and no legacy `/sse`/GET transport exists. Confirm both public `Deno.serve` listeners use `automaticCompression: true` and no hand-written HTTP compression middleware/framing remains. Verify response-stream cancellation still reaches MCP SSE so foreground `exec` is cancelled while `exec_attach` only detaches.
13. Confirm missing/valid/invalid/expired context-handle paths do or do not execute exactly as documented.
14. Confirm no approval, `allow_re`, `deny_re` or tool-enable policy remains.
15. Confirm no UI polling interval, auto-refresh control or manual refresh path exists; Tool-call filters must update through the single Deno render queue.
16. Confirm backend log, Session, Workspace, process, debug, OAuth, settings and TLS mutations enter the same Deno render queue.
17. Confirm every visible open/close/select/navigation transition is represented in Deno `uiState` and is produced by Eta, not by an imperative browser DOM mutation.
18. Confirm expanded-row state uses database primary keys and remains correct when pagination or new rows change table order.
19. Confirm inactive sections perform no section-specific database queries during a render.
20. Confirm the WebView only sends normalized input envelopes through Tauri events (including blur with the next focus target), receives Tauri render events, invokes Morphlex and restores Deno-supplied focus/scroll metadata.
21. Confirm `list_workspaces` is read-only/sessionless, accepts no `context_handle`, and returns only enabled Workspace names. Confirm `open_workspace` requires a globally unique enabled Workspace `name`, publishes `name` as a free string with no configured-name enum, accepts optional `current_context_handle` but not the ordinary required `context_handle`, preserves an active Session handle while switching its Workspace, creates a new Session when the optional handle is omitted, empty, unknown or expired, and directly returns `workspace_name`, absolute `cwd` and the Workspace-level `AGENTS.md` / `agents.md` path when present with `agent_guidance_path: null` when absent; confirm no public `workspace_info` tool is exposed.
22. Confirm every built-in tool exposes a strict tool-specific output schema; Session-bound tools and `open_workspace` use the common context envelope, while `list_workspaces` returns only its Workspace-name list.
23. Confirm `glob`, `grep` and `replace` implement every documented traversal, exclusion, encoding, size-limit and expected-count argument without shell, `uv` or Python helpers.
24. Confirm published tool input schemas remain strict and unchanged by diagnostic logging; an invalid call that does reach `/mcp` must be rejected before execution, stored with status `invalid`, retain its input/error/result, render purple, and be reachable from both the Tool Calls status filter and the clickable header invalid count. For every call where a published descriptor exists, persist that exact descriptor snapshot in `tool_call_descriptors` and render its description/input/output schemas on the right side of the expanded Tool Call detail; never reconstruct historical rows from the current schema. The descriptor panel must use the full available second-column width and must not inherit the fixed-width shell-sidebar styles. Compare it with the descriptor currently published for the same tool and mark exact matches CURRENT, all other snapshots OUTDATED. Confirm the status dropdown renders completed/failed/invalid/running in green/red/purple/yellow respectively and keeps the selected value in that semantic color.
25. Confirm there is no top-level Tauriless import. The desktop shell must use only the pinned literal dynamic import `await import("npm:@mefistofelix/tauriless@0.1.12")` inside `desktop()` after `spawnBackendWorker()` completes, so the backend Worker never evaluates Tauriless or calls its eager `Deno.dlopen`. Keep no hand-written FFI wrapper, vendored Tauriless native binaries, Rust/Tauri scaffold, Neutralinojs, npm project files or CLI files.
26. Confirm Session rows, Tool-call rows and the Tool-call Session filter use `contexts.id` / `logs.context_id`, while MCP requests still use the opaque handle.
27. Confirm OAuth client rows count `contexts.oauth_client_id` matches and their View sessions action opens Sessions with that client filter; clearing the filter restores all Sessions.
28. Confirm current-day GUI timestamps omit the calendar date while preserving time and any relative-age suffix.
29. Confirm the Workspaces page groups Sessions by internal `root_id`, renders Session id/client alone on the first drag-item line and Created, Last Activity, Status and `Tool Calls: N` together underneath without generic OAuth/auth-kind text, routes Session reassignment through Deno, and the Sessions page has no Workspace selector. Confirm Workspace paths preserve the exact stored absolute/relative string in the GUI while runtime operations resolve relative values against `APP_DIR`. Confirm `roots.name` has global `UNIQUE(name)`, rename/create collisions render inline beside the name field and disable Save, and native OS directory drops add enabled Workspaces automatically, ignore files/non-directories, no-op when the effective path already exists, and choose the first free globally unique name `Name`, `Name #2`, `Name #3`, ... .
30. Confirm browser drag handling only transports the numeric Session PK/target Workspace id and performs no imperative visible DOM mutation.
31. Confirm the versioned source tree contains the four root project files, `.github/workflows/release.yml` and the `assets/` directory, with Morphlex and all branding/static files there and no duplicate assets in the root; `commands.yaml` remains a root configuration file, not an asset. Confirm a version-tag push is the release trigger and the GitHub Release receives exactly the four project-built assets `mrmcp-windows-x64.exe`, `mrmcp-linux-x64`, `mrmcp-macos-x64`, `mrmcp-macos-arm64` (GitHub's automatic source-code links are outside this rule), with no project-generated zip/tar/checksum attachments.
32. Confirm `.github/workflows/release.yml` pins Deno 2.9.5, rejects a tag that differs from the source `VERSION`, passes `--minimum-dependency-age=0` to release check/compile, cross-compiles `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`, `x86_64-apple-darwin` and `aarch64-apple-darwin`, and creates/updates the release only after all four builds succeed. All standalone builds must include both `assets/` and root `commands.yaml`; Windows must additionally use `--no-terminal` and `--icon assets/mrmcp.ico`. Confirm Tauriless 0.1.12 provides all four matching native bindings. Confirm first standalone startup materializes `commands.yaml` beside the executable only when absent without overwriting an existing file. Confirm MCP `serverInfo` always contains the public HTTPS `${publicBase()}/mrmcp-icon.png` PNG icon and that exact path is fetchable without authentication only on the HTTPS listener. Confirm the desktop GUI exposes no `/assets/...` HTTP routes and receives its local asset content only through Tauriless.
33. Verify `trash_paths` creates one `.mrmcp/trash/<action_id>/` plus sibling `.json` inside the selected Workspace, never creates top-level `.trash`, excludes `.mrmcp` metadata from explicit/glob selections, supports files/directories and globs, collapses nested selections, and leaves no partial trash action after rollback.
34. Verify `untrash_action` preflights the complete action and either restores every path or restores none; confirm both trash tools have `destructiveHint: false` and no permanent filesystem-delete tool is published.
35. Verify `exec`/`exec_start` schemas describe argv as verbatim ordered arguments and process normalization happens before buffering/streaming, removes ANSI/OSC/control sequences without erasing prior progress states, and converts standalone `\r` to a line break. Confirm foreground `exec`/custom commands without progress return ordinary final JSON, while `_meta.progressToken` + SSE produces 16 KiB/100 ms progress and the final result still contains the complete transcript; disconnecting foreground work kills the child. Confirm `exec_start` accepts no label, returns immediately without streaming, retains the complete process transcript and returns `exec_id ==` its Tool Call log id. Verify all follow-up process tools require exact `(context_handle, exec_id)` and cannot reach another Session. `exec_attach` with progress emits unread backlog + live output to process end and then returns the whole unread transcript with `remaining_bytes=0`; without progress it returns existing backlog immediately or long-polls for data, returns at most 16 KiB after the 16 KiB/100 ms threshold, reports exact `remaining_bytes`, advances its internal cursor, and can wait again when `remaining_bytes=0,status=running`. Killing/failing while attached wakes the call and returns last output plus final status; disconnecting attach only detaches. `exec_list` returns only active persistent executions. `exec_status` does not advance attach state and returns metadata-only/all/tail output for running or retained completed/killed records. No `exec_poll`, labels, public offsets, `wait_ms`, public internal process id or public PID remain. Verify stdin writes are retained internally. On Windows, verify managed children use `node:child_process.spawn(..., { windowsHide: true })`, completion observes the child `exit` rather than waiting indefinitely for inherited pipe closure, and termination uses only the managed child runtime `kill()` API with no `taskkill`/platform helper or false process-tree guarantee.
36. Verify `query_tool_calls` returns only prior rows for the supplied `context_handle`, excludes its own current row, enforces limit 1–50/default 10, combines exact tool/status filters with literal full-record text search and `before_id` backward pagination, and makes no claim about upstream requests that never reached MrMCP.
37. Verify process-like Tool Call rows render command/cwd, optional raw stdin panel and normalized combined output above JSON details; base64 stdin must be labeled rather than display-decoded. Every expanded completed Tool Call exposes the raw tool return value separately from the final MCP Result JSON, including `exec*`. Every compact Tool Call row and desktop Tool Call notification shows the tool plus a compact argument preview: exclude Session bearer handles, show at most six useful top-level arguments, limit each value to 48 characters, cap the whole preview at 180 characters and append `… +N args` when more remain. For `exec*`, preserve the command-aware executable-basename/argv preview and resolve `exec_id`-based persistent follow-up calls back to the originating command when available; keep the full command only in expanded details. Persist whether `_meta.progressToken` was supplied in `tool_call_transport` and show **📡 Progress requested** in compact/detail views and Tool Call notifications without changing `input_json`. Prefer live process output when available, enqueue process-output chunks and process-exit changes through the normal coalesced render path, show observable termination origin/requested/observed signal, and render no terminal block for non-process tools. Explicit GUI/`exec_kill` termination is `user`, foreground request disconnect is `client`, timeout is `timeout`, server shutdown is `server`, and observable outside termination is `external`. A parent exit must complete the foreground client response even when descendants keep inherited stdout/stderr handles open; ordinary nonzero exits must not be mislabeled as external kills.
38. Verify Tool Call pagination/table/compact rows/detail rows use stable ids keyed by log database primary key and a live insert does not replace unrelated existing rows during Morphlex reconciliation.
39. Verify visible GUI headings, action buttons and dialog titles use consistent Title Case while ordinary field labels/body prose remain sentence case. Keep explanatory GUI copy short and operational: state what the control/view does and the user-visible consequence; avoid implementation prose when a shorter meaning-first sentence is sufficient.
40. Confirm desktop mode creates no backend OS child: one `mrmcp.exe` owns Tauriless on the main OS thread plus the backend Deno Worker, Tauriless is drained at roughly 16 ms without blocking Deno, Worker readiness/shutdown use messages, readiness/shutdown timeout timers are cleared when no longer needed, and actual window destruction releases Tauriless and the Worker before the desktop main entrypoint exits explicitly. A normal X/close-request hides the main window and keeps MrMCP running. Confirm the GUI opens no network listener and loads only through Tauriless `asset-request`; only HTTP/HTTPS public listeners retry occupied base ports at +50 without persisting fallback ports. Before creating the WebView, unsubscribe unused Tauriless initial named events but retain `tauri://close-requested`, `tauri://destroyed`, `tauri://drag-drop`, `tauri://resize`, `tauri://focus`, `tauri://blur` and built-in `tauriless://webview-message`; resize/focus/blur are used only to debounce a native `is_visible` + `is_minimized` query and publish `ui-visibility` to the backend, not as graphical state themselves. Confirm WebView bootstrap registers the MrMCP render event and immediately emits its bootstrap message without a preliminary browser-side close-request listener or `metadata.currentWindow` dependency. Confirm rapid browser text inputs are coalesced while action/change/blur/submit/navigation flush pending input before delivery. Confirm the main window is created hidden with backend rendering disabled, forced to logical inner size 1180×760, centered, iconized, then shown; showing/restoring enables rendering and forces one current-state sync, while hide/minimize disables rendering. Tray menu contains only Quit, left tray click toggles show/hide, native directory-drop Workspace creation works, and new-Session OS notifications work through Tauriless. The compact header must keep related state grouped: brand/version, live/fallback plus effective HTTP/HTTPS ports, `💬 N active` with up to four latest `#Session(total Tool Calls)` entries using a ten-minute Tool Call activity window, then `🛠️` Tool Calls in-flight, total, error and invalid counts. Where useful, header values are clickable only through normalized browser inputs handled by Deno: ports → Settings, active → unfiltered Sessions, recent Session → Tool Calls filtered by Session, in-flight → running Tool Calls, total → unfiltered Tool Calls, errors → failed Tool Calls, invalid → invalid Tool Calls. These shortcuts must update Deno `uiState` and use the normal Eta/Tauri-event/Morphlex render path; never add browser-owned filters, querystring state or imperative DOM changes. Keep existing icons concise and differentiate related text semantically: active green, in-flight yellow when nonzero, errors red when nonzero, invalid purple when nonzero, totals/session counters blue-neutral, and zero alert counts muted. ACME HTTP-01 is disabled unless effective HTTP remains port 80. Confirm the Windows standalone build uses both `--no-terminal` and `--icon assets/mrmcp.ico`, and source-mode `deno run` remains terminal-attached for development.
41. Verify Workspace/Command path existence/type checks run on blur rather than per keystroke, field validation renders inline and disables Save while invalid, the next focused control survives validation rendering, and no browser-native validation bubble/error popup is used.
42. Verify every managed Workspace/Command/Confirm dialog is opened solely by Eta-rendered `open` state plus CSS overlay, with no browser `alert()`/`confirm()`/`showModal()`/`show()`/imperative close path; generic errors use the Deno-owned non-modal notice balloon and Escape only sends a Deno close intent.
43. Verify `publish_file` exposes no return-mode selector, Base64 image payload or MCP `resource_link`; its structured result contains the temporary HTTPS `uri`, its tool descriptor points to the versioned MCP App widget, and the widget reads `structuredContent.uri`, uses `<img>` for images and an Open File link for other MIME types. Confirm `exec` exposes no `return_files*` shortcut.
44. Verify `publish_html` persists rows in `published_html`, returns a persistent unguessable HTTPS URI, remains fetchable after closing/reopening the SQLite connection/server, points to the dedicated MCP App widget, and renders through a nested iframe whose sandbox allows scripts/forms/modals/popups but never `allow-same-origin`. Confirm the outer widget declares the MrMCP origin in `frameDomains` and the tool description states that external networking is host/browser/CSP/CORS dependent.
45. Verify the Dashboard Trash card derives its count and latest action/path from actual `.mrmcp/trash/<action_id>` directories across the program folder and every configured Workspace, so Empty Trash immediately produces zero with no stale path detail even when historical `trash_paths` Tool Call logs remain. Untrash count/details remain historical Tool Call activity and its path is labeled historical. Verify the Dashboard Active Tool Calls table contains all in-flight calls plus only the previous five seconds of completed calls, uses the shared compact summary/Session/time/progress marker, keeps a fixed five-row viewport with internal scrolling, and routes a clicked row through Deno to the exact Tool Calls page/detail identified by its stable log id. It fades only as presentation and is removed/refreshed by Deno-owned one-shot timers with no browser polling/countdown. Verify Settings Clear Operational Data and Dashboard Empty Trash use the shared Promise maintenance barrier: in-flight Tool Calls finish, new calls wait, maintenance runs, then waiting calls continue. Clear Operational Data may reset `debug_logs` but must never reset the `logs` AUTOINCREMENT sequence, because detached persistent executions can still hold `exec_id` values from deleted Tool Call rows. Confirmation dialogs close immediately, no completion dialog appears, only the active action button shows spinner/live in-flight+waiting counts, and Dashboard Tool Calls In Flight tracks `activeCallControls.size` without browser polling.
46. Run the desktop WebView on a machine with Deno and platform dependencies.
47. Verify the public OAuth consent and invalid/expired-request pages render through the shared Eta instance with auto-escaped dynamic values, generic MrMCP branding, centered decision content, green **Authorize Access** and red **Cancel** buttons without button emoji, and no client-specific or intermediate success page. At representative desktop landscape viewports, including 1920×1200 and a shorter ~1695×862 browser viewport, confirm the centered card remains around half-width, all four details and both actions fit without scrolling, and text remains comfortably readable rather than collapsing from short-side `vmin` scaling. Confirm approve/deny still redirect directly to the registered OAuth callback with the standard code/error parameters.
