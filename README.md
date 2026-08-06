# MRMCP

MRMCP is a desktop Model Context Protocol server for Deno. It gives ChatGPT and other remote MCP clients controlled access to selected local directories, file operations, commands, managed processes, and a persistent JavaScript worker.

The server includes a local WebView administration interface for projects, roots, authentication, enabled tools, execution policy, TLS, logs, processes, and downloadable command configuration.

## What is included

- `mrmcp.js` — server, backend, local administration GUI, OAuth, TLS, MCP tools and process management.
- `morphlex.js` — local browser module used by the administration GUI.
- `AGENTS.md` — implementation notes and release requirements for contributors and coding agents.

Runtime data is deliberately kept outside Git:

- `.mrmcp/` — SQLite database, certificates, downloaded executables and runtime state.
- `commands.yaml` — optional local extra-command catalog.
- backups, binaries and machine-specific configuration.

## Requirements

- Deno 2.9.x.
- Windows or Linux with a supported system WebView.
- Administrator/root privileges when binding public ports 80 and 443.
- A public IPv4 address reachable from the internet on TCP ports 80 and 443 when connecting ChatGPT directly.
- Router port forwarding and firewall rules for ports 80 and 443 when the machine is behind a router.

A self-signed certificate is enough for local diagnostics, but ChatGPT requires a publicly trusted HTTPS certificate.

## Run with Deno

Keep `mrmcp.js` and `morphlex.js` in the same directory and run:

```sh
deno run -A --unstable-ffi --unstable-worker-options mrmcp.js
```

The local administration GUI opens automatically and is also available at:

```text
http://127.0.0.1:7332/
```

MRMCP stores runtime data in `.mrmcp` beside `mrmcp.js`.

### Run and restart automatically while editing

```sh
deno run --watch=mrmcp.js,morphlex.js -A --unstable-ffi --unstable-worker-options mrmcp.js
```

The WebView process is restarted when either source file changes.

### Check the source without starting the server

```sh
deno check mrmcp.js
deno check morphlex.js
```

## Create a standalone executable with Deno

`deno compile` produces a self-contained executable that does not require Deno on the destination machine.

### Windows x64

```sh
deno compile -A --unstable-ffi --unstable-worker-options \
  --include morphlex.js \
  --target x86_64-pc-windows-msvc \
  --output mrmcp.exe \
  mrmcp.js
```

Run it with:

```powershell
.\mrmcp.exe
```

### Linux x64

```sh
deno compile -A --unstable-ffi --unstable-worker-options \
  --include morphlex.js \
  --target x86_64-unknown-linux-gnu \
  --output mrmcp \
  mrmcp.js
chmod +x mrmcp
./mrmcp
```

### Build for the current platform

```sh
deno compile -A --unstable-ffi --unstable-worker-options --include morphlex.js --output mrmcp mrmcp.js
```

The compiled program stores `.mrmcp` and reads the optional external `commands.yaml` beside the executable. `morphlex.js` is embedded by `--include`, so it does not need to be distributed separately.

The ordinary `deno compile` command already creates a standalone executable. Do not add the experimental `--bundle` option: MRMCP uses workers and dynamic imports, and the normal compiler preserves those patterns correctly.

On Windows, `--no-terminal` may be added for a GUI-only build, but keeping the terminal visible is recommended during initial configuration so startup and TLS errors remain visible.

## First-time setup

1. Start MRMCP with administrator/root privileges.
2. Open the local GUI.
3. In **Settings**, detect the public IPv4 address and enter a valid email address for Let's Encrypt.
4. Confirm that ports 80 and 443 are forwarded to this machine and allowed by the firewall.
5. Wait for the dashboard to show a trusted certificate.
6. Create or edit a project.
7. Add one or more named root directories.
8. Enable only the tools that the project should expose.
9. Copy the project's public `sslip.io` HTTPS MCP endpoint from **Endpoints**.

## Projects, roots and permissions

A project is an independently configured MCP endpoint. Each project has its own:

- slug and public endpoint;
- enabled state;
- OAuth and optional Basic authentication;
- permitted filesystem roots;
- enabled tools;
- process-execution switch;
- confirmation policy;
- optional allow and deny regular expressions.

Every connected client receives a default workspace session. A workspace selects exactly one named root at a time. File paths and command working directories are normal paths relative to that selected root and cannot escape it.

