# MrMCP tools

This file documents the current built-in MCP tool surface, its arguments, semantics and design rationale. The published JSON Schemas in `mrmcp.js` are executable contracts; this file explains why the contracts have this shape.

## General conventions

### Session capability

Most tools require `context_handle`, the opaque `ctx_...` capability returned by `open_workspace`. Pass it unchanged. `list_workspaces` and the read-only diagnostic `tools_schema` are sessionless; `open_workspace` itself needs no pre-existing Session, can explicitly create a missing Workspace with `create=true`, then creates/reuses a Session and returns the handle used afterward.

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

Text content and its physical representation are deliberately separate. The agent works on decoded text; MrMCP owns charset encoding, physical BOM bytes and CR/LF serialization.

Design rationale: agents are good at expressing the intended logical text but should not be forced to reproduce incidental byte-level representation exactly on every tool call. Requiring them to remember or emit the original charset, BOM and CR/LF convention would increase prompt/tool-call burden and create avoidable errors and retry round-trips. MrMCP therefore infers and preserves representation whenever the existing bytes provide one unambiguous answer, and normalizes harmless payload differences such as agent-supplied LF versus CRLF. New files use LF when no line-ending style exists yet; an explicit representation choice is required only for a genuinely ambiguous existing source such as a single-line/empty file that is being expanded or a mixed-EOL file. This convenience never permits silent data loss: malformed input, unsupported characters, ambiguous representation choices and non-lossless conversions fail instead of being guessed or repaired.

Character-set rules:

- `encoding:"auto"` passes the complete original `Uint8Array` from `Deno.readFile()` to pinned `chardet` and uses only the charset it reports. BOM, UTF-8 validity, NUL patterns and other local heuristics never override or supplement that decision. If `chardet` returns no usable charset, auto decoding fails. An explicit input encoding bypasses `chardet` entirely and is decoded as requested.
- Physical BOM inspection is independent metadata only. A recognized UTF-8/UTF-16/UTF-32 prefix produces `bom:true`; it never selects the charset. The selected decoder may consume a matching BOM according to that charset's normal decoding semantics (including the custom UTF-32 decoder), which is distinct from using BOM as a detector.
- Native `TextDecoder` charsets decode with `fatal:true`; malformed data is not retried through a permissive decoder. A charset unavailable to `TextDecoder` may use `iconv-lite`, but only when decode/re-encode reproduces the original bytes exactly.
- `output_encoding:"preserve"` reuses the detected source charset. On a new file, where there is nothing to preserve, it means UTF-8. A `chardet` result of ASCII remains strict ASCII; it is not silently promoted to UTF-8 or interpreted through the WHATWG Windows-1252 `ascii` alias. Encoding intent is not stored separately from file bytes: a newly written UTF-8 file containing only ASCII-compatible bytes may later be reported as `ascii` by `auto` if that is what `chardet` detects, because those bytes do not physically distinguish the two encodings. Encoding is checked by decoding the final bytes through MrMCP's own read path and comparing the exact text, so unsupported characters are rejected instead of becoming `?` or replacement characters. Auto-detected legacy encodings can therefore be preserved only when both decoding and encoding are lossless.
- `bom:"preserve"` preserves physical recognized-BOM prefix presence, not a particular BOM byte sequence: converting a BOM-bearing UTF-16 file to UTF-8 therefore produces the UTF-8 BOM. A new file with `preserve` has no BOM. `add` requires a BOM-capable Unicode output encoding because adding Unicode BOM bytes to a legacy charset would change its decoded text. With an explicitly decoded legacy source whose ordinary text bytes already happen to begin with a recognized BOM sequence, `preserve` does not invent another prefix; the final byte-prefix check decides whether physical presence was actually retained. `remove` similarly fails rather than alter logical text if the requested text itself necessarily encodes to recognized BOM bytes at byte zero.

Line-ending rules:

- Read/search outputs are normalized to LF so matching and edits operate on one stable logical representation. Source metadata still reports `line_endings:"lf"|"crlf"|"cr"|"mixed"|"none"`. `none` means there is no CR or LF separator at all; it includes an empty file and a non-empty single-line file.
- LF, CRLF, CR or mixed separators arriving in `content`, `old_text` or `new_text` are logical text, not an implicit declaration of the desired file format. `fs_edit` normalizes edit anchors/replacements to LF for matching. On output, an explicit `line_endings:"lf"|"crlf"|"cr"` normalizes every break to that requested style.
- `line_endings:"preserve"` reuses an existing uniform source style (`lf`, `crlf` or `cr`) regardless of which separators the agent happened to send. For a new file, where there is no source style to preserve, it defaults to LF and normalizes any incoming LF/CRLF/CR/mixed separators to LF. This intentionally avoids needless retry round-trips and guarantees that a successful new-file write does not inherit mixed line endings from the tool payload.
- If an existing source is `mixed`, `preserve` returns `mixed_line_endings` when the result contains line breaks; if an existing source is `none` and the result introduces line breaks, it returns `line_endings_required`. The agent must then choose `lf`, `crlf` or `cr`. New files are not ambiguous: `preserve` means LF. If the resulting text has no line breaks, no choice is required because the output style is factually `none`.
- A terminating newline does not create a synthetic extra logical line; an empty file has `total_lines:0`.

