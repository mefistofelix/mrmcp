# MrMCP tools

This file documents the current built-in MCP tool surface, its arguments, semantics and design rationale. The published JSON Schemas in `mrmcp.js` are executable contracts; this file explains why the contracts have this shape.

## General conventions

### Session capability

Every tool except `init_chat_session` requires `chat_session`, the opaque `ctx_...` capability returned by `init_chat_session()`. Pass it unchanged, including to `list_workspaces`, `open_workspace`, `tools_schema` and configured custom tools. All tool results use the same `chat_session` envelope. Initialization creates a Session with no selected Workspace; `open_workspace` only attaches or moves an existing Session, preserving its identity. Missing/unknown/expired capabilities never create replacement Sessions implicitly; old `context_handle` and `current_context_handle` arguments are rejected.

### Filesystem paths

Filesystem paths are relative to the Session's current Workspace unless the specific tool says otherwise. MrMCP resolves and confines them to that Workspace.

### Result summaries and tool choice

`structuredContent` remains the complete structured result. Filesystem tools, `tools_log`, `memory_find`, Workspace discovery, command discovery and `tools_schema` also return a short text summary of counts, failures and applicable continuation fields. Summaries are derived only from current result metadata; they never duplicate file contents, match snippets, fingerprints, nested payloads or complete JSON. Batch mutation summaries report both succeeded and failed entries, including all-failed batches; the per-entry statuses remain authoritative and the existing call-level completion semantics are unchanged.

Choose `fs_glob` for paths, `fs_grep` for textual occurrences (including comments, strings and configuration), `fs_navigate` for next/previous matches in known files, and `fs_read` for known ranges. Use `source_code_search` for Lucerna BM25 relevance search and AST symbols. Batch independent reads. Request a few context lines when nearby source can avoid another read; the default remains zero. For additional caller/impact exploration, prefer a suitable available command from `discover_commands`, following its catalog description; the versioned catalog already includes Cymbal.

### `document_grep`

Requires `chat_session`. Uses its selected Workspace, or Search `default_path` when none is selected. Empty/omitted `default_path` means OS Desktop/`_default`, created on the first search. This does not create or attach a Workspace; other file/process/kernel tools still require one. Xberg 1.3.2 extracts local documents; LanceDB 0.27.2 (0.22.3 on Intel macOS, the last stable Intel binding) stores passages and performs fulltext/BM25 and vector search. The separate Lucerna tool provides lexical/AST source retrieval. On macOS Intel, extraction uses Xberg's public npm WASM initializer. Deno manages the package and its WASM/license; standalone builds embed that dependency and work without downloading it at runtime. Other supported platforms use native Xberg. There is no separate WASM asset under assets.

| Argument | Behavior |
|---|---|
| `query` | Required nonempty text, up to 4,096 characters. |
| `mode` | `auto` (default), `fulltext`, `vector` or `hybrid`. Auto uses hybrid when an embedding model is configured, otherwise fulltext. |
| `path/include/exclude/gitignore/hidden` | Source-directory selection with globstar `**`, parent/nested ignore rules and negations. Gitignore defaults true; hidden defaults false. Symlinks are skipped. |
| `mime[]` | Exact types or `type/*`; inferred from local filename extensions. |
| `limit` | Default 10, maximum 100 hits. |
| `max_files`, `max_file_bytes` | Defaults 1,000 files and 20 MiB per file; maxima 5,000 and 50 MiB. |

Every call hashes current selected files. A changed hash or extraction version replaces only that file's passages; unchanged extraction and embeddings survive restart. Completed traversal prunes vanished/newly ignored paths only inside the requested path/glob/MIME selection. Incomplete traversal never prunes unseen paths. Other selections remain stored but cannot appear in results: both fulltext and vector queries filter current eligible files/chunks. Failed/oversized files are excluded even if an older snapshot exists. No background Workspace crawl runs.

Functional indices and a hash/MIME manifest live under `.mrmcp/search/<hash-of-real-Workspace-path>/`; unassigned Sessions use `.mrmcp/search/_default/<hash-of-real-source-path>/`. These survive restart and Tool Call cleanup. Changing the default source directory gets a different hash and cannot expose an earlier directory’s stored results. Index mutation serializes only within the same Workspace. Vector tables are separated by provider/endpoint/model; changed/deleted selected files lose obsolete vectors. Fulltext requires no embedding provider. Ollama `/api/embed` and OpenAI-compatible `/embeddings` receive bounded batches; no model is downloaded automatically. Hybrid uses reciprocal-rank fusion (`k=60`).

Calls read at most 64 MiB of selected source bytes, bound extracted text to 8 MiB per file and changed/vector-selected passages to 20,000, and bound returned traversal entries to 100,000. Passages contain at most 2,400 UTF-16 characters without splitting surrogate pairs. Output includes effective mode/gitignore, indexing/reuse/removal/scanning counts, truncation, total error count with at most 100 details, returned count and hits with id, Workspace-relative path, MIME, chunk number, text, extracted line bounds and score. PDF lines refer to extracted text rather than original page/source coordinates.

Settings → **Search** shows the resolved fallback source folder and edits root `search.yaml`, containing `default_path` (empty for OS Desktop/`_default`, otherwise absolute or relative to the MrMCP directory), `embedding` (provider, endpoint, model, api_key) and `ocr` (native or disabled). Native OCR uses Auto.js public image/OCR APIs and the OS's installed recognition support, with no custom FFI wrapper or external OCR fallback. Standalone builds preserve existing YAML edits and use Application Support on macOS.

Download subtitles with the catalog `yt-dlp` command and index the resulting Workspace files. This tool has no URL, transcript-download, proxy or audio-download integration. For example, execute `yt-dlp --skip-download --write-subs --write-auto-subs --sub-format vtt --sub-langs en.* --paths . URL`, then call `document_grep` with an appropriate file selection.

### `proxy_get`

Requires `chat_session`, with no selected Workspace. The configured global pool comes from **Settings → Proxies** / root `proxies.yaml`. The tool exposes three actions:

- `action=pick` (default): select distinct eligible entries, default `limit=1`, maximum 50. `mode=round_robin` selects the least recently selected eligible proxy globally, using health to resolve ties; selection advances a persistent monotonic cursor. `mode=random` samples without replacement, weighted by `(successes+1)/(successes+failures+2)/(consecutive_failures+1)`. Both skip active cooldowns.
- `action=list`: paginate configured/resolved order with `offset` (default 0, maximum 10,000), `limit` (default 20, maximum 50) and `next_offset`. Listing includes unavailable/cooled-down entries and never advances selection.
- `action=report`: require a previously picked `proxy_id` and boolean `success`. Success increments successes and clears consecutive failures/cooldown. Failure increments failures/consecutive failures and applies `failure_cooldown_seconds * 2^previous_consecutive_failures`, capped at 24 hours. Optional `retry_after_seconds` (0–86,400) overrides that delay. Report does not fetch list sources. Report arguments on other actions and nonzero pick offsets are rejected.

`include_direct` defaults true; false excludes the special `direct` entry representing a direct HTTP request. Explicit proxy entries accept HTTP(S), SOCKS5/SOCKS5H, bare host:port and optional URL credentials. Returned URLs include those credentials when configured. Proxy ids are SHA-256 of normalized entries; only ids, successes, failures, consecutive failures, selection/report timestamps and cooldowns are stored in the main SQLite `proxy_stats` table. Statistics are shared across Sessions, survive restart and Clear Operational Data, and never appear in the YAML pool file. No automatic network probe or outcome inference runs: callers must report the actual request outcome.

`proxies.yaml` contains `proxies[]`, newline-list `proxy_lists[]`, `list_ttl_minutes` (default 60), `request_timeout_seconds` (15), `max_entries` (200) and `failure_cooldown_seconds` (30). It seeds direct access and two public list URLs. At most 20 sources and 2,000 configured entries/source URLs are allowed. Sources are fetched only during explicit pick/list calls, with a shared per-source fetch across concurrent callers, a 1 MiB response cap and memory TTL. Invalid/comment lines are skipped, normalized duplicates removed, configured order preserved and the final pool bounded. Source failures are reported without discarding other usable entries. Saving configuration clears source caches; no background fetch/probe runs.

Output contains action/mode, total configured/resolved count, offset, returned count, next_offset, next_retry_at, proxies and source errors. Each proxy has proxy_id, proxy, available and stats. Report returns proxy=null because it updates by id without fetching the pool. If every entry is cooling down, pick returns an empty array plus the earliest next_retry_at; it does not wait. Pool membership/page offsets may change when remote lists refresh.

Examples:

`{"chat_session":"ctx_...","mode":"random","include_direct":false}`

`{"chat_session":"ctx_...","action":"report","proxy_id":"<returned id>","success":false,"retry_after_seconds":120}`

### `source_code_search`

Requires `chat_session`. Uses its selected Workspace, or Search `default_path` when none is selected. Empty/omitted `default_path` means OS Desktop/`_default`, created on the first search. This does not create or attach a Workspace; other file/process/kernel tools still require one. Uses the public Lucerna 0.2.9 `TreeSitterChunker` and `Searcher` APIs. This build supports local **lexical BM25 and AST**, without semantic embeddings, remote providers, reranking or call-graph analysis. Code-aware tokenization keeps identifiers and splits camelCase/underscores. Queries are ordinary words/identifiers, not FTS query syntax or regular expressions.

| Argument | Meaning |
| --- | --- |
| `action` | `search` (default), `map`, `files`, `chunks`, `stats`. |
| `query` | Required for search. Results appear in relevance order with `matchType: lexical`. |
| `path`, `include[]`, `exclude[]`, `hidden` | Same path-selection rules as filesystem tools, relative to `source_directory`. Include/exclude are relative to `path`; hidden defaults false. |
| `file_path` | File relative to `source_directory`, required for chunks; a path/glob filter for search. |
| `language`, `types[]` | Search filters by one/many languages and Lucerna chunk types. Language aliases include `c++` → `cpp`, `c#` → `csharp`, `js`/`jsx`, `ts`/`tsx`, `py`, `yml`, `sh`/`shell`, `ps1`, `md` and `objective-c`. Results use canonical names. Map accepts types. |
| `include_content` | Default true; false omits source `content` and enriched `contextContent` from returned chunks. |
| `limit`, `offset` | Stateless result pagination; defaults 10/0, limit up to 100. Reuse the selection/query and pass `next_offset` as offset. |
| `max_files`, `max_file_bytes` | Indexing bounds: defaults 5,000 files and 1 MiB per file, maxima 10,000 and 2 MiB. Also capped at 32 MiB total selected source and 100,000 traversal entries. |