### Enable write access on the MRMCP server

Open **Projects**, edit the project, and configure:

1. Turn on **Enabled**.
2. Turn on **OAuth enabled** for ChatGPT Web.
3. Check the required write tools under **Enabled tools**:
   - `write_file`
   - `write_files`
   - `edit_file`
   - `edit_files`
   - `replace_files`
   - `create_directory`
   - `copy_path`
   - `move_path`
   - `delete_path`
4. Turn on **Process execution enabled** only when the project should expose `exec`, background-process tools, or JavaScript-worker tools.
5. Set **Confirmation**:
   - `Allow` — MRMCP executes permitted calls immediately.
   - `Ask` — read-only calls run directly; write/destructive calls wait for approval in the local GUI.
   - `Deny` — calls are rejected unless an allow regular expression matches.
6. Optionally use **Allow regex** and **Deny regex** for more specific rules. The deny expression is evaluated first.
7. Save the project.

MRMCP permission and ChatGPT permission are separate layers. Even when MRMCP is set to `Allow`, ChatGPT may still ask the user to confirm a write or modify action.

## Connect MRMCP to ChatGPT Web

ChatGPT connects to a remote HTTPS MCP endpoint; it does not connect directly to `localhost`. The public MRMCP endpoint therefore needs a trusted certificate and must be reachable from OpenAI over the internet. OpenAI also documents a Secure MCP Tunnel option for private/on-premises servers where available.

OpenAI currently documents full custom-MCP write/modify support for ChatGPT Business, Enterprise and Edu workspaces on the web. Pro developer mode can connect custom MCP servers with read/fetch permissions, while full write actions depend on plan and workspace rollout. The interface and plan availability may change.

Official current setup reference:

- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta

### 1. Prepare the MRMCP project

In the MRMCP GUI:

1. Create or edit the project.
2. Enable the project and OAuth.
3. Enable the desired read and write tools.
4. Enable process execution only when needed.
5. Choose `Allow` or `Ask` as the MRMCP confirmation policy.
6. Confirm that the dashboard reports a trusted certificate.
7. Copy the project's **MCP sslip.io** HTTPS URL, for example:

```text
https://203-0-113-10.sslip.io/mcp/default
```

OAuth is the recommended authentication method for ChatGPT. Basic authentication remains available for compatible MCP clients and diagnostics, but credentials embedded in URLs should not be shared or logged.

### 2. Enable ChatGPT developer mode

On ChatGPT Web, use the settings available to your workspace:

- Business admins/owners: **Workspace settings → Apps → Create**, or enable developer mode in the advanced Apps settings.
- Enterprise/Edu: an admin first grants developer access through workspace permissions/RBAC; the authorized user then enables **Settings → Apps → Advanced Settings → Developer mode**.

The exact labels can change while the feature remains in beta.

### 3. Create the custom MCP app

1. Open **Settings or Workspace settings → Apps → Create**.
2. Enter a name such as `MRMCP`.
3. Paste the public MRMCP project endpoint.
4. Select OAuth authentication.
5. Choose **Scan Tools**.
6. Complete the MRMCP OAuth authorization page.
7. Wait for ChatGPT to finish scanning the tool definitions.
8. Create/save the app.

The development app appears in the enabled Apps list with a development label and, for managed workspaces, as a draft until it is published.

### 4. Enable write actions in ChatGPT

ChatGPT has its own action controls in addition to the MRMCP project controls.

1. Open the custom app's menu in **Workspace settings → Apps**.
2. Open **Action control** or **Configure Actions**.
3. Choose **Allow all actions**, or choose a custom action set.
4. When using a custom set, explicitly enable the MRMCP write tools listed above and any required process/JavaScript tools.
5. Publish or save the action configuration as required by the workspace.

New or changed actions are not enabled automatically. After changing enabled tools or schemas in MRMCP, use **Refresh** or rescan the app in ChatGPT, review the differences, and explicitly enable newly discovered write actions. Some workspace plans require recreating and republishing an app after changes.

### 5. Use MRMCP in a chat

1. Start a new ChatGPT Web conversation.
2. Select the MRMCP app from the tools/apps menu, or refer to it in the prompt.
3. Ask ChatGPT to operate inside one of the configured roots.
4. Approve actions when ChatGPT or the local MRMCP GUI asks for confirmation.

