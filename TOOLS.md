# MrMCP tools

This file documents the current built-in MCP tool surface, its arguments, semantics and design rationale. The published JSON Schemas in `mrmcp.js` are executable contracts; this file explains why the contracts have this shape.

## General conventions

### Session capability

Most tools require `context_handle`, the opaque `ctx_...` capability returned by `open_workspace`. Pass it unchanged. `list_workspaces` and `create_workspace` are sessionless; `open_workspace` creates or reuses a Session and returns the handle used afterward.

### Filesystem paths

Filesystem paths are relative to the Session's current Workspace unless the specific tool says otherwise. MrMCP resolves and confines them to that Workspace.

### Stateless filesystem navigation

Filesystem discovery, search and navigation keep no server-side cursor state.

- `fs_glob` continues with `after_path` / `next_after_path`.
- `fs_grep` continues with `resume_after` / `next_resume_after`.
- `fs_navigate` receives an explicit `from_line` and direction for every file on every call.
- `fs_read` continues a truncated range with `next_start_line`.

The continuation value is ordinary call data. Losing a previous response loses no hidden server state.

### Path selection

`fs_glob`, `fs_grep` and `fs_trash.selection` share the same selection fields:

- `path` — Workspace-relative file or directory at which traversal starts; default `.`.
- `include[]` — globstar patterns relative to `path`; default `['**/*']`.
- `exclude[]` — globstar patterns removed from the candidate set; default empty.
- `gitignore` — when true, apply applicable parent `.gitignore` rules and nested `.gitignore` files encountered while descending; default true.
- `hidden` — include dot-prefixed files/directories; default false. `.gitignore` files are still read when hidden entries are not returned.

Nested `.gitignore` discovery is always recursive when `gitignore=true`; there is deliberately no separate recursive switch. MrMCP reads `.gitignore` files themselves, not Git's index, global excludes or `.git/info/exclude`.

### Text representation

Text tools support `auto`, UTF-8, UTF-16LE, UTF-16BE, Windows-1252 and Latin-1 input. Mutations support `preserve` or an explicit output encoding, BOM preservation/add/remove and `preserve|lf|crlf|cr` line endings.

Returned text is normalized to LF for stable agent editing while the result reports the source `encoding`, `bom` and `line_endings`. Tool string arguments are already JSON-decoded text; MrMCP never applies a second C/JavaScript escape-decoding pass.

### Fingerprints

A `fingerprint` is an opaque whole-file content token. Do not parse it or depend on its hashing algorithm.

`fs_read`, matched `fs_grep` results and `fs_navigate` return fingerprints. `fs_stat` can compute one on request. `fs_write` and `fs_edit` accept `expected_fingerprint` per file and refuse that file with `fingerprint_mismatch` if the current bytes do not match.

Mutation tools also recheck the source immediately before writing and report `source_changed` if it changed during the call. This is optimistic concurrency protection, not an OS file lock.

### Batch behavior

Batch entries are independent. There is no public `atomic` option and no cross-entry rollback. If three entries succeed and the fourth fails, the three successful operations remain applied and the structured result reports all four outcomes.

This avoids best-effort rollback becoming a second failure mode. A single recursive copy/move/trash/restore can report `failed_partial` when it leaves a destination or payload after failing.

`fs_edit` has one important local invariant: all edits for one file are validated and applied to an evolving in-memory document before that file is written once. A validation failure means that file is not written; other files remain independent.

---

## Session and Workspace

### `list_workspaces`

Lists enabled Workspace names that may be passed to `open_workspace`.

Arguments: none.

Rationale: discovery is sessionless so a client can choose a Workspace before it has a Session capability.

### `create_workspace`

Creates a new empty directory on the current user's Desktop and registers it as an enabled Workspace.

Arguments:

- `name` — new globally unique Workspace name.

The path is intentionally not supplied by the agent; MrMCP resolves the Desktop and final directory internally.

### `open_workspace`

Opens an enabled Workspace and returns the Session capability used by later tools.

Arguments:

- `name` — Workspace name.
- `current_context_handle` — optional existing active Session capability. When valid, the same Session is moved to the selected Workspace. Otherwise a new Session is created.

Returns `workspace_name`, absolute `cwd`, `agent_guidance_path` and `context_handle`.

---

## Filesystem discovery and reading

### `fs_glob`

Discovers files, directories and symlinks and also acts as the tree navigator.

Arguments:

- shared path selection: `path`, `include[]`, `exclude[]`, `gitignore`, `hidden`.
- `limit` — maximum entries returned, default 500, maximum 10000.
- `after_path` — final Workspace-relative path from the previous page. Only lexically later entries are returned.
- `context_handle`.

Results are deterministically ordered. When truncated, `next_after_path` is the value to send as the next `after_path`.

Rationale: globstar plus directory entries covers both ordinary globbing and tree browsing without a separate `tree` tool.

### `fs_grep`

Searches text across a selected set of files.

Arguments:

- `pattern` — non-empty literal or regex source.
- shared path selection: `path`, `include[]`, `exclude[]`, `gitignore`, `hidden`.
- `regex` — interpret `pattern` as JavaScript regex source; default false.
- `case_sensitive` — default false.
- `encoding` — input text encoding; default `auto`.
- `context_lines_before` / `context_lines_after` — text context returned around each match; default 0.
- `mode` — `matches`, `files` or `count`; default `matches`.
- `max_file_bytes` — skip source files larger than this size; default 5 MiB, maximum 50 MiB.
- `limit` — maximum returned matches in `matches` mode or matched files in the other modes; default 300, maximum 2000.
- `resume_after` — optional stateless continuation object:
  - `{path}` means continue after the whole file.
  - `{path, line}` means continue after that line within the file.
- `context_handle`.

Matched files include a whole-file `fingerprint`, size and text metadata. Match rows contain `line`, `column`, `text`, optional `context_before[]` and `context_after[]`.

When more results remain, `next_resume_after` is directly reusable as the next `resume_after`.

Rationale: repository-wide search belongs in one tool; relative next/previous navigation belongs in `fs_navigate`, avoiding ambiguous start-line/direction semantics inside grep.

### `fs_read`

Reads one or many text files in one call.

Arguments:

- `files[]`, each containing:
  - `path` — required.
  - `start_line` / `end_line` — optional inclusive requested range.
  - `context_lines_before` / `context_lines_after` — optional surrounding lines.
  - `encoding` — per-file input encoding; default `auto`.
- `max_output_bytes_per_file` — target maximum UTF-8 bytes of normalized text returned for each file result; default 1 MiB, maximum 5 MiB. A single complete line may exceed the target so line content is never split. This bounds response payload, not source file size.
- `context_handle`.

Successful results include normalized `content`, actual returned range, `total_lines`, source size, fingerprint and text metadata. A truncated result provides `next_start_line`.

Rationale: a single multi-file read eliminates `read_file`/`read_files` duplication while per-file range and encoding options remain naturally scoped to the file they affect.

### `fs_navigate`

Finds the next or previous match relative to known positions in one or many files.

Arguments:

- `pattern` — non-empty literal or regex source.
- `files[]`, each containing:
  - `path` — required.
  - `from_line` — exclusive reference line; minimum 0.
  - `direction` — `forward` or `backward`.
  - `max_matches` — matches returned for that file; default 1, maximum 100.
  - `encoding` — per-file input encoding; default `auto`.
- `regex` — default false.
- `case_sensitive` — default false.
- `context_lines_before` / `context_lines_after`.
- `context_handle`.

Forward starts at `from_line + 1`; backward starts at `from_line - 1`. Therefore a returned match line can be sent back unchanged as the next `from_line` and navigation always progresses. Use `from_line: 0` to search forward beginning with line 1; to begin backward from the physical end, use a value greater than the file's `total_lines` (for example `total_lines + 1`).

Results include fingerprint, source size/line count, text metadata and structured matches.

Rationale: relative navigation is common after `fs_read`/`fs_grep` and is clearer as an explicit stateless primitive than by overloading grep pagination.

### `fs_stat`

Reads filesystem metadata for one or many paths.

Arguments:

- `paths[]` — one or more Workspace-relative paths.
- `fingerprint` — when true, also read and fingerprint regular-file content; default false.
- `context_handle`.

Returns type, size, modification/creation time and optional fingerprint.

Rationale: this is the canonical metadata primitive replacing the narrower `file_info` name and naturally works for directories and symlinks as well as files.

---

## Filesystem content mutation

### `fs_write`

Creates or replaces the complete contents of one or many text files.

Arguments:

- `files[]`, each containing:
  - `path`.
  - `content`.
  - `expected_fingerprint` — optional optimistic concurrency token.
  - `output_encoding` — `preserve` or explicit encoding; default `preserve`.
  - `line_endings` — `preserve|lf|crlf|cr`; default `preserve`.
  - `bom` — `preserve|add|remove`; default `preserve`.