`.gitignore` is **always enabled** and cannot be overridden. Uses the existing Workspace selector, including applicable parent rules, nested rules and negations. Symlinks are skipped. Every call reselects and hashes live eligible files. File hashes, AST chunks and a contentless SQLite FTS5/BM25 index persist in `lucerna.sqlite` under `.mrmcp/search/<hash-of-real-Workspace-path>/`, or `.mrmcp/search/_default/<hash-of-real-source-path>/` without a Workspace. Unchanged AST chunks are reused after restart; only changed selected files are parsed again. Completed traversal prunes missing/newly ignored files only inside that requested selection. Other scopes remain stored; incomplete traversal never prunes unseen paths. Failed, oversized, ignored and out-of-scope files cannot appear because results join the current eligible selection. No `.lucerna`, index database or configuration file is created in the source folder. Indices survive operational-history cleanup. Workspace `lucerna.config.ts` is never evaluated. Supported canonical languages: `javascript`, `typescript`, `json`, `markdown`, `go`, `c`, `cpp`, `zig`, `html`, `python`, `yaml`, `php`, `java`, `rust`, `csharp`, `kotlin`, `swift`, `ruby`, `bash`, `powershell`, `sql`, `css`, `scss`, `vue`, `svelte`, `toml`, `lua`, `r`, `scala`, `dart`, `perl`, `haskell`, `elixir`, `clojure`, `matlab`, `groovy`, `solidity`, `julia`, `ocaml`, `erlang`, `objc`. Common extensions include Go, C headers, C++ `.cpp/.cc/.cxx/.c++/.hpp/.hh/.hxx/.h++` (uppercase `.C` is C++), Zig, HTML/HTM, Python/PYI/PYW, YAML/YML and PHP/PHTML/PHPS/PHP3/PHP4/PHP5/PHP7/PHP8. Extension matching is case-insensitive except the conventional uppercase `.C` distinction. Languages detected by the pack without a Lucerna extractor are counted as unsupported. Grammar libraries are not embedded in the executable. The parser's public API initializes JavaScript, TypeScript and JSON on first use and downloads additional supported grammars when selected files need them; Markdown uses its grammar-free extractor. These libraries use the package's normal OS cache, independently of the MrMCP index. Standalone builds retain only their target's native parser binding. Intel macOS resolves the companion's public npm entry and loads it through the main parser's NAPI_RS_NATIVE_LIBRARY_PATH option; loading is synchronous, the previous environment value is restored immediately, and vendor loaders are unchanged.

Both retrieval tools return absolute `source_directory` and `index_directory`, plus `workspace_selected`; false means the Session stayed unassigned and used the default source folder. Search-index storage cannot be used as input files. Source results also report `reindexed_files`, `unchanged_files`, `removed_files` and `scanned_files`.

The result includes `mode: lexical`, `gitignore: true`, scope `path`, indexed file/chunk counts, skipped oversized/unsupported counts, total `error_count` plus at most 100 error details, indexing `truncation_reason`, result `returned` and `next_offset`. `truncated` means an indexing bound was reached or another result page exists; skipped files and errors also indicate incomplete coverage. `data.results` contains search hits (`chunk`, `matchType`), chunks, symbol-map entries or file paths according to action. `data.stats` contains counts and language breakdown. Chunk IDs remain stable for unchanged content. Distinct symbols sharing Lucerna's file/start-line ID receive deterministic distinct IDs; their original ID is retained in `metadata.lucerna_id`. Native Lucerna chunk fields retain `id`, source-directory-relative `filePath`, `language`, `type`, optional `name`, and one-based `startLine`/`endLine`; use filesystem tools to obtain edit fingerprints.

```json
{"chat_session":"ctx_...","query":"authentication middleware","types":["function","method"],"limit":10}
{"chat_session":"ctx_...","action":"map","include_content":false,"limit":50}
{"chat_session":"ctx_...","action":"chunks","file_path":"src/auth.ts"}
```

The compatible parser is pinned to 1.6.2; current newer npm native packages are not usable on the tested Deno/Windows runtime. The Intel macOS companion is provided as a normal npm dependency. Do not infer caller/semantic capabilities from lexical hits. Refresh the connector and test this new tool from a new chat/branch after updating the executable.

### Stateless filesystem navigation

Filesystem discovery, search and navigation keep no server-side cursor state.

- `fs_glob` continues with `after_path` / `next_after_path`.
- `fs_grep` continues with `resume_after` / `next_resume_after`.
- `fs_navigate` receives an explicit `from_line` and direction for every file on every call.
- `fs_read` continues a truncated range with `next_start_line`.

These cursors describe positions in the current data, not a frozen snapshot. Reuse the same selection and search arguments on continuation. Changes to files or line positions between calls can change subsequent results; returned fingerprints identify the content version read. Each text read/search still decodes complete files and computes whole-file metadata where required, even when the returned page is small.

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

- `encoding:"auto"` uses only the charset reported by pinned `chardet`. For `fs_read`, `fs_grep` and `fs_navigate`, Settings → Files selects **Initial 16 KiB** (default, persisted as `text_encoding_detection=sample`) or **Complete file** (`full`). The sample is a zero-copy prefix of the original byte buffer; files at or below 16 KiB are detected in full. The selected decoder still reads the entire file strictly. Sample mode uses the first candidate from the public `chardet.analyse` API only when its confidence score is at least 80. If the candidate is absent, has a lower confidence score, yields no charset or decoding fails, `chardet.detect` and strict decoding retry once with the complete original buffer. A sample may miss later charset clues even when decoding succeeds; Complete file inspects all bytes. Mutations (`fs_write`, `fs_edit`, `fs_text_convert_encoding_eol`) always detect the complete source when automatic decoding is needed, regardless of this read/search setting. BOM, UTF-8 validity, NUL patterns and other local heuristics never select or override a charset. If full detection/decoding fails, the tool reports the error. An explicit input encoding bypasses `chardet` entirely in both modes.
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

### `chat_set_goal`

Set a user-requested, repeating follow-up message for a ChatGPT conversation. MrMCP sends the saved text after an interval without MrMCP Tool Call activity. It does not evaluate progress, interpret the goal, detect completion, or stop because ChatGPT says the work is finished. Repetition ends through explicit cancellation, global suspension, Session expiry/deletion or an uncertain delivery. No selected Workspace is required.

#### Arguments and result

| Argument | Contract |
| --- | --- |
| `chat_session` | Required active capability from `init_chat_session`; identifies the MrMCP Session, not the ChatGPT conversation id. |
| `goal` | Required string, at most 32,000 JavaScript string code units. Nonblank text is kept exactly, including whitespace; empty/whitespace-only becomes an empty goal and stops follow-ups. |
| `timeout_seconds` | Optional integer, 30–86,400. Omission uses the current global default, initially 300. Each call selects its interval anew: omitting it when updating a goal uses the current default, not that goal's previous override. |

Example tool arguments, using an already-created Session:

```json
{"chat_session":"ctx_...","goal":"Continue the work, verify the result and report any blocker.","timeout_seconds":300}
```

To stop:

```json
{"chat_session":"ctx_...","goal":""}
```

Returns the common `chat_session` envelope plus `goal`, `timeout_seconds`, `status`, `chatgpt_chat_id`, `chat_url`, `next_check_at`, `last_sent_at`, `detail`, `browser` and `user_data_dir`. Missing association/timestamps/detail are `null`; timestamps are Unix milliseconds. `next_check_at` is a scheduler check time, not a promised delivery time, and can lag new activity until that check recomputes the deadline. `last_sent_at` is the last confirmed submission and remains available after clearing/replacing the goal.

Without a verified login profile, a nonempty set saves the goal as `waiting_login`, with no next check and no browser launch. Initialize/verify login in Settings and call the tool again for an unassociated Session; linked goals may resume after verification. With a verified profile, for an unassociated Session each explicit nonempty set saves `pending` and schedules one matching attempt for no earlier than one second later; the actual start depends on the five-second scheduler. The call returns before discovery. Before opening Chrome, the scheduler persists `matching` and consumes the request by setting `goal_next_check_at=0`. One attempt may inspect up to 20 recent candidates. Missing login, a draft, no match, browser/capture errors, time-budget exhaustion or interruption finish that attempt with `next_check_at:null`; they never schedule another matching scan. Resolve the issue and call `chat_set_goal` again to rearm, including with the same text. Tool Call activity, login completion, global disable/re-enable and settings changes do not rearm a consumed attempt. Within the current run, an unstarted pending request can still run later. At restart, matching is off by default: interrupted `matching` and still-queued `pending` requests become unscheduled errors. The optional startup policy below is the only automatic rearm exception. A Session with an existing association immediately becomes `ready` and schedules its interval. `ready` means associated and eligible for scheduling, not that login, the page and Send have already been checked. Replacing or clearing a goal increments its revision, invalidating older work, clears its error and keeps the conversation association. The tool does not accept a manual conversation-id override.

#### Global settings and browser lifetime

Initialize the dedicated profile through **Settings → Goals → Login ChatGPT** and sign in interactively or finish any challenge. One login observer checks that same page immediately and every 500 ms, without overlapping checks, until it recognizes an existing or newly completed login. No second confirmation is needed. Closing/disconnecting the window stops this observation without reopening Chrome; use the button again to continue. This explicit flow is available even when global management is off. Automatic matching/sending pauses throughout setup, including across a restart before verification. Setup launches Chrome visibly with images and `windowsHide:false`; a running headless/image-blocked dedicated browser is restarted only when its shared tab has no draft, active response or dialog. The ordinary system browser is never used. Existing running launch options otherwise remain unchanged.