Custom MCP apps currently operate on ChatGPT Web; mobile support and agent/deep-research behavior may differ. Deep research is limited to read/fetch actions.

## sslip.io and Let's Encrypt overview

MRMCP can expose a trusted HTTPS address without requiring the user to purchase or manually configure a DNS domain.

The flow is:

1. MRMCP detects the machine's public IPv4 address.
2. It converts that address into an `sslip.io` hostname. For example, `203.0.113.10` becomes `203-0-113-10.sslip.io`.
3. `sslip.io` resolves that hostname back to the embedded IPv4 address.
4. MRMCP requests a certificate from Let's Encrypt for that hostname.
5. Let's Encrypt performs an HTTP-01 validation on public port 80.
6. During validation, MRMCP serves only the active ACME challenge token under `/.well-known/acme-challenge/...`; every other port-80 request returns `404`.
7. After validation, the trusted certificate is used by the MCP/OAuth HTTPS server on port 443.
8. MRMCP stores the certificate locally and renews it automatically before expiration while respecting retry and rate-limit delays.

The public architecture is therefore:

```text
ChatGPT → HTTPS 443 → public IPv4 / sslip.io hostname → MRMCP project endpoint
Let's Encrypt → HTTP 80 → temporary ACME challenge only
Local user → HTTP 127.0.0.1:7332 → administration GUI
```

If Let's Encrypt is unavailable, MRMCP keeps HTTPS alive with a separate self-signed fallback certificate. Local diagnostics continue to work, but ChatGPT rejects the endpoint until a trusted certificate is active.

If the public IPv4 address changes, run public-IP detection again. The `sslip.io` hostname changes with the address, so MRMCP must obtain a matching certificate. Connections also fail when the ISP uses CGNAT or blocks inbound ports 80/443 unless a supported tunnel or public reverse proxy is used.

## HTTP compression and connection efficiency

MRMCP negotiates response compression through `Accept-Encoding`:

- Brotli (`br`) and gzip are supported.
- Client quality values (`q`) are respected; Brotli wins when quality is equal.
- Compression is applied to JSON, text, JavaScript, YAML, XML and SVG responses of at least 1 KiB.
- OAuth endpoints and responses that set cookies are not compressed, avoiding compression of authentication material.
- Images, PDFs, archives, executable files, databases and other already-compressed/binary responses are not recompressed.
- Partial responses, explicitly encoded responses and `Cache-Control: no-transform` responses are left unchanged.
- Compressible responses include `Vary: Accept-Encoding`.

This mainly reduces the initial tool scan and large file/search results. Small MCP calls remain uncompressed to avoid wasting CPU and adding latency.

Other connection-efficiency choices include compact tool descriptors, incremental process-output offsets, one-year OAuth access tokens with reusable refresh tokens, and temporary file links instead of placing large binary data inside JSON.

# MCP tool reference

The following tools are the built-in tools that a project can expose. The project administrator may disable any of them.

## Common path and session rules

- `path`, `from`, `to` and `cwd` are relative to the workspace's selected root unless otherwise stated.
- `session_id` is optional. Omit it to use the client's default workspace session.
- `expected_sha256` is an optional optimistic-concurrency check. The operation fails rather than overwriting a file that changed unexpectedly.
- Tools cannot escape the selected root through `..`, absolute paths, symlinks or alternate root syntax.

## Workspace

### `workspace`

Lists roots and manages logical workspace sessions.

| Argument | Required | Meaning |
|---|---:|---|
| `action` | No | `status` (default), `list_roots`, `new`, `select`, or `delete`. |
| `session_id` | No | Existing workspace session for `status`, `select`, or `delete`. |
| `label` | No | Human-readable label used when creating a new session. |
| `root` | No | Named project root selected by `new` or `select`. |

The default workspace cannot be deleted.

## File reading and discovery

### `read_file`

Reads one UTF-8 text file.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | File to read. |
| `start_line` | No | First line, starting at 1. |
| `end_line` | No | Last line, inclusive. |
| `session_id` | No | Workspace session. |

Use `publish_file` rather than `read_file` for binary files.

### `read_files`

Reads several UTF-8 files in one call.

