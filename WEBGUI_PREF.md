# Server-authoritative Web GUI preferences

## Purpose and scope

This document defines a portable architecture for a server-rendered administration GUI that runs in a standards-based browser surface. It deliberately does not depend on a backend programming language, process model, desktop shell, native bridge or network transport.

In this document:

- **backend** means the authoritative application side, regardless of where or how it runs;
- **frontend** means the browser document and its small runtime;
- **adapter** means the optional transport/host layer between them;
- **render** means a complete current HTML snapshot of the application root;
- **intent** means a normalized description of user input, never a direct domain mutation;
- **durable state** means persisted application data;
- **UI state** means navigation, drafts, filters, pages, open rows, dialogs, validation, notices, focus and scroll.

The central rule is:

> The backend owns application state and UI state. The frontend owns only the live DOM and short-lived browser mechanics needed to observe input, deliver intents and apply renders.

This is not a client-side application with a server API. It is a server-authoritative GUI whose HTML is reconciled into a long-lived DOM with Morphlex.

## Architectural flow

```text
durable/runtime state ──> active-view projection ──> escaped template
                                                        │
                                                        v
                                                RenderEnvelope(revision, HTML)
                                                        │
                                                latest-snapshot channel
                                                        │
                                                        v
live DOM <── Morphlex morph <── frontend revision gate <─┘
   │
   └── delegated browser events ──> normalized InputEnvelope
                                            │
                                     ordered intent channel
                                            │
                                            v
                                sequential backend input reducer
                                            │
                              state/action/validation mutation
                                            │
                                            └──> mark render dirty
```

There is one logical state machine. The browser is its input/output terminal, not a second implementation of it.

## Responsibility boundaries

### Backend

The backend must own:

- durable records, configuration, files and other domain data;
- live runtime data and subscriptions;
- the complete authoritative `uiState`;
- the current section and subpage;
- filters, pagination, sorting and expanded-row identifiers;
- form and settings drafts after input delivery;
- dialog kind, payload and open/closed state;
- field warnings, form warnings and Save eligibility;
- notice balloons and their dismissal timers;
- last reported focus/caret and per-section scroll coordinates;
- visibility-aware dirty state;
- active-view data projection and all administrative queries;
- business rules, authorization and final validation;
- every mutation and native/application action;
- template execution and HTML escaping;
- render scheduling, cancellation, generation and revision numbers.

Why: these values must survive unrelated data changes and renders, must be consistent with domain state, and must not be split across two competing reducers.

### Frontend

The frontend may own only browser-mechanical state:

- the live DOM;
- the value currently visible in a form control before its input envelope arrives at the backend;
- pending input items keyed by control id;
- short debounce timers;
- the ordered outbound send queue;
- the last applied render revision;
- the actual current focus, caret and scroll position before reporting them;
- temporary `DataTransfer` content during a drag;
- clipboard interaction and its fallback textarea;
- transient instances of progressive-enhancement widgets such as a JSON tree editor;
- animation and hover state that has no semantic consequence.

These are transport or browser facts, not application state. The frontend must not contain an application-state store, business reducer, administrative data cache or client-side copy of backend rules.

### Adapter or host

An adapter is optional. When present, it should own only:

- transport binding and message routing;
- browser lifecycle/readiness;
- actual window or page visibility information;
- native services that a browser cannot perform directly;
- one in-flight render delivery plus one newest pending render;
- conversion of host events, such as a native directory drop, into ordinary normalized input.

It must not own filters, dialogs, drafts, projections, business validation or HTML composition. Host-specific event names and APIs end at this boundary.

## State ownership matrix

