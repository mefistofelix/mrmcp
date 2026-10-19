# MrMCP tools

This file documents the current built-in MCP tool surface, its arguments, semantics and design rationale. The published JSON Schemas in `mrmcp.js` are executable contracts; this file explains why the contracts have this shape.

## General conventions

### Session capability

Every tool except `init_chat_session` requires `chat_session`, the opaque `ctx_...` capability returned by `init_chat_session()`. Pass it unchanged, including to `list_workspaces`, `open_workspace`, `tools_schema` and configured custom tools. All tool results use the same `chat_session` envelope. Initialization creates a Session with no selected Workspace; `open_workspace` only attaches or moves an existing Session, preserving its identity. Missing/unknown/expired capabilities never create replacement Sessions implicitly; old `context_handle` and `current_context_handle` arguments are rejected.

### Filesystem paths

Filesystem paths are relative to the Session's current Workspace unless the specific tool says otherwise. MrMCP resolves and confines them to that Workspace.

### Result summaries and tool choice

`structuredContent` remains the complete structured result. Filesystem tools, `tools_log`, `memory_find`, Workspace discovery, command discovery and `tools_schema` also return a short text summary of counts, failures and applicable continuation fields. Summaries are derived only from current result metadata; they never duplicate file contents, match snippets, fingerprints, nested payloads or complete JSON. Batch mutation summaries report both succeeded and failed entries, including all-failed batches; the per-entry statuses remain authoritative and the existing call-level completion semantics are unchanged.

Choose `fs_glob` for paths, `fs_grep` for textual occurrences (including comments, strings and configuration), `fs_navigate` for next/previous matches in known files, and `fs_read` for known ranges. Batch independent reads. Request a few context lines when nearby source can avoid another read; the default remains zero. For additional caller/impact exploration, prefer a suitable available command from `discover_commands`, following its catalog description; the versioned catalog already includes Cymbal.

### `document_grep`