Tool string arguments are already JSON-decoded text. MrMCP never applies a second C/JavaScript-style escape-decoding pass, so e.g. `\\n` remains two literal characters unless the JSON value itself contains an actual newline.

### Fingerprints

A `fingerprint` is an opaque whole-file content token. Do not parse it or depend on its hashing algorithm.

`fs_read`, matched `fs_grep` results and `fs_navigate` return fingerprints. `fs_stat` can compute one on request. `fs_write` and `fs_edit` accept `expected_fingerprint` per file and refuse that file with `fingerprint_mismatch` if the current bytes do not match.

Mutation tools also recheck the source immediately before writing and report `source_changed` if it changed during the call. This is optimistic concurrency protection, not an OS file lock.

### Batch behavior

Batch entries are independent. There is no public `atomic` option and no cross-entry rollback. If three entries succeed and the fourth fails, the three successful operations remain applied and the structured result reports all four outcomes.

This avoids best-effort rollback becoming a second failure mode. A single recursive copy/move/trash/untrash can report `failed_partial` when it leaves a destination or payload after failing.

`fs_edit` has one important local invariant: all edits for one file are validated and applied to an evolving in-memory document before that file is written once. A validation failure means that file is not written; other files remain independent.

---

## Session and Workspace

### `list_workspaces`

Lists enabled Workspace names that may be passed to `open_workspace`.

Arguments: none.

Rationale: discovery is sessionless so a client can choose a Workspace before it has a Session capability.

### `open_workspace`

Opens an enabled Workspace and returns the Session capability used by later tools. Workspace creation is deliberately folded into this tool rather than exposed as a second public creation tool.

Arguments:

- `name` — Workspace name.
- `create` — default `false`. Set `true` only when you explicitly want a missing Workspace created as a new empty directory on the current user's Desktop and registered under exactly this name. With `false`, a missing or disabled Workspace is an error. If the Workspace already exists, `create=true` simply opens it and does not replace it.
- `current_context_handle` — optional existing active Session capability. When valid, the same Session is moved to the selected Workspace. Otherwise a new Session is created.

The creation path remains name-only: the agent does not supply the filesystem path; MrMCP resolves the Desktop and final directory internally and performs the same name/path/existing-target collision checks used by the GUI workflow.

Returns `workspace_name`, absolute `cwd`, `agent_guidance_path`, `workspace_created`, `memory_summary` and `context_handle`. `workspace_created` is true only when this exact call created the missing Workspace. `memory_summary.global`, `memory_summary.workspace` and `memory_summary.session` each contain the number of live memories plus up to five most recently set keys, giving the agent a small orientation hint without eagerly returning values. Guidance resolution checks only the Workspace root, preferring `AGENTS.md` / `agents.md` and then falling back to `CLAUDE.md` / `Claude.md` / `claude.md`. `DEV_PREF.md` is intentionally not guidance-discovered by `open_workspace`.

### `workspace_dev_preferences_write`

Opt-in materialization of the operator's development preferences into the current Workspace. Use this tool only when the user explicitly asks to save/copy/materialize their development preferences in that project. It must never be called proactively, during Workspace opening, for preference discovery, or to decide what instructions to follow.

The source is the physical `DEV_PREF.md` beside the running MrMCP executable; source mode uses the file beside `mrmcp.js`. The destination is exactly Workspace-root `DEV_PREF.md`. If the destination already exists, the tool returns `already_exists` immediately and does not read, compare, merge or overwrite either file. Otherwise it copies the source bytes exactly. The tool returns only `path`, `status`, `created` and the normal `context_handle`; it never returns preference content.

Calling this tool does not itself instruct the agent to read or apply `DEV_PREF.md`. Existing user/project guidance controls that separately.

Arguments: only `context_handle`.

---

## Filesystem discovery and reading

### `fs_glob`

Discovers files, directories and symlinks and also acts as the tree navigator.

Arguments:

- shared path selection: `path`, `include[]`, `exclude[]`, `gitignore`, `hidden`.
- `metadata` — default `false`. The normal page contains only `path` + `type`; set true only when size, modification/creation timestamps or stored symlink targets are needed.
- `limit` — maximum entries returned, default 1000, maximum 10000.
- `after_path` — stateless continuation path returned by the previous page as `next_after_path`. Only lexically later entries are returned.
- `context_handle`.

Results are deterministically ordered and echo `metadata`, `returned` and the effective `limit`. Every entry always reports `path` and `type` (`file`, `directory` or `symlink`). With `metadata=true`, entries additionally report size and modification/creation timestamps, and symlinks report their stored `link_target` without dereferencing it. When `truncated=true`, pass `next_after_path` unchanged as the next `after_path` with the same selection arguments.

Traversal never applies magic dependency/build/cache exclusions. It may skip a subtree only when the active include patterns prove that no descendant could match; ambiguous/global patterns fail open to ordinary traversal. User exclusions belong in `.gitignore` or explicit `exclude[]`.