| Argument | Required | Meaning |
|---|---:|---|
| `paths` | Yes | Array of 1–100 file paths. |
| `max_bytes_per_file` | No | Per-file limit; default 1 MiB, maximum 5 MiB. |
| `session_id` | No | Workspace session. |

### `list_files`

Recursively lists files using a glob pattern.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | No | Starting directory; default `.`. |
| `pattern` | No | Glob; default `**/*`. |
| `include_hidden` | No | Include hidden files/directories. |
| `include_dependencies` | No | Include dependency directories normally filtered from broad listings. |
| `limit` | No | Maximum returned entries, up to 10,000. |
| `session_id` | No | Workspace session. |

### `search_files`

Searches text with a literal string or regular expression.

| Argument | Required | Meaning |
|---|---:|---|
| `query` | Yes | Text or regular expression to find. |
| `path` | No | Starting directory; default `.`. |
| `pattern` | No | File glob; default `**/*`. |
| `regex` | No | Interpret `query` as a regular expression. |
| `case_sensitive` | No | Enable case-sensitive matching. |
| `max_results` | No | Maximum matches, up to 2,000. |
| `session_id` | No | Workspace session. |

### `file_info`

Returns metadata for one file or directory.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | File or directory. |
| `session_id` | No | Workspace session. |

## File creation and modification

### `write_file`

Creates or completely overwrites one UTF-8 file.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | Destination file. |
| `content` | Yes | Complete UTF-8 content. |
| `create_parents` | No | Create missing parent directories; default `true`. |
| `expected_sha256` | No | Require the existing file to have this SHA-256 before writing. |
| `session_id` | No | Workspace session. |

### `write_files`

Validates and writes several UTF-8 files, rolling back when possible if one operation fails.

| Argument | Required | Meaning |
|---|---:|---|
| `files` | Yes | Array of 1–100 objects containing `path`, `content`, and optional `expected_sha256`. |
| `create_parents` | No | Create missing parent directories; default `true`. |
| `session_id` | No | Workspace session. |

### `edit_file`

Replaces exact text inside one file.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | File to edit. |
| `old_text` | Yes | Exact existing text. |
| `new_text` | Yes | Replacement text. |
| `expected_occurrences` | No | Required match count; default `1`. |
| `session_id` | No | Workspace session. |

### `edit_files`

Applies exact replacements to several files with validation and rollback where possible.

| Argument | Required | Meaning |
|---|---:|---|
| `edits` | Yes | Array of 1–200 objects with `path`, `old_text`, `new_text`, and optional `expected_occurrences`. |
| `session_id` | No | Workspace session. |

### `replace_files`

Previews or applies a bulk literal/regular-expression replacement.

| Argument | Required | Meaning |
|---|---:|---|
| `query` | Yes | Text or regular expression to replace. |
| `replacement` | Yes | Replacement text. |
| `path` | No | Starting directory; default `.`. |
| `pattern` | No | File glob; default `**/*`. |
| `regex` | No | Interpret `query` as a regular expression. |
| `case_sensitive` | No | Default `true`. |
| `dry_run` | No | Preview only; default `true`. Set `false` to write. |
| `max_files` | No | Maximum affected files; default 200, maximum 1,000. |
| `session_id` | No | Workspace session. |

### `create_directory`

Creates a directory and any missing parents.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | Directory to create. |
| `session_id` | No | Workspace session. |

### `copy_path`

Copies a file or directory recursively.

| Argument | Required | Meaning |
|---|---:|---|
| `from` | Yes | Existing source path. |
| `to` | Yes | Destination path. |
| `session_id` | No | Workspace session. |

### `move_path`

Moves or renames a file or directory.

| Argument | Required | Meaning |
|---|---:|---|
| `from` | Yes | Existing source path. |
| `to` | Yes | Destination path. |
| `session_id` | No | Workspace session. |

### `delete_path`

Deletes a file or directory.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | Path to delete. |
| `recursive` | No | Required for non-empty directory removal. |
| `session_id` | No | Workspace session. |

## Publishing generated files

### `publish_file`

