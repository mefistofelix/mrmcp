# Changelog

## 0.10.115

- Replaced `publish_file` and `publish_html` with one stateless `publish` tool. Each call supplies exactly one Workspace `path`, direct UTF-8 `text`, or `base64` payload plus a required MIME type; optional filename, title, description, height and `auto|inline|download` presentation metadata drive one smart MCP App without introducing previous-result/image-id state.
- Unified every publication source into the same persistent `.mrmcp/publish/` file snapshot pipeline. Path sources are copied, direct text/Base64 sources are materialized as bytes, all use a random capability-prefixed sanitized filename and the same fast size/first/last/middle content fingerprint, and `published_uses` retains Session/Workspace plus MIME/presentation metadata while deduplicated payloads survive restart/source deletion until explicit cleanup.
- Replaced separate download/HTML URLs and widgets with one persistent `/published/<id>/<filename>` content URL plus one versioned MIME-aware View. Browser-displayable MIME types retain the filename while using inline Content-Disposition, opaque/binary MIME types use attachment, and the widget independently interprets the presentation hint to show an image/iframe preview or file action. HTML remains isolated in a nested sandbox without `allow-same-origin`; title, description and compact filename/MIME/size/source metadata render above the element. Inline previews expose **Open original** to the persistent URL in a new window/tab, while file-card mode relies on its existing **Open File** action instead of duplicating the same link.
- Simplified the Published administration view around generic content resources: MIME replaces the old file/HTML type distinction, all physical snapshots remain directly visible under `.mrmcp/publish/`, Session and size filtering remain, and the clean current schema no longer depends on the obsolete publication `kind` column/index.

## 0.10.114

- Added `desktop_auto`, the single AAF desktop-automation MCP tool backed by the unversioned latest static `npm:@mefistofelix/auto.js` import. Its `yaml` field links directly to the public AAF specification. Auto.js `run()` structured output is preserved, including arbitrary mixed final state; zero/one/many retained final-state WebP/PNG images keep their nested state positions with `image_id` replacing binary data, while `images[]` maps ids/paths/absolute rect/scale to distinct MCP `ImageContent` blocks for direct model vision. Transient observation images deliberately bypass Published storage, MCP Apps and resource links. Auto.js `0.1.3` fixes Deno npm libvips resolution and declares Sharp as its package metadata dependency, so compact WebP materialization works from the standalone npm package instead of falling back to raw BGRA8.
- Switched Tauriless to the unversioned `npm:@mefistofelix/tauriless` latest import and kept Sharp as an unversioned cached literal lazy import. Sharp is included in the ordinary Deno standalone dependency graph without eager initialization; builds remain standard `deno compile` with no self-extracting filesystem. Sharp is currently bundled only and has no runtime call site.
- Added authenticated sessionless `inspect_tools` for exact live descriptor inspection: agents can request 1–50 unique published tool names and receive each canonical full descriptor from the same source used by `tools/list` as lossless `descriptor_json`, including descriptions, input/output schemas, annotations and metadata, with unknown names reported separately. `names[]` declares `uniqueItems:true` and duplicate names are also rejected at runtime. ChatGPT conversations may retain the tool-schema snapshot they started with, so published name/schema changes are verified from a new chat/branch rather than weakening the canonical schema.
- Hardened the filesystem tools after an end-to-end fixture audit: literal `fs_grep` patterns are now documented as whole substrings (including spaces), `count` is explicitly matching-line count, cursor-filtered `matched_files` is accurate, direct hidden-file globbing honors `hidden`, terminating newlines no longer create phantom lines, empty files read as zero lines, byte-bounded `fs_read` prioritizes requested lines over optional leading context so `next_start_line` always advances, `fs_write(create_parents:false)` reports `parent_missing`, and write/edit require an explicit LF/CRLF/CR choice only when the resulting text has breaks and `preserve` has no unambiguous physical style to reuse (mixed sources, or new/line-ending-free sources). Agent-provided LF/CRLF/CR differences are normalized rather than rejected when the target style is already known. Whole-file `fs_write` now decodes an existing source lazily only when preserved charset/EOL metadata requires it, so an explicit replacement is not blocked by irrelevant old-text decoding.
- Reworked automatic text detection around pinned `chardet`: `auto` passes the detector the complete original byte buffer and uses only its detected charset, with no BOM/UTF-8/UTF-16 override or fallback, while explicit input encodings bypass detection entirely. Physical BOM presence is inspected independently only for factual `bom` metadata. Native decoders now remain fatal on malformed input instead of falling through to permissive iconv decoding; iconv-only charsets require byte-identical decode/re-encode, detected ASCII stays strict ASCII, UTF-32 consumes a leading BOM like native Unicode decoders, and all writes validate final BOM state plus exact decode round-trip so legacy/unrepresentable characters cannot silently degrade. BOM preservation is physical-prefix based even under explicit legacy decoding, while adding a BOM remains limited to BOM-capable Unicode encodings.
- Made recursive `fs_copy` preserve symlinks instead of dereferencing them; the cross-filesystem `fs_move` fallback now has the same symlink semantics as native rename.
- Compacted the Published administration table and prevented the selected Guided Prompts sidebar label from wrapping. Clear Operational Data now compacts SQLite with `VACUUM` and truncates the WAL after clearing operational rows so disk usage actually falls.

## 0.10.113

- Reworked the desktop UI transport so noisy browser state is coalesced only before crossing the Tauri bridge: text input is debounced/merged in the WebView, scroll and focus updates are latest-wins while pending, semantic events remain ordered barriers, and Deno processes every received envelope sequentially. Rendering now uses generations to abandon stale Eta work, serializes main-thread delivery to one in-flight plus one newest pending render, rejects stale revisions in the WebView, and relies on unmodified Morphlex `preserveChanges: true` so active edits and caret position survive unrelated live morphs.
- Added the session-scoped `discover_commands` catalog with ordered YAML metadata, an Agent Discovery toggle, compact Commands filtering/pagination, the Robost desktop-automation entry, and updated command guidance to publish generated files explicitly through `publish_file`.
- Added a dedicated Tool/command filter before generic Tool Call search. Managed-process rows persist/index `process_runs.log_id`, allowing `exec*` calls to resolve back to the originating executable/catalog command; current-schema startup now ensures that column before queries use it, fixing the `no such column: pr.log_id` administration crash.
- Changed Published bulk cleanup to confirmed **Clear Matching** across the complete filtered result set and added fresh per-instance MCP App View resource URIs for descriptor/resource cache busting while keeping canonical URIs internally.
- Updated the pinned desktop runtime to Tauriless `0.1.17`; its npm package was verified to contain the Windows x64, Linux x64, macOS x64 and macOS arm64 native bridges required by release CI.