Rationale: lightweight path/type pages cover common repository navigation without doing per-entry metadata I/O; metadata remains explicit when an agent actually needs it.

### `fs_grep`

Searches text across a selected set of files.

Arguments:

- `pattern` — non-empty literal substring or regex source. With `regex=false`, the entire supplied string is matched literally; spaces and punctuation are not tokenized.
- shared path selection: `path`, `include[]`, `exclude[]`, `gitignore`, `hidden`.
- `regex` — interpret `pattern` as JavaScript regex source; default false.
- `case_sensitive` — default false.
- `encoding` — input text encoding; default `auto`.
- `context_lines_before` / `context_lines_after` — text context returned around each match; default 0.
- `mode` — `matches`, `files` or `count`; default `matches`. `count` follows grep `-c` semantics and reports matching lines per file, not total substring occurrences.
- `max_file_bytes` — skip source files larger than this size; default 5 MiB, maximum 50 MiB.
- `limit` — maximum matching lines in `matches` mode or matched files in `files`/`count`; default 300, maximum 2000.
- `max_output_bytes` — approximate UTF-8 payload target for one page; default 1 MiB, maximum 16 MiB. A single indivisible match/file record may exceed the target so the cursor always advances.
- `resume_after` — optional stateless continuation object:
  - `{path}` means continue after the whole file.
  - `{path, line}` means continue after that line within the file.
- `context_handle`.

Matched files include a whole-file `fingerprint`, size and text metadata. Match rows contain `line`, `column`, `text`, optional `context_before[]` and `context_after[]`. The page also reports `returned`, the effective `limit`, `output_bytes`, `max_output_bytes` and nullable `truncation_reason` (`limit`, `output_bytes` or `walk_limit`).

When `truncated=true`, `next_resume_after` is directly reusable as the next `resume_after`. Search remains stateless; MrMCP does not retain hidden grep cursors.

Rationale: repository-wide search belongs in one tool, but response size should stay bounded by explicit stateless paging rather than by silently clipping stored results.

### `fs_read`

Reads one or many text files in one call.

Arguments:

- `files[]`, each containing:
  - `path` — required.
  - `start_line` / `end_line` — optional inclusive requested range.
  - `context_lines_before` / `context_lines_after` — optional surrounding lines.
  - `encoding` — per-file input encoding; default `auto`.
- `max_output_bytes_per_file` — per-file UTF-8 ceiling, default 1 MiB, maximum 5 MiB. A single complete line may exceed it so line content is never split.
- `max_output_bytes` — aggregate target for the whole batch, default 2 MiB, maximum 16 MiB. Remaining budget is shared across remaining files and unused quota rolls forward.
- `context_handle`.

Successful results include normalized `content`, actual returned range, `total_lines`, source size, fingerprint and text metadata. The batch reports `output_bytes`, both effective byte limits, `truncated` and `truncated_files`. A truncated requested range provides `next_start_line`.

Under each file's current budget, requested lines take priority over optional context: `fs_read` fills the requested range first and only then uses remaining space for `context_lines_before` / `context_lines_after`. Context omission alone does not create a continuation cursor, and every truncated requested range advances `next_start_line` beyond the requested start. A single indivisible line may make the aggregate result exceed the nominal target; this is intentional so text is never split and continuation always progresses.

Rationale: one multi-file read remains convenient for common batches while the aggregate budget prevents the default response from growing roughly linearly with file count.

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
  - `output_encoding` — `preserve` or explicit encoding; default `preserve`. Existing files reuse the detected charset; new files use UTF-8.
  - `line_endings` — `preserve|lf|crlf|cr`; default `preserve`. Preserve reuses a uniform existing source style; for a new file it defaults to LF. An existing mixed or no-style source still requires an explicit choice when the result contains line breaks.
  - `bom` — `preserve|add|remove`; default `preserve`. Existing files preserve physical BOM presence; new files default to no BOM.
- `create_parents` — create missing parent directories; default true.
- `context_handle`.

Returns per-file status plus before/after sizes, fingerprints and final text metadata when written, and top-level `succeeded` / `failed` counts. With `create_parents:false`, a missing parent is reported explicitly as `parent_missing` rather than as source `not_found`.

An existing source is decoded only when a preserved property actually needs decoded text metadata: preserving the charset always needs detection, and preserving line endings needs decoding only when the replacement contains line breaks. Physical BOM preservation is read directly from raw prefix bytes. Therefore a complete replacement with explicit output encoding/EOL policy can replace otherwise undecodable source bytes without an irrelevant chardet/decode failure, while fingerprint and source-changed checks still protect concurrency.

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

When `line_endings: preserve` has no unique source style and the edited result still contains line breaks, the edit is not written: mixed sources return `mixed_line_endings`, while a source with `line_endings:none` returns `line_endings_required`. If the edit removes every line break, the result is unambiguously `none` and no explicit style is required.

Rationale: this keeps multi-edit fast and safe without line-number drift. Edits are anchored by text, not absolute coordinates, so earlier edits may add/remove lines without invalidating later edit positions.

### `fs_text_convert_encoding_eol`