- `create_parents` — create missing parent directories; default true.
- `context_handle`.

Returns per-file status plus before/after sizes, fingerprints and final text metadata when written, and top-level `succeeded` / `failed` counts.

Rationale: whole-file replacement and anchored editing are different operations and remain separate tools; combining them would create a mode-dependent schema.

### `fs_edit`

Applies ordered exact edits to one or many existing text files.

Arguments:

- `files[]`, each containing:
  - `path`.
  - `expected_fingerprint` — optional optimistic concurrency token.
  - `input_encoding` — default `auto`.
  - `output_encoding`, `line_endings`, `bom` — same representation controls as `fs_write`.
  - `edits[]`, each containing:
    - `old_text` — non-empty exact text anchor.
    - `new_text` — exact replacement text.
    - `expected_occurrences` — exact occurrence count required at that edit step; default 1.
- `context_handle`.

For each file MrMCP:

1. reads the file once;
2. verifies the initial fingerprint when supplied;
3. creates one normalized in-memory text document;
4. applies edit 1, then edit 2 to the result of edit 1, and so on;
5. checks every `expected_occurrences` against the document state at that exact step;
6. rechecks that the source did not change externally;
7. writes the file once.

If any occurrence check fails, that file receives `occurrence_mismatch` and is not written. The result includes compact ordered edit evidence `{index, expected_occurrences, occurrences}` without echoing the potentially large text arguments.

When source line endings are mixed, `line_endings: preserve` is rejected with `mixed_line_endings`; exact mixed-EOL layout cannot be reconstructed after normalized editing. Choose an explicit output line-ending mode to make conversion intentional.

Rationale: this keeps multi-edit fast and safe without line-number drift. Edits are anchored by text, not absolute coordinates, so earlier edits may add/remove lines without invalidating later edit positions.

---

## Filesystem structural mutation

### `fs_mkdir`

Creates one or many directories.

Arguments:

- `paths[]` — requested directory paths.
- `parents` — create missing parents recursively; default true.
- `context_handle`.

Existing directories are reported as `exists` and count as successful. Entries are independent.

### `fs_copy`

Copies one or many files/directories recursively.

Arguments:

- `entries[]` — `{from, to}` pairs.
- `create_parents` — default true.
- `context_handle`.

The destination must not already exist. Copying a directory inside itself is rejected. Entries run in order and later entries observe earlier filesystem changes. A recursive failure that leaves a destination may report `failed_partial`.

### `fs_move`

Moves or renames one or many files/directories.

Arguments are the same as `fs_copy`.

MrMCP first uses native rename and falls back to copy/remove when a cross-filesystem move requires it. Destinations must not already exist. Entries run in order and are never reversed because a later entry fails.

### `fs_trash`

Reversibly removes paths from a Workspace by moving them into the single MrMCP-managed trash store.

Arguments:

- `paths[]` — optional explicit paths.
- `selection` — optional object using the shared `path/include/exclude/gitignore/hidden` selection model.
- at least one of `paths` or `selection` is required.
- `context_handle`.

Nested selected targets collapse under their selected parent. A transaction manifest is written before payload moves. Successful entries are stored under one `trash_id`; failures do not roll successful entries back. If no payload remains in the trash after the call, the result has `trash_id: null` and no empty transaction is kept. A `failed_partial` payload keeps the `trash_id` so the reported partial state remains inspectable.

Returns `trash_id`, physical trash/manifest paths, `succeeded`, `failed` and per-path statuses.

Rationale: removal is intentionally reversible; there is no permanent filesystem-delete tool.

### `fs_restore`

Restores payloads still present under one trash transaction.

Arguments:

- `trash_id` — identifier returned by `fs_trash`.
- `context_handle`.

Each payload is restored independently. Occupied destinations, missing parents, wrong-Workspace paths and unavailable payloads are reported per entry. Successful restores remain restored; failed payloads remain available for retry. The trash transaction is deleted only when no payload remains.

---

## Publication

### `publish_file`

Snapshots an existing Workspace file into persistent MrMCP publish storage and presents it through the attached MCP App widget.

Arguments:

- `path` — required.
- `filename` — optional presented/download filename.
- `mime_type` — optional MIME override.
- `context_handle`.

Publications survive source changes/deletion and server restarts until explicitly cleared.

### `publish_html`

Publishes self-contained interactive HTML through the MCP App widget.

Arguments:

- `html` — required.
- `title` — default `Interactive HTML`, maximum 200 characters.
- `height` — widget height, default 600, range 120–2000.
- `context_handle`.

