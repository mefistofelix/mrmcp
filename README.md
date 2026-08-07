# MrMCP 0.10.46

MrMCP is a stateless Model Context Protocol server implemented in Deno. It exposes one authenticated MCP endpoint at `/mcp`, a loopback administration interface, filesystem and text-editing tools, an extra-command catalog, managed processes, a persistent JavaScript worker, OAuth and Basic authentication, TLS automation, and explicit `context_handle` capabilities for persistent application state.

![MrMCP administration interface](./mrmcp-screenshot.png)

The desktop window uses `jsr:@webview/webview@0.9.0`, imported directly by Deno. The project has no Node.js application, npm install, CLI scaffold, Rust, Tauri or Neutralinojs runtime.

## Project files

- `mrmcp.js` — backend, MCP endpoint, SQLite schema, administration UI and desktop launcher.
- `morphlex.js` — DOM morphing engine used after Eta renders updated HTML.
- `commands.yaml` — metadata for optional executables in `.mrmcp/bin`.
- `README.md` — user and operator documentation.
- `AGENTS.md` — implementation invariants and release checks.

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

Successful tool results contain the compact state envelope:

```json
{
  "context_handle": "ctx_...",
  "context_status": "active",
  "operation_executed": true
}
```

Recovery responses additionally set `isError: true`, `operation_executed: false`, `retry_required: true`, `recovery_tool: "create_context"` and a recovery message. Possible statuses are `active`, `invalid` and `expired`. Contexts expire after 30 days without activity.

The handle itself selects the context after authentication. MrMCP does not bind contexts, processes or JavaScript kernels to the OAuth client or Basic credential that created them. Any authenticated client possessing a valid handle can use that context.

### Why the GUI says “Sessions”

The administration interface labels contexts **Sessions** because that is convenient for operators. This is only a GUI term. MrMCP does not implement protocol sessions and does not use `Mcp-Session-Id`.

## Authentication and tool access

Authentication controls access to MrMCP; `context_handle` selects persistent state after authentication.

- Authenticated OAuth or Basic clients receive every published built-in and custom tool.
- Anonymous clients receive no tools and cannot execute operations.
- There are no tool approvals, enable lists, execution switches, `allow_re`, `deny_re` or user-defined per-tool policies.
- OAuth consent authorizes the client itself, not an individual tool call.

The only public MCP endpoint is `/mcp`. OAuth protected-resource metadata is exposed for that single resource.

## Database policy

Development builds use one exact current SQLite schema and no compatibility layer.

- The database is `.mrmcp/mrmcp.sqlite` beside the application.
- `PRAGMA user_version` must exactly equal `DB_SCHEMA_VERSION`.
- A non-empty database with another version is rejected before schema changes.
- There are no migrations, `ALTER TABLE` upgrades, backfills, aliases, old-key imports or legacy identifier acceptance.
- After an incompatible development change, stop MrMCP and delete `.mrmcp/mrmcp.sqlite`.

The current schema uses `server_config`, `roots`, `contexts`, `logs.context_handle` and `process_runs.context_handle`. A context stores exactly one current `root_id`; root id `0` denotes the directory containing `mrmcp.js`.

## Roots and filesystem isolation

The Roots page lets the operator register named absolute directories and assign one current root to each Session.

- A root may be assigned to any number of contexts.
- Every context always has exactly one effective root.
- A new context starts on the fallback root beside `mrmcp.js`.
- Changing a Session's root affects new tool calls immediately.
- Existing background or interactive processes continue in the directory where they started.
- Disabling or deleting a root moves currently associated contexts to the fallback root without terminating processes.

The public `context_info` tool returns the absolute root directory currently assigned to the supplied context plus `agent_guidance_present` and a nullable absolute `agent_guidance_path`. MrMCP checks only the root-level `AGENTS.md`, then `agents.md`; it does not scan parent or child directories. When the path is present, the agent must read and follow that file before modifying the repository. Root identifiers, available roots and other administrative metadata are not exposed through MCP tools.

All relative paths and new child-process working directories must remain inside the root captured at the start of the tool call.

## Built-in tools

Context and location:

- `create_context`;
- `context_info`.

Filesystem and text:

- `read_file`, `read_files`, `write_file`, `write_files`;
- `glob`, `grep`, `edit`, `replace`;
- `file_info`, `create_directory`, `copy_path`, `move_path`, `delete_path`;
- `publish_file`.