| State | Authoritative owner | Frontend copy, if any | Reason |
| --- | --- | --- | --- |
| Domain records and configuration | Backend, persisted as appropriate | Rendered representation only | One source of truth |
| Live processes/activities | Backend runtime | Rendered representation only | The browser must not infer lifecycle |
| Current section/subpage | Backend `uiState` | `data-section` for event context only | Navigation must survive renders and external mutations |
| Filters, page and sort | Backend `uiState` | Current form-control properties | Queries and result identity stay consistent |
| Expanded row/dialog | Backend `uiState`, keyed by stable domain id | Corresponding rendered nodes | Row order and pagination may change |
| Form/settings draft | Backend after every delivered input | Newest unsent control property | Morphing must not erase active typing |
| Validation | Backend | Rendered warning/disabled state | Client hints are never authoritative |
| Notice balloon | Backend plus one-shot timer | Rendered node | Errors from any source follow one path |
| Focus/caret | Backend stores last report/desire | Browser owns current physical focus | A surviving active control must win over stale metadata |
| Scroll | Backend stores per view | Browser owns current physical position | A render can restore view continuity |
| Dirty/generation/revision | Backend | Last accepted revision only | Prevent stale work and stale DOM application |
| Input debounce/send queue | Frontend | N/A | Reduce bridge traffic without changing semantics |
| Render delivery pending slot | Adapter or delivery boundary | N/A | Intermediate snapshots are disposable |
| Enhanced widget instance | Frontend, transient | Canonical value mirrored into a managed form field | Imperative widgets must not become data owners |

The temporary overlap for form values is intentional. The backend is authoritative once an input is delivered; until then, Morphlex `preserveChanges` protects the user's newer browser value from an older rendered default.

## Channel contract

The implementation needs an asynchronous, bidirectional message channel. It may be an in-process event bus, IPC, `postMessage`, WebSocket or another bridge. The concrete transport is irrelevant if it preserves the following semantics.

### Frontend to backend: ordered intent stream

This direction is **ordered, lossless during a live connection and at-most-once for semantic actions**.

- Inputs are processed in the exact order emitted.
- A semantic action must not overtake pending text input.
- Failed mutating intents must not be retried blindly, because duplicate delivery may duplicate the action.
- The frontend serializes sends through one queue.
- The backend serializes handling through one queue and does not add a second coalescing layer.
- Payloads must be structured-clone-safe or JSON-serializable and must never contain DOM nodes.

A representative envelope is:

```json
{
  "event": {
    "type": "action",
    "action": "delete-row",
    "dataset": { "id": "42" },
    "values": { "query": "draft visible in the current scope" },
    "focus": { "id": "query", "start": 5, "end": 5 },
    "viewport": { "section": "items", "x": 0, "y": 420 }
  }
}
```

Use intent types such as:

- `bootstrap`;
- `navigate`;
- `inputs` for a batch of text/control drafts;
- `change` for committed control changes;
- `blur` when validation depends on leaving a field;
- `focus`;
- `scroll`;
- `submit` with the complete current form values;
- `action` with a semantic `data-action` name and compact dataset;
- normalized host inputs such as `native-drop`.

The event schema should be explicit and validated on the backend. Element ids and `data-*` values are selectors, not authority: the backend must re-check record existence, allowed transitions and submitted values.

### Backend to frontend: revisioned snapshot stream

This direction is **latest-snapshot, monotonic and safely lossy**. Intermediate renders may be discarded because each render is a complete current snapshot.

A representative envelope is:

```json
{
  "revision": 184,
  "html": "<div id=\"app\" data-section=\"items\">...</div>",
  "section": "items",
  "scroll": [0, 420],
  "scroll_target": "item-row-42",
  "focus": { "id": "query", "start": 5, "end": 5 },
  "reason": "item-updated",
  "at": 1787560000000
}
```

Required semantics:

- `revision` increases for every delivered render;
- `html` contains exactly one application-root element with the same tag as the live root;
- `section` is explicit because an inner morph does not update the outer root's attributes;
- `scroll_target`, when present, takes precedence over coordinates;
- `reason` and `at` are diagnostic, not state inputs;
- the adapter may drop an older pending render in favor of a newer one;
- the frontend rejects any revision that is not newer before starting Morphlex.

Do not transport domain JSON for the frontend to render. Do not make the browser issue administrative JSON fetches. If internal API/service handlers are useful for code reuse, call them behind the authoritative boundary and pass their results into the server-side projection/template pipeline.

### Bootstrap