## 0.10.112

- Isolated each `publish_file` / `publish_html` MCP App View to the standard `ui/notifications/tool-result` channel, pinned the first publication identity mounted by a widget, removed ChatGPT-global `toolOutput` fallbacks and legacy `openai/*` tool metadata, and made `resources/read` independent of contextual `Mcp-Name` values. Widget resource URIs were bumped to invalidate cached markup.
- Changed `published_uses` from append-only publish-call history to one current relationship per published item + Session + call-time Workspace. Republishing in the same relationship updates display/source metadata and timestamp, while different Workspaces remain distinct references.
- Made publication download capability tokens authoritative regardless of the presentational filename suffix, while still using a matching publication reference to select its MIME override when available.
- Disabled MCP discovery/tool/resource caching with `ttlMs: 0` so clients observe current descriptors and versioned MCP App resources immediately.

## 0.10.111

- Deduplicated `publish_file` and `publish_html` resources by deterministic content identity while retaining random public capability ids. Files use the requested fast fingerprint of size plus first, last and central 10-byte samples; HTML uses a full SHA-256 hash. Publication snapshot/dedup/registration is serialized through one shared chain.
- Added `published_uses` history so one deduplicated resource retains every call-time Session, Workspace, source and display reference. The Published UI now shows all associated Session/Workspace references, supports Session filtering across them, records request count/last request, and opens the persistent public URL.
- Hardened simultaneous MCP App previews by randomizing per-widget JSON-RPC request-id bases and completing `ui/notifications/initialized` even after an initialize timeout, preventing concurrent image/HTML previews from remaining blank.
- Removed automatic expiry and one-time publication semantics; published resources remain persistent until explicitly deleted or cleared.

## 0.10.110

- Fixed Workspace trash storage so MrMCP has exactly one trash location at `APP_DIR/.mrmcp/trash/`; named Workspaces no longer receive `.mrmcp/trash` directories. Trash manifests retain absolute original paths, restore remains scoped to the originating Workspace, and cross-volume trash/restore falls back from rename to copy+remove with rollback.
- Updated Dashboard Trash and Empty Trash to read and clear only the single global MrMCP trash store.

## 0.10.109

- Unified `publish_file` and `publish_html` persistence under `.mrmcp/publish/` with one shared `published` metadata table. File snapshots use `<id>-<original filename including extension>` and retain the exact source path/name plus physical and exposed filenames; HTML snapshots use `<id>.html`; both retain the call-time Session id. Added a Published GUI with type/Session/size filters, native OS opening, per-item deletion and Clear All. Publications survive source deletion and server restarts and are persistent by default unless explicit expiry or one-time semantics are requested.
- Fixed `publish_file` / `publish_html` MCP App widgets to observe late ChatGPT `toolOutput` updates through `openai:set_globals`, avoiding false missing-URL errors when the iframe is created before its tool result; bumped both versioned UI resource URIs to invalidate cached widget HTML.
- Added sessionless `create_workspace(name)`: it creates a new empty Desktop directory, registers it as an enabled Workspace, keeps the resolved path opaque to the agent, and fails before creation on Workspace-name/path collisions or an existing target directory.
- Added confirmed Clear actions to Tool Calls, Sessions, Workspaces and OAuth Clients, matching the existing HTTP Log clear flow.
- Hardened Operational Data clearing by deleting dependent Tool Call/HTTP metadata explicitly and surfacing completion or failure in the UI instead of only console output.
- Reorganized Settings into a stable main configuration column and a compact secondary controls/maintenance column.
- Tool Calls compact rows now show the persisted call-time Workspace below the numeric Session id.

## 0.10.108

- Added the standard Tauri macOS notification permission flow lazily on the first native notification: reuse an existing grant, request authorization when needed, and suppress delivery for the run if the user denies it.
- Delay startup notification flushing until the main window is visible so any first macOS authorization prompt is attached to the visible MrMCP app rather than hidden startup.

## 0.10.107

- Restored the WebView-side `tauri://close-requested` interception independently from GUI bootstrap, so the window X is prevented from destroying `main` while the Deno main-thread drain hides it.
- Updated to Tauriless `0.1.14`, which builds Tauri in production/custom-protocol mode, and set the macOS Tauri application identifier to the packaged `com.mefistofelix.mrmcp` bundle id before the first WebView so native notifications use the correct app identity.
- Marked the macOS tray icon as a template image so the status item renders correctly in the menu bar.

## 0.10.106

- Made native DMG creation retry-safe against transient `hdiutil` `Resource busy` failures on GitHub macOS runners, cleaning any partial image/temporary mount before retrying.

## 0.10.105

- Gave the DMG source filesystem an explicit 512 MiB capacity so `hdiutil` cannot under-estimate the temporary volume while copying the large standalone app on Apple Silicon; the published UDZO image remains compressed.

## 0.10.104

- Replaced the macOS `.app.zip` release containers with native compressed `.dmg` disk images, each containing the signed `MrMCP.app` bundle plus an `Applications` link for the conventional Finder drag-install flow.
- Added DMG creation, verification, mount-back validation and app signature checks to the native macOS release jobs.

## 0.10.103

- Switched MrMCP's desktop pump from the removed Tauriless `drain()` API to Tauriless `0.1.13` `run(16)`, giving the native Tauri/Tao loop a bounded 16 ms slice before Deno resumes its own event loop.
- Restored the independent macOS GUI smoke test after the Tauriless run-loop diagnostics: CI now compiles and launches the actual MrMCP standalone with Tauriless `0.1.13` on both Intel and Apple Silicon, requiring it to remain alive beyond the WebView bootstrap deadline.

## 0.10.102

- Updated the pinned desktop runtime to Tauriless `0.1.13`, including the bounded macOS run-loop fixes validated in the Tauriless release.
- Removed the Dashboard Active Tool Calls internal scrollbar; the panel keeps its compact minimum height and expands for additional live/recent calls.
- Added persistent HTTP-log Session/Workspace snapshots so each associated HTTP row shows the Workspace used for that call rather than the Session's later current Workspace.
- Made direct `--backend` execution strictly headless: Tauriless is never imported, WebView assets are not read, GUI renders are not queued and desktop notifications are not emitted.
- Added `--add-workspace <name> <path>` as a one-shot database command that validates and inserts an enabled Workspace, then exits without starting the server or desktop runtime.

