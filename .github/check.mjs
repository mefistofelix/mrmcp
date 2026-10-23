// Isolated integration checks against the real backend/tool dispatcher. The
// copied test entry exits before public listeners or browser goal work starts.
import * as fs from "node:fs/promises";
import { resolve, join } from "node:path";
function replaceFixture(source, pattern, replacement) {
  const updated = source.replace(pattern, replacement);
  if (updated === source) throw new Error("Test instrumentation point missing: " + pattern);
  return updated;
}
const root = resolve(import.meta.dir, "..");
await fs.mkdir(join(root, "build"), { recursive: true });
const directory = await fs.mkdtemp(join(root, "build", "bun-check-"));
const semantic = process.argv.includes("--semantic");
const standalone = process.argv.includes("--standalone");
for (const file of [
  "commands.yaml",
  "mcp.yaml",
  "guided_prompts.yaml",
  "proxies.yaml",
  "search.yaml",
  "LICENSE",
])
  await fs.copyFile(join(root, file), join(directory, file));
await fs.cp(join(root, "assets"), join(directory, "assets"), { recursive: true });
const suite = String.raw`
let checks = 0;
let id = 0;
const check = (ok, label) => {
  if (!ok) throw new Error(label);
  checks++;
};
const p = await serverConfig();
await run(
  "UPDATE server_config SET basic_enabled=1,basic_username='probe',basic_secret_enc=?,oauth=0 WHERE id=?",
  "test-only",
  p.id,
);
serverConfigCache = null;
serverToolCache.clear();
const invoke = async (name, args = {}, meta = null) => {
  if (process.env.MRMCP_TEST_TRACE === "1") console.log("Tool: " + name);
  const request = new Request("https://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MCP_MODERN_PROTOCOL,
      authorization: "Basic " + btoa("probe:test-only"),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  const response = await mcpHandler(request, { remoteAddr: { hostname: "127.0.0.1" } });
  const packet = await response.json();
  check(!packet.error && !packet.result?.isError, name + ": " + JSON.stringify(packet));
  if (name === "document_grep") {
    const schema = (await serverTools(await serverConfig(), true)).find(
      (tool) => tool.name === name,
    ).outputSchema;
    const error = inputSchemaError(schema, packet.result.structuredContent);
    check(!error, "actual document_grep output schema: " + error);
  }
  return packet.result.structuredContent;
};
if (process.env.MRMCP_TEST_RESTART === "1") {
  const context = await one("SELECT handle FROM contexts ORDER BY id LIMIT 1");
  const workerState = await invoke("subagents", { chat_session: context.handle, action: "status" });
  check(workerState.agents.some((agent) => agent.id === "agent_restart_fixture" && agent.result === "Durable worker result"),
    "subagent state and reports survive a full backend restart");
  const persisted = await invoke("document_grep", {
    chat_session: context.handle,
    query: "scopefixture",
    include: ["rag-scope/*.txt"],
    gitignore: false,
    mode: "fulltext",
  });
  check(
    persisted.reindexed_files === 0 && persisted.results.length > 0,
    "Turso index survives a full backend restart",
  );
  if (process.env.MRMCP_TEST_SEMANTIC === "1") {
    const cached = await invoke("document_grep", {
      chat_session: context.handle,
      query: "dog playing outside",
      include: ["canine.txt", "bank.txt"],
      mode: "vector",
    });
    check(
      cached.reindexed_files === 0 && cached.results[0]?.path === "canine.txt",
      "semantic index and cached model survive a full backend restart",
    );
    if (await fs.stat(join(APP_DIR, "fixture", "ocr.png")).catch(() => null)) {
      const ocr = await invoke("document_grep", {
        chat_session: context.handle,
        query: "Native",
        include: ["ocr.png"],
        mode: "fulltext",
      });
      check(
        ocr.reindexed_files === 0 && ocr.results.length > 0,
        "Paddle OCR index and profile survive backend restart",
      );
    }
  }
  await db.close();
  console.log(JSON.stringify({ ok: true, restart: true, checks }));
  process.exit(0);
}
for (const tool of await serverTools(await serverConfig(), true))
  check(!validateToolDescriptor(tool).length, "descriptor " + tool.name);
check(
  !(await serverTools(await serverConfig(), true)).some(
    (tool) => tool.name === "source_code_search",
  ),
  "retired AST tool is absent from discovery",
);
const session = await invoke("init_chat_session");
const handle = session.chat_session;
check(typeof handle === "string" && handle.startsWith("ctx_"), "opaque Session");
const workspace = join(APP_DIR, "fixture");
await fs.mkdir(workspace, { recursive: true });
await run(
  "INSERT INTO roots(server_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
  p.id,
  "Fixture",
  workspace,
  1,
  Date.now(),
);
await invoke("open_workspace", { chat_session: handle, name: "Fixture" });
const call = async (name, args = {}) => await invoke(name, { chat_session: handle, ...args });
const startingControl = await reserveToolCall({ contextHandle: handle });
let maintenanceStarted = false;
let allowMaintenance;
let announceMaintenance;
const maintenanceEntered = new Promise((resolve) => {
  announceMaintenance = resolve;
});
const maintenanceFinish = new Promise((resolve) => {
  allowMaintenance = resolve;
});
const maintenanceProbe = withToolCallsDrained("fixture", async () => {
  maintenanceStarted = true;
  announceMaintenance();
  await maintenanceFinish;
});
await sleep(0);
check(
  !maintenanceStarted,
  "maintenance waits for a Tool Call reserved before async initialization",
);
let nextReserved = false;
const nextControlTask = reserveToolCall({ contextHandle: handle }).then((control) => {
  nextReserved = true;
  return control;
});
await releaseToolCall(startingControl);
await maintenanceEntered;
check(!nextReserved, "new Tool Call reservations wait behind maintenance");
allowMaintenance();
await maintenanceProbe;
await releaseToolCall(await nextControlTask);
const invalidControl = await reserveToolCall({ contextHandle: "invalid-fixture" });
try {
  await contextControlToolResult(
    p,
    "list_workspaces",
    { chat_session: "invalid-fixture" },
    { kind: "invalid", supplied_handle: "invalid-fixture" },
    null,
    false,
    null,
    null,
    invalidControl.log_id,
  );
  check(
    lastToolCallId === invalidControl.log_id &&
      !!(await one("SELECT 1 FROM logs WHERE id=? AND status='invalid'", invalidControl.log_id)),
    "invalid Session logs retain their reserved in-flight Tool Call id",
  );
} finally {
  await releaseToolCall(invalidControl);
}
for (const [path, read, write] of [
  [COMMANDS_PATH, readCommandConfig, writeCommandConfig],
  [GUIDED_PROMPTS_PATH, readGuidedPromptConfig, writeGuidedPromptConfig],
  [MCP_CATALOG_PATH, readMcpConfig, writeMcpConfig],
]) {
  const original = await readTextFile(path);
  try {
    const rows = await read();
    await write(rows);
    check(
      JSON.stringify(await read()) === JSON.stringify(rows),
      "catalog replacement preserves ordered normalized data: " + basename(path),
    );
  } finally {
    await replaceTextFile(path, original);
  }
}
const blockedTarget = join(workspace, "catalog-replacement-directory");
await fs.mkdir(blockedTarget);
let replacementFailed = false;
try {
  await replaceTextFile(blockedTarget, "fixture");
} catch {
  replacementFailed = true;
}
check(
  replacementFailed &&
    (await fs.stat(blockedTarget)).isDirectory() &&
    !(await fs.readdir(workspace)).some(
      (name) => name.startsWith("catalog-replacement-directory.") && name.endsWith(".tmp"),
    ),
  "failed catalog replacement preserves the destination and cleans its temporary file",
);
const bound = await Promise.all(Array.from({ length: 24 }, (_, i) => one("SELECT ? AS value", i)));
check(
  bound.every((row, i) => row.value === i),
  "concurrent SQL executions retain their own bound arguments",
);
let entered;
const inTransaction = new Promise((resolve) => {
  entered = resolve;
});
const rollback = withDbTransaction(async () => {
  await run("INSERT INTO metrics(name,value) VALUES('rollback-fixture',1)");
  entered();
  await sleep(20);
  throw Error("rollback-fixture");
}).catch((error) => error.message);
await inTransaction;
const independent = run("INSERT INTO metrics(name,value) VALUES('outside-fixture',1)");
await Promise.all([rollback, independent]);
check(
  !(await one("SELECT 1 FROM metrics WHERE name='rollback-fixture'")) &&
    !!(await one("SELECT 1 FROM metrics WHERE name='outside-fixture'")),
  "transaction rollback cannot absorb a concurrent independent write",
);
await run("DELETE FROM metrics WHERE name='outside-fixture'");
let deferred;
await withDbTransaction(async () => {
  deferred = new Promise((resolve, reject) =>
    setTimeout(() => one("SELECT 42 n").then(resolve, reject), 10),
  );
});
check(
  (await deferred).n === 42,
  "deferred work cannot reuse a completed async-local transaction handle",
);
const proxyOriginal = await readTextFile(PROXIES_PATH);
try {
  const configuration = parseYaml(proxyOriginal);
  configuration.proxies = ["direct", "http://127.0.0.1:32101", "http://127.0.0.1:32102"];
  configuration.proxy_lists = [];
  await writeFile(PROXIES_PATH, stringifyYaml(configuration));
  const picked = await Promise.all(
    Array.from({ length: 3 }, () => call("proxy_get", { action: "pick", mode: "round_robin" })),
  );
  check(
    new Set(picked.map((result) => result.proxies[0].proxy_id)).size === 3,
    "concurrent round-robin calls reserve distinct least-used proxies",
  );
  const proxy_id = picked[0].proxies[0].proxy_id;
  await Promise.all([
    call("proxy_get", { action: "report", proxy_id, success: false }),
    call("proxy_get", { action: "report", proxy_id, success: false }),
  ]);
  check(
    (await proxyStats(proxy_id)).consecutive_failures === 2,
    "concurrent failure reports preserve proxy counters",
  );
} finally {
  await writeFile(PROXIES_PATH, proxyOriginal);
}
await run("UPDATE server_config SET oauth=1 WHERE id=?", p.id);
serverConfigCache = null;
const oauthCode = "concurrency-code";
const verifier = "concurrency-verifier";
const client = "concurrency-client";
const redirect = "https://example.test/callback";
await run(
  "INSERT INTO oauth_clients(client_id,name,redirects_json,created_at) VALUES(?,?,?,?)",
  client,
  "fixture",
  JSON.stringify([redirect]),
  Date.now(),
);
await run(
  "INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,server_id,resource,scope,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  await sha256(oauthCode),
  client,
  redirect,
  await sha256(verifier),
  p.id,
  "https://localhost/mcp",
  "mcp",
  Date.now() + 60000,
);
const redeem = () =>
  mcpHandler(
    new Request("https://localhost/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: oauthCode,
        client_id: client,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    }),
    { remoteAddr: { hostname: "127.0.0.1" } },
  );
const redeemed = await Promise.all([redeem(), redeem()]);
check(
  redeemed.filter((response) => response.status === 200).length === 1 &&
    redeemed.filter((response) => response.status === 400).length === 1,
  "authorization codes remain single-use under concurrent exchange",
);
await run("UPDATE server_config SET oauth=0 WHERE id=?", p.id);
serverConfigCache = null;
const written = await call("fs_write", {
  files: [
    { path: "a/note.txt", content: "Caffè\nBun runtime\n" },
    { path: "a/empty.txt", content: "" },
  ],
});
check(written.succeeded === 2, "write batch");
const read = await call("fs_read", {
  files: [{ path: "a/note.txt" }, { path: "missing" }, { path: "a/empty.txt" }],
});
check(
  read.files[0].content.includes("Caffè") && read.files[2].content === "",
  "UTF8 and empty read",
);
const glob = await call("fs_glob", { include: ["**/*.txt"], metadata: true });
check(
  glob.entries?.length === 2 || glob.paths?.length === 2,
  "glob stat metadata " + JSON.stringify(glob),
);
const grep = await call("fs_grep", { pattern: "Bun", include: ["**/*.txt"] });
check(grep.matches?.length || grep.files?.length, "grep");
const copied = await call("fs_copy", { entries: [{ from: "a", to: "b" }] });
check(copied.succeeded === 1, "recursive copy");
const moved = await call("fs_move", { entries: [{ from: "b/note.txt", to: "b/moved.txt" }] });
check(moved.succeeded === 1, "move");
const trash = await call("fs_trash", { paths: ["b"] });
check(trash.succeeded === 1, "trash");
check((await call("fs_untrash", { trash_id: trash.trash_id })).succeeded === 1, "restore");
await call("memory_set", { scope: "session", key: "runtime", value: '{"bun":true}', json: true });
check(
  (await call("memory_find", { scope: "session", key: "runtime" })).memories?.length === 1,
  "memory JSON",
);
await setCfg("tool_call_storage", "memory");
await call("memory_find", { scope: "session", key: "runtime" });
await flushDeferredLogWork();
check(
  (await one("SELECT COUNT(*) n FROM logs_fts_memory WHERE fts_match(content,?)", '"runtime"')).n >
    0,
  "Turso fulltext indexes volatile Tool Call payloads",
);
await setCfg("tool_call_storage", "disk");
const pub = await call("publish", {
  text: "Bun publication",
  mime_type: "text/plain",
  filename: "probe.txt",
});
check(!!pub.uri, "publish");
const record = await one("SELECT * FROM published WHERE id=?", pub.id);
if (record) {
  const res = await publishedContentResponse(new Request(pub.uri), new URL(pub.uri));
  check((await res.text()).includes("Bun publication"), "published streaming");
}
const js = await call("js", { code: "globalThis.counter=41; counter+1" });
check(JSON.stringify(js).includes("42"), "JS worker result");
const js2 = await call("js", { code: "counter+=1;counter" });
check(JSON.stringify(js2).includes("42"), "JS kernel persistence");
await call("js_reset");
const testBun = process.env.MRMCP_TEST_BUN || process.execPath;
const exec = await call("exec", {
  program: testBun,
  args: ["-e", "console.log('bun-process-ok')"],
  timeout_ms: 10000,
});
check(JSON.stringify(exec).includes("bun-process-ok"), "foreground process streams");
await run(
  "INSERT INTO custom_tools(server_id,name,description,command,created_at) VALUES(?,?,?,?,?)",
  p.id,
  "fixture_custom",
  "Existing registered tool",
  JSON.stringify([testBun, "-e", "console.log('custom-tool-preserved')"]),
  Date.now(),
);
serverToolCache.clear();
try {
  const custom = await call("fixture_custom");
  check(
    JSON.stringify(custom).includes("custom-tool-preserved"),
    "persisted custom MCP tools still execute after unused GUI editor routes are removed",
  );
} finally {
  await run("DELETE FROM custom_tools WHERE server_id=? AND name='fixture_custom'", p.id);
  serverToolCache.clear();
}
const started = await call("exec_start", {
  program: testBun,
  args: ["-e", "console.log('persistent-ok')"],
  operation_id: "probe",
});
check(Number.isSafeInteger(started.exec_id), "persistent stable id");
await sleep(100);
const status = await call("exec_status", { exec_id: started.exec_id, output: "all" });
check(JSON.stringify(status).includes("persistent-ok"), "persistent output");
const mixedWrite = await call("fs_write", {
  files: [
    { path: "a", content: "must not replace a directory" },
    { path: "optional-read-fixture/new.txt", content: "optional read fixture" },
  ],
});
check(
  mixedWrite.failed === 1 && mixedWrite.succeeded === 1,
  "batch writes retain independent failures and allow absent destinations",
);
check(
  (await fs.stat(join(workspace, "a"))).isDirectory() &&
    (await readTextFile(join(workspace, "optional-read-fixture/new.txt"))) ===
      "optional read fixture",
  "failed optional reads preserve existing directories and successful sibling writes",
);
await writeFile(
  join(workspace, "sample.js"),
  "export function fibonacciCount(x) { return x+1; }\n",
);
const docs = await call("document_grep", {
  query: "runtime",
  include: ["a/*.txt"],
  mode: "fulltext",
});
check(docs.results?.length > 0, "rag.js/Turso fulltext");
const docsAgain = await call("document_grep", {
  query: "runtime",
  include: ["a/*.txt"],
  mode: "fulltext",
});
check(docsAgain.reindexed_files === 0, "document incremental reuse");
check(
  !(await fs.stat(join(docs.index_directory, "models", "embeddings")).catch(() => null)),
  "fulltext downloads no embedding model",
);
await fs.unlink(join(workspace, "a/note.txt"));
const pruned = await call("document_grep", {
  query: "runtime",
  include: ["a/*.txt"],
  mode: "fulltext",
});
check(pruned.removed_files === 1 && !pruned.results.length, "scoped document pruning");
await fs.mkdir(join(workspace, "rag-scope"), { recursive: true });
await writeFile(join(workspace, "rag-scope/visible.txt"), "scopefixture public content");
await writeFile(join(workspace, "rag-scope/private.txt"), "scopefixture private content");
const scopeBoth = await call("document_grep", {
  query: "scopefixture",
  include: ["rag-scope/*.txt"],
  mode: "fulltext",
});
check(
  scopeBoth.results.length === 2 && scopeBoth.engine === "rag.js" && scopeBoth.storage === "turso",
  "Rag engine and scope fixture",
);
await writeFile(join(workspace, "rag-scope/.gitignore"), "private.txt\n");
const ignored = await call("document_grep", {
  query: "scopefixture",
  include: ["rag-scope/*.txt"],
  mode: "fulltext",
});
check(
  ignored.results.length === 1 &&
    ignored.results[0].path === "rag-scope/visible.txt" &&
    ignored.removed_files === 1,
  "newly ignored stored document is pruned through public Rag API",
);
const outside = await call("document_grep", {
  query: "scopefixture",
  include: ["a/*.txt"],
  mode: "fulltext",
});
check(!outside.results.length, "stored out-of-scope hits stay excluded");
const override = await call("document_grep", {
  query: "scopefixture",
  include: ["rag-scope/*.txt"],
  gitignore: false,
  mode: "fulltext",
});
check(override.results.length === 2, "explicit gitignore override");
const bounded = await call("document_grep", {
  query: "scopefixture",
  include: ["rag-scope/*.txt"],
  gitignore: false,
  max_files: 1,
  mode: "fulltext",
});
check(
  bounded.truncated && bounded.results.length <= 1,
  "truncated traversal cannot return unvisited stored paths",
);
await writeFile(join(workspace, "rag-scope/filter.md"), "mimefixture markdown content");
await writeFile(join(workspace, "rag-scope/filter.txt"), "mimefixture plain text content");
const mime = await call("document_grep", {
  query: "mimefixture",
  include: ["rag-scope/filter.*"],
  mime: ["text/plain"],
  mode: "fulltext",
});
check(
  mime.results.length === 1 && mime.results[0].path === "rag-scope/filter.txt",
  "MIME selection filters actual indexed results",
);
const excluded = await call("document_grep", {
  query: "mimefixture",
  include: ["rag-scope/filter.*"],
  exclude: ["**/*.txt"],
  mode: "fulltext",
});
check(
  excluded.results.length === 1 && excluded.results[0].path === "rag-scope/filter.md",
  "glob exclusions filter actual indexed results",
);
await writeFile(join(workspace, "rag-scope/.gitignore"), "");
await writeFile(join(workspace, "rag-scope/literal[1].txt"), "bracketfixture literal path");
const literal = await call("document_grep", {
  query: "bracketfixture",
  path: "rag-scope/literal[1].txt",
  mode: "fulltext",
});
check(
  literal.results[0]?.path === "rag-scope/literal[1].txt" &&
    literal.results[0]?.citations?.[0]?.offsetUnit === "utf8-bytes",
  "literal paths and native Rag citations " + JSON.stringify(literal),
);
const originalSearch = await readTextFile(SEARCH_PATH);
const providerRequests = [];
const providerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json();
    providerRequests.push({ path: new URL(request.url).pathname, body });
    const vectors = body.input.map((text) => [1, text.length / 100, 1]);
    return Response.json(
      new URL(request.url).pathname === "/api/embed"
        ? { embeddings: vectors }
        : { data: vectors.map((embedding, index) => ({ index, embedding })) },
    );
  },
});
try {
  await writeFile(join(workspace, "rag-provider.txt"), "External embedding provider fixture");
  for (const provider of ["openai", "ollama"]) {
    const configuration = parseYaml(originalSearch);
    configuration.embedding = {
      provider,
      model: "fixture-model",
      endpoint: "http://127.0.0.1:" + providerServer.port,
      api_key: "fixture-only",
    };
    await writeFile(SEARCH_PATH, stringifyYaml(configuration));
    const remote = await call("document_grep", {
      query: "External",
      include: ["rag-provider.txt"],
      mode: "vector",
    });
    check(
      remote.results[0]?.path === "rag-provider.txt",
      "public Rag embedding callback " + provider,
    );
  }
  check(
    providerRequests.some((r) => r.path === "/embeddings") &&
      providerRequests.some((r) => r.path === "/api/embed"),
    "preserved external embedding protocols",
  );
} finally {
  await writeFile(SEARCH_PATH, originalSearch);
  providerServer.stop(true);
}
if (process.env.MRMCP_TEST_SEMANTIC === "1") {
  const pdfStream =
    "BT /F1 12 Tf 40 750 Td (Embeddedpdffixture preserves useful document text without image recognition or external OCR.) Tj ET";
  const pdfObjects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + pdfStream.length + " >>\nstream\n" + pdfStream + "\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  let pdfOffsets = [0];
  for (let n = 0; n < pdfObjects.length; n++) {
    pdfOffsets.push(pdf.length);
    pdf += n + 1 + " 0 obj\n" + pdfObjects[n] + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    pdfOffsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  await writeFile(join(workspace, "native-text.pdf"), pdf);
  const textPdf = await call("document_grep", {
    query: "Embeddedpdffixture",
    include: ["native-text.pdf"],
    mode: "fulltext",
  });
  check(
    textPdf.results[0]?.citations?.[0]?.pageStart === 1,
    "real searchable PDF text and page citation",
  );
  check(
    !(await fs.stat(join(textPdf.index_directory, "models", "paddle")).catch(() => null)),
    "searchable PDF avoids OCR and Paddle model download",
  );
  await writeFile(
    join(workspace, "canine.txt"),
    "A playful puppy runs happily through a green meadow. Dogs enjoy outdoor exercise.",
  );
  await writeFile(
    join(workspace, "bank.txt"),
    "The bank evaluates mortgages and interest rates for a long term loan.",
  );
  const vector = await call("document_grep", {
    query: "dog playing outside",
    include: ["canine.txt", "bank.txt"],
    mode: "vector",
  });
  check(
    vector.results[0]?.path === "canine.txt",
    "actual local semantic ranking " + JSON.stringify(vector),
  );
  const hybrid = await call("document_grep", {
    query: "puppy exercise",
    include: ["canine.txt", "bank.txt"],
    mode: "hybrid",
  });
  check(hybrid.results[0]?.path === "canine.txt", "actual hybrid ranking");
  await writeFile(
    join(workspace, "long.txt"),
    "Mortgage interest rates.\n".repeat(250) +
      "A puppy plays happily outside in a green meadow.".repeat(30),
  );
  const tail = await call("document_grep", {
    query: "puppy playing outside",
    include: ["long.txt"],
    mode: "vector",
    limit: 1,
  });
  check(
    tail.results[0]?.text.includes("puppy"),
    "long document tail remains searchable through rag.js chunks",
  );
  const ocrFixture = join(process.env.MRMCP_TEST_ROOT, "build", "retrieval", "ocr.png");
  if (await fs.stat(ocrFixture).catch(() => null)) {
    await fs.copyFile(ocrFixture, join(workspace, "ocr.png"));
    const ocr = await call("document_grep", {
      query: "Native",
      include: ["ocr.png"],
      mode: "fulltext",
    });
    check(
      ocr.results?.length > 0,
      "real PaddleOCR through Rag public provider " + JSON.stringify(ocr),
    );
    check(
      !!(await fs.stat(join(ocr.index_directory, "models", "paddle")).catch(() => null)),
      "Paddle models persist inside the Rag profile",
    );
    const again = await call("document_grep", {
      query: "Native",
      include: ["ocr.png"],
      mode: "fulltext",
    });
    check(
      again.reindexed_files === 0 && again.results.length > 0,
      "Paddle OCR index reuses extraction without reprocessing",
    );
    const configuration = await readTextFile(SEARCH_PATH);
    try {
      const settings = parseYaml(configuration);
      settings.ocr = "disabled";
      await writeFile(SEARCH_PATH, stringifyYaml(settings));
      const disabled = await call("document_grep", {
        query: "Native",
        include: ["ocr.png"],
        mode: "fulltext",
      });
      check(
        !disabled.results.length,
        "disabled OCR does not return another profile's recognized text",
      );
      if (RUNTIME_OS === "windows" || RUNTIME_OS === "darwin") {
        settings.ocr = "native";
        await writeFile(SEARCH_PATH, stringifyYaml(settings));
        const native = await call("document_grep", {
          query: "Native",
          include: ["ocr.png"],
          mode: "fulltext",
        });
        check(native.results.length > 0, "explicit native OCR remains supported");
      }
    } finally {
      await writeFile(SEARCH_PATH, configuration);
    }
  }
  const browser = { name: "bun-probe", headless: true };
  const version = await call("cdp_call", {
    calls: [{ browser, call: { method: "Browser.getVersion", params: {} } }],
  });
  check(JSON.stringify(version).includes("Chrome"), "real CDP browser launch");
  const dom = await call("cdp_call", {
    calls: [
      {
        browser,
        target: "fixture",
        call: {
          method: "Runtime.evaluate",
          params: {
            expression:
              "document.body.innerHTML='<button id=probe>Bun browser</button>'; document.querySelector('#probe').textContent",
            returnByValue: true,
          },
        },
      },
    ],
  });
  check(JSON.stringify(dom).includes("Bun browser"), "real CDP evaluate");
  const find = await call("cdp_call", {
    calls: [
      {
        browser,
        target: "fixture",
        call: { method: "_.find", params: { xpath: "//button[@id='probe']" } },
      },
    ],
  });
  check(JSON.stringify(find).includes("Bun browser"), "CDP extension method");
  const goalBrowserRecord = cdpBrowsers.get(browser.name);
  const goalTarget = await cdpEnsureTarget(goalBrowserRecord, { name: "goal-model-fixture", initialize: false });
  const goalPage = { record: goalBrowserRecord, ...goalTarget };
  const goalEnabledBefore = getCfg("chat_goals_enabled", "1");
  const goalRequests = [];
  const goalFulfillments = new Set();
  const goalHtml = '<main><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea>' +
    '<button type="submit" data-testid="send-button">Submit</button></form></main><script>window.goalFixture=(' +
    goalReactFixture.toString() + ')(' + JSON.stringify(goalFixtureId) + ',' + JSON.stringify(handle) + ');' +
    'document.querySelector("main").__reactFiber$fixture=window.goalFixture.leaf;' +
    'document.querySelector("form").addEventListener("submit",event=>{' +
    'event.preventDefault();const editor=document.querySelector("textarea"),f=window.goalFixture;' +
    'f.history.mapping["submitted-user"]={id:"submitted-user",parent:f.history.current_node,' +
    'message:{id:"submitted-user",author:{role:"user"},content:{content_type:"text",parts:[editor.value]}}};' +
    'f.history.current_node="submitted-user";editor.value="";});</script>';
  const goalRequestHandler = (event) => {
    if (event.detail.browser !== browser.name || event.detail.target !== "goal-model-fixture") return;
    goalRequests.push(new URL(event.detail.request.url).pathname);
    const task = cdpInternal(goalBrowserRecord, "Fetch.fulfillRequest", {
      requestId: event.detail.requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(goalHtml).toString("base64"),
    }, goalPage.session_id);
    goalFulfillments.add(task);
    task.finally(() => goalFulfillments.delete(task));
  };
  goalBrowserRecord.client.addEventListener("Fetch.requestPaused", goalRequestHandler);
  try {
    await setCfg("chat_goals_enabled", "1");
    await cdpInternal(goalBrowserRecord, "Fetch.enable", {
      patterns: [{ urlPattern: "https://chatgpt.com/*" }],
    }, goalPage.session_id);
    await chatGoalRpc(goalPage, "Page.navigate", { url: chatGoalUrl(goalFixtureId) });
    let observed;
    for (let i = 0; i < 60; i++) {
      observed = await chatGoalReadReact(goalPage, { chatId: goalFixtureId, handle });
      if (observed.status === "ready") break;
      await sleep(50);
    }
    check(observed?.match && observed.source === "query-cache",
      "real Chrome/CDP reads the cached conversation model without a history fetch");
    check(!goalRequests.some((path) => path.startsWith("/backend-api/")),
      "the goal reader issues no private REST requests");
    await chatGoalRpc(goalPage, "Runtime.evaluate", {
      expression: "window.goalFixture.history.current_node='user'", returnByValue: true,
    });
    check(!(await chatGoalReadReact(goalPage, { chatId: goalFixtureId, handle })).match,
      "real page cache changes are read afresh without navigation or network capture");
    await chatGoalRpc(goalPage, "Runtime.evaluate", {
      expression: "history.replaceState(null,''," + JSON.stringify("/g/g-p-fixture/c/" + goalFixtureId) + ")",
      returnByValue: true,
    });
    const focused = await chatGoalEvaluate(goalPage, "focus", {
      chatId: goalFixtureId, user_ids: observed.user_ids,
    });
    check(focused.focused, "a project chat can focus its composer using exact model-only message ids");
    await chatGoalRpc(goalPage, "Input.insertText", { text: "Fixture goal follow-up" });
    const sent = await chatGoalEvaluate(goalPage, "send", {
      chatId: goalFixtureId, text: "Fixture goal follow-up",
    });
    const receipt = await chatGoalReadReact(goalPage, {
      chatId: goalFixtureId, expected_text: "Fixture goal follow-up",
    });
    check(sent.sent && receipt.goal_receipt === "submitted-user",
      "real CDP submission can be acknowledged from the React model without legacy message DOM markers");
    await chatGoalRpc(goalPage, "Runtime.evaluate", {
      expression: "history.replaceState(null,'','/');document.querySelector('main').innerHTML=" +
        JSON.stringify('<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true"></div><button type="submit" data-testid="send-button">Submit</button></form>') +
        ";document.querySelector('form').onsubmit=e=>{e.preventDefault();window.workerSent=true}",
      returnByValue: true,
    });
    const worker = { new_chat: true };
    check((await chatGoalEvaluate(goalPage, "focus", worker)).focused,
      "a proven fresh worker composer can focus without old message IDs");
    const workerText = "Worker fixture\n\nPreserve multiline text";
    await chatGoalRpc(goalPage, "Input.insertText", { text: workerText });
    const workerState = await chatGoalEvaluate(goalPage, "state");
    check(workerState.draft === workerText,
      "real CDP preserves the exact multiline worker prompt without injecting app tokens: " + JSON.stringify({draft:workerState.draft, expected:workerText}));
    check((await chatGoalEvaluate(goalPage, "send", { ...worker, text: workerText })).sent,
      "a worker first prompt submits through the unique native form without app ID configuration");
  } finally {
    goalBrowserRecord.client.removeEventListener("Fetch.requestPaused", goalRequestHandler);
    await Promise.allSettled([...goalFulfillments]);
    await setCfg("chat_goals_enabled", goalEnabledBefore);
    await call("cdp_call", { calls: [{ browser, call: { method: "Browser.close", params: {} } }] });
  }
  // Exercise the real packaged extension/URL protocol on an owned disposable
  // profile. Never launch or connect to the operator's system profile here.
  const extensionBrowser = {
    name: "bootstrap-probe",
    cdp_ext: true,
    cdp_ext_install: true,
    user_data_dir: join(APP_DIR, "bootstrap-profile"),
    headless: true,
    args: { "no-sandbox": true },
    connect_timeout_ms: 20000,
  };
  let extensionRecord;
  try {
    extensionRecord = await ensureCdpBrowser(extensionBrowser);
    const bootstrap = new URL(extensionRecord.engine.bootstrap_url);
    const pages = await cdpInternal(extensionRecord, "chrome.tabs.query", { args: [{}] });
    check(
      bootstrap.hostname === "127.0.0.1" && bootstrap.pathname === "/cdp_ext" &&
        bootstrap.searchParams.get("browser") === extensionBrowser.name &&
        /^[a-p]{32}$/.test(extensionRecord.engine.extension_id) &&
        pages.some((page) => page.url === bootstrap.href),
      "real Chrome extension accepts the logical-name/token bootstrap and retains its bootstrap tab",
    );
    const target = await cdpEnsureTarget(extensionRecord, {
      name: "bootstrap-page",
      initialize: false,
      group: { name: "Bootstrap fixture", color: "blue" },
    });
    const evaluated = await cdpInternal(extensionRecord, "Runtime.evaluate", {
      expression: "21 * 2", returnByValue: true,
    }, target.session_id);
    const groups = await cdpInternal(extensionRecord, "chrome.tabGroups.query", { args: [{}] });
    check(
      evaluated.result.value === 42 && groups.some((group) =>
        group.title === "Bootstrap fixture" && group.color === "blue"),
      "actual bootstrap transport routes evaluation and native colored groups through the public library",
    );
    const proc = extensionRecord.engine.proc;
    extensionRecord.ws.close();
    for (let i = 0; i < 50 && extensionRecord.open; i++) await sleep(10);
    const reconnected = await ensureCdpBrowser(extensionBrowser);
    const surviving = await cdpEnsureTarget(reconnected, { name: "bootstrap-page" });
    check(
      reconnected.engine.proc === proc && surviving.target_id === target.target_id,
      "real extension reconnect preserves the owned Chrome process and surviving logical tab",
    );
  } finally {
    const owned = extensionRecord?.engine || cdpReverseClient?.browsers[extensionBrowser.name];
    if (owned?.socket?.readyState === WebSocket.OPEN)
      await owned.socket.req({ method: "Browser.close" }).catch(() => {});
    owned?.proc?.kill();
    owned?.socket?.close();
    const record = cdpBrowsers.get(extensionBrowser.name);
    if (record) cdpDisconnect(record);
    if (cdpReverseClient) delete cdpReverseClient.browsers[extensionBrowser.name];
    cdpBrowserOptions.delete(extensionBrowser.name);
    cdpTargetOptions.delete(cdpTargetKey(extensionBrowser.name, "bootstrap-page"));
  }
}
await fs.mkdir(MCP_BIN_DIR, { recursive: true });
const mockBin = join(MCP_BIN_DIR, RUNTIME_OS === "windows" ? "probe.exe" : "probe");
try {
  await fs.link(testBun, mockBin);
} catch (error) {
  if (error.code !== "EXDEV") throw error;
  await fs.copyFile(testBun, mockBin);
}
const mock =
  'const rl=require("node:readline").createInterface({input:process.stdin});rl.on("line",line=>{const r=JSON.parse(line);if(r.id==null)return;console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result:r.method==="initialize"?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:{echo:r.params,pid:process.pid}}));});';
await writeFile(
  MCP_CATALOG_PATH,
  stringifyYaml({
    servers: [
      {
        logical_name: "probe-stdio",
        path: RUNTIME_OS === "windows" ? "probe.exe" : "probe",
        enabled: true,
        stdio: { args: ["-e", mock], persistence: "ttl", ttl_seconds: 300, windows_hide: true },
      },
    ],
  }),
);
const upstream = await call("exec_mcp", {
  mcp: "probe-stdio",
  request: {
    jsonrpc: "2.0",
    id: "test-id",
    method: "tools/call",
    params: { name: "echo", arguments: { hello: "Bun" } },
  },
});
check(
  upstream.response?.id === "test-id" && upstream.response.result.echo.arguments.hello === "Bun",
  "raw stdio JSON-RPC",
);
const upstream2 = await call("exec_mcp", {
  mcp: "probe-stdio",
  request: { method: "tools/list", params: {} },
});
check(upstream2.response?.result?.pid === upstream.response.result.pid, "stdio TTL reuse");
for (const entry of [...mcpStdioPool.values()]) entry.close("test complete");
const image = await (
  await loadAutoVips()
).decodeImage(await fs.readFile(join(ASSETS_DIR, "mrmcp-logo.png")));
const webp = await (await loadAutoVips()).encodeImage(image, "webp");
check(webp instanceof Uint8Array || webp.data?.length > 0, "public Auto.js codec");
const material = await ensureSelfSigned();
check(material.valid, "self-signed certificate generation and inspection");
const certificateLibrary = await loadX509();
const csrAlgorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const csrKeys = await crypto.subtle.generateKey(csrAlgorithm, true, ["sign", "verify"]);
const certificateRequest = await certificateLibrary.Pkcs10CertificateRequestGenerator.create({
  keys: csrKeys,
  signingAlgorithm: csrAlgorithm,
  name: "",
  extensions: [new certificateLibrary.SubjectAlternativeNameExtension([
    { type: "ip", value: "127.0.0.1" },
    { type: "dns", value: "localhost" },
  ], true)],
});
check(await certificateRequest.verify() && certificateRequest.rawData.byteLength > 0,
  "X.509 ACME CSR generation and signature verification");
let delivered = 0;
let cancelled = 0;
let aborted = 0;
const tls = serveHttp(
  { hostname: "127.0.0.1", port: 0, cert: material.certificate, key: material.key },
  async (req, info) => {
    info.completed.then(
      () => delivered++,
      () => aborted++,
    );
    const path = new URL(req.url).pathname;
    if (path === "/cancel") {
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode("data: open\n\n"));
            timer = setInterval(() => controller.enqueue(enc.encode("data: tick\n\n")), 25);
          },
          cancel() {
            clearInterval(timer);
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return path === "/sse"
      ? new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
      : new Response("Compression works. ".repeat(200), {
          headers: { "content-type": "text/plain" },
        });
  },
);
try {
  const compressed = await fetch("https://localhost:" + tls.port, {
    headers: { "accept-encoding": "gzip" },
    tls: { rejectUnauthorized: false },
  });
  check(
    compressed.headers.get("content-encoding") === "gzip" &&
      (await compressed.text()).startsWith("Compression works."),
    "real TLS and HTTP compression",
  );
  const sse = await fetch("https://localhost:" + tls.port + "/sse", {
    headers: { "accept-encoding": "br,gzip" },
    tls: { rejectUnauthorized: false },
  });
  check(
    !sse.headers.has("content-encoding") && (await sse.text()).includes("hello"),
    "SSE remains uncompressed",
  );
  await sleep(0);
  check(delivered === 2, "HTTP completion follows streamed body consumption");
  const abort = new AbortController();
  const streaming = await fetch("https://localhost:" + tls.port + "/cancel", {
    signal: abort.signal,
    tls: { rejectUnauthorized: false },
  });
  const reader = streaming.body.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !cancelled; i++) await sleep(10);
  check(
    cancelled === 1 && aborted === 1,
    "real HTTP disconnect cancels the upstream SSE and rejects completion",
  );
} finally {
  await tls.shutdown();
}
const uiPages = [];
const nativePages = [];
setUiRenderVisible(true);
uiRenderConnected = false;
const guiContextId = (await one("SELECT id FROM contexts WHERE handle=?", handle)).id;
const guiLogPage = await uiOperation("logs", {
  tool: "exec",
  q: "bun-process-ok",
  context: String(guiContextId),
  page: "999",
  page_size: "10",
});
check(
  guiLogPage.rows.length > 0 &&
    guiLogPage.page === guiLogPage.pages &&
    guiLogPage.rows.every((row) => row.tool.startsWith("exec") && row.context_id === guiContextId),
  "direct GUI log service preserves text/tool/Session filters and clamps pagination",
);
const guiEmpty = await uiOperation("logs", { q: '"unterminated-absent-fixture', page: "999" });
check(
  guiEmpty.total === 0 && guiEmpty.page === 1 && !guiEmpty.rows.length,
  "failed fulltext parsing retains the literal-search fallback and empty-page bounds",
);
const guiDetail = await uiOperation("logs/detail", { id: guiLogPage.rows[0].id });
check(
  guiDetail.id === guiLogPage.rows[0].id && guiDetail.tool_descriptor,
  "direct GUI detail retains its historical canonical descriptor",
);
check(
  (await uiOperation("logs/kill", { id: 2147483647, signal: "SIGKILL" })).ok === false,
  "direct GUI cancellation does not claim an absent call was stopped",
);
let invalidGuiSettings = "";
try {
  await uiOperation("settings", { chat_goal_timeout_minutes: "invalid" });
} catch (error) {
  invalidGuiSettings = errorMessage(error);
}
check(
  invalidGuiSettings === "Goal timeout must be whole minutes from 1 to 1440.",
  "direct GUI settings propagate the original validation error",
);
const headlessBefore = getCfg("chat_goal_stop_before_send", "0");
try {
  await uiOperation("settings", { chat_goal_stop_before_send: true });
  check(
    getCfg("chat_goal_stop_before_send", "0") === "1",
    "direct GUI settings persist changes without an HTTP envelope",
  );
} finally {
  await setCfg("chat_goal_stop_before_send", headlessBefore);
}
for (const [catalog, path, read, extra] of [
  ["commands", COMMANDS_PATH, readCommandConfig, {}],
  [
    "mcp",
    MCP_CATALOG_PATH,
    readMcpConfig,
    { enabled: true, stdio: { args: [], persistence: "command" } },
  ],
  [
    "prompts",
    GUIDED_PROMPTS_PATH,
    readGuidedPromptConfig,
    { arguments: [], template: 'Fixture <%= it.args.focus || "project" %>' },
  ],
]) {
  const original = await readTextFile(path);
  const name = "gui_service_fixture";
  try {
    await uiOperation(catalog + "/save", { name, description: "GUI service fixture", ...extra });
    check(
      (await read()).some((row) => row.name === name),
      "direct GUI catalog create: " + catalog,
    );
    await uiOperation(catalog + "/save", {
      name,
      old_name: name,
      description: "Updated GUI fixture",
      ...extra,
    });
    check(
      (await read()).filter((row) => row.name === name).length === 1 &&
        (await read()).find((row) => row.name === name).description === "Updated GUI fixture",
      "direct GUI catalog edit preserves unique ordered entries: " + catalog,
    );
    await uiOperation(catalog + "/delete", { name });
    check(
      !(await read()).some((row) => row.name === name),
      "direct GUI catalog delete: " + catalog,
    );
    const concurrent = [name + "_a", name + "_b"];
    await Promise.all(concurrent.map((name) => uiOperation(catalog + "/save", {
      name, description: "Concurrent GUI fixture", ...extra,
    })));
    const rows = await read();
    check(concurrent.every((name) => rows.some((row) => row.name === name)),
      "concurrent saves retain both edits in the same YAML catalog: " + catalog);
    const results = await Promise.allSettled([
      uiOperation(catalog + "/save", { name: "invalid/name", ...extra }),
      uiOperation(catalog + "/delete", { name: concurrent[0] }),
    ]);
    check(results[0].status === "rejected" && results[1].status === "fulfilled" &&
      !(await read()).some((row) => row.name === concurrent[0]),
      "a failed catalog mutation does not block the next one: " + catalog);
  } finally {
    await replaceTextFile(path, original);
  }
}
const mcpProjection = await state("mcp");
check(
  mcpProjection.settings &&
    mcpProjection.header_activity &&
    !mcpProjection.stats &&
    !mcpProjection.server &&
    !mcpProjection.roots &&
    !mcpProjection.context_values,
  "MCP Servers projects its shell without loading inactive Dashboard/Workspace/Session data",
);
const beforeConfirm = Number((await one("SELECT COUNT(*) n FROM logs")).n);
for (const action of [
  "clear-tool-calls",
  "clear-sessions",
  "clear-workspaces",
  "clear-clients",
  "clear-database",
]) {
  await handleUiAction({ action });
  check(
    uiState.dialog?.kind === "confirm" && uiState.dialog.confirmAction === action,
    "maintenance remains confirmation-only: " + action,
  );
  uiState.dialog = null;
}
check(
  Number((await one("SELECT COUNT(*) n FROM logs")).n) === beforeConfirm && !toolCallGate,
  "opening maintenance confirmations performs no cleanup",
);
uiState.settingsDraft = {
  search_configuration: stringifyYaml({ ...searchConfig(), ocr: "native" }),
};
await handleUiAction({ action: "search-use-paddle", dataset: {}, values: {} });
check(
  parseYaml(uiState.settingsDraft.search_configuration).ocr === "paddle" &&
    searchConfig().ocr === "paddle",
  "Paddle shortcut updates only the settings draft",
);
uiState.settingsDraft = null;
const filterSnapshot = Object.fromEntries(
  [
    "logs",
    "commands",
    "mcp",
    "prompts",
    "published",
    "memory",
    "browser",
    "automation",
    "debug",
  ].map((key) => [key, structuredClone(uiState[key])]),
);
const nativeSnapshot = structuredClone(uiState.native);
try {
  uiState.logs.page = 7;
  uiState.logs.openRowId = "stable-record";
  await handleUiInput({ type: "change", id: "logPageSize", value: "50" });
  check(
    uiState.logs.page === 1 &&
      uiState.logs.pageSize === 50 &&
      uiState.logs.openRowId === "stable-record",
    "changing Tool Call page size resets pagination without replacing selected identity",
  );
  uiState.commands.page = 7;
  uiState.mcp.page = 7;
  await handleUiInput({
    type: "inputs",
    items: [
      { id: "commandQuery", value: "typed command" },
      { id: "mcpQuery", value: "typed server" },
    ],
  });
  check(
    uiState.commands.query === "typed command" &&
      uiState.commands.page === 7 &&
      uiState.mcp.query === "typed server" &&
      uiState.mcp.page === 1,
    "batched catalog typing retains each page reset policy",
  );
  await handleUiInput({ type: "enter", id: "commandQuery" });
  check(uiState.commands.page === 1, "committed command search starts at the first page");
  uiState.memory.workspace = "Fixture";
  uiState.memory.page = 7;
  await handleUiInput({ type: "change", id: "memoryContext", value: "12" });
  check(
    uiState.memory.scope === "session" &&
      uiState.memory.context === "12" &&
      !uiState.memory.workspace &&
      uiState.memory.page === 1,
    "Session Memory filter excludes a stale Workspace filter",
  );
  await handleUiInput({ type: "change", id: "memoryScope", value: "global" });
  check(
    !uiState.memory.context && !uiState.memory.workspace,
    "Global Memory filter clears both owner filters",
  );
  await handleUiAction({ action: "new-memory" });
  await handleUiInput({
    type: "inputs",
    items: [
      { id: "mvalue", value: "{unfinished" },
      { id: "mjson", checked: true },
    ],
  });
  await handleUiInput({ type: "change", id: "mscope", value: "session" });
  check(
    uiState.dialog.data.value_text === "{unfinished" &&
      uiState.dialog.data.json &&
      uiState.dialog.data.scope === "session" &&
      !!uiState.dialog.data.context &&
      !uiState.dialog.data.workspace,
    "Memory owner changes preserve an unfinished JSON draft",
  );
} finally {
  Object.assign(uiState, filterSnapshot);
  uiState.native = nativeSnapshot;
  uiState.dialog = null;
}

const markupText = '<script>literal &lt; value</script> "quoted"';
const nativeLiteral = nativeProjection(
  <div id="app">
    <main>
      <input id="literal" value={markupText} checked={false} />
      <button data-copy={markupText} disabled={false}>
        {markupText}
      </button>
      <select id="zero">
        <option value={0} selected>
          {markupText}
        </option>
      </select>
    </main>
  </div>,
);
check(
  nativeLiteral.controls.literal.value === markupText &&
    nativeLiteral.controls.zero.value === "0" &&
    JSON.stringify(nativeLiteral.tree).includes("literal &lt; value"),
  "native JSX preserves literal markup/entities and zero values without HTML decoding",
);
const escapedPage = await oauthPage({
  title: markupText,
  client_name: markupText,
  scope: markupText,
  resource: markupText,
  redirect_host: markupText,
  icon_url: "https://example.com/icon.png",
  fields: [["client_id", markupText]],
});
const escapedHtml = await escapedPage.text();
check(
  escapedPage.status === 200 &&
    escapedHtml.startsWith("<!doctype html>") &&
    escapedHtml.includes(htmlEscape(markupText)) &&
    !escapedHtml.includes("<script>") &&
    escapedHtml.includes('name="client_id" value="' + htmlEscape(markupText) + '"') &&
    escapedHtml.includes("Authorize Access") &&
    escapedHtml.includes("Cancel"),
  "OAuth JSX serializes escaped web text/attributes with the existing consent form",
);
const failedPage = await oauthError(markupText);
const failedHtml = await failedPage.text();
check(
  failedPage.status === 400 &&
    failedHtml.includes(htmlEscape(markupText)) &&
    !failedHtml.includes("<script>") &&
    !failedHtml.includes("<form"),
  "OAuth invalid-request page retains escaped errors and no consent form",
);
check(promptEta === undefined, "native GUI and OAuth do not initialize the text template engine");
const textPrompt = await renderGuidedPrompt(
  p,
  {
    name: "jsx_architecture_fixture",
    arguments: [{ name: "focus", required: true }],
    template:
      "Review <%= it.args.focus %><% if (it.workspace === null) { %> \u00B7 no workspace<% } %>",
  },
  { focus: markupText },
  new Request("https://localhost/mcp"),
  {},
  { kind: "basic" },
  "https",
  MCP_MODERN_PROTOCOL,
);
check(
  textPrompt.messages[0].content.text === "Review " + markupText + " \u00B7 no workspace" &&
    promptEta,
  "guided prompts retain lazy non-escaping Eta text rendering and existing template syntax",
);

// Hold Turso's own connection lock while GUI actions are pending. Navigation
// and unrelated drafts must still complete, with no global input queue/ACKs.
const guiRoot = await one("SELECT id,name FROM roots ORDER BY id LIMIT 1");
const rootCountBeforeGuiRace = Number((await one("SELECT COUNT(*) n FROM roots")).n);
let releaseGuiDatabase;
let guiDatabaseEntered;
const guiDatabaseGate = new Promise((resolve) => { releaseGuiDatabase = resolve; });
const guiDatabaseReady = new Promise((resolve) => { guiDatabaseEntered = resolve; });
const guiDatabaseOwner = withDbTransaction(async () => {
  guiDatabaseEntered();
  await guiDatabaseGate;
});
await guiDatabaseReady;
const pendingGuiEdit = dispatchUiInput({
  type: "action", action: "edit-root", dataset: { id: guiRoot.id },
});
await dispatchUiInput({ type: "navigate", section: "help" });
check(uiState.currentSection === "help" && uiState.dialog === null,
  "GUI navigation does not wait for an asynchronous dialog read");
await dispatchUiInput({ type: "action", action: "new-root" });
const pendingGuiName = dispatchUiInput({ type: "input", id: "rname", value: guiRoot.name });
check(uiState.dialog.data.name === guiRoot.name,
  "GUI draft is backend-owned before its asynchronous validation completes");
await dispatchUiInput({ type: "input", id: "rpath", value: workspace });
check(uiState.dialog.data.path === workspace,
  "An independent GUI field updates during pending validation");
const guiSubmission = {
  type: "submit", formId: "rootForm",
  values: { rname: "Cancelled GUI submit fixture", rpath: workspace, renabled: true },
};
const pendingGuiSubmit = dispatchUiInput(guiSubmission);
check(dispatchUiInput(guiSubmission) === pendingGuiSubmit,
  "An identical in-flight form submission is not executed twice");
await dispatchUiInput({ type: "navigate", section: "dashboard" });
releaseGuiDatabase();
await Promise.all([guiDatabaseOwner, pendingGuiEdit, pendingGuiName, pendingGuiSubmit]);
check(uiState.currentSection === "dashboard" && uiState.dialog === null,
  "Late dialog/validation results cannot reopen or overwrite the current GUI");
check(Number((await one("SELECT COUNT(*) n FROM roots")).n) === rootCountBeforeGuiRace,
  "A form abandoned during validation does not perform a stale save");
await dispatchUiInput({ type: "action", action: "new-root" });
await Promise.all([
  dispatchUiInput({ type: "input", id: "rname", value: guiRoot.name }),
  dispatchUiInput({ type: "input", id: "rname", value: "Latest GUI draft fixture" }),
]);
check(uiState.dialog.data.name === "Latest GUI draft fixture" && !uiState.dialog.data.name_warning,
  "Only the latest validation may update its field");
uiState.dialog = null;

for (const section of UI_SECTIONS) {
  uiState.currentSection = section;
  uiState.dialog = null;
  const view = await renderUiView(uiRenderGeneration);
  check(
    !JSON.stringify(view).includes("[object Promise]"),
    "page contains resolved asynchronous data: " + section,
  );
  const projection = nativeProjection(view, uiState.native);
  check(!!projection.tree, "native page " + section);
  uiPages.push(section);
  nativePages.push({ section, projection });
}
for (const action of ["new-root", "new-command", "new-prompt", "new-memory"]) {
  await handleUiAction({ action, dataset: {}, values: {} });
  const view = await renderUiView(uiRenderGeneration);
  nativePages.push({
    section: "dialog:" + action,
    projection: nativeProjection(view, uiState.native),
  });
  check(!!uiState.dialog, "managed dialog " + action);
  uiState.dialog = null;
}
uiConfirm("Fixture confirmation", "Confirm this test action?", "clear-logs");
nativePages.push({
  section: "dialog:confirm",
  projection: nativeProjection(await renderUiView(uiRenderGeneration), uiState.native),
});
uiState.dialog = null;
nativePages.push(JSON.parse(await fs.readFile(join(APP_DIR, "subagent-page.json"), "utf8")));
uiState.currentSection = "logs";
const treeLogState = structuredClone(uiState.logs);
uiState.logs.toolQuery = guiDetail.tool;
uiState.logs.page = 1;
uiState.logs.openRowId = String(guiDetail.id);
nativePages.push({
  section: "tool-detail",
  projection: nativeProjection(await renderUiView(uiRenderGeneration), uiState.native),
});
uiState.logs = treeLogState;
const treeFixture = {
  query: "Find matching source documents",
  options: {
    mode: "hybrid",
    limits: { files: 50, chunks: 12 },
    flags: [true, false, null],
    description: "A long parameter value stays readable and wraps inside its column without covering adjacent keys or controls.",
  },
  paths: ["src/**/*.js", "docs/**/*.md"],
  empty: {},
};
nativePages.push({
  section: "json-trees",
  projection: nativeProjection(
    <div id="app">
      <header>Parameter trees</header>
      <main>
        <h3>JSON parameters</h3>
        <pre id="tree-fixture-source" hidden>{JSON.stringify(treeFixture)}</pre>
        <div id="tree-fixture" class="json-editor-host" data-json-source="tree-fixture-source" />
        <h3>Tool Call packet</h3>
        {fragmentDebugPayload(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "document_grep", arguments: treeFixture } }))}
      </main>
    </div>,
  ),
});
await writeFile(join(APP_DIR, "native-pages.json"), JSON.stringify(nativePages));
for (const section of [
  "network",
  "security",
  "process",
  "files",
  "goals",
  "search",
  "proxies",
  "notifications",
  "maintenance",
]) {
  uiState.currentSection = "settings";
  uiState.settingsTab = section;
  const view = await renderUiView(uiRenderGeneration);
  check(!!nativeProjection(view, uiState.native).tree, "Settings tab " + section);
}
const lastId = Number((await one("SELECT MAX(id) n FROM logs")).n);
await clearOperationalDatabase();
check(
  (await one("SELECT COUNT(*) n FROM memories WHERE key='runtime'")).n === 1,
  "maintenance preserves memory",
);
const afterCleanup = await call("document_grep", {
  query: "scopefixture",
  include: ["rag-scope/*.txt"],
  gitignore: false,
  mode: "fulltext",
});
check(
  afterCleanup.reindexed_files === 0 && afterCleanup.results.length > 0,
  "maintenance preserves Rag index",
);
check(
  Number((await one("SELECT MAX(id) n FROM logs")).n) > lastId,
  "Tool Call ids stay monotonic after cleanup",
);
for (const key of [...jsKernels.keys()]) destroyJsKernel(key, "test end");
const workerParent = await one("SELECT id FROM contexts ORDER BY id LIMIT 1");
await run("INSERT INTO subagents(id,parent_context_id,label,task,claim_token,target,state,created_at,updated_at) VALUES('agent_restart_fixture',?,'Persistence','Restart fixture','','subagent-restart','completed',?,?)",
  workerParent.id, Date.now(), Date.now());
await run("INSERT INTO subagent_messages(agent_id,kind,text,state,created_at,delivered_at) VALUES('agent_restart_fixture','result','Durable worker result','delivered',?,?)",
  Date.now(), Date.now());
if (uiRenderTimer) clearTimeout(uiRenderTimer);
if (uiNoticeTimer) clearTimeout(uiNoticeTimer);
if (headerActivityTimer) clearTimeout(headerActivityTimer);
if (activeToolCallTimer) clearTimeout(activeToolCallTimer);
if (requestMetricTimer) clearTimeout(requestMetricTimer);
await db.close();
console.log(JSON.stringify({ ok: true, checks, uiPages, runtime: Bun.version }));
process.exit(0);
`;
let source = await fs.readFile(join(root, "mrmcp.js"), "utf8");
source = replaceFixture(
  source,
  /const GUI_RUNTIME\s*=[^;]+;/,
  'const GUI_RUNTIME = process.env.MRMCP_TEST_GUI==="1" || (import.meta.main && !["--backend","--add-workspace"].includes(process.argv[2]));',
);
const insertion = "  await restoreAcmeBackoff();";
if (!source.includes(insertion)) throw Error("Backend test insertion point missing");
const goalChecks = await fs.readFile(join(root, ".github", "check-goals.inc.js"), "utf8");
const subagentChecks = await fs.readFile(join(root, ".github", "check-subagents.inc.js"), "utf8");
const fullSuite = suite.replace(
  "const startingControl =",
  goalChecks + "\n" + subagentChecks + "\nconst startingControl =",
);
source = source.replace(insertion, fullSuite + "\n  return;\n" + insertion);
await fs.writeFile(join(directory, "mrmcp.js"), source);
let command = [process.execPath, join(directory, "mrmcp.js"), "--backend"];
if (standalone) {
  const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
  const build = Bun.spawn(
    [
      process.execPath,
      join(root, ".github", "build.mjs"),
      process.platform,
      process.arch,
      binary,
      join(directory, "mrmcp.js"),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (await build.exited) process.exit(1);
  if (process.platform === "darwin") {
    const sign = Bun.spawn(["codesign", "--force", "--sign", "-", binary], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await sign.exited) process.exit(1);
  }
  command = [binary, "--backend"];
}
const child = Bun.spawn(command, {
  cwd: standalone ? process.env.TEMP || directory : root,
  env: {
    ...process.env,
    MRMCP_TEST_GUI: "1",
    MRMCP_TEST_SEMANTIC: semantic ? "1" : "0",
    MRMCP_TEST_BUN: process.execPath,
    MRMCP_TEST_ROOT: root,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const timeout = setTimeout(() => child.kill(), 180000);
const code = await child.exited;
clearTimeout(timeout);
console.log("Test fixture: " + directory);
if (code) process.exit(code);
const restart = Bun.spawn(command, {
  cwd: directory,
  env: {
    ...process.env,
    MRMCP_TEST_GUI: "1",
    MRMCP_TEST_RESTART: "1",
    MRMCP_TEST_SEMANTIC: semantic ? "1" : "0",
    MRMCP_TEST_BUN: process.execPath,
    MRMCP_TEST_ROOT: root,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const restartTimeout = setTimeout(() => restart.kill(), 120000);
const restartCode = await restart.exited;
clearTimeout(restartTimeout);
if (restartCode) process.exit(restartCode);
// Exercise one-shot registration and the unattended recreate-only boundary
// before loading the native test renderer. No production directory is used.
const cli = Bun.spawn([...command.slice(0, -1), "--add-workspace", "CLI fixture", "fixture"], {
  cwd: directory,
  env: { ...process.env, MRMCP_TEST_GUI: "0" },
  stdout: "inherit",
  stderr: "inherit",
});
if (await cli.exited) throw Error("One-shot Workspace registration failed");
const { connect } = await import("@tursodatabase/database");
const inspect = await connect(join(directory, ".mrmcp", "mrmcp.sqlite"), {
  readonly: true,
  experimental: ["views", "index_method", "triggers"],
});
try {
  if (
    (await (await inspect.prepare("SELECT path FROM roots WHERE name='CLI fixture'")).get())
      ?.path !== "fixture"
  )
    throw Error("One-shot CLI changed the entered relative path");
} finally {
  await inspect.close();
}
const incompatible = join(directory, "incompatible");
await fs.mkdir(join(incompatible, ".mrmcp"), { recursive: true });
await fs.copyFile(
  join(directory, ".mrmcp", "mrmcp.sqlite"),
  join(incompatible, ".mrmcp", "mrmcp.sqlite"),
);
const old = await connect(join(incompatible, ".mrmcp", "mrmcp.sqlite"), {
  experimental: ["views", "index_method", "triggers"],
});
await old.exec("UPDATE schema_meta SET version=5");
await old.close();
await fs.writeFile(join(incompatible, ".mrmcp", "keep.txt"), "preserve");
const oldEntry = join(
  incompatible,
  standalone ? (process.platform === "win32" ? "probe.exe" : "probe") : "mrmcp.js",
);
if (standalone) await fs.link(command[0], oldEntry);
else await fs.copyFile(join(directory, "mrmcp.js"), oldEntry);
const refused = Bun.spawn(
  standalone ? [oldEntry, "--backend"] : [process.execPath, oldEntry, "--backend"],
  {
    cwd: incompatible,
    env: { ...process.env, MRMCP_TEST_GUI: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const refusedError = await new Response(refused.stderr).text();
if (
  (await refused.exited) === 0 ||
  !refusedError.includes("schema version mismatch") ||
  (await fs.readFile(join(incompatible, ".mrmcp", "keep.txt"), "utf8")) !== "preserve" ||
  (await fs.stat(join(incompatible, "commands.yaml")).catch(() => null))
)
  throw Error(
    "Unattended schema boundary did not preserve incompatible data before sidecars: " +
      refusedError,
  );
console.log("Lifecycle: CLI relative path and unattended schema-5 refusal/preservation passed");
// Exercise the production listener shutdown with a foreground process active.
// Waiting for graceful HTTP stop before cancelling that process would deadlock.
let lifecycle = await fs.readFile(join(root, "mrmcp.js"), "utf8");
lifecycle = replaceFixture(lifecycle, /const GUI_RUNTIME\s*=[^;]+;/, "const GUI_RUNTIME = true;");
lifecycle = replaceFixture(lifecycle, "const HTTP_PORT = 80;", "const HTTP_PORT = 0;");
lifecycle = replaceFixture(lifecycle, "const HTTPS_PORT = 443;", "const HTTPS_PORT = 0;");
lifecycle = replaceFixture(
  lifecycle,
  /return \{\s*input:\s*dispatchUiInput,\s*visible:\s*setUiRenderVisible,\s*shutdown,?\s*\};/,
  "return { input:dispatchUiInput,visible:setUiRenderVisible,shutdown,testPorts:{http:mcpHttpServer?.port,https:mcpHttpsServer?.port},testListenError:mcpListenError,testActive:()=>activeCallControls.size };",
);
lifecycle =
  lifecycle.slice(0, lifecycle.lastIndexOf("\nif (import.meta.main) {")) +
  String.raw`
const service = await runBackend();
if (!service.testPorts.https) throw Error("Lifecycle TLS listener failed: " + service.testListenError);
const base = "https://127.0.0.1:" + service.testPorts.https;
let sequence = 0;
let handle;
const call = async (name, args = {}) => {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    tls: { rejectUnauthorized: false },
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MCP_MODERN_PROTOCOL,
      authorization: "Basic " + btoa("probe:test-only"),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++sequence,
      method: "tools/call",
      params: { name, arguments: { ...(handle ? { chat_session: handle } : {}), ...args } },
    }),
  });
  return await response.json();
};
handle = (await call("init_chat_session")).result.structuredContent.chat_session;
await call("open_workspace", { name: "Fixture" });
const active = call("exec", {
  program: process.execPath,
  args: ["-e", "setTimeout(()=>{},60000)"],
  timeout_ms: 65000,
}).catch((error) => ({ error: String(error) }));
const deadline = Date.now() + 10000;
while (!service.testActive() && Date.now() < deadline) await Bun.sleep(10);
if (!service.testActive()) throw Error("Foreground shutdown fixture never became active");
await Bun.sleep(150);
const started = performance.now();
await service.shutdown();
await active;
if (performance.now() - started > 4500) throw Error("Shutdown waited for foreground timeout");
console.log(
  "Lifecycle: active foreground request cancelled before graceful HTTP stop and Turso close",
);
process.exit(0);
`;
await fs.writeFile(join(directory, "lifecycle.js"), lifecycle);
const closing = Bun.spawn([process.execPath, join(directory, "lifecycle.js")], {
  cwd: directory,
  stdout: "inherit",
  stderr: "inherit",
});
const closingTimeout = setTimeout(() => closing.kill(), 15000);
const closingCode = await closing.exited;
clearTimeout(closingTimeout);
if (closingCode) throw Error("Active request shutdown failed");
// The fixture process is independent of the native layout test process. The
// live desktop check additionally verifies GUI-first provider initialization.
const { nativeElement: element, nativeProjection, NativeUiHost } = await import("../mrmcp.js");
const { TestGpuixRenderer, hasTestGpuixRenderer } = await import("@gpuix/native");
if (hasTestGpuixRenderer()) {
  const native = new TestGpuixRenderer(1180, 760);
  const events = [];
  const initialBatch = native.applyBatch.bind(native);
  const rootMutations = [];
  native.applyBatch = (packet) => {
    rootMutations.push(...JSON.parse(packet));
    return initialBatch(packet);
  };
  const host = await NativeUiHost.create(native, (event) => events.push(event));
  if (!rootMutations.some(([name, enabled]) => name === "setKeyboardFocusDim" && enabled === false))
    throw Error("Keyboard navigation dims the administration window");
  native.applyBatch = initialBatch;
  const page = (value) =>
    nativeProjection(
      element(
        "div",
        { id: "app" },
        element("header", null, "Test"),
        element(
          "main",
          null,
          element("input", { id: "draft", value }),
          element("button", { "data-action": "save" }, "Save"),
        ),
      ),
    );
  host.apply({ revision: 1, section: "test", projection: page("old") });
  native.flush();
  const input = [...host.nodes.values()].find((n) => n.meta?.id === "draft");
  host.event({ elementId: input.nativeId, eventType: "change", value: "new" });
  if (events.at(-1)?.type !== "input" || events.at(-1).value !== "new")
    throw Error("Native input did not reach the backend immediately");
  const inputId = input.nativeId;
  host.apply({
    revision: 3,
    section: "test",
    projection: page("new"),
  });
  native.flush();
  if (host.nodes.get("id:draft").nativeId !== inputId)
    throw Error("React replaced a retained text input");
  let revision = 4;
  for (const payload of JSON.parse(
    await fs.readFile(join(directory, "native-pages.json"), "utf8"),
  )) {
    host.apply({ ...payload, revision: revision++ });
    native.flush();
    if (payload.section === "tool-detail") {
      const panels = [...host.nodes.values()].filter((node) => node.meta?.tag === "aside");
      const definition = panels.find((node) => !node.meta?.scroller);
      if (!definition || native.getElementBounds(definition.nativeId).width <= 208)
        throw Error("Tool definition inherits the narrow navigation sidebar layout");
    }
    if (process.argv.includes("--screenshots"))
      native.captureScreenshot(
        join(directory, "ui-" + payload.section.replaceAll(":", "-") + ".png"),
      );
    if (payload.section.startsWith("dialog:")) {
      const overlay = [...host.nodes.values()].find((n) => n.meta?.overlay);
      const frame = overlay && (host.nodes.get(overlay.key + "/scroll-frame") || overlay);
      const app = host.nodes.get("id:app");
      const bounds = frame && native.getElementBounds(frame.nativeId);
      const viewport = app && native.getElementBounds(app.nativeId);
      if (
        !bounds ||
        !viewport ||
        viewport.height <= 0 ||
        viewport.width <= 0 ||
        Math.abs(bounds.height - viewport.height) > 1 ||
        Math.abs(bounds.width - viewport.width) > 1 ||
        Math.abs(bounds.y - viewport.y) > 1 ||
        Math.abs(bounds.x - viewport.x) > 1
      )
        throw Error(
          "Dialog does not fill the native viewport: " +
            payload.section +
            " " +
            JSON.stringify({ bounds, viewport }),
        );
      for (const height of [760, 620]) {
        const projection = structuredClone(payload.projection);
        Object.assign(projection.tree.style, { width: 900, height });
        host.apply({ ...payload, projection, revision: revision++ });
        native.flush();
        const panel = [...host.nodes.values()].find((node) => node.meta?.tag === "dialog");
        const form = [...host.nodes.values()].find((node) => node.meta?.tag === "form") || panel;
        const title = form && host.nodes.get(form.children[0].key);
        const actions = form && host.nodes.get(form.children.at(-1).key);
        const titleBounds = title && native.getElementBounds(title.nativeId);
        const actionBounds = actions && native.getElementBounds(actions.nativeId);
        if (
          !titleBounds ||
          !actionBounds ||
          titleBounds.y < 0 ||
          actionBounds.y + actionBounds.height > height ||
          actionBounds.y <= titleBounds.y
        )
          throw Error(
            "Dialog title/actions clipped at height " +
              height +
              ": " +
              payload.section +
              " " +
              JSON.stringify({ titleBounds, actionBounds }),
          );
        if (
          [...host.nodes.values()].filter(
            (node) => node.meta?.scroller && node.key.startsWith(panel.key),
          ).length > 1
        )
          throw Error("Dialog has nested scroll viewports");
      }
    }
  }
  host.apply({ revision: revision++, section: "test", projection: page("new") });
  native.flush();
  const retainedBaseline = native.getRetainedElementCount();
  for (let i = 0; i < 3; i++) {
    host.apply({
      revision: revision++,
      section: "large",
      projection: nativeProjection(
        element(
          "div",
          { id: "app" },
          ...Array.from({ length: 40 }, (_, n) =>
            element("span", { id: "temporary" + n }, "Temporary " + n),
          ),
        ),
      ),
    });
    host.apply({ revision: revision++, section: "test", projection: page("new") });
    native.flush();
    if (native.getRetainedElementCount() !== retainedBaseline)
      throw Error("React leaked removed native elements");
  }
  const gpuix = await import("@gpuix/react");
  const dispatch = () =>
    gpuix.flushSync(() => native.drainEvents().forEach((event) => host.dispatch(event)));
  const settle = () => {
    native.flush();
    dispatch();
    native.flush();
  };
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const inspect = () => flatten(JSON.parse(native.getTreeJson()));
  const prop = (name, value) => inspect().find((node) => node.customProps?.[name] === value);
  const click = (node) => {
    const bounds = native.getElementBounds(node.id);
    if (!bounds) throw Error("Widget has no painted bounds: " + JSON.stringify(node));
    native.simulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    settle();
  };
  host.apply({
    revision: revision++,
    section: "keyboard",
    projection: nativeProjection(
      element(
        "div",
        { id: "app" },
        element(
          "main",
          null,
          element("textarea", { id: "tab-editor", value: "line one\nline two" }),
          element("input", { id: "tab-next", value: "Next field" }),
        ),
      ),
    ),
  });
  settle();
  native.focusElement(host.nodes.get("id:tab-editor").nativeId);
  native.simulateKeystrokes("tab");
  settle();
  if (native.getFocusedElementId() !== host.nodes.get("id:tab-next").nativeId)
    throw Error("Tab did not move focus to the next field");
  native.simulateKeystrokes("shift-tab");
  settle();
  if (native.getFocusedElementId() !== host.nodes.get("id:tab-editor").nativeId)
    throw Error("Shift+Tab did not return focus to the multiline field");
  console.log("GPUI: native Tab/Shift+Tab navigation without global keyboard dimming passed");

  const treeData = {
    query: "A long value ".repeat(12),
    options: { mode: "hybrid", limits: { files: 50 } },
    paths: ["src/**/*.js"],
  };
  const treeState = { details: { 'json:mvalue:["options","limits"]': true } };
  const treePage = (editable = false) =>
    nativeProjection(
      element(
        "div",
        { id: "app" },
        element(
          "main",
          null,
          element("textarea", { id: "mvalue", hidden: true }, JSON.stringify(treeData)),
          element("div", {
            id: "parameters",
            class: "json-editor-host",
            "data-json-source": "mvalue",
            ...(editable ? { "data-json-edit": "memory" } : {}),
          }),
        ),
      ),
      treeState,
    );
  const treeKey = "id:parameters/tree";
  for (const width of [900, 500]) {
    const projection = treePage();
    Object.assign(projection.tree.style, { width, height: 620 });
    host.apply({ revision: revision++, section: "json", projection });
    settle();
    const bounds = (key) => native.getElementBounds(host.nodes.get(key).nativeId);
    const query = bounds(treeKey + "/query/key");
    const options = bounds(treeKey + "/options/name");
    const mode = bounds(treeKey + "/options/mode/key");
    const files = bounds(treeKey + "/options/limits/files/key");
    const value = bounds(treeKey + "/query/value");
    const panel = bounds("id:parameters");
    if (
      Math.abs(query.x - options.x) > 1 ||
      Math.abs(mode.x - query.x - 21) > 1 ||
      Math.abs(files.x - mode.x - 21) > 1
    )
      throw Error(
        "JSON branches and leaves have inconsistent indentation: " +
          JSON.stringify({ query, options, mode, files }),
      );
    if (value.x < query.x + query.width || value.x + value.width > panel.x + panel.width)
      throw Error("JSON values overlap keys or overflow the panel at width " + width);
    if (process.argv.includes("--screenshots"))
      native.captureScreenshot(join(directory, "ui-json-width-" + width + ".png"));
  }
  const queryId = host.nodes.get(treeKey + "/query/key").nativeId;
  click({ id: host.nodes.get(treeKey + "/options/toggle").nativeId });
  if (events.at(-1)?.key !== 'json:mvalue:["options"]' || events.at(-1)?.open !== false)
    throw Error("JSON branch toggle did not preserve its exact path");
  treeState.details['json:mvalue:["options"]'] = false;
  host.apply({ revision: revision++, section: "json", projection: treePage() });
  settle();
  if (
    host.nodes.has(treeKey + "/options/mode/key") ||
    host.nodes.get(treeKey + "/query/key").nativeId !== queryId
  )
    throw Error("Collapsing a JSON branch affected unrelated rows");
  treeState.details['json:mvalue:["options"]'] = true;
  treeState.jsonEdits = { 'mvalue:["options","mode"]': '"unfinished' };
  host.apply({ revision: revision++, section: "json-edit", projection: treePage(true) });
  settle();
  const field = host.nodes.get(treeKey + "/options/mode/value");
  if (field.props.value !== '"unfinished' || field.style.borderColor !== "#c56d76")
    throw Error("JSON editing lost its invalid partial draft or warning");
  host.event({ elementId: field.nativeId, eventType: "change", value: '"fulltext"' });
  if (events.at(-1)?.type !== "native-json" || events.at(-1)?.path !== '["options","mode"]')
    throw Error("JSON value edits lost their structured path");
  click({ id: host.nodes.get(treeKey + "/paths/0/remove").nativeId });
  if (events.at(-1)?.operation !== "delete" || events.at(-1)?.path !== '["paths",0]')
    throw Error("JSON array removal lost its numeric path");
  console.log(
    "GPUI: JSON indentation, narrow wrapping, keyed folds, invalid drafts and exact edit/remove paths passed",
  );
  const checkboxPage = (checked) =>
    nativeProjection(
      element(
        "div",
        { id: "app" },
        element(
          "main",
          null,
          element(
            "label",
            { id: "checkbox-label" },
            element("input", { id: "checkbox-labeled", type: "checkbox", checked }),
            "Enable feature",
          ),
          element("input", {
            id: "checkbox-alone",
            type: "checkbox",
            "aria-label": "Standalone feature",
          }),
          element("input", {
            id: "checkbox-disabled",
            type: "checkbox",
            disabled: true,
            "aria-label": "Unavailable feature",
          }),
        ),
      ),
    );
  host.apply({ revision: revision++, section: "checkbox", projection: checkboxPage(false) });
  settle();
  const emptyBox = host.nodes.get("id:checkbox-labeled/box");
  const boxBounds = native.getElementBounds(emptyBox.nativeId);
  if (
    boxBounds.width !== 18 ||
    boxBounds.height !== 18 ||
    emptyBox.style.borderWidth !== 1 ||
    emptyBox.style.borderColor === emptyBox.style.background
  )
    throw Error("Unchecked checkbox has no visible square border");
  click({ id: emptyBox.nativeId });
  if (events.at(-1)?.id !== "checkbox-labeled" || events.at(-1)?.checked !== true)
    throw Error("Clicking the checkbox square did not toggle its label");
  host.apply({ revision: revision++, section: "checkbox", projection: checkboxPage(true) });
  settle();
  if (!host.nodes.has("id:checkbox-labeled/check"))
    throw Error("Checked checkbox has no SVG checkmark");
  click({ id: host.nodes.get("id:checkbox-label").nativeId });
  if (events.at(-1)?.id !== "checkbox-labeled" || events.at(-1)?.checked !== false)
    throw Error("Clicking a checkbox label did not toggle");
  native.focusElement(host.nodes.get("id:checkbox-alone").nativeId);
  native.simulateKeystrokes("space");
  settle();
  if (events.at(-1)?.id !== "checkbox-alone" || events.at(-1)?.checked !== true)
    throw Error("Standalone checkbox keyboard activation failed");
  const beforeDisabledCheckbox = events.length;
  click({ id: host.nodes.get("id:checkbox-disabled").nativeId });
  if (events.length !== beforeDisabledCheckbox) throw Error("Disabled checkbox toggled");
  if (process.argv.includes("--screenshots"))
    native.captureScreenshot(join(directory, "ui-checkboxes.png"));
  console.log(
    "GPUI: visible checkbox borders, SVG checks, label/pointer/keyboard and disabled states passed",
  );
  const selectPage = (value) =>
    element(
      "div",
      { id: "app" },
      element("header", null, "Select regression"),
      element(
        "main",
        null,
        element(
          "select",
          { id: "choice" },
          element("option", { value: "disk", selected: value === "disk" }, "Disk"),
          element("option", { disabled: true }, "Unavailable"),
          element("option", { value: "memory", selected: value === "memory" }, "Memory"),
        ),
        element(
          "div",
          { id: "below" },
          element("button", { "data-action": "under-popup" }, "Underlying action"),
        ),
      ),
    );
  host.apply({
    revision: revision++,
    section: "select",
    projection: nativeProjection(selectPage("disk")),
  });
  settle();
  const trigger = prop("aria-id", "choice");
  const belowBefore = native.getElementBounds(host.nodes.get("id:below").nativeId);
  const eventsBeforeOpen = events.length;
  click(trigger);
  if (!prop("aria-id", "choice/options")) throw Error("Official Select did not open");
  if (events.length !== eventsBeforeOpen) throw Error("Opening Select called the backend");
  if (
    JSON.stringify(native.getElementBounds(host.nodes.get("id:below").nativeId)) !==
    JSON.stringify(belowBefore)
  )
    throw Error("Select changed page layout");
  const disabled = prop("aria-label", "Unavailable");
  click(disabled);
  if (
    events
      .slice(eventsBeforeOpen)
      .some((event) => event.type === "change" || event.action === "under-popup")
  )
    throw Error("Disabled Select item selected or clicked through");
  native.simulateKeystrokes("down");
  settle();
  native.simulateKeystrokes("enter");
  settle();
  if (events.at(-1)?.type !== "change" || events.at(-1)?.value !== "memory")
    throw Error("Official Select keyboard selection failed: " + JSON.stringify(events.at(-1)));
  host.apply({
    revision: revision++,
    section: "select",
    projection: nativeProjection(selectPage("memory")),
  });
  settle();
  if (native.getFocusedElementId() !== host.nodes.get("id:choice").nativeId)
    throw Error("Official Select did not restore trigger focus");
  click(prop("aria-id", "choice"));
  native.simulateKeystrokes("escape");
  settle();
  if (prop("aria-id", "choice/options")) throw Error("Official Select Escape did not close");
  click(prop("aria-id", "choice"));
  native.simulateClick(350, 20);
  settle();
  if (prop("aria-id", "choice/options")) throw Error("Official Select outside click did not close");
  const nestedDialog = element(
    "div",
    { id: "app" },
    element(
      "div",
      { class: "dialog-overlay" },
      element(
        "dialog",
        { id: "nested-dialog", open: true },
        element("h2", null, "Nested Select"),
        selectPage("disk").children[1],
        element("button", { "data-action": "close-dialog" }, "Cancel"),
      ),
    ),
  );
  host.apply({
    revision: revision++,
    section: "nested-dialog",
    projection: nativeProjection(nestedDialog),
  });
  settle();
  click(prop("aria-id", "choice"));
  const beforeNestedEscape = events.length;
  native.simulateKeystrokes("escape");
  settle();
  if (
    prop("aria-id", "choice/options") ||
    events.slice(beforeNestedEscape).some((event) => event.action === "close-dialog")
  )
    throw Error("Escape closed the dialog behind its Select");
  native.simulateKeystrokes("escape");
  settle();
  if (events.at(-1)?.action !== "close-dialog")
    throw Error("Second Escape did not close the dialog");
  const longSelect = nativeProjection(
    element(
      "div",
      { id: "app" },
      element(
        "select",
        { id: "long-choice" },
        ...Array.from({ length: 30 }, (_, i) =>
          element("option", { value: String(i) }, "Option " + i),
        ),
      ),
    ),
  );
  const locate = (node, key) =>
    node.key === key
      ? node
      : (node.children || []).map((child) => locate(child, key)).find(Boolean);
  const size = native.getWindowSize();
  Object.assign(locate(longSelect.tree, "id:long-choice").style, {
    position: "absolute",
    left: size.width - 170,
    top: size.height - 60,
    width: 150,
  });
  host.apply({ revision: revision++, section: "long-select", projection: longSelect });
  settle();
  click(prop("aria-id", "long-choice"));
  const menu = prop("aria-id", "long-choice/options");
  const menuBounds = menu && native.getElementBounds(menu.id);
  if (
    !menuBounds ||
    menuBounds.x < 0 ||
    menuBounds.y < 0 ||
    menuBounds.x + menuBounds.width > size.width + 1 ||
    menuBounds.y + menuBounds.height > size.height + 1
  )
    throw Error("Official Select overflows viewport: " + JSON.stringify(menuBounds));
  native.simulateScrollWheel(menuBounds.x + 20, menuBounds.y + 60, 0, -90);
  settle();
  if (!prop("aria-id", "long-choice/options") || native.getScrollOffset(menu.id)[1] >= 0)
    throw Error("Long official Select did not scroll or dismissed itself");
  console.log(
    "GPUI: official Select overlay, disabled hits, keyboard selection, focus and dismissal passed",
  );

  const scrollView = element(
    "div",
    { id: "app" },
    element("header", null, "Native scroll regression"),
    element(
      "main",
      null,
      element(
        "table",
        { id: "wide" },
        element(
          "thead",
          null,
          element(
            "tr",
            null,
            ...Array.from({ length: 20 }, (_, i) => element("th", null, "Column " + i)),
          ),
        ),
        element(
          "tbody",
          null,
          element(
            "tr",
            null,
            ...Array.from({ length: 20 }, (_, i) => element("td", null, "Value " + i)),
          ),
        ),
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        element(
          "article",
          { class: "card" },
          element("h3", null, "Section " + i),
          element("p", null, "Content ".repeat(40)),
        ),
      ),
    ),
  );
  host.apply({ revision: revision++, section: "scroll", projection: nativeProjection(scrollView) });
  settle();
  const main = host.mainScroller;
  const bounds = native.getElementBounds(main.nativeId);
  const x = bounds.x + 50,
    y = bounds.y + 200;
  const eventCount = events.length;
  const startOffset = native.getScrollOffset(main.nativeId)[1];
  native.simulateScrollWheel(x, y, 0, -120);
  settle();
  if (Math.abs(native.getScrollOffset(main.nativeId)[1] - startOffset + 120) > 1)
    throw Error(
      "GPUIX precise wheel lost pixel motion: " +
        JSON.stringify({
          startOffset,
          after: native.getScrollOffset(main.nativeId),
          bounds,
          content: native.getElementBounds(host.nodes.get(main.key + "/scroll-content").nativeId),
        }),
    );
  if (events.length !== eventCount) throw Error("Wheel called the backend synchronously");
  native.scrollTo(main.nativeId, 0, 0);
  settle();
  const table = [...host.nodes.values()].find((node) => node.meta?.scrollAxis === "x");
  const tableBounds = native.getElementBounds(table.nativeId);
  native.simulateScrollWheel(tableBounds.x + 30, tableBounds.y + 10, -120, 0);
  settle();
  if (native.getScrollOffset(table.nativeId)[0] >= 0)
    throw Error("Native wide table did not pan horizontally");
  native.scrollTo(table.nativeId, -100000, 0);
  settle();
  const tableCells = [...host.nodes.values()].filter((node) => node.meta?.tag === "td");
  const lastCell = native.getElementBounds(tableCells.at(-1).nativeId);
  if (lastCell.x + lastCell.width > tableBounds.x + tableBounds.width + 1)
    throw Error("Final table column is unreachable after horizontal scrolling");
  const beforeChain = native.getScrollOffset(main.nativeId)[1];
  native.simulateScrollWheel(tableBounds.x + 30, tableBounds.y + 10, 0, -120);
  settle();
  if (
    Math.abs(native.getScrollOffset(main.nativeId)[1] - beforeChain + 120) > 1 ||
    native.getScrollOffset(table.nativeId)[1] !== 0
  )
    throw Error(
      "Vertical wheel over wide table did not chain to the page: " +
        JSON.stringify({
          main: native.getScrollOffset(main.nativeId),
          table: native.getScrollOffset(table.nativeId),
          tableBounds,
        }),
    );
  const beforeLineWheel = native.getScrollOffset(main.nativeId)[1];
  native.simulateScrollWheel(x, y, 0, -60);
  native.flush();
  gpuix.flushSync(() =>
    native
      .drainEvents()
      .forEach((event) =>
        host.dispatch(event.eventType === "scroll" ? { ...event, precise: false } : event),
      ),
  );
  native.flush();
  const preserved = native.getScrollOffset(main.nativeId)[1];
  if (Math.abs(preserved - beforeLineWheel + 60) > 1)
    throw Error(
      "Mouse wheel pixel delta was scaled/applied again: " +
        JSON.stringify({ beforeLineWheel, preserved }),
    );
  await Bun.sleep(0);
  settle();
  const applyBatch = native.applyBatch.bind(native);
  const batches = [];
  native.applyBatch = (packet) => {
    batches.push(...JSON.parse(packet));
    return applyBatch(packet);
  };
  host.apply({ revision: revision++, section: "scroll", projection: nativeProjection(scrollView) });
  settle();
  if (native.getScrollOffset(main.nativeId)[1] !== preserved)
    throw Error("An unrelated projection reset scroll offset");
  if (batches.some((mutation) => mutation[0] !== "destroyElement"))
    throw Error("React resent unchanged widgets: " + JSON.stringify(batches));
  batches.length = 0;
  const changedView = structuredClone(scrollView);
  changedView.children[0].children = ["Changed header"];
  const changedProjection = nativeProjection(changedView);
  host.apply({
    revision: revision++,
    section: "scroll",
    projection: changedProjection,
  });
  settle();
  if (!batches.some((mutation) => mutation[0] === "setText") || batches.length > 10)
    throw Error(
      "A header update touched the unchanged page: " +
        JSON.stringify(batches.slice(0, 12)) +
        "; total " +
        batches.length,
    );
  native.applyBatch = applyBatch;
  let geometryReads = 0;
  const getBounds = native.getElementBounds.bind(native);
  native.getElementBounds = (id) => {
    geometryReads++;
    return getBounds(id);
  };
  const wheelStart = performance.now();
  for (let i = 0; i < 12; i++) {
    native.simulateScrollWheel(x, y, 0, -48);
    settle();
  }
  if (geometryReads) throw Error("Application measured geometry while scrolling");
  native.getElementBounds = getBounds;
  console.log(
    "GPUI: native scroll, stable offsets, zero geometry polling, unchanged React bailout; " +
      ((performance.now() - wheelStart) / 12).toFixed(2) +
      " ms/test wheel cycle",
  );

  const longTreeText = "Long Tool Call text must wrap inside its value column. ".repeat(18);
  const longTreeToken = "ABCDEF0123456789".repeat(30);
  const detailState = {};
  const debugEntry = (key, text, id) =>
    element(
      "div",
      { class: "debug-entry" },
      element("span", { class: "debug-key" }, key + ":"),
      element("span", { class: "debug-string", id }, text),
    );
  const detailView = element(
    "div",
    { id: "app" },
    element("main", null, "Underlying page"),
    element(
      "div",
      { id: "detail-scroll", class: "tool-detail-overlay" },
      element(
        "div",
        { class: "tool-detail-grid" },
        element(
          "div",
          null,
          element(
            "div",
            { class: "debug-payload-tree" },
            element(
              "details",
              { class: "debug-node", open: true },
              element("summary", null, "Tool Call response"),
              element(
                "div",
                { class: "debug-children" },
                debugEntry("text", longTreeText, "long-tree-text"),
                debugEntry("token", longTreeToken, "long-tree-token"),
                element(
                  "details",
                  { id: "detail-fold", class: "debug-node", open: true },
                  element("summary", null, "Foldable group"),
                  ...Array.from({ length: 10 }, (_, i) => debugEntry("child " + i, "value")),
                ),
                ...Array.from({ length: 80 }, (_, i) => debugEntry("item " + i, "value " + i)),
              ),
            ),
          ),
          element(
            "div",
            { id: "detail-command", class: "terminal-command" },
            element("span", { class: "prompt" }, ">"),
            element("span", null, "bun run task.js " + "--option=value ".repeat(30)),
          ),
        ),
        element("aside", { class: "tool-descriptor" }, "Adjacent tool definition"),
      ),
    ),
  );
  const detailProjection = () => {
    const projection = nativeProjection(detailView, detailState);
    Object.assign(projection.tree.style, { width: 900, height: 620 });
    return projection;
  };
  host.apply({ revision: revision++, section: "detail-scroll", projection: detailProjection() });
  settle();
  for (const key of ["id:long-tree-text", "id:long-tree-token"]) {
    const container = host.nodes.get(key);
    const text = host.nodes.get(container.children[0].key);
    const box = native.getElementBounds(container.nativeId);
    const painted = native.getElementBounds(text.nativeId);
    if (painted.height <= 20 || painted.x + painted.width > box.x + box.width + 1)
      throw Error("Tool Call tree text overflows its value column: " + key);
  }
  if (native.getElementBounds(host.nodes.get("id:detail-command").nativeId).height <= 20)
    throw Error("Long command preview does not wrap");
  const overlay = host.nodes.get("id:detail-scroll");
  const detailBounds = native.getElementBounds(overlay.nativeId);
  const scrollTo = native.scrollTo.bind(native);
  let scrollWrites = 0;
  native.scrollTo = (...args) => {
    scrollWrites++;
    return scrollTo(...args);
  };
  for (let tick = 1; tick <= 8; tick++) {
    native.simulateScrollWheel(detailBounds.x + 40, detailBounds.y + 50, 0, -60);
    native.flush();
    gpuix.flushSync(() =>
      native
        .drainEvents()
        .forEach((event) =>
          host.dispatch(event.eventType === "scroll" ? { ...event, precise: false } : event),
        ),
    );
    native.flush();
    if (Math.abs(native.getScrollOffset(overlay.nativeId)[1] + tick * 60) > 1)
      throw Error("Mouse wheel skipped intermediate Tool Call detail content at tick " + tick);
  }
  if (scrollWrites) throw Error("Application rewrote native wheel offsets in the detail overlay");
  native.scrollTo = scrollTo;
  detailState.details = { "id:detail-fold": false };
  host.apply({ revision: revision++, section: "detail-scroll", projection: detailProjection() });
  settle();
  if (Math.abs(native.getScrollOffset(overlay.nativeId)[1] + 480) > 1)
    throw Error("Collapsing a Tool Call tree reset its intermediate scroll position");
  detailState.details["id:detail-fold"] = true;
  host.apply({ revision: revision++, section: "detail-scroll", projection: detailProjection() });
  settle();
  if (Math.abs(native.getScrollOffset(overlay.nativeId)[1] + 480) > 1)
    throw Error("Expanding a Tool Call tree reset its intermediate scroll position");
  native.simulateScrollWheel(detailBounds.x + 40, detailBounds.y + 50, 0, 60);
  native.flush();
  gpuix.flushSync(() =>
    native
      .drainEvents()
      .forEach((event) =>
        host.dispatch(event.eventType === "scroll" ? { ...event, precise: false } : event),
      ),
  );
  native.flush();
  if (Math.abs(native.getScrollOffset(overlay.nativeId)[1] + 420) > 1)
    throw Error("Mouse wheel cannot return upward through intermediate detail content");
  if (process.argv.includes("--screenshots"))
    native.captureScreenshot(join(directory, "ui-tool-tree-scroll.png"));
  console.log(
    "GPUI: long tree/token/command wrapping and incremental mouse wheel scrolling across folds passed",
  );

  const dragView = element(
    "div",
    { id: "app" },
    element(
      "main",
      null,
      element(
        "div",
        { "data-session-drag": "", "data-session-id": "42", class: "session-chip" },
        element("div", { id: "drag-child" }, element("b", null, "Session #42")),
      ),
      element(
        "div",
        { "data-root-drop": "7", class: "card" },
        element("div", { id: "drop-child" }, element("b", null, "Destination")),
      ),
      element(
        "div",
        { "data-root-drop": "0", class: "card" },
        element("div", { id: "unassign-child" }, "No Workspace"),
      ),
    ),
  );
  host.apply({ revision: revision++, section: "drag", projection: nativeProjection(dragView) });
  settle();
  const drag = (destination) => {
    const from = native.getElementBounds(host.nodes.get("id:drag-child").nativeId);
    const to = native.getElementBounds(host.nodes.get(destination).nativeId);
    native.simulateMouseDown(from.x + 20, from.y + 10);
    settle();
    native.simulateMouseMove(to.x + 20, to.y + 10, 0);
    settle();
    native.simulateMouseUp(to.x + 20, to.y + 10);
    settle();
  };
  drag("id:drop-child");
  if (
    events.at(-1)?.action !== "assign-session-root" ||
    events.at(-1)?.dataset?.rootId !== "7" ||
    events.at(-1)?.dataset?.id !== "42"
  )
    throw Error(
      "Native descendant-to-descendant drag did not assign Session: " +
        JSON.stringify(events.at(-1)),
    );
  drag("id:unassign-child");
  if (events.at(-1)?.dataset?.rootId !== "0") throw Error("Native drag did not unassign Workspace");
  const dropBounds = native.getElementBounds(host.nodes.get("id:drop-child").nativeId);
  const dropPaths = [join(directory, "fixture")];
  native.simulateFileDrop(dropBounds.x + 20, dropBounds.y + 10, dropPaths);
  settle();
  if (
    events.at(-1)?.type !== "native-drop" ||
    JSON.stringify(events.at(-1)?.paths) !== JSON.stringify(dropPaths)
  )
    throw Error("OS file drop on nested content did not reach the backend");
  console.log("GPUI: nested Session pointer drags and OS directory-drop dispatch passed");

  host.close();
  native.flush();
  if (native.getRetainedElementCount() !== 0) throw Error("React unmount leaked native elements");
  console.log(
    "GPUI React: page layouts, populated Subagents detail, managed dialogs, direct input and native cleanup passed",
  );
}
if (standalone) {
  // Exercise React and its native renderer from the embedded public package
  // closure, with a genuinely empty software cache and no development imports.
  const entry = join(directory, "react-smoke.js");
  const application = await fs.readFile(join(root, "mrmcp.js"), "utf8");
  const smoke =
    application.slice(0, application.lastIndexOf("\nif (import.meta.main) {")) +
    String.raw`
const { TestGpuixRenderer, hasTestGpuixRenderer, GpuixRenderer } = await loadRuntimePackage("@gpuix/native");
const nativeRuntime = await loadRuntimePackage("@gpuix/native/runtime");
if (typeof nativeRuntime.startFrameLoop !== "function") throw Error("Standalone native frame loop missing");
if (!hasTestGpuixRenderer()) {
  const [react, gpuix, host] = await Promise.all([
    loadRuntimePackage("react"), loadRuntimePackage("@gpuix/react"), loadRuntimePackage("@gpuix/native/host"),
  ]);
  if (typeof react.createElement !== "function" || typeof gpuix.createRoot !== "function" ||
      typeof host.createMutationQueue !== "function" || typeof GpuixRenderer !== "function")
    throw Error("Standalone public React/native package closure is incomplete");
  console.log("Standalone React: public renderer/host/dependencies load from empty cache; native interaction harness unavailable on this platform");
  process.exit(0);
}
const renderer = new TestGpuixRenderer(1180, 760);
const events = [];
const host = await NativeUiHost.create(renderer, (event) => events.push(event));
const page = (value) => nativeProjection(
  <div id="app"><header>Standalone React</header><main>
    <input id="smoke-input" value={value} />
    <select id="smoke-select"><option value="one">One</option><option value="two">Two</option></select>
    <button data-action="smoke-save">Save</button>
  </main></div>,
);
host.apply({ revision: 1, section: "smoke", projection: page("old") });
renderer.flush();
const input = host.nodes.get("id:smoke-input");
if (!input?.nativeId) throw Error("Standalone React did not mount native refs");
host.dispatch({ elementId: input.nativeId, eventType: "change", value: "typed" });
if (events.at(-1)?.value !== "typed") throw Error("Standalone direct input failed");
host.apply({ revision: 2, section: "smoke", projection: page("typed") });
renderer.flush();
if (host.nodes.get("id:smoke-input").nativeId !== input.nativeId)
  throw Error("Standalone React replaced the retained editor");
const gpuix = await loadRuntimePackage("@gpuix/react");
const trigger = host.nodes.get("id:smoke-select");
const bounds = renderer.getElementBounds(trigger.nativeId);
renderer.simulateClick(bounds.x + 10, bounds.y + 10);
gpuix.flushSync(() => renderer.drainEvents().forEach(event => host.dispatch(event)));
renderer.flush();
if (!renderer.getTreeJson().includes("smoke-select/options"))
  throw Error("Standalone official Select failed to open");
host.close();
renderer.flush();
if (renderer.getRetainedElementCount()) throw Error("Standalone React unmount leaked");
console.log("Standalone React: empty package cache, native refs, direct input and unmount passed");
process.exit(0);
`;
  await fs.writeFile(entry, smoke);
  const binary = join(directory, process.platform === "win32" ? "react-probe.exe" : "react-probe");
  const build = Bun.spawn(
    [
      process.execPath,
      join(root, ".github", "build.mjs"),
      process.platform,
      process.arch,
      binary,
      entry,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (await build.exited) throw Error("Standalone React smoke compilation failed");
  if (process.platform === "darwin") {
    const sign = Bun.spawn(["codesign", "--force", "--sign", "-", binary]);
    if (await sign.exited) throw Error("Standalone React smoke signing failed");
  }
  const cache = join(directory, "react-empty-cache");
  const child = Bun.spawn([binary], {
    cwd: directory,
    env: { ...process.env, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = setTimeout(() => child.kill(), 60000);
  const code = await child.exited;
  clearTimeout(deadline);
  if (code) throw Error("Standalone React smoke failed: " + code);
}
