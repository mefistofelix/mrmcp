// Injected into the isolated backend by check.mjs. No real account/profile is used.
async function checkBrowserGoals() {
  const direct = { name: "bun-probe", headless: true };
  const version = await call("cdp_call", {
    calls: [{ browser: direct, call: { method: "Browser.getVersion" } }],
  });
  check(JSON.stringify(version).includes("Chrome"), "real direct CDP browser launch");
  try {
    const found = await call("cdp_call", {
      calls: [
        {
          browser: direct,
          target: "fixture",
          call: {
            method: "Runtime.evaluate",
            params: {
              expression: 'document.body.innerHTML="<button>Direct fixture</button>"',
              returnByValue: true,
            },
          },
        },
      ],
    });
    check(found.results[0].success, "direct CDP still evaluates through the public transport");
    const nodes = await call("cdp_call", {
      calls: [
        {
          browser: direct,
          target: "fixture",
          call: { method: "_.find", params: { xpath: "//button" } },
        },
      ],
    });
    check(
      nodes.results[0].cdp.result.result.value.count === 1,
      "direct XPath keeps the package evaluator and result envelope",
    );
  } finally {
    await call("cdp_call", { calls: [{ browser: direct, call: { method: "Browser.close" } }] });
  }

  // Grant user scripts only in this disposable profile through Chrome's own
  // settings. Production never changes an operator profile or grants access.
  const profile = join(APP_DIR, "bootstrap-profile");
  const extension = join(profile, "Default", "cdp_ext");
  await exportCdpExtension(extension);
  const preparation = new cdp.cdp({
    headless: true,
    extensions: [extension],
    args: { "user-data-dir": profile, "no-sandbox": true },
  });
  try {
    const grant = await preparation.call({
      method: "Runtime.evaluate",
      params: {
        target: { name: "settings", create_params: { url: "chrome://extensions/" } },
        expression:
          "chrome.developerPrivate.updateExtensionConfiguration(" +
          JSON.stringify({
            extensionId: cdp.browser.extension_id(extension),
            userScriptsAccess: true,
          }) +
          ").then(() => true)",
        awaitPromise: true,
      },
    });
    check(grant.result.value === true, "isolated fixture enables the native User Scripts toggle");
    const exited = new Promise((resolve) => preparation.browsers.main.proc.once("exit", resolve));
    await preparation.call({ method: "Browser.close" });
    await exited;
  } finally {
    await preparation.close();
  }
  const requests = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return new Response(
        '<main><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea>' +
          '<button type="submit" data-testid="send-button">Submit</button></form></main>',
        {
          headers: { "content-type": "text/html", "content-security-policy": "script-src 'none'" },
        },
      );
    },
  });
  const browser = {
    name: "bootstrap-probe",
    cdp_ext: true,
    cdp_ext_install: true,
    user_data_dir: profile,
    headless: true,
    args: { "no-sandbox": true },
    connect_timeout_ms: 20000,
  };
  let record;
  const enabled = getCfg("chat_goals_enabled", "1");
  const script = chatGoalScript;
  try {
    record = await ensureCdpBrowser(browser);
    const bootstrap = new URL(record.engine.bootstrap_url);
    check(
      bootstrap.pathname === "/cdp_ext" && bootstrap.searchParams.get("browser") === browser.name,
      "real extension accepts the logical-name/token bootstrap",
    );
    const wire = [];
    const req = record.ws.req;
    record.ws.req = function (request, ...args) {
      wire.push(request);
      return req.call(this, request, ...args);
    };
    const target = await cdpEnsureTarget(record, {
      name: "browser-goals",
      initialize: false,
      execution_mode: "api",
      group: CHAT_BROWSER_GROUP,
    });
    const page = { record, ...target };
    await setCfg("chat_goals_enabled", "1");
    check(
      (await chatGoalEvaluate(page, "state")).url === "about:blank",
      "a new blank worker is inspected through tabs API before any document script injection",
    );
    await chatGoalOpenUrl(page, "http://127.0.0.1:" + server.port + "/c/" + goalFixtureId);
    for (let i = 0; i < 100; i++) {
      const tab = await cdpInternal(record, "chrome.tabs.get", { args: [Number(page.target_id)] });
      if (tab.status === "complete") break;
      await sleep(25);
    }
    check(
      await script(
        page,
        () => {
          try {
            eval("42");
            return false;
          } catch {
            return true;
          }
        },
        [],
        "MAIN",
      ),
      "the page's restrictive CSP remains in force",
    );
    await script(
      page,
      {
        toString: () => `() => {
          window.goalFixture = (${goalReactFixture.toString()})(
            ${JSON.stringify(goalFixtureId)}, ${JSON.stringify(handle)}
          );
          document.querySelector('main').__reactFiber$fixture = window.goalFixture.leaf;
          document.querySelector('form').onsubmit = event => {
            event.preventDefault();
            const editor = document.querySelector('textarea');
            const fixture = window.goalFixture;
            fixture.history.mapping['submitted-user'] = {
              id: 'submitted-user', parent: fixture.history.current_node,
              message: {
                id: 'submitted-user', author: { role: 'user' },
                content: { content_type: 'text', parts: [editor.value] }
              }
            };
            fixture.history.current_node = 'submitted-user';
            editor.value = '';
          };
          return true;
        }`,
      },
      [],
      "MAIN",
    );
    check(
      (await script(page, () => typeof window.goalFixture, [])) === "undefined",
      "USER_SCRIPT DOM operations have separate globals from MAIN React state",
    );
    // Keep the fixture on localhost. Supply only a lexical location facade to
    // the serialized adapters; never navigate the real ChatGPT site/account.
    chatGoalScript = (page, fn, args, world) =>
      script(
        page,
        {
          toString: () => `(...args) => {
            const location = {
              origin: 'https://chatgpt.com', pathname: window.location.pathname,
              href: 'https://chatgpt.com' + window.location.pathname
            };
            return (${fn.toString()})(...args);
          }`,
        },
        args,
        world,
      );
    let observed = await chatGoalReadReact(page, { chatId: goalFixtureId, handle });
    check(
      observed.match && observed.source === "query-cache",
      "extension MAIN reads the committed React model under restrictive CSP without debugger",
    );
    await script(
      page,
      () => {
        window.goalFixture.history.current_node = "user";
        return true;
      },
      [],
      "MAIN",
    );
    check(
      !(await chatGoalReadReact(page, { chatId: goalFixtureId, handle })).match,
      "React cache changes are read afresh without navigation or network monitoring",
    );
    const focused = await chatGoalEvaluate(page, "focus", {
      chatId: goalFixtureId,
      user_ids: observed.user_ids,
    });
    const text = "Fixture goal follow-up\n\nSecond paragraph";
    const inserted = await chatGoalEvaluate(page, "insert", { chatId: goalFixtureId, text });
    check(
      !(await chatGoalEvaluate(page, "insert", { chatId: goalFixtureId, text: "Overwrite" }))
        .inserted && (await chatGoalEvaluate(page, "state")).draft === text,
      "script insertion preserves an existing draft rather than appending or overwriting",
    );
    const sent = await chatGoalEvaluate(page, "send", { chatId: goalFixtureId, text });
    const receipt = await chatGoalReadReact(page, { chatId: goalFixtureId, expected_text: text });
    check(
      focused.focused &&
        inserted.inserted &&
        sent.sent &&
        receipt.goal_receipt === "submitted-user",
      "native textarea insertion and form submission have an exact MAIN React receipt",
    );
    await script(
      page,
      () => {
        history.replaceState(null, "", "/");
        document.querySelector("main").innerHTML =
          "<form data-chatgpt-composer>" +
          '<div id="prompt-textarea" contenteditable="true"></div>' +
          '<button type="submit" data-testid="send-button">Submit</button></form>';
        document.querySelector("form").onsubmit = (event) => {
          event.preventDefault();
          window.workerSent = true;
          document.querySelector("#prompt-textarea").textContent = "";
        };
        return true;
      },
      [],
      "MAIN",
    );
    const worker = { new_chat: true, text: "Worker fixture\n\nPreserve multiline text" };
    check(
      (await chatGoalEvaluate(page, "focus", worker)).focused &&
        (await chatGoalEvaluate(page, "insert", worker)).inserted &&
        (await chatGoalEvaluate(page, "state")).draft === worker.text &&
        (await chatGoalEvaluate(page, "send", worker)).sent &&
        (await script(page, () => window.workerSent, [], "MAIN")),
      "native rich-editor insertion preserves the exact multiline worker prompt and submits",
    );
    await script(
      page,
      (chatId) => {
        history.replaceState(null, "", "/c/" + chatId);
        const stop = document.createElement("button");
        stop.type = "button";
        stop.dataset.testid = "stop-button";
        stop.textContent = "Stop fixture";
        stop.onclick = () => {
          window.stopped = true;
          stop.remove();
        };
        document.querySelector("form").append(stop);
        return true;
      },
      [goalFixtureId],
      "MAIN",
    );
    check(
      (await chatGoalEvaluate(page, "stop", { chatId: goalFixtureId })).stop_ok &&
        (await script(page, () => window.stopped, [], "MAIN")),
      "native DOM Stop reaches the page handler without debugger input",
    );
    const xpath = await call("cdp_call", {
      calls: [
        {
          browser: browser.name,
          target: "browser-goals",
          call: { method: "_.find", params: { xpath: "//button", limit: 2 } },
        },
      ],
    });
    check(
      xpath.results[0].cdp.result.result.value.count === 1,
      "public reverse XPath uses the fixed extension API helper without debugger",
    );
    const click = await call("cdp_call", {
      wait: false,
      calls: [
        {
          browser: browser.name,
          target: "browser-goals",
          call: { method: "_.click", params: { xpath: "//button", attempts: 1 } },
        },
      ],
    });
    const pendingId = click.results[0].id;
    for (let i = 0; i < 100 && record.pending.has(pendingId); i++) await sleep(10);
    check(
      cdpRingNewest(record)?.cdp.result.result.value === true,
      "wait=false retains the eventual native API XPath response with its original id",
    );
    const attached = await cdpInternal(record, "chrome.debugger.getTargets");
    check(
      attached.every((tab) => !tab.attached) &&
        !wire.some((request) => /^(Runtime\.|Page\.|Input\.|Network\.)/.test(request.method)) &&
        wire
          .filter((request) => request.method === "Target.attachToTarget")
          .every((request) => request.params.execution_mode === "api") &&
        !wire.some((request) => /BypassCSP|declarativeNetRequest/.test(request.method)),
      "real reverse execution never attaches Chrome Debugger, changes CSP or enables CDP domains: " +
        JSON.stringify({
          attached: attached
            .filter((tab) => tab.attached)
            .map((tab) => ({ id: tab.id, type: tab.type })),
          forbidden: wire
            .filter((request) => /^(Runtime\.|Page\.|Input\.|Network\.)/.test(request.method))
            .map((request) => request.method),
          selection: wire
            .filter((request) => request.method === "Target.attachToTarget")
            .map((request) => request.params),
        }),
    );
    check(
      !requests.some((path) => path.startsWith("/backend-api/")),
      "readers issue no private REST requests",
    );
    const groups = await cdpInternal(record, "chrome.tabGroups.query", { args: [{}] });
    check(
      groups.length === 1 && groups[0].title === "MrMCP",
      "owned targets use one native MrMCP group",
    );
    const proc = record.engine.proc;
    record.ws.close();
    for (let i = 0; i < 100 && record.open; i++) await sleep(10);
    const reconnected = await ensureCdpBrowser(browser);
    const surviving = await cdpEnsureTarget(reconnected, { name: "browser-goals" });
    check(
      reconnected.engine.proc === proc && surviving.target_id === target.target_id,
      "real reverse reconnect preserves the Chrome process and logical API tab",
    );
  } finally {
    chatGoalScript = script;
    await setCfg("chat_goals_enabled", enabled);
    await server.stop(true);
    const owned = record?.engine || cdpReverseClient?.browsers[browser.name];
    owned?.proc?.kill();
    owned?.socket?.close();
    const live = cdpBrowsers.get(browser.name);
    if (live) cdpDisconnect(live);
    if (cdpReverseClient) delete cdpReverseClient.browsers[browser.name];
    cdpBrowserOptions.delete(browser.name);
    cdpTargetOptions.delete(cdpTargetKey(browser.name, "browser-goals"));
  }
}
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
      (await fs.readFile(join(destination, "sidebar.html"))).equals(
        await fs.readFile(join(source, "sidebar.html")),
      ) &&
      (await fs.readFile(join(destination, "sidebar.js"))).equals(
        await fs.readFile(join(source, "sidebar.js")),
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
  let scriptError = "";
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
          if (params.execution_mode !== "api")
            throw Error("Goals/Subagents must never attach Chrome Debugger");
          const tab = tabs.get(Number(params.targetId));
          result = { sessionId: String(tab.id) };
          notify("Target.attachedToTarget", {
            sessionId: result.sessionId,
            targetInfo: info(tab),
            waitingForDebugger: false,
          });
          break;
        }
        case "chrome.tabs.update": {
          const [id, value] = params.args;
          const tab = tabs.get(id);
          Object.assign(tab, value);
          notify("Target.targetInfoChanged", { targetInfo: info(tab) });
          result = tab;
          break;
        }
        case "chrome.tabs.query":
          result = [...tabs.values()];
          break;
        case "chrome.userScripts.execute": {
          if (scriptError) {
            bridge.send(
              JSON.stringify({ id: request.id, error: { code: -32000, message: scriptError } }),
            );
            return;
          }
          const injection = params.args[0];
          const value = goalVm.runInNewContext(injection.js[0].code);
          result = [{ frameId: 0, result: value }];
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
          result = [...groups.values()].filter(
            (group) => !params.args[0].title || group.title === params.args[0].title,
          );
          break;
        case "chrome.tabs.group": {
          const groupId = params.args[0].groupId ?? 23 + groups.size;
          if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: 7 });
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
      groups.get(23)?.title === "MrMCP" && groups.get(23)?.color === "purple",
      "CDP.js creates the shared native MrMCP tab group",
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
      !methods.some((r) =>
        /^(Network\.|Runtime\.|Page\.|Input\.|chrome\.debugger\.)/.test(r.method),
      ),
      "goals use no debugger, page/input/runtime commands or network capture",
    );
    check(
      (await chatGoalScript(page, (a, b) => a + b, [19, 23], "MAIN")) === 42,
      "native script-text execution preserves structured results without Runtime.evaluate",
    );
    scriptError = "User Scripts access denied";
    let permissionHint = "";
    try {
      await chatGoalScript(page, () => 42, []);
    } catch (error) {
      permissionHint = error.message;
    }
    scriptError = "";
    check(
      permissionHint.includes("Enable Allow User Scripts") &&
        !methods.some((request) => request.method === "Runtime.evaluate"),
      "missing User Scripts permission produces setup guidance without debugger fallback",
    );
    let refused = false;
    try {
      await chatGoalRpc(page, "Runtime.evaluate", { expression: "42" });
    } catch (error) {
      refused = error.message.includes("requires browser APIs");
    }
    check(refused, "internal ChatGPT control rejects debugger commands before transport dispatch");
    await cdpReverseClient.close();
    cdpDisconnect(page.record);
    cdpReverseClient = new cdp.cdp({
      base_path: CDP_DIR,
      reverse_server: { hostname: "127.0.0.1", port: 0 },
    });
    groups.set(99, { id: 99, windowId: 7, title: "MrMCP", color: "orange" });
    page = await attachBridge(chatGoalPage());
    check(
      created === 1 &&
        page.target_id === again.target_id &&
        groups.size === 2 &&
        tabs.get(Number(page.target_id)).groupId === 23 &&
        groups.get(99).color === "orange",
      "a fresh reverse manager reuses its marked group and preserves unrelated same-title groups",
    );
    tabs.delete(Number(page.target_id));
    notify("Target.targetDestroyed", { targetId: page.target_id });
    await sleep(10);
    const recreated = await chatGoalPage();
    check(
      created === 2 &&
        recreated.target_id !== page.target_id &&
        groups.get(tabs.get(Number(recreated.target_id)).groupId)?.title === "MrMCP",
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
      storage_key: "mrmcp.fixture-worker",
    });
    subagentPages.set("fixture-worker", workerPage);
    await setCfg("chat_goals_enabled", "0");
    chatGoalConfigure();
    check(
      workerPage.record.open &&
        groups.size === 1 &&
        tabs.get(Number(workerPage.target_id)).groupId ===
          tabs.get(Number(afterRestart.target_id)).groupId,
      "subagent targets share the MrMCP group and remain independent of the Goals enable flag",
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
      if (action === "insert") {
        inserted++;
        return { inserted: true };
      }
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
