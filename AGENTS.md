# MrMCP implementation guide

## Current release and files

MrMCP 0.10.48 consists of exactly five root files:

- `mrmcp.js` — Deno backend, MCP `2026-07-28`, OAuth/Basic authentication, SQLite, loopback UI and WebView launcher.
- `morphlex.js` — DOM morphing engine. Eta performs server-side templating; Morphlex does not template.
- `commands.yaml` — extra-command catalog.
- `README.md` — complete user/operator behavior and development changelog.
- `AGENTS.md` — implementation invariants and release checks.

The only public MCP endpoint is `/mcp`. The administration UI is loopback-only at `127.0.0.1:7332`.

## Desktop shell

Use only the direct Deno import `jsr:@webview/webview@0.9.0`.

- Do not add Tauri, Rust, Neutralinojs, Node.js, npm, a CLI or a scaffold project.
- Desktop mode starts the backend as a Deno child process, waits for `MRMCP_READY`, opens the authenticated GUI URL and stops the child when the WebView closes.
- The initial desktop size is 1180×760.
- Do not add a native tray or drag-and-drop bridge unless explicitly requested.
- Keep Roots management conventional: logical name, absolute path, enabled state, edit and delete.

## Database: clean schema only

The repository is in development. There is no backward compatibility.

1. Maintain one exact startup schema and one `DB_SCHEMA_VERSION`.
2. Reject a non-empty database whose `PRAGMA user_version` differs.
3. Never add `ALTER TABLE`, migration code, backfills or old-column detection.
4. Never import legacy configuration keys or identifiers.
5. Never retain an old table or column only for compatibility.
6. Never accept legacy `opaque_` values, `server_opaque` arguments or transport-derived session identifiers.
7. Tell developers to delete `.mrmcp/mrmcp.sqlite` after incompatible schema changes.
8. A clean schema must create no named `default` root.
9. `contexts.id` is the numeric administrative primary key; `contexts.handle` remains the unique opaque bearer capability. Tool-call and process rows retain both `context_id` and `context_handle` snapshots.

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

The GUI label **Sessions** is operator terminology only. Never describe `context_handle` as a protocol or transport session.

## Authentication and authorization

Authentication is the only server-access decision.

- Authenticated clients receive all published tools.
- Anonymous clients receive none.
- Do not implement tool approvals, allow/deny regular expressions, enable lists, execution switches or per-tool policy rules.
- OAuth consent remains only to authorize the OAuth client.
- `context_handle` is a bearer capability shared by any authenticated client that possesses it.

## Roots and current working directory

The GUI maintains named roots. A root may be assigned to many contexts, while each context stores exactly one current `root_id`.

- Root id `0` is the fallback directory containing `mrmcp.js`.
- New contexts start on root id `0`.
- Root assignment is managed only in the Sessions/Roots GUI.
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
- Sessions;
- Roots;
- Commands;
- Tool calls;
- HTTP debug;
- OAuth clients;
- Settings.

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

The browser must not call `/api/state`, `/api/render` or section-specific JSON endpoints. It must not execute database, filesystem, process, TLS, OAuth or command business logic. Local clipboard writes are allowed because they carry no persistent or graphical application state.

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

- Dashboard: endpoint summary and aggregates.
- Sessions: contexts and their single current root.
- Roots: roots only.
- Commands: command catalog page only.
- Tool calls: context filter values, paginated rows and at most one selected detail row.
- HTTP debug: setting, filtered rows and at most one selected detail row.
- OAuth: OAuth clients only.
- Settings: runtime settings only.

Inactive sections must neither render nor query their tables. Sidebar selection, expanded rows, dialogs, confirmations and drafts are all Eta output derived from Deno state.

### Dialogs and drafts

Root, Command, Settings, confirmation and message state belongs to Deno. Input events update the corresponding server draft even when no immediate render is needed, so an unrelated MCP/SSE update cannot erase partially entered values. Confirmations and errors must be Eta-rendered dialogs, not browser `confirm()` or `alert()` calls.

## Tool-call UI