Explicitly converts only the physical text representation of existing regular files while preserving logical text content. This is the direct operation for requested charset, line-ending or BOM conversion; it is not a formatter and must not be used proactively to "normalize" a repository.

Arguments:

- `files[]` — explicit Workspace-relative paths only; there is no glob/discovery mode. Each entry contains `path`, optional `expected_fingerprint`, and optional `input_encoding` (`auto` by default) to override charset detection when the source encoding is already known.
- `encoding` — target `preserve|utf-8|utf-16le|utf-16be|windows-1252|latin1`; default `preserve`.
- `line_endings` — target `preserve|lf|crlf|cr`; default `preserve`. Here preserve means preserve the actual source convention exactly, including `mixed` or `none`.
- `bom` — `preserve|add|remove`; default `preserve`. `add` requires a BOM-capable Unicode resulting encoding.
- `context_handle`.

At least one of `encoding`, `line_endings` or `bom` must request a real conversion rather than `preserve`; an all-preserve call is rejected so this tool cannot be abused as a read/detection API. Source encoding is detected with the same chardet-based path as the other filesystem text tools unless that file explicitly supplies `input_encoding`. Conversion is lossless: a wrong/ambiguous automatic detection fails rather than silently guessing, and if the requested target charset cannot represent the text that file fails rather than substituting characters.

Each result reports `path`, `status` and, when decoding succeeded, `before` / `after` objects containing detected/effective `encoding`, `line_endings` and physical `bom`. `converted` means bytes were rewritten; `unchanged` means the current bytes already represent the requested result and no write occurred. Optional fingerprints protect against concurrent changes, and MrMCP rechecks the source immediately before deciding unchanged or writing. Directories and symlinks are `not_file`; entries are independent.

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

Copies one or many files, directories or symlinks recursively. Symlinks are recreated as symlinks with the same link target text rather than dereferenced into ordinary files/directories.

Arguments:

- `entries[]` — `{from, to}` pairs.
- `create_parents` — default true.
- `context_handle`.

The destination must not already exist. Copying a directory inside itself is rejected. Entries run in order and later entries observe earlier filesystem changes. A recursive failure that leaves a destination may report `failed_partial`.

### `fs_move`

Moves or renames one or many files/directories.

Arguments are the same as `fs_copy`.

MrMCP first uses native rename and falls back to copy/remove when a cross-filesystem move requires it. The fallback preserves symlinks just like the native rename path. Destinations must not already exist. Entries run in order and are never reversed because a later entry fails.

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

### `fs_untrash`

Restores payloads still present under one trash transaction.

Arguments:

- `trash_id` — identifier returned by `fs_trash`.
- `context_handle`.

Each payload is restored independently. Occupied destinations, missing parents, wrong-Workspace paths and unavailable payloads are reported per entry. Successful restores remain restored; failed payloads remain available for retry. The trash transaction is deleted only when no payload remains.

The desktop **Trash** section is an operator view over the same authoritative manifest/payload store, not over Tool Call history. Its sidebar badge counts payload items actually present. It lists transactions and original paths/type/size, restores one item or a whole transaction without overwriting an occupied destination, supports confirmed permanent deletion of one item/transaction, and exposes confirmed Empty Trash. Orphan payload directories without a valid manifest remain visible as deletable but non-restorable state.

---

## Desktop automation

### `desktop_auto`

Runs one Automation Action Format (AAF) YAML scenario against the current desktop through `@mefistofelix/auto.js`.

Arguments:

- `yaml` — complete AAF YAML scenario. The top level is an ordered array and each item contains exactly one action. The authoritative specification and examples are at `https://github.com/mefistofelix/auto.js/blob/main/AAF_SPEC.md`.
- `context_handle`.

The returned `results` and `state` preserve Auto.js `run()` semantics. `results` is the ordered per-action result array; `state` is the arbitrary final structure built by the scenario and may freely mix OCR text, window/accessibility records, coordinates, arrays, objects, scalars and zero, one or many retained screenshots.

Retained final-state screenshots remain at the exact nested state locations chosen by the scenario. MrMCP removes only their binary `data`, keeps their AAF metadata (`format`, absolute desktop `rect`, `grayscale`, `scale`), and inserts `image_id`. A top-level `images[]` transport index maps each distinct image id to every referencing `$.state` path and to its MCP `content_index`. The same retained image referenced from several state paths is emitted only once.

The MCP result `content` is multimodal: index `0` is the JSON `TextContent` representation of the structured result, followed by one MCP `ImageContent` block per distinct retained image. Thus no-image scenarios return ordinary structured/text data, while scenarios with several images return all of them in the same tool result. The images are direct model input, not `publish`, Published storage, an MCP App or a `resource_link`. MCP encodes `ImageContent.data` as Base64 on the wire; Auto.js WebP plus `scale` is the intended size-control path. `rect` always remains the original absolute screen-space capture rectangle, so coordinates can be mapped back correctly after downscaling.

