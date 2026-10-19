// Injected into the isolated backend by check.mjs. No real account/profile is used.
const goalVm = await import("node:vm");
{
  const destination = join(APP_DIR, "exported-cdp-ext");
  const source = join(
    dirname(Bun.resolveSync("@mefistofelix/cdp.js", runtimePackageDirectory || MODULE_DIR)),
    "cdp_ext",
  );
  const before = cdpReverseClient;
  const exported = await uiOperation("cdp/export-extension", { path: destination });
  check(
    exported.path === destination &&
      !exported.confirmation_required &&
      (await fs.readFile(join(destination, "cdp_ext.js"))).equals(
        await fs.readFile(join(source, "cdp_ext.js")),
      ) &&
      (await fs.readFile(join(destination, "manifest.json"))).equals(
        await fs.readFile(join(source, "manifest.json")),
      ) &&
      cdpReverseClient === before,
    "GUI export copies the exact public package extension files without opening Chrome, including standalone extraction",
  );
  await writeFile(join(destination, "cdp_ext.js"), "local extension edit");
  const confirmation = await uiOperation("cdp/export-extension", { path: destination });
  check(
    confirmation.confirmation_required &&
      (await readTextFile(join(destination, "cdp_ext.js"))) === "local extension edit",
    "exporting an existing extension asks for confirmation before changing any file",
  );
  await writeFile(join(destination, "operator-notes.txt"), "keep");
  await uiOperation("cdp/export-extension", { path: destination, overwrite: true });
  check(
    (await fs.readFile(join(destination, "cdp_ext.js"))).equals(
      await fs.readFile(join(source, "cdp_ext.js")),
    ) && (await readTextFile(join(destination, "operator-notes.txt"))) === "keep",
    "confirmed extension update retains the stable folder and unrelated operator files",
  );
  const unrelated = join(APP_DIR, "unrelated-extension-folder");
  await fs.mkdir(unrelated);
  await writeFile(join(unrelated, "keep.txt"), "keep");
  let refused = false;
  try {
    await uiOperation("cdp/export-extension", { path: unrelated, overwrite: true });
  } catch {
    refused = true;
  }
  check(
    refused && (await fs.readdir(unrelated)).join() === "keep.txt",
    "extension export refuses an unrelated nonempty folder even with overwrite confirmation",
  );
  const previous = uiState.cdpExtensionDirectory;
  try {
    await handleUiInput({ type: "input", id: "cdpExtensionDirectory", value: destination });
    await handleUiAction({ action: "export-cdp-extension" });
    check(
      uiState.cdpExtensionDirectory === destination &&
        uiState.dialog?.confirmAction === "export-cdp-extension",
      "native export input/action opens the ordinary confirmation for an existing folder",
    );
    await uiRunConfirmedAction(uiState.dialog);
    uiState.dialog = null;
  } finally {
    uiState.cdpExtensionDirectory = previous;
  }
}
{
  const system = cdpConfiguredOptions(
    cdpBrowserSpec({ name: "bootstrap-system", cdp_ext: true }),
    null,
  );
  check(
    system.user_data_dir === null &&
      system.cdp_ext_install === false &&
      system.login &&
      system.translations,
    "cdp_ext defaults to the external system profile with manual installation and normal browser integration",
  );
  const custom = cdpConfiguredOptions(
    cdpBrowserSpec({
      name: "bootstrap-custom",
      cdp_ext: true,
      user_data_dir: "custom-profile",
    }),
    null,
  );
  check(
    custom.user_data_dir === join(APP_DIR, "custom-profile") && custom.cdp_ext_install === true,
    "an explicit custom profile defaults to public managed extension installation",
  );
  check(
    cdpConfiguredOptions(
      cdpBrowserSpec({
        name: "bootstrap-manual",
        cdp_ext: true,
        user_data_dir: "custom-profile",
        cdp_ext_install: false,
      }),
      null,
    ).cdp_ext_install === false,
    "manual extension installation remains selectable for a custom profile",
  );
  const manual = cdpConfiguredOptions(
    cdpBrowserSpec({
      name: "bootstrap-repeat",
      cdp_ext: true,
      user_data_dir: "custom-profile",
      cdp_ext_install: false,
    }),
    null,
  );
  check(
    cdpConfiguredOptions(
      cdpBrowserSpec({
        name: "bootstrap-repeat",
        cdp_ext: true,
        user_data_dir: "custom-profile",
      }),
      manual,
    ).cdp_ext_install === false,
    "repeating the same custom profile cannot implicitly re-enable extension installation",
  );
  let refused = false;
  try {
    cdpConfiguredOptions(cdpBrowserSpec({ name: "invalid-install", cdp_ext_install: true }), null);
  } catch {
    refused = true;
  }
  check(refused, "extension installation cannot accidentally activate on a direct CDP launch");
  check(
    cdpConfiguredOptions(cdpBrowserSpec({ name: "a".repeat(32), reverse: true }), null)
      .extension_id === "a".repeat(32),
    "passive attachment can use its native extension ID as the logical name without an empty route",
  );
}
{
  const enabled = getCfg("chat_goals_enabled", "1");
  const first = await createContext(p);
  const second = await createContext(p);
  const chatId = "12345678-aaaa-bbbb-cccc-123456789abc";
  try {
    await setCfg("chat_goals_enabled", "1");
    const direct = await call("chat_set_goal", {
      chat_session: first.handle,
      goal: "Explicit fixture",
      timeout_seconds: 45,
      chatgpt_chat_id: chatId,
    });
    check(
      direct.chatgpt_chat_id === chatId &&
        direct.status === "ready" &&
        direct.next_check_at >= Date.now() + 40000 &&
        !cdpBrowsers.has(CHAT_GOAL_BROWSER),
      "an explicit conversation ID bypasses matching and schedules the full idle interval without opening Chrome",
    );
    const retained = await setChatGoal(first, "Retained fixture", 60);
    check(
      retained.chatgpt_chat_id === chatId && retained.status === "ready",
      "omitting the ID retains even an association newer than the caller's context snapshot",
    );
    const before = await one("SELECT * FROM contexts WHERE id=?", first.id);
    let rejected = false;
    try {
      await setChatGoal(first, "Invalid fixture", 30, "https://chatgpt.com/c/invalid");
    } catch {
      rejected = true;
    }
    check(
      rejected &&
        (await one("SELECT goal_revision FROM contexts WHERE id=?", first.id)).goal_revision ===
          before.goal_revision,
      "invalid manual IDs fail without modifying a saved goal",
    );
    await setChatGoal(second, "Replacement fixture", 30, chatId);
    check(
      !(await one("SELECT goal_text FROM contexts WHERE id=?", first.id)).goal_text,
      "explicit IDs preserve one active goal per conversation across Sessions",
    );
    const cleared = await setChatGoal(second, "", 30);
    check(
      cleared.status === "disabled" && cleared.chatgpt_chat_id === chatId,
      "clearing a goal retains its explicit conversation association",
    );
    await setCfg("chat_goals_enabled", "0");
    const disabled = await setChatGoal(first, "Disabled fixture", 30, "abcdefgh-1234");
    check(
      disabled.status === "disabled" && disabled.chatgpt_chat_id === chatId,
      "globally disabled setting does not change the explicit association",
    );
  } finally {
    await run("DELETE FROM contexts WHERE id IN (?,?)", first.id, second.id);
    await setCfg("chat_goals_enabled", enabled);
  }
}
function goalReactFixture(chatId, handle, options = {}) {
  const history = {
    conversation_id: chatId,
    current_node: "call",
    mapping: {
      user: {
        id: "user",
        parent: null,
        message: {
          id: "user",
          author: { role: "user" },
          content: { content_type: "text", parts: ["Fixture question"] },
        },
      },
      call: {
        id: "call",
        parent: "user",
        message: {
          id: "call",
          author: { role: "assistant" },
          recipient: "api_tool.call_tool",
          status: "finished_successfully",
          content: {
            content_type: "code",
            text: JSON.stringify({
              path: "/MrMCP/link_fixture/chat_set_goal",
              args: { chat_session: handle, goal: "SECRET_FIXTURE_ARGUMENT" },
            }),
          },
        },
      },
    },
  };
  const query = { queryKey: ["chatgpt-conversation", chatId], state: { data: history } };
  const unrelated = { queryKey: ["session"] };
  Object.defineProperty(unrelated, "state", {
    get() {
      throw Error("Credentials must never be read");
    },
  });
  const client = { getQueryCache: () => ({ getAll: () => [unrelated, query] }) };
  const root = { tag: 3, memoizedProps: {}, child: null, return: null };
  root.stateNode = { current: root };
  const provider = { tag: 0, memoizedProps: { client }, child: null, return: root };
  root.child = provider;
  let parent = provider;
  for (let i = 0; i < (options.depth || 0); i++) {
    const node = { tag: 0, memoizedProps: {}, return: parent, child: null };
    parent.child = node;
    parent = node;
  }
  const leaf = { tag: 5, memoizedProps: { conversationId: chatId }, return: parent };
  parent.child = leaf;
  const element = {
    __reactFiber$fixture: leaf,
    closest: () => null,
    getClientRects: () => [{}],
  };
  return {
    history,
    query,
    leaf,
    root,
    provider,
    element,
    document: { querySelectorAll: () => [element] },
    location: { origin: "https://chatgpt.com", pathname: "/c/" + chatId },
    __input: { chatId, handle, tool_names: ["chat_set_goal"] },
  };
}
const goalFixtureId = "goal-fixture-0001";
const goalReadFixture = (fixture) =>
  goalVm.runInNewContext("(" + chatGoalReact.toString() + ")(__input)", fixture, { timeout: 1000 });