## 0.10.101

- Changed macOS release artifacts from raw executables to native x64/arm64 `MrMCP.app` bundles inside `.app.zip` archives, with `Info.plist`, generated `.icns`, executable permissions, ad-hoc code signing and structural validation on native macOS runners. Packaged apps keep `commands.yaml` and `.mrmcp` under `~/Library/Application Support/MrMCP/` so runtime writes never modify the application bundle.
- Added a separate GitHub Actions macOS GUI smoke-test workflow. It runs natively on `macos-15-intel` and Apple Silicon `macos-15`, builds the matching standalone executable, launches the real Tauriless WebView, waits beyond MrMCP's 10-second bootstrap deadline and fails with the captured process log if the application exits or reports a WebView bootstrap timeout.

## 0.10.100

- Simplified WebView bootstrap to match Tauriless' working Deno example: the browser now uses a classic inline script, listens only for MrMCP's host→WebView render event, then emits its bootstrap message. Native `tauri://close-requested` remains owned by the Tauriless main-thread drain, and the browser no longer reads `__TAURI_INTERNALS__.metadata.currentWindow` during startup. This removes macOS-specific failure points that could stop the bootstrap before the first WebView→host message.

## 0.10.99

- Load Tauriless lazily only in the desktop/main isolate instead of importing it at module top level. The backend Worker therefore never executes Tauriless' eager `Deno.dlopen`, preventing the same macOS dylib from being mapped twice and registering duplicate Objective-C classes such as `NotificationCenterDelegate`.

## 0.10.98

- Added a tag-driven GitHub Actions release workflow that verifies the tag against `VERSION`, uses Deno 2.9.5 and publishes exactly four standalone executables: Windows x64, Linux x64, macOS x64 and macOS arm64.
- Updated the pinned desktop dependency to Tauriless `0.1.12`, whose package includes the new `darwin-arm64` native bridge required for Apple Silicon. Release CI explicitly disables Deno's default 24-hour minimum dependency age so a newly published pinned Tauriless release can be built immediately.

## 0.10.97

- Prevented horizontal overflow in the Dashboard Active Tool Calls panel; it now exposes vertical scrolling only while keeping long call summaries clipped/ellipsized within the fixed five-row viewport.

## 0.10.96

- Fixed the Dashboard Active Tool Calls panel to a five-row viewport with internal scrolling; clicking any live/recent row opens that exact Tool Call expanded and scrolled into view in the Tool Calls section, with Deno selecting the correct log page even when the call is not on page 1.
- Extended completed-call Dashboard retention/fade from three to five seconds and unified Dashboard/toast Tool Call summaries through the same bounded `tool · args` formatter. Tool Call toast bodies now put that summary first so Windows truncation cannot hide it below the multiline Session block.

## 0.10.95

- Suspended administration UI projection/Eta rendering and Worker→WebView HTML delivery while the native desktop window is hidden or minimized. Backend state continues updating and remains dirty; restoring/showing the window produces one fresh full render of the current state instead of replaying hidden intermediate updates.

## 0.10.94

- Replaced client-chosen persistent-process labels with `exec_id`, the integer Tool Call id returned by `exec_start`; all process-control access is scoped to the same `context_handle`, and Clear Operational Data no longer resets the Tool Call AUTOINCREMENT sequence so live/future exec ids cannot collide.
- Added `exec_status(exec_id)` for non-consuming state inspection and optional complete or tail output after completion/kill, while `exec_list` now reports only currently running persistent executions.

## 0.10.93

- Added request-scoped MCP SSE progress for foreground `exec` and foreground custom commands only when `_meta.progressToken` is supplied; the final result still contains the complete normalized transcript. `exec_attach` uses SSE when accepted even without a progress token so its no-progress long-poll can wait for data before returning.
- Switched HTTP compression to Deno's native `Deno.serve({ automaticCompression: true })` on both public listeners; MrMCP no longer contains a hand-written Brotli/gzip response middleware or any `Content-Length`/chunk-framing compression logic.
- Replaced `exec_poll` with explicit persistent-process lifecycle tools. `exec_start(label)` retains the complete process transcript; `exec_attach(label)` either streams unread backlog+live output to process end when progress is requested or returns repeated long-poll chunks of at most 16 KiB with `remaining_bytes` when progress is absent. `exec_write`/`exec_kill` address the same Session-scoped `(context_handle, label)` identity, and `exec_list` reports retained labels/states. Removed public offsets, `wait_ms`, process ids and PIDs from the MCP process contract while retaining internal ids/PIDs for administration.
- Added transport metadata for whether each Tool Call supplied `_meta.progressToken`; Tool Calls, Dashboard process activity and desktop Tool Call notifications show **📡 Progress requested** without modifying the recorded tool arguments.
- Added a Dashboard **Active Tool Calls** table with the shared compact call summary, Session, elapsed time and progress marker; completed calls remain visible for three seconds and fade before a Deno-owned timer removes them.
- Changed HTTP Debug Log recording to insert a row as soon as the request arrives and update that same row only when response delivery completes or disconnects. Streaming SSE response bodies are captured through the live response path without draining/cloning the stream before delivery.
- Added the additive `tool_call_transport` table keyed by Tool Call log id for transport-only progress metadata.

## 0.10.92

- Added bounded argument previews for every compact Tool Call row and desktop Tool Call notification, omitting Session bearer handles while preserving command-aware previews for the `exec*` family.
- Expanded Tool Call details with a separate **Tool Return Value JSON** block before the final **MCP Result JSON**, including process/`exec*` calls.
- No SQLite schema change.

## 0.10.91

- Added explicit Tool Call outcome notifications: invalid/rejected calls receive a single `⚠️ Invalid Tool Call #…` / rejection notification, while valid calls that later fail receive a final `❌ Tool Call Failed #…` notification. Session context remains first in the body, followed by tool/compact command and a bounded error summary.

## 0.10.90

- Fixed Tool Calls UI rendering after compact `exec*` previews were added: the logs API now resolves its server configuration before building command previews instead of referencing an undefined `p`.
- Moved the Tool Call number into the desktop notification title (`🛠️ Tool Call #123`) and place the Session summary first in the body, before the tool name/command preview, so context is read first.