Automatic login detection preserves drafts and requires a fresh successful recent-conversations response requested by the website on the canonical ChatGPT page, with no observed login screen. Editor availability is checked separately and cannot veto authenticated recent-chat evidence. The current editor’s `data-composer-markdown` / `data-chatgpt-composer` machine markers are supported alongside the native form fallbacks. Settings displays Opening, Checking, Signed in, Sign-in required, page/challenge waiting, closed or error states and an independent monitoring status; opening runs asynchronously so it cannot block GUI input. If an already-signed-in page loaded before attachment, the login observer may navigate home once after its composer becomes usable and its draft is empty; it never refreshes in a loop or navigates away from an active login flow. A public logged-out composer alone is insufficient. MrMCP reads neither authentication cookies/headers nor login/session payloads and issues no private authenticated HTTP request. Unknown layouts/capture formats, login screens and challenges leave setup pending with a diagnostic. After success, only the verification timestamp (`chat_goal_login_verified_at`, initially `0`) is persisted in the existing config table; credentials/site data stay in Chrome’s profile. This records a successful setup, not a permanent authentication guarantee. An observed login screen or a 401 on conversation data during matching/sending clears readiness and stops automatic browser work until the operator uses Login ChatGPT again. Login readiness and the user enable switch are independent: login detection never enables a disabled feature, disabling preserves readiness, and explicit login observation can finish with the feature disabled. Close the login window after verification to use the saved headless/image/process settings on the next launch.

Verification can resume already-associated eligible goals; it never re-arms an unassociated match, evaluates a goal or sends a test message. Sessions → Login settings opens this same Settings tab. The remaining controls are persisted through **Save Settings**. No SQLite schema change is needed.

| Control | Config key | Default | Effect |
| --- | --- | --- | --- |
| Enable chat goal management | `chat_goals_enabled` | On (`1`) | Starts/stops background goal work. |
| Retry missing chat matches at startup | `chat_goal_match_on_startup` | Off (`0`) | At startup only, queue one matching attempt per active unassociated goal if global goal management is enabled. Saving the setting does not run matching immediately. |
| Default inactivity timeout | `chat_goal_timeout_minutes` | 5 | Whole minutes, 1–1440; used by subsequent sets that omit `timeout_seconds`. Existing goals keep their interval. |
| Stop the current response before sending | `chat_goal_stop_before_send` | Off (`0`) | When on, click Stop before inserting the prompt and check that it takes effect. Applies to subsequent send attempts without a browser restart. |
| Headless | `chat_goal_headless` | Off (`0`) | Whether the next dedicated Chrome launch has a visible browser window. |
| Disable page images | `chat_goal_disable_images` | Off (`0`) | Images load normally by default. Enabling this passes `images:false` to cdp.js at launch; screenshots remain possible. Existing saved choices are preserved. |
| Spawned process window / console | `chat_goal_windows_hide` | `auto` | `auto` makes `windowsHide` equal to headless; `hide`/`show` explicitly override it. This controls process-console visibility, not headless rendering. |

MrMCP uses the shared unversioned `@mefistofelix/cdp.js` library, browser name `mrmcp-chatgpt`, profile `<active data directory>/cdp/mrmcp-chatgpt/`, and one logical page named `goals`. All Sessions use the ChatGPT account logged into that profile and share that single page. The normal desktop browser/profile is not used. Chrome is created by explicit login setup, or lazily for discovery/delivery after successful setup. An unverified profile never launches Chrome in the background. An enabled feature with no goals does not launch Chrome merely because its timer runs.

The browser/profile and page identity are reused when available. Launch changes take effect after closing the dedicated browser and letting MrMCP launch it again; they do not reconfigure a running Chrome process. Keep headless off for interactive sign-in or challenges. The browser retains its own cookies/site data in the profile, subject to the site's expiry/revalidation rules. MrMCP does not guarantee that login or a challenge will never be requested again.

Turning global management off stops the interval, removes monitor listeners/captured metadata, disconnects the dedicated inspector and prevents subsequent automatic browser opening, navigation and sending. Chrome itself remains running; profile, associations and saved goals remain intact. The tool stays published: a valid nonblank set returns `disabled`, `next_check_at:null` and the existing goal without changing it. Validation still applies, and an empty goal can still clear saved state. Re-enabling resumes eligible goals without resetting elapsed time; an overdue goal can therefore run on the next tick. `delivery_uncertain` and consumed unsuccessful/interrupted matching attempts stay suspended. Operations already dispatched to Chrome cannot be recalled.

With **Retry missing chat matches at startup** off, restarting does not resume failed, interrupted or never-started matching requests. When on, each backend startup queues one new attempt for each nonexpired Session with a nonempty goal and no ChatGPT association, preserving its text, timeout and explicit-set timestamp. Cleared/disabled/expired goals, existing associations and `sending`/`delivery_uncertain` states are excluded. A failed startup attempt stays unscheduled until another explicit set or a later opted-in startup. Global management must be enabled and the login profile verified at startup; enabling it later does not replay startup matching. A normal settings save never triggers this startup hook.

#### How the ChatGPT conversation is found

1. Open/reuse the dedicated page. Goal setup uses `initialize:false`; it explicitly installs scoped Network event listeners and enables Network before navigating. DOM checks use `Runtime.evaluate` without enabling Runtime reporting or adding the normal page binding.
2. Preserve an existing draft, login flow or modal dialog rather than navigating away. A current assistant response does not block discovery; candidate histories/tool details may be matched while that candidate is responding. Otherwise open `https://chatgpt.com/`.
3. Observe requests made by the website itself. The monitor recognizes successful JSON responses for `/backend-api/conversations` and `/backend-api/conversation/<id>` or `/backend-api/conversations/<id>`, excluding list requests marked `is_archived=true`. After `Network.loadingFinished`, it reads that response body through `Network.getResponseBody` on the original page session. It does not issue authenticated HTTP fetches, replay private requests or extract authentication cookies/headers.
4. Merge observed recent lists by conversation id and sort by `update_time`, newest first. Append canonical conversation links found in the rendered navigation areas, deduplicate, and consider at most 20 candidates. It does not exhaustively page through the account's archive or search every conversation.
5. Navigate to each candidate. For a captured history, follow the complete active branch from `current_node` through each node's `parent`. Recognize assistant messages addressed to `api_tool.call_tool`, parse `content.text` as JSON, require the final segment of `path` to name a MrMCP built-in tool, and compare `args.chat_session` exactly. Any such call on the active branch can establish the association; it need not be `chat_set_goal` or the latest call. Abandoned branches and Session-like strings in ordinary messages are ignored.
6. If a valid captured branch has no match, move to the next candidate. If capture is absent/unsupported, inspect rendered tool JSON and expand structurally identified disclosure panels. This fallback examines up to 12 recent assistant containers/disclosure candidates, parses complete JSON in tool-marked or related code blocks, and requires the exact Session handle in the supported tool wrappers. It does not infer association from a quoted token or prose example.
7. Persist the first verified match in `contexts.chatgpt_chat_id`, re-read its current activity/revision and immediately continue to delivery if already due. The matched page is reused without a reload or another scheduler tick. If not due, save the deadline and continue to another goal. Later sends reuse `https://chatgpt.com/c/<id>` without rediscovery. If the stored conversation disappears or the account changes, failures are surfaced; the current tool has no reset/rebind argument, and clearing a goal retains its association.