const goalFixture = (options) => goalReactFixture(goalFixtureId, handle, options);
{
  const fixture = goalFixture();
  const read = goalReadFixture(fixture);
  check(
    read.status === "ready" && read.match && read.source === "query-cache",
    "goal match reads a mounted cached REST object without fetch or WebSocket events",
  );
  check(
    !JSON.stringify(read).includes("SECRET_FIXTURE_ARGUMENT") &&
      !JSON.stringify(read).includes(handle),
    "React inspection exports no tool arguments or unrelated session credentials",
  );
  check(read.turn.state === "running", "a finished tool request does not prove turn completion");
  const final = {
    id: "final",
    author: { role: "assistant" },
    recipient: "all",
    channel: "final",
    status: "finished_successfully",
    end_turn: true,
    content: { content_type: "text", parts: ["Complete"] },
  };
  fixture.history.mapping.final = { parent: "call", message: final };
  fixture.history.current_node = "final";
  check(
    goalReadFixture(fixture).turn.state === "complete",
    "final end_turn plus successful status proves completion",
  );
  final.end_turn = false;
  check(
    goalReadFixture(fixture).turn.state === "running",
    "successful status alone is not a completed turn",
  );
  final.end_turn = true;
  fixture.history.mapping.scratch = {
    parent: "final",
    message: {
      id: "scratch",
      author: { role: "assistant" },
      recipient: "all",
      channel: "analysis",
      status: "in_progress",
      content: { content_type: "text", parts: [""] },
    },
  };
  fixture.history.current_node = "scratch";
  check(
    goalReadFixture(fixture).turn.state === "complete",
    "trailing analysis scratch does not hide the completed final",
  );
  fixture.history.mapping.newFinal = {
    parent: "scratch",
    message: { ...final, id: "newFinal", end_turn: false, status: "in_progress" },
  };
  fixture.history.current_node = "newFinal";
  check(
    goalReadFixture(fixture).turn.state === "running",
    "a newer unfinished final supersedes an older completed answer",
  );
  const before = goalReadFixture(fixture).turn.signature;
  fixture.history.mapping.newFinal.message.content = { content_type: "text", parts: ["OtherOne"] };
  check(
    goalReadFixture(fixture).turn.signature !== before,
    "equal-length response changes count as progress",
  );
  fixture.history.mapping.nextUser = {
    parent: "newFinal",
    message: {
      id: "nextUser",
      author: { role: "user" },
      content: { content_type: "text", parts: ["Next"] },
    },
  };
  fixture.history.current_node = "nextUser";
  check(
    goalReadFixture(fixture).turn.state === "running",
    "a new user turn cannot inherit an old completion",
  );
}
{
  const fixture = goalFixture();
  fixture.history.mapping.inactive = fixture.history.mapping.call;
  fixture.history.current_node = "user";
  check(!goalReadFixture(fixture).match, "inactive cached branches cannot associate a Session");
  fixture.history.current_node = "call";
  fixture.history.mapping.call.message.content.text = JSON.stringify({
    path: "/MrMCP/chat_set_goal",
    args: { chat_session: handle + "suffix" },
  });
  check(!goalReadFixture(fixture).match, "Session matching is exact, never a substring");
  fixture.history.mapping.call.message.content.text = JSON.stringify({
    path: "/MrMCP/chat_set_goal",
    args: { goal: JSON.stringify({ chat_session: handle }) },
  });
  check(
    !goalReadFixture(fixture).match,
    "an example Session inside goal text cannot prove a match",
  );
  fixture.history.mapping.call.message.content.text = "{truncated";
  check(
    goalReadFixture(fixture).match_complete === false,
    "truncated requests never prove absence",
  );
  fixture.history.mapping.later = goalFixture().history.mapping.call;
  fixture.history.mapping.later.parent = "call";
  fixture.history.mapping.later.id = "later";
  fixture.history.mapping.later.message.id = "later";
  fixture.history.current_node = "later";
  check(
    goalReadFixture(fixture).match,
    "a complete later request can match despite older truncated requests",
  );
}
for (const mutation of [
  (fixture) => {
    fixture.history.mapping.user.parent = "call";
  },
  (fixture) => {
    delete fixture.history.mapping.user;
  },
]) {
  const fixture = goalFixture();
  mutation(fixture);
  const read = goalReadFixture(fixture);
  check(
    !read.match && read.status === "incomplete",
    "cycle/missing ancestors invalidate active-branch proof",
  );
}
{
  const fixture = goalFixture();
  fixture.query.state.error = { status: 401, private: "NEVER_EXPORT_THIS" };
  check(
    goalReadFixture(fixture).status === "waiting_login" &&
      !JSON.stringify(goalReadFixture(fixture)).includes("NEVER_EXPORT_THIS"),
    "only the current query's unauthorized status is projected, without its error payload",
  );
}
{
  const fixture = goalFixture();
  fixture.query.queryKey[1] = "different-chat-0002";
  check(
    !goalReadFixture(fixture).match,
    "a different cache query is not joined to the current URL",
  );
  fixture.query.queryKey[1] = goalFixtureId;
  fixture.history.conversation_id = "different-chat-0002";
  check(
    goalReadFixture(fixture).status === "conflict",
    "cached history identity must agree with its query key",
  );
  fixture.history.conversation_id = goalFixtureId;
  fixture.leaf.memoizedProps.conversationId = "different-chat-0002";
  check(
    goalReadFixture(fixture).status === "conflict",
    "mounted old-page props invalidate route-based guesses",
  );
}
{
  const fixture = goalFixture({ depth: 450 });
  check(goalReadFixture(fixture).match, "deep production React trees remain inspectable");
  fixture.leaf.return.child = null;
  check(!goalReadFixture(fixture).match, "an uncommitted/detached Fiber cannot supply evidence");
}
{
  const fixture = goalFixture();
  fixture.location.pathname = "/g/g-p-fixture/c/" + goalFixtureId;
  fixture.__input.expected_text = "Fixture question";
  const read = goalReadFixture(fixture);
  check(
    read.match && read.goal_receipt === "user",
    "project routes and model-only user receipts retain exact identity",
  );
  const turn = {
    status: "complete",
    items: [
      { type: "user-message", messageId: "user" },
      { type: "assistant-message", messageId: "final", completed: true, phase: "final_answer" },
    ],
  };
  fixture.leaf.memoizedProps.turn = turn;
  check(
    goalReadFixture(fixture).turn.state === "complete",
    "the mounted typed turn can prove completion ahead of cached history",
  );
  turn.status = "in_progress";
  check(
    goalReadFixture(fixture).turn.state === "running",
    "a newer running typed turn overrides stale completion evidence",
  );
  const typedSignature = goalReadFixture(fixture).turn.signature;
  turn.items[1].content = "Visible response progress";
  check(
    goalReadFixture(fixture).turn.signature !== typedSignature,
    "typed response progress is observed even when the history query has not updated",
  );
  const live = structuredClone(fixture.history);
  live.current_node = "user";
  fixture.leaf.memoizedState = {
    memoizedState: {
      renderedConversation: live,
      renderedTurns: [{ turn }],
    },
    next: null,
  };
  check(
    goalReadFixture(fixture).source === "mounted-live" && !goalReadFixture(fixture).match,
    "an exact mounted live snapshot supersedes old query-cache branches",
  );
  fixture.leaf.memoizedState.next = {
    memoizedState: {
      renderedConversation: structuredClone(live),
      renderedTurns: [{ turn }],
    },
    next: null,
  };
  check(
    goalReadFixture(fixture).status === "conflict",
    "conflicting live snapshots cannot establish a match",
  );
}
{
  const old = goalFixture();
  const committed = goalFixture();
  committed.history.current_node = "user";
  old.root.alternate = committed.root;
  committed.root.alternate = old.root;
  old.provider.alternate = committed.provider;
  old.leaf.alternate = committed.leaf;
  old.root.stateNode.current = committed.root;
  committed.root.stateNode = old.root.stateNode;
  check(
    !goalReadFixture(old).match,
    "an old DOM Fiber pointer is resolved through the committed alternate",
  );
}
{
  const savedEnabled = getCfg("chat_goals_enabled", "1");
  const previousClient = cdpReverseClient;
  const context = await createContext(p);
  const extensionId = "a".repeat(32);
  const launch = cdp.browser.launch;
  const bootstraps = [];
  const methods = [];
  const tabs = new Map([[1, { id: 1, windowId: 7, url: chatGoalUrl(goalFixtureId), groupId: -1 }]]);
  const groups = new Map();
  const storage = {};
  let nextTab = 54;
  let created = 0;
  let bridge;
  const info = (tab) => ({
    targetId: String(tab.id),
    type: "page",
    url: tab.url,
    title: "",
    groupId: tab.groupId,
    attached: false,
  });
  const notify = (method, params) => bridge.send(JSON.stringify({ method, params }));
  const attachBridge = async (pending) => {
    const deadline = Date.now() + 3000;
    while (!cdpReverseClient?.server) {
      if (Date.now() > deadline) throw Error("reverse test listener did not open");
      await sleep(5);
    }
    bridge = new WebSocket("ws://127.0.0.1:" + cdpReverseClient.server.port, {
      headers: { origin: "chrome-extension://" + extensionId },
    });
    bridge.addEventListener("open", () => {
      const url = new URL(cdpReverseClient.browsers[CHAT_GOAL_BROWSER].bootstrap_url);
      bridge.send(
        JSON.stringify({
          browser: url.searchParams.get("browser"),
          extension_id: extensionId,
          token: url.searchParams.get("token"),
        }),
      );
    });
    bridge.addEventListener("message", (event) => {
      const request = JSON.parse(event.data);
      methods.push(request);
      const params = request.params || {};
      let result = {};
      switch (request.method) {
        case "Browser.getVersion":
          result = { product: "Chrome/fixture", protocolVersion: "1.3" };
          break;
        case "Target.getTargets":
          result = { targetInfos: [...tabs.values()].map(info) };
          break;
        case "Target.setDiscoverTargets":
          for (const tab of tabs.values())
            notify("Target.targetCreated", { targetInfo: info(tab) });
          break;
        case "Target.setAutoAttach":
        case "Runtime.runIfWaitingForDebugger":
          break;
        case "Target.createTarget": {
          const tab = { id: ++nextTab, windowId: 7, url: params.url, groupId: -1 };
          tabs.set(tab.id, tab);
          created++;
          notify("Target.targetCreated", { targetInfo: info(tab) });
          result = { targetId: String(tab.id) };
          break;
        }
        case "Target.attachToTarget": {
          const tab = tabs.get(Number(params.targetId));
          result = { sessionId: String(tab.id) };
          notify("Target.attachedToTarget", {
            sessionId: result.sessionId,
            targetInfo: info(tab),
            waitingForDebugger: false,
          });
          break;
        }
        case "Page.getFrameTree":
          result = { frameTree: { frame: { id: "frame" } } };
          break;
        case "Page.navigate": {
          const tab = tabs.get(Number(request.sessionId));
          tab.url = params.url;
          notify("Target.targetInfoChanged", { targetInfo: info(tab) });
          result = { frameId: "frame" };
          break;
        }
        case "chrome.tabs.get":
          result = tabs.get(params.args[0]);
          break;
        case "chrome.storage.session.get":
          result = { ...storage };
          break;
        case "chrome.storage.session.set":
          Object.assign(storage, params.args[0]);
          break;
        case "chrome.tabGroups.query":
          result = [...groups.values()];
          break;
        case "chrome.tabs.group": {
          const groupId = params.args[0].groupId ?? 23 + groups.size;
          groups.set(groupId, { id: groupId, windowId: 7 });
          tabs.get(params.args[0].tabIds).groupId = groupId;
          result = groupId;
          break;
        }
        case "chrome.tabGroups.update": {
          const [id, value] = params.args;
          Object.assign(groups.get(id), value);
          result = groups.get(id);
          break;
        }
        default:
          bridge.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32601,
                message: "Unexpected reverse fixture method: " + request.method,
              },
            }),
          );
          return;
      }
      bridge.send(JSON.stringify({ id: request.id, result }));
    });
    return await pending;
  };
  try {
    cdp.browser.launch = async (options) => {
      bootstraps.push({ url: new URL(options.bootstrap_url), options });
      return { proc: { exitCode: 0, signalCode: null, unref() {} } };
    };
    await setCfg("chat_goals_enabled", "1");
    const unset = await setChatGoal(context, "Reverse fixture", 30);
    check(
      unset.status === "pending" && !cdpBrowsers.has(CHAT_GOAL_BROWSER),
      "automatic reverse discovery remains lazy when saving an unassociated goal",
    );
    const debug = await chatGoalDebug(context);
    check(
      debug.browser_configured && !debug.browser_connected && !("login_ready" in debug),
      "goal debug reports reverse configuration rather than app-owned login readiness",
    );
    const debugSchema = (await serverTools(p)).find(
      (tool) => tool.name === "chat_goal_debug",
    ).outputSchema;
    check(
      !inputSchemaError(debugSchema, { ...debug, chat_session: context.handle }) &&
        toolResultSummary("chat_goal_debug", debug).includes("browser configured"),
      "goal debug output and concise summary expose the current reverse contract",
    );
    cdpReverseClient = new cdp.cdp({
      base_path: CDP_DIR,
      reverse_server: { hostname: "127.0.0.1", port: 0 },
    });
    check(
      !cdpReverseClient.server && !created,
      "configured reverse goals remain lazy until an explicit browser operation",
    );
    let page = await attachBridge(chatGoalPage());
    const again = await chatGoalPage();
    const networkRoute = cdpMessageTarget(
      {
        ...page.record,
        session_to_target: new Map(),
      },
      {
        method: "chrome.webRequest.onCompleted",
        params: { tabId: Number(page.target_id) },
        sessionId: page.target_id,
      },
    );
    const backgroundRoute = cdpMessageTarget(page.record, {
      method: "chrome.webRequest.onCompleted",
      params: { tabId: -1 },
    });
    check(
      networkRoute.target_id === page.target_id &&
        networkRoute.target === "goals" &&
        !backgroundRoute.target_id,
      "webRequest notifications route known logical tabs without debugger session mappings, preserving tabId=-1",
    );
    check(
      created === 1 && again.target_id === page.target_id && page.target === "goals",
      "the same logical goals tab is reused and unrelated personal tabs are not adopted",
    );
    check(
      groups.get(23)?.title === "MrMCP Goals" && groups.get(23)?.color === "purple",
      "CDP.js creates the named purple native tab group",
    );
    check(
      !page.record.engine.proc &&
        page.record.user_data_dir === null &&
        bootstraps.length === 1 &&
        bootstraps[0].options.cdp_ext_install === false &&
        bootstraps[0].options.update_preferences === false &&
        bootstraps[0].url.pathname === "/cdp_ext" &&
        bootstraps[0].url.searchParams.get("browser") === CHAT_GOAL_BROWSER &&
        bootstraps[0].url.searchParams.get("token") &&
        bootstraps[0].url.searchParams
          .get("websocket_url")
          .endsWith(":" + cdpReverseClient.server.port),
      "Goals use the public token-bound URL opener without installing an extension, owning Chrome or creating a profile",
    );
    check(
      !cdp.browser.build_args(bootstraps[0].options)["enable-automation"] &&
        !cdp.browser.build_args(bootstraps[0].options)["disable-sync"] &&
        !cdp.browser.build_args(bootstraps[0].options)["user-data-dir"],
      "the system-profile opener preserves normal Chrome routing and browser account integration",
    );
    check(
      !methods.some((r) => /^(Network\.|Runtime\.enable|Runtime\.addBinding)/.test(r.method)),
      "goals do not enable network capture, Runtime reporting or a binding",
    );
    await cdpReverseClient.close();
    cdpDisconnect(page.record);
    cdpReverseClient = new cdp.cdp({
      base_path: CDP_DIR,
      reverse_server: { hostname: "127.0.0.1", port: 0 },
    });
    page = await attachBridge(chatGoalPage());
    check(
      created === 1 && page.target_id === again.target_id,
      "a fresh reverse manager reuses the persisted surviving logical target",
    );
    tabs.delete(Number(page.target_id));
    notify("Target.targetDestroyed", { targetId: page.target_id });
    await sleep(10);
    const recreated = await chatGoalPage();
    check(
      created === 2 &&
        recreated.target_id !== page.target_id &&
        groups.get(tabs.get(Number(recreated.target_id)).groupId)?.title === "MrMCP Goals",
      "a closed goals target is recreated lazily in the same named group",
    );
    await cdpReverseClient.close();
    cdpDisconnect(recreated.record);
    delete storage[CHAT_GOAL_TAB_KEY];
    for (const id of tabs.keys()) if (id !== 1) tabs.delete(id);
    groups.clear();
    await run(
      "UPDATE cdp_targets SET target_id='1' WHERE browser=? AND target=?",
      CHAT_GOAL_BROWSER,
      CHAT_GOAL_TARGET,
    );
    cdpReverseClient = new cdp.cdp({
      base_path: CDP_DIR,
      reverse_server: { hostname: "127.0.0.1", port: 0 },
    });
    const afterRestart = await attachBridge(chatGoalPage());
    check(
      created === 3 &&
        afterRestart.target_id !== "1" &&
        tabs.get(1).url === chatGoalUrl(goalFixtureId),
      "a recycled persisted tab ID without the extension session marker cannot adopt a personal tab",
    );
    const oldText = (await one("SELECT goal_text FROM contexts WHERE id=?", context.id)).goal_text;
    const workerPage = await chatGoalPage({
      subagent: true,
      target: "fixture-worker",
      group: SUBAGENT_GROUP,
      storage_key: "mrmcp.fixture-worker",
    });
    subagentPages.set("fixture-worker", workerPage);
    await setCfg("chat_goals_enabled", "0");
    chatGoalConfigure();
    check(
      workerPage.record.open &&
        groups.get(24)?.title === "MrMCP Subagents" &&
        groups.get(24)?.color === "cyan",
      "subagent targets use a separate cyan group and remain independent of the Goals enable flag",
    );
    subagentPages.delete("fixture-worker");
    await setCfg("chat_goals_enabled", "1");
    check(
      chatGoalExtensionId() === extensionId &&
        (await one("SELECT goal_text FROM contexts WHERE id=?", context.id)).goal_text === oldText,
      "the announced extension is discovered without configuration and saved goals remain intact",
    );
    await setCfg("chat_goals_enabled", "0");
    chatGoalConfigure();
    await sleep(20);
    check(
      !methods.some((r) => r.method === "Browser.close" || r.method === "Target.closeTarget"),
      "disabling goals leaves the system browser and tabs open",
    );
    check(
      !chatGoalTimer && !chatGoalObservedPage,
      "disabling clears the scheduler and turn observation",
    );
  } finally {
    cdp.browser.launch = launch;
    await setChatGoal(await one("SELECT * FROM contexts WHERE id=?", context.id), "", 30);
    bridge?.close();
    await cdpReverseClient?.close();
    const record = cdpBrowsers.get(CHAT_GOAL_BROWSER);
    if (record) cdpDisconnect(record);
    cdpReverseClient = previousClient;
    cdpBrowserOptions.delete(CHAT_GOAL_BROWSER);
    cdpTargetOptions.delete(cdpTargetKey(CHAT_GOAL_BROWSER, CHAT_GOAL_TARGET));
    cdpTargetOptions.delete(cdpTargetKey(CHAT_GOAL_BROWSER, "fixture-worker"));
    await run("DELETE FROM cdp_targets WHERE browser=?", CHAT_GOAL_BROWSER);
    await setCfg("chat_goals_enabled", savedEnabled);
    chatGoalObservedPage = null;
  }
}
{
  const savedEnabled = getCfg("chat_goals_enabled", "1");
  const originals = {
    page: chatGoalPage,
    react: chatGoalReadReact,
    evaluate: chatGoalEvaluate,
    navigate: chatGoalNavigate,
    rpc: chatGoalRpc,
    state: chatGoalState,
  };
  const owner = await createContext(p);
  const linked = await createContext(p);
  const other = await createContext(p);
  const fresh = () => one("SELECT * FROM contexts WHERE id=?", owner.id);
  const overdue = async () => {
    const past = Date.now() - 90000;
    await run(
      "UPDATE contexts SET last_active_at=?,goal_updated_at=?,goal_activity_at=0,goal_last_sent_at=0,goal_next_check_at=1 WHERE id=?",
      past,
      past,
      owner.id,
    );
  };
  const controls = [];
  let browserOpens = 0;
  try {
    await setCfg("chat_goals_enabled", "1");
    await setChatGoal(owner, "GOAL_FIXTURE_PROMPT", 30);
    await chatGoalBind(await fresh(), goalFixtureId);
    await run("UPDATE contexts SET chatgpt_chat_id=? WHERE id=?", goalFixtureId, linked.id);
    await overdue();
    chatGoalPage = async () => {
      browserOpens++;
      throw Error("A running Tool Call must not open Chrome");
    };
    const long = await reserveToolCall({ goalActivity: true, contextHandle: linked.handle });
    controls.push(long);
    await chatGoalRun(await fresh());
    check(
      browserOpens === 0 && (await fresh()).goal_status === "busy",
      "a long Tool Call in any linked Session suspends the timer before opening Chrome",
    );
    check(
      (await chatGoalActiveCalls(await fresh(), long.log_id)) === 0,
      "manual debug can exclude its own Tool Call only",
    );
    const unauthorized = await reserveToolCall({ contextHandle: owner.handle });
    const beforeUnauthorized = (await fresh()).goal_activity_at;
    await releaseToolCall(unauthorized);
    check(
      (await fresh()).goal_activity_at === beforeUnauthorized,
      "rejected authentication cannot renew goal activity even with a supplied valid handle",
    );
    const completedAfter = Date.now();
    await releaseToolCall(long);
    check(
      chatGoalDue(await fresh()) >= completedAfter + 30000,
      "completion starts a full fresh inactivity interval regardless of call length",
    );
    const unrelated = await reserveToolCall({ goalActivity: true, contextHandle: other.handle });
    controls.push(unrelated);
    check(
      (await chatGoalActiveCalls(await fresh())) === 0,
      "another conversation's Tool Call does not block this goal",
    );
    await releaseToolCall(unrelated);
    const page = { record: { open: true } };
    let model = {
      status: "ready",
      chat_id: goalFixtureId,
      user_ids: ["old-user"],
      turn: {
        state: "running",
        signature: "first",
        progress_at: Date.now() - 90000,
      },
    };
    chatGoalReadReact = async () => model;
    await overdue();
    chatGoalTurns.delete(goalFixtureId);
    await chatGoalObserveTurn(page, await fresh());
    const firstActivity = (await fresh()).goal_activity_at;
    check(
      firstActivity > Date.now() - 1000,
      "first running observation establishes a conservative idle baseline",
    );
    await sleep(5);
    await chatGoalObserveTurn(page, await fresh());
    check(
      (await fresh()).goal_activity_at === firstActivity,
      "an unchanged busy/streaming snapshot does not postpone forever",
    );
    model = { ...model, turn: { ...model.turn, progress_at: Date.now() } };
    await chatGoalObserveTurn(page, await fresh());
    check(
      (await fresh()).goal_activity_at === firstActivity,
      "a timestamp-only heartbeat does not count as new response progress",
    );
    model = { ...model, turn: { ...model.turn, signature: "progress" } };
    await chatGoalObserveTurn(page, await fresh());
    check(
      (await fresh()).goal_activity_at > firstActivity,
      "observed response progress restarts inactivity",
    );
    let stops = 0,
      sends = 0,
      inserted = 0,
      clears = 0,
      acknowledged = false;
    chatGoalEvaluate = async (_page, action) => {
      if (action === "clear") {
        clears++;
        return { cleared: true };
      }
      if (action === "stop") {
        stops++;
        return { stop_ok: true };
      }
      if (action === "send") {
        sends++;
        acknowledged = true;
        return { sent: true };
      }
      return {
        status: "ready",
        url: chatGoalUrl(goalFixtureId),
        draft: "",
        responding: false,
        focused: true,
        users: [
          {
            id: acknowledged ? "new-user" : "old-user",
            text: acknowledged ? "GOAL_FIXTURE_PROMPT" : "Question",
          },
        ],
      };
    };
    chatGoalRpc = async (_page, method) => {
      if (method === "Input.insertText") inserted++;
      return {};
    };
    await overdue();
    const blocked = await reserveToolCall({ goalActivity: true, contextHandle: owner.handle });
    controls.push(blocked);
    await chatGoalSend(page, await fresh(), { force: true, stop_before_send: true });
    check(
      !stops && !sends && !inserted,
      "in-flight Tool Calls veto even forced Stop/prompt before every side effect",
    );
    await releaseToolCall(blocked);
    await overdue();
    await chatGoalSend(page, await fresh());
    check(
      sends === 1 && inserted === 1 && (await fresh()).goal_last_sent_at > 0,
      "an unchanged stalled chat receives its goal after the interval expires",
    );
    await overdue();
    chatGoalState = async (...args) => {
      await originals.state(...args);
      if (args[1] === "sending")
        controls.push(await reserveToolCall({ goalActivity: true, contextHandle: owner.handle }));
    };
    await chatGoalSend(page, await fresh());
    check(
      sends === 1 && clears === 1,
      "a Tool Call arriving during the dispatch commit cancels the prompt and clears only its draft",
    );
    chatGoalState = originals.state;
    for (const control of controls) await releaseToolCall(control);
    chatGoalPage = async () => page;
    chatGoalNavigate = async (_page, url) => ({ status: "ready", url });
    chatGoalEvaluate = async (_page, action) =>
      action === "recent"
        ? { urls: [chatGoalUrl(goalFixtureId)] }
        : { status: "ready", url: chatGoalUrl(goalFixtureId), draft: "" };
    chatGoalReadReact = async () => ({ status: "ready", match: true, match_complete: true });
    const found = await chatGoalFindChat(page, await fresh());
    check(
      found.chatId === goalFixtureId,
      "candidate matching succeeds from cache without any network monitor",
    );
  } finally {
    chatGoalPage = originals.page;
    chatGoalReadReact = originals.react;
    chatGoalEvaluate = originals.evaluate;
    chatGoalNavigate = originals.navigate;
    chatGoalRpc = originals.rpc;
    chatGoalState = originals.state;
    for (const control of controls) await releaseToolCall(control);
    await setChatGoal(await fresh(), "", 30);
    await setCfg("chat_goals_enabled", savedEnabled);
    chatGoalTurns.clear();
    chatGoalObservedPage = null;
  }
}