## 0.10.89

- Redesigned desktop notification copy around logical Session events: **✨ New Session**, **🟢 Session Active** after 10 minutes without a Tool Call, and **📂 Workspace Opened**. Every Session reference is a compact multiline summary with current Workspace, creation age and total Tool Calls; Tool Call and multi-Workspace notifications use emoji and short bulleted groups.
- Unified the compact-header active Session window with the same 10-minute inactivity threshold used by **Session Active** notifications.
- Fixed the expanded Tool Call **Agent Tool Definition** layout by scoping fixed sidebar CSS to the shell sidebar, allowing the schema/descriptor panel to use the full available right column.
- Added compact command-line previews for the `exec*` family in Tool Call rows and desktop notifications. Previews strip executable directory paths, show at most six arguments, truncate long arguments, cap the whole preview at 180 characters and retain the full command only in expanded details.

## 0.10.88

- Added sessionless read-only `list_workspaces`, returning only enabled Workspace names, while keeping `open_workspace.name` a free string validated at execution time instead of an enum of configured names.
- Persist Tool Call descriptor snapshots and show the exact agent-facing title, description, input schema and output schema beside expanded calls, with a live **CURRENT** / **OUTDATED** comparison against the descriptor currently published by the server.
- Split Desktop Notifications into independent Session, Workspace and Tool Call settings; notification titles no longer repeat `MrMCP` and include the Workspace name when one is known.
- Moved **Save Settings** to the top of Settings so it remains immediately visible.

## 0.10.87

- Updated the pinned desktop dependency to `@mefistofelix/tauriless@0.1.11` and pass `name: "MrMCP"` with the Windows AppUserModelID registration. Windows keeps the simple production flow: call `tauriless:set-app-user-model-id` with the standalone executable path before the first WebView, then use the standard Tauri notification plugin without JS-side data-directory, shortcut or pinning workarounds.
- Standardized desktop notification copy and added a Workspace notification whenever `open_workspace` successfully attaches a Session to a Workspace. Notification titles are compact (`MrMCP · Session`, `MrMCP · Workspace`, `MrMCP · Tool Call`) and bodies carry only the useful Session/tool/Workspace identifiers.

## 0.10.86

- Pinned the desktop Tauriless dependency to `@mefistofelix/tauriless@0.1.7`, the first npm release that accepts `tauriless:set-app-user-model-id` before the first WebView. This prevents Windows startup from embedding the older 0.1.6 bridge and exiting before the GUI opens.

## 0.10.85

- Fixed desktop close handling so the WebView registers the Tauri close-request listener before bootstrap; the window X hides the window while MrMCP keeps running, tray visibility is read from Tauri rather than cached locally, and a tray click restores a minimized window before focusing it.
- Added a global Desktop Notifications setting, enabled by default, covering newly created Sessions, incoming Tool Calls, successful native directory drops and dropped directories that already exist as Workspaces. On Windows the desktop host now sets the process AppUserModelID to `Deno.execPath()` through Tauriless before creating the first WebView, so subsequent Tauri plugin notifications use the registered standalone executable identity.
- Fixed desktop tray Quit handling by attaching the Tauri channel to the `tray-quit` menu item itself and routing desktop channel messages by their payload instead of hard-coded callback ids; the tray menu label remains exactly **Quit** and normal window X remains hide-only.
- Restored live Tool Call termination controls as soon as a running call becomes cancellable, with the force action labeled **Kill**.
- Replaced the HTTP Log checkbox + Apply flow with one immediate, high-contrast **Logging ON / Logging OFF** button. Disabling recording stops new HTTP debug rows but keeps all stored rows, filters and details visible until explicitly cleared.
- Extended `open_workspace` with optional `current_context_handle`: an active Session is switched to the named Workspace without changing its handle, while an omitted, empty, unknown or expired value creates a new Session. Its result also includes `workspace_name`, absolute `cwd` and nullable `agent_guidance_path`, and the redundant public `workspace_info` tool was removed.

## 0.10.84

- Moved the desktop GUI from authenticated loopback HTTP to Tauriless' local asset protocol, eliminating GUI port 7332, login/session cookies, CSRF and the WebSocket/SSE transport.
- Replaced GUI transport with the Tauri event bus: WebView inputs use `plugin:event|emit`, the backend Worker remains authoritative, and rendered Eta payloads return through `plugin:event|emit_to` before Morphlex applies them.
- Added the native window icon and OS notification for newly created remote Sessions; reduced the tray menu to Quit, made left tray clicks toggle show/hide, and made the window X hide rather than exit.
- Renamed the user-facing directory model from Roots to globally named **Workspaces**. `roots`/`root_id` remain internal persistence names, while `roots.name` is now `UNIQUE(name)`.
- Replaced the previous context-open flow with `open_workspace(name)`; opening a Workspace creates a Session already attached to it.
- Changed native directory drops to add Workspaces automatically, ignoring files and already-configured paths; generated names use the first free `Name`, `Name #2`, `Name #3`, ... value.
- Replaced error/message popups with inline field validation and disabled Save actions; generic operational failures use non-modal notice balloons.
- Enriched HTTP Log rows with Session id, client id and per-IP request totals, removed remote ports, and redesigned expanded HTTP details into structured Request/Response panels.
- Reduced Tauriless host event traffic by unsubscribing 16 unused initial events before WebView creation and using the built-in `tauriless://webview-message` event. Browser text input is coalesced before host delivery while action/blur/change/submit/navigation flush pending edits first.
- Force the initial Tauriless inner window size to logical 1180×760 before showing the window, then center it.
- Removed the decorative puzzle emoji from the native window title; it is now simply `MrMCP <version>`.

## 0.10.83

- Replaced the direct `@webview/webview` desktop shell with `Tauriless` imported directly through Deno as `npm:@mefistofelix/tauriless`; the main OS thread now drains Tauriless every ~16 ms while the existing backend remains a named Deno Worker in the same process.
- Kept this first Tauriless integration on the existing authenticated loopback GUI URL, with window destruction driving graceful Worker shutdown; the next planned step is Tauriless asset-protocol delivery so the local GUI no longer needs a network listener/session/CSRF layer.
- Hardened GUI bootstrap by embedding the logo, Morphlex and browser bootstrap directly into the authenticated page and allowing the page CSRF capability on persistent GUI GET channels, avoiding WebView subrequest-cookie failures.
- Normalized the Windows managed-child PID before SQLite persistence so a missing/non-bindable Node-compatible `child.pid` is stored as `NULL` instead of breaking `exec` with a SQLite parameter-binding error.
- No SQLite schema change.