Remote dependencies remain subject to host/browser CSP and CORS. The whole MCP request is bounded by the server request-body limit.

---

## Command discovery and Tool Call history

### `discover_commands`

Returns the complete extra-command catalog intentionally made available to the agent.

Arguments:

- `context_handle`.

Results contain `logical_name`, description and optional documentation URL. A returned logical name can be passed directly as `exec.program`; MrMCP resolves catalog names before normal PATH lookup.

Rationale: user-provided command capability remains extensible without growing the built-in MCP surface.

### `query_tool_calls`

Queries Tool Calls that actually reached MrMCP for the current Session.

Arguments:

- `limit` — 1–50, default 10.
- `tool` — exact tool-name filter.
- `status` — exact `received|running|completed|failed|invalid|orphaned` filter.
- `query` — case-insensitive literal substring across the stored record.
- `before_id` — return rows with lower stable log ids for backward pagination.
- `context_handle`.

The call excludes its own current log row. Requests blocked before reaching MrMCP cannot appear here.

---

## Process execution

### Shared direct execution arguments

`exec` and `exec_start` accept one of:

- `program` — executable path or `logical_name` from `discover_commands`.
- `shell_command` — use only when actual shell syntax such as pipes/redirection is needed.

Additional fields:

- `args[]` — verbatim ordered argv for `program`; default empty.
- `cwd` — Workspace-relative directory; default `.`.
- `env` — string environment overrides.
- `stdin` — initial stdin data.
- `stdin_encoding` — `text|base64`; default `text`.
- `timeout_ms` — tool-specific timeout.
- `context_handle`.

`exec` also has `separate_streams`; `exec_start` deliberately does not because it returns before process output is consumed.

### `exec`

Runs a foreground process until exit.

- `timeout_ms` default 120000, maximum 3600000.
- `separate_streams` optionally adds stdout/stderr snapshots; combined observed-order output remains the default.

If the MCP request uses a progress token and SSE, output can stream as progress while the final result still contains the complete transcript. Cancelling/disconnecting the foreground Tool Call terminates the child.

### `exec_start`

Starts a persistent interactive/background process and returns immediately.

- `timeout_ms` default 0 (no timeout), maximum 604800000.

Returns `exec_id`, which is also the originating Tool Call id. Persistent process state is in memory and does not survive a server restart.

### `exec_attach`

Consumes unread output from a persistent process and advances that process's attach cursor.

Arguments:

- `exec_id`.
- `separate_streams` — include complete stdout/stderr snapshots in the final result; default false.
- `context_handle`.

Only one attachment may be active for an `exec_id`. `remaining_bytes` tells the caller whether already-buffered output remains.

### `exec_write`

Writes to persistent-process stdin.

Arguments:

- `exec_id`.
- `data` — default empty.
- `encoding` — `text|base64`; default `text`.
- `close` — close stdin after the optional write; default false.
- `context_handle`.

### `exec_kill`

Terminates a running persistent process.

Arguments:

- `exec_id`.
- `signal` — `SIGTERM|SIGKILL`; default `SIGTERM`.
- `context_handle`.

### `exec_list`

Lists only currently running persistent processes for the Session.

Arguments:

- `limit` — default 50, maximum 200.
- `context_handle`.

### `exec_status`

Reads persistent-process status without advancing the attach cursor.

Arguments:

- `exec_id`.
- `output` — `none|all|tail`; default `none`.
- `tail_lines` — default 200, maximum 10000.
- `separate_streams` — default false.
- `context_handle`.

---

## JavaScript kernel

### `js`

Runs JavaScript in a persistent lazy kernel scoped to the current Session and Workspace.

Arguments:

- `code` — required.
- `cwd` — Workspace-relative working directory; default `.`.
- `timeout_ms` — default 30000, maximum 120000.
- `context_handle`.

Use it for computation or programmatic parsing, not filesystem operations already covered by `fs_*` tools.

### `js_add_node_module_dir`

Adds a directory to the current persistent JavaScript kernel's module search directories.

Arguments:

- `path`.
- `context_handle`.

### `js_reset`

Destroys/reset the persistent JavaScript kernel for the current Session and Workspace.

Arguments:

- `context_handle`.

---

## Guided prompts are not tools

`guided_prompts.yaml` is exposed through MCP `prompts/list` / `prompts/get`, not `tools/list`. Guided prompts are user-controlled reusable workflows; they do not add model-controlled tool capability.