- Display and filter by the numeric operator Session primary key, never the long `context_handle` or generic context label.
- Apply text, Session, status and page-size filter changes automatically through Deno-owned state; do not add a Tool-call Search button or a second refresh path.
- Use numbered pagination above the table.
- Keep input/output JSON out of compact rows.
- Render details only for the selected primary key.
- Show Terminate/Force controls only for genuinely cancellable work.
- Display complete timestamps plus compact relative ages.

## Processes and PATH

The system-PATH setting is enabled by default.

- ON: prepend `.mrmcp/bin` to the supplied or inherited `PATH`.
- OFF: use only `.mrmcp/bin` in the child `PATH`.
- Use `ComSpec` on Windows and `SHELL` or `/bin/sh` on Unix.
- Keep managed process access scoped to the exact `context_handle`; retain the root and cwd snapshot captured at process start.

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

## Documentation requirements

README must describe current behavior, not only past changes. It must include:

- startup and files;
- protocol rationale and explicit context capability lifecycle;
- the distinction between GUI Sessions and protocol sessions;
- authentication and database policy;
- roots, commands, processes, text encoding and TLS;
- the event-driven UI and ephemeral state model;
- a development changelog, with reverted architecture experiments clearly marked as superseded.

Update README, AGENTS, the source header and `VERSION` together for every release.

## Release checks

1. Syntax-check `mrmcp.js` as an ES module.
2. Extract and syntax-check the embedded browser module and JavaScript worker.
3. Compile/render every Eta fragment with representative data, including all eight sections and every dialog kind.
4. Verify sidebar input travels over WebSocket, changes Deno `uiState.currentSection`, queues a render and produces SSE HTML.
5. Verify the browser bundle contains no application-state object, business logic or administrative JSON fetches.
6. Verify expanded Tool-call and HTTP rows survive relevant backend renders by database primary key.
7. Verify `buildUiRenderModel()` queries only the active section.
8. Verify input events update Deno drafts before unrelated backend renders.
9. Verify the render queue coalesces bursts, never renders concurrently and performs a follow-up pass when dirtied during rendering.
10. Build an empty SQLite database and verify `PRAGMA user_version` and the exact schema.
11. Confirm no migrations, `ALTER TABLE`, legacy identifiers or old configuration imports exist.
12. Confirm only MCP `2026-07-28` is advertised and no transport-session headers are used.
13. Confirm missing/valid/invalid/expired context-handle paths do or do not execute exactly as documented.
14. Confirm no approval, `allow_re`, `deny_re` or tool-enable policy remains.
15. Confirm no UI polling interval, auto-refresh control or manual refresh path exists; Tool-call filters must update through the single Deno render queue.
16. Confirm backend log, context, root, process, debug, OAuth, settings and TLS mutations enter the same Deno render queue.
17. Confirm every visible open/close/select/navigation transition is represented in Deno `uiState` and is produced by Eta, not by an imperative browser DOM mutation.
18. Confirm expanded-row state uses database primary keys and remains correct when pagination or new rows change table order.
19. Confirm inactive sections perform no section-specific database queries during a render.
20. Confirm the WebView only sends normalized input envelopes, receives SSE renders, invokes Morphlex and restores Deno-supplied focus/scroll metadata.
21. Confirm `context_info` returns the current absolute root and the root-level `AGENTS.md` / `agents.md` path when present, and returns `null` when absent.
22. Confirm every built-in tool exposes a strict tool-specific output schema layered on the common context envelope.
23. Confirm `glob`, `grep` and `replace` implement every documented traversal, exclusion, encoding, size-limit and expected-count argument without shell, `uv` or Python helpers.
24. Confirm no Tauri, Rust, Neutralinojs, npm project or CLI files exist.
25. Confirm Session rows, Tool-call rows and the Tool-call Session filter use `contexts.id` / `logs.context_id`, while MCP requests still use the opaque handle.
26. Confirm the archive contains exactly the five root project files.
27. Run the desktop WebView on a machine with Deno and platform dependencies.