The desktop **Automation** page is a derived diagnostic view over `desktop_auto` Tool Calls recorded in **Full** payload mode. Only Full rows are complete replay sources: the page can filter by originating Session, show the exact YAML scenario, parsed scenario, returned state/results and retained input/output images, then replay the original scenario through the shared low-level Auto.js engine. Light/Metadata rows remain visible in ordinary Tool Call history but are intentionally not replay sources. Replay itself stays a local action below the MCP dispatcher and creates no Tool Call, notification or replay-history row.

---

## Chrome DevTools Protocol

The CDP surface is deliberately small: `cdp_call`, `cdp_subs`, and `cdp_poll`. It has no Puppeteer/Playwright dependency and does not import `doc/CDP.js`; that file remains low-level behavioral know-how. Standard CDP commands stay standard, while two deliberately namespaced `_mrmcp` operations capture the useful XPath behavior from the reference without adding separate MCP tools. The authoritative protocol reference is `https://chromedevtools.github.io/devtools-protocol/`.

### `cdp_call`

Sends one or more CDP operations. The input is **always** a `calls[]` array, including the one-call case. Each entry may select a persistent global browser/profile label, an optional logical page target and one operation; if `browser` is omitted, MrMCP uses the persistent profile label `main`. One Tool Call may span several targets and browsers. MrMCP stores each browser profile under `.mrmcp/cdp/<browser>/`, assigns a stable unique loopback debugging port, reconnects to a still-running browser when possible, and otherwise launches a compatible Chromium browser automatically. Browser state is global, not Session-owned, and a launched browser may outlive MrMCP.

Arguments:

- `calls[]` — required, 1–100 entries, returned in the same order.
  - `browser` — optional persistent browser/profile label for this entry; defaults to `main` when omitted.
  - `target` — optional persistent logical page label. If its saved page still exists, MrMCP resolves a current flattened `sessionId`; if it disappeared, MrMCP creates a new paused `about:blank` page, initializes/resumes it and replaces the persisted `targetId`. `_mrmcp` operations require a target; standard browser-level CDP methods may omit it.
  - `call` — exactly one of:
    - `method` — exact standard CDP method such as `Page.navigate`, `Runtime.evaluate`, `Network.getResponseBody` or `Page.captureScreenshot`; `params` is passed to CDP unchanged. Never supply transport `id` or `sessionId`.
    - `_mrmcp` — private MrMCP operation, never sent as a CDP method. `_mrmcp:"click"` accepts `params.xpath` plus optional `attempts` (default 5, max 20) and `interval_ms` (default 300); it performs the reference `Runtime.evaluate` retry/click flow with `awaitPromise`, `returnByValue`, `silent` and `userGesture`. `_mrmcp:"find"` accepts `params.xpath` plus optional `limit` (default 20, max 100) and returns compact matching node/element metadata including text and client rects. Both operations preprocess augmented XPath: `ends-with(a,b)` becomes the XPath-1.0 `substring(...) = b` equivalent and `icontains(a,b)` becomes a case-insensitive `contains(translate(...),b)` expression.
  - `_image` — optional MrMCP response post-processing **only** for a standard `Page.captureScreenshot` call and only with `wait=true`. The standard screenshot request remains untouched, so every normal CDP screenshot parameter remains available. `return` is currently `base64`; `format:"original"` keeps the browser-returned encoding without loading an image codec, while `format:"webp"` lazily uses the public Auto.js `auto.vips.decodeImage` / `auto.vips.encodeImage` API. Its current WebP encoder is fixed at `quality:80`; `scale` multiplies dimensions before encoding. PNG/WebP browser screenshots can enter this post-processing path. The resulting Base64 stays in `cdp.result.data`; an `image` metadata object reports encoding, resulting format/MIME, byte size, scale and quality. MrMCP never imports Sharp directly and does not save CDP screenshots to disk unless a later explicit tool does so.
- `wait` — one batch-wide flag, default `true`. `true` dispatches every entry and waits independently for every response; one failed entry does not abort siblings. `false` dispatches all possible entries and returns assigned request ids immediately; retrieve eventual responses with `cdp_poll`. `_image` is intentionally unavailable with `wait=false` because post-processing happens on the waited response.
- `context_handle`.

The result is `{wait, results[]}` in input order. Each row reports browser/target/session diagnostics, assigned request `id`, `queued`, `cdp`, nullable `image`, setup errors, `success` and a compact row error. For private `_mrmcp` operations, the ring/response envelope remembers logical method names such as `_mrmcp.click` even though the wire command is `Runtime.evaluate`.

The persistent database stores browser-to-port and `(browser,target)`-to-CDP-`targetId`; `sessionId` remains runtime-only. Reconnecting to a still-running browser reconstructs sessions through CDP. A missing page/browser incarnation is repaired lazily the next time its logical target is used.

The desktop **Browser** page combines persistent browser/profile + logical-target state with current connection/ring/subscription diagnostics. Historical request/response inspection and Replay use only `cdp_call` Tool Calls recorded in **Full** payload mode, because Light/Metadata deliberately do not retain a complete replay source. A replay reruns only the selected recorded batch item through the shared low-level CDP engine; it does not enter the MCP dispatcher, create a Tool Call, write replay history or emit Tool Call notifications. The page adds no new CDP telemetry or replay persistence.

