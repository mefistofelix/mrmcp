<p align="center"><img src="./assets/mrmcp-logo.png" alt="MrMCP" width="180"></p>

# MrMCP 0.10.117

MrMCP is a stateless Model Context Protocol server implemented in Deno. It exposes one authenticated `/mcp` endpoint, Workspace-scoped Sessions, filesystem and process tools, OAuth/Basic authentication, TLS automation, and a local Tauriless administration UI.

![MrMCP Tool Calls view](./assets/mrmcp-screenshot1.png)

![MrMCP Workspaces and Sessions view](./assets/mrmcp-screenshot2.png)

## Features

- MCP `2026-07-28` with explicit `context_handle` Session capabilities.
- Named Workspaces with drag-and-drop Session assignment.
- AAF desktop automation through `desktop_auto`, including zero/one/many model-visible WebP/PNG screenshots mixed with structured OCR, geometry and state output; the local Automation page reuses recorded Tool Calls/screenshots for inspection and can replay a scenario directly as a local user action without creating another Tool Call.
- Low-level dependency-free Chrome DevTools Protocol control through always-batched `cdp_call`, with persistent browser/profile and logical page labels plus subscription/poll access to CDP notifications; the local Browser page summarizes existing profile/target/ring/subscription state, filters recorded sends by browser/target/Session/activity and can replay an individual recorded operation directly without creating another Tool Call.
- Explicit persistent Session/Workspace key-value memory through `memory_find` and `memory_set`, with explicitly typed JSON/text values, TTL and a local Memory manager.
- Filesystem, text search/editing, reversible trash and generated-file publishing.
- Foreground and persistent processes with progress streaming when requested.
- Persistent JavaScript kernels scoped to Session + Workspace.
- Extra command catalog through `commands.yaml`.
- User-managed MCP guided prompts through `guided_prompts.yaml`, with Eta templates, two editable starter examples (one argument-free and one parameterized), and a built-in template/model help view.
- OAuth and Basic authentication.
- Automatic TLS/certificate handling.
- Tool Call and optional HTTP diagnostic logs, with confirmed page-level Clear actions for Tool Calls, Sessions, Workspaces, OAuth Clients and HTTP history.
- Local desktop UI with system tray and native notifications.
- One MIME-aware `publish` MCP App helper for Workspace paths, direct text and Base64 bytes, with persistent deduplicated `.mrmcp/publish/` files, inline/download presentation hints, multi-Workspace publication references and a local Published manager for filtering, native opening and deletion.

## Requirements

- Deno with `node:sqlite` support.
- A Tauriless-supported platform.
- Permission to bind public ports 80 and 443 when those listeners are enabled.

## Run

Desktop GUI:

```bash
deno run -A --unstable-ffi mrmcp.js
```

Headless backend:

```bash
deno run -A mrmcp.js --backend
```

Register a Workspace without starting the server:

```bash
deno run -A mrmcp.js --add-workspace "Workspace name" "/path/to/workspace"
```

The desktop UI is local-only and opens no GUI TCP listener. Public MCP/OAuth traffic uses HTTP/HTTPS listeners; occupied base ports fall back in `+50` steps without rewriting configuration.

## Workspaces and Sessions

MrMCP keeps transport state stateless. Persistent application state is selected explicitly with a `context_handle`.

1. Call `list_workspaces` to discover enabled Workspace names.
2. Call `open_workspace(name)` to create a Session in an existing Workspace. When you explicitly want a missing Workspace created as a new empty Desktop folder, call `open_workspace(name, create=true)` instead; missing names are never created implicitly.
3. Reuse the returned `context_handle` on later Session-bound tools.
4. To move the same Session, call `open_workspace(name, current_context_handle)`.

`open_workspace` also returns the Workspace name, absolute working directory, optional `agent_guidance_path`, whether this call created the Workspace, and a compact Memory summary containing live counts plus up to five latest keys for Workspace and Session scope. Guidance resolution prefers Workspace-root `AGENTS.md` / `agents.md` and falls back to `CLAUDE.md` / `Claude.md` / `claude.md`; when the returned path is present, read and follow it before repository work.

The administration UI displays Sessions with short numeric ids. The opaque `ctx_...` value remains the MCP bearer capability. A Session may move between Workspaces, while historical Tool Calls retain the Workspace snapshot captured when each call started.

## Tools

Session and Workspace:

- `list_workspaces`, `open_workspace`, `tools_log`

Desktop and browser automation:

- `desktop_auto` — execute one AAF YAML scenario through Auto.js; arbitrary final state is preserved and retained screenshots are returned directly as MCP image content for model vision.
- `cdp_call` — send an always-present `calls[]` batch spanning browsers/targets; each entry may omit `browser` to use the persistent `main` profile. Entries may be untouched standard CDP `{method,params}` or namespaced `_mrmcp` XPath `click`/`find` operations; standard `Page.captureScreenshot` may optionally return a Base64 screenshot post-processed through the public Auto.js `auto.vips` API to scaled WebP (current encoder Q=80) while preserving all normal CDP screenshot params.
- `cdp_subs`, `cdp_poll` — add/remove runtime subscriptions (including `*`, target/method-prefix and full-message regex filters) and read bounded CDP traffic through ascending cursors or ad-hoc polling.