## 0.10.82

- Colored every Tool Calls status-filter option with the same semantic status palette used by rows and the compact header: `completed` green, `failed` red, `invalid` purple and `running` yellow; the selected status keeps its semantic color after the Deno-owned rerender.
- Changed the release workflow rule so Git release commits use a concise descriptive message containing the version and primary change instead of generic `release X.Y.Z` messages.
- Reverified that the OAuth consent page remains the compact dark 52vw one-screen layout introduced in 0.10.81, with combined `vw` + `vh` typography and no desktop scrolling regression.
- No SQLite schema change.

## 0.10.81

- Fixed the OAuth consent layout's landscape scaling bug: `vmin` was tied to the shorter viewport dimension and made typography too small, while the card width was unnecessarily capped by `72vh`.
- Kept the dark centered one-screen design but made the card a true `52vw` desktop panel and sized text from combined `vw` + `vh` terms, producing substantially larger readable typography without bringing back vertical scrolling.
- Increased the logo and metadata/action text proportionally, kept the four request details in one compact panel, and removed the redundant OAuth footer so the larger type still fits comfortably.
- No SQLite schema change.

## 0.10.80

- Added a distinct `invalid` Tool Call state for requests that reach MrMCP but fail protocol, tool-name, context or input-schema validation before execution.
- Kept published input schemas strict and added matching server-side validation so non-conforming clients that still dispatch invalid calls are diagnosable without loosening the MCP contract.
- Invalid rows retain the received input, validation error and returned MCP/JSON-RPC result; Tool Calls can be filtered by `invalid`, and the compact header exposes a clickable purple invalid count alongside red execution errors.
- Clarified `exec`/`exec_start` invocation guidance and the release Git invocation contract; `program + args` remains the direct process path and `shell_command` remains the explicit shell path.
- No SQLite schema change.

## 0.10.79

- Increased OAuth consent typography for better readability while keeping the viewport-relative one-screen layout and card dimensions unchanged.
- Reverified the consent layout at 1920×1200 with the larger text and no scrolling.
- No SQLite schema change.

## 0.10.78

- Reworked OAuth consent sizing around viewport-relative `vw`/`vh`/`vmin` units instead of fixed-pixel dimensions, so the card and typography scale with the actual browser viewport.
- Locked the consent document to the viewport and verified the 1920×1200 desktop render has no vertical overflow while keeping the complete decision visible.
- No SQLite schema change.

## 0.10.77

- Reworked OAuth consent into a much smaller centered card with compact metadata rows instead of oversized nested cards.
- Switched consent/error styling to the same dark palette as the administration GUI while preserving green authorize and red cancel actions.
- Kept the full decision visible in a normal viewport with substantially more background around the card.
- No SQLite schema change.

## 0.10.76

- Compacted the OAuth consent screen to fit the complete authorization decision and actions in a normal viewport with substantially less scrolling.
- Removed the redundant trust-notice block while keeping client, scope, resource and return destination visible.
- Reduced logo, typography, spacing and button sizing, with an additional low-height viewport layout.
- No SQLite schema change.

## 0.10.75

- Restored the Windows executable icon by making `--icon assets/mrmcp.ico` part of the required standalone build command.
- Documented the icon flag as a release invariant alongside `--no-terminal` so fast releases do not silently ship the default Deno executable icon.
- No SQLite schema change.

## 0.10.74

- Reordered header listener ports to HTTP / HTTPS / GUI so public ports appear first.
- Made useful header counters server-routed shortcuts: Settings, all Sessions, per-Session Tool Calls, and running/all/failed Tool Call views; filters remain exclusively Deno-owned `uiState` rendered through Eta.
- No SQLite schema change.

## 0.10.73

- Compacted the OAuth Clients table from six columns to four, grouping Session and token lifecycle details while keeping all timestamps and relative ages visible.
- Prevented client IDs and date metadata from forcing excessive table width; actions remain compact at the right.
- No SQLite schema change.

## 0.10.72

- Redesigned the generic OAuth consent screen around a centered MrMCP brand card with the public logo, clearer client/scope/resource/return-destination details and an explicit trust notice.
- Made **Authorize Access** a green primary action and **Cancel** a red secondary/destructive action, without button emoji; kept the page client-agnostic and preserved the standard direct OAuth redirect to the registered client callback.
- Moved the complete OAuth consent/error document to Eta using the same server-side Eta instance as the administration UI, with auto-escaped dynamic values and a matching branded invalid/expired-request state.
- Expanded **OAuth Clients** with client creation, first/last Session creation, latest access-token issue and latest refresh-token use timestamps, including compact relative ages.
- No SQLite schema change.

## 0.10.71

- Advertised the MrMCP PNG logo through MCP `serverInfo.icons`, using the current public HTTPS base URL so compatible clients can display server branding.
- Added unauthenticated read-only HTTPS `GET /mrmcp-icon.png`, backed by the versioned `assets/mrmcp-logo.png`; normal GUI `/assets/...` routes remain authenticated.
- Centralized server name/version/icon metadata in one `mcpServerInfo()` projection used by `server/discover`, response `_meta` and the MCP self-test.
- No SQLite schema change.

## 0.10.70

- Fixed desktop shutdown so closing the WebView cannot leave `mrmcp.exe` resident after listeners stop: Worker readiness/shutdown timeouts are cancellable, graceful Worker shutdown is still awaited, and the desktop main entrypoint exits explicitly after cleanup.
- Changed the Dashboard Trash card from historical `trash_paths` counts to the live `.mrmcp/trash` filesystem inventory, so **Empty Trash** immediately shows `0` and no stale action/path details. Untrash activity remains historical.
- Tool Calls now uses the explicit emoji-presentation form `🛠️` throughout the GUI so Windows renders the icon consistently with the other colored emoji.
- No SQLite schema change.

## 0.10.69