New page sessions use flattened auto-attach with `waitForDebuggerOnStart:true`. While paused, MrMCP enables `Runtime`, `Page`, `Network`, best-effort `ServiceWorker`, focus emulation, `_send_to_cdp` via `Runtime.addBinding`, and best-effort push-messaging `BackgroundService` observation. It sends `Runtime.disable` before `Runtime.runIfWaitingForDebugger`; this disables execution-context reporting but does not remove the binding or prevent later `Runtime.evaluate`. JavaScript may call `_send_to_cdp("...")`, producing the standard `Runtime.bindingCalled` event. Optional setup failures are exposed in `setup_errors`.

### `cdp_subs`

Adds and/or removes global runtime subscriptions for one browser in a single call. Removals are applied before additions. Subscriptions are not Session-owned and are intentionally not persisted across MrMCP restarts.

Arguments:

- `browser` — required browser label.
- `add` — either `"*"` for one catch-all subscription or an array of subscription specs. A spec may contain:
  - `targets[]` — logical target labels; `"*"` matches every target. Omit for all target-associated messages.
  - `methods[]` — exact methods; `"*"` matches all methods.
  - `method_prefixes[]` — prefixes such as `Network.`, `Page.` or `Runtime.`; `"*"` matches all methods. Exact and prefix filters are OR alternatives.
  - `include_browser` — include traffic with no target association. When omitted it defaults true only if no target list is supplied.
  - `regex` — optional JavaScript regex source tested against `JSON.stringify` of the **complete raw inbound CDP message**, so diagnostic subscriptions can match arbitrary payload text such as `pippo`, URLs, ids or nested values without knowing the method in advance.
  - `regex_flags` — optional `i`, `m`, `s`, `u` flags, each at most once.
- `remove` — either `"*"` to remove every live subscription for that browser or an array of opaque `cdpsub_...` ids.
- `context_handle`.

Target, method/prefix and regex dimensions combine with AND; alternatives within exact/prefix methods combine with OR. Internal `Target.*` state handling always runs regardless of public subscriptions. Notifications are put in the public ring only when some live subscription matches; responses are retained independently so `wait=false` remains recoverable.

### `cdp_poll`

Reads retained CDP traffic. With `subscription`, polling proceeds forward from that subscription's ascending cursor and `advance:true` (default) advances only that cursor. Without a subscription, `browser` is required and polling returns the latest matching retained messages from the tail in chronological order without consuming them.

Optional ad-hoc filters are `target`, `type=all|notification|response`, response `id`, exact `methods[]`, `method_prefixes[]`, and `limit` (1–200, default 50). Response envelopes remember the original/logical request method, so method/prefix filtering also works for standard and `_mrmcp` responses.

Each browser has one shared ring rather than one copy per subscription. It is capped at 10,000 messages and 32 MiB serialized size; oversized or oldest entries are dropped as necessary. `dropped`, `oldest_seq`, `newest_seq`, and `stream_resets` make loss and reconnection explicit. A subscription itself stores only its filters and cursor.

---

## Memory

MrMCP exposes one small explicit persistent key-value memory surface: `memory_find` and `memory_set`. There is deliberately no separate `memory_get`; exact lookup is `memory_find` with `key`. Values are explicitly either validated JSON text or ordinary text and are stored in SQLite, not in hidden model state.

`memory_set` explicitly chooses one scope. `memory_find` can choose one scope, a unique array of scopes, or `"*"` for Global + current Session + all Workspaces:

- Global memory is shared across the whole MrMCP server.
- Session memory always means only the current `context_handle`'s Session.
- Workspace memory is shared by Workspace. For `memory_set`, `workspace` is required. For `memory_find`, `workspace` is an optional filter; when omitted, every registered Workspace included by the scope selector is searched.

### `memory_find`

Finds live memories across the selected scope set. Expired TTL rows are removed before the query.

Arguments:

- `scope` — required: one of `global|session|workspace`, a unique array of those scopes, or `"*"` for all three.
- `workspace` — optional filter when Workspace scope is included; omit it to search all registered Workspaces.
- `key` — optional exact key.
- `key_prefix` — optional key prefix.
- `query` — optional search across key plus stored JSON/text value. It is a case-insensitive literal by default.
- `regex=true` — interpret `query` as a JavaScript regular expression.
- `case_sensitive=true` — use case-sensitive literal or regex matching.
- `set_after`, `set_before` — optional ISO date/time bounds on `set_at`.
- `limit` — 1–100, default 20.
- `before_id` — stable backward-pagination cursor; `next_before_id` is returned when another page exists.
- `context_handle`.

Each result contains stable row `id`, scope, nullable Session id and Workspace label, key, explicit `json` boolean, `value` (parsed JSON when true, ordinary string when false), `ttl_seconds`, ISO `set_at`, and nullable ISO `expires_at`. Global results have neither a Session id nor Workspace label.

### `memory_set`

Sets or replaces one key, or deletes it. `key` is 1–512 characters. Stored value text is limited to 1 MiB.

Arguments:

- `scope` and optional/required `workspace` as above.
- `key` — required.
- `value` — exact string value; required unless deleting.
- `json` — required when setting: `true` validates `value` with `JSON.parse`; `false` stores it unchanged.
- `ttl_seconds` — `0` means permanent; a positive value expires that many seconds after this set operation.
- `delete=true` — removes the key; omit both `value` and `json`.
- `context_handle`.

Replacing a key creates a fresh row identity and `set_at`; TTL is therefore restarted from the replacement time. Deleting a Session or Workspace also removes memories owned by it; Global memory is independent of both. **Clear Operational Data intentionally preserves Memory**, just as it preserves Sessions, Workspaces and CDP browser/profile state.

The desktop **Memory** page is a lazy administrative view over the same table. It filters by scope, Session, Workspace, set-date range and text, paginates results, labels JSON/TEXT, displays TTL/expiry, and supports creating Global entries or entries for an explicitly selected existing Session/Workspace, inspecting/editing the complete value/type/key/TTL, and confirmed deletion. GUI creation rejects an already-existing key for that owner rather than silently replacing it; use View / Edit for replacement. JSON memories use the same vendored JSONEditor tree as Tool Call JSON and support node-level editing; text memories use a plain textarea. Switching TEXT ↔ JSON preserves the current draft byte-for-byte as text; invalid JSON remains visible/editable with an error instead of being discarded. JSONEditor writes back through the normal managed form field and Deno submit path, while backend JSON validation remains authoritative.

---

## Publication

### `publish`

Publishes content to the user through one MIME-aware MCP App and persists an immutable snapshot under `.mrmcp/publish/`.

Arguments:

- exactly one source:
  - `path` — existing Workspace file; MrMCP snapshots its bytes.
  - `text` — string encoded as UTF-8 bytes.
  - `base64` — Base64-encoded bytes decoded directly into publish storage.
- `mime_type` — required MIME type for the published bytes. Browser-displayable MIME types are served inline; opaque/binary MIME types are served as attachments.
- `filename` — optional presented filename. A path defaults to its source basename; direct text/Base64 content gets a MIME-based fallback name when omitted.
- `presentation` — optional widget hint: `auto` (default), `inline`, or `download`. This affects the first-frame MCP App presentation only and does not override HTTP MIME/Content-Disposition semantics.
- `title` — optional heading, maximum 200 characters.
- `description` — optional text below the title, maximum 2000 characters.
- `height` — preferred iframe-style inline-preview height, default 600, range 120–2000.
- `context_handle`.

Every source becomes a normal physical file named with the random publication capability prefix plus a sanitized filename. Content is deduplicated with the same fast size/first/last/middle sampling fingerprint, and a reused resource may retain references from multiple Sessions and Workspaces without copying the payload. Publications survive source changes/deletion and server restarts until explicitly cleared.

The returned `uri` is the persistent HTTPS URL of the published content itself, not the MCP App resource. `source` reports whether this call supplied `path`, `text`, or `base64`; the widget combines that with filename, MIME type and size as compact metadata near the optional description. Displayable resources keep their filename in an inline `Content-Disposition`; executables and other opaque binary MIME types use attachment disposition. The smart widget uses MIME plus `presentation` to choose an image/iframe preview or a file action. Inline previews expose **Open original** below the metadata and open that persistent URL in a new window/tab; file-card presentation omits the redundant header link because its **Open File** action is already the primary content link. HTML is loaded in a nested sandboxed iframe without `allow-same-origin`; self-contained HTML/CSS/JavaScript is the portable default, while remote dependencies remain subject to host/browser CSP and CORS. The whole MCP request, including `text` or `base64`, is bounded by the server request-body limit.

---

## Tool-call inspection

Tool Call history has two independent operator settings and every row exposes the policy that actually applied:

- **Storage: Disk** — history lives in the main SQLite database and survives restart.
- **Storage: Memory** — history lives in SQLite TEMP tables/FTS on the active connection and disappears on restart. It has a separate retention in minutes.
- **Payload: Full** — complete request/raw-return JSON and actual text output, plus detectable binary input/output content in the Tool Call content store.
- **Payload: Light** — bounded JSON/text previews (up to 64 KiB per stored field) and no retained Tool Call binary copy. Truncated JSON is represented explicitly with `_mrmcp_payload_truncated`.
- **Payload: Metadata** — no Tool Call request/response JSON, stdout/stderr or binary copies; identity, Session/Workspace snapshot, status/timing, progress flag and bounded errors remain.

Storage and payload are orthogonal: `Memory + Full`, `Disk + Metadata`, etc. are all valid. The payload policy is diagnostic only and cannot remove state required by another feature. In particular persistent-process command/transcript state remains owned by the process subsystem so `exec_attach` / `exec_status` keep working; Browser ring, explicit Memory, Published and CDP state likewise keep their own authoritative storage. Expanded Tool Calls render only fields/capabilities actually present on that row, and Browser/Automation replay is limited to Full rows. No third-party JSON viewer is loaded.

---

## Command discovery and diagnostics

### `discover_commands`

Returns the complete extra-command catalog intentionally made available to the agent.

Arguments:

- `context_handle`.