Bootstrap order is important:

1. load the stable shell document and browser runtime;
2. register the render listener;
3. only after registration succeeds, send `bootstrap`;
4. mark the frontend connected on the backend;
5. produce one fresh render from current state.

Lifecycle interception or host setup must be independent from this chain. A failure in an unrelated host listener must not prevent the GUI render handshake.

### Visibility

When reliable visibility information exists, hidden or minimized UI must not trigger data projection, template execution, HTML construction or render delivery.

- Domain and UI state continue to update.
- Every relevant mutation still marks the render dirty.
- Losing visibility invalidates work already being built.
- Pending rendered HTML may be dropped.
- Regaining visibility requests exactly one fresh current-state synchronization.
- Never treat resize/focus/blur events themselves as proof of visibility; query or receive the actual visibility state.

This reduces needless database work, HTML allocation and DOM churn while preserving correctness.

## Frontend runtime rules

### One stable root

Keep one long-lived root, conventionally `#app`. Render a minimal loading shell initially, then reconcile only the root's children.

The browser runtime and global delegated listeners are installed once outside the morph lifecycle. Rendered HTML must not contain runtime scripts or inline event handlers.

### Event delegation

Listen at document/root level and resolve behavior through stable attributes:

- `[data-page]` for navigation;
- `[data-action]` for semantic actions;
- stable control `id` values for input/change/blur/focus;
- `[data-session-drag]` and `[data-root-drop]`, or equivalent semantic markers, for drag transport;
- form ids for submits.

Delegation is mandatory because Morphlex may add, move or replace rendered nodes. Per-node listeners would be lost or duplicated.

For an action, collect values from the nearest relevant form/section when the action needs the current draft. For submit, collect every named managed control in the form. Checkboxes send booleans; other controls send strings unless the event contract explicitly says otherwise.

### Input ordering and coalescing

Only noisy observational input may be coalesced in the frontend:

| Input | Baseline behavior |
| --- | --- |
| Text/control `input` | Debounce about 60 ms; merge by stable control id; send one `inputs[]` batch |
| Scroll | Debounce about 80 ms; latest coordinates win |
| Focus | Latest may replace an adjacent unsent focus envelope |
| Repeated pending `inputs`/focus/scroll | Latest-wins only while still in the frontend queue |
| Action/change/blur/submit/navigation/Enter | Ordered barrier; flush pending inputs first; never coalesce |

Calling the semantic send path must enqueue the pending input batch before the semantic event. This preserves the user's last keystroke before Save, navigation or another action.

The backend must receive and process every resulting envelope sequentially. It may debounce an expensive render or query caused by those inputs, but it must not reorder or merge the input semantics again.

### Allowed local effects

The frontend may perform effects that are inherently browser-local and do not change application meaning:

- copy already-rendered text to the clipboard;
- provide a temporary textarea fallback for clipboard access;
- populate/read `DataTransfer` during drag-and-drop;
- prevent default browser form submission or drop behavior;
- apply focus, selection and scroll after a morph;
- instantiate/destroy a presentation-only widget;
- run CSS hover/transition/animation effects.

Everything else travels as an intent. In particular, navigation, filtering, row expansion, modal state, deletion, native opening and business replay actions must not be implemented as imperative DOM changes.

## Morphlex contract

Use the vendored `morphlex.js` through its public API. Do not patch the third-party source for application behavior; adapt application markup and lifecycle around it.

The normal application operation is exactly:

```js
morphInner(appRoot, renderedRootHtml, { preserveChanges: true });
```

Do not add lifecycle callbacks, custom form snapshots, replay layers or another virtual-DOM/state reconciliation wrapper around the morph.

### Important `morphInner` behavior

- A string target must parse to exactly one element.
- The live root and rendered root must have the same tag name.
- Only child nodes are reconciled; outer-root attributes are not. Synchronize required root metadata, such as `data-section`, from explicit render-envelope fields after the morph.
- The morph is synchronous and non-preemptible. Once started, let it finish in the current JavaScript turn.
- Revision rejection must happen before entering the morph.
- `preserveChanges: true` protects user-modified input values, checkbox/radio checked state, option selection and textarea values when a render carries an older default.
- Structural removal/replacement still follows normal browser behavior; preservation is not permission to retain nodes absent from authoritative HTML.
- Whitespace-only text nodes are not stable identity and may be removed/recreated.