- Replaced the desktop backend child process with a named Deno Worker/isolate inside the same OS process. WebView close now sends a graceful Worker shutdown message and terminates the isolate only as a bounded fallback, eliminating the extra `mrmcp.exe` lifecycle.
- Added runtime listener fallback in `+50` steps for GUI/HTTP/HTTPS without persisting fallback ports. The header turns warning-state when fallback is active and shows effective ports; ACME HTTP-01 is disabled unless effective HTTP remains port 80. Parallel isolated test instances should run from separate program directories.
- Expanded the compact header with five-minute active Sessions, recent `#Session(total Tool Calls)` summaries, and Tool Calls total, in-flight and error counts. Related values are grouped and use semantic text colors without adding extra icon noise.
- Process stdout/stderr is now terminal-normalized before buffering or storage. ANSI/OSC/control sequences are removed and standalone carriage-return progress updates become separate lines, preserving intermediate progress states. No raw process-output copy or `raw_output` option remains.
- Simplified explanatory GUI copy and standardized Tool Calls on the `🛠` icon across navigation, pages, cards and Session actions.
- No SQLite schema change.

## 0.10.68

- Added Settings **Clear Operational Data**, preserving authentication, Sessions/contexts, Roots, server settings and registered tools while clearing Tool Calls/search rows, process history, HTTP debug logs, persisted HTML and request metrics.
- Added Dashboard **Empty Trash**, permanently clearing managed `.mrmcp/trash` contents under the program folder and every configured Root after confirmation.
- Both maintenance actions use a Promise barrier rather than an application queue: already in-flight Tool Calls finish, new Tool Calls wait, maintenance runs, then waiting calls continue. Managed processes detached from a completed `exec_start` call do not delay maintenance.
- Maintenance confirmation dialogs close immediately after Confirm and never produce completion dialogs. Only the action button being executed shows a spinner with live `in flight` / `waiting` counts and then returns to its normal label.
- Added a live Dashboard **Tool Calls In Flight** counter backed directly by current Deno runtime state; no browser polling or browser-owned countdown was introduced.
- No SQLite schema change.

## 0.10.67

- Simplified expanded Tool Calls stdin rendering: the dedicated Stdin panel now shows the raw input value directly, without a redundant shell heredoc wrapper; base64 input remains labeled.
- No SQLite schema change.

## 0.10.66

- Removed Windows `taskkill` process-tree handling. Managed termination now uses only the existing Deno/Node child-process `kill()` API, with no spawned platform-specific helper command.
- Renamed explicit operator/client termination origin from `termination_source: "mrmcp"` to `termination_source: "user"`; timeout and server-shutdown requests are tracked separately as `timeout` and `server`, while externally observed termination remains `external`.
- Kept `signal` as the signal actually observed from the child runtime when available and `requested_signal` as the requested termination mode, avoiding fabricated Windows signal values.
- Terminate/Force target the managed child only. There is no claim of portable recursive process-tree termination; foreground calls still return after parent exit even if descendant processes retain inherited output handles.
- No SQLite schema change.

## 0.10.65

- Fixed Tool Calls **Terminate** / **Force** for managed processes. On Windows, Terminate first attempts `taskkill /T` and escalates to `/T /F` when required; Force uses `/T /F` immediately so the process tree is actually stopped rather than only the parent process.
- Managed-process completion now observes the parent process `exit` instead of waiting indefinitely for Node's `close` event. Output is allowed a short drain period, then lingering inherited stdout/stderr pipes are detached so a foreground MCP tool call returns even when the parent was killed while descendants still hold the pipes open.
- Process responses now expose `requested_signal` and `termination_source` (`mrmcp` or `external` when the origin is observable), and the expanded Tool Calls terminal shows the termination origin/signal. A normal Windows `exit 1` is not falsely classified as an external kill.
- Process exit now queues a Tool Calls UI render so kill buttons/status disappear promptly after the process actually ends.
- No SQLite schema change.

## 0.10.64

- Added process-call stdin to the expanded Tool Calls terminal view when `stdin` was supplied, rendered before output as a shell-style `<<'EOF' ... EOF` heredoc.
- Preserve the logged stdin value exactly; base64 stdin is labeled as base64 rather than being decoded only for display.
- No SQLite schema change.

## 0.10.63

- On Windows, managed `exec` / `exec_start` child processes now use `node:child_process.spawn(..., { windowsHide: true })` so console executables do not briefly create a visible console window or steal focus from the MrMCP WebView.
- Adapted Node child stdin/stdout/stderr to Web Streams internally, preserving the existing process polling, combined output, stdin, timeout and cancellation behavior; non-Windows execution continues to use `Deno.Command`.

## 0.10.62

- Renamed the current `recent_tool_calls` tool to `query_tool_calls` with no compatibility alias, matching its role as a filterable history query rather than only a recent-items fetch.
- Kept `limit` at default 10 / maximum 50 and added combinable exact `tool`, exact `status`, case-insensitive literal `query` across the complete stored log record, and stable `before_id` backward pagination.
- Added Dashboard Trash and Untrash activity cards derived from completed Tool Call logs, showing total completed operations plus the latest completion time, action/folder id and absolute trash path; the Untrash path is explicitly historical after restoration.
- No SQLite schema change; the Dashboard derives this information from existing persistent Tool Call logs.

## 0.10.61

- Added `publish_html` for agent-generated interactive HTML/CSS/JavaScript, presented through its own MCP App widget and nested sandboxed iframe.
- Persisted published HTML in SQLite with an unguessable `/published-html/html_...` URL, so previously published content survives MrMCP restarts.
- Kept the nested document isolated by omitting `allow-same-origin`; scripts, forms, modals and popup links are available, while external network resources remain host/browser/CORS dependent and self-contained HTML is the portable default.
- Removed database schema versioning entirely: there is no `DB_SCHEMA_VERSION` or `PRAGMA user_version` startup gate. Additive tables/indexes are ensured with `IF NOT EXISTS`, while genuinely incompatible existing table shapes still fail on the actual required columns.

## 0.10.60

- Made the attached MCP App/Smart App widget the single supported `publish_file` presentation path in ChatGPT.
- Removed `return_mode=inline|link|both`, Base64 image payloads and raw MCP `resource_link` output from `publish_file`; the tool now returns one temporary HTTPS `uri` in `structuredContent` for the widget to consume.
- Updated the widget to render image MIME types through a normal HTML `<img src=uri>` and non-image files through an **Open File** action.
- Removed `exec.return_files*`; commands create files and `publish_file` presents them, so agents have one unambiguous delivery workflow.
- Bumped the widget resource URI to `ui://mrmcp/file-preview-v4.html` to avoid stale cached widget HTML.
- No SQLite schema change.

## 0.10.59