Results contain `logical_name`, description and optional documentation URL. A returned logical name can be passed directly as `exec.program`; MrMCP resolves catalog names before normal PATH lookup.

Rationale: user-provided command capability remains extensible without growing the built-in MCP surface.

### `tools_schema`

Returns the canonical complete descriptor for one or more exact currently published tool names, directly from the same `serverTools()` source used by MCP `tools/list`.

Arguments:

- `names[]` — 1–50 unique exact published tool names.

The result contains `tools[]` in requested order for names that exist and `missing[]` for names that are not currently published. Each returned item contains `name` plus `descriptor_json`, the exact canonical descriptor serialized losslessly as JSON, including `title`, full `description`, `inputSchema`, `outputSchema`, `annotations` and `_meta` when present. The string representation deliberately keeps the diagnostic tool's own output schema simple for connector compatibility. The tool is authenticated, read-only and sessionless because published descriptors are server-level contracts rather than Session/Workspace state.

Publication-widget resource URIs are returned in canonical form. Normal `tools/list` intentionally adds a fresh `?instance=...` suffix to those View URIs for host cache busting; that suffix is the only intentionally dynamic descriptor difference and is not part of input/output schema semantics.

Rationale: connector/tool wrappers may present a synthesized or abbreviated schema view. This diagnostic path lets an agent inspect the authoritative server descriptor itself when exact schema, descriptions, output statuses, annotations or metadata matter, without duplicating descriptor definitions in a second implementation.

### `tools_log`

Queries Tool Calls that actually reached MrMCP for the current Session across both Disk and Memory history.

Arguments:

- `id` — optional exact stable Tool Call id; when supplied, at most one matching row is returned and `before_id` is ignored.
- `detail` — `summary|full`, default `summary`. Summary avoids payload bodies; Full returns whatever JSON/text that row actually retained.
- `limit` — 1–50, default 10. Exact-id lookup effectively returns at most one.
- `tool` — exact tool-name filter.
- `status` — exact `received|running|completed|failed|invalid|orphaned` filter.
- `query` — case-insensitive literal substring across fields actually retained in each row.
- `before_id` — stateless backward-pagination cursor when `id` is absent.
- `context_handle`.

Every returned row includes `storage` and `payload_mode`. Summary rows include `payload_retained`, retained input/result/output sizes and an optional bounded error preview. Full-detail rows expose payload bodies only when the row retained them; `payload_complete` distinguishes complete Full data from a Light preview. Metadata rows return no Tool Call payload bodies. The result echoes `detail`, `returned`, effective `limit`, `truncated` and `next_before_id`; when truncated, pass `next_before_id` back as `before_id` with the same filters. The call excludes its own current row. Requests blocked before reaching MrMCP cannot appear here.

---

## Telegram Bot API

### `telegram_req`

Sends one generic Telegram Bot API JSON request. The local user configures only the Bot token on the dedicated **✈️ Telegram** sidebar page; the token is injected by MrMCP and is never an agent argument or returned value. The agent owns chat/channel ids and other application state, which can be kept in Memory when useful.

Arguments:

- `request` — one object containing required Bot API `method` plus that method's normal JSON parameters.
- `context_handle`.

MrMCP uses native `fetch()` only: no TDLib and no Telegram client library. Numeric-string `chat_id` is normalized to a number when safely representable. If Telegram returns `parameters.migrate_to_chat_id`, MrMCP remembers that redirect for the running process, rewrites the request and retries once. The result contains the method, Telegram's JSON response body, and nullable migration metadata. Telegram method semantics remain the Bot API's own contract.

---

## Process execution

### Shared direct execution arguments

`exec` and `exec_start` accept one of:

- `program` — executable path or `logical_name` from `discover_commands`.
- `shell_command` — use only when actual shell syntax such as pipes/redirection is needed.

Additional fields:

- `args[]` — verbatim ordered argv for `program`; default empty.
- `cwd` — Workspace-relative directory; default `.`.
- `env` — per-call string environment overrides. Before those overrides, every managed child receives the global Settings → Process Environment `NAME=value` entries. Their values may use `${MRMCP_DIR}` (MrMCP data directory), `${MRMCP_BIN}` (managed bin directory), `${WORKSPACE}` (current Workspace root) and `${CWD}` (effective exec directory); placeholders are expanded when the process starts so Workspace/CWD remain dynamic. Precedence is system environment → global configured environment → per-call `env`. The Process Environment Git line-ending option is enabled by default and appends runtime `core.autocrlf=false` to every managed child, so direct and nested Git invocations ignore machine/platform `core.autocrlf` conversion without changing the user's Git config. Disabling the option stops that injection. Repository `.gitattributes` remains authoritative, and explicit `git -c core.autocrlf=...` can override the runtime default.
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

Returns `exec_id`, which is always the stable integer Tool Call id of the originating `exec_start`, independent of Disk/Memory history storage or Full/Light/Metadata payload mode. Pass it unchanged with the same `context_handle` to the follow-up exec tools. Runtime process state and complete normalized transcript are owned by the process subsystem and remain available for the process lifetime/retention even when Tool Call payload mode is Metadata; process runtime state does not survive server restart.

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