Requires `chat_session`. Uses its Workspace or Search `default_path` (empty means lazy OS Desktop/`_default`) without assigning a Workspace. The engine is [rag.js](https://github.com/mefistofelix/rag.js), using its public API and Turso storage.

| Argument | Behavior |
|---|---|
| `query` | Required nonempty text, up to 4,096 characters. |
| `mode` | `auto`, `fulltext`, `vector` or `hybrid`. MrMCP auto chooses hybrid when a model is configured, otherwise fulltext. |
| `path/include/exclude/gitignore/hidden` | Existing globstar selection, applicable parent/nested gitignore rules and negations. Gitignore defaults true; hidden false. Symlinks are skipped. |
| `mime[]` | Exact types or type/*, selecting by filename MIME; citations retain the extractor's content-aware MIME. |
| `limit` | Default 10, maximum 100 deduplicated passage hits. |
| `max_files/max_file_bytes` | Defaults 1,000 files/20 MiB; maxima 5,000/50 MiB. Selection observes at most 64 MiB and 100,000 traversal entries; extracted text is bounded to 8 MiB per file. |

MrMCP selects safe files first, then passes their exact paths to Rag.index with verify=hash. Unchanged extraction/chunks/vectors persist across calls and restarts. Only complete traversal reconciles missing/newly ignored paths; truncated traversal preserves unseen records. Failed, oversized, ignored and unvisited files cannot contribute hits or citations, including stored older revisions. Rag.search uses refresh=none after explicit indexing. Each instance closes in finally; no watcher or ingestion loop remains running between calls. The library's internal ingestion loop can recover known stale records while open; a public extraction callback rejects files outside the current eligible set.

Stores live under `.mrmcp/search/<real-path-hash>/rag/<profile-hash>/`, or `.mrmcp/search/_default/<hash>/rag/<profile-hash>/` without a Workspace. Every profile contains Rag's `turso.db`, `models/` and temporary/lock state. Lexical and embedding/OCR/provider/model/limit profiles are separate, so fulltext never generates embeddings or downloads an embedding model. Old LanceDB indices and previous embedding caches are preserved, without conversion; explicit searches build the new derived store. Operational cleanup preserves all search stores/models. A stale `writer.lock` after a crash requires establishing that no instance owns the store before manual recovery, as documented by rag.js; MrMCP never removes it automatically.

rag.js owns extraction (Xberg 1.3.10), Unicode-aware overlapping chunks (default 1,200 characters, overlap 150), chunk deduplication, native embeddings and retrieval. Turso performs fulltext term matching/ranking and exact cosine vector search; hybrid uses reciprocal-rank fusion, k=60. Models remain local and lazy: fast is English MiniLM, multilingual is E5 with query/passage prefixes. Weights persist inside the profile's `models/embeddings`, with no external service/API key. Ollama /api/embed and OpenAI-compatible /embeddings remain available through the public embedding callback. OCR defaults to the public Rag Paddle provider (PP-OCRv6 small, languages auto), using its existing Xberg dependency without another library or OS COM OCR calls. Models download on the first actual OCR operation and persist in the profile’s models/paddle folder. Auto has fixed language coverage, not unrestricted script autodetection. Explicit native OCR uses current Auto.js public vips/ocr; disabled OCR passes false. Neither mode silently falls back to Tesseract. Searchable PDF pages retain usable embedded text and page citations. Media transcription/video OCR remain disabled here; use catalog whisper-cli or yt-dlp explicitly.

The result retains source_directory/index_directory/workspace_selected, mode/gitignore, current eligible indexed_files, reindexed/unchanged/removed/scanned file counts, truncation/errors and results. engine is rag.js and storage is turso. Hits retain id/path/mime/chunk/text/score and add the library's complete current citations: document/occurrence IDs, relative/absolute file paths, UTF-8 byte offsets, page/time bounds, origin and locator/metadata. Identical text can have several citations. start_line/end_line are null because Rag exposes offsets/pages rather than extracted line numbers; indexed_chunks is null because scoped chunk counts are not in its public API. index_counts explicitly contains profile-wide Rag counts, including retained derived records, and must not be interpreted as scoped totals.

Settings → Search retains shared Save/drafts/inline validation and authoritative search.yaml: default_path, embedding (local|ollama|openai, model and optional endpoint/api_key), ocr (paddle|native|disabled). Existing YAML edits are preserved; Use local embeddings and Use PaddleOCR change the draft only. Opening/saving Settings downloads no models.


### `proxy_get`

Requires `chat_session`, with no selected Workspace. The configured global pool comes from **Settings → Proxies** / root `proxies.yaml`. The tool exposes three actions:

- `action=pick` (default): select distinct eligible entries, default `limit=1`, maximum 50. `mode=round_robin` selects the least recently selected eligible proxy globally, using health to resolve ties; selection advances a persistent monotonic cursor. `mode=random` samples without replacement, weighted by `(successes+1)/(successes+failures+2)/(consecutive_failures+1)`. Both skip active cooldowns.
- `action=list`: paginate configured/resolved order with `offset` (default 0, maximum 10,000), `limit` (default 20, maximum 50) and `next_offset`. Listing includes unavailable/cooled-down entries and never advances selection.
- `action=report`: require a previously picked `proxy_id` and boolean `success`. Success increments successes and clears consecutive failures/cooldown. Failure increments failures/consecutive failures and applies `failure_cooldown_seconds * 2^previous_consecutive_failures`, capped at 24 hours. Optional `retry_after_seconds` (0–86,400) overrides that delay. Report does not fetch list sources. Report arguments on other actions and nonzero pick offsets are rejected.

`include_direct` defaults true; false excludes the special `direct` entry representing a direct HTTP request. Explicit proxy entries accept HTTP(S), SOCKS5/SOCKS5H, bare host:port and optional URL credentials. Returned URLs include those credentials when configured. Proxy ids are SHA-256 of normalized entries; only ids, successes, failures, consecutive failures, selection/report timestamps and cooldowns are stored in the main Turso `proxy_stats` table. Statistics are shared across Sessions, survive restart and Clear Operational Data, and never appear in the YAML pool file. No automatic network probe or outcome inference runs: callers must report the actual request outcome.

`proxies.yaml` contains `proxies[]`, newline-list `proxy_lists[]`, `list_ttl_minutes` (default 60), `request_timeout_seconds` (15), `max_entries` (200) and `failure_cooldown_seconds` (30). It seeds direct access and two public list URLs. At most 20 sources and 2,000 configured entries/source URLs are allowed. Sources are fetched only during explicit pick/list calls, with a shared per-source fetch across concurrent callers, a 1 MiB response cap and memory TTL. Invalid/comment lines are skipped, normalized duplicates removed, configured order preserved and the final pool bounded. Source failures are reported without discarding other usable entries. Saving configuration clears source caches; no background fetch/probe runs.

Output contains action/mode, total configured/resolved count, offset, returned count, next_offset, next_retry_at, proxies and source errors. Each proxy has proxy_id, proxy, available and stats. Report returns proxy=null because it updates by id without fetching the pool. If every entry is cooling down, pick returns an empty array plus the earliest next_retry_at; it does not wait. Pool membership/page offsets may change when remote lists refresh.

Examples:

`{"chat_session":"ctx_...","mode":"random","include_direct":false}`

`{"chat_session":"ctx_...","action":"report","proxy_id":"<returned id>","success":false,"retry_after_seconds":120}`

### `chat_set_goal`

Set a user-requested, repeating follow-up message for a ChatGPT conversation. MrMCP sends the saved text after an interval without Tool Call activity or observed response progress, with no Tool Call still running in that conversation. It observes turn activity/completion, but does not interpret whether the textual goal has been achieved or stop because ChatGPT says the work is finished. Repetition ends through explicit cancellation, global suspension, Session expiry/deletion or an uncertain delivery. No selected Workspace is required.

#### Arguments and result

| Argument | Contract |
| --- | --- |
| `chat_session` | Required active capability from `init_chat_session`; identifies the MrMCP Session, not the ChatGPT conversation id. |
| `goal` | Required string, at most 32,000 JavaScript string code units. Nonblank text is kept exactly, including whitespace; empty/whitespace-only becomes an empty goal and stops follow-ups. |
| `chatgpt_chat_id` | Optional conversation ID from the ChatGPT `/c/<id>` URL, 8–80 ASCII letters/digits/hyphens. Explicitly replaces the association and bypasses matching; omission retains the current ID. It is unrelated to the Chrome extension/tab ID. Empty strings and full URLs are rejected. |
| `timeout_seconds` | Optional integer, 30–86,400. Omission uses the current global default, initially 300. Each call selects its interval anew: omitting it when updating a goal uses the current default, not that goal's previous override. |

Example tool arguments, using an already-created Session:

```json
{"chat_session":"ctx_...","goal":"Continue the work, verify the result and report any blocker.","timeout_seconds":300}
```

To stop:

```json
{"chat_session":"ctx_...","goal":""}
```

Returns the common `chat_session` envelope plus `goal`, `timeout_seconds`, `status`,
`chatgpt_chat_id`, `chat_url`, `next_check_at`, `last_sent_at`, `detail`, `browser`,
`transport` (always `reverse`), nullable `extension_id` and logical `target` (`goals`).
Missing association/timestamps/detail are null; timestamps are Unix milliseconds. next_check_at is a
scheduler check time, not a promised delivery time. last_sent_at remains available after clearing a goal.

An unassociated Session without an explicit chatgpt_chat_id becomes pending,
scheduled no earlier than one second later on the five-second scheduler. The call returns before
discovery. Persist matching and next-check zero before connecting, consuming that one attempt.
An unsuccessful, interrupted or failed scan remains unscheduled; repeat chat_set_goal to retry.
Activity and ordinary settings saves do not rearm it. Existing associations are reused and schedule
their full interval. Replacing/clearing a goal increments its revision and preserves its association.
Restart matching defaults off, including never-started pending work; the startup option below is the
only automatic exception. Supplying chatgpt_chat_id skips the scan, sets ready and schedules a full
idle interval without connecting now. The latest explicit set wins across Sessions linked to that
conversation. Clearing the goal retains its ID, including one supplied in the same call.

#### Global settings and browser lifetime

Goals use the user's system Chrome through public CDP.js 0.5.0 URL bootstrap and reverse transport.
The operator installs CDP Ext and signs in normally. MrMCP sets cdp_ext=true, cdp_ext_install=false,
user_data_dir=null and update_preferences=false; login/translations remain enabled. CDP.js opens its
loopback bootstrap URL through Chrome, reusing the running system profile or opening Chrome if
closed. It installs no extension, creates no profile and changes no profile preferences.

One-time setup:

1. In Settings → Goals, choose the CDP Ext export folder and click **Save CDP Ext folder**. The default
   is APP_DIR/cdp_ext, beside the editable catalogs; macOS uses the application-support directory.
   Export uses the exact manifest.json and cdp_ext.js from the bundled public package, including offline.
2. In chrome://extensions in the intended system profile, enable **Developer mode**, click **Load
   unpacked** and select that exact folder. See also the [upstream instructions](https://github.com/mefistofelix/cdp.js#reverse-chrome-extension-transport).
3. Keep the export path stable. After upgrading MrMCP, save to the same folder, confirm replacement
   of the packaged files and press **Reload** on the extension card in Chrome. Existing unrelated files
   are preserved; unrelated nonempty folders, symlink destinations or nonregular extension files are
   refused. Export alone opens no browser or connection and never installs/enables an extension.
   No extension ID or WebSocket address is entered in MrMCP.
4. Sign in to ChatGPT in the system profile. Set a goal to request matching, or supply chatgpt_chat_id.

CDP.js lazily starts its shared loopback listener (default port 9223), then opens a real local HTTP
/cdp_ext URL with browser=mrmcp-goals, the effective WebSocket endpoint and a generated binding token.
The installed extension intercepts the tab URL and announces its logical browser name, native ID and
token. CDP.js validates the token and extension origin; MrMCP does no socket scanning or guessed-profile
selection. One extension copy/native ID can serve distinct profiles with distinct logical names.
A profile already connected to another name/manager fails explicitly rather than changing its binding.
Disconnect it from that manager before retrying. Bootstrap and owned page tabs remain open on Quit.
Chrome's singleton routing and any user-selected raw launch flags determine instance reuse. The external
opener skips the automation launch preset; its process is not owned Chrome and is never terminated by
MrMCP. Reconnects are handled by the library without replaying interrupted commands or duplicating pages.

There is no Login ChatGPT button, extension-ID setting or login-verification timestamp. Settings
and debug report the current connection; automatic configuration is not proof of site authentication.
An observed login screen/unauthorized current query suspends that goal as waiting_login. Sign in in
the normal browser and explicitly retry chat_set_goal or a debug action. No network monitoring is used.

| Control | Config key | Default | Effect |
| --- | --- | --- | --- |
| Enable chat goal management | chat_goals_enabled | On (1) | Starts/stops goal work. |
| Retry missing chat matches at startup | chat_goal_match_on_startup | Off (0) | One startup attempt per eligible unassociated goal; requires enabled goals and an installed extension. |
| Default inactivity timeout | chat_goal_timeout_minutes | 5 | Whole minutes 1–1440; subsequent sets only. |
| Stop the current response before sending | chat_goal_stop_before_send | Off (0) | Click Stop and verify its effect before sending. |

These settings use the existing config table, schema 6. Headless, process visibility and image-loading
launch settings no longer apply to Goals; Chrome is controlled by its user. The former dedicated
profile is unused and remains untouched. Saved goals and conversation associations are preserved.

The browser label is mrmcp-goals and its shared logical target is goals, in the native purple
**MrMCP Goals** tab group, using CDP.js target.group. Attach/create the target only for an explicit
matching attempt, a due delivery or a user-requested debug action. Startup without due work, Settings
opening/saving and status diagnostics create no tab or browser connection. The opt-in startup matching
policy and delivery retries still count as requested goal work. Reuse a surviving target by logical
name; recreate a closed target only when the next action needs it. Do not adopt unrelated ChatGPT tabs
or groups with the same visible title. A namespaced chrome.storage.session marker confirms the owned
tab across MrMCP/extension-worker reconnects; a Chrome restart clears it so recycled numeric tab IDs
cannot select a personal tab. Only the logical tab ID is stored there, never chat content or tokens.

Goals/Subagents share the logical browser mrmcp-goals; explicit browser tools can reuse that name
to operate on the same profile. Another logical name cannot take over an already-connected profile. Native extension IDs
are observed connection metadata, not a user configuration field. Bootstrap routing uses the logical
name and token, so shared native IDs do not identify a unique Chrome profile.

Disabling clears the interval/turn observer and disconnects the Goals inspector. It leaves Chrome,
tabs, saved goals and associations intact; the shared reverse listener can remain for other browser
users. The tool remains published and a nonblank set returns disabled without changing saved state.
An empty set can clear it. Re-enabling resumes eligible deliveries without resetting elapsed time;
consumed missing matches and uncertain delivery stay suspended. Already-dispatched actions cannot
be recalled. Closing MrMCP disconnects its bridge and leaves the user's browser/tabs open.

With startup matching off, restart never rearms failed/interrupted/pending matching requests.
When on, backend startup queues one attempt for each nonexpired unassociated nonempty goal, excluding
disabled/expired/sending/delivery_uncertain states. Preserve text, interval and explicit-set priority.
An unsuccessful startup scan stays unscheduled until another set or a later opted-in startup.

#### How the ChatGPT conversation is found

1. Open/reuse the owned Goals page with initialize:false. Use Runtime.evaluate in the page's main JavaScript world without enabling Runtime reporting or installing the general page binding. Normal goal matching/sending neither captures history responses nor subscribes to WebSocket pushes. There is no Network observer for Goals, including login.
2. Preserve drafts, login flows and dialogs. Otherwise open the home page and read the rendered recent navigation links in the site's order, considering at most 20 conversations. This does not exhaustively search the account or archive.
3. For each candidate, resolve DOM Fiber pointers through React's committed root.current path, including alternate pointers. Find the mounted query client through provider props and read only the exact chatgpt-conversation query whose id agrees with the route and any mounted conversation identities. Cached data works even when navigation makes no HTTP request. Do not enumerate arbitrary application stores or read authentication/session queries.
4. A newer published renderedConversation snapshot can supersede history only when its renderedTurns reference the exact mounted turn and its user message proves ownership. Read named hook/memo-cache values; invoke no state-changing React callbacks. Ambiguous identities or multiple competing models cannot establish a match. Project/GPT conversation routes retain the same canonical conversation id.
5. Follow the complete current_node → parent branch, rejecting cycles, missing ancestors and conflicting ids. Parse complete JSON only in assistant api_tool.call_tool messages, require a MrMCP tool name and compare args.chat_session exactly. Never match ordinary prose, nested example strings or inactive branches. Only the match boolean, bounded message ids and turn metadata leave the page; tool arguments and history bodies stay there.
6. An inspected complete branch without a match advances to the next candidate. Missing/unsupported/truncated models can fall back to rendered, structurally identified tool JSON/disclosures; contradictory identity evidence cannot. A truncated request never proves absence, and a complete later matching request can still succeed. No private REST request is issued or replayed.
7. Persist the verified association, recheck revision/activity and continue scheduling on the same tab. Existing one-attempt-per-explicit-set and optional-startup rules remain unchanged. Later delivery reuses the saved conversation id without rediscovery.

The minimal read-only technique is adapted from [Chat On Steroids fiber.js](https://github.com/totec448-spec/chat-on-steroids/blob/5456eb390bb9c4d54b7a3d076a5201ec5677f5e2/extension/fiber.js), under MIT with notice in the root LICENSE. These are website internals, not a public ChatGPT API: unknown shapes remain explicit diagnostics/fallbacks.

Only one nonempty goal may be associated with a given ChatGPT conversation. The most recent explicit set wins; association discovery also checks for a newer already-associated goal before replacing anything. Equal set times are resolved by the newer numeric Session id. Older replaced goals are cleared, with an explanatory detail.

#### Timer, activity and scheduling

The earliest delivery deadline is recomputed as:

```text
max(last_active_at, goal_activity_at, goal_updated_at, goal_last_sent_at)
  + goal_timeout_seconds × 1000
```

Authenticated tools/call arrivals with a valid capability count before lookup/schema validation; completion counts again for success, rejection or failure. In-flight runtime controls for every Session currently linked to the conversation veto Stop, insertion and dispatch. The entire duration of a long call is excluded: after the last call completes, a full timeout starts. Unrelated conversations remain independent. A detached process remaining alive after exec_start returns is not an in-flight Tool Call.

The shared page's React model supplies a bounded progress fingerprint from active-turn message ids, status/completion markers, content sizes and bounded tail hashes. Raw text/arguments never leave the page. Changed fingerprints update the persistent goal_activity_at; unchanged busy/streaming markers do not repeatedly reset it. A successful assistant final with end_turn:true proves completion; a finished tool/interim message alone does not. A mounted typed final additionally requires completed:true, phase:final_answer and turn.status:complete. Newer unfinished public answers supersede older finals, while trailing analysis scratch does not hide a completed final. Goal completion itself is never inferred.

The first observed running snapshot has no proven last-change time, so it establishes one conservative baseline interval. Subsequent identical observations do not extend it. The same non-overlapping five-second scheduler observes the already-open shared tab without navigating solely for observation. Other conversations are inspected when visited for matching/delivery; this is observed inactivity, not a claim to continuously monitor every account chat. Restart retains persisted activity/deadlines but starts a new in-memory fingerprint baseline. A completed turn still requires an idle interval before another goal; an unchanged unfinished turn can eventually receive the goal, optionally after Stop.

Due goals remain sequential on the shared tab while ordinary MCP calls remain concurrent. New activity, maintenance, drafts, dialogs, lost login or changed revision defer/cancel delivery. Recheck after the sending-state database commit as well as immediately before browser side effects; a call arriving during preparation prevents dispatch and clears only the exact draft inserted by that attempt. After submission confirmation, continue to another goal without waiting for its assistant response.

For a 300-second goal, a tool starting at 10:00 and completing at 10:20 cannot receive a timer-driven goal during the call. The earliest deadline is 10:25, and newly observed response progress postpones it again. A stalled response with no in-flight Tool Calls and no new observed progress can receive the prompt after the interval. Browser waits, discovery and earlier goals can delay delivery beyond that deadline.

#### Exact send sequence and cancellation

1. Check the current shared page for a draft, dialog or login flow before changing it. An existing draft still prevents navigation to protect its contents; an assistant response in another conversation does not.
2. Navigate to the associated conversation, or reuse it if already loaded. A response in progress is allowed. If Stop-before-send is enabled, recheck the goal revision, inactivity deadline and maintenance state, then click the unique enabled machine-marked Stop control (`stop-button` or `composer-stop-button`) only when response markers are present. Poll at 100 ms intervals for up to five seconds (plus CDP latency) until those markers clear and the composer is ready. Recheck cancellation/activity throughout; missing, ambiguous or disabled Stop, a changed conversation, or failure to become ready produces an error instead of pretending that interruption succeeded. If no response is active, this is a no-op. Then require a usable composer, the exact conversation path, an empty draft and an identifiable existing user message, and focus the editor.
3. Re-read the goal revision/activity, check maintenance, and confirm the deadline is still due. Related Tool Call arrivals/completions are already reflected in that deadline.
4. Insert the exact saved text with CDP `Input.insertText`, then repeat the revision/activity/maintenance checks.
5. Persist `sending` before dispatch. Re-resolve the page and require the exact URL, unchanged inserted text and a structurally valid composer. Activate the unique available submit control with DOM `.click()`. While a response is active and no submit control exists, use the native `HTMLFormElement.requestSubmit()` path only for a single-editor form; Stop controls are excluded from submit selection. This lets the website accept/queue the prompt according to its own behavior. Never click Stop implicitly when the option is off. When it is on, renewed response activity blocks dispatch because the requested interruption no longer holds. No clipboard operation or simulated Enter is used.
6. Check up to 40 times, sleeping 250 ms between checks, for an empty composer and a new user message whose id was absent before sending and whose text exactly equals the goal. Use either rendered message markers or the exact mounted React model receipt; no unrelated user text is exported by the model reader. CDP execution time adds to this roughly ten-second observation window. Confirmation saves `goal_last_sent_at`, returns to `ready` and starts another full interval; the scheduler immediately continues to the next goal even if ChatGPT has started responding to the message.

Attempting submission during a response does not guarantee that a particular ChatGPT UI version accepts or immediately renders it; disabled/ambiguous controls remain errors, and a dispatched form submission that produces no observable acknowledgement follows the same uncertain-delivery rule. Confirmation is an observation of ChatGPT's rendered UI, not an independent server delivery receipt. If dispatch may have happened but confirmation is missing, the state becomes `delivery_uncertain` and there is no automatic retry. Restart converts a saved `sending` state to `delivery_uncertain`. Inspect the conversation and explicitly set the goal again to rearm it.

Replacing/clearing a goal, disabling management, Session deletion/expiry and new activity are checked before submission. If insertion occurred but dispatch did not, cleanup attempts to remove only the exact inserted text from the same conversation, while management is still enabled and the server is not stopping. A changed draft is preserved. A message already dispatched cannot be cancelled; a draft may remain if shutdown/disable interrupts cleanup.

#### States and operator actions

| Status | Meaning / next action |
| --- | --- |
| `disabled` | Goal cleared, or global management off. Global off masks the stored status; it does not erase the goal. |
| `pending` | An explicit set or opted-in startup has queued one matching attempt which has not started yet. |
| `matching` | That attempt is in progress; it has already been consumed persistently, so a crash cannot repeat it. |
| `ready` | Associated and scheduled. Login/composer checks still happen at delivery time. |
| `waiting_login` | The site requires sign-in. Sign in normally in system Chrome and retry chat_set_goal or a debug action. This goal remains suspended until that explicit retry. |
| `waiting_browser` | CDP Ext ID is not configured. Install the extension, save its ID in Settings → Goals and repeat the set. |
| `not_found` | No exact Session match in the bounded recent candidates. Ensure the correct account/chat and a visible MrMCP tool call, then call `chat_set_goal` again. No automatic discovery retry. |
| `busy` | An associated chat still has in-flight Tool Calls; the scheduler waits for completion and a fresh full timeout. For an unassociated chat it can also mean discovery was interrupted or exhausted its budget; call `chat_set_goal` again to request another match. |
| `draft_present` | The shared page contains text that MrMCP will not overwrite. Send or remove that draft manually. An unassociated goal needs another `chat_set_goal` call to retry matching. |
| `error` | Browser, navigation, unsupported page structure or pre-dispatch failure. Read the bounded detail in Sessions. Before association, another explicit set is required; after association, normal delivery retry applies. Internal DOM `not_ready` is projected as `error`. |
| `sending` | Dispatch has been prepared and acknowledgement is being observed. |
| `delivery_uncertain` | Dispatch outcome could not be confirmed, or restart interrupted sending. Automatic sends are suspended; inspect and explicitly rearm. |
| `expired` | Session exceeded its 30-day inactivity lifetime. Automatic goal messages do not extend that lifetime. Use an active Session. |

For already-associated goals, normal stored delivery deferrals/errors schedule another check 60 seconds later, subject to the global enable switch and extension configuration. Unassociated matching attempts never use that automatic retry; their result has `next_check_at:null` and a detail asking for another `chat_set_goal` call. An opted-in future startup can also queue one new attempt. A scheduler pass skipped solely because of maintenance or an existing scheduler task uses the next available tick instead. **Sessions** shows the goal preview, interval, status/detail, conversation id, next check and last confirmed send. **Stop goal** clears it immediately. **Goal settings** opens the Goals tab and its CDP Ext setup instructions. Opening Settings does not connect, retry a match or send a message.

#### Persistence, bounds and interface compatibility

Persistent Session fields are `chatgpt_chat_id`, `goal_text`, `goal_timeout_seconds`, `goal_revision`, `goal_updated_at`, `goal_activity_at`, `goal_status`, `goal_next_check_at`, `goal_last_sent_at` and `goal_error` (bounded to 500 characters), alongside ordinary Session activity. They survive restart and **Clear Operational Data**, independently of Tool Call Disk/Memory and Payload/Metadata policies. Clearing/deleting Sessions removes their goals. Closing/stopping MrMCP stops monitoring; the user's Chrome and tabs remain open. Restart resumes eligible overdue deliveries only with global management enabled and CDP Ext configured. Missing matching requests, including never-started ones, remain stopped unless the startup matching option is also enabled. In that case it queues one attempt per eligible goal, without resetting the delivery interval or explicit-set timestamp. Matching uses the existing status/next-check/revision fields; no new schema column is needed.

React inspection retains no Fiber, query client or history across observations. Bounds are 32 DOM anchors, root depth 2048, 8192 child-list steps per path, 4096 queries per client, 4096 live hook/memo inspection steps and 20,000 active-branch nodes. Request JSON is limited to 1 MiB per request / 8 MiB aggregate. The backend keeps at most 100 conversation fingerprints with state/observed-change time, never text or argument payloads. No history body is persisted or returned by goal tools.

RPC waits are bounded at 15 seconds and target acquisition at 20 seconds. Navigation checks run for up to 15 seconds; each candidate waits at most 3 seconds for a mounted model. Discovery retains its 90-second soft budget checked between operations. A timed-out optional observation cannot prevent the scheduler from processing all other due goals. The first running observation is intentionally conservative because the page cannot prove how long an unobserved chat was already stalled.

DOM identification uses machine attributes and native HTML/ARIA structure: unique editors, form-owned submit controls (including external `form=` controls), canonical conversation links, `aria-controls`/`aria-expanded` and `details`/`summary`. It never selects controls by translated labels, accessible-name wording, generated CSS classes or icon shapes. Login and ongoing-response recognition also use structural/machine markers. It refuses ambiguous editors/submits, dialogs, unavailable controls or missing message identity. This tolerates locale changes and some layout changes, but endpoint/payload contracts, machine attributes and form structure can change; the adapter reports failure/deferral instead of guaranteeing compatibility with every future website version.

Implementation entry points in `mrmcp.js`: `setChatGoal` / `chatGoalView` (contract), `recoverChatGoals` / `chatGoalConfigure` / `chatGoalTick` / `chatGoalRun` (recovery and scheduling), `noteChatGoalActivity` / `chatGoalDue` / `chatGoalActiveCalls` / `chatGoalObserveTurn` (activity), `chatGoalPage` / `chatGoalReact` / `chatGoalReadReact` / `chatGoalFindChat` / `chatGoalBind` (browser and association), and `chatGoalDom` / `chatGoalSend` (submission).

### `chat_goal_debug`

User-requested diagnostics and manual actions for the current `chat_session`; no Workspace is required. The tool remains published when Goals is disabled.

| Argument | Meaning |
| --- | --- |
| `chat_session` | Required active MrMCP Session capability. |
| `action` | `status` (default), `match`, or `send`. |
| `stop_before_send` | Optional boolean for `send` only, overriding the global Stop option for this attempt without changing Settings. |

`status` reads saved association, goal, deadline, extension configuration/connection and enablement without connecting to Chrome. `match` immediately performs one normal exact-Session matching scan, including rechecking a stored association; it sends no prompt and retains the old id if rechecking fails. A successful match uses the normal newest-goal ownership rule. `send` submits the saved nonempty goal to the already-associated chat immediately, bypassing the inactivity deadline. It uses the same shared tab/pass lock and the same Stop, draft, maintenance, revision, activity and acknowledgement checks as timed delivery. New Tool Call activity during the attempt still cancels pre-dispatch work. Confirmation resets the ordinary inactivity interval. Global disable, a missing goal/association or a previous `sending`/`delivery_uncertain` state defers the action; inspect and rearm uncertain delivery through `chat_set_goal` first. These calls themselves count as normal MrMCP activity.

For status inspection, operation_detail also reports linked in-flight Tool Calls or the last observed turn state and seconds since observed progress. Manual send excludes only its own diagnostic Tool Call from the in-flight guard.

The result contains the usual goal fields plus `action`, `operation_status` (`inspected|deferred|matched|not_found|sent|failed`), `operation_detail`, `enabled`, `browser_configured`, `browser_connected`, `chat_session_matched`, `scheduler_busy` and `due_at` (Unix milliseconds or null). `chat_session_matched` reports whether an association is stored; only `operation_status:matched` confirms this scan, and only `operation_status:sent` confirms this submission. No arbitrary prompt or conversation-id override is accepted by debug; set chatgpt_chat_id through chat_set_goal. browser_configured is true for automatic reverse discovery, independently of browser_connected and site login.

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

 Workspace-dependent file operations, `workspace_dev_preferences_write`, new `exec`/`exec_start` or custom commands and JavaScript kernels require `open_workspace` first. Existing process follow-ups remain scoped to the same Session and work after Workspace removal. Desktop/CDP, discovery, diagnostics, memory, Telegram, OpenRouter and `publish(text|base64)` require only the Session; `publish(path)` requires a Workspace.

### `subagents`

Persistent ChatGPT workers inspired by [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids).
One authenticated tool with the ordinary required chat_session capability; no Workspace is required.
This is an application feature using the operator's ChatGPT account and CDP Ext, not a model API or
an additional OS process. No extra quota, model access, worktree, software installation or filesystem
isolation is created. Workers share the parent's selected Workspace and must coordinate edits.

Setup uses **Settings → Goals**, shared with Goals: install CDP Ext in system Chrome and sign in normally.
CDP.js 0.5.0 opens or reuses the system browser through URL bootstrap; no extension ID is entered.
Also save the MrMCP ChatGPT app ID (asdk_app_…)
from that installed app's Settings → Apps page URL, and its exact display name (default MrMCP).
Workers attach that app using the native editor app-mention token, adapted minimally from the MIT
Chat On Steroids chatgpt-dom.js implementation. If the token is unavailable, removed or changes the
authored task, refuse Send and report the error. The configured app must already be connected and
authorized in ChatGPT; this does not install/authorize an app or answer approval dialogs.

The Goals enable flag controls Goals alone. Subagents operate independently through the same browser
label mrmcp-goals, using targets subagent-<opaque agent id> in the native cyan **MrMCP Subagents** group.
Goals keep their purple group. Each target has its own namespaced extension session-storage tab-ID
marker, preventing adoption of recycled personal tab IDs. Browser bootstrap may open Chrome; no
managed profile is created or edited.
Tabs are acquired for requested work/resume; passive inspection does not connect or create targets.

| Action | Inputs and behavior |
| --- | --- |
| spawn | workers[1–8] with task (1–8000 chars), optional label (80) and explicit requested model route id; optional shared context (8000). Atomically reserve up to eight active workers per parent Session, then open independent fresh chats asynchronously. Return a queued snapshot without waiting for worker completion. No parent conversation history is implicitly copied. |
| join | Worker first calls init_chat_session, then joins with agent_id and the one-use claim_token from its private bootstrap. Parent and child use distinct persistent Session capabilities. The claim is not in public worker metadata. Join inherits the selected Workspace; the worker may open_workspace with its returned name to read cwd/guidance. Nested worker spawning is rejected. |
| message | Parent supplies agent_id and text (16000 chars); queue it durably for that worker. A completed worker is reused with its chat/context. Running turns and in-flight worker Tool Calls finish before queued text is sent. A joined worker omits agent_id (or selects itself) to report text to its parent through the broker. Reports are collected by tools, never automatically pasted into a parent chat. |
| status | Read only the caller's owned workers or the joined worker's own record, with optional agent_id/state/query, limit 1–50 (20), page (1) and after_message_id (0). It opens no tab and returns up to 50 ordered messages with a continuation id. Advance the cursor to avoid rereading old reports. |
| wait | Optional agent_id and after_message_id, timeout_ms 0–60000 (30000). Wait asynchronously for a broker change, cancellation or timeout, then return a scoped current snapshot. Other Tool Calls remain concurrent. It never keeps a database transaction open while waiting. |
| finish | Joined worker only; result (32000 chars) records its factual handoff. An exact repeated completed result is idempotent. If parent messages are already queued, they remain runnable. A complete public final answer can also settle the worker when no Tool Call is in flight; reasoning/tool/interim content never becomes the result. |
| stop | Parent-only agent_id: invalidate work, cancel pending/uncertain messages, request cancellation of in-flight child Tool Calls and click the proven browser Stop when connected. Leave tabs and prior results open/intact. Browser Stop failure is visible; local stopped status does not prove the provider stopped. Already-detached processes are independent and remain visible separately. |
| resume | Parent-only agent_id, after inspecting paused/error/stopped state. Reuse its chat or an unstarted queued bootstrap. Admission still respects eight active workers. A removed/expired joined child Session requires a new worker; prior history remains available. delivery_uncertain cannot be resumed/replayed: inspect it, stop its pending work explicitly, then decide what new work to send. |

Each reply has action, status (accepted/joined/updated/snapshot/timeout), agents, messages, total, page,
returned and next_after_message_id, plus the common chat_session. Each worker includes opaque id,
label/task/shared context, state, numeric parent/child Session IDs, Workspace id/name, chat id/link,
logical target, model_requested/model_observed, created/updated/start/completion/activity/check times,
bounded error, latest result, message/pending/in-flight Tool Call and active-process counts.
Unavailable identifiers/times/results are null. Model request is intent; only model evidence from
the mounted response is observed. Tokens, cost and reasoning effort are not invented.

Messages contain increasing numeric id, agent_id, kind (bootstrap/message/report/result), text,
delivery state (queued/sending/delivered/uncertain/cancelled), created_at and nullable delivered_at.
The bootstrap record has empty text: its task/context are on the worker, and its private claim is
generated only for that worker's prompt. Queue capacity is 50 per worker; overflow refuses, never
drops an older message. Authenticated parent/child Session capabilities select the family; neither
agent names, OAuth client identity nor transport headers grant access to somebody else's workers.

Native submission preserves drafts/dialogs, requires a fresh blank chat or the exact associated chat,
checks revision around every awaited preparation step and the durable sending commit, and confirms
a new exact user-message receipt before marking delivered. App mentions are excluded structurally
from authored text; rich-text paragraph wrappers preserve logical newlines. Pre-dispatch cancellation
can remove only the exact draft inserted by that attempt. Uncertain delivery is suspended without
automatic retry. App/site changes can require an adapter update; synthetic tests cannot establish
compatibility with a real authenticated account.

Five-second worker checks are independent per worker and use existing open targets. They observe
bounded React progress/completion/public final text, never Network/WebSocket history capture.
The last public final is limited to 32000 characters, with a visible truncation marker. A missing
connection/changed identity pauses the worker; background observation never recreates a closed tab.
Long child Tool Calls veto automatic messages and page-final completion. Parent expiry pauses work.

Turso tables subagents and subagent_messages are distinct functional stores, created directly under
current schema 6; no migration/ALTER or alternative version mechanism is added. They survive restart
and Clear Operational Data independently of log storage/payload retention. Restart pauses active
workers; interrupted starting/sending work becomes delivery_uncertain. Explicit resume is required.
Deleting the parent Session removes its workers/reports after stopping them; deleting a child stops
that worker and removes its child binding. No other Session capability is returned to a caller.
Shutdown stops timers, wakes waits and disconnects CDP without closing the system browser/tabs.

The **Subagents** GUI lists workers with Session (parent or child), state and text filters, pagination,
task preview, activity/silence, observed model, in-flight Tool Calls and detached-process counts.
Details show complete task/context, requested/observed model, timestamps, result, error and paginated
message/report history. Queue message, Stop, Resume and chat opening are explicit native actions;
message drafts remain backend-owned React state. Opening the page never starts/resumes a worker.

Example (use the actual capability):

```json
{"chat_session":"ctx_…","action":"spawn","context":"Review only; coordinate shared files.","workers":[{"label":"Tests","task":"Run the existing checks and report failures."},{"label":"Review","task":"Review concurrency and report concrete defects."}]}
{"chat_session":"ctx_…","action":"wait","timeout_ms":30000}
{"chat_session":"ctx_…","action":"message","agent_id":"agent_…","text":"Check the shutdown path too."}
```

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

Nested selected targets collapse under their selected parent. Before payload moves, MrMCP records one Turso transaction row plus per-item original path, type and cached byte size for non-directory payloads; directory size remains unknown rather than recursively pre-scanning the tree. Successful payloads are stored under one `trash_id`; failures do not roll successful entries back. A failed move with no retained payload removes that item metadata, while `failed_partial` keeps its row so the partial payload remains inspectable. If no tracked item remains, the result has `trash_id: null` and no empty transaction is kept.

Returns `trash_id`, the physical trash directory path, `succeeded`, `failed` and per-path statuses.

Rationale: removal is intentionally reversible; there is no permanent filesystem-delete tool.

### `fs_untrash`

Restores payloads still present under one trash transaction.

Arguments:

- `trash_id` — identifier returned by `fs_trash`.
- `chat_session`.

Each payload is restored independently. Occupied destinations, missing parents, wrong-Workspace paths and unavailable payloads are reported per entry. Successful restores remain restored and delete their item metadata; failed or physically missing tracked items remain visible for retry/cleanup. The trash transaction is deleted only when no tracked item metadata remains.

The desktop **Trash** section is an operator view over authoritative Turso Trash metadata plus live payload presence, not over Tool Call history. Its sidebar badge counts tracked DB items without scanning the filesystem. Each item shows cached original path/type/size together with a live Present/Missing disk state; externally missing payloads remain visible in metadata until explicitly removed. Restore acts only on present payloads and never overwrites an occupied destination; permanent delete removes a present payload when available and always removes its DB metadata. Empty Trash clears both the global payload store and Trash metadata.

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
- `user_data_dir` — profile directory. Empty restores `.mrmcp/cdp/<name>/`; omitted with cdp_ext or explicit null selects Chromium's system profile. Relative executable/profile paths resolve against the application directory. Modern Chrome requires a separate profile for ordinary debugging-port launches. System-profile preference files are never written.
- `args` — up to 100 verbatim arguments, or the public cdp.js switch object. A matching switch replaces its generated default; object `false`/`null` removes a flag, `true` emits a flag, strings/numbers emit `--key=value`, arrays become comma-separated. Keys omit `--`. Empty clears overrides. `headless`, `user-data-dir`, `remote-debugging-*` and the argv terminator remain managed. Extension launches require named switches rather than positional arguments.
- `reverse` — passive attachment to an already installed bridge, opening no URL and changing no profile. Supply extension_id from chrome://extensions, or use that native ID as the browser name. The initial manifest endpoint must reach the shared listener. Prefer cdp_ext for automatic system-browser bootstrap.
- `cdp_ext` — public token-bound URL bootstrap. Defaults to the system profile and an extension installed by the user; opens/reuses Chrome without a debugging port or manually entered extension ID/endpoint. The bootstrap tab remains open. With an explicit custom user_data_dir, extension installation defaults on. Reload the extension after upgrades.
- `cdp_ext_install` — only for cdp_ext=true; default false for the system profile, true for a custom directory. False uses the already-installed extension and skips the automation launch preset. True prepares/loads an extension copy and owns the launched process. It cannot install into an already running Chrome through forwarded flags; user/agent must explicitly choose that setup.
- `translations` / `login` — browser translation and browser-account/sync integration flags. Default true for the external opener, false for managed launches. Website sign-in is independent. Existing Chrome does not apply newly forwarded flags.
- `extension_id` — native identity only for passive reverse attachment, optional if the browser name is that ID. cdp_ext observes it automatically. Bootstrapped profiles with distinct logical names may share an extension directory/native ID; one profile has one active logical connection.
- `extensions` — managed launch only: boolean or unpacked-directory array; `true` keeps profile extensions, an array selects local directories and `'*'` includes enabled profile extensions. Relative paths resolve against the application directory. `false` is the default.
- `update_preferences` — managed launch only: `false` skips profile preference writes. External reverse attachment always leaves profile files untouched.
- `websocket_url` — direct browser-level `ws://` or `wss://` endpoint, without URL credentials or a fragment. A nonempty endpoint cannot be combined with local launch options in the same object. Empty clears the endpoint and returns the name to managed local mode. Direct connections report `port:null` and `user_data_dir:null`, create no local profile directory and never fall back to launching Chrome when connection fails.

- `port` — integer 1–65535 for attachment to an already-running browser; no automatic launch. `null` returns to managed local mode. This mode reports the explicit port and `user_data_dir:null`.
- `host` — optional hostname, IPv4 or IPv6 address for port attachment, default `127.0.0.1`; no scheme, path or embedded port.
- `http_url` — HTTP(S) base URL or exact `/json/version` URL. Base paths are preserved when appending `/json/version`, as are query parameters. The discovery response supplies the browser WebSocket URL. Credentials/fragments are rejected; empty returns to local mode. This mode reports null port/profile.
- `request_timeout_ms` — 100–86400000, default 30000; bounds each individual CDP command and page setup step. Raise it for long `Runtime.evaluate` promises or XPath retries. Timeout does not cancel execution in Chrome; a late actual response can still appear in `cdp_poll` while the connection remains open.
- `connect_timeout_ms` — 100–60000, default 15000; bounds each discovery, WebSocket handshake/setup phase and local launch readiness.

Choose one transport (`reverse`, `cdp_ext`, `port`, `http_url`, `websocket_url`). An explicit selector replaces the previous selection for that name; false/empty/null clears it. External attachment modes create no local profile/process, reject explicit launch options and fail without local fallback. Browser shutdown closes sockets and the shared extension listener, retaining launched browsers. A dropped extension connection does not prove Chrome exited: reuse its manager/process and wait for reconnection, never automatically spawn another browser while that child is alive.

The tool supports all modes; agent and user choose the appropriate one. Direct CDP has its ordinary protocol coverage. Extension mode uses Chrome's restricted `chrome.debugger` domains: Runtime/Page/Network/DOM/Input/Emulation are available, ServiceWorker/BackgroundService are unsupported and their optional setup errors remain visible. Browser-level Target commands are limited; `create_params` accepts only `url`/`background`. Opening DevTools can detach the bridge. Unknown/unsupported operations return the original upstream errors. This requires an extension-capable public cdp.js npm release; an older installed package returns a clear unsupported-release error before launching or creating a listener.

Extension connections also accept `chrome.<namespace>.<method>` with positional `params.args` and optional `params.callback:true`. Example: `chrome.tabs.query` with `args:[{}]`. Native JSON results are preserved in `cdp.result`. The logical target does not supply an implicit tab ID to these APIs: use native tab IDs inside `args`. There is no generic remote Chrome event registration. CDP.js 0.5.0 also forwards chrome.webRequest.* request lifecycle notifications independently of debugger attachment and target.network. They include native request metadata/headers, without response bodies or WebSocket frames. Existing cdp_subs/cdp_poll method/target filters and bounded rings apply; requests with tabId=-1 have no target. Goals/Subagents do not use this stream for matching or retain it implicitly.

Typical system-browser request inside calls[]: {"browser":{"name":"personal","cdp_ext":true},"call":{"method":"chrome.tabs.query","params":{"args":[{}]}}}. Install CDP Ext manually using the [CDP.js instructions](https://github.com/mefistofelix/cdp.js#reverse-chrome-extension-transport); reload it after updates. Explicit managed setup: {"browser":{"name":"bridge","cdp_ext":true,"user_data_dir":"profiles/bridge","cdp_ext_install":true},"target":"page","call":{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}}. Passive attachment remains available with reverse=true and extension_id. A profile already connected to another name/manager rejects rebinding until disconnected.

Explicit fields update the name's configuration **only in memory for the current server run**; omitted fields retain their values. Subsequent calls may use just the name string. Reapply advanced options after restarting MrMCP: they are not persisted as browser configuration or restored from Tool Call history. Canonical request packets may still retain the supplied arguments for diagnostics and explicit Replay. Local launch options are used when a process must be started; reconnecting checks the profile and headless setting when Chromium exposes its command line. A connected or connecting name rejects different options, and a known local browser that is still running must be closed before changing its launch configuration. No option change automatically restarts a browser. Set the configuration on the first use of a name, or repeat the same object in concurrent calls.

Local example: `{"browser":{"name":"tests","headless":true,"executable_path":"C:/Program Files/Google/Chrome/Application/chrome.exe","user_data_dir":"profiles/tests","args":["--window-size=1280,800"]},"target":"page","call":{"method":"Page.navigate","params":{"url":"https://example.com"}}}`.

Direct example: `{"browser":{"name":"remote","websocket_url":"ws://127.0.0.1:9222/devtools/browser/<id>"},"call":{"method":"Browser.getVersion"}}`.

Port example: `{"browser":{"name":"existing","port":9222},"call":{"method":"Browser.getVersion"}}`. HTTP example: `{"browser":{"name":"remote","http_url":"http://localhost:9222"},"call":{"method":"Browser.getVersion"}}`.

Advanced target options apply only to `cdp_call.target`; subscription/poll target filters remain name strings:

- `target_id` — bind the logical label to an existing page instead of creating one. Use the ID from `Target.getTargets`; extension mode also accepts the stringified tab ID from `chrome.tabs.query`. Example: `{"name":"existing","target_id":"123"}`. A live logical label cannot be rebound; choose another label or close it. The normal missing-page recreation policy still applies after that page disappears.

- `name` — required logical page label, 1–128 characters.
- `group` — reverse/extension-only false, a logical group name, or an object with required name and optional Chrome color (grey, blue, red, yellow, green, pink, purple, cyan, orange). Configure on first use. CDP.js groups targets natively, scoped to browser/window; direct CDP rejects grouping.
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

MrMCP exposes one small explicit persistent key-value memory surface: `memory_find` and `memory_set`. There is deliberately no separate `memory_get`; exact lookup is `memory_find` with `key`. Values are explicitly either validated JSON text or ordinary text and are stored in Turso, not in hidden model state.

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

The desktop **Memory** page is a lazy administrative view over the same table. It filters by scope, Session, Workspace, set-date range and text, paginates results, labels JSON/TEXT, displays TTL/expiry, and supports creating Global entries or entries for an explicitly selected existing Session/Workspace, inspecting/editing the complete value/type/key/TTL, and confirmed deletion. GUI creation rejects an already-existing key for that owner rather than silently replacing it; use View / Edit for replacement. JSON memories use the native JSON tree/source editor tree as Tool Call JSON and support node-level editing; text memories use a plain textarea. Switching TEXT ↔ JSON preserves the current draft byte-for-byte as text; invalid JSON remains visible/editable with an error instead of being discarded. native JSON editor writes back through the normal managed form field and Bun submit path, while backend JSON validation remains authoritative.

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

- **Storage: Disk** — history lives in the main Turso database and survives restart.
- **Storage: Memory** — history lives in Turso TEMP tables/FTS on the active connection and disappears on restart. It has a separate retention in minutes.
- **Payload: Payload** — stores exactly the canonical MCP JSON-RPC request packet and canonical MCP JSON-RPC response packet once. Nested JSON/YAML/Base64/images are interpreted only while the fullscreen debugger renders the row.
- **Payload: Metadata** — stores neither MCP packet; identity, Session/Workspace snapshot, status/timing, progress flag and bounded errors remain.

Storage and payload are orthogonal: `Memory + Payload`, `Disk + Metadata`, etc. are all valid. The payload policy is diagnostic only and cannot remove state required by another feature. Persistent-process runtime/history is owned by the process subsystem in the main database and remains independent of Tool Call storage, retention and clear operations, so `exec_attach` / `exec_status` keep working. Browser ring, explicit Memory, Published, Trash and CDP state likewise keep their own authoritative storage. Fullscreen Tool Call details render only capabilities actually present on that row, and Browser/Automation replay is limited to Payload rows.

---

## Command discovery and diagnostics

### Platform-aware command catalog

The authoritative file is root `commands.yaml`. Each entry has `logical_name`, description, optional documentation_url and shared optional path/download_url/archive_path/bundle/default_args. `platforms` maps `windows-x86_64`, `linux-x86_64`, `darwin-x86_64`, `darwin-aarch64` (also aarch64 Windows/Linux) or OS-only keys to path/download_url/archive_path/bundle/default_args overrides. Exact OS/CPU wins over an OS-only fallback. Omitted fields inherit shared values; explicit empty download_url disables download. An empty/absent platform mapping uses shared values; a nonempty mapping with no matching key marks that command unsupported. Missing download URLs permit manually installed executables; no source build/package-manager install is inferred.

Discovery, logical exec resolution, GUI availability and Download/Download All use the selected current-platform variant. YAML order and every platform definition survive edits to another command. The command dialog exposes shared fields plus the complete platform YAML with inline validation. Download supports direct binaries, ZIP and TAR/TAR.GZ/TGZ/TAR.XZ; it installs only the selected regular-file payload below `.mrmcp/bin`, unless an explicit bundle mapping requests a complete runtime in its own subdirectory. Bundle installs preserve library files, materialize only internal TAR links as regular copies, reject traversal/unsafe links, bound expansion and replace the directory only after companion downloads pass SHA-256. They never create archive-controlled symlinks. XZ decompression uses a lazy portable WASM dependency, with the same 512 MiB archive/output limit as gzip. `archive_path` selects an exact archive member; otherwise an unambiguous executable basename is required. Unix installs are chmod 0755. Existing files require the existing overwrite confirmation. Unsupported platform variants are never downloaded or executed.

The default catalog includes native `yt-dlp`, Google Workspace `gws` and `whisper-cli`. Whisper Download also installs its shared-library bundle and multilingual `ggml-base.bin` model (~148 MB); inference is local. Its default_args prepend an absolute model path and language auto; caller arguments can override them. Windows/Linux use upstream b5454 CPU bundles; macOS uses sjoerdteunisse/OpenWhispr prebuilt CLI v1.0.0. Models are downloaded on demand and reused after hash verification, outside the executable. LibGen and Anna’s Archive are supplied by the independent MCP catalog.

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

## OpenRouter API

### `openrouter_req`

Sends one JSON request to `https://openrouter.ai/api/v1`. The local user saves the API key on the **🔀 OpenRouter** sidebar page; a password field, inline validation and Save work like Telegram. An empty saved key removes authentication configuration. Opening or saving this page performs no API request. The key persists in the local database and is never a tool argument or returned value. No Workspace is required.

Arguments:

- `chat_session` — required current Session.
- `request.path` — required API-relative endpoint, such as `/models`, `/chat/completions`, `/responses` or `/embeddings`.
- `request.method` — `GET`, `POST` (default), `PUT`, `PATCH` or `DELETE`.
- `request.query` — optional mapping of URL parameters to strings, numbers or booleans.
- `request.body` — optional ordinary API JSON object; disallowed for GET. Model/provider parameters, messages, multimodal content, structured-output schemas and tool definitions pass through unchanged.
- `timeout_ms` — optional 1,000–3,600,000 ms, default 60,000.

Only non-streaming JSON is supported: omit `stream` or set it to `false`. Responses are bounded to 16 MiB. External URLs, traversal paths and redirects are rejected; authentication headers cannot be overridden. Requests use native `fetch()` without an SDK, automatic retries or execution of model-returned tool calls. Cancellation aborts the HTTP request. Results contain `method`, `path`, HTTP `status`, `success` and the complete JSON `response`; HTTP/provider errors set `success=false` and retain their JSON details. Non-JSON, network, timeout and configuration failures return ordinary tool errors. The configured key is redacted from API results and errors.

Examples:

```json
{"chat_session":"<current Session>","request":{"method":"GET","path":"/models"}}
```

```json
{"chat_session":"<current Session>","request":{"path":"/chat/completions","body":{"model":"<model id from /models>","messages":[{"role":"user","content":"Summarize this text."}],"max_tokens":200}}}
```

Endpoint fields and model capabilities follow the [official OpenRouter API contract](https://openrouter.ai/docs/api_reference/overview).

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

## exec_mcp — separate stdio MCP catalog

Requires chat_session, but no Workspace. Omit mcp and request to return enabled servers with description, availability, persistence and documentation URL. Otherwise mcp is an exact logical server name from mcp.yaml and request is an ordinary JSON-RPC request object with method and optional params/jsonrpc/id. MrMCP performs initialize/notifications/initialized itself; those methods and notification-only requests are rejected. Transport ids are unique within a shared process and restored to the caller’s id (or the outer Tool Call id if omitted). Other request fields and upstream response/result/error fields pass through. Return success=false for a JSON-RPC error or result.isError=true; retain the entire response. Timeout defaults to 60000 ms, range 1000–3600000; cancellation/disconnect/timeout closes that server and fails concurrent calls sharing it. No automatic retries or wrapper files. Progress requests forward upstream progress through the outer Tool Call. Sampling/interactive elicitation is unavailable.

```json
{"chat_session":"<handle>","mcp":"libgen-mcp","request":{"jsonrpc":"2.0","id":"catalog","method":"tools/list","params":{}}}
```

After inspecting the returned current upstream inputSchema, send tools/call with params {name, arguments}; search, get_details, download and read are currently published by libgen-mcp. Download its native binary first from MCP Servers. The authoritative mcp.yaml servers list uses logical_name, description, enabled, command-style platform/path/download/archive metadata and stdio {args, persistence, ttl_seconds, windows_hide}. Defaults: command persistence, TTL 300 seconds, hidden Windows terminal. The starter libgen-mcp v2.2.1 entry uses ttl persistence for 300 seconds and one engine for LibGen, Anna’s Archive/IPFS and open-access sources. Optional member credentials remain upstream environment variables configured through Settings → Process. Legacy libgen-cli and annas-mcp are removed from the default Commands catalog.

command closes after each response; ttl reuses the server until it has no in-flight request for ttl_seconds; persistent starts on the first request and stays until MrMCP Quit. Hiding the GUI window keeps it alive. All actual processes are tracked in the Processes GUI, killed on Session deletion and closed on application shutdown. GUI/catalog edits invalidate existing instances. Pool keys include the Session, binary, argv, cwd, environment and policy. With a Workspace use its directory; otherwise use .mrmcp/mcp/files/<MCP name>/<Session id>. Launch args support ${CWD}, ${WORKSPACE}, ${MRMCP_DIR}, ${MRMCP_BIN}. Binaries live in .mrmcp/mcp/bin and never enter ordinary Commands discovery. Sidecar mcp.yaml is embedded as a first-run template and existing edits are preserved on upgrade. MCP Servers has independent pagination/search and register/edit/delete/download controls; options and every platform mapping survive edits.