- Made all Root, Command, Confirm and Message dialogs fully Deno/Eta-owned: Eta renders `open`, the WebView no longer calls `showModal()`, and CSS supplies the modal overlay without browser-side dialog state.
- Moved Root and Command path validation from per-keystroke rendering to blur-time validation, preserving draft updates while typing and carrying the next focus target through the render pipeline so validation cannot steal focus/caret.
- Marked invalid named-root paths red in both Roots and Sessions, with the validation reason available as a tooltip.
- Simplified Roots drag/drop Session items: the first line now contains only Session id/client, while Created, Last Activity, Status and `Tool Calls: N` share one compact metadata row; generic OAuth text was removed.
- Moved reversible trash storage under each Root's reserved `.mrmcp/trash/` metadata directory instead of a top-level `.trash/` directory.
- No SQLite schema change.

## 0.10.58

- Fixed Roots Session cards so Created and Last Activity timestamps are preserved from the projection and rendered correctly.
- Added each Session's Tool Calls count to Roots assignment cards.
- Removed the redundant absolute program-folder path from the Default-root card; the existing explanatory text is sufficient.
- Root paths may now be absolute or relative. The exact entered string is stored in SQLite; relative roots are resolved against the program folder only at runtime when filesystem/process operations need an absolute path.
- Root path existence/type validation is now a live red warning beside the field and does not block saving an otherwise valid Root. Command path warnings use the same inline style and keep the dialog open instead of replacing it with a generic Error dialog.
- No SQLite schema change.

## 0.10.57

- Compiled the Windows standalone executable with Deno `--no-terminal`, so launching `mrmcp.exe` opens only the WebView and does not create a companion console window.
- Kept source-mode `deno run` unchanged so development and backend diagnostics can still use a normal terminal.
- No SQLite schema change.

## 0.10.56

- Added `recent_tool_calls`, scoped to the exact `context_handle`, so agents can inspect calls that actually reached MrMCP without querying SQLite; requests blocked upstream before MCP dispatch are necessarily absent.
- Made process `output` the default terminal-like stream, combining stdout and stderr in observed arrival order; `separate_streams: true` optionally adds the individual streams, and `exec_poll` supports a combined `output_offset`.
- Restricted Tool Call terminal rendering to process-like results and changed the terminal block to the combined output stream above MCP JSON.
- Normalized GUI page headings, action buttons and dialog titles to consistent Title Case, including **Tool Calls** and **HTTP Log**.
- No SQLite schema change.

## 0.10.55

- Clarified `exec`/`exec_start` argument-vector semantics: `args` is passed verbatim and in order, and agents should consult `--help` instead of rewriting uncertain CLI syntax.
- Clarified process output schemas so `stdout` and `stderr` are explicitly diagnostic outputs that should be read together with status and exit code.
- Added a terminal-style block above MCP JSON in expanded `exec`, `exec_start` and `exec_poll` Tool Call rows, showing command, cwd, stdout and stderr; live in-memory process output is preferred when available.
- Added stable DOM ids for Tool Call pagination, table, compact rows and expanded detail rows so Morphlex keys existing rows by database primary key instead of rematching them by table position during live inserts.
- No SQLite schema change.

## 0.10.54

- Began versioning the root `commands.yaml` catalog instead of leaving it hidden by the root ignore rule.
- Kept `commands.yaml` outside `assets/`: source mode edits the root file directly, while standalone builds embed it separately with `--include commands.yaml` only as a first-run template.
- On standalone backend startup, materialize the embedded `commands.yaml` beside the executable only when that physical file is absent; existing user edits are never overwritten.
- No SQLite schema change.

## 0.10.53

- Added reversible `trash_paths` for files, directories and glob selections. Each call stores one timestamped action below `.mrmcp/trash/` with a sibling JSON manifest and returns its `action_id`.
- Added `untrash_action(action_id)` with all-or-nothing restore semantics and rollback on a mid-restore failure.
- Kept trash actions intentionally simple: no hashes or redundant integrity metadata; MrMCP assumes `.mrmcp/trash` is managed only by MrMCP while retaining the preflight needed for transactional restore.
- `trash_paths` and `untrash_action` are not annotated as destructive because they move data reversibly; removed the permanent `delete_path` tool so filesystem removal is trash-only.
- No SQLite schema change.

## 0.10.52

- Moved GUI/browser resources into a single versioned `assets/` directory: Morphlex, SVG/PNG branding, the multi-resolution Windows ICO and the administration screenshot.
- Added authenticated `/assets/...` static serving that reads the same paths from disk under `deno run` and from Deno's virtual filesystem when `assets/` is embedded with `--include assets`.
- Removed the inline brand SVG/data URL from `mrmcp.js`; the GUI header and favicon now reference `assets/mrmcp-logo.svg`, while the native window title remains **🧩 MrMCP**.
- Moved README screenshots into `assets/` and kept them separate from the logo assets.
- Recompiled the Windows executable with `--include assets --icon assets/mrmcp.ico`.
- No SQLite schema change.

## 0.10.51

- Centralized Session root assignment on the Roots page: **📁 Roots** appear on the left with their associated Sessions, while **💬 Sessions / No root assigned** appears on the right; Session items show creation and last-access timestamps.
- Added bidirectional drag-and-drop assignment between the Default root and named roots, plus direct root-to-root reassignment; Deno remains authoritative and the browser transports only the Session PK and target root id.
- Removed the root selector from Sessions; the current root label and path remain visible there as read-only information.
- Updated the sidebar labels/order to **Clients**, **Sessions**, **Roots**, **Tool Calls**, **Commands**, **HTTP Log** and compacted the Commands table actions vertically.
- No SQLite schema change.

## 0.10.50

- Moved OAuth clients directly below Dashboard in the sidebar.
- Added a Session count to each OAuth client row and a **View sessions** action that opens Sessions filtered by that OAuth `client_id`; the filter remains visible until cleared.
- Changed GUI date formatting so timestamps from the current local day show only the time, while older/future dates keep their calendar date and existing relative-age suffixes remain unchanged.

## 0.10.49

- Added best-effort creation-client metadata to Sessions: authentication kind, OAuth client id/name when available, and User-Agent. Model and thinking/reasoning level are intentionally not inferred because MCP does not reliably expose them.
- Added a Sessions continuity notice explaining that changing ChatGPT model or thinking level may create a new MCP context even inside the same conversation.
- Added a Help section with ChatGPT Web Developer-mode, custom MCP app, OAuth, tool-scan and write-action setup guidance.
- Moved Tool calls directly below Sessions in the sidebar and retained the one-click per-Session filtered Tool-call view.
- Updated the clean SQLite table shape for creation-client metadata; incompatible development databases needed to be recreated.