Morphlex preferentially reconciles equal nodes and elements with stable ids, including id-bearing descendants. It can fall back to matching by `name`, `href`, `src`, tag and compatible input type, and it minimizes moves when reordering. Treat those fallbacks as convenience, not as entity identity.

Therefore:

- every repeated logical entity must have a globally unique, stable DOM id derived from its immutable domain key;
- compact row and expanded detail ids must use the database/domain primary key, never the current array index;
- pagination and live inserts must not reuse an unrelated row's id;
- keep the same tag and input type for a surviving logical control;
- do not generate duplicate ids;
- do not rely on sibling order alone when rows can be inserted, filtered or reordered.

### Progressive enhancement widgets

Imperative widgets are allowed only as disposable enhancement over managed markup.

Before a morph:

1. destroy every widget instance cleanly;
2. leave its canonical value in a normal managed field.

After a morph:

1. locate rendered enhancement hosts;
2. parse the managed source field;
3. recreate the widget;
4. on edits, serialize back to the managed field and use the normal input queue;
5. show parse errors without discarding the original draft.

The widget never becomes the source of truth. Switching representations must preserve the draft byte-for-byte unless the user explicitly edits it.

## Backend input reducer

Process input envelopes one at a time.

For every envelope:

1. capture reported focus/caret when present;
2. capture the viewport coordinates for the reported section;
3. update affected drafts before awaiting domain work;
4. interpret the semantic intent;
5. validate identifiers and values;
6. perform any authorized action;
7. update UI state and mark affected render scopes dirty;
8. expose failures through the ordinary notice/dialog rendering path.

If an event triggers asynchronous work, do not start processing the next event until the current intent has reached a defined state boundary. Render requests raised during one input may be deferred until that input completes so the browser never sees a half-reduced UI state.

The reducer must not manipulate the DOM, emit JavaScript commands to toggle classes or instruct the frontend how to implement business behavior.

## Render scheduler

### Dirty scopes

Every domain mutation must declare the views it affects. Queue a render only when the affected scope includes the active section or shared shell state.

Examples of shared shell state include header activity, global notices, dialogs and connection status. A change in an inactive, unrelated section remains data-only until that section becomes active.

### Lazy projection

Build only the active section's projection. Inactive sections must not issue section-specific database queries, filesystem scans or service calls during a render.

The recommended pipeline is:

1. read minimal shared shell state;
2. clone/project authoritative UI state for templating;
3. query only active-section data;
4. clamp page/filter selections authoritatively;
5. render section fragments;
6. compose the complete root HTML;
7. perform a final generation/visibility check;
8. assign a new delivery revision and emit.

### Generation cancellation

Increment a render generation every time the view is dirtied, even when another render is already running. At the start and after every asynchronous boundary, verify that:

- the UI is still render-visible;
- the generation is still current.

Abort obsolete projection/template pipelines rather than finishing HTML that cannot be used. Never render concurrently. When the current attempt ends, immediately process the newest dirty generation.

### Coalescing and backpressure

A short render throttle of roughly 18 ms is a useful baseline for ordinary bursts. Draft-validation renders may use roughly 40 ms. Expensive text-filter renders may use a separate delay around 220 ms, and very noisy diagnostic/runtime activity may be scope-throttled around 180 ms.

Correctness does not depend on these exact timings; it depends on generation cancellation and ordered input.

Across the final delivery boundary:

- allow one render delivery in flight;
- retain at most one pending render;
- replace that pending render with the newest complete snapshot;
- discard pending delivery when visibility is lost;
- keep the backend dirty so visibility restoration builds a fresh snapshot.

## Focus and scroll continuity

Every normalized event should include the current focus id, selection start/end when supported, active section and viewport coordinates.

Special rules:

- `focusout`/blur includes the next focus target derived from `relatedTarget`;
- the backend stores scroll per section;
- navigation may request an explicit stable `scroll_target`;
- after morph, wait until layout is available, then prefer `scroll_target`, otherwise restore coordinates;
- before applying deferred focus/scroll, confirm the render revision is still current;
- if a connected, enabled form control already has focus after morph, preserve it and its caret;
- only apply backend focus metadata when no surviving active editable control owns focus;
- removed/replaced controls follow normal browser focus behavior.

This prevents a validation render from moving the caret backward or stealing focus from the control the user entered next.

## Forms and validation

- Keep drafts in backend UI state so unrelated domain renders cannot reset fields.
- Update drafts on input before scheduling a render.
- Use cheap syntactic validation during editing only when it improves feedback.
- Run filesystem/network/existence checks on blur rather than on every keystroke.
- Render field warnings inline beside the relevant field.
- Render Save disabled while known-invalid or not-yet-checked state blocks submission.
- Do not rely on browser-native validation bubbles.
- Re-run all authoritative validation on submit; a disabled button is only presentation.
- Keep a form-level warning for operational conflicts returned by the backend.
- Never discard invalid drafts merely because parsing failed.

Settings with several visual tabs should retain all managed controls in the rendered form, hide non-selected cards declaratively, and use one backend-owned draft plus one Save. Tab selection belongs to backend UI state; the browser must not toggle tab classes or `hidden` state as application logic.

## Dialogs, confirmations and notices

Dialog visibility is declarative:

- backend state selects dialog kind and data;
- the template emits an overlay plus an already-open dialog element;
- closing, cancelling, confirming and Escape send intents;
- the next render removes the dialog.

Do not use `alert()`, `confirm()`, `showModal()`, imperative `show()`/`close()` or browser-owned modal state.

Confirm dialogs only confirm. After Confirm, close them immediately in backend UI state; long-running work reports completion/failure through a non-modal notice balloon.

Generic operational errors use the same backend-owned notice path, not an error modal. Useful baseline lifetimes are 6.5 seconds for errors, 5 seconds for information and 3 seconds for success; timers are one-shot and render their own dismissal without browser polling.

## Lists, tables, filters and live data

- Page, page size, filters, sorting and expanded detail are backend-owned.
- Page numbers are clamped against the current result set on the backend.
- A filter change normally returns to page 1.
- Expanded detail is keyed by stable domain primary key and closes only when that key is no longer present/allowed.
- Generic search and field-specific search remain separate when their meanings differ; combine them authoritatively.
- A live insert must not replace, collapse or expand an unrelated row during reconciliation.
- Query only the visible section and only the open detail required by that section.
- Domain changes, process output and service events enter the same scoped render queue.
- Do not add browser polling, periodic refresh, a manual Refresh path, client countdowns or query-string UI state.
- Time-based presentation changes that affect content use backend-owned one-shot timers; pure CSS fading may remain presentational.

## Drag-and-drop

Browser drag handling transports only compact stable identifiers. It must not move visible nodes imperatively.

The backend validates the source id and target id, performs reassignment, updates authoritative state and returns the resulting layout through the normal render path. A native/host drop is normalized into the same input reducer rather than creating a second mutation path.

## Template, HTML and security rules

- Render dynamic data with automatic HTML escaping by default.
- Mark trusted raw HTML explicitly and narrowly.
- Never interpolate unescaped user/domain strings into HTML, attributes or hidden form values.
- Keep runtime JavaScript static; rendered snapshots contain markup, not executable application code.
- Use `data-action`/`data-page` instead of inline handlers.
- Do not load essential GUI code or styles from a CDN at runtime; vendor the minimal required assets and licenses.
- Keep raw secrets and request headers out of the render model unless a specific managed secret field intentionally needs them.
- Treat the render channel as privileged. If it crosses a network boundary, add the authentication, origin and request-forgery protections appropriate to that transport.
- Frontend affordances are not authorization. Validate every action on the backend.

## Presentation preferences