The adapter follows the [cdp.js monitoring recipe](https://github.com/mefistofelix/cdp.js/blob/master/tests/chat-monitoring.md). Push frames for conversation creation/turn completion only update candidate ordering and invalidate old captured history; they never prove a Session match and do not reset the inactivity timer. Navigation generations discard history bodies that complete after their navigation has been superseded.

Only one nonempty goal may be associated with a given ChatGPT conversation. The most recent explicit set wins; association discovery also checks for a newer already-associated goal before replacing anything. Equal set times are resolved by the newer numeric Session id. Older replaced goals are cleared, with an explanatory detail.

#### Timer, activity and scheduling

The earliest delivery deadline is recomputed as:

```text
max(last_active_at, goal_activity_at, goal_updated_at, goal_last_sent_at)
  + goal_timeout_seconds × 1000
```

Authenticated `tools/call` requests with a valid nonexpired `chat_session` and a nonempty tool name record arrival activity before tool lookup/schema validation. Therefore schema-rejected/unknown-tool calls also defer a goal; rejected authentication or invalid/expired capabilities do not. Completion of an executed call records activity again, including failure. Activity from any Session already associated with the same conversation updates the active goal for that conversation. Calls that never reach MrMCP are invisible to this timer.

Ordinary user/assistant messages, typing in another browser, ChatGPT push events, and tools belonging to other connectors do not count as MrMCP activity. A foreground MrMCP call already in flight does not suppress a prompt once the inactivity interval expires; this lets Goals try to unblock a stalled call/chat. A detached process remaining alive after `exec_start` returns does not itself keep a Tool Call in flight; subsequent process tool calls count normally. Goal-generated browser operations create no synthetic MCP Tool Calls and do not renew Session activity.

Every five seconds, one non-overlapping scheduler pass selects due nonempty goals, ordered by next check and Session id. It handles them sequentially through the shared page; ordinary MCP tool execution remains concurrent. A match, any due send and timer reset are consecutive operations in that pass. Once submission is confirmed, the page is available for the next goal immediately; the scheduler never waits for the assistant's resulting answer. Maintenance defers work. New Tool Call arrivals/completions move the deadline, but the continued existence of an older call does not. A future inactivity deadline is saved and checked later without opening the browser. Browser work, discovery and other earlier due goals can delay a send beyond the nominal timeout.

Example: with a 300-second goal, a tool begins at 10:00 and finishes at 10:02. The earliest send is 10:07, followed by the next eligible scheduler pass and browser checks. A confirmed send at 10:07:04 sets the next interval to 10:12:04. Any later MrMCP activity postpones it again. A response still running in the destination does not veto delivery: MrMCP attempts to submit the prompt. A draft is preserved and defers delivery. With Stop-before-send enabled, it interrupts the destination response first; otherwise it leaves the response running and uses the available submission path.

#### Exact send sequence and cancellation

1. Check the current shared page for a draft, dialog or login flow before changing it. An existing draft still prevents navigation to protect its contents; an assistant response in another conversation does not.
2. Navigate to the associated conversation, or reuse it if already loaded. A response in progress is allowed. If Stop-before-send is enabled, recheck the goal revision, inactivity deadline and maintenance state, then click the unique enabled `[data-testid="stop-button"]` control only when response markers are present. Poll at 100 ms intervals for up to five seconds (plus CDP latency) until those markers clear and the composer is ready. Recheck cancellation/activity throughout; missing, ambiguous or disabled Stop, a changed conversation, or failure to become ready produces an error instead of pretending that interruption succeeded. If no response is active, this is a no-op. Then require a usable composer, the exact conversation path, an empty draft and an identifiable existing user message, and focus the editor.
3. Re-read the goal revision/activity, check maintenance, and confirm the deadline is still due. Related Tool Call arrivals/completions are already reflected in that deadline.
4. Insert the exact saved text with CDP `Input.insertText`, then repeat the revision/activity/maintenance checks.
5. Persist `sending` before dispatch. Re-resolve the page and require the exact URL, unchanged inserted text and a structurally valid composer. Activate the unique available submit control with DOM `.click()`. While a response is active and no submit control exists, use the native `HTMLFormElement.requestSubmit()` path only for a single-editor form; Stop controls are excluded from submit selection. This lets the website accept/queue the prompt according to its own behavior. Never click Stop implicitly when the option is off. When it is on, renewed response activity blocks dispatch because the requested interruption no longer holds. No clipboard operation or simulated Enter is used.
6. Check up to 40 times, sleeping 250 ms between checks, for an empty composer and a new rendered user message whose id was absent before sending and whose text exactly equals the goal. CDP execution time adds to this roughly ten-second observation window. Confirmation saves `goal_last_sent_at`, returns to `ready` and starts another full interval; the scheduler immediately continues to the next goal even if ChatGPT has started responding to the message.

Attempting submission during a response does not guarantee that a particular ChatGPT UI version accepts or immediately renders it; disabled/ambiguous controls remain errors, and a dispatched form submission that produces no observable acknowledgement follows the same uncertain-delivery rule. Confirmation is an observation of ChatGPT's rendered UI, not an independent server delivery receipt. If dispatch may have happened but confirmation is missing, the state becomes `delivery_uncertain` and there is no automatic retry. Restart converts a saved `sending` state to `delivery_uncertain`. Inspect the conversation and explicitly set the goal again to rearm it.

Replacing/clearing a goal, disabling management, Session deletion/expiry and new activity are checked before submission. If insertion occurred but dispatch did not, cleanup attempts to remove only the exact inserted text from the same conversation, while management is still enabled and the server is not stopping. A changed draft is preserved. A message already dispatched cannot be cancelled; a draft may remain if shutdown/disable interrupts cleanup.

#### States and operator actions

| Status | Meaning / next action |
| --- | --- |
| `disabled` | Goal cleared, or global management off. Global off masks the stored status; it does not erase the goal. |
| `pending` | An explicit set or opted-in startup has queued one matching attempt which has not started yet. |
| `matching` | That attempt is in progress; it has already been consumed persistently, so a crash cannot repeat it. |
| `ready` | Associated and scheduled. Login/composer checks still happen at delivery time. |
| `waiting_login` | Login setup is missing or a logout was detected. Use **Settings → Goals → Login ChatGPT** and sign in; recognition is automatic. No background browser work resumes before recognition. Then call `chat_set_goal` again for an unassociated Session; eligible linked goals resume when the user enable switch is on. |
| `not_found` | No exact Session match in the bounded recent candidates. Ensure the correct account/chat and a visible MrMCP tool call, then call `chat_set_goal` again. No automatic discovery retry. |
| `busy` | Discovery was interrupted by maintenance or exhausted its soft time budget. Call `chat_set_goal` again to request another matching attempt. An assistant response alone no longer puts a goal into this deferred state. |
| `draft_present` | The shared page contains text that MrMCP will not overwrite. Send or remove that draft manually. An unassociated goal needs another `chat_set_goal` call to retry matching. |
| `error` | Browser, navigation, unsupported page structure or pre-dispatch failure. Read the bounded detail in Sessions. Before association, another explicit set is required; after association, normal delivery retry applies. Internal DOM `not_ready` is projected as `error`. |
| `sending` | Dispatch has been prepared and acknowledgement is being observed. |
| `delivery_uncertain` | Dispatch outcome could not be confirmed, or restart interrupted sending. Automatic sends are suspended; inspect and explicitly rearm. |
| `expired` | Session exceeded its 30-day inactivity lifetime. Automatic goal messages do not extend that lifetime. Use an active Session. |

For already-associated goals, normal stored delivery deferrals/errors schedule another check 60 seconds later, subject to the global enable switch and login readiness. Unassociated matching attempts never use that automatic retry; their result has `next_check_at:null` and a detail asking for another `chat_set_goal` call. An opted-in future startup can also queue one new attempt. A scheduler pass skipped solely because of maintenance or an existing scheduler task uses the next available tick instead. **Sessions** shows the goal preview, interval, status/detail, conversation id, next check and last confirmed send. **Stop goal** clears it immediately. **Login settings** opens the Goals tab, whose single **Login ChatGPT** button initializes or repairs the dedicated login. Neither action retries a missing match or forces a send. Explicit login setup is also available while global management is off.

#### Persistence, bounds and interface compatibility

Persistent Session fields are `chatgpt_chat_id`, `goal_text`, `goal_timeout_seconds`, `goal_revision`, `goal_updated_at`, `goal_activity_at`, `goal_status`, `goal_next_check_at`, `goal_last_sent_at` and `goal_error` (bounded to 500 characters), alongside ordinary Session activity. They survive restart and **Clear Operational Data**, independently of Tool Call Disk/Memory and Payload/Metadata policies. Clearing/deleting Sessions removes their goals. Closing/stopping MrMCP stops monitoring; its detached Chrome process/profile can remain. Restart resumes eligible overdue deliveries only with global management enabled and login readiness retained. Missing matching requests, including never-started ones, remain stopped unless the startup matching option is also enabled. In that case it queues one attempt per eligible goal, without resetting the delivery interval or explicit-set timestamp. Matching uses the existing status/next-check/revision fields; no new schema column is needed.

Captured lists/history summaries are memory-only: at most 200 recent ids, 20 history summaries, 100 tracked response requests/epochs each, and 8 concurrent body reads. The monitor rejects bodies above 8 MiB encoded transfer size or 12 MiB returned string length; branch traversal is capped at 20,000 nodes and 100 distinct Session handles. Full history bodies are not stored in the database or exposed as goal Tool Call results. Internal goal CDP responses do not enter the public response ring; an explicitly configured general CDP notification subscription on this browser still follows the normal CDP subscription contract.

Connection/goal RPC waits are bounded (15 seconds; target acquisition 20 seconds). Navigation readiness is polled for 15 seconds; discovery waits up to 2 seconds for a recent-list capture and up to 3 seconds per candidate history. Candidate discovery uses a 90-second soft deadline checked between operations, not a hard whole-task limit: an already-awaited browser operation can extend it.

DOM identification uses machine attributes and native HTML/ARIA structure: unique editors, form-owned submit controls (including external `form=` controls), canonical conversation links, `aria-controls`/`aria-expanded` and `details`/`summary`. It never selects controls by translated labels, accessible-name wording, generated CSS classes or icon shapes. Login and ongoing-response recognition also use structural/machine markers. It refuses ambiguous editors/submits, dialogs, unavailable controls or missing message identity. This tolerates locale changes and some layout changes, but endpoint/payload contracts, machine attributes and form structure can change; the adapter reports failure/deferral instead of guaranteeing compatibility with every future website version.

Implementation entry points in `mrmcp.js`: `setChatGoal` / `chatGoalView` (contract), `recoverChatGoals` / `chatGoalConfigure` / `chatGoalTick` / `chatGoalRun` (recovery and scheduling), `noteChatGoalActivity` / `chatGoalDue` (activity), `chatGoalPage` / `chatGoalMonitor` / `chatGoalHistorySessions` / `chatGoalFindChat` / `chatGoalBind` (browser and association), and `chatGoalDom` / `chatGoalSend` (submission).

### `chat_goal_debug`

User-requested diagnostics and manual actions for the current `chat_session`; no Workspace is required. The tool remains published when Goals is disabled.

| Argument | Meaning |
| --- | --- |
| `chat_session` | Required active MrMCP Session capability. |
| `action` | `status` (default), `match`, or `send`. |
| `stop_before_send` | Optional boolean for `send` only, overriding the global Stop option for this attempt without changing Settings. |

`status` reads saved association, goal, deadline, login readiness and enablement without opening Chrome. `match` immediately performs one normal exact-Session matching scan, including rechecking a stored association; it sends no prompt and retains the old id if rechecking fails. A successful match uses the normal newest-goal ownership rule. `send` submits the saved nonempty goal to the already-associated chat immediately, bypassing the inactivity deadline. It uses the same shared tab/pass lock and the same Stop, draft, maintenance, revision, activity and acknowledgement checks as timed delivery. New Tool Call activity during the attempt still cancels pre-dispatch work. Confirmation resets the ordinary inactivity interval. Global disable, missing login, a missing goal/association or a previous `sending`/`delivery_uncertain` state defers the action; inspect and rearm uncertain delivery through `chat_set_goal` first. These calls themselves count as normal MrMCP activity.

The result contains the usual goal fields plus `action`, `operation_status` (`inspected|deferred|matched|not_found|sent|failed`), `operation_detail`, `enabled`, `login_ready`, `login_status`, `chat_session_matched`, `scheduler_busy` and `due_at` (Unix milliseconds or null). `chat_session_matched` reports whether an association is stored; only `operation_status:matched` confirms this scan, and only `operation_status:sent` confirms this submission. No arbitrary prompt, account id or conversation-id override is accepted.

Examples using the actual capability:

```json
{"chat_session":"ctx_...","action":"status"}
{"chat_session":"ctx_...","action":"match"}
{"chat_session":"ctx_...","action":"send","stop_before_send":true}
```

After installing this newly published tool, refresh the connector contract from a new chat/branch; an existing chat may retain its older tool list.

### `init_chat_session`

Creates one new persistent chat Session without opening or creating a Workspace.

Arguments: none. Returns `chat_session`; call once per chat and reuse a valid existing value instead of initializing again. Sessions expire after 30 days without activity. Initialization and its Tool Call history are associated with the new Session.

`document_grep` and `source_code_search` use the configured fallback source folder when no Workspace is selected. Workspace-dependent file operations, `workspace_dev_preferences_write`, new `exec`/`exec_start` or custom commands and JavaScript kernels require `open_workspace` first. Existing process follow-ups remain scoped to the same Session and work after Workspace removal. Desktop/CDP, discovery, diagnostics, memory, Telegram and `publish(text|base64)` require only the Session; `publish(path)` requires a Workspace.

### `list_workspaces`

Lists enabled Workspace names that may be passed to `open_workspace`.

Arguments: required `chat_session`. Returns `workspaces` plus the common `chat_session` envelope. Discovery does not select a Workspace.

### `open_workspace`

Attaches the existing chat Session to an enabled Workspace and returns the same capability. Workspace creation is deliberately folded into this tool rather than exposed as a second public creation tool.

Arguments:

- `name` — Workspace name.
- `create` — default `false`. Set `true` only when you explicitly want a missing Workspace created as a new empty directory on the current user's Desktop and registered under exactly this name. With `false`, a missing or disabled Workspace is an error. If the Workspace already exists, `create=true` simply opens it and does not replace it.
- `chat_session` — required existing active Session capability returned by `init_chat_session`. Workspace changes preserve it; this tool never creates a Session.

The creation path remains name-only: the agent does not supply the filesystem path; MrMCP resolves the Desktop and final directory internally and performs the same name/path/existing-target collision checks used by the GUI workflow.

Returns `workspace_name`, absolute `cwd`, `agent_guidance_path`, `workspace_created`, `memory_summary` and `chat_session`. `workspace_created` is true only when this exact call created the missing Workspace. `memory_summary.global`, `memory_summary.workspace` and `memory_summary.session` each contain the number of live memories plus up to five most recently set keys, giving the agent a small orientation hint without eagerly returning values. Guidance resolution checks only the Workspace root, preferring `AGENTS.md` / `agents.md` and then falling back to `CLAUDE.md` / `Claude.md` / `claude.md`. `DEV_PREF.md` is intentionally not guidance-discovered by `open_workspace`.

### `workspace_dev_preferences_write`

Opt-in materialization of the operator's development preferences into the current Workspace. Use this tool only when the user explicitly asks to save/copy/materialize their development preferences in that project. It must never be called proactively, during Workspace opening, for preference discovery, or to decide what instructions to follow.

The source is the physical `DEV_PREF.md` beside the running MrMCP executable; source mode uses the file beside `mrmcp.js`. The destination is exactly Workspace-root `DEV_PREF.md`. If the destination already exists, the tool returns `already_exists` immediately and does not read, compare, merge or overwrite either file. Otherwise it copies the source bytes exactly. The tool returns only `path`, `status`, `created` and the normal `chat_session`; it never returns preference content.

Calling this tool does not itself instruct the agent to read or apply `DEV_PREF.md`. Existing user/project guidance controls that separately.

Arguments: only `chat_session`.

---

## Filesystem discovery and reading

### `fs_glob`

Discovers files, directories and symlinks and also acts as the tree navigator.

Arguments:

- shared path selection: `path`, `include[]`, `exclude[]`, `gitignore`, `hidden`.
- `metadata` — default `false`. The normal page contains only `path` + `type`; set true only when size, modification/creation timestamps or stored symlink targets are needed.
- `limit` — maximum entries returned, default 1000, maximum 10000.
- `after_path` — stateless continuation path returned by the previous page as `next_after_path`. Only later entries in depth-first path-component order are returned: a directory and its descendants precede its next sibling. Sibling names use locale comparison with an exact string tie-breaker.
- `chat_session`.

Results are deterministically ordered and echo `metadata`, `returned` and the effective `limit`. Every entry always reports `path` and `type` (`file`, `directory` or `symlink`). With `metadata=true`, entries additionally report size and modification/creation timestamps, and symlinks report their stored `link_target` without dereferencing it. When `truncated=true`, pass `next_after_path` unchanged as the next `after_path` with the same selection arguments.

Traversal never applies magic dependency/build/cache exclusions. Include-based pruning requires proof that no descendant could match; ambiguous/global patterns fail open to ordinary traversal. Continuations also skip subtrees entirely before the cursor in path-component order. User exclusions belong in `.gitignore` or explicit `exclude[]`.

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
- `resume_after` — optional stateless continuation object:
  - `{path}` means continue after the whole file.
  - `{path, line}` means continue after that line within the file.
- `chat_session`.

Matched files include a whole-file `fingerprint`, size and text metadata. Match rows contain `line`, `column`, `text`, optional `context_before[]` and `context_after[]`. The page also reports `returned`, the effective `limit` and nullable `truncation_reason` (`limit` or `walk_limit`).

Every result echoes the effective `max_file_bytes` and includes `skipped_large_files`, the number of candidates omitted on this page because their observed source size exceeds that threshold. Files exactly at the threshold are searched. Filtered/ignored paths and unvisited candidates are not counted, and no extra traversal is performed to count future skips. The existing `scanned_files` counts candidates examined after path resolution, including oversized files and later read/decode failures; it is not a successful-decoding count. All counters are page-local, not whole-search totals. A continued file can be examined on several pages.

Per-file errors remain in `files[]`; oversized files are represented by the counter rather than additional rows. The text summary flags incomplete coverage when either occurs, even if `returned=0` and `truncated=false`. No continuation means the current traversal ended, not that every selected file was successfully searched.

When `truncated=true`, `next_resume_after` is directly reusable as the next `resume_after`. Search remains stateless; MrMCP does not retain hidden grep cursors.

Traversal is consumed progressively and stops when the result page is full, using at most one additional path to check for a continuation when there are no more matches in the current file. A continuation can still find no further matches: remaining paths may not match the search. This avoids enumerating the entire remaining tree merely to return an early page.

Rationale: repository-wide search belongs in one tool. Paging is governed by the explicit result-count limit and stateless cursor rather than an additional arbitrary response-byte target.

### `fs_read`

Reads one or many text files in one call.

Arguments:

- `files[]`, each containing:
  - `path` — required.
  - `start_line` / `end_line` — optional inclusive requested range.
  - `context_lines_before` / `context_lines_after` — optional surrounding lines.
  - `encoding` — per-file input encoding; default `auto`.
- `max_output_bytes_per_file` — per-file UTF-8 ceiling, default 1 MiB, maximum 5 MiB. A single complete line may exceed it so line content is never split.
- `chat_session`.

Successful per-file results include normalized `content`, actual returned range, `total_lines`, source size, fingerprint, text metadata, `truncated` and nullable `next_start_line`. An `end_line` beyond EOF is clamped to the last actual line; a `start_line` beyond EOF is out of bounds. A truncated requested range provides `next_start_line`; each requested file is bounded independently by `max_output_bytes_per_file`.

Under each file's budget, requested lines take priority over optional context: `fs_read` fills the requested range first and only then uses remaining space for `context_lines_before` / `context_lines_after`. Context omission alone does not create a continuation cursor, and every truncated requested range advances `next_start_line` beyond the requested start. A single indivisible line may exceed the per-file ceiling; this is intentional so text is never split and continuation always progresses.

Rationale: one multi-file read remains convenient for common batches while each file keeps an explicit independent text ceiling and continuation cursor; there is no hidden cross-file aggregate budget.

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
- `chat_session`.

Forward starts at `from_line + 1`; backward starts at `from_line - 1`. Therefore a returned match line can be sent back unchanged as the next `from_line` and navigation always progresses. Use `from_line: 0` to search forward beginning with line 1; to begin backward from the physical end, use a value greater than the file's `total_lines` (for example `total_lines + 1`).

Results include fingerprint, source size/line count, text metadata and structured matches.

Rationale: relative navigation is common after `fs_read`/`fs_grep` and is clearer as an explicit stateless primitive than by overloading grep pagination.

### `fs_stat`

Reads filesystem metadata for one or many paths.

Arguments:

- `paths[]` — one or more Workspace-relative paths.
- `fingerprint` — when true, also read and fingerprint regular-file content; default false.
- `chat_session`.

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
- `chat_session`.

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
- `chat_session`.

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
- `chat_session`.

At least one of `encoding`, `line_endings` or `bom` must request a real conversion rather than `preserve`; an all-preserve call is rejected so this tool cannot be abused as a read/detection API. Source encoding is detected with the same chardet-based path as the other filesystem text tools unless that file explicitly supplies `input_encoding`. Conversion is lossless: a wrong/ambiguous automatic detection fails rather than silently guessing, and if the requested target charset cannot represent the text that file fails rather than substituting characters.

Each result reports `path`, `status` and, when decoding succeeded, `before` / `after` objects containing detected/effective `encoding`, `line_endings` and physical `bom`. `converted` means bytes were rewritten; `unchanged` means the current bytes already represent the requested result and no write occurred. Optional fingerprints protect against concurrent changes, and MrMCP rechecks the source immediately before deciding unchanged or writing. Directories and symlinks are `not_file`; entries are independent.

---

## Filesystem structural mutation

### `fs_mkdir`

Creates one or many directories.

Arguments:

- `paths[]` — requested directory paths.
- `parents` — create missing parents recursively; default true.
- `chat_session`.

Existing directories are reported as `exists` and count as successful. Entries are independent.

### `fs_copy`

Copies one or many files, directories or symlinks recursively. Symlinks are recreated as symlinks with the same link target text rather than dereferenced into ordinary files/directories.

Arguments:

- `entries[]` — `{from, to}` pairs.
- `create_parents` — default true.
- `chat_session`.

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
- `chat_session`.

Nested selected targets collapse under their selected parent. Before payload moves, MrMCP records one SQLite transaction row plus per-item original path, type and cached byte size for non-directory payloads; directory size remains unknown rather than recursively pre-scanning the tree. Successful payloads are stored under one `trash_id`; failures do not roll successful entries back. A failed move with no retained payload removes that item metadata, while `failed_partial` keeps its row so the partial payload remains inspectable. If no tracked item remains, the result has `trash_id: null` and no empty transaction is kept.

Returns `trash_id`, the physical trash directory path, `succeeded`, `failed` and per-path statuses.

Rationale: removal is intentionally reversible; there is no permanent filesystem-delete tool.

### `fs_untrash`

Restores payloads still present under one trash transaction.

Arguments:

- `trash_id` — identifier returned by `fs_trash`.
- `chat_session`.

Each payload is restored independently. Occupied destinations, missing parents, wrong-Workspace paths and unavailable payloads are reported per entry. Successful restores remain restored and delete their item metadata; failed or physically missing tracked items remain visible for retry/cleanup. The trash transaction is deleted only when no tracked item metadata remains.

The desktop **Trash** section is an operator view over authoritative SQLite Trash metadata plus live payload presence, not over Tool Call history. Its sidebar badge counts tracked DB items without scanning the filesystem. Each item shows cached original path/type/size together with a live Present/Missing disk state; externally missing payloads remain visible in metadata until explicitly removed. Restore acts only on present payloads and never overwrites an occupied destination; permanent delete removes a present payload when available and always removes its DB metadata. Empty Trash clears both the global payload store and Trash metadata.

---

## Desktop automation

### `desktop_auto`

Runs one Automation Action Format (AAF) YAML scenario against the current desktop through `@mefistofelix/auto.js`.

Arguments:

- `yaml` — complete AAF YAML scenario. The top level is an ordered array and each item contains exactly one action. The authoritative specification and examples are at `https://github.com/mefistofelix/auto.js/blob/main/AAF_SPEC.md`.
- `chat_session`.

The returned `results` and `state` preserve Auto.js `run()` semantics. `results` is the ordered per-action result array; `state` is the arbitrary final structure built by the scenario and may freely mix OCR text, window/accessibility records, coordinates, arrays, objects, scalars and zero, one or many retained screenshots.

Retained final-state screenshots remain at the exact nested state locations chosen by the scenario. MrMCP removes only their binary `data`, keeps their AAF metadata (`format`, absolute desktop `rect`, `grayscale`, `scale`), and inserts `image_id`. A top-level `images[]` transport index maps each distinct image id to every referencing `$.state` path and to its MCP `content_index`. The same retained image referenced from several state paths is emitted only once.

The MCP result `content` is multimodal: index `0` is the JSON `TextContent` representation of the structured result, followed by one MCP `ImageContent` block per distinct retained image. Thus no-image scenarios return ordinary structured/text data, while scenarios with several images return all of them in the same tool result. The images are direct model input, not `publish`, Published storage, an MCP App or a `resource_link`. MCP encodes `ImageContent.data` as Base64 on the wire; Auto.js WebP plus `scale` is the intended size-control path. `rect` always remains the original absolute screen-space capture rectangle, so coordinates can be mapped back correctly after downscaling.

The desktop **Automation** page is a derived diagnostic view over `desktop_auto` Tool Calls recorded in **Payload** mode. Only Payload rows are replay sources: the page can filter by originating Session, show the exact YAML scenario, parsed scenario, returned state/results and retained input/output images, then replay the original scenario through the shared low-level Auto.js engine. Metadata rows remain visible in ordinary Tool Call history but are intentionally not replay sources. Replay itself stays a local action below the MCP dispatcher and creates no Tool Call, notification or replay-history row.

---

## Chrome DevTools Protocol

The CDP surface is deliberately small: `cdp_call`, `cdp_subs`, and `cdp_poll`. The unversioned npm import `@mefistofelix/cdp.js` supplies browser launch defaults, JSON-RPC transport, target/session setup and XPath helpers. MrMCP adds persistent identities/profiles, detached process lifetime, batch results, subscription rings, GUI Replay and screenshot conversion. Every operation uses the standard `{method,params}` shape. Standard CDP parameters pass through unchanged, including fields named `browser` or `target`; routing stays in the outer batch entry. The reserved `_.` namespace selects the library’s `_.click` and `_.find` helpers without adding MCP tools. References: [cdp.js](https://github.com/mefistofelix/cdp.js) and [CDP protocol](https://chromedevtools.github.io/devtools-protocol/).

### `cdp_call`

Sends one or more CDP operations. The input is **always** a `calls[]` array, including the one-call case. Each entry may select a persistent global browser/profile label, an optional logical page target and one operation; if `browser` is omitted, MrMCP uses the persistent profile label `main`. One Tool Call may span several targets and browsers. Local browsers default to `.mrmcp/cdp/<browser>/` with a stable unique loopback debugging port; MrMCP reconnects to a still-running browser when possible, and otherwise launches a compatible Chromium browser automatically. An explicit debugging port, HTTP(S) discovery URL or direct WebSocket endpoint connects to an existing browser without local executable discovery or launch. Browser state is global, not Session-owned, and a launched browser may outlive MrMCP.

Arguments:

- `calls[]` — required, 1–100 entries, returned in the same order.
  - `browser` — optional name string or advanced object; defaults to `"main"` when omitted. The object always requires `name` and accepts `headless`, `executable_path`, `user_data_dir`, `args`, `websocket_url`, `http_url`, `port`, `host` and `connect_timeout_ms`, as described below.
  - `target` — optional persistent logical page label string or advanced object with required `name`. If its saved page still exists, MrMCP resolves a current flattened `sessionId`; if it disappeared, MrMCP creates a new page (default `about:blank`, customizable through `create_params`), initializes its session and replaces the persisted `targetId`. `_.click` and `_.find` require a target; standard browser-level CDP methods may omit it.
  - `call` — one object with required `method` and optional `params`; no separate extension selector. Never supply transport `id` or `sessionId`.
    - Standard `method` names such as `Page.navigate`, `Runtime.evaluate`, `Network.getResponseBody` or `Page.captureScreenshot` pass through with `params` unchanged.
    - `method:"_.click"` accepts `params.xpath` plus optional `attempts` (default 5, max 20) and `interval_ms` (default 300); it performs the reference `Runtime.evaluate` retry/click flow with `awaitPromise`, `returnByValue`, `silent` and `userGesture`.
    - `method:"_.find"` accepts `params.xpath` plus optional `limit` (default 20, max 100) and returns compact matching node/element metadata including text and client rects. Both extensions preprocess augmented XPath: `ends-with(a,b)` becomes the XPath-1.0 `substring(...) = b` equivalent and `icontains(a,b)` becomes a case-insensitive `contains(translate(...),b)` expression. The reserved `_.` methods translate locally to `Runtime.evaluate`; unknown names in that namespace fail per entry.
  - `_image` — optional MrMCP response post-processing **only** for a standard `Page.captureScreenshot` call and only with `wait=true`. The standard screenshot request remains untouched, so every normal CDP screenshot parameter remains available. `return` is currently `base64`; `format:"original"` keeps the browser-returned encoding without loading an image codec, while `format:"webp"` lazily uses the public Auto.js `auto.vips.decodeImage` / `auto.vips.encodeImage` API. Its current WebP encoder is fixed at `quality:80`; `scale` multiplies dimensions before encoding. PNG/WebP browser screenshots can enter this post-processing path. The resulting Base64 stays in `cdp.result.data`; an `image` metadata object reports encoding, resulting format/MIME, byte size, scale and quality. MrMCP never imports Sharp directly and does not save CDP screenshots to disk unless a later explicit tool does so.
- `wait` — one batch-wide flag, default `true`. `true` dispatches every entry and waits independently for every response; one failed entry does not abort siblings. `false` dispatches all possible entries and returns assigned request ids immediately; retrieve eventual responses with `cdp_poll`. `_image` is intentionally unavailable with `wait=false` because post-processing happens on the waited response.
- `chat_session`.

The result is `{wait, results[]}` in input order. Each row reports browser/target/session diagnostics, assigned request `id`, `queued`, `cdp`, nullable `image`, setup errors, `success` and a compact row error. For local extensions, the ring/response envelope remembers the requested logical method name, `_.click` or `_.find`, even though the wire command is `Runtime.evaluate`.

Example entry: `{"target":"page","call":{"method":"_.click","params":{"xpath":"//button[@id='save']"}}}`.

Advanced browser options are shared by `cdp_call`, `cdp_subs` and `cdp_poll`:

- `name` — required safe 1–64 character logical label. `"main"` and `{"name":"main"}` select the same browser.
- `windowsHide` — boolean, defaults to the effective `headless` value; controls Node’s `windowsHide` spawn option on supported operating systems. It is independent of headless mode and only applies to local launches.
- `headless` — boolean; defaults to `false` for a new configuration. `true` launches Chrome with `--headless=new`.
- `executable_path` — path to a Chromium executable. Empty restores automatic discovery, including `MRMCP_CDP_BROWSER` and the library’s `CDP_BROWSER` fallback.
- `images` — boolean, default true. Set false to disable page image loading through cdp.js. Local launch only; screenshots remain available. Raw `args` can override the generated `blink-settings` switch.
- `user_data_dir` — profile directory. Empty restores `.mrmcp/cdp/<name>/`. Relative executable/profile paths resolve against the MrMCP application directory.
- `args` — up to 100 additional verbatim arguments. A matching `--switch` replaces the built-in value of that switch. An empty array clears extra arguments. The `headless`, `user-data-dir` and `remote-debugging-*` transport switches are managed by MrMCP and cannot be overridden through this array; the argv terminator `--` is also rejected.
- `websocket_url` — direct browser-level `ws://` or `wss://` endpoint, without URL credentials or a fragment. A nonempty endpoint cannot be combined with local launch options in the same object. Empty clears the endpoint and returns the name to managed local mode. Direct connections report `port:null` and `user_data_dir:null`, create no local profile directory and never fall back to launching Chrome when connection fails.

- `port` — integer 1–65535 for attachment to an already-running browser; no automatic launch. `null` returns to managed local mode. This mode reports the explicit port and `user_data_dir:null`.
- `host` — optional hostname, IPv4 or IPv6 address for port attachment, default `127.0.0.1`; no scheme, path or embedded port.
- `http_url` — HTTP(S) base URL or exact `/json/version` URL. Base paths are preserved when appending `/json/version`, as are query parameters. The discovery response supplies the browser WebSocket URL. Credentials/fragments are rejected; empty returns to local mode. This mode reports null port/profile.
- `request_timeout_ms` — 100–86400000, default 30000; bounds each individual CDP command and page setup step. Raise it for long `Runtime.evaluate` promises or XPath retries. Timeout does not cancel execution in Chrome; a late actual response can still appear in `cdp_poll` while the connection remains open.
- `connect_timeout_ms` — 100–60000, default 15000; bounds each discovery, WebSocket handshake/setup phase and local launch readiness.

Choose only one endpoint selector (`port`, `http_url`, `websocket_url`) per object. An explicit selector replaces any prior endpoint for that name. All attachment modes create no local profile/process, reject explicit local launch options and fail without local fallback.

Explicit fields update the name's configuration **only in memory for the current server run**; omitted fields retain their values. Subsequent calls may use just the name string. Reapply advanced options after restarting MrMCP: they are not persisted as browser configuration or restored from Tool Call history. Canonical request packets may still retain the supplied arguments for diagnostics and explicit Replay. Local launch options are used when a process must be started; reconnecting checks the profile and headless setting when Chromium exposes its command line. A connected or connecting name rejects different options, and a known local browser that is still running must be closed before changing its launch configuration. No option change automatically restarts a browser. Set the configuration on the first use of a name, or repeat the same object in concurrent calls.

Local example: `{"browser":{"name":"tests","headless":true,"executable_path":"C:/Program Files/Google/Chrome/Application/chrome.exe","user_data_dir":"profiles/tests","args":["--window-size=1280,800"]},"target":"page","call":{"method":"Page.navigate","params":{"url":"https://example.com"}}}`.

Direct example: `{"browser":{"name":"remote","websocket_url":"ws://127.0.0.1:9222/devtools/browser/<id>"},"call":{"method":"Browser.getVersion"}}`.

Port example: `{"browser":{"name":"existing","port":9222},"call":{"method":"Browser.getVersion"}}`. HTTP example: `{"browser":{"name":"remote","http_url":"http://localhost:9222"},"call":{"method":"Browser.getVersion"}}`.

Advanced target options apply only to `cdp_call.target`; subscription/poll target filters remain name strings:

- `name` — required logical page label, 1–128 characters.
- `create_params` — native [Target.createTarget parameters](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-createTarget), merged over `{url:"about:blank",background:true}`. For example `url`, `background`, `newWindow`, `width`, `height`, `browserContextId` or `hidden`. Chrome validates supported parameters/combinations; `forTab:true` is rejected because logical targets route to pages. Applied only when creating/recreating a page; existing pages are not navigated or resized. Supplying a new object replaces the saved create_params object.
- `initialize` — default true; false skips all optional setup below. The debugger pause is always released.
- `runtime` — default `"bootstrap"` enables Runtime during setup then disables reporting before resume; true leaves reporting enabled; false sends neither enable nor disable. JavaScript execution and explicit `Runtime.evaluate` remain available.
- `page`, `network`, `service_worker`, `focus_emulation`, `binding`, `background_service` — independent booleans, all default true, controlling Page.enable, Network.enable, ServiceWorker.enable, focus emulation, the _send_to_cdp binding and pushMessaging BackgroundService setup. `network:false` skips automatic Network reporting; it does not block network access.

Target options are remembered by `(browser,name)` only for this server run. Omitted fields retain values and strings reuse them. Configure them on first use; a live/opening page rejects changes, including conflicting concurrent entries. Close it first or use another name. Reconnection and recreation reuse the options; server restart discards them. Setup waits for a newly created target to be identified before enabling any optional domain, including when auto-attach arrives before the create response.

Example entry: `{"browser":{"name":"existing","port":9222},"target":{"name":"quiet","create_params":{"url":"https://example.com","background":true},"network":false,"runtime":false},"call":{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}}`.

The persistent database stores browser-to-reserved-local-port and `(browser,target)`-to-CDP-`targetId`; advanced options and `sessionId` remain runtime-only. External attachments do not use their reserved local port. Reconnecting to a still-running browser reconstructs sessions through CDP. A missing page/browser incarnation is repaired lazily the next time its logical target is used.

The desktop **Browser** page combines persistent browser/profile + logical-target state with current connection/ring/subscription diagnostics. Historical request/response inspection and Replay use only `cdp_call` Tool Calls recorded in **Payload** mode, because Metadata deliberately does not retain a replay source. A replay reruns only the selected recorded batch item through the shared low-level CDP engine; it does not enter the MCP dispatcher, create a Tool Call, write replay history or emit Tool Call notifications. The page adds no new CDP telemetry or replay persistence.

The library uses flattened auto-attach with `waitForDebuggerOnStart:false` and discovery. It initializes each logical page when resolved, using its selected options: Runtime/Page/Network, best-effort ServiceWorker, focus emulation, `_send_to_cdp` binding and pushMessaging BackgroundService. The default `runtime:"bootstrap"` enables Runtime during setup, then sends `Runtime.disable` before `Runtime.runIfWaitingForDebugger`. This leaves explicit `Runtime.evaluate` available. A binding installed in the current document emits `Runtime.bindingCalled`; navigation can replace that document, so use `runtime:true` when binding availability across navigation is needed. Protocol failures in optional setup steps appear in `setup_errors`; transport failures/timeouts fail the entry. Unrelated auto-attached pages are not initialized with MrMCP defaults.

### `cdp_subs`

Adds and/or removes global runtime subscriptions for one browser in a single call. Removals are applied before additions. Subscriptions are not Session-owned and are intentionally not persisted across MrMCP restarts.

Arguments:

- `browser` — required name string or advanced object with `name`, using the same configuration rules as `cdp_call`. Additions connect to the browser; a removal-only call does not launch or reconfigure it.
- `add` — either `"*"` for one catch-all subscription or an array of subscription specs. A spec may contain:
  - `targets[]` — logical target labels; `"*"` matches every target. Omit for all target-associated messages.
  - `methods[]` — exact methods; `"*"` matches all methods.
  - `method_prefixes[]` — prefixes such as `Network.`, `Page.` or `Runtime.`; `"*"` matches all methods. Exact and prefix filters are OR alternatives.
  - `include_browser` — include traffic with no target association. When omitted it defaults true only if no target list is supplied.
  - `regex` — optional JavaScript regex source tested against `JSON.stringify` of the **complete raw inbound CDP message**, so diagnostic subscriptions can match arbitrary payload text such as `pippo`, URLs, ids or nested values without knowing the method in advance.
  - `regex_flags` — optional `i`, `m`, `s`, `u` flags, each at most once.
- `remove` — either `"*"` to remove every live subscription for that browser or an array of opaque `cdpsub_...` ids.
- `chat_session`.

Target, method/prefix and regex dimensions combine with AND; alternatives within exact/prefix methods combine with OR. Internal `Target.*` state handling always runs regardless of public subscriptions. Notifications are put in the public ring only when some live subscription matches; responses are retained independently so `wait=false` remains recoverable.

### `cdp_poll`

Reads retained CDP traffic. With `subscription`, polling proceeds forward from that subscription's ascending cursor and `advance:true` (default) advances only that cursor. Without a subscription, `browser` is required and polling returns the latest matching retained messages from the tail in chronological order without consuming them. `browser` accepts the same name string or advanced object as `cdp_call`; when supplied alongside `subscription`, the name must match that subscription's browser.

Optional ad-hoc filters are `target`, `type=all|notification|response`, response `id`, exact `methods[]`, `method_prefixes[]`, and `limit` (1–200, default 50). Response envelopes remember the original/logical request method, so method/prefix filtering also works for standard and local extension responses, for example `methods:["_.click"]` or `method_prefixes:["_."]`.

Each browser has one shared ring rather than one copy per subscription. It is capped at 10,000 messages and 32 MiB serialized size; oversized or oldest entries are dropped as necessary. `dropped`, `oldest_seq`, `newest_seq`, and `stream_resets` make loss and reconnection explicit. A subscription itself stores only its filters and cursor.

---

## Memory

MrMCP exposes one small explicit persistent key-value memory surface: `memory_find` and `memory_set`. There is deliberately no separate `memory_get`; exact lookup is `memory_find` with `key`. Values are explicitly either validated JSON text or ordinary text and are stored in SQLite, not in hidden model state.

`memory_set` explicitly chooses one scope. `memory_find` can choose one scope, a unique array of scopes, or `"*"` for Global + current Session + all Workspaces:

- Global memory is shared across the whole MrMCP server.
- Session memory always means only the current `chat_session`'s Session.
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
- `chat_session`.

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
- `chat_session`.

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
- `chat_session`.

Every source becomes a normal physical file named with the random publication capability prefix plus a sanitized filename. Content is deduplicated with the same fast size/first/last/middle sampling fingerprint, and a reused resource may retain references from multiple Sessions and Workspaces without copying the payload. Publications survive source changes/deletion and server restarts until explicitly cleared.

The returned `uri` is the persistent HTTPS URL of the published content itself, not the MCP App resource. `source` reports whether this call supplied `path`, `text`, or `base64`; the widget combines that with filename, MIME type and size as compact metadata near the optional description. Displayable resources keep their filename in an inline `Content-Disposition`; executables and other opaque binary MIME types use attachment disposition. The smart widget uses MIME plus `presentation` to choose an image/iframe preview or a file action. Inline previews expose **Open original** below the metadata and open that persistent URL in a new window/tab; file-card presentation omits the redundant header link because its **Open File** action is already the primary content link. HTML is loaded in a nested sandboxed iframe without `allow-same-origin`; self-contained HTML/CSS/JavaScript is the portable default, while remote dependencies remain subject to host/browser CSP and CORS. The whole MCP request, including `text` or `base64`, is bounded by the server request-body limit.

---

## Tool-call inspection

Tool Call history has two independent operator settings and every row exposes the policy that actually applied:

- **Storage: Disk** — history lives in the main SQLite database and survives restart.
- **Storage: Memory** — history lives in SQLite TEMP tables/FTS on the active connection and disappears on restart. It has a separate retention in minutes.
- **Payload: Payload** — stores exactly the canonical MCP JSON-RPC request packet and canonical MCP JSON-RPC response packet once. Nested JSON/YAML/Base64/images are interpreted only while the fullscreen debugger renders the row.
- **Payload: Metadata** — stores neither MCP packet; identity, Session/Workspace snapshot, status/timing, progress flag and bounded errors remain.

Storage and payload are orthogonal: `Memory + Payload`, `Disk + Metadata`, etc. are all valid. The payload policy is diagnostic only and cannot remove state required by another feature. Persistent-process runtime/history is owned by the process subsystem in the main database and remains independent of Tool Call storage, retention and clear operations, so `exec_attach` / `exec_status` keep working. Browser ring, explicit Memory, Published, Trash and CDP state likewise keep their own authoritative storage. Fullscreen Tool Call details render only capabilities actually present on that row, and Browser/Automation replay is limited to Payload rows.

---

## Command discovery and diagnostics

### Platform-aware command catalog

The authoritative file is root `commands.yaml`. Each entry has `logical_name`, description, optional documentation_url and shared optional path/download_url/archive_path. `platforms` maps `windows-x86_64`, `linux-x86_64`, `darwin-x86_64`, `darwin-aarch64` (also aarch64 Windows/Linux) or OS-only keys to path/download_url/archive_path overrides. Exact OS/CPU wins over an OS-only fallback. Omitted fields inherit shared values; explicit empty download_url disables download. An empty/absent platform mapping uses shared values; a nonempty mapping with no matching key marks that command unsupported. Missing download URLs permit manually installed executables; no source build/package-manager install is inferred.

Discovery, logical exec resolution, GUI availability and Download/Download All use the selected current-platform variant. YAML order and every platform definition survive edits to another command. The command dialog exposes shared fields plus the complete platform YAML with inline validation. Download supports direct binaries, ZIP and TAR/TAR.GZ/TGZ; it installs only the selected regular-file payload below `.mrmcp/bin`, never an archive tree or TAR symlink. `archive_path` selects an exact archive member; otherwise an unambiguous executable basename is required. Unix installs are chmod 0755. Existing files require the existing overwrite confirmation. Unsupported platform variants are never downloaded or executed.

The default catalog includes native `yt-dlp` variants for Windows x64, Linux x64 and both macOS CPUs. `libgen-cli` is metadata for a manually supplied Go-built binary: upstream has no published releases. Its descriptor documents the upstream Go install command; MrMCP does not install Go or compile source automatically.

`camoufox` is a manual full-bundle entry: extract the upstream browser ZIP under `.mrmcp/bin/camoufox`, preserving its libraries/resources and macOS `Camoufox.app` structure. Its variants resolve `camoufox.exe` on Windows x64, `camoufox-bin` on Linux x64/arm64 and `Camoufox.app/Contents/MacOS/camoufox` on macOS x64/arm64. The release page is linked as documentation; no single-executable download is offered for this multi-file browser. Registration never downloads or launches it and does not alter the Chromium CDP integration.

### `discover_commands`

Returns the complete extra-command catalog intentionally made available to the agent.

Arguments:

- `chat_session`.

Results contain `logical_name`, description and optional documentation URL. A returned logical name can be passed directly as `exec.program`; MrMCP resolves catalog names before normal PATH lookup.

Rationale: user-provided command capability remains extensible without growing the built-in MCP surface.

### `tools_schema`

Returns the canonical complete descriptor for one or more exact currently published tool names, directly from the same `serverTools()` source used by MCP `tools/list`.

Arguments:

- `names[]` — 1–50 unique exact published tool names.
- `chat_session` — required active Session capability.

The result contains `tools[]` in requested order for names that exist and `missing[]` for names that are not currently published. Each returned item contains `name` plus `descriptor_json`, the exact canonical descriptor serialized losslessly as JSON, including `title`, full `description`, `inputSchema`, `outputSchema`, `annotations` and `_meta` when present. The string representation deliberately keeps the diagnostic tool's own output schema simple for connector compatibility. The tool is authenticated and read-only, requires `chat_session` and returns it in the common envelope; it does not require an open Workspace.

Publication-widget resource URIs are returned in canonical form. Normal `tools/list` intentionally adds a fresh `?instance=...` suffix to those View URIs for host cache busting; that suffix is the only intentionally dynamic descriptor difference and is not part of input/output schema semantics.

Rationale: connector/tool wrappers may present a synthesized or abbreviated schema view. This diagnostic path lets an agent inspect the authoritative server descriptor itself when exact schema, descriptions, output statuses, annotations or metadata matter, without duplicating descriptor definitions in a second implementation.

### `tools_log`

Queries Tool Calls that actually reached MrMCP for the current Session across both Disk and Memory history.

Arguments:

- `id` — optional exact stable Tool Call id; when supplied, at most one matching row is returned and `before_id` is ignored.
- `detail` — `summary|full`, default `summary`. Summary avoids packet bodies; Full returns the retained canonical MCP request and response packets.
- `limit` — 1–50, default 10. Exact-id lookup effectively returns at most one.
- `tool` — exact tool-name filter.
- `status` — exact `received|running|completed|failed|invalid|orphaned` filter.
- `query` — case-insensitive literal substring across fields actually retained in each row.
- `before_id` — stateless backward-pagination cursor when `id` is absent.
- `chat_session`.

Every returned row includes `storage` and `payload_mode` (`payload|metadata`). Summary rows include `payload_retained`, `request_bytes`, `response_bytes` and an optional bounded error preview. Full-detail Payload rows expose complete `mcp_request` and `mcp_response` packet objects with `payload_complete=true`; Metadata rows return no packet bodies. MrMCP does not persist separate argument/result/stdout/stderr/binary copies for Tool Call history. The result echoes `detail`, `returned`, effective `limit`, `truncated` and `next_before_id`; when truncated, pass `next_before_id` back as `before_id` with the same filters. The call excludes its own current row. Requests blocked before reaching MrMCP cannot appear here.

---

## Telegram Bot API

### `telegram_req`

Sends one generic Telegram Bot API JSON request. The local user configures only the Bot token on the dedicated **✈️ Telegram** sidebar page; the token is injected by MrMCP and is never an agent argument or returned value. The agent owns chat/channel ids and other application state, which can be kept in Memory when useful.

Arguments:

- `request` — one object containing required Bot API `method` plus that method's normal JSON parameters.
- `chat_session`.

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
- `env` — per-call string environment overrides. Before those overrides, every managed child receives the global Settings → Process Environment `NAME=value` entries. Their values may use `${MRMCP_DIR}` (MrMCP data directory), `${MRMCP_BIN}` (managed bin directory), `${WORKSPACE}` (current Workspace root) and `${CWD}` (effective exec directory); placeholders are expanded when the process starts so Workspace/CWD remain dynamic. Precedence is system environment → global configured environment → per-call `env`. The Process Environment Git line-ending option is enabled by default and appends runtime `core.autocrlf=false` to every managed child, so direct and nested Git invocations ignore machine/platform `core.autocrlf` conversion without changing the user's Git config. Disabling the option stops that injection. An existing CRLF checkout created with `core.autocrlf=true` can appear modified under the forced `false` policy even though no file bytes changed; disable the option to use the repository/machine policy for that checkout. This setting governs Git conversion, independently of `fs_write` / `fs_edit` representation handling. Repository `.gitattributes` remains authoritative, and explicit `git -c core.autocrlf=...` can override the runtime default.
- `stdin` — initial stdin data.
- `stdin_encoding` — `text|base64`; default `text`.
- `operation_id` — optional client-chosen opaque replay key (1–256 characters). Within the same `chat_session` and tool, identical process requests reuse the original process while it is active and for 5 minutes after completion. Reusing the key with different process arguments during that window is rejected. The key is deliberately temporary and may be reused after the grace period; it is not a Session-wide permanent identifier.
- `timeout_ms` — tool-specific timeout. Request-scoped `exec`/`exec_attach` default to 45 seconds but allow longer explicit waits. High values can cross client/proxy retry or replay windows; use `exec_start` for long or non-idempotent work. Persistent `exec_start` keeps its independent process timeout.
- `chat_session`.

`exec` also has `separate_streams`; `exec_start` deliberately does not because it returns before process output is consumed.

### `exec`

Runs a foreground process until exit or its requested timeout.

- `timeout_ms` default **45000**, maximum **3600000** (1 hour). Values above the default are deliberately allowed, but may cross retry/replay boundaries imposed by the MCP client, proxy or gateway. In ChatGPT testing a request replay was observed around 60 seconds; a repeated foreground call can duplicate a non-idempotent command. Prefer `exec_start` for long, expensive or non-idempotent work.
- `separate_streams` optionally adds stdout/stderr snapshots; combined observed-order output remains the default.

If `operation_id` is supplied, concurrent or replayed identical `exec` requests share one process and return the same retained result; the 5-minute completion grace also prevents a just-finished foreground command from being executed again by a delayed retry. If the MCP request uses a progress token and SSE, output can stream as progress while the final result still contains the complete transcript. When the HTTP runtime observes cancellation/disconnect it terminates the child; the selected `timeout_ms` remains the fallback for transports that cannot surface a disconnect before a response exists.

### `exec_start`

Starts a persistent interactive/background process and returns immediately.

- `timeout_ms` default 0 (no timeout), maximum 604800000.

Returns `exec_id`, which is always the stable integer Tool Call id of the originating `exec_start`, independent of Disk/Memory history storage or Payload/Metadata retention mode. With `operation_id`, identical retries in the same Session/tool return that same `exec_id` while active and during the 5-minute completion grace; after the grace the opaque key may be reused to create a new process. Pass `exec_id` unchanged with the same `chat_session` to the follow-up exec tools. Runtime process state and complete normalized transcript are owned by the process subsystem and remain available for the process lifetime/retention even when Tool Call payload mode is Metadata; process runtime state does not survive server restart.

### `exec_attach`

Consumes unread output from a persistent process and advances that process's attach cursor. The attachment itself is bounded even when the child is intentionally long-lived.

Arguments:

- `exec_id`.
- `timeout_ms` — attachment wait/stream timeout, default **45000**, maximum **3600000** (1 hour). This never terminates the persistent child. High values may cross client/proxy retry windows; an overlapping retry can encounter the intentional single-attach guard, so shorter repeated attaches or `exec_status` are preferable when transport behavior is uncertain.
- `separate_streams` — include complete stdout/stderr snapshots in the final result; default false.
- `chat_session`.

Only one attachment may be active for an `exec_id`. `remaining_bytes` tells the caller whether already-buffered output remains. `wait_timed_out=true` means only this attachment's wait expired while the process was still running; call `exec_attach` again or use `exec_status`. An observed client disconnect also detaches, but the bounded wait is the fallback on transports where disconnect is not observable until a response exists. A process-level timeout remains reported separately through `timed_out`/`status`.

### `exec_write`

Writes to persistent-process stdin.

Arguments:

- `exec_id`.
- `data` — default empty.
- `encoding` — `text|base64`; default `text`.
- `close` — close stdin after the optional write; default false.
- `chat_session`.

### `exec_kill`

Terminates a running persistent process.

Arguments:

- `exec_id`.
- `signal` — `SIGTERM|SIGKILL`; default `SIGTERM`.
- `chat_session`.

### `exec_list`

Lists only currently running persistent processes for the Session.

Arguments:

- `limit` — default 50, maximum 200.
- `chat_session`.

### `exec_status`

Reads persistent-process status without advancing the attach cursor.

Arguments:

- `exec_id`.
- `output` — `none|all|tail`; default `none`.
- `tail_lines` — default 200, maximum 10000.
- `separate_streams` — default false.
- `chat_session`.

---

## JavaScript kernel

### `js`

Runs JavaScript in a persistent lazy kernel scoped to the current Session and Workspace.

Arguments:

- `code` — required.
- `cwd` — Workspace-relative working directory; default `.`.
- `timeout_ms` — default 30000, maximum 120000.
- `chat_session`.

Use it for computation or programmatic parsing, not filesystem operations already covered by `fs_*` tools.

### `js_add_node_module_dir`

Adds a directory to the current persistent JavaScript kernel's module search directories.

Arguments:

- `path`.
- `chat_session`.

### `js_reset`

Destroys/reset the persistent JavaScript kernel for the current Session and Workspace.

Arguments:

- `chat_session`.

---

## Guided prompts are not tools

`guided_prompts.yaml` is exposed through MCP `prompts/list` / `prompts/get`, not `tools/list`. Guided prompts are user-controlled reusable workflows; they do not add model-controlled tool capability.