## 0.10.48

- Added a numeric primary key to every GUI Session while preserving the opaque `ctx_...` capability for MCP protocol calls.
- Stored the Session PK on Tool-call and process rows so logs keep a stable short identifier even after a Session is deleted.
- Changed the Sessions table, Tool-call Session column and Session filter to show the numeric PK instead of the long handle or generic `context` label.
- Renamed the root-id-0 selector option to **Default root**.
- Removed the Tool-call Search button; text, Session, status and page-size filter changes now refresh automatically through the existing Deno-owned render pipeline.
- Updated the clean SQLite table shape for numeric Session and Tool-call identifiers.

## 0.10.47

- Reduced the public tool-result envelope to the required `context_handle` plus tool-specific fields.
- Removed redundant `context_status`, `operation_executed`, `retry_required`, `recovery_tool` and recovery `message` fields; errors now use `isError: true` and one `error` string.
- Removed public `execution_log_id` values while retaining complete internal administration logs.
- Removed `agent_guidance_present`; a nullable `agent_guidance_path` now expresses both presence and location.
- Replaced the internal GUI context status string with a direct `expired` boolean.
- Removed constant success flags and array-length duplicates from `create_directory`, `delete_path`, `glob`, `grep` and `replace` results.

## 0.10.46

- Replaced `get_cwd` with `context_info`, which returns the current absolute root and the optional root-level `AGENTS.md` / `agents.md` guidance path.
- Directed agents to call `context_info` after context creation and root changes, then read and follow `agent_guidance_path` when present.
- Added explicit tool-specific output schemas instead of one permissive generic result schema.
- Expanded `glob`, `grep` and `replace` with exclusions, hidden/dependency traversal, file-size and encoding controls; `replace` also gained an exact `expected_replacements` guard.
- Updated tool descriptions and server instructions to prefer structured file tools and avoid shell, `uv` or Python for covered operations.

## 0.10.45

- Replaced `server_opaque` with the public bearer capability `context_handle` and added `create_context`.
- Removed authenticated-client ownership from contexts, processes and JavaScript kernels; possession of a valid handle selects the context after authentication.
- Replaced the MCP `workspace` tool with the minimal `get_cwd` tool. Root assignment remains exclusively in the Sessions/Roots administration UI.
- Made each context reference exactly one current `root_id`, freely reassignable; a root may serve many contexts and existing processes are left untouched when the assignment changes.
- Scoped lazy persistent JavaScript kernels by context and root.
- Replaced `list_files`, `search_files`, `edit_file`, `edit_files` and `replace_files` with `glob`, `grep`, `edit` and `replace`.
- Fixed multi-edit semantics: ordered edits for the same file are now applied to one in-memory document and all files are committed atomically with rollback.
- Added root snapshots to tool-call and process logs and updated the corresponding clean SQLite table shapes.

## 0.10.43

- Expanded `AGENTS.md` with the full UI-state design rationale and failure mode that motivated the architecture.
- Made explicit that every visible state transition, including navigation and row expansion, is Deno-owned and Eta-rendered.
- Documented normalized user/backend event handling, primary-key-based expanded rows, lazy section-scoped queries and the single throttled asynchronous render queue.
- Added release checks that reject imperative browser UI state and inactive-section data loading.

## 0.10.42

- Moved every ephemeral graphical state value from the WebView into the Deno backend.
- Replaced browser-side `globalThis.mrmcpUiState`, `/api/state` and `/api/render` calls with a WebSocket input channel and an SSE HTML output channel.
- Added a single sequential Deno input dispatcher for navigation, forms, filters, pagination, expanded rows, dialogs, focus and scroll.
- Added a throttled/coalescing asynchronous render queue; backend and MCP events use the same queue.
- Changed the WebView into a thin event sender and Morphlex HTML receiver.
- Made confirmations and error messages server-owned Eta dialogs.

## 0.10.41

- Added a real global ephemeral UI state object.
- Restored the missing unified `dispatchUiEvent` implementation that prevented sidebar navigation.
- Moved current section, filters, pages, expanded row primary keys, dialogs and self-test output into the state object.
- Eta now conditionally renders only the current section; Morphlex applies every UI transition.
- Added section-specific server projections so inactive pages do not query their tables.
- Moved expanded Tool call and HTTP details from imperative DOM insertion into Eta templates.
- Expanded README and AGENTS documentation, including the MCP 2026-07-28 stateless rationale.

## 0.10.40

- Added a restrained emoji vocabulary for faster visual scanning.

## 0.10.39

- Removed experimental root drag-and-drop and diagnostics.
- Restored conventional root creation, editing, enable/disable and deletion.

## 0.10.38

- Reduced the initial desktop window to 1180×760.

## 0.10.37

- Standardized visible branding as **MrMCP** and added the 🧩 header/window icon.

## 0.10.36

- Replaced GUI polling with SSE-driven Eta → Morphlex updates.

## 0.10.35

- Renamed the operator view to Sessions.
- Removed the global default-root option; unassigned values use the `mrmcp.js` directory.

## 0.10.34

- Returned the desktop launcher to direct `@webview/webview` after superseded Tauri and Neutralino experiments.

## 0.10.32–0.10.33 — superseded experiments

- Explored Neutralino-based desktop shells; fully removed in 0.10.34.

## 0.10.29 — superseded experiment

- Explored a Tauri v2 desktop shell; fully removed in 0.10.34.

## 0.10.30–0.10.31

- Replaced transport-derived session identity with explicit tool arguments for the stateless protocol.
- Stabilized the final field name as `context_handle` and removed “context” terminology from agent-facing schemas.

## 0.10.28

- Removed tool-call approvals and every associated queue, state and database field.
- Removed `allow_re` and `deny_re`; authentication became the only tool-access boundary.

## 0.10.27

- Added session-oriented administration, root assignment, tool-call pagination and termination controls.
- Added encoding, BOM and line-ending controls to text tools.
- Added the system-PATH process setting.

## 0.10.24–0.10.26

- Added relative ages beside log timestamps.
- Consolidated to one `/mcp` endpoint.
- Introduced early session/root and event-log improvements that were later adapted to explicit opaque handles.
