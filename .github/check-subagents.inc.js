// Durable worker/broker checks. No real ChatGPT account or browser is used here.
{
  const schedule = subagentSchedule;
  const page = subagentPage;
  const evaluate = chatGoalEvaluate;
  const readReact = chatGoalReadReact;
  const rpc = chatGoalRpc;
  const owner = await one("SELECT * FROM contexts WHERE handle=?", handle);
  const stranger = await createContext(p);
  const child = await createContext(p);
  const schema = (await serverTools(p)).find((tool) => tool.name === "subagents").outputSchema;
  const controls = [];
  const previousGate = toolCallGate;
  const probe = async (actor, args) => {
    const result = await subagentTool(actor, args);
    const error = inputSchemaError(schema, { ...result, chat_session: actor.handle });
    check(!error, "actual subagents output contract: " + error);
    return result;
  };
  const fails = async (actor, args, expected) => {
    let error = "";
    try {
      await subagentTool(actor, args);
    } catch (failure) {
      error = errorMessage(failure);
    }
    check(error.includes(expected), "subagent refusal: " + expected + ": " + error);
  };
  try {
    subagentSchedule = () => {};
    const accepted = await probe(owner, {
      action: "spawn",
      context: "Shared fixture",
      workers: [
        { label: "Tests", task: "Run fixture tests" },
        { label: "Review", task: "Review fixture" },
      ],
    });
    check(
      accepted.agents.length === 2 && accepted.agents.every((agent) => agent.state === "queued"),
      "spawn reserves independent workers without app ID configuration before browser publication",
    );
    check(
      !JSON.stringify(accepted).includes("claim_token"),
      "worker claims are not public tool metadata",
    );
    const id = accepted.agents.find((agent) => agent.label === "Tests").id;
    const row = await subagentRecord(id);
    const brief = subagentBrief(row);
    check(
      brief.includes("init_chat_session") &&
        brief.includes("action=join, agent_id=" + JSON.stringify(id)) &&
        brief.includes("claim_token=" + JSON.stringify(row.claim_token)) &&
        brief.includes("action=message") &&
        brief.includes("action=finish") &&
        brief.includes("Run fixture tests") &&
        brief.includes("Shared fixture"),
      "bootstrap prompt carries the exact private join and task/report/finish instructions",
    );
    await fails(stranger, { action: "message", agent_id: id, text: "foreign" }, "another Session");
    check(
      !(await probe(stranger, { action: "status" })).agents.length,
      "unrelated Sessions cannot discover worker families",
    );
    const admissions = await Promise.allSettled(
      [1, 2].map(() =>
        subagentTool(stranger, {
          action: "spawn",
          workers: Array.from({ length: 5 }, () => ({ task: "Admission fixture" })),
        }),
      ),
    );
    check(
      admissions.filter((result) => result.status === "fulfilled").length === 1 &&
        (await one("SELECT COUNT(*) n FROM subagents WHERE parent_context_id=?", stranger.id)).n ===
          5,
      "concurrent admissions reserve slots atomically and never exceed eight workers",
    );
    await run("DELETE FROM subagents WHERE parent_context_id=?", stranger.id);
    await fails(child, { action: "join", agent_id: id, claim_token: "wrong" }, "claim");
    const joined = await probe(child, {
      action: "join",
      agent_id: id,
      claim_token: row.claim_token,
    });
    check(
      joined.agents[0].session_id === child.id &&
        !(await subagentRecord(id)).claim_token &&
        (await one("SELECT root_id FROM contexts WHERE id=?", child.id)).root_id === owner.root_id,
      "one-use join binds a separate Session and inherits only the selected Workspace",
    );
    await fails(stranger, { action: "join", agent_id: id, claim_token: row.claim_token }, "claim");
    await fails(child, { action: "spawn", workers: [{ task: "nested" }] }, "nested");
    await probe(child, { action: "message", text: "Progress report" });
    const reports = await probe(owner, { action: "status", agent_id: id });
    check(
      reports.messages.some(
        (message) => message.kind === "report" && message.text === "Progress report",
      ),
      "worker progress is delivered durably through the broker, not by waking the parent chat",
    );
    await probe(owner, { action: "message", agent_id: id, text: "Follow-up task" });
    await probe(child, { action: "finish", result: "RESULT: fixture passed" });
    check(
      (await subagentRecord(id)).state === "queued",
      "a finish with pending work leaves that work runnable",
    );
    await run(
      "UPDATE subagent_messages SET state='delivered' WHERE agent_id=? AND state='queued'",
      id,
    );
    await run("UPDATE subagents SET state='running' WHERE id=?", id);
    await probe(child, { action: "finish", result: "RESULT: completed" });
    const count = (
      await one("SELECT COUNT(*) n FROM subagent_messages WHERE agent_id=? AND kind='result'", id)
    ).n;
    await probe(child, { action: "finish", result: "RESULT: completed" });
    check(
      (await one("SELECT COUNT(*) n FROM subagent_messages WHERE agent_id=? AND kind='result'", id))
        .n === count,
      "an exact repeated finish does not duplicate its report",
    );
    await fails(owner, { action: "finish", agent_id: id, result: "fake" }, "Only the joined");
    await probe(owner, { action: "message", agent_id: id, text: "Reuse the existing context" });
    check(
      (await subagentRecord(id)).state === "queued",
      "message revives a completed worker in its existing chat",
    );
    const filtered = await subagentSnapshot(
      null,
      { context: String(child.id), query: "fixture" },
      true,
    );
    check(
      filtered.agents.length === 1 && filtered.agents[0].id === id,
      "GUI filters match either parent or child Session plus task search",
    );
    const after = reports.messages.at(-1).id;
    const continued = await probe(owner, {
      action: "status",
      agent_id: id,
      after_message_id: after,
    });
    check(
      continued.messages.every((message) => message.id > after),
      "message cursors advance without consuming reports",
    );
    const paused = await subagentRecord(id);
    await recoverSubagents();
    check(
      (await subagentRecord(id)).state === "paused",
      "restart pauses work rather than reopening browsers or replaying prompts",
    );
    await run("UPDATE subagents SET state='starting' WHERE id=?", id);
    await recoverSubagents();
    check(
      (await subagentRecord(id)).state === "delivery_uncertain",
      "restart during dispatch suspends uncertain delivery",
    );
    await fails(owner, { action: "resume", agent_id: id }, "uncertain");
    await probe(owner, { action: "stop", agent_id: id });
    check(
      (await subagentRecord(id)).state === "stopped" &&
        !(await one("SELECT 1 FROM subagent_messages WHERE agent_id=? AND state='queued'", id)),
      "stop cancels queued work without deleting reports",
    );
    await fails(owner, { action: "resume", agent_id: id }, "no queued prompt");
    check(
      (await subagentRecord(id)).state === "stopped",
      "a failed resume does not mutate the worker",
    );
    // Exercise an acknowledged browser dispatch and the non-network final-answer fallback.
    await run("UPDATE subagents SET state='queued',chatgpt_chat_id='' WHERE id=?", id);
    await run(
      "INSERT INTO subagent_messages(agent_id,kind,text,state,created_at) VALUES(?,'bootstrap','','queued',?)",
      id,
      Date.now(),
    );
    const browserPage = { record: { open: true } };
    subagentPage = async () => browserPage;
    let sent = false,
      submittedText = "",
      inserted = 0;
    chatGoalRpc = async (_page, method, params) => {
      if (method === "Input.insertText") {
        submittedText = params.text;
        inserted++;
      }
      return {};
    };
    chatGoalEvaluate = async (_page, action) => {
      if (action === "send") {
        sent = true;
        controls.push(await reserveToolCall({ goalActivity: true, contextHandle: child.handle }));
        return { sent: true };
      }
      return {
        status: "ready",
        focused: true,
        users: [],
        draft: "",
        url: sent ? chatGoalUrl(goalFixtureId) : "about:blank",
      };
    };
    chatGoalReadReact = async (_page, input) =>
      input.expected_text
        ? { status: "ready", goal_receipt: "worker-receipt" }
        : {
            status: "ready",
            turn: { state: "complete", signature: "done" },
            answer: "Public final answer",
            model_id: "fixture-model",
          };
    const pending = await one(
      "SELECT * FROM subagent_messages WHERE agent_id=? AND state='queued' ORDER BY id LIMIT 1",
      id,
    );
    await subagentSubmit(await subagentRecord(id), pending);
    check(
      sent &&
        inserted === 1 &&
        submittedText === subagentBrief(await subagentRecord(id)) &&
        (await subagentRecord(id)).chatgpt_chat_id === goalFixtureId &&
        (await one("SELECT state FROM subagent_messages WHERE id=?", pending.id)).state ===
          "delivered",
      "plain bootstrap prompt and exact new-user receipt confirm delivery before binding the worker chat",
    );
    check(
      (await one("SELECT chatgpt_chat_id FROM contexts WHERE id=?", child.id)).chatgpt_chat_id ===
        goalFixtureId,
      "worker calls starting immediately after dispatch do not block the delivery receipt or Session binding",
    );
    for (const control of controls) await releaseToolCall(control);
    await subagentRun(await subagentRecord(id));
    check(
      (await probe(owner, { action: "status", agent_id: id })).agents[0].result ===
        "Public final answer",
      "a complete public React answer can finish a worker without exposing reasoning",
    );
    await probe(owner, { action: "message", agent_id: id, text: "Deferred by maintenance" });
    const queued = await one(
      "SELECT * FROM subagent_messages WHERE agent_id=? AND state='queued' ORDER BY id LIMIT 1",
      id,
    );
    const fakeRpc = chatGoalRpc;
    chatGoalRpc = async (...args) => {
      const result = await fakeRpc(...args);
      if (args[1] === "Input.insertText") toolCallGate = Promise.resolve();
      return result;
    };
    const callsBefore = controls.length;
    await subagentSubmit(await subagentRecord(id), queued);
    toolCallGate = previousGate;
    chatGoalRpc = fakeRpc;
    check(
      controls.length === callsBefore &&
        (await subagentRecord(id)).state === "queued" &&
        (await one("SELECT state FROM subagent_messages WHERE id=?", queued.id)).state === "queued",
      "maintenance arriving before dispatch defers the message without losing its queue state",
    );
    await run("UPDATE subagents SET state='running' WHERE id=?", id);
    const waiting = subagentTool(owner, { action: "wait", agent_id: id, timeout_ms: 1000 });
    await sleep(20);
    subagentChanged();
    check(
      (await waiting).status === "snapshot" && !subagentWaiters.size,
      "wait wakes on broker changes and releases its listener",
    );
    check(
      (await subagentTool(owner, { action: "wait", agent_id: id, timeout_ms: 5 })).status ===
        "timeout",
      "bounded wait returns a current snapshot on timeout",
    );
    await run("UPDATE subagents SET state='completed' WHERE id=?", id);
    uiState.currentSection = "subagents";
    uiState.subagents.openRowId = id;
    await handleUiInput({ type: "input", id: "subagentMessage", value: "Draft message" });
    await handleUiInput({
      type: "inputs",
      items: [{ id: "subagentMessage", value: "Newer draft" }],
    });
    check(
      uiState.subagents.message === "Newer draft",
      "single and batched React input preserve the worker message draft",
    );
    const previousVisibility = uiRenderVisible;
    uiRenderVisible = true;
    const view = await renderUiView(uiRenderGeneration);
    uiRenderVisible = previousVisibility;
    check(
      !!nativeProjection(view, uiState.native).tree,
      "the Subagents GUI renders populated worker detail and report history",
    );
    await writeFile(
      join(APP_DIR, "subagent-page.json"),
      JSON.stringify({
        section: "subagents:populated",
        projection: nativeProjection(view, uiState.native),
      }),
    );
    const beforeCleanup = (await one("SELECT COUNT(*) n FROM subagents")).n;
    await clearOperationalDatabase();
    check(
      (await one("SELECT COUNT(*) n FROM subagents")).n === beforeCleanup,
      "operational history cleanup preserves functional subagent state/reports",
    );
  } finally {
    toolCallGate = previousGate;
    for (const control of controls) await releaseToolCall(control);
    subagentSchedule = schedule;
    subagentPage = page;
    chatGoalEvaluate = evaluate;
    chatGoalReadReact = readReact;
    chatGoalRpc = rpc;
    if (subagentTimer) clearInterval(subagentTimer);
    subagentTimer = null;
    subagentPages.clear();
    for (const wake of [...subagentWaiters]) wake();
    await run("DELETE FROM subagents WHERE parent_context_id=?", owner.id);
    uiState.currentSection = "dashboard";
    uiState.subagents.openRowId = "";
  }
}