Memory:

- `memory_find` — search the explicitly selected current-Session or named-Workspace memory by exact/prefix key, text, set date and stable pagination.
- `memory_set` — set/replace/delete text values with explicit `json=true|false`; JSON text is validated before storage, with optional TTL in the selected Session or Workspace scope.

The desktop **Memory** page filters stored values by Session, Workspace, scope, set date and text, labels JSON vs TEXT, and allows creation, full value/type/TTL inspection, editing and confirmed deletion. New entries explicitly choose an existing Session or Workspace owner. JSON values use an editable JSON tree with node-level operations; text values use the plain text editor, and switching TEXT ↔ JSON never discards the current draft value. Expired TTL rows are removed automatically; Clear Operational Data preserves Memory.

Filesystem:

- `fs_glob`, `fs_grep`, `fs_read`, `fs_navigate`, `fs_stat`
- `fs_write`, `fs_edit`
- `fs_mkdir`, `fs_copy`, `fs_move`, `fs_trash`, `fs_restore`
- `publish` — publish exactly one Workspace path, text string or Base64 payload with a required MIME type, optional filename/title/description and an `auto|inline|download` presentation hint.

The `fs_*` surface is multi-file where appropriate, stateless for navigation/pagination, uses opaque file fingerprints for optimistic concurrency, and reports independent per-entry outcomes instead of cross-entry rollback. See `TOOLS.md` for the complete tool contracts and rationale.

Commands and execution:

- `discover_commands` returns the complete available extra-command catalog in YAML order, with descriptions and documentation links. Agent discovery can be globally enabled/disabled from the Commands page without changing the catalog or executables.
- `exec`, `exec_start`, `exec_attach`, `exec_write`, `exec_kill`, `exec_list`, `exec_status`
- `js`, `js_add_node_module_dir`, `js_reset`
- `tools_schema` — inspect canonical live MCP descriptors; `tools_log` — query Tool Calls that reached the current Session.
- `telegram_req` — make one generic pre-authenticated Telegram Bot API JSON request using the Bot token configured by the user in Settings.

Filesystem removal is reversible: `fs_trash`/`fs_restore` use explicit `trash_id` transactions instead of a permanent delete tool. All Workspaces share the single MrMCP-managed `APP_DIR/.mrmcp/trash/` store; MrMCP never creates `.mrmcp` metadata directories inside named Workspaces.

Persistent processes use the integer `exec_id` returned by `exec_start`; follow-up process tools require the same Session `context_handle`.

## Guided prompts

`guided_prompts.yaml` is the authoritative guided-prompt catalog exposed through MCP `prompts/list` and `prompts/get`. The local Guided Prompts page creates, edits and deletes entries directly in that file. Templates use Eta and receive prompt arguments plus sanitized server/runtime context; when a prompt declares and receives a valid `context_handle`, the template also gets that Session and its current Workspace. The Guided Prompts page has a dedicated Template Help view with the YAML shape, Eta examples and model fields.

## Authentication and networking

Authenticated OAuth or Basic clients receive the published tools; anonymous clients do not.

The only public MCP protocol endpoint is `/mcp`. MrMCP advertises MCP `2026-07-28` and does not use `Mcp-Session-Id` transport sessions. Ordinary calls return JSON. Foreground process calls can use request-scoped SSE progress when `_meta.progressToken` is supplied, while the final result still contains the complete transcript.

Base public ports are:

- HTTP `80` — ACME HTTP-01.
- HTTPS `443` — MCP, OAuth and metadata.

ACME HTTP-01 is available only while the effective HTTP listener remains on port 80.

## Desktop application

Desktop mode uses Tauriless from npm latest and keeps the native event loop plus Deno backend Worker in one OS process. The window can be hidden to the tray without stopping MrMCP. Native directory drops can add Workspaces, and Session/Workspace/Tool Call notifications are configurable independently.

Windows standalone builds use `--no-terminal` and the versioned application icon. macOS releases are Finder-launchable `MrMCP.app` bundles distributed inside DMG images.

## Release binaries

A version tag matching `mrmcp.js` `VERSION` triggers `.github/workflows/release.yml`. The GitHub Release contains:

- `mrmcp-windows-x64.exe`
- `mrmcp-linux-x64`
- `mrmcp-macos-x64.dmg`
- `mrmcp-macos-arm64.dmg`

The macOS app is currently ad-hoc signed; warning-free first launch of an Internet-downloaded build requires Developer ID signing and Apple notarization.

## Project files

- `mrmcp.js` — server, tools, SQLite, local UI and desktop launcher.
- `commands.yaml` — editable extra-command catalog.
- `guided_prompts.yaml` — editable MCP guided-prompt catalog and Eta templates.
- `README.md` — current user/operator overview.
- `CHANGELOG.md` — release history.
- `AGENTS.md` — implementation invariants and release checks.
- `.github/workflows/` — release and native macOS GUI test workflows.
- `assets/` — Morphlex, branding, icons and screenshots.

Runtime data lives under `.mrmcp`. Packaged macOS builds keep mutable state, `commands.yaml` and `guided_prompts.yaml` under `~/Library/Application Support/MrMCP/` rather than inside the application bundle.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
