# MRMCP

MRMCP is a single-file Deno MCP desktop server with a local WebView administration interface.

It exposes project-scoped filesystem, process, command-catalog and persistent JavaScript tools through MCP, with named workspace roots, execution policies, OAuth or Basic authentication, TLS automation and local observability.

## Files tracked in this repository

- `mrmcp.js` — server, backend and administration GUI.
- `morphlex.js` — vendored client-side DOM morphing module used by the GUI.
- `AGENTS.md` — detailed architecture, behavior and release requirements.

Local runtime state, downloaded executables, command configuration, certificates, databases and backups are intentionally not tracked.

## Requirements

- Deno 2.9.x
- Windows or Linux
- Administrative privileges when binding public ports 80 and 443

## Run

Place `mrmcp.js` and `morphlex.js` in the same directory, then run:

```sh
deno run -A --unstable-ffi --unstable-worker-options mrmcp.js
```

The administration GUI is available locally at:

```text
http://127.0.0.1:7332/
```

Runtime data is stored in `.mrmcp` beside the script.

## Local command catalog

An optional untracked `commands.yaml` beside `mrmcp.js` defines extra logical commands. If it is absent, MRMCP starts with an empty explicit catalog and can still discover executable files placed directly in `.mrmcp/bin`.

Minimal example:

```yaml
commands:
  - logical_name: git
    description: Distributed version-control CLI.
    enabled: true
```

See `AGENTS.md` for the full command schema, protocol behavior, security model and release checks.
