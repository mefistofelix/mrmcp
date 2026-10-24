// Real HTTP/OAuth/stdio fixtures, isolated catalogs and database. No external
// provider, account, personal browser or credential is used.
{
  const catalog = await readTextFile(MCP_CATALOG_PATH);
  const pages = [];
  const previousSection = uiState.currentSection,
    previousVisibility = uiRenderVisible;
  const capture = async (section) => {
    uiState.currentSection = "mcp";
    uiRenderVisible = true;
    pages.push({
      section,
      projection: nativeProjection(await renderUiView(uiRenderGeneration), uiState.native),
    });
  };
  let expectedAuthorization = "Bearer fixture-token";
  let requests = 0,
    initialized = 0,
    refreshed = 0,
    registrations = 0;
  let challenge = "",
    redirect = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: origin + "/mcp",
          authorization_servers: [origin],
          scopes_supported: ["tools"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: origin + "/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register") {
        registrations++;
        const body = await request.json();
        redirect = body.redirect_uris[0];
        return Response.json({ client_id: "fixture-client", redirect_uris: [redirect] });
      }
      if (url.pathname === "/authorize") {
        challenge = url.searchParams.get("code_challenge");
        if (
          url.searchParams.get("resource") !== origin + "/mcp" ||
          url.searchParams.get("redirect_uri") !== redirect
        )
          return new Response("Invalid authorization request", { status: 400 });
        const callback = new URL(redirect);
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", origin);
        return new Response(null, { status: 302, headers: { location: callback.href } });
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "refresh_token") {
          refreshed++;
          await sleep(20);
          return Response.json({
            access_token: "oauth-refreshed",
            refresh_token: "refresh-next",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (
          createHash("sha256").update(body.get("code_verifier")).digest("base64url") !==
            challenge ||
          body.get("resource") !== origin + "/mcp" ||
          body.get("redirect_uri") !== redirect
        )
          return new Response("PKCE mismatch", { status: 400 });
        return Response.json({
          access_token: "oauth-initial",
          refresh_token: "refresh-first",
          token_type: "Bearer",
          expires_in: 1,
        });
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/legacy")
        return new Response(null, { status: 404 });
      requests++;
      const authorization =
        request.headers.get("authorization") || request.headers.get("x-api-key") || "";
      if (authorization !== expectedAuthorization)
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      const packet = await request.json();
      if (!packet.method || packet.id == null) return new Response(null, { status: 202 });
      const respond = (result) => Response.json({ jsonrpc: "2.0", id: packet.id, result });
      if (packet.method === "server/discover") {
        if (url.pathname === "/legacy")
          return Response.json({
            jsonrpc: "2.0",
            id: packet.id,
            error: { code: -32601, message: "Initialize first" },
          });
        return respond({ supportedVersions: [MCP_MODERN_PROTOCOL], capabilities: { tools: {} } });
      }
      if (packet.method === "initialize") {
        initialized++;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: packet.id,
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "fixture", version: "1" },
              capabilities: { tools: {} },
            },
          },
          { headers: { "mcp-session-id": "upstream-fixture-session" } },
        );
      }
      if (
        url.pathname === "/legacy" &&
        request.headers.get("mcp-session-id") !== "upstream-fixture-session"
      )
        return new Response(null, { status: 400 });
      if (packet.method === "tools/list")
        return respond({
          tools: [
            {
              name: "fixture_remote",
              description: "Fixture remote tool",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            { name: "memory_find", inputSchema: { type: "object", properties: {} } },
          ],
        });
      if (packet.params?.arguments?.text === "slow") {
        await sleep(1500);
        return respond({ content: [] });
      }
      if (packet.params?.arguments?.text === "malformed")
        return new Response("invalid JSON", { headers: { "content-type": "application/json" } });
      const response = {
        jsonrpc: "2.0",
        id: packet.id,
        result: {
          content: [{ type: "text", text: "Fixture result" }],
          structuredContent: packet.params || {},
        },
      };
      const data = JSON.stringify(response);
      return new Response(
        new ReadableStream({
          async start(controller) {
            const progress =
              'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\n\r\n';
            controller.enqueue(
              enc.encode(progress + "event: message\r\ndata: " + data.slice(0, 12)),
            );
            await sleep(5);
            controller.enqueue(enc.encode(data.slice(12) + "\r\n\r\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const origin = "http://127.0.0.1:" + server.port;
  const selection = {
    context: await one("SELECT * FROM contexts WHERE handle=?", handle),
    root: unassignedWorkspaceRoot(p),
  };
  const execution = { selection, logId: 42 };
  const row = normalizeMcpEntry({ logical_name: "fixture-http", http: { url: origin + "/mcp" } });
  const failure = async (operation) => {
    try {
      await operation();
      return "";
    } catch (error) {
      return errorMessage(error);
    }
  };
  try {
    await uiOperation("mcp/save", { name: row.name, http: row.http });
    check(
      (await readMcpConfig()).find((item) => item.name === row.name).exposure === "exec",
      "MCP default exposure is exec only",
    );
    check(requests === 0, "saving and discovering remote definitions opens no connection");
    await dispatchUiInput({ type: "action", action: "new-command", dataset: { catalog: "mcp" } });
    await dispatchUiInput({
      type: "submit",
      formId: "mcpForm",
      values: {
        mcName: "fixture-gui",
        mcTransport: "http",
        mcUrl: origin + "/mcp",
        mcEnabled: true,
      },
    });
    const guiRow = (await readMcpConfig()).find((item) => item.name === "fixture-gui");
    check(
      guiRow?.http?.url === row.http.url && uiState.dialog === null,
      "native form submission creates a remote definition without auxiliary JSON configuration",
    );
    await dispatchUiInput({ type: "action", action: "mcp-auth", dataset: { name: guiRow.name } });
    await dispatchUiInput({
      type: "submit",
      formId: "mcpAuthForm",
      values: {
        maType: "bearer",
        maToken: "gui-private-token",
      },
    });
    check(
      mcpAuth(guiRow).token === "gui-private-token" &&
        !uiState.dialog.data.token &&
        !(await readTextFile(MCP_CATALOG_PATH)).includes("gui-private-token"),
      "native authentication form saves credentials only in Turso and clears secret drafts",
    );
    await uiOperation("mcp/save", {
      name: "fixture-gui-renamed",
      old_name: guiRow.name,
      http: guiRow.http,
    });
    const renamed = (await readMcpConfig()).find((item) => item.name === "fixture-gui-renamed");
    check(
      mcpAuth(renamed).token === "gui-private-token" && !mcpData("auth", guiRow.name).token,
      "renaming preserves database credentials and removes the orphaned credential key",
    );
    await uiOperation("mcp/save", {
      name: renamed.name,
      old_name: renamed.name,
      http: { url: origin + "/other" },
    });
    check(
      mcpAuth((await readMcpConfig()).find((item) => item.name === renamed.name)).type === "none",
      "editing an endpoint never forwards the previous endpoint credentials",
    );
    await uiOperation("mcp/delete", { name: renamed.name });
    const anonymous = await failure(() =>
      execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution),
    );
    check(
      anonymous.includes("401") &&
        mcpData("status", row.name).auth_sent === false &&
        mcpData("status", row.name).auth_state === "authentication_required",
      "anonymous 401 is distinguished from network failure",
    );
    await mcpSaveAuth(row, { type: "bearer", token: "fixture-token" });
    const actual = await call("exec_mcp", {
      mcp: row.name,
      request: {
        id: "caller-id",
        method: "tools/call",
        params: { name: "fixture_remote", arguments: { text: "Hello" } },
      },
    });
    check(
      actual.success &&
        actual.response.id === "caller-id" &&
        actual.response.result.structuredContent.arguments.text === "Hello",
      "real MCP dispatcher proxies streamed HTTP responses and restores the caller id",
    );
    check(
      mcpData("status", row.name).auth_sent &&
        mcpData("status", row.name).auth_state === "authenticated",
      "GUI observations distinguish successful authenticated requests",
    );
    check(
      !(await readTextFile(MCP_CATALOG_PATH)).includes("fixture-token"),
      "GUI authentication is stored only in the database",
    );
    const basic = "Basic " + Buffer.from("user:password").toString("base64");
    expectedAuthorization = basic;
    await mcpSaveAuth(row, { type: "basic", username: "user", password: "password" });
    check(
      (await execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution)).success,
      "Basic authentication reaches the remote server",
    );
    expectedAuthorization = "header-secret";
    await mcpSaveAuth(row, { type: "headers", headers: { "X-Api-Key": "header-secret" } });
    check(
      (await execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution)).success,
      "custom header authentication reaches the remote server",
    );
    expectedAuthorization = "Bearer fixture-token";
    await mcpSaveAuth(row, { type: "bearer", token: "fixture-token" });
    await uiOperation("mcp/save", { name: "fixture-legacy", http: { url: origin + "/legacy" } });
    await mcpSaveAuth(
      normalizeMcpEntry({ logical_name: "fixture-legacy", http: { url: origin + "/legacy" } }),
      { type: "bearer", token: "fixture-token" },
    );
    const legacy = await call("exec_mcp", {
      mcp: "fixture-legacy",
      request: { method: "tools/list" },
    });
    check(
      legacy.success && initialized === 1,
      "remote initialization fallback negotiates and preserves the upstream session header",
    );
    const count = await mcpRefreshTools(
      (await readMcpConfig()).find((item) => item.name === row.name),
    );
    check(count.count === 2, "explicit refresh persists the complete upstream tool inventory");
    await uiOperation("mcp/save", {
      name: row.name,
      old_name: row.name,
      http: row.http,
      exposure: "tools",
    });
    const mergedRow = (await readMcpConfig()).find((item) => item.name === row.name);
    check(
      mcpInventory(mergedRow).length === 2,
      "changing exposure reuses descriptors without a new upstream request",
    );
    await mcpRefreshTools(mergedRow);
    const descriptors = await serverTools(p);
    check(
      descriptors.some((tool) => tool.name === "fixture_remote") &&
        descriptors.filter((tool) => tool.name === "memory_find").length === 1,
      "merge publishes a unique upstream tool while preserving the MrMCP tool on conflict",
    );
    check(
      (await mcpRows())
        .find((item) => item.name === row.name)
        .merge_warnings.some((item) => item.tool === "memory_find"),
      "GUI warns about a built-in tool collision",
    );
    const mergedCall = await call("fixture_remote", { text: "Merged invocation" });
    check(
      mergedCall.success &&
        !Object.hasOwn(mergedCall.result.structuredContent.arguments, "chat_session"),
      "merged tool dispatch removes only the MrMCP Session capability before upstream forwarding",
    );
    await uiOperation("mcp/save", {
      name: "fixture-second",
      http: { url: origin + "/mcp" },
      exposure: "tools",
    });
    const second = (await readMcpConfig()).find((item) => item.name === "fixture-second");
    await mcpSaveAuth(second, { type: "bearer", token: "fixture-token" });
    await mcpRefreshTools(second);
    check(
      !(await serverTools(p)).some((tool) => tool.name === "fixture_remote") &&
        (await mcpRows()).filter((item) =>
          item.merge_warnings.some((warning) => warning.tool === "fixture_remote"),
        ).length === 2,
      "collisions between merged servers warn both entries and publish neither ambiguous name",
    );
    await capture("mcp:collisions");
    await uiOperation("mcp/delete", { name: second.name });
    check(
      (await serverTools(p)).some((tool) => tool.name === "fixture_remote"),
      "removing a collision restores the unique cached descriptor",
    );
    const timeout = await failure(() =>
      execMcp(
        p,
        {
          mcp: row.name,
          timeout_ms: 100,
          request: {
            method: "tools/call",
            params: { name: "fixture_remote", arguments: { text: "slow" } },
          },
        },
        execution,
      ),
    );
    check(
      timeout && mcpData("status", row.name).network_error.includes("cancelled or timed out"),
      "request timeouts abort HTTP work and update diagnostics",
    );
    check(
      (await failure(() =>
        execMcp(
          p,
          {
            mcp: row.name,
            request: {
              method: "tools/call",
              params: { name: "fixture_remote", arguments: { text: "malformed" } },
            },
          },
          execution,
        ),
      )) &&
        mcpData("status", row.name).protocol_error &&
        !mcpData("status", row.name).network_error,
      "invalid upstream JSON is a protocol error rather than a network or authentication error",
    );
    await mcpSaveAuth(row, { type: "oauth", scope: "tools" });
    const login = await mcpStartOAuth(row);
    const authorize = await fetch(login.url, { redirect: "manual" });
    const callback = authorize.headers.get("location");
    const wrong = new URL(callback);
    wrong.searchParams.set("state", "wrong-state");
    check((await fetch(wrong)).status === 400, "OAuth callback rejects an incorrect state");
    await fetch(callback);
    for (let i = 0; i < 100 && mcpOAuthJobs.has(row.name); i++) await sleep(10);
    check(
      registrations === 1 && mcpAuth(row).grant?.access_token === "oauth-initial",
      "real OAuth metadata, DCR, loopback callback and PKCE exchange persist the grant",
    );
    expectedAuthorization = "Bearer oauth-refreshed";
    const concurrent = await Promise.all(
      [1, 2].map(() => execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution)),
    );
    check(
      concurrent.every((result) => result.success) &&
        refreshed === 1 &&
        mcpAuth(row).grant.refresh_token === "refresh-next",
      "concurrent requests serialize OAuth refresh and preserve rotated tokens in the database",
    );
    const again = await mcpStartOAuth(row);
    await fetch((await fetch(again.url, { redirect: "manual" })).headers.get("location"));
    for (let i = 0; i < 100 && mcpOAuthJobs.has(row.name); i++) await sleep(10);
    check(
      registrations === 1 && mcpAuth(row).grant.access_token === "oauth-initial",
      "OAuth reconnection reuses its registered client and exact loopback callback",
    );
    await execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution);
    const revoked = mcpAuth(row);
    revoked.grant.access_token = "revoked-token";
    await setCfg(mcpDataKey("auth", row.name), JSON.stringify(revoked));
    const refreshesBefore401 = refreshed;
    const after401 = await Promise.all(
      [1, 2].map(() => execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution)),
    );
    check(
      after401.every((result) => result.success) && refreshed === refreshesBefore401 + 1,
      "parallel HTTP 401 responses share one refresh and reuse the newly issued token",
    );
    await handleUiAction({ action: "edit-command", dataset: { catalog: "mcp", name: row.name } });
    check(
      uiState.dialog.kind === "mcp" && uiState.dialog.data.transport === "http",
      "GUI edits remote MCP definitions with dedicated structured controls",
    );
    await capture("dialog:mcp-remote");
    await handleUiAction({ action: "mcp-auth", dataset: { name: row.name } });
    check(
      uiState.dialog.kind === "mcp-auth" &&
        !JSON.stringify(uiState.dialog.data).includes("oauth-refreshed"),
      "GUI auth drafts never copy saved OAuth tokens into input fields",
    );
    await capture("dialog:mcp-auth");
    const localProgram = `
      const readline = require('node:readline').createInterface({ input: process.stdin });
      readline.on('line', line => {
        const request = JSON.parse(line);
        if (request.id == null) return;
        let result;
        if (request.method === 'initialize') {
          result = { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
        } else if (request.method === 'tools/list') {
          result = { tools: [{ name: 'fixture_local', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
        } else {
          result = {
            content: [{ type: 'text', text: 'Local result' }],
            structuredContent: {
              ...request.params.arguments, cwd: process.cwd(), secret: process.env.FIXTURE_MCP_SECRET,
            },
          };
        }
        console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      });
    `;
    await uiOperation("mcp/save", {
      name: "fixture-local",
      path: RUNTIME_OS === "windows" ? "probe.exe" : "probe",
      exposure: "tools",
      stdio: { args: ["-e", localProgram], persistence: "command" },
    });
    const local = (await readMcpConfig()).find((item) => item.name === "fixture-local");
    await handleUiAction({ action: "mcp-auth", dataset: { name: local.name } });
    await dispatchUiInput({
      type: "submit",
      formId: "mcpAuthForm",
      values: {
        maType: "environment",
        maEnvironment: JSON.stringify({ FIXTURE_MCP_SECRET: "stdio-private-key" }),
      },
    });
    await mcpRefreshTools(local);
    const freshSession = await invoke("init_chat_session", {});
    const localResult = await invoke("fixture_local", {
      chat_session: freshSession.chat_session,
      text: "Local merge",
    });
    check(
      localResult.result.structuredContent.text === "Local merge" &&
        localResult.result.structuredContent.secret === "stdio-private-key" &&
        localResult.result.structuredContent.cwd.startsWith(join(DATA_DIR, "mcp", "files")),
      "local stdio tools merge through the real dispatcher without a selected Workspace or wrapper files",
    );
    check(
      !(await readTextFile(MCP_CATALOG_PATH)).includes("stdio-private-key") &&
        mcpData("status", local.name).auth_sent,
      "per-server stdio credentials come from Turso and are visible only as supplied in diagnostics",
    );
    await handleUiAction({ action: "edit-command", dataset: { catalog: "mcp", name: local.name } });
    await capture("dialog:mcp-local");
    await writeFile(join(APP_DIR, "mcp-pages.json"), JSON.stringify(pages));
    uiState.dialog = null;
    await server.stop(true);
    check(
      (await failure(() =>
        execMcp(p, { mcp: row.name, request: { method: "tools/list" } }, execution),
      )) &&
        mcpData("status", row.name).network_error &&
        !mcpData("status", row.name).auth_error,
      "connection failures remain distinct from an authentication rejection",
    );
  } finally {
    for (const job of mcpOAuthJobs.values()) job.cancel();
    closeMcpRemoteConnections();
    await server.stop(true);
    await replaceTextFile(MCP_CATALOG_PATH, catalog);
    serverToolCache.clear();
    const entries = [...mcpStdioPool.values()];
    for (const entry of entries) entry.close("MCP fixtures finished");
    await Promise.allSettled(entries.map((entry) => entry.rec.done));
    uiState.dialog = null;
    uiState.currentSection = previousSection;
    uiRenderVisible = previousVisibility;
  }
}