Publishes an existing workspace file through a temporary HTTPS link. MCP Apps-capable hosts can show the included image-preview interface.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | Existing workspace file. |
| `filename` | No | Filename shown to the receiving user. |
| `mime_type` | No | MIME override; normally omit it. |
| `expires_in` | No | Link lifetime in seconds; default 86,400, minimum 30, maximum 604,800. |
| `one_time` | No | Invalidate the link after its first successful download; default `false`. |
| `return_mode` | No | `link` (default), `inline`, or `both`. Inline output is limited to supported raster images. |
| `session_id` | No | Workspace session. |

Temporary links are held in memory and disappear when MRMCP restarts. Publishing never changes or deletes the original file.

## Extra command catalog

### `list_commands`

Finds installed logical commands configured in `commands.yaml` or discovered directly inside `.mrmcp/bin`.

| Argument | Required | Meaning |
|---|---:|---|
| `query` | No | Case-insensitive search over name, path and description. |
| `page` | No | Page number; default `1`. |
| `page_size` | No | Entries per page; default 25, maximum 100. |

Every returned `logical_name` is directly callable as `exec.program`. Do not first probe it with `where`, `which`, `Get-Command` or filesystem searches. MRMCP resolves logical aliases before the operating-system `PATH`.

## Foreground and background processes

Process tools are exposed only when **Process execution enabled** is active for the project.

### `exec`

Runs a foreground command and waits for completion.

Exactly one of `program` or `shell_command` is required.

| Argument | Required | Meaning |
|---|---:|---|
| `program` | Conditional | Executable or logical name from `list_commands`. |
| `args` | No | Array of separate command arguments; default `[]`. |
| `shell_command` | Conditional | Shell expression used only when pipelines/redirection are genuinely required. |
| `cwd` | No | Working directory relative to the selected root; default `.`. |
| `env` | No | Object of string environment variables. |
| `stdin` | No | Text or Base64 input sent to standard input. |
| `stdin_encoding` | No | `text` (default) or `base64`. |
| `timeout_ms` | No | Default 120,000; maximum 3,600,000. |
| `return_files` | No | Array of 1–16 output files to attach after success, resolved from `cwd`. |
| `return_files_expires_in` | No | Temporary-link lifetime; default 86,400 seconds, maximum 604,800. |
| `return_files_one_time` | No | Make returned links single-use. |
| `return_files_inline` | No | Also return eligible raster images inline; default `true`, combined limit 8 MiB. |
| `session_id` | No | Workspace session. |

For Python, prefer an installed `uv` command:

```text
program: uv
args: ["run", "script.py"]
```

or execute source from `stdin` with:

```text
program: uv
args: ["run", "-"]
```

### `exec_start`

Starts an interactive or background process and returns a `process_id`.

It accepts the same `program`, `args`, `shell_command`, `cwd`, `env`, `stdin`, `stdin_encoding`, and `session_id` fields as `exec`, plus:

| Argument | Required | Meaning |
|---|---:|---|
| `keep_stdin_open` | No | Keep standard input available for `exec_write`; default `true`. |
| `timeout_ms` | No | Default `0` (no configured timeout), maximum 604,800,000. |

Use `exec_poll`, `exec_write`, and `exec_kill` with the returned process ID.

### `exec_poll`

Returns incremental process output and status.

| Argument | Required | Meaning |
|---|---:|---|
| `process_id` | Yes | Managed process identifier. |
| `stdout_offset` | No | Return stdout after this character offset; default `0`. |
| `stderr_offset` | No | Return stderr after this character offset; default `0`. |
| `wait_ms` | No | Wait for new output/status, up to 30,000 ms; default `0`. |

The response includes new offsets for the next poll.

### `exec_write`

Writes to a managed process's standard input or closes it.

| Argument | Required | Meaning |
|---|---:|---|
| `process_id` | Yes | Managed process identifier. |
| `data` | No | Text/Base64 payload; default empty. |
| `encoding` | No | `text` (default) or `base64`. |
| `close` | No | Close standard input after writing; default `false`. |

### `exec_kill`

Terminates a managed process.

| Argument | Required | Meaning |
|---|---:|---|
| `process_id` | Yes | Managed process identifier. |
| `signal` | No | `SIGTERM` (default) or `SIGKILL`. |

### `exec_list`

Lists processes owned by the connected client.

| Argument | Required | Meaning |
|---|---:|---|
| `include_completed` | No | Include recent completed processes; default `true`. |
| `limit` | No | Maximum rows; default 50, maximum 200. |