Commands and persistent execution:

- `list_commands`;
- `exec`, `exec_start`, `exec_poll`, `exec_write`, `exec_kill`, `exec_list`;
- `js`, `js_add_node_module_dir`, `js_reset`.

`edit` accepts multiple files and multiple ordered exact edits per file. Each file is read once, its edits are applied sequentially in memory, every expected occurrence count is validated, and all files are written atomically with rollback.

`glob`, `grep` and `replace` are intended to remove the need for improvised `uv`, Python or shell scripts during ordinary repository work:

- `glob` supports a start path, glob pattern, exclusions, hidden files, dependency directories and a result limit;
- `grep` supports literal or regular-expression matching, case sensitivity, globs, exclusions, context lines, hidden/dependency traversal, encoding selection, file-size limits and `content`, `files_with_matches` or `count` output;
- `replace` supports the same traversal controls, literal or regex replacements, preview mode, encoding/BOM/line-ending preservation, atomic rollback and an optional exact `expected_replacements` guard.

Every built-in tool publishes a tool-specific output schema layered on the common `context_handle`, `context_status` and `operation_executed` envelope. Recovery-only fields remain optional so successful results stay compact.

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
- Sessions;
- Roots;
- Commands;
- Tool calls;
- HTTP debug;
- OAuth clients;
- Settings.

Projects, Active calls, Custom tools and Approvals are intentionally absent. The header and window title use **🧩 MrMCP**. Emoji are limited to navigation, headings, principal actions, destructive actions and compact states.

### Deno-owned event-driven rendering model

The GUI has no polling timer, auto-refresh setting, browser-side data fetch loop or duplicate refresh path. Deno is the only owner of graphical state.

The backend keeps one ephemeral `uiState` object containing:

- the current section and per-section scroll positions;
- focus and selection information needed after a morph;
- command search, page, page size and availability filter;
- Tool-call filters, numbered page and expanded database primary key;
- HTTP-debug filters and expanded database primary key;
- active dialog, confirmation or message;
- in-progress Root, Command and Settings drafts;
- self-test output and the last processed browser-input sequence.

The WebView does not keep an application-state object and does not query administrative JSON endpoints. Its responsibilities are deliberately narrow:

1. delegate click, change, input, submit, focus, keyboard and scroll events;
2. serialize those events and send them to Deno over `/api/ui-input` WebSocket;
3. receive complete server-rendered UI HTML over `/api/events` SSE;
4. apply the HTML to `#app` with Morphlex;
5. restore the scroll and focus values supplied by Deno.

Deno processes browser events sequentially. It updates `uiState`, executes database/filesystem/process actions, and schedules a render only when required. MCP calls, process changes, logs, OAuth changes, TLS changes and other backend subsystems use the same render scheduler.

Rendering is queued rather than performed synchronously inside the triggering operation. A short throttle coalesces bursts, only one render runs at a time, and additional requests received during a render cause one subsequent pass. Eta rendering uses its asynchronous API when available. When rendering completes, Deno broadcasts one `render` SSE event containing the full `#app` HTML and the authoritative scroll/focus metadata.

Eta chooses the active section with a conditional. `buildUiRenderModel()` queries only the data required by that section, then Eta renders the sidebar, active section, dialogs and section-specific rows. Inactive sections are neither rendered nor queried. Expanded Tool-call and HTTP rows are identified by their unique database primary key and are reconstructed by Eta after relevant backend events.

Native confirmation and alert state is not kept in the browser. Confirmations, errors and forms are represented in Deno `uiState` and rendered as ordinary Eta dialogs. The browser may perform a local clipboard write because that operation carries no application or graphical state.

### Tool-call log

The Tool calls page supports:

- filter by GUI session and status;
- full-text query;
- numbered pagination above the table;
- complete timestamps with compact relative ages;
- compact rows without inline input/output JSON;
- Eta-rendered expanded details;
- Terminate and Force controls only when cancellation is real.

## TLS and connectivity

MrMCP uses fixed public listeners:

- port 80 for ACME HTTP-01 challenges;
- port 443 for MCP, OAuth and metadata;
- loopback port 7332 for the administration UI.

The Settings and Dashboard pages display listener state, active certificate, validity, trust, expiry, ACME request history, backoff and next attempt. A valid certificate already stored in `.mrmcp` is reused.

## Development changelog

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
- Added root snapshots to tool-call and process logs and moved the clean SQLite schema to version 2.

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
