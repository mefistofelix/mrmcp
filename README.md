<p align="center"><img src="./assets/mrmcp-logo.png" alt="MrMCP" width="180"></p>

# MrMCP 0.10.111

MrMCP is a stateless Model Context Protocol server implemented in Deno. It exposes one authenticated `/mcp` endpoint, Workspace-scoped Sessions, filesystem and process tools, OAuth/Basic authentication, TLS automation, and a local Tauriless administration UI.

![MrMCP Tool Calls view](./assets/mrmcp-screenshot1.png)

![MrMCP Workspaces and Sessions view](./assets/mrmcp-screenshot2.png)

## Features

- MCP `2026-07-28` with explicit `context_handle` Session capabilities.
- Named Workspaces with drag-and-drop Session assignment.
- Filesystem, text search/editing, reversible trash and generated-file publishing.
- Foreground and persistent processes with progress streaming when requested.
- Persistent JavaScript kernels scoped to Session + Workspace.
- Extra command catalog through `commands.yaml`.
- User-managed MCP guided prompts through `guided_prompts.yaml`, with Eta templates and a built-in template/model help view.
- OAuth and Basic authentication.
- Automatic TLS/certificate handling.
- Tool Call and optional HTTP diagnostic logs, with confirmed page-level Clear actions for Tool Calls, Sessions, Workspaces, OAuth Clients and HTTP history.
- Local desktop UI with system tray and native notifications.
- `publish_file` and `publish_html` MCP App presentation helpers with persistent deduplicated `.mrmcp/publish/` snapshots, serialized publication writes, multi-Workspace publication references and a local Published manager for filtering, native opening and deletion.

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

1. Call `list_workspaces` to discover enabled Workspace names; when a new empty Workspace is needed, `create_workspace(name)` creates and registers it on the user's Desktop without exposing or accepting its path.
2. Call `open_workspace(name)` to create a Session in that Workspace.
3. Reuse the returned `context_handle` on later Session-bound tools.
4. To move the same Session, call `open_workspace(name, current_context_handle)`.

`open_workspace` also returns the Workspace name, absolute working directory and optional `agent_guidance_path`. Guidance resolution prefers Workspace-root `AGENTS.md` / `agents.md` and falls back to `CLAUDE.md` / `Claude.md` / `claude.md`; when the returned path is present, read and follow it before repository work.

The administration UI displays Sessions with short numeric ids. The opaque `ctx_...` value remains the MCP bearer capability. A Session may move between Workspaces, while historical Tool Calls retain the Workspace snapshot captured when each call started.

## Tools

Session and Workspace:

- `list_workspaces`, `create_workspace`, `open_workspace`, `query_tool_calls`

Filesystem:

- `fs_glob`, `fs_grep`, `fs_read`, `fs_navigate`, `fs_stat`
- `fs_write`, `fs_edit`
- `fs_mkdir`, `fs_copy`, `fs_move`, `fs_trash`, `fs_restore`
- `publish_file`, `publish_html`

The `fs_*` surface is multi-file where appropriate, stateless for navigation/pagination, uses opaque file fingerprints for optimistic concurrency, and reports independent per-entry outcomes instead of cross-entry rollback. See `TOOLS.md` for the complete tool contracts and rationale.

Commands and execution:

- `discover_commands` returns the complete available extra-command catalog in YAML order, with descriptions and documentation links. Agent discovery can be globally enabled/disabled from the Commands page without changing the catalog or executables.
- `exec`, `exec_start`, `exec_attach`, `exec_write`, `exec_kill`, `exec_list`, `exec_status`
- `js`, `js_add_node_module_dir`, `js_reset`

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

Desktop mode uses Tauriless `0.1.17` and keeps the native event loop plus Deno backend Worker in one OS process. The window can be hidden to the tray without stopping MrMCP. Native directory drops can add Workspaces, and Session/Workspace/Tool Call notifications are configurable independently.

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