## Persistent JavaScript worker

JavaScript tools run inside a persistent Deno Worker scoped to the authenticated client, project and workspace. They are exposed only when process execution is enabled.

### `js`

Executes JavaScript in the persistent worker.

| Argument | Required | Meaning |
|---|---:|---|
| `code` | Yes | JavaScript source. Top-level `await` is supported. |
| `cwd` | No | Working directory relative to the selected root; default `.`. |
| `timeout_ms` | No | Default 30,000, maximum 120,000. |
| `session_id` | No | Workspace session. |

State persists between calls. Assign values to `globalThis` when they must survive across top-level asynchronous evaluations.

### `js_add_node_module_dir`

Adds a project directory or `node_modules` directory to the worker's module lookup paths.

| Argument | Required | Meaning |
|---|---:|---|
| `path` | Yes | Directory relative to the selected root. |
| `session_id` | No | Workspace session. |

### `js_reset`

Terminates the current persistent JavaScript worker and clears its state.

| Argument | Required | Meaning |
|---|---:|---|
| `session_id` | No | Workspace session whose worker should be reset. |

## Custom command tools

The GUI can expose an administrator-defined command as its own MCP tool. Each custom tool accepts:

| Argument | Required | Meaning |
|---|---:|---|
| `args` | No | Argument array appended to the configured command. |
| `shell_command_suffix` | No | Optional advanced shell suffix. Use only when the configured command intentionally supports shell syntax. |
| `cwd` | No | Working directory; default `.`. |
| `env` | No | String environment variables. |
| `stdin` | No | Text sent to standard input. |
| `timeout_ms` | No | Default 120,000, maximum 3,600,000. |
| `session_id` | No | Workspace session. |

Custom command tools are treated as write/open-world actions and should be enabled only for trusted commands.

## Local command catalog

An optional untracked `commands.yaml` beside the script or executable defines extra logical commands. Executables are stored below `.mrmcp/bin`.

Minimal example:

```yaml
commands:
  - logical_name: git
    description: Distributed version-control CLI.
    documentation_url: https://git-scm.com/docs
    enabled: true
```

Complete fields:

| Field | Meaning |
|---|---|
| `logical_name` | Name exposed by `list_commands` and accepted by `exec.program`. |
| `path` | Optional path below `.mrmcp/bin`; defaults to `logical_name`. Windows executable suffixes may be omitted. |
| `description` | Agent-facing explanation. |
| `download_url` | Optional direct file or ZIP URL used by the GUI Download action. |
| `documentation_url` | Optional documentation link. |
| `enabled` | Defaults to `true`. |

Files placed directly inside `.mrmcp/bin` are discovered automatically. Nested executable paths require an explicit catalog entry.

## Security guidance

- Expose only roots and tools that are necessary.
- Prefer OAuth for ChatGPT.
- Use `Ask` while testing write or command actions.
- Keep destructive and open-world actions disabled when not required.
- Review the local MCP tool-call log and HTTP debug log.
- Never publish Basic URLs, OAuth tokens, `.mrmcp` databases, private keys or certificate private-key files.
- Connecting an untrusted MCP server or exposing untrusted project content can introduce prompt-injection and command-execution risks.

## Troubleshooting

### ChatGPT cannot connect

Check that:

- the dashboard certificate is trusted rather than self-signed;
- the public IPv4 is current;
- TCP ports 80 and 443 reach the MRMCP machine;
- the ISP is not using CGNAT or blocking inbound ports;
- the copied endpoint is the HTTPS project endpoint, not the local GUI URL;
- the project is enabled and OAuth is enabled;
- the ChatGPT app was rescanned after tool/schema changes.

### Tools appear read-only or write tools are missing

Check both permission layers:

1. In MRMCP, enable the write tools and select `Allow` or `Ask`.
2. In ChatGPT workspace app settings, refresh the action list and enable the write actions under Action control.
3. Confirm that the current ChatGPT plan/workspace supports full MCP write actions.

### A compiled executable cannot find configuration

Place `commands.yaml` beside the executable. Runtime state is created in `.mrmcp` beside the executable. `morphlex.js` is embedded only when the compile command includes `--include morphlex.js`.

See `AGENTS.md` for implementation architecture, migration constraints and release checks.