- Use consistent Title Case for headings, action buttons and dialog titles.
- Use sentence case for field labels and ordinary body prose.
- Keep explanatory copy short and operational: say what the control does and the user-visible consequence.
- Keep selected navigation labels on one line where practical.
- Use semantic status colors consistently and never rely on color alone; include text, icon or status label.
- Render inline field errors near the field and generic errors as a small non-modal balloon.
- Keep responsive layout in CSS, not in browser-owned application state.
- Preserve native semantics for forms, buttons, tables, focus and keyboard input.

## What must not be in the frontend bundle

The frontend bundle must contain no:

- application-state object or domain cache;
- business logic or authorization rules;
- administrative JSON fetch layer;
- client-side router or query-string state;
- polling interval, auto-refresh or countdown state;
- optimistic domain mutation;
- imperative navigation/filter/tab/dialog/row-expansion DOM logic;
- duplicate validation implementation presented as authoritative;
- custom virtual DOM or form replay wrapper around Morphlex;
- hidden mapping from row position to entity identity;
- direct native filesystem/process/service mutation.

## Failure behavior

- Input transport failures are observable in diagnostics; do not silently pretend the action succeeded.
- Do not blindly replay semantic actions after an ambiguous transport failure.
- A render-build failure may emit a minimal escaped error snapshot using the normal revisioned render channel.
- A stale render is not an error; discard it and build the newest generation.
- A stale/out-of-order delivered revision is not an error; the frontend ignores it.
- Widget parse failure leaves the raw managed source visible and editable.
- Backend action/validation failure updates dialog/form state or emits a notice, then rerenders.

## Verification checklist

1. The render listener is installed before `bootstrap` is sent.
2. A navigation click crosses the input channel, changes backend UI state, queues a render and returns through the render channel.
3. The frontend bundle has no application store, business reducer, polling or administrative fetches.
4. Every input envelope is handled sequentially on the backend.
5. Pending text input is queued before action/change/blur/submit/navigation barriers.
6. Drafts update before unrelated backend renders.
7. Only the active section issues section-specific queries.
8. Every dirty request increments generation, including requests received during a render.
9. Stale projection/template work aborts at its next asynchronous boundary.
10. Render construction never runs concurrently.
11. Delivery has one in-flight render and only one newest pending snapshot.
12. The frontend rejects non-newer revisions before morphing.
13. `morphInner` is called unmodified with only `{ preserveChanges: true }`.
14. The rendered string contains one root element with the same tag as the live root.
15. Required outer-root metadata is synchronized explicitly after the inner morph.
16. Stable domain ids key repeated rows and expanded details; array positions never do.
17. Live inserts and pagination do not transfer open state to unrelated rows.
18. A surviving active form control keeps focus, selection and its newer value.
19. A blur-triggered validation render does not steal focus from the next control.
20. Scroll is restored per section or through a stable explicit target.
21. All dialogs are driven by rendered open state; Escape only sends a close intent.
22. Inline warnings disable Save declaratively, and submit repeats validation.
23. Generic failures appear through the backend-owned non-modal notice path.
24. Drag-and-drop transports ids and makes no visible DOM mutation.
25. Enhanced widget content is mirrored into a managed field before ordinary input delivery.
26. Hidden/minimized state suppresses projection, templating and delivery while retaining dirty state.
27. Visibility restoration produces one fresh current-state render.
28. Domain/runtime mutations enter the same scoped render queue as user inputs.
29. Dynamic template values are escaped and rendered snapshots contain no inline application handlers.
30. Essential GUI assets work offline without runtime CDN access.

## Decision rule for new features

When adding a feature, ask where its truth must live.

- If it affects data, permissions, navigation, filtering, validation, dialog state, actions or what HTML should exist, it belongs on the backend.
- If it only observes browser input, buffers delivery, applies a revisioned morph, restores caret/scroll or performs an inherently local browser effect, it belongs on the frontend.
- If it only connects runtimes, reports actual visibility or exposes a native primitive, it belongs in the adapter.

If both frontend and backend would need to independently understand the same application transition, the boundary is wrong: send a smaller intent to the backend and render the resulting state once.
