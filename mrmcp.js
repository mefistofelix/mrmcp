/*
MrMCP 0.10.50 — Deno-owned event-driven UI and stateless MCP server with explicit context capabilities and an embedded WebView desktop window.
Runtime data: .mrmcp beside the script or standalone executable.
Run desktop GUI: deno run -A --unstable-ffi mrmcp.js
Run headless backend: deno run -A mrmcp.js --backend
GUI library: jsr:@webview/webview@0.9.0, imported directly by Deno.
*/

import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createBrotliCompress, createGzip, inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { Eta } from "jsr:@bgub/eta@4.6.0";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.1.2";
import { contentType as mediaContentType, typeByExtension } from "jsr:@std/media-types@1.1.0";

const SELF = new URL(import.meta.url);
const MODULE_DIR = dirname(fileURLToPath(SELF));
const APP_DIR = Deno.build.standalone ? dirname(Deno.execPath()) : MODULE_DIR;
const COMMANDS_PATH = join(APP_DIR, "commands.yaml");
const cliValue = name => { const index = Deno.args.indexOf(name); return index >= 0 ? String(Deno.args[index + 1] || "") : ""; };
const GUI_PORT = 7332;
const ADMIN_TOKEN = SELF.searchParams.get("admin") || cliValue("--admin") ||
  Deno.env.get("MRMCP_ADMIN_TOKEN") || crypto.randomUUID().replaceAll("-", "");
const BASE_TOOLS = [
  "create_context", "context_info", "read_file", "read_files", "write_file", "write_files",
  "edit", "replace", "glob", "grep",
  "file_info", "create_directory", "copy_path", "move_path", "delete_path",
  "publish_file", "list_commands", "exec", "exec_start", "exec_poll", "exec_write", "exec_kill", "exec_list",
  "js", "js_add_node_module_dir", "js_reset",
];
const READ_TOOLS = new Set([
  "context_info", "read_file", "read_files", "glob", "grep",
  "file_info", "list_commands", "exec_poll", "exec_list",
]);
const MCP_MODERN_PROTOCOL = "2026-07-28";
const MCP_PROTOCOLS = [MCP_MODERN_PROTOCOL];
const MCP_DEFAULT_PROTOCOL = MCP_MODERN_PROTOCOL;
const VERSION = "0.10.50";
const DB_SCHEMA_VERSION = 4;
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTEXT_HANDLE_INPUT_DESCRIPTION = "Required opaque capability returned by create_context. Pass the exact value unchanged; never invent, modify, shorten, derive or substitute it.";
const CONTEXT_HANDLE_OUTPUT_DESCRIPTION = "Opaque capability identifying a persistent MrMCP context. Pass this exact value unchanged as context_handle on later calls.";
const CONTEXT_HANDLE_RULE = "Requires the exact context_handle returned by create_context.";
const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";
const FILE_PREVIEW_UI_URI = "ui://mrmcp/image-preview-v3.html";
const enc = new TextEncoder(), dec = new TextDecoder();

const stringResponse = (body, status, type, headers = {}) => {
  body = String(body);
  const responseHeaders = new Headers({ "content-type": type, ...headers });
  if (!responseHeaders.has("content-length")) responseHeaders.set("content-length", String(new Blob([body]).size));
  return new Response(body, { status, headers: responseHeaders });
};
const json = (x, status = 200, headers = {}) =>
  stringResponse(JSON.stringify(x), status, "application/json; charset=utf-8", headers);
const text = (x, status = 200, type = "text/plain; charset=utf-8", headers = {}) =>
  stringResponse(x, status, type, headers);
const htmlEscape = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomUUID();
const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async value => b64url(new Uint8Array(
  await crypto.subtle.digest("SHA-256", value instanceof Uint8Array ? value : enc.encode(String(value))),
));
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const MAX_REQUEST_BODY = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
async function bodyText(req, max = MAX_REQUEST_BODY) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) throw new Error("Request body too large");
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error("Request body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return dec.decode(bytes);
}
const bodyJson = async req => JSON.parse(await bodyText(req) || "{}");
const form = async req => new URLSearchParams(await bodyText(req));
const HTTP_COMPRESSION_MIN_BYTES = 1024;
function appendVary(headers, value) {
  const values = new Map((headers.get("vary") || "").split(",")
    .map(x => x.trim()).filter(Boolean).map(x => [x.toLowerCase(), x]));
  values.set(value.toLowerCase(), value);
  headers.set("vary", [...values.values()].join(", "));
}
function preferredContentEncoding(value) {
  const qualities = new Map();
  for (const item of String(value || "").split(",")) {
    const [rawName, ...params] = item.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const match = param.trim().match(/^q\s*=\s*(.*)$/i);
      if (!match) continue;
      const valid = match[1].match(/^(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/);
      quality = valid ? Number(valid[1]) : 0;
    }
    qualities.set(name, Math.max(qualities.get(name) || 0, quality));
  }
  const quality = name => qualities.has(name) ? qualities.get(name) : (qualities.get("*") || 0);
  return [["br", quality("br"), 2], ["gzip", quality("gzip"), 1]]
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1] || b[2] - a[2])[0]?.[0] || "";
}
function compressibleContentType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") ||
    type === "application/javascript" || type === "application/xml" || type.endsWith("+xml") ||
    type === "application/yaml" || type === "application/x-yaml" || type === "image/svg+xml";
}
function compressHttpResponse(req, response) {
  if (!response.body || req.method === "HEAD" || [204, 205, 304].includes(response.status)) return response;
  const headers = new Headers(response.headers);
  if (new URL(req.url).pathname.startsWith("/oauth/") || headers.has("set-cookie")) return response;
  if (!compressibleContentType(headers.get("content-type"))) return response;
  appendVary(headers, "Accept-Encoding");
  const rebuild = body => new Response(body, {
    status: response.status, statusText: response.statusText, headers,
  });
  const length = Number(headers.get("content-length"));
  if (headers.has("content-encoding") || headers.has("content-range") ||
      /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get("cache-control") || "") ||
      !Number.isFinite(length) || length < HTTP_COMPRESSION_MIN_BYTES) return rebuild(response.body);
  const encoding = preferredContentEncoding(req.headers.get("accept-encoding"));
  if (!encoding) return rebuild(response.body);
  headers.set("content-encoding", encoding);
  headers.delete("content-length");
  const source = Readable.fromWeb(response.body);
  const compressed = source.pipe(encoding === "br" ? createBrotliCompress() : createGzip());
  return rebuild(Readable.toWeb(compressed));
}
const within = (root, path) => {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
};

function jsKernelWorkerSource() {/*
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

const moduleDirs = [];
const output = { stdout: [], stderr: [] };
let currentCwd = ".";

const format = value => typeof value === "string" ? value : inspect(value, {
  depth: 8, colors: false, compact: 3, maxArrayLength: 200, maxStringLength: 200000,
});
const write = (stream, values) => output[stream].push(values.map(format).join(" "));
globalThis.console = {
  log: (...v) => write("stdout", v), info: (...v) => write("stdout", v),
  debug: (...v) => write("stdout", v), warn: (...v) => write("stderr", v),
  error: (...v) => write("stderr", v),
};
globalThis.nodeRepl = {
  write: (...v) => write("stdout", v),
  moduleDirs: () => [...moduleDirs],
};
globalThis.cwd = currentCwd;

const anchors = () => moduleDirs.map(dir => createRequire(pathToFileURL(
  join(dir.endsWith("node_modules") ? dirname(dir) : dir, "__mrmcp__.cjs"),
).href));
function requireModule(specifier) {
  let last;
  for (const require of anchors()) {
    try { return require(specifier); } catch (error) { last = error; }
  }
  try { return createRequire(pathToFileURL(join(currentCwd, "__mrmcp__.cjs")).href)(specifier); }
  catch (error) { throw last || error; }
}
async function importModule(specifier) {
  if (/^(node:|npm:|jsr:|https?:|file:)/.test(specifier)) return await import(specifier);
  if (specifier.startsWith(".") || isAbsolute(specifier))
    return await import(pathToFileURL(resolve(currentCwd, specifier)).href);
  let last;
  for (const require of anchors()) {
    try { return await import(pathToFileURL(require.resolve(specifier)).href); }
    catch (error) { last = error; }
  }
  try {
    const require = createRequire(pathToFileURL(join(currentCwd, "__mrmcp__.cjs")).href);
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch (error) { throw last || error; }
}
globalThis.require = requireModule;
globalThis.importModule = importModule;

async function evaluate(code, cwd) {
  currentCwd = cwd || currentCwd;
  globalThis.cwd = currentCwd;
  output.stdout.length = output.stderr.length = 0;
  let value;
  try {
    value = (0, eval)(code);
  } catch (error) {
    if (!(error instanceof SyntaxError) || !/\bawait\b/.test(code)) throw error;
    value = await (async () => eval(code))();
  }
  value = await value;
  return {
    value: format(value),
    stdout: output.stdout.join("\n"),
    stderr: output.stderr.join("\n"),
    module_dirs: [...moduleDirs],
  };
}

self.onmessage = async event => {
  const { id, action } = event.data;
  try {
    if (action === "add_dir") {
      const dir = String(event.data.path);
      if (!moduleDirs.includes(dir)) moduleDirs.push(dir);
      self.postMessage({ id, ok: true, result: { module_dirs: [...moduleDirs] } });
    } else if (action === "eval") {
      self.postMessage({ id, ok: true, result: await evaluate(String(event.data.code), event.data.cwd) });
    } else {
      throw new Error(`Unknown kernel action: ${action}`);
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack || error) });
  }
};
*/}
const JS_KERNEL_SOURCE = jsKernelWorkerSource.toString().match(/\/\*([\s\S]*)\*\//)[1];

// Backend lifecycle, persistence and network services.
async function backend() {
  const DATA = join(APP_DIR, ".mrmcp");
  const TLS_DATA = DATA;
  const DB_PATH = join(DATA, "mrmcp.sqlite");
  const CERT_PATH = join(TLS_DATA, "fullchain.pem");
  const KEY_PATH = join(TLS_DATA, "privkey.pem");
  const SELF_CERT_PATH = join(TLS_DATA, "selfsigned.pem");
  const SELF_KEY_PATH = join(TLS_DATA, "selfsigned-key.pem");
  const PUBLIC_HOST = "0.0.0.0", HTTP_PORT = 80, HTTPS_PORT = 443;
  const BIN_DIR = join(DATA, "bin");
  const TEMP_DIR = join(DATA, "tmp");
  Deno.mkdirSync(BIN_DIR, { recursive: true });
  Deno.mkdirSync(DATA, { recursive: true });
  await Deno.remove(TEMP_DIR, { recursive: true }).catch(error => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  Deno.mkdirSync(TEMP_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  let uiRevision = 0;
  const uiRenderStreams = new Set();
  const UI_SECTIONS = new Set(["dashboard", "sessions", "logs", "roots", "commands", "debug", "oauth", "settings", "help"]);
  const uiState = {
    currentSection: "dashboard",
    scrollBySection: { dashboard: [0, 0] },
    focus: null,
    dialog: null,
    notice: null,
    settingsDraft: null,
    lastInputSequence: 0,
    commands: { page: 1, query: "", pageSize: 25, includeMissing: true },
    sessions: { oauthClientId: "" },
    logs: { page: 1, query: "", context: "", status: "", pageSize: 25, openRowId: "", selfTest: null },
    debug: { query: "", method: "", status: "", openRowId: "" },
  };
  let uiRenderTimer = null, uiLogFilterTimer = null, uiRenderRunning = false, uiRenderQueued = false;
  let uiInputChain = Promise.resolve(), uiInputDepth = 0;
  const normalizedUiScopes = scopes => [...new Set((Array.isArray(scopes) ? scopes : [scopes])
    .map(String).map(value => value.trim()).filter(Boolean))];
  function uiScopesAffectCurrent(scopes) {
    const values = new Set(normalizedUiScopes(scopes));
    return values.has("all") || values.has("state") || values.has("view") ||
      values.has(uiState.currentSection) || (uiState.currentSection === "dashboard" && values.has("endpoints"));
  }
  function emitUiChange(scopes = ["state"], reason = "change") {
    if (uiScopesAffectCurrent(scopes)) queueUiRender(reason);
  }
  function queueUiRender(reason = "change", delay = 18) {
    uiRenderQueued = true;
    if (!uiRenderStreams.size || uiInputDepth || uiRenderRunning || uiRenderTimer) return;
    uiRenderTimer = setTimeout(() => {
      uiRenderTimer = null;
      drainUiRenderQueue(reason).catch(error => {
        console.error("MrMCP UI render failed", error);
        uiRenderRunning = false;
        uiRenderQueued = false;
        const message = htmlEscape(String(error?.stack || error));
        const payload = JSON.stringify({
          revision: ++uiRevision,
          html: `<div id="app" data-section="${htmlEscape(uiState.currentSection)}"><header><b>🧩 MrMCP</b></header><main style="margin-left:0"><div class="card tls-alert"><h2>UI render failed</h2><pre>${message}</pre></div></main></div>`,
          section: uiState.currentSection,
          scroll: [0, 0], focus: null, ack: uiState.lastInputSequence,
          reason: "render-error", at: Date.now(),
        });
        const chunk = enc.encode(`event: render\nid: ${uiRevision}\ndata: ${payload}\n\n`);
        for (const subscriber of [...uiRenderStreams]) {
          try { subscriber.controller.enqueue(chunk); }
          catch { uiRenderStreams.delete(subscriber); }
        }
      });
    }, Math.max(0, Number(delay) || 0));
  }
  async function drainUiRenderQueue(reason = "change") {
    if (uiRenderRunning) return;
    uiRenderRunning = true;
    try {
      while (uiRenderQueued) {
        uiRenderQueued = false;
        await Promise.resolve();
        const html = await renderUiDocument();
        const payload = JSON.stringify({
          revision: ++uiRevision,
          html,
          section: uiState.currentSection,
          scroll: uiState.scrollBySection[uiState.currentSection] || [0, 0],
          focus: uiState.focus,
          ack: uiState.lastInputSequence,
          reason,
          at: Date.now(),
        });
        const chunk = enc.encode(`event: render\nid: ${uiRevision}\ndata: ${payload}\n\n`);
        for (const subscriber of [...uiRenderStreams]) {
          try { subscriber.controller.enqueue(chunk); }
          catch { uiRenderStreams.delete(subscriber); }
        }
        if (uiRenderQueued) await sleep(0);
      }
    } finally {
      uiRenderRunning = false;
      if (uiRenderQueued) queueUiRender("coalesced", 0);
    }
  }
  function uiEventStream() {
    let subscriber;
    const stream = new ReadableStream({
      start(controller) {
        subscriber = { controller };
        uiRenderStreams.add(subscriber);
        controller.enqueue(enc.encode(`: MrMCP UI stream connected\n\n`));
        queueUiRender("connected", 0);
      },
      cancel() { if (subscriber) uiRenderStreams.delete(subscriber); },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  function uiScopesForSql(sql) {
    const statement = String(sql || "").trim().toLowerCase();
    if (!/^(?:insert|update|delete|replace)\b/.test(statement)) return [];
    const scopes = new Set();
    if (/\blogs\b/.test(statement)) ["logs", "sessions", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\bcontexts\b/.test(statement)) ["sessions", "logs", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\broots\b/.test(statement)) ["roots", "sessions", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\bdebug_logs\b/.test(statement)) scopes.add("debug");
    if (/\bprocess_runs\b/.test(statement)) ["logs", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\bcustom_tools\b/.test(statement)) ["commands", "dashboard", "endpoints"].forEach(scope => scopes.add(scope));
    if (/\boauth_(?:clients|tokens|refresh_tokens|codes)\b/.test(statement)) ["oauth", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\bserver_config\b/.test(statement)) ["dashboard", "endpoints", "settings", "oauth"].forEach(scope => scopes.add(scope));
    if (/\bconfig\b/.test(statement)) ["dashboard", "settings", "debug", "tls", "endpoints"].forEach(scope => scopes.add(scope));
    if (/\bmetrics\b/.test(statement)) scopes.add("dashboard");
    return [...scopes];
  }
  const existingSchemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);
  const existingUserTables = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).get()?.count || 0);
  if (existingUserTables && existingSchemaVersion !== DB_SCHEMA_VERSION) throw new Error(
    `Unsupported .mrmcp/mrmcp.sqlite schema ${existingSchemaVersion}. ` +
    `MrMCP development builds do not migrate databases. Delete .mrmcp/mrmcp.sqlite and restart.`,
  );
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS config(
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_config(
      id INTEGER PRIMARY KEY CHECK(id=1),
      name TEXT NOT NULL,
      oauth INTEGER NOT NULL DEFAULT 1,
      basic_enabled INTEGER NOT NULL DEFAULT 0,
      basic_username TEXT NOT NULL DEFAULT 'mrmcp',
      basic_secret_enc TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_tools(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id,name),
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      server_id INTEGER,
      server_name TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      resolved_json TEXT NOT NULL DEFAULT '',
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      context_id INTEGER NOT NULL DEFAULT 0,
      context_handle TEXT NOT NULL DEFAULT '',
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS logs_time ON logs(started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_server ON logs(server_name,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_tool ON logs(tool,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_context ON logs(context_handle,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_context_id ON logs(context_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS debug_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      remote_addr TEXT NOT NULL DEFAULT '',
      request_headers TEXT NOT NULL DEFAULT '',
      request_body TEXT NOT NULL DEFAULT '',
      response_headers TEXT NOT NULL DEFAULT '',
      response_body TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS debug_logs_time ON debug_logs(ts DESC);
    CREATE INDEX IF NOT EXISTS debug_logs_status ON debug_logs(status,ts DESC);
    CREATE INDEX IF NOT EXISTS debug_logs_method ON debug_logs(method,ts DESC);
    CREATE TABLE IF NOT EXISTS oauth_clients(
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirects_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes(
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens(
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens(
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_tokens(client_id);
    CREATE INDEX IF NOT EXISTS oauth_refresh_server ON oauth_refresh_tokens(server_id);
    CREATE TABLE IF NOT EXISTS roots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id,name),
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS contexts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL UNIQUE,
      server_id INTEGER NOT NULL,
      root_id INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL DEFAULT 0,
      protocol_version TEXT NOT NULL DEFAULT '',
      auth_kind TEXT NOT NULL DEFAULT '',
      oauth_client_id TEXT NOT NULL DEFAULT '',
      client_name TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS contexts_server ON contexts(server_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS contexts_active ON contexts(last_active_at DESC);
    CREATE INDEX IF NOT EXISTS contexts_root ON contexts(server_id,root_id);
    CREATE TABLE IF NOT EXISTS process_runs(
      id TEXT PRIMARY KEY,
      pid INTEGER,
      server_id INTEGER NOT NULL,
      server_name TEXT NOT NULL,
      context_id INTEGER NOT NULL DEFAULT 0,
      context_handle TEXT NOT NULL DEFAULT '',
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      command_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      exit_code INTEGER,
      signal TEXT NOT NULL DEFAULT '',
      timeout_ms INTEGER NOT NULL DEFAULT 0,
      stdout_tail TEXT NOT NULL DEFAULT '',
      stderr_tail TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS process_runs_time ON process_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS metrics(
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => {
    const result = db.prepare(sql).run(...args);
    const scopes = uiScopesForSql(sql);
    if (scopes.length) emitUiChange(scopes, "database");
    return result;
  };
  const getCfg = (key, fallback) => one("SELECT value FROM config WHERE key=?", key)?.value ?? fallback;
  const setCfg = (key, value) => run(
    "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key, String(value),
  );
  const requiredSchema = {
    server_config: ["oauth", "basic_enabled", "basic_username", "basic_secret_enc"],
    roots: ["server_id", "name", "path", "enabled"],
    contexts: ["id", "handle", "server_id", "root_id", "created_at", "updated_at", "last_active_at", "protocol_version", "auth_kind", "oauth_client_id", "client_name", "user_agent"],
    process_runs: ["context_id", "context_handle", "root_id", "root_name", "root_path", "stdout_tail", "stderr_tail"],
    logs: ["id", "server_name", "tool", "status", "input_json", "context_id", "context_handle", "root_id", "root_name", "root_path"],
    oauth_refresh_tokens: ["token_hash", "client_id", "server_id", "resource", "scope", "last_used_at"],
  };
  const schemaErrors = [];
  for (const [table, columns] of Object.entries(requiredSchema)) {
    const present = new Set(all(`PRAGMA table_info(${table})`).map(column => column.name));
    if (!present.size) schemaErrors.push(`missing table ${table}`);
    else for (const column of columns) if (!present.has(column)) schemaErrors.push(`${table}.${column}`);
  }
  if (schemaErrors.length) throw new Error(
    `Invalid clean database schema (${schemaErrors.join(", ")}). Delete .mrmcp/mrmcp.sqlite and restart.`,
  );
  db.exec(`PRAGMA user_version=${DB_SCHEMA_VERSION}`);
  let fts = true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
      log_id UNINDEXED, server, tool, input, output, stderr, error,
      tokenize='unicode61'
    )`);
  } catch { fts = false; }
  run("INSERT OR IGNORE INTO metrics(name,value) VALUES('requests',0)");
  const startupTime = Date.now();
  run("UPDATE process_runs SET status='orphaned',completed_at=? WHERE status IN ('starting','running')", startupTime);
  run(`UPDATE logs SET status='orphaned',completed_at=?
    WHERE status IN ('received','running')`, startupTime);
  for (const [k, v] of [
    ["mcp_host", "0.0.0.0"], ["mcp_port", "80"], ["external_url", ""],
    ["mcp_http_enabled", "1"], ["mcp_http_port", "80"],
    ["mcp_https_enabled", "1"], ["mcp_https_port", "443"],
    ["public_ip", ""], ["public_ip_checked_at", "0"],
    ["tls_mode", "letsencrypt"], ["tls_domain", ""], ["tls_email", "mrmcp@mrmcp.com"],
    ["public_ip_urls_json", JSON.stringify(["https://api.ipify.org?format=json"])],
    ["sslip_suffix", "sslip.io"],
    ["acme_directory_url", "https://acme-v02.api.letsencrypt.org/directory"],
    ["tls_staging", "0"], ["tls_auto_renew", "1"],
    ["tls_cert_path", CERT_PATH], ["tls_key_path", KEY_PATH],
    ["tls_cert_expires", ""], ["tls_cert_ip", ""], ["tls_last_error", ""], ["tls_last_issued_at", "0"],
    ["tls_last_request_at", "0"], ["tls_last_request_status", ""], ["tls_last_request_valid", "0"],
    ["tls_next_attempt_at", "0"], ["tls_rate_limit_reset_at", "0"], ["tls_renewal_due_at", "0"],
    ["tls_self_signed_created_at", "0"], ["debug_http_log", "0"],
    ["inherit_system_path", "1"],
  ]) if (!one("SELECT 1 FROM config WHERE key=?", k)) setCfg(k, v);
  setCfg("tls_cert_path", CERT_PATH);
  setCfg("tls_key_path", KEY_PATH);
  setCfg("tls_staging", "0");
  setCfg("tls_auto_renew", "1");
  setCfg("tls_mode", "letsencrypt");
  if (!one("SELECT 1 FROM server_config")) run(
    `INSERT INTO server_config(id,name,oauth,created_at) VALUES(1,?,?,?)`,
    "MrMCP", 1, Date.now(),
  );
  const SESSION = randomToken(), CSRF = randomToken();
  const processes = new Map(), jsKernels = new Map(), activeCallControls = new Map(),
    oauthConsents = new Map(), rateBuckets = new Map(), downloadTokens = new Map();
  const sealSecret = value => String(value || "");
  const openSecret = value => String(value || "");
  let shuttingDown = false, mcpHttpServer, mcpHttpsServer;
  let mcpHttpActive = false, mcpTlsActive = false, mcpTlsKind = "none";
  let mcpTlsValid = false, mcpTlsTrusted = false, mcpTlsInfo = null;
  let mcpListenError = "", renewalTimer, processCleanupTimer, downloadCleanupTimer;
  const acmeChallenges = new Map();

  const ipv4 = value => isIP(String(value || "").trim()) === 4;
  const sslipHostname = ip => {
    ip = String(ip || "").trim();
    const suffix = getCfg("sslip_suffix", "sslip.io").trim().replace(/^\.+|\.+$/g, "") || "sslip.io";
    return ipv4(ip) ? `${ip.replaceAll(".", "-")}.${suffix}` : "";
  };
  const localHttpsBase = () => "https://127.0.0.1";
  const localBase = () => localHttpsBase();
  const directIpBase = () => {
    const ip = getCfg("public_ip", "").trim();
    return ipv4(ip) ? `https://${ip}` : "";
  };
  const sslipBase = () => {
    const host = sslipHostname(getCfg("public_ip", ""));
    return host ? `https://${host}` : "";
  };
  const sslipCertificateReady = () =>
    mcpTlsActive && mcpTlsTrusted && mcpTlsInfo?.identityValid &&
    mcpTlsInfo?.host === sslipHostname(getCfg("public_ip", ""));
  const automaticExternalBase = () => mcpTlsActive ? (sslipBase() || directIpBase()) : "";
  const publicBase = () => {
    const external = getCfg("external_url", "").replace(/\/+$/, "");
    return external || automaticExternalBase() || localBase();
  };
  const publicOrigin = () => {
    try { return new URL(publicBase()).origin; }
    catch { return publicBase(); }
  };
  const serverConfig = () => one("SELECT * FROM server_config WHERE id=1");
  const mcpUrl = () => `${publicBase()}/mcp`;
  const metadataUrl = () => `${publicBase()}/.well-known/oauth-protected-resource/mcp`;
  const serverCapabilities = fullAccess => fullAccess ? {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    extensions: {
      [MCP_UI_EXTENSION]: { mimeTypes: [MCP_UI_MIME_TYPE] },
    },
  } : {};
  const filePreviewUiMeta = () => ({
    ui: {
      prefersBorder: false,
      csp: { resourceDomains: [publicOrigin()] },
    },
  });
  const filePreviewResource = () => ({
    uri: FILE_PREVIEW_UI_URI,
    name: "mrmcp_file_preview",
    title: "MrMCP file preview",
    description: "Minimal sandboxed MCP App that displays an image directly from the HTTPS resource_link returned by publish_file.",
    mimeType: MCP_UI_MIME_TYPE,
    _meta: filePreviewUiMeta(),
  });
  function filePreviewAppHtml() {
    return String.raw`<!doctype html>
<html lang="en" data-mode="inline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MrMCP image preview</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body, main { margin: 0; width: 100%; min-width: 0; background: transparent; }
#stage { position: relative; display: none; width: 100%; place-items: center; overflow: hidden; }
#image { display: block; width: 100%; height: auto; object-fit: contain; }
#actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; opacity: .25; transition: opacity .15s; }
#stage:hover #actions, #actions:focus-within { opacity: 1; }
#actions button, #actions a { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid #ffffff55; border-radius: 8px; color: white; background: #000b; font: 20px/1 system-ui, sans-serif; text-decoration: none; cursor: pointer; }
#actions [hidden] { display: none; }
#error { display: none; padding: 10px; color: var(--color-text-danger, #b42318); font: 14px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
html[data-mode="fullscreen"], html[data-mode="fullscreen"] body, html[data-mode="fullscreen"] main { height: 100%; overflow: hidden; }
html[data-mode="fullscreen"] #stage { display: grid; height: 100%; }
html[data-mode="fullscreen"] #image { width: 100%; height: 100%; }
@media (hover: none) { #actions { opacity: 1; } }
</style>
</head>
<body>
<main>
  <div id="stage">
    <img id="image" alt="Published image">
    <div id="actions">
      <button id="fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen" hidden>⛶</button>
      <a id="open" target="_blank" rel="noopener noreferrer" title="Open original" aria-label="Open original">↗</a>
    </div>
  </div>
  <div id="error" role="alert"></div>
</main>
<script>
(function () {
  'use strict';
  var root = document.documentElement;
  var stage = document.getElementById('stage');
  var image = document.getElementById('image');
  var open = document.getElementById('open');
  var fullscreen = document.getElementById('fullscreen');
  var error = document.getElementById('error');
  var pending = new Map();
  var nextId = 1;
  var currentMode = 'inline';
  var fullscreenAvailable = false;

  function post(message) { window.parent.postMessage(message, '*'); }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function request(method, params, timeoutMs) {
    var id = nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      var timer = timeoutMs ? setTimeout(function () {
        pending.delete(id);
        reject(new Error(method + ' timeout'));
      }, timeoutMs) : 0;
      pending.set(id, {
        resolve: function (value) { if (timer) clearTimeout(timer); resolve(value); },
        reject: function (reason) { if (timer) clearTimeout(timer); reject(reason); }
      });
    });
  }
  function array(value) { return Array.isArray(value) ? value : []; }
  function resourceLink(result) {
    return array(result && result.content).find(function (item) {
      return item && item.type === 'resource_link' && typeof item.uri === 'string';
    });
  }
  function showError(text) {
    error.textContent = text || '';
    error.style.display = text ? 'block' : 'none';
  }
  function setMode(mode) {
    currentMode = mode === 'fullscreen' ? 'fullscreen' : 'inline';
    root.dataset.mode = currentMode;
    fullscreen.title = currentMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
    fullscreen.setAttribute('aria-label', fullscreen.title);
  }
  function applyHostContext(context) {
    context = context || {};
    if (context.theme) root.style.colorScheme = context.theme;
    if (context.displayMode) setMode(context.displayMode);
    fullscreenAvailable = array(context.availableDisplayModes).indexOf('fullscreen') >= 0;
    fullscreen.hidden = !fullscreenAvailable;
  }
  function render(result) {
    result = result || {};
    var structured = result.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent : result;
    var link = resourceLink(result);
    var uri = (link && link.uri) || (typeof structured.uri === 'string' ? structured.uri : '');
    var mime = String((link && link.mimeType) || structured.mime_type || '').toLowerCase();
    var filename = String((link && (link.title || link.name)) || structured.filename || 'Published image');
    showError('');
    if (!uri) {
      stage.style.display = 'none';
      showError('This preview requires publish_file with return_mode link or both.');
      return;
    }
    if (mime && mime.indexOf('image/') !== 0) {
      stage.style.display = 'none';
      showError('This minimal preview displays image resource links only.');
      return;
    }
    image.alt = filename;
    open.href = uri;
    image.src = uri;
    stage.style.display = 'grid';
  }
  function toggleFullscreen() {
    if (!fullscreenAvailable) return;
    var requested = currentMode === 'fullscreen' ? 'inline' : 'fullscreen';
    fullscreen.disabled = true;
    request('ui/request-display-mode', { mode: requested }, 3000).then(function (result) {
      setMode(result && result.mode ? result.mode : requested);
    }).catch(function () {}).finally(function () { fullscreen.disabled = false; });
  }

  fullscreen.addEventListener('click', toggleFullscreen);
  image.addEventListener('dblclick', toggleFullscreen);
  image.addEventListener('load', function () { showError(''); });
  image.addEventListener('error', function () {
    stage.style.display = 'none';
    showError('Unable to load the published image resource. The temporary URL may have expired; publish the file again.');
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      var item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(message.error); else item.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') render(message.params);
    if (message.method === 'ui/notifications/host-context-changed') applyHostContext(message.params);
  }, { passive: true });

  var openai = typeof window !== 'undefined' ? window.openai : undefined;
  if (openai && openai.toolOutput) render(openai.toolOutput);

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'mrmcp-image-preview', version: '1.2.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }, 3000).then(function (result) {
    applyHostContext(result && result.hostContext);
    notify('ui/notifications/initialized', {});
    if (openai && openai.toolOutput) render(openai.toolOutput);
  }).catch(function () {
    if (openai && openai.toolOutput) render(openai.toolOutput);
  });

  if (typeof ResizeObserver === 'function') {
    var lastWidth = 0, lastHeight = 0;
    new ResizeObserver(function () {
      var width = Math.ceil(document.documentElement.scrollWidth);
      var height = Math.ceil(document.documentElement.scrollHeight);
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width; lastHeight = height;
      notify('ui/notifications/size-changed', { width: width, height: height });
    }).observe(document.documentElement);
  }
})();
</script>
</body>
</html>`;
  }
  const MIME_OVERRIDES = new Map([
    [".mmd", "text/plain"], [".d2", "text/plain"],
    [".sqlite", "application/vnd.sqlite3"], [".db", "application/octet-stream"],
  ]);
  const mimeEssence = value => String(value || "").split(";", 1)[0].trim().toLowerCase();
  const inferredMimeType = path => {
    const extension = extname(String(path)).toLowerCase();
    return MIME_OVERRIDES.get(extension) || typeByExtension(extension) || "application/octet-stream";
  };
  const responseContentType = (mimeType, filename) =>
    mediaContentType(String(mimeType || "").trim()) ||
    mediaContentType(extname(String(filename || "")).toLowerCase()) ||
    String(mimeType || "application/octet-stream");
  const isRasterImageMime = mimeType => {
    const essence = mimeEssence(mimeType);
    return essence.startsWith("image/") && essence !== "image/svg+xml";
  };
  const isInlinePreviewMime = mimeType => {
    const essence = mimeEssence(mimeType);
    return essence.startsWith("image/") || essence.startsWith("text/") ||
      essence.startsWith("audio/") || essence.startsWith("video/") ||
      essence === "application/pdf" || essence === "application/json" || essence.endsWith("+json") ||
      essence === "application/xml" || essence.endsWith("+xml") ||
      essence === "application/javascript" || essence === "application/wasm";
  };
  const isActiveDocumentMime = mimeType => {
    const essence = mimeEssence(mimeType);
    return essence === "image/svg+xml" || essence === "text/html" || essence === "application/xhtml+xml" ||
      essence === "application/xml" || essence === "text/xml" || essence.endsWith("+xml");
  };
  const safeDownloadName = value => {
    const name = basename(String(value || "download")).replace(/[\u0000-\u001f\u007f<>:\"|?*\/\\]/g, "_").trim();
    return name && name !== "." && name !== ".." ? name.slice(0, 240) : "download";
  };
  const boundedExpirySeconds = value => {
    const seconds = Number(value ?? 86400);
    return Number.isFinite(seconds) ? Math.max(30, Math.min(seconds, 604800)) : 86400;
  };
  const downloadUrl = (token, filename) => `${publicBase()}/download/${token}/${encodeURIComponent(filename)}`;
  async function cleanupDownloadRecord(token, record, removeFile = false) {
    if (downloadTokens.get(token) === record) downloadTokens.delete(token);
    if (removeFile && record?.delete_after) await Deno.remove(record.path).catch(() => {});
  }
  async function expireDownloadTokens(now = Date.now()) {
    for (const [token, record] of downloadTokens)
      if (record.expires_at <= now) await cleanupDownloadRecord(token, record, true);
  }
  async function cleanupAllDownloadTokens() {
    await Promise.allSettled([...downloadTokens].map(([token, record]) => cleanupDownloadRecord(token, record, true)));
  }
  async function publishPath(path, options = {}) {
    const allowedRoot = await Deno.realPath(options.allowed_root || dirname(path));
    const realPath = await Deno.realPath(path);
    if (!within(allowedRoot, realPath)) throw new Error("Published file resolves outside its allowed root");
    const stat = await Deno.stat(realPath);
    if (!stat.isFile) throw new Error("Only regular files can be published");
    const filename = safeDownloadName(options.filename || basename(realPath));
    const mimeType = String(options.mime_type || inferredMimeType(filename)).trim() || "application/octet-stream";
    if (/[^\x20-\x7e]/.test(mimeType) || !/^[^\s\/]+\/[^\s]+$/.test(mimeType))
      throw new Error("Invalid MIME type");
    const returnMode = String(options.return_mode || "link").trim().toLowerCase();
    if (!["inline", "link", "both"].includes(returnMode))
      throw new Error("return_mode must be inline, link, or both");
    const rasterImage = isRasterImageMime(mimeType);
    if (returnMode === "inline" && !rasterImage)
      throw new Error("return_mode=inline is supported only for non-SVG raster images");
    if (returnMode === "inline" && stat.size > MAX_INLINE_IMAGE_BYTES)
      throw new Error(`Image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte inline limit; use return_mode=link or both`);

    const wantsInline = returnMode !== "link" && rasterImage && stat.size <= MAX_INLINE_IMAGE_BYTES;
    const wantsLink = returnMode !== "inline";
    const content = [];
    if (wantsInline) {
      const inlineData = Buffer.from(await Deno.readFile(realPath)).toString("base64");
      content.push({ type: "image", data: inlineData, mimeType });
    }

    let uri, expiresAt, record;
    if (wantsLink) {
      const token = randomToken(32);
      expiresAt = Date.now() + boundedExpirySeconds(options.expires_in) * 1000;
      record = {
        path: realPath, allowed_root: allowedRoot, filename, mime_type: mimeType, size: stat.size,
        expires_at: expiresAt, one_time: options.one_time === true, delete_after: options.delete_after === true,
      };
      downloadTokens.set(token, record);
      uri = downloadUrl(token, filename);
      content.push({
        type: "resource_link", uri, name: filename, title: filename,
        description: String(options.description || `${mimeEssence(mimeType).startsWith("image/") ? "Image preview" : "Published file"}: ${filename}`),
        mimeType, size: stat.size,
        annotations: { audience: ["user"], priority: 1 },
      });
    }

    const inlineOmittedReason = returnMode === "both" && !wantsInline
      ? (!rasterImage ? "File MIME type is not an inline raster image" : `Image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte inline limit`)
      : undefined;
    return {
      mcp_content: content, filename, mime_type: mimeType, size: stat.size,
      return_mode: returnMode, inline: wantsInline, linked: wantsLink,
      ...(uri ? {
        uri,
        markdown: mimeEssence(mimeType).startsWith("image/") ? `![${filename}](${uri})` : `[Download ${filename}](${uri})`,
        expires_at: new Date(expiresAt).toISOString(), one_time: record.one_time,
      } : {}),
      ...(inlineOmittedReason ? { inline_omitted_reason: inlineOmittedReason } : {}),
    };
  }
  async function processReturnFiles(rec, args) {
    const requested = args.return_files;
    if (!Array.isArray(requested) || !requested.length || rec.status !== "completed") return null;
    const root = await Deno.realPath(rec.root_path);
    const prepared = [], seen = new Set();
    for (const raw of requested) {
      const value = String(raw || "").trim();
      if (!value) throw new Error("return_files entries must be non-empty paths");
      const candidate = isAbsolute(value) ? resolve(value) : resolve(rec.cwd, value);
      const realPath = await Deno.realPath(candidate).catch(() => null);
      if (!realPath) throw new Error(`Returned file does not exist: ${value}`);
      if (!within(root, realPath)) throw new Error(`Returned file resolves outside the selected context root: ${value}`);
      const stat = await Deno.stat(realPath);
      if (!stat.isFile) throw new Error(`Returned path is not a regular file: ${value}`);
      const key = Deno.build.os === "windows" ? realPath.toLowerCase() : realPath;
      if (seen.has(key)) continue;
      seen.add(key);
      prepared.push({
        path: realPath, stat,
        display: relative(root, realPath).split(sep).join("/") || basename(realPath),
      });
    }
    let inlineBudget = MAX_INLINE_IMAGE_BYTES;
    const mcpContent = [], files = [];
    for (const entry of prepared) {
      const mimeType = inferredMimeType(entry.path);
      const mayInline = args.return_files_inline !== false && isRasterImageMime(mimeType) &&
        entry.stat.size <= inlineBudget;
      const result = await publishPath(entry.path, {
        filename: basename(entry.path), mime_type: mimeType,
        expires_in: args.return_files_expires_in, one_time: args.return_files_one_time,
        return_mode: mayInline ? "both" : "link", allowed_root: root,
        description: `Output file created by ${rec.display}`,
      });
      if (result.inline) inlineBudget -= result.size;
      mcpContent.push(...result.mcp_content);
      const { mcp_content: _content, ...metadata } = result;
      files.push({ path: entry.display, ...metadata });
    }
    return { mcp_content: mcpContent, returned_files: files };
  }

  const contentDisposition = (filename, mode = "attachment") => {
    const fallback = safeDownloadName(filename).replace(/["\\]/g, "_");
    const disposition = mode === "inline" ? "inline" : "attachment";
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  };
  async function downloadResponse(req, u) {
    const match = u.pathname.match(/^\/download\/([A-Za-z0-9_-]{40,})\/([^/]+)$/);
    if (!match || !["GET", "HEAD"].includes(req.method))
      return text("Not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    const token = match[1], record = downloadTokens.get(token);
    if (!record || record.expires_at <= Date.now()) {
      if (record) await cleanupDownloadRecord(token, record, true);
      return text("Download expired or not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    }
    let requestedName;
    try { requestedName = decodeURIComponent(match[2]); } catch { requestedName = ""; }
    if (requestedName !== record.filename)
      return text("Not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    const allowedRoot = await Deno.realPath(record.allowed_root).catch(() => null);
    const realPath = await Deno.realPath(record.path).catch(() => null);
    const stat = realPath && allowedRoot && within(allowedRoot, realPath)
      ? await Deno.stat(realPath).catch(() => null) : null;
    if (!stat?.isFile) {
      await cleanupDownloadRecord(token, record, true);
      return text("File not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    }
    const inlinePreview = isInlinePreviewMime(record.mime_type);
    const activeDocument = isActiveDocumentMime(record.mime_type);
    const headers = {
      "content-type": responseContentType(record.mime_type, record.filename),
      "content-length": String(stat.size),
      "content-disposition": contentDisposition(record.filename, inlinePreview ? "inline" : "attachment"),
      "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff",
      ...(inlinePreview ? {
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      } : {}),
      ...(activeDocument ? {
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
      } : !inlinePreview ? { "content-security-policy": "default-src 'none'; sandbox" } : {}),
    };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers });
    const file = await Deno.open(realPath, { read: true });
    if (record.one_time) downloadTokens.delete(token);
    const reader = file.readable.getReader();
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      try { reader.releaseLock(); } catch {}
      try { file.close(); } catch {}
      if (record.one_time && record.delete_after) await Deno.remove(record.path).catch(() => {});
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) { controller.close(); await finish(); }
          else controller.enqueue(value);
        } catch (error) { controller.error(error); await finish(); }
      },
      async cancel() { try { await reader.cancel(); } catch {} await finish(); },
    });
    return new Response(stream, { status: 200, headers });
  }
  const pem = (label, bytes) => {
    const base = btoa(String.fromCharCode(...bytes));
    return `-----BEGIN ${label}-----\n${base.match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  };

  async function detectPublicIp() {
    const urls = parseJson(getCfg("public_ip_urls_json", "[]"), [])
      .map(String).map(value => value.trim()).filter(value => /^https:\/\//i.test(value));
    let lastError = "";
    for (const url of urls.length ? urls : ["https://api.ipify.org?format=json"]) {
      try {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const raw = await response.text();
        let ip = raw.trim();
        try { ip = JSON.parse(raw).ip || ip; } catch {}
        if (!ipv4(ip)) throw new Error("The service did not return an IPv4 address");
        setCfg("public_ip", ip);
        setCfg("public_ip_checked_at", Date.now());
        return ip;
      } catch (e) { lastError = String(e?.message || e); }
    }
    throw new Error(`Public IPv4 detection failed: ${lastError}`);
  }

  const acmeRetryAt = (response, detail = "") => {
    const values = [];
    const header = response?.headers?.get("retry-after")?.trim();
    if (header) {
      const seconds = Number(header);
      values.push(Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header));
    }
    const match = String(detail).match(/retry after (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC/i);
    if (match) values.push(Date.parse(`${match[1]}T${match[2]}Z`));
    return Math.max(0, ...values.filter(Number.isFinite));
  };
  const certificateRenewAt = info => info?.notBefore && info?.notAfter
    ? info.notBefore + (info.notAfter - info.notBefore) * 2 / 3 : 0;

  async function inspectCertificate(certPath, keyPath, kind) {
    try {
      const [certificate, key, { X509Certificate }] = await Promise.all([
        Deno.readTextFile(certPath), Deno.readTextFile(keyPath), import("node:crypto"),
      ]);
      const leaf = new X509Certificate(certificate);
      const notBefore = Date.parse(leaf.validFrom), notAfter = Date.parse(leaf.validTo);
      const ip = getCfg("public_ip", "").trim(), host = sslipHostname(ip);
      const san = String(leaf.subjectAltName || "").toLowerCase();
      const identityValid = (!ipv4(ip) || san.includes(ip.toLowerCase())) &&
        (!host || san.includes(host.toLowerCase()));
      const timeValid = Number.isFinite(notBefore) && Number.isFinite(notAfter) &&
        Date.now() >= notBefore && Date.now() < notAfter;
      const chainLength = certificate.match(/-----BEGIN CERTIFICATE-----/g)?.length || 0;
      const selfSigned = leaf.subject === leaf.issuer;
      const production = kind === "letsencrypt" && chainLength >= 2 && !selfSigned &&
        !/Fake LE|STAGING/i.test(`${certificate}\n${leaf.issuer}`);
      return {
        available: true, certPath, keyPath, certificate, key, kind,
        subject: leaf.subject, issuer: leaf.issuer, serialNumber: leaf.serialNumber,
        notBefore, notAfter, expiresAt: new Date(notAfter).toISOString(),
        renewAt: certificateRenewAt({ notBefore, notAfter }),
        ip, host, san, identityValid, timeValid, selfSigned,
        valid: timeValid && identityValid, trusted: production && timeValid && identityValid,
      };
    } catch (error) {
      return {
        available: false, certPath, keyPath, kind, valid: false, trusted: false,
        error: String(error?.message || error),
      };
    }
  }

  async function ensureSelfSigned() {
    let current = await inspectCertificate(SELF_CERT_PATH, SELF_KEY_PATH, "self-signed");
    if (current.valid) return current;
    const x509 = await import("npm:@peculiar/x509@1.13.0");
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    const ip = getCfg("public_ip", "").trim(), host = sslipHostname(ip);
    const names = [
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
    ];
    if (ipv4(ip) && ip !== "127.0.0.1") names.push({ type: "ip", value: ip });
    if (host) names.push({ type: "dns", value: host });
    const now = Date.now(), notBefore = new Date(now - 300000), notAfter = new Date(now + 30 * 86400000);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString("hex"),
      name: `CN=${host || ip || "MrMCP"}`,
      notBefore, notAfter, signingAlgorithm: algorithm, keys,
      extensions: [
        new x509.SubjectAlternativeNameExtension(names, false),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], false),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const privateKey = pem(
      "PRIVATE KEY",
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    );
    await Deno.writeTextFile(SELF_CERT_PATH, certificate.toString("pem"));
    await Deno.writeTextFile(SELF_KEY_PATH, privateKey);
    setCfg("tls_self_signed_created_at", now);
    current = await inspectCertificate(SELF_CERT_PATH, SELF_KEY_PATH, "self-signed");
    if (!current.valid) throw new Error(`Unable to create a usable self-signed certificate: ${current.error || "invalid certificate"}`);
    return current;
  }

  async function selectTlsMaterial() {
    const production = await inspectCertificate(CERT_PATH, KEY_PATH, "letsencrypt");
    if (production.trusted) {
      setCfg("tls_cert_not_before", new Date(production.notBefore).toISOString());
      setCfg("tls_cert_expires", production.expiresAt);
      setCfg("tls_cert_ip", production.ip);
      setCfg("tls_cert_sslip", production.host);
      setCfg("tls_cert_environment", "production");
      setCfg("tls_renewal_due_at", production.renewAt);
      const next = Number(getCfg("tls_next_attempt_at", "0"));
      if (!next || next < Date.now()) setCfg("tls_next_attempt_at", production.renewAt);
      return production;
    }
    return await ensureSelfSigned();
  }

  function restoreAcmeBackoff() {
    const parsed = acmeRetryAt(null, getCfg("tls_last_error", ""));
    const current = Number(getCfg("tls_next_attempt_at", "0"));
    if (parsed > Date.now() && parsed > current) {
      setCfg("tls_rate_limit_reset_at", parsed);
      setCfg("tls_next_attempt_at", parsed + 60000);
    }
  }

  async function issueLetsEncrypt() {
    let ip = getCfg("public_ip", "").trim();
    const email = getCfg("tls_email", "").trim();
    if (!mcpHttpActive) throw new Error("ACME HTTP-01 listener is not available on 0.0.0.0:80");
    if (!ip) ip = await detectPublicIp();
    if (!ipv4(ip)) throw new Error("The detected external address is not a valid public IPv4 address");
    const sslip = sslipHostname(ip);
    if (!sslip) throw new Error("Unable to derive the sslip.io hostname from the public IP");
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new Error("Enter a valid email address for Let's Encrypt");

    const now = Date.now();
    setCfg("tls_last_request_at", now);
    setCfg("tls_last_request_status", "running");
    setCfg("tls_last_request_valid", "0");
    setCfg("tls_last_error", "");

    const accountPath = join(TLS_DATA, "acme-ip-account.pem");
    const accountUrlKey = "acme_ip_account_url";
    const directoryUrl = getCfg("acme_directory_url", "https://acme-v02.api.letsencrypt.org/directory").trim();

    try {
      const [x509, cryptoNode] = await Promise.all([
        import("npm:@peculiar/x509@1.13.0"),
        import("node:crypto"),
      ]);

      let accountKey;
      try {
        accountKey = cryptoNode.createPrivateKey(await Deno.readTextFile(accountPath));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        accountKey = cryptoNode.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
        await Deno.writeTextFile(accountPath, accountKey.export({ format: "pem", type: "pkcs8" }));
      }

      const privateJwk = accountKey.export({ format: "jwk" });
      const publicJwk = {
        crv: privateJwk.crv, kty: privateJwk.kty, x: privateJwk.x, y: privateJwk.y,
      };
      const thumbprint = await sha256(enc.encode(JSON.stringify(publicJwk)));

      const directoryResponse = await fetch(directoryUrl, { cache: "no-store" });
      if (!directoryResponse.ok) throw new Error(`ACME directory error ${directoryResponse.status}`);
      const directory = await directoryResponse.json();
      if (!directory.newNonce || !directory.newAccount || !directory.newOrder)
        throw new Error("Invalid ACME directory response");

      let nonce = "", accountUrl = getCfg(accountUrlKey, "");
      async function newNonce() {
        const response = await fetch(directory.newNonce, { method: "HEAD", cache: "no-store" });
        if (!response.ok) throw new Error(`ACME nonce error ${response.status}`);
        nonce = response.headers.get("replay-nonce") || "";
        if (!nonce) throw new Error("ACME server returned no replay nonce");
      }
      async function signedPost(url, payload, useJwk = false, accept = "application/json") {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!nonce) await newNonce();
          const protectedHeader = {
            alg: "ES256", nonce, url, ...(useJwk ? { jwk: publicJwk } : { kid: accountUrl }),
          };
          const protected64 = b64url(enc.encode(JSON.stringify(protectedHeader)));
          const payload64 = payload === null ? "" : b64url(enc.encode(JSON.stringify(payload)));
          const signingInput = `${protected64}.${payload64}`;
          const signature = cryptoNode.sign("sha256", enc.encode(signingInput), {
            key: accountKey, dsaEncoding: "ieee-p1363",
          });
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/jose+json", accept },
            body: JSON.stringify({
              protected: protected64, payload: payload64, signature: b64url(signature),
            }),
          });
          nonce = response.headers.get("replay-nonce") || "";
          const raw = await response.text();
          let data;
          try { data = raw ? JSON.parse(raw) : {}; } catch { data = raw; }
          if (!response.ok) {
            if (typeof data === "object" && String(data?.type || "").endsWith(":badNonce")) {
              nonce = "";
              continue;
            }
            const detail = typeof data === "object" ? data?.detail || JSON.stringify(data) : raw;
            const retry = acmeRetryAt(response, detail);
            if (retry) {
              setCfg("tls_rate_limit_reset_at", retry);
              setCfg("tls_next_attempt_at", retry + 60000);
            }
            throw new Error(`ACME ${response.status}: ${detail}`);
          }
          return { response, data, raw, location: response.headers.get("location") || "" };
        }
        throw new Error("ACME request failed after repeated badNonce responses");
      }

      if (!accountUrl) {
        const created = await signedPost(directory.newAccount, {
          contact: [`mailto:${email}`], termsOfServiceAgreed: true,
        }, true);
        accountUrl = created.location;
        if (!accountUrl) throw new Error("ACME account response did not include an account URL");
        setCfg(accountUrlKey, accountUrl);
      }

      const createdOrder = await signedPost(directory.newOrder, {
        identifiers: [{ type: "ip", value: ip }, { type: "dns", value: sslip }],
        profile: "shortlived",
      });
      const orderUrl = createdOrder.location;
      let order = createdOrder.data;
      if (!orderUrl) throw new Error("ACME order response did not include an order URL");

      for (const authorizationUrl of order.authorizations || []) {
        let authorization = (await signedPost(authorizationUrl, null)).data;
        if (authorization.status === "valid") continue;
        const challenge = authorization.challenges?.find(challenge => challenge.type === "http-01");
        if (!challenge?.token || !challenge.url)
          throw new Error(`Let's Encrypt did not offer HTTP-01 for ${authorization.identifier?.value || "an identifier"}`);
        acmeChallenges.set(challenge.token, `${challenge.token}.${thumbprint}`);
        await signedPost(challenge.url, {});
        for (let attempt = 0; attempt < 90; attempt++) {
          await sleep(2000);
          authorization = (await signedPost(authorizationUrl, null)).data;
          if (authorization.status === "valid") break;
          if (authorization.status === "invalid")
            throw new Error(`ACME validation failed for ${authorization.identifier?.value || "identifier"}: ${authorization.error?.detail || "invalid authorization"}`);
        }
        if (authorization.status !== "valid")
          throw new Error(`Timed out while validating ${authorization.identifier?.value || "an identifier"}`);
      }

      for (let attempt = 0; attempt < 90; attempt++) {
        order = (await signedPost(orderUrl, null)).data;
        if (order.status === "ready") break;
        if (order.status === "invalid")
          throw new Error(`ACME order failed: ${order.error?.detail || "invalid order"}`);
        await sleep(2000);
      }
      if (order.status !== "ready") throw new Error("Timed out while waiting for the ACME order");

      const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
      const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
      const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        keys, signingAlgorithm: algorithm, name: "",
        extensions: [
          new x509.SubjectAlternativeNameExtension([
            { type: "ip", value: ip }, { type: "dns", value: sslip },
          ], true),
        ],
      });
      await signedPost(order.finalize, { csr: b64url(new Uint8Array(csr.rawData)) });

      for (let attempt = 0; attempt < 90; attempt++) {
        order = (await signedPost(orderUrl, null)).data;
        if (order.status === "valid" && order.certificate) break;
        if (order.status === "invalid")
          throw new Error(`Certificate issuance failed: ${order.error?.detail || "invalid order"}`);
        await sleep(2000);
      }
      if (order.status !== "valid" || !order.certificate)
        throw new Error("Timed out while waiting for the IP/sslip.io certificate");

      const certificateResponse = await signedPost(
        order.certificate, null, false, "application/pem-certificate-chain",
      );
      const certificate = certificateResponse.raw.trim() + "\n";
      const chainLength = certificate.match(/-----BEGIN CERTIFICATE-----/g)?.length || 0;
      if (chainLength < 2)
        throw new Error(`Let's Encrypt returned an incomplete certificate chain (${chainLength} certificate)`);
      if (/Fake LE|STAGING/i.test(certificate))
        throw new Error("Let's Encrypt returned a staging certificate instead of a production certificate");

      const privateKey = pem(
        "PRIVATE KEY",
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
      );
      await Deno.writeTextFile(CERT_PATH, certificate);
      await Deno.writeTextFile(KEY_PATH, privateKey);

      const parsed = await inspectCertificate(CERT_PATH, KEY_PATH, "letsencrypt");
      if (!parsed.trusted) throw new Error(`The issued certificate failed local validation: ${parsed.error || "invalid identity, validity or chain"}`);

      setCfg("tls_cert_expires", parsed.expiresAt);
      setCfg("tls_cert_not_before", new Date(parsed.notBefore).toISOString());
      setCfg("tls_cert_ip", ip);
      setCfg("tls_cert_sslip", sslip);
      setCfg("tls_cert_environment", "production");
      setCfg("tls_last_issued_at", Date.now());
      setCfg("tls_last_request_status", "success");
      setCfg("tls_last_request_valid", "1");
      setCfg("tls_last_error", "");
      setCfg("tls_rate_limit_reset_at", "0");
      setCfg("tls_renewal_due_at", parsed.renewAt);
      setCfg("tls_next_attempt_at", parsed.renewAt);
      setCfg("tls_mode", "letsencrypt");
      await restartMcp();

      return {
        requested: true, valid: true, ip, sslip_hostname: sslip,
        profile: "shortlived", expires_at: parsed.expiresAt,
        renewal_due_at: new Date(parsed.renewAt).toISOString(),
        certificate_path: CERT_PATH, key_path: KEY_PATH,
      };
    } catch (error) {
      const message = String(error?.stack || error);
      setCfg("tls_last_error", message);
      setCfg("tls_last_request_status", "error");
      setCfg("tls_last_request_valid", "0");
      const next = Number(getCfg("tls_next_attempt_at", "0"));
      if (!next || next <= Date.now()) setCfg("tls_next_attempt_at", Date.now() + 6 * 60 * 60 * 1000);
      throw error;
    } finally {
      acmeChallenges.clear();
    }
  }

  async function requestCertificate() {
    const production = await inspectCertificate(CERT_PATH, KEY_PATH, "letsencrypt");
    if (production.trusted && Date.now() < production.renewAt) {
      setCfg("tls_renewal_due_at", production.renewAt);
      setCfg("tls_next_attempt_at", production.renewAt);
      return {
        requested: false, valid: true, reason: "The certificate on disk is valid and not due for renewal",
        expires_at: production.expiresAt, renewal_due_at: new Date(production.renewAt).toISOString(),
      };
    }
    const next = Number(getCfg("tls_next_attempt_at", "0"));
    if (next > Date.now()) return {
      requested: false, valid: production.trusted,
      reason: "ACME request deferred by renewal/backoff schedule",
      next_attempt_at: new Date(next).toISOString(),
    };
    return await issueLetsEncrypt();
  }

  async function automaticRenewal() {
    if (!getCfg("public_ip", "").trim()) await detectPublicIp().catch(() => {});
    const production = await inspectCertificate(CERT_PATH, KEY_PATH, "letsencrypt");
    if (production.trusted && Date.now() < production.renewAt) {
      setCfg("tls_cert_not_before", new Date(production.notBefore).toISOString());
      setCfg("tls_cert_expires", production.expiresAt);
      setCfg("tls_renewal_due_at", production.renewAt);
      setCfg("tls_next_attempt_at", production.renewAt);
      return;
    }
    const next = Number(getCfg("tls_next_attempt_at", "0"));
    if (next > Date.now() || !getCfg("tls_email", "").trim()) return;
    if (!getCfg("public_ip", "").trim()) await detectPublicIp();
    await issueLetsEncrypt().catch(() => {});
  }

  // File tools can access every entry inside the selected configured root.
  async function safePath(root, path = ".") {
    const rootReal = await Deno.realPath(root);
    const target = resolve(rootReal, String(path || "."));
    if (!within(rootReal, target)) throw new Error("Path outside selected root");
    let current = target;
    for (;;) {
      try {
        const real = await Deno.realPath(current);
        if (!within(rootReal, real)) throw new Error("Path resolves outside the selected root");
        break;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        const parent = dirname(current);
        if (parent === current) throw e;
        current = parent;
      }
    }
    return target;
  }
  async function fileHash(path) {
    return await sha256(new Uint8Array(await Deno.readFile(path)));
  }
  const TEXT_ENCODINGS = new Set(["utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"]);
  const CP1252_SPECIAL = new Map([
    [0x20ac,0x80],[0x201a,0x82],[0x0192,0x83],[0x201e,0x84],[0x2026,0x85],[0x2020,0x86],[0x2021,0x87],
    [0x02c6,0x88],[0x2030,0x89],[0x0160,0x8a],[0x2039,0x8b],[0x0152,0x8c],[0x017d,0x8e],[0x2018,0x91],
    [0x2019,0x92],[0x201c,0x93],[0x201d,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],[0x02dc,0x98],
    [0x2122,0x99],[0x0161,0x9a],[0x203a,0x9b],[0x0153,0x9c],[0x017e,0x9e],[0x0178,0x9f],
  ]);
  const CP1252_DECODE = new Map([...CP1252_SPECIAL].map(([code, byte]) => [byte, code]));
  function textEncoding(value, fallback = "auto", preserve = false) {
    value = String(value || fallback).trim().toLowerCase().replaceAll("_", "-");
    if (["utf8", "utf-8-sig"].includes(value)) value = "utf-8";
    if (["utf16", "utf-16", "utf16le"].includes(value)) value = "utf-16le";
    if (value === "utf16be") value = "utf-16be";
    if (["cp1252", "windows1252"].includes(value)) value = "windows-1252";
    if (["iso-8859-1", "iso8859-1"].includes(value)) value = "latin1";
    if (preserve && value === "preserve") return value;
    if (value === "auto" || TEXT_ENCODINGS.has(value)) return value;
    throw new Error(`Unsupported text encoding: ${value}`);
  }
  function lineEndingKind(value) {
    const crlf = (value.match(/\r\n/g) || []).length;
    const lf = (value.match(/(?<!\r)\n/g) || []).length;
    const cr = (value.match(/\r(?!\n)/g) || []).length;
    const kinds = [["crlf", crlf], ["lf", lf], ["cr", cr]].filter(([, count]) => count > 0);
    return kinds.length === 0 ? "none" : kinds.length === 1 ? kinds[0][0] : "mixed";
  }
  function normalizeLineEndings(value, mode, source = null) {
    mode = String(mode || "preserve").toLowerCase();
    if (mode === "preserve") mode = ["lf", "crlf", "cr"].includes(source?.line_endings) ? source.line_endings : "preserve";
    if (mode === "preserve") return String(value);
    if (!["lf", "crlf", "cr"].includes(mode)) throw new Error("line_endings must be preserve, lf, crlf, or cr");
    const normalized = String(value).replace(/\r\n|\r/g, "\n");
    return mode === "lf" ? normalized : mode === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized.replaceAll("\n", "\r");
  }
  function decodeLatin1(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return out;
  }
  function decodeWindows1252(bytes) {
    let out = "";
    for (const byte of bytes) out += String.fromCodePoint(CP1252_DECODE.get(byte) ?? byte);
    return out;
  }
  function encodeLatin1(value, windows1252 = false) {
    const bytes = [];
    for (const character of String(value)) {
      const code = character.codePointAt(0);
      if (windows1252 && CP1252_SPECIAL.has(code)) bytes.push(CP1252_SPECIAL.get(code));
      else if (code <= 0xff) bytes.push(code);
      else throw new Error(`Character U+${code.toString(16).toUpperCase()} cannot be encoded as ${windows1252 ? "windows-1252" : "latin1"}`);
    }
    return new Uint8Array(bytes);
  }
  function encodeUtf16(value, bigEndian = false) {
    const text = String(value), bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[i * 2 + (bigEndian ? 1 : 0)] = code & 0xff;
      bytes[i * 2 + (bigEndian ? 0 : 1)] = code >>> 8;
    }
    return bytes;
  }
  function encodeText(value, encoding) {
    if (encoding === "utf-8") return enc.encode(String(value));
    if (encoding === "utf-16le") return encodeUtf16(value, false);
    if (encoding === "utf-16be") return encodeUtf16(value, true);
    if (encoding === "windows-1252") return encodeLatin1(value, true);
    if (encoding === "latin1") return encodeLatin1(value, false);
    throw new Error(`Unsupported output encoding: ${encoding}`);
  }
  function decodeTextDocument(bytes, requested = "auto") {
    requested = textEncoding(requested, "auto");
    let encoding = requested, offset = 0, bom = false;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      if (requested === "auto") encoding = "utf-8";
      if (encoding === "utf-8") { offset = 3; bom = true; }
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (requested === "auto") encoding = "utf-16le";
      if (encoding === "utf-16le") { offset = 2; bom = true; }
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      if (requested === "auto") encoding = "utf-16be";
      if (encoding === "utf-16be") { offset = 2; bom = true; }
    }
    const payload = bytes.subarray(offset);
    if (encoding === "auto") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(payload); encoding = "utf-8"; }
      catch { encoding = "windows-1252"; }
    }
    const text = encoding === "latin1" ? decodeLatin1(payload)
      : encoding === "windows-1252" ? decodeWindows1252(payload)
      : new TextDecoder(encoding, { fatal: true }).decode(payload);
    return { text, encoding, bom, line_endings: lineEndingKind(text), bytes };
  }
  async function readTextDocument(path, requested = "auto") {
    return decodeTextDocument(await Deno.readFile(path), requested);
  }
  function encodeTextDocument(value, source = null, options = {}) {
    const requested = textEncoding(options.output_encoding || "preserve", "preserve", true);
    const encoding = requested === "preserve" ? (source?.encoding || "utf-8") : requested;
    const text = normalizeLineEndings(value, options.line_endings || "preserve", source);
    const bomMode = String(options.bom || "preserve").toLowerCase();
    if (!["preserve", "add", "remove"].includes(bomMode)) throw new Error("bom must be preserve, add, or remove");
    const bom = bomMode === "add" || (bomMode === "preserve" && !!source?.bom);
    if (bom && !["utf-8", "utf-16le", "utf-16be"].includes(encoding)) throw new Error(`BOM is unsupported for ${encoding}`);
    const payload = encodeText(text, encoding);
    const prefix = !bom ? new Uint8Array() : encoding === "utf-8"
      ? new Uint8Array([0xef, 0xbb, 0xbf]) : encoding === "utf-16le"
      ? new Uint8Array([0xff, 0xfe]) : new Uint8Array([0xfe, 0xff]);
    const bytes = new Uint8Array(prefix.length + payload.length);
    bytes.set(prefix); bytes.set(payload, prefix.length);
    return { bytes, encoding, bom, line_endings: lineEndingKind(text) };
  }
  function editNeedle(value, document) {
    const mode = document.line_endings;
    return ["lf", "crlf", "cr"].includes(mode) ? normalizeLineEndings(value, mode) : String(value);
  }
  function globRegex(pattern = "**/*") {
    const source = String(pattern).replaceAll("\\", "/");
    let output = "^";
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === "*" && source[index + 1] === "*") {
        if (source[index + 2] === "/") {
          output += "(?:.*/)?";
          index += 2;
        } else {
          output += ".*";
          index += 1;
        }
      } else if (character === "*") output += "[^/]*";
      else if (character === "?") output += "[^/]";
      else output += /[.+^${}()|[\]\\]/.test(character) ? "\\" + character : character;
    }
    return new RegExp(output + "$");
  }
  async function walk(root, start = ".", options = {}) {
    const base = await safePath(root, start), rootReal = await Deno.realPath(root);
    const result = [], limit = Math.min(Number(options.limit || 2000), 10000);
    const match = globRegex(options.pattern || "**/*");
    const baseStat = await Deno.stat(base);
    if (baseStat.isFile) {
      const rel = relative(rootReal, base).replaceAll("\\", "/");
      return match.test(rel) ? [rel] : [];
    }
    if (!baseStat.isDirectory) return result;
    async function visit(dir) {
      for await (const e of Deno.readDir(dir)) {
        if (result.length >= limit) return;
        if (!options.include_hidden && e.name.startsWith(".")) continue;
        if (!options.include_dependencies && ["node_modules", "vendor", "dist"].includes(e.name)) continue;
        const absolute = join(dir, e.name);
        const rel = relative(rootReal, absolute).replaceAll("\\", "/");
        if (e.isDirectory) await visit(absolute);
        else if (e.isFile && match.test(rel)) result.push(rel);
      }
    }
    await visit(base);
    return result;
  }
  async function copyRecursive(from, to) {
    const st = await Deno.stat(from);
    if (st.isDirectory) {
      await Deno.mkdir(to, { recursive: true });
      for await (const e of Deno.readDir(from)) await copyRecursive(join(from, e.name), join(to, e.name));
    } else {
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(from, to);
    }
  }

  // Context handles are globally unique bearer capabilities over the stateless MCP transport.
  // Each context has exactly one current root; root id 0 is the program folder fallback.
  const serverRoots = p => all(
    "SELECT * FROM roots WHERE server_id=? AND enabled=1 ORDER BY id", p.id,
  );
  const fallbackWorkspaceRoot = p => ({
    id: 0, server_id: p.id, name: "Program folder", path: APP_DIR, enabled: 1, fallback: true,
  });
  const validRootName = name => {
    const value = String(name || "").trim();
    return value.length >= 1 && value.length <= 128 && !/[\/\\\x00-\x1f\x7f]/.test(value);
  };
  function contextByHandle(p, handle) {
    return handle ? one(
      "SELECT * FROM contexts WHERE handle=? AND server_id=?",
      String(handle), p.id,
    ) : null;
  }
  function contextById(p, id) {
    return Number(id) ? one(
      "SELECT * FROM contexts WHERE id=? AND server_id=?",
      Number(id), p.id,
    ) : null;
  }
  function createContext(p, protocolVersion = "", client = {}) {
    let handle;
    do handle = `ctx_${randomToken(24)}`;
    while (one("SELECT 1 FROM contexts WHERE handle=?", handle));
    const now = Date.now();
    run(`INSERT INTO contexts(handle,server_id,root_id,label,created_at,updated_at,last_active_at,protocol_version,auth_kind,oauth_client_id,client_name,user_agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, handle, p.id, 0, "", now, now, now, String(protocolVersion || ""),
      String(client.auth_kind || ""), String(client.oauth_client_id || ""), String(client.client_name || ""),
      String(client.user_agent || "").slice(0, 512));
    return one("SELECT * FROM contexts WHERE handle=?", handle);
  }
  const contextExpired = context => !!context &&
    Date.now() - Number(context.last_active_at || context.created_at || 0) > CONTEXT_TTL_MS;
  function resolveContext(p, suppliedHandle = "", protocolVersion = "") {
    const handle = String(suppliedHandle ?? "");
    if (!handle) return { kind: "missing", record: null, supplied_handle: "" };
    if (handle.length > 256) return { kind: "invalid", record: null, supplied_handle: handle };
    const context = contextByHandle(p, handle);
    if (!context) return { kind: "invalid", record: null, supplied_handle: handle };
    if (contextExpired(context)) return { kind: "expired", record: context, supplied_handle: handle };
    const now = Date.now(), observed = String(protocolVersion || context.protocol_version || "");
    run("UPDATE contexts SET last_active_at=?,protocol_version=? WHERE handle=?", now, observed, context.handle);
    return { kind: "active", record: one("SELECT * FROM contexts WHERE handle=?", context.handle), supplied_handle: handle };
  }
  function getContextRecord(p, handle = "") {
    const context = contextByHandle(p, handle);
    if (!context) throw new Error("Unknown context_handle");
    if (contextExpired(context)) throw new Error("The context_handle has expired");
    return context;
  }
  function selectedContextRoot(p, context) {
    const rootId = Number(context.root_id || 0);
    const root = rootId ? serverRoots(p).find(item => item.id === rootId) : null;
    if (rootId && !root) {
      run("UPDATE contexts SET root_id=0,updated_at=? WHERE handle=?", Date.now(), context.handle);
      context.root_id = 0;
    }
    return root || fallbackWorkspaceRoot(p);
  }
  function contextSnapshot(p, context) {
    const roots = serverRoots(p), root = selectedContextRoot(p, context);
    return {
      id: context.id,
      pk: context.id,
      context_handle: context.handle,
      label: context.label || `#${context.id}`,
      expired: contextExpired(context),
      protocol_version: context.protocol_version || "unknown",
      root_id: root.id,
      effective_root: root.name,
      root_path: root.path,
      fallback_root: root.id === 0,
      created_at: context.created_at,
      updated_at: context.updated_at,
      last_active_at: context.last_active_at,
      expires_at: Number(context.last_active_at || context.created_at || 0) + CONTEXT_TTL_MS,
      available_roots: roots.map(item => ({ id: item.id, name: item.name, selected: item.id === root.id })),
    };
  }
  function selectContextRoot(p, context, rootId) {
    rootId = Math.max(0, Number(rootId) || 0);
    const root = rootId ? serverRoots(p).find(item => item.id === rootId) : null;
    if (rootId && !root) throw new Error(`Unknown or disabled root id: ${rootId}`);
    run("UPDATE contexts SET root_id=?,updated_at=? WHERE handle=?", root?.id || 0, Date.now(), context.handle);
    return contextSnapshot(p, getContextRecord(p, context.handle));
  }
  function selectedRoot(p, args = {}) {
    const context = getContextRecord(p, String(args.context_handle || ""));
    return { context, root: selectedContextRoot(p, context) };
  }
  async function resolveWorkspacePath(selection, path = ".") {
    const absolute = await safePath(selection.root.path, path);
    return {
      ...selection,
      path: absolute,
      display: relative(selection.root.path, absolute).replaceAll("\\", "/") || ".",
    };
  }
  async function contextInfo(selection) {
    let agentGuidancePath = null;
    for (const name of ["AGENTS.md", "agents.md"]) {
      const candidate = await resolveWorkspacePath(selection, name).catch(() => null);
      const stat = candidate ? await Deno.stat(candidate.path).catch(() => null) : null;
      if (stat?.isFile) {
        agentGuidancePath = candidate.path;
        break;
      }
    }
    return {
      cwd: selection.root.path,
      agent_guidance_path: agentGuidancePath,
    };
  }
  const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat"];
  const windowsExecutableSuffix = name => Deno.build.os === "windows"
    ? WINDOWS_EXECUTABLE_SUFFIXES.find(suffix => String(name).toLowerCase().endsWith(suffix)) || ""
    : "";
  const executableFile = (name, stat) => Deno.build.os === "windows"
    ? !!windowsExecutableSuffix(name) : !!(stat?.mode && (stat.mode & 0o111));
  const logicalCommandName = file => {
    const suffix = windowsExecutableSuffix(file);
    return suffix ? file.slice(0, -suffix.length) : file;
  };
  async function binPath(relativePath) {
    const raw = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!raw || isAbsolute(raw)) throw new Error("Command path must be relative to .mrmcp/bin");
    const path = resolve(BIN_DIR, raw);
    if (!within(BIN_DIR, path)) throw new Error("Command path escapes .mrmcp/bin");
    return { path, relative: relative(BIN_DIR, path).replaceAll("\\", "/") };
  }
  async function commandTarget(relativePath) {
    const configured = await binPath(relativePath);
    if (Deno.build.os !== "windows" || windowsExecutableSuffix(configured.relative)) return configured;
    for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
      const candidate = await binPath(configured.relative + suffix);
      if ((await Deno.stat(candidate.path).catch(() => null))?.isFile) return candidate;
    }
    return configured;
  }
  function responseFilename(response) {
    const disposition = response.headers.get("content-disposition") || "";
    const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    if (encoded) { try { return basename(decodeURIComponent(encoded.trim().replace(/^"|"$/g, ""))); } catch {} }
    const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
    if (plain) return basename(plain.trim());
    try { return basename(decodeURIComponent(new URL(response.url).pathname)); } catch { return ""; }
  }
  async function downloadCommandTarget(relativePath, response) {
    const configured = await binPath(relativePath);
    if (Deno.build.os !== "windows" || windowsExecutableSuffix(configured.relative)) return configured;
    const existing = await commandTarget(configured.relative);
    if (existing.relative !== configured.relative) return existing;
    return await binPath(configured.relative + (windowsExecutableSuffix(responseFilename(response)) || ".exe"));
  }
  async function archiveCommandTarget(relativePath, archiveName) {
    const configured = await binPath(relativePath);
    if (Deno.build.os !== "windows" || windowsExecutableSuffix(configured.relative)) return configured;
    return await binPath(configured.relative + (windowsExecutableSuffix(archiveName) || ".exe"));
  }
  function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minimum = Math.max(0, bytes.byteLength - 22 - 0xffff);
    let end = -1;
    for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
    }
    if (end < 0) throw new Error("Invalid ZIP archive: end record not found");
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Multi-disk ZIP archives are unsupported");
    const count = view.getUint16(end + 10, true);
    const centralSize = view.getUint32(end + 12, true);
    const centralOffset = view.getUint32(end + 16, true);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are unsupported");
    if (centralOffset + centralSize > bytes.byteLength) throw new Error("Invalid ZIP archive: central directory is truncated");
    const entries = [];
    let offset = centralOffset;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP archive: central entry is truncated");
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > bytes.byteLength) throw new Error("Invalid ZIP archive: entry name is truncated");
      const name = dec.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
      offset = next;
    }
    return entries;
  }
  function selectZipCommandEntry(bytes, row) {
    const files = zipEntries(bytes).filter(entry => entry.name && !entry.name.endsWith("/"));
    const bases = [...new Set([basename(String(row.path || row.name)), basename(row.name)].map(value => value.toLowerCase()))];
    const wanted = [];
    for (const base of bases) {
      wanted.push(base);
      if (!WINDOWS_EXECUTABLE_SUFFIXES.some(suffix => base.endsWith(suffix))) {
        for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) wanted.push(base + suffix);
      }
    }
    for (const name of wanted) {
      const matches = files.filter(entry => basename(entry.name.replaceAll("\\", "/")).toLowerCase() === name)
        .sort((a, b) => a.name.length - b.name.length);
      if (matches.length) return matches[0];
    }
    const executables = files.filter(entry => WINDOWS_EXECUTABLE_SUFFIXES.some(
      suffix => basename(entry.name.replaceAll("\\", "/")).toLowerCase().endsWith(suffix),
    ));
    if (executables.length === 1) return executables[0];
    throw new Error(`ZIP archive does not contain an unambiguous executable for ${row.name}`);
  }
  function extractZipEntry(bytes, entry) {
    if (entry.flags & 1) throw new Error("Encrypted ZIP entries are unsupported");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = entry.localOffset;
    if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== 0x04034b50) throw new Error("Invalid ZIP archive: local entry is missing");
    const nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength, end = start + entry.compressedSize;
    if (end > bytes.byteLength) throw new Error("Invalid ZIP archive: compressed data is truncated");
    const compressed = bytes.subarray(start, end);
    let output;
    if (entry.method === 0) output = new Uint8Array(compressed);
    else if (entry.method === 8) output = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
    if (entry.uncompressedSize !== 0xffffffff && output.byteLength !== entry.uncompressedSize) throw new Error("Invalid ZIP archive: extracted size mismatch");
    return output;
  }
  function normalizeCommandEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each commands.yaml entry must be an object");
    const name = String(entry.logical_name || "").trim();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(name)) throw new Error(`Invalid logical_name in commands.yaml: ${name || "(empty)"}`);
    return {
      name,
      logical_name: name,
      path: String(entry.path || "").trim() || name,
      description: String(entry.description || "").trim(),
      download_url: String(entry.download_url || "").trim(),
      documentation_url: String(entry.documentation_url || "").trim(),
    };
  }
  async function readCommandConfig() {
    let source;
    try { source = await Deno.readTextFile(COMMANDS_PATH); }
    catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      return [];
    }
    const document = parseYaml(source || "commands: []", { schema: "core" });
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("commands.yaml must contain a mapping");
    if (!Array.isArray(document.commands)) throw new Error("commands.yaml must contain a commands array");
    const rows = document.commands.map(normalizeCommandEntry);
    const names = new Set();
    for (const row of rows) {
      const key = row.name.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate logical_name in commands.yaml: ${row.name}`);
      names.add(key);
      await binPath(row.path);
      for (const [field, value] of [["download_url", row.download_url], ["documentation_url", row.documentation_url]]) {
        if (!value) continue;
        let url;
        try { url = new URL(value); } catch { throw new Error(`Invalid ${field} for ${row.name}`); }
        if (!/^https?:$/.test(url.protocol)) throw new Error(`${field} for ${row.name} must use HTTP or HTTPS`);
      }
    }
    return rows;
  }
  async function writeCommandConfig(rows) {
    const commands = rows.map(row => ({
      logical_name: row.name,
      ...(row.path !== row.name ? { path: row.path } : {}),
      description: row.description || "",
      download_url: row.download_url || "",
      documentation_url: row.documentation_url || "",
    }));
    const temporary = `${COMMANDS_PATH}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, stringifyYaml({ commands }, { lineWidth: -1 }));
    if (Deno.build.os === "windows") await Deno.remove(COMMANDS_PATH).catch(e => { if (!(e instanceof Deno.errors.NotFound)) throw e; });
    await Deno.rename(temporary, COMMANDS_PATH);
  }
  async function commandRow(row) {
    const configured = await binPath(row.path), target = await commandTarget(row.path);
    const stat = await Deno.stat(target.path).catch(() => null);
    return {
      ...row,
      source: "catalog",
      registered: true,
      path: configured.relative,
      resolved_path: target.relative,
      present: !!stat?.isFile,
      executable: !!stat?.isFile && executableFile(target.relative, stat),
      size: stat?.size ?? null,
      modified_at: stat?.mtime?.toISOString() || null,
    };
  }
  async function automaticCommands() {
    const rows = [];
    for await (const entry of Deno.readDir(BIN_DIR)) {
      if (!entry.isFile && !entry.isSymlink) continue;
      const path = join(BIN_DIR, entry.name);
      const stat = await Deno.stat(path).catch(() => null);
      if (!stat?.isFile || !executableFile(entry.name, stat)) continue;
      const name = logicalCommandName(entry.name);
      rows.push({
        name,
        logical_name: name,
        path: entry.name,
        description: "",
        source: "automatic",
        registered: false,
        present: true,
        executable: true,
        size: stat.size,
        modified_at: stat.mtime?.toISOString() || null,
      });
    }
    return rows;
  }
  async function commandCatalog({
    query = "", page = 1, page_size = 25, include_missing = false, admin = false,
  } = {}) {
    const registered = await Promise.all((await readCommandConfig()).map(commandRow));
    const names = new Set(registered.map(row => row.name.toLowerCase()));
    const paths = new Set(registered.flatMap(row => [row.path, row.resolved_path]).filter(Boolean).map(path => path.toLowerCase()));
    const automatic = (await automaticCommands()).filter(
      row => !names.has(row.name.toLowerCase()) && !paths.has(row.path.toLowerCase()),
    );
    let rows = [...registered, ...automatic];
    rows = admin
      ? rows.filter(row => include_missing || (row.present && row.executable))
      : rows.filter(row => row.present && row.executable);
    const needle = String(query).trim().toLowerCase();
    rows = rows.filter(row =>
      !needle || `${row.name}\n${row.path}\n${row.description}\n${row.download_url || ""}\n${row.documentation_url || ""}`.toLowerCase().includes(needle)
    ).sort((a, b) =>
      a.name.localeCompare(b.name) ||
      Number(b.registered) - Number(a.registered)
    );
    page = Math.max(1, Number(page) || 1);
    page_size = Math.max(1, Math.min(Number(page_size) || 25, 100));
    const total = rows.length, start = (page - 1) * page_size;
    return {
      query: String(query),
      page,
      page_size,
      total,
      pages: Math.max(1, Math.ceil(total / page_size)),
      has_more: start + page_size < total,
      bin_directory: BIN_DIR,
      config_file: COMMANDS_PATH,
      path_precedence: "MrMCP resolves catalog logical names before normal platform PATH lookup; catalog entries override automatic first-level commands and nested paths require catalog entries",
      invocation: {
        rule: "Every returned commands[].logical_name is already present, executable, and directly callable as exec.program. Do not probe it with where.exe, which, Get-Command, or a filesystem search.",
        example: { tool: "exec", input: { program: "<logical_name>", args: [] } },
      },
      commands: rows.slice(start, start + page_size).map(row => ({
        ...row,
        logical_name: row.logical_name || row.name,
        exec_program: row.logical_name || row.name,
        directly_invokable: true,
        path_lookup_required: false,
      })),
    };
  }
  async function catalogProgram(name) {
    const registered = (await readCommandConfig()).find(row => row.name.toLowerCase() === String(name).toLowerCase());
    if (registered) {
      const target = await commandRow(registered);
      if (!target.present) throw new Error(`Catalog command "${registered.name}" is missing: ${registered.path}`);
      if (!target.executable) throw new Error(`Catalog command "${registered.name}" is not executable: ${registered.path}`);
      return { name: registered.name, path: target.resolved_path, absolute: (await binPath(target.resolved_path)).path };
    }
    const automatic = (await automaticCommands()).find(
      row => row.name.toLowerCase() === String(name).toLowerCase(),
    );
    return automatic
      ? { name: automatic.name, path: automatic.path, absolute: (await binPath(automatic.path)).path }
      : null;
  }


  // Compact descriptors reduce token use while preserving invocation semantics.
  function serverTools(p, fullAccess = true) {
    if (!fullAccess) return [];
    const available = new Set(BASE_TOOLS);
    const contextInput = {
      context_handle: {
        type: "string", minLength: 12, maxLength: 256,
        pattern: "^ctx_[A-Za-z0-9_-]+$", description: CONTEXT_HANDLE_INPUT_DESCRIPTION,
      },
    };
    const inputEncoding = {
      type: "string",
      enum: ["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"],
      default: "auto",
    };
    const outputText = {
      output_encoding: {
        type: "string",
        enum: ["preserve", "utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"],
        default: "preserve",
      },
      line_endings: { type: "string", enum: ["preserve", "lf", "crlf", "cr"], default: "preserve" },
      bom: { type: "string", enum: ["preserve", "add", "remove"], default: "preserve" },
    };
    const exactEdit = {
      type: "object", additionalProperties: false,
      properties: {
        old_text: { type: "string", description: "Exact text to replace in the document state produced by earlier edits." },
        new_text: { type: "string" },
        expected_occurrences: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["old_text", "new_text"],
    };
    const execInput = {
      program: {
        type: "string",
        description: "Executable path or logical_name returned by list_commands. Invoke catalog names directly without PATH probes.",
      },
      args: { type: "array", items: { type: "string" }, default: [] },
      shell_command: { type: "string", description: "Use only when shell syntax such as a pipeline or redirection is required." },
      cwd: { type: "string", default: ".", description: "Directory relative to the context's current root." },
      env: { type: "object", additionalProperties: { type: "string" } },
      stdin: { type: "string" },
      stdin_encoding: { type: "string", enum: ["text", "base64"], default: "text" },
      timeout_ms: { type: "integer", minimum: 0, maximum: 604800000 },
      ...contextInput,
    };

    const defs = {
      create_context: [
        "Create a new persistent MrMCP context capability. Call context_info immediately afterward, then pass the returned context_handle unchanged to every later tool.",
        { properties: {} },
      ],
      context_info: [
        "Return the current absolute working root and the root-level AGENTS.md guidance path when present. Read and follow agent_guidance_path before repository work; call again after the operator changes the context root.",
        { properties: { ...contextInput } },
      ],
      read_file: [
        "Read one text file with encoding detection, line-ending metadata and optional line bounds. Prefer this over exec, js, uv or Python.",
        { properties: {
          path: { type: "string" }, encoding: inputEncoding,
          start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
          ...contextInput,
        }, required: ["path"] },
      ],
      read_files: [
        "Read several text files with encoding detection. Prefer this over exec, js, uv or Python.",
        { properties: {
          paths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          encoding: inputEncoding,
          max_bytes_per_file: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576 },
          ...contextInput,
        }, required: ["paths"] },
      ],
      write_file: [
        "Create or overwrite one complete text file while preserving encoding, BOM and line endings by default.",
        { properties: {
          path: { type: "string" }, content: { type: "string" },
          create_parents: { type: "boolean", default: true }, expected_sha256: { type: "string" },
          ...outputText, ...contextInput,
        }, required: ["path", "content"] },
      ],
      write_files: [
        "Atomically write several complete text files with duplicate-path validation and rollback.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: { path: { type: "string" }, content: { type: "string" }, expected_sha256: { type: "string" }, ...outputText },
            required: ["path", "content"],
          } },
          create_parents: { type: "boolean", default: true }, ...contextInput,
        }, required: ["files"] },
      ],
      edit: [
        "Preferred tool for source edits. Applies ordered exact edits to each evolving in-memory document, validates occurrence counts, writes each file once and rolls back the whole batch. Do not use exec, js, uv or Python for edits expressible here.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: {
              path: { type: "string" }, expected_sha256: { type: "string" }, input_encoding: inputEncoding,
              ...outputText,
              edits: { type: "array", minItems: 1, maxItems: 200, items: exactEdit },
            },
            required: ["path", "edits"],
          } },
          ...contextInput,
        }, required: ["files"] },
      ],
      replace: [
        "Preview or atomically apply repeated literal or regular-expression replacements across a file glob. Supports exclusions, hidden/dependency traversal, file-size limits and an exact expected replacement count. Prefer this over exec, js, uv or Python.",
        { properties: {
          query: { type: "string" }, replacement: { type: "string" },
          path: { type: "string", default: "." }, glob: { type: "string", default: "**/*" },
          exclude: { type: "array", items: { type: "string" }, default: [] },
          regex: { type: "boolean", default: false }, case_sensitive: { type: "boolean", default: true },
          include_hidden: { type: "boolean", default: false },
          include_dependencies: { type: "boolean", default: false },
          max_file_bytes: { type: "integer", minimum: 1, maximum: 52428800, default: 5242880 },
          expected_replacements: { type: "integer", minimum: 0 },
          dry_run: { type: "boolean", default: true },
          max_files: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
          input_encoding: inputEncoding, ...outputText, ...contextInput,
        }, required: ["query", "replacement"] },
      ],
      glob: [
        "List files recursively under the current root using a glob pattern, optional exclusions and explicit hidden/dependency traversal. Prefer this over find, dir, ls, exec, uv or Python.",
        { properties: {
          path: { type: "string", default: "." }, pattern: { type: "string", default: "**/*" },
          exclude: { type: "array", items: { type: "string" }, default: [] },
          include_hidden: { type: "boolean", default: false },
          include_dependencies: { type: "boolean", default: false },
          limit: { type: "integer", minimum: 1, maximum: 10000, default: 2000 },
          ...contextInput,
        } },
      ],
      grep: [
        "Search text under the current root without spawning rg, grep, uv or Python. Supports literal/regex matching, globs, exclusions, context lines, hidden/dependency traversal, encoding selection and content/file/count output modes.",
        { properties: {
          pattern: { type: "string" }, path: { type: "string", default: "." },
          glob: { type: "string", default: "**/*" },
          exclude: { type: "array", items: { type: "string" }, default: [] },
          regex: { type: "boolean", default: false }, case_sensitive: { type: "boolean", default: false },
          include_hidden: { type: "boolean", default: false },
          include_dependencies: { type: "boolean", default: false },
          max_file_bytes: { type: "integer", minimum: 1, maximum: 52428800, default: 5242880 },
          encoding: inputEncoding,
          context_before: { type: "integer", minimum: 0, maximum: 20, default: 0 },
          context_after: { type: "integer", minimum: 0, maximum: 20, default: 0 },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "content" },
          max_results: { type: "integer", minimum: 1, maximum: 2000, default: 300 },
          ...contextInput,
        }, required: ["pattern"] },
      ],
      file_info: ["Return file or directory metadata.", { properties: { path: { type: "string" }, ...contextInput }, required: ["path"] }],
      create_directory: ["Create a directory and its parents.", { properties: { path: { type: "string" }, ...contextInput }, required: ["path"] }],
      copy_path: ["Copy a file or directory recursively.", { properties: { from: { type: "string" }, to: { type: "string" }, ...contextInput }, required: ["from", "to"] }],
      move_path: ["Move or rename a path.", { properties: { from: { type: "string" }, to: { type: "string" }, ...contextInput }, required: ["from", "to"] }],
      delete_path: ["Delete a file or directory.", { properties: { path: { type: "string" }, recursive: { type: "boolean", default: false }, ...contextInput }, required: ["path"] }],
      publish_file: [
        "Publish an existing file from the current root. Use this for generated images, PDFs, archives, databases and other binary outputs; never read or Base64-encode binary files manually.",
        { properties: {
          path: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" },
          expires_in: { type: "integer", minimum: 30, maximum: 604800, default: 86400 },
          one_time: { type: "boolean", default: false },
          return_mode: { type: "string", enum: ["inline", "link", "both"], default: "link" },
          ...contextInput,
        }, required: ["path"] },
      ],
      list_commands: [
        "Discover installed extra commands by name or purpose. Every returned logical_name is directly callable as exec.program without PATH probes.",
        { properties: {
          query: { type: "string", default: "" }, page: { type: "integer", minimum: 1, default: 1 },
          page_size: { type: "integer", minimum: 1, maximum: 100, default: 25 }, ...contextInput,
        } },
      ],
      exec: [
        "Run a foreground command. Do not invoke shell commands, uv or Python to read, list, search, edit or replace files when the structured MrMCP tools cover the operation.",
        { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
          ...execInput,
          timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 },
          return_files: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
          return_files_expires_in: { type: "integer", minimum: 30, maximum: 604800, default: 86400 },
          return_files_one_time: { type: "boolean", default: false },
          return_files_inline: { type: "boolean", default: true },
        } },
      ],
      exec_start: [
        "Start an interactive or background command; use exec_poll, exec_write and exec_kill afterward.",
        { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
          ...execInput, keep_stdin_open: { type: "boolean", default: true },
          timeout_ms: { type: "integer", minimum: 0, maximum: 604800000, default: 0 },
        } },
      ],
      exec_poll: ["Read incremental output and status for a process started by this context.", { properties: {
        process_id: { type: "string" }, stdout_offset: { type: "integer", minimum: 0, default: 0 },
        stderr_offset: { type: "integer", minimum: 0, default: 0 },
        wait_ms: { type: "integer", minimum: 0, maximum: 30000, default: 0 }, ...contextInput,
      }, required: ["process_id"] }],
      exec_write: ["Write to a process started by this context, or close its stdin.", { properties: {
        process_id: { type: "string" }, data: { type: "string", default: "" },
        encoding: { type: "string", enum: ["text", "base64"], default: "text" },
        close: { type: "boolean", default: false }, ...contextInput,
      }, required: ["process_id"] }],
      exec_kill: ["Terminate a process started by this context.", { properties: {
        process_id: { type: "string" }, signal: { type: "string", enum: ["SIGTERM", "SIGKILL"], default: "SIGTERM" },
        ...contextInput,
      }, required: ["process_id"] }],
      exec_list: ["List active and recent processes belonging to this context.", { properties: {
        include_completed: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, ...contextInput,
      } }],
      js: [
        "Run JavaScript in a persistent lazy kernel scoped to the current context and root. Use it for computation or programmatic parsing, not ordinary file inspection, search or edits.",
        { properties: {
          code: { type: "string" }, cwd: { type: "string", default: "." },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000, default: 30000 }, ...contextInput,
        }, required: ["code"] },
      ],
      js_add_node_module_dir: ["Add a directory to the persistent JavaScript kernel for the current context and root.", { properties: { path: { type: "string" }, ...contextInput }, required: ["path"] }],
      js_reset: ["Reset the persistent JavaScript kernel for the current context and root.", { properties: { ...contextInput } }],
    };

    const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
    const objectArray = { type: "array", items: { type: "object", additionalProperties: true } };
    const stringArray = { type: "array", items: { type: "string" } };
    const envelopeProperties = {
      context_handle: { type: "string", description: CONTEXT_HANDLE_OUTPUT_DESCRIPTION },
      error: { type: "string" },
    };
    const outputSchema = (properties = {}) => ({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false,
      properties: { ...envelopeProperties, ...properties },
      required: ["context_handle"],
    });
    const textMetadata = {
      encoding: { type: "string" }, bom: { type: "boolean" }, line_endings: { type: "string" },
    };
    const processProperties = {
      process_id: { type: "string" }, pid: { type: "integer" }, status: { type: "string" },
      command: {}, cwd: { type: "string" }, started_at: { type: "string" }, completed_at: nullableString,
      exit_code: { anyOf: [{ type: "integer" }, { type: "null" }] }, signal: nullableString,
      timed_out: { type: "boolean" }, stdout: { type: "string" }, stdout_from: { type: "integer" },
      stdout_next: { type: "integer" }, stdout_truncated_before: { anyOf: [{ type: "integer" }, { type: "null" }] },
      stderr: { type: "string" }, stderr_from: { type: "integer" }, stderr_next: { type: "integer" },
      stderr_truncated_before: { anyOf: [{ type: "integer" }, { type: "null" }] },
      stdin_open: { type: "boolean" }, success: { type: "boolean" }, returned_files: objectArray,
    };
    const outputSchemas = {
      create_context: outputSchema(),
      context_info: outputSchema({
        cwd: { type: "string", description: "Absolute path of the context's current root." },
        agent_guidance_path: {
          ...nullableString,
          description: "Absolute root-level AGENTS.md or agents.md path. When non-null, read and follow it before modifying files under this context root.",
        },
      }),
      read_file: outputSchema({ path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" }, content: { type: "string" }, ...textMetadata }),
      read_files: outputSchema({ files: objectArray }),
      write_file: outputSchema({ path: { type: "string" }, bytes: { type: "integer" }, sha256: { type: "string" }, ...textMetadata }),
      write_files: outputSchema({ files: objectArray }),
      edit: outputSchema({ files: objectArray, total_replacements: { type: "integer" } }),
      replace: outputSchema({ dry_run: { type: "boolean" }, scanned_files: { type: "integer" }, total_replacements: { type: "integer" }, files: objectArray }),
      glob: outputSchema({ files: stringArray, truncated: { type: "boolean" } }),
      grep: outputSchema({ output_mode: { type: "string" }, scanned_files: { type: "integer" }, matched_files: { type: "integer" }, results: objectArray, truncated: { type: "boolean" } }),
      file_info: outputSchema({ path: { type: "string" }, name: { type: "string" }, is_file: { type: "boolean" }, is_directory: { type: "boolean" }, is_symlink: { type: "boolean" }, size: { type: "integer" }, modified_at: nullableString, created_at: nullableString }),
      create_directory: outputSchema({ path: { type: "string" } }),
      copy_path: outputSchema({ from: { type: "string" }, to: { type: "string" } }),
      move_path: outputSchema({ from: { type: "string" }, to: { type: "string" } }),
      delete_path: outputSchema({ path: { type: "string" } }),
      publish_file: outputSchema({ path: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" }, size: { type: "integer" }, return_mode: { type: "string" }, inline: { type: "boolean" }, linked: { type: "boolean" }, uri: { type: "string" }, markdown: { type: "string" }, expires_at: { type: "string" }, one_time: { type: "boolean" }, inline_omitted_reason: { type: "string" } }),
      list_commands: outputSchema({ query: { type: "string" }, page: { type: "integer" }, page_size: { type: "integer" }, total: { type: "integer" }, pages: { type: "integer" }, has_more: { type: "boolean" }, bin_directory: { type: "string" }, config_file: { type: "string" }, path_precedence: { type: "string" }, invocation: { type: "object", additionalProperties: true }, commands: objectArray }),
      exec: outputSchema(processProperties),
      exec_start: outputSchema(processProperties),
      exec_poll: outputSchema(processProperties),
      exec_write: outputSchema({ process_id: { type: "string" }, bytes_written: { type: "integer" }, stdin_open: { type: "boolean" } }),
      exec_kill: outputSchema({ process_id: { type: "string" }, killed: { type: "boolean" }, signal: { type: "string" } }),
      exec_list: outputSchema({ processes: objectArray }),
      js: outputSchema({ kernel_id: { type: "string" }, cwd: { type: "string" }, value: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, module_dirs: stringArray }),
      js_add_node_module_dir: outputSchema({ kernel_id: { type: "string" }, path: { type: "string" }, module_dirs: stringArray }),
      js_reset: outputSchema({ reset: { type: "boolean" }, kernel_id: { type: "string" } }),
    };
    const genericOutputSchema = outputSchema();
    const processOutputSchema = outputSchema(processProperties);

    const titles = {
      create_context: "Create context", context_info: "Context info", read_file: "Read", read_files: "Read batch",
      write_file: "Write", write_files: "Write batch", edit: "Edit", replace: "Replace",
      glob: "Glob", grep: "Grep", publish_file: "Publish file", list_commands: "Command catalog",
      exec: "Run command", exec_start: "Start command", exec_poll: "Process output", exec_write: "Write stdin",
      exec_kill: "Terminate process", exec_list: "List processes", js: "JavaScript kernel",
      js_add_node_module_dir: "Add module directory", js_reset: "Reset JavaScript kernel",
    };
    const annotations = name => ({
      readOnlyHint: READ_TOOLS.has(name) || name === "publish_file",
      destructiveHint: ["write_file", "write_files", "edit", "replace", "move_path", "delete_path", "exec", "exec_start", "exec_write", "exec_kill", "js", "js_add_node_module_dir", "js_reset"].includes(name),
      idempotentHint: (READ_TOOLS.has(name) && name !== "publish_file") || ["write_file", "write_files", "edit", "create_directory", "js_reset"].includes(name),
      openWorldHint: name.startsWith("exec") || name === "js" || name === "publish_file",
    });
    const schema = value => ({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false, ...value,
    });
    const withRequiredContext = value => ({
      ...value,
      required: [...new Set([...(value.required || []), "context_handle"])],
    });
    const tools = [...available].filter(name => defs[name]).map(name => {
      const requiresContext = name !== "create_context";
      return {
        name,
        title: titles[name] || name.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
        description: requiresContext ? `${defs[name][0]} ${CONTEXT_HANDLE_RULE}` : defs[name][0],
        inputSchema: schema(requiresContext ? withRequiredContext(defs[name][1]) : defs[name][1]),
        outputSchema: outputSchemas[name] || genericOutputSchema,
        annotations: annotations(name),
        ...(name === "publish_file" ? { _meta: {
          ui: { resourceUri: FILE_PREVIEW_UI_URI }, "openai/outputTemplate": FILE_PREVIEW_UI_URI,
          "openai/toolInvocation/invoking": "Preparing file preview…", "openai/toolInvocation/invoked": "File preview ready.",
        } } : {}),
      };
    });
    for (const custom of all("SELECT * FROM custom_tools WHERE server_id=? ORDER BY name", p.id)) tools.push({
      name: custom.name,
      title: custom.name.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
      description: `${custom.description || `Run configured command: ${custom.command}`} ${CONTEXT_HANDLE_RULE}`,
      inputSchema: schema({ properties: {
        args: { type: "array", items: { type: "string" }, default: [] }, shell_command_suffix: { type: "string" },
        cwd: { type: "string", default: "." }, env: { type: "object", additionalProperties: { type: "string" } },
        stdin: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 },
        ...contextInput,
      }, required: ["context_handle"] }),
      outputSchema: processOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
    return tools;
  }

  function validateToolDescriptor(tool) {
    const errors = [];
    if (!tool || typeof tool !== "object") return ["descriptor is not an object"];
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name || "")) errors.push("invalid name");
    if (!tool.title || typeof tool.title !== "string") errors.push("missing title");
    if (!tool.description || typeof tool.description !== "string") errors.push("missing description");
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema))
      errors.push("invalid inputSchema");
    else if (tool.inputSchema.type !== "object") errors.push("inputSchema.type must be object");
    if (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema))
      errors.push("invalid outputSchema");
    else {
      if (tool.outputSchema.type !== "object") errors.push("outputSchema.type must be object");
      if (tool.outputSchema.additionalProperties !== false) errors.push("outputSchema.additionalProperties must be false");
      if (!tool.outputSchema.required?.includes("context_handle"))
        errors.push("outputSchema missing required context_handle");
      const expectedOutputs = {
        context_info: ["cwd", "agent_guidance_path"],
        glob: ["files", "truncated"],
        grep: ["scanned_files", "matched_files", "results", "truncated"],
        replace: ["scanned_files", "total_replacements", "files"],
        edit: ["total_replacements", "files"],
      };
      for (const key of expectedOutputs[tool.name] || [])
        if (!tool.outputSchema.properties?.[key]) errors.push(`outputSchema missing property ${key}`);
    }
    if (tool.name === "create_context") {
      if (tool.inputSchema?.properties?.context_handle) errors.push("create_context must not accept context_handle");
    } else {
      if (!tool.inputSchema?.properties?.context_handle) errors.push("inputSchema missing context_handle");
      if (!tool.inputSchema?.required?.includes("context_handle")) errors.push("inputSchema context_handle must be required");
    }
    const expectedInputs = {
      glob: ["exclude", "include_hidden", "include_dependencies", "limit"],
      grep: ["exclude", "regex", "case_sensitive", "include_hidden", "include_dependencies", "max_file_bytes", "encoding", "context_before", "context_after", "output_mode", "max_results"],
      replace: ["exclude", "regex", "case_sensitive", "include_hidden", "include_dependencies", "max_file_bytes", "expected_replacements", "dry_run", "max_files"],
    };
    for (const key of expectedInputs[tool.name] || [])
      if (!tool.inputSchema.properties?.[key]) errors.push(`inputSchema missing property ${key}`);
    return errors;
  }
  function mcpSelfTest(p) {
    const tools = serverTools(p);
    const invalid = tools.map(tool => ({
      name: tool.name,
      errors: validateToolDescriptor(tool),
    })).filter(x => x.errors.length);
    const resource = filePreviewResource();
    const publishTool = tools.find(tool => tool.name === "publish_file");
    const uiErrors = [];
    if (resource.uri !== FILE_PREVIEW_UI_URI) uiErrors.push("unexpected UI resource URI");
    if (resource.mimeType !== MCP_UI_MIME_TYPE) uiErrors.push("unexpected UI resource MIME type");
    if (!filePreviewAppHtml().includes("ui/notifications/tool-result")) uiErrors.push("UI bridge listener missing");
    if (filePreviewAppHtml().includes("base64") || filePreviewAppHtml().includes("data:")) uiErrors.push("UI must not embed Base64/data URLs");
    if (!filePreviewAppHtml().includes("resource_link")) uiErrors.push("UI resource-link handling missing");
    if (publishTool?._meta?.ui?.resourceUri !== FILE_PREVIEW_UI_URI) uiErrors.push("publish_file UI metadata missing");
    if (publishTool?._meta?.["openai/outputTemplate"] !== FILE_PREVIEW_UI_URI) uiErrors.push("ChatGPT output-template alias missing");
    return {
      ok: tools.length > 0 && invalid.length === 0 && uiErrors.length === 0,
      endpoint: "/mcp",
      protocol_versions: MCP_PROTOCOLS,
      tool_count: tools.length,
      tool_names: tools.map(x => x.name),
      invalid_tools: invalid,
      ui_errors: uiErrors,
      server_discover_result: {
        resultType: "complete",
        supportedVersions: MCP_PROTOCOLS,
        capabilities: serverCapabilities(true),
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "MrMCP",
            version: VERSION,
          },
        },
        ttlMs: 300000,
        cacheScope: "private",
      },
      modern_tools_list_result: {
        resultType: "complete",
        tools,
        ttlMs: 300000,
        cacheScope: "private",
      },
      resources_list_result: { resources: [resource] },
      resources_read_result: {
        contents: [{
          uri: FILE_PREVIEW_UI_URI, mimeType: MCP_UI_MIME_TYPE,
          text: filePreviewAppHtml(), _meta: filePreviewUiMeta(),
        }],
      },
    };
  }

  function beginLog(p, tool, args, contextHandle = "", root = null) {
    const contextId = Number(contextByHandle(p, contextHandle)?.id || 0);
    const inserted = run(`INSERT INTO logs(started_at,server_id,server_name,tool,status,input_json,
      context_id,context_handle,root_id,root_name,root_path) VALUES(?,?,?,?,'received',?,?,?,?,?,?)`,
      Date.now(), p.id, "mcp", tool, JSON.stringify(args), contextId, String(contextHandle || ""),
      Number(root?.id || 0), String(root?.name || ""), String(root?.path || ""));
    return Number(inserted.lastInsertRowid);
  }
  function updateLog(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    run(`UPDATE logs SET ${keys.map(k => `${k}=?`).join(",")} WHERE id=?`, ...keys.map(k => fields[k]), id);
  }
  function indexLog(id) {
    if (!fts) return;
    try {
      const l = one("SELECT * FROM logs WHERE id=?", id);
      run("DELETE FROM logs_fts WHERE log_id=?", id);
      run("INSERT INTO logs_fts(log_id,server,tool,input,output,stderr,error) VALUES(?,?,?,?,?,?,?)",
        id, l.server_name, l.tool, l.input_json, l.result_json || l.resolved_json || l.stdout || '', l.stderr, l.error);
    } catch {}
  }
  function rejectToolCall(p, tool, args, message, contextHandle = "") {
    const id = beginLog(p, tool, args, contextHandle), completed = Date.now();
    updateLog(id, {
      completed_at: completed, duration_ms: 0, status: "failed",
      error: message, result_json: JSON.stringify({ error: message }),
    });
    indexLog(id);
    return id;
  }
  // Long-running process management mirrors the Bash/BashOutput/KillShell pattern:
  // exec is blocking; exec_start + exec_poll/exec_write/exec_kill is interactive.
  const PROCESS_BUFFER_LIMIT = 4 * 1024 * 1024;
  const processTail = value => value.length > 65536 ? value.slice(-65536) : value;
  function appendProcessOutput(rec, stream, value) {
    if (!value) return;
    const key = stream, base = `${stream}_base`;
    rec[key] += value;
    if (rec[key].length > PROCESS_BUFFER_LIMIT) {
      const cut = rec[key].length - PROCESS_BUFFER_LIMIT;
      rec[key] = rec[key].slice(cut);
      rec[base] += cut;
    }
    rec.updated_at = Date.now();
  }
  async function pumpProcess(stream, rec, key) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        appendProcessOutput(rec, key, decoder.decode(value, { stream: true }));
      }
      appendProcessOutput(rec, key, decoder.decode());
    } catch (e) {
      rec.error ||= String(e?.message || e);
    }
  }
  function commandSpec(args) {
    const hasProgram = typeof args.program === "string" && args.program.length;
    const hasShell = typeof args.shell_command === "string" && args.shell_command.length;
    if (hasProgram === hasShell) throw new Error("Specify exactly one of program or shell_command");
    if (hasProgram) {
      if (!Array.isArray(args.args) || !args.args.every(x => typeof x === "string"))
        throw new Error("args must be an array of strings");
      return { program: args.program, argv: args.args, display: JSON.stringify([args.program, ...args.args]), shell: false };
    }
    const win = Deno.build.os === "windows";
    const shellProgram = win
      ? (Deno.env.get("ComSpec") || join(Deno.env.get("SystemRoot") || "C:\\Windows", "System32", "cmd.exe"))
      : (Deno.env.get("SHELL") || "/bin/sh");
    return {
      program: shellProgram,
      argv: win ? ["/d", "/s", "/c", args.shell_command] : ["-lc", args.shell_command],
      display: args.shell_command,
      shell: true,
    };
  }
  function processView(rec, stdoutOffset = 0, stderrOffset = 0) {
    const read = (key, requested) => {
      const base = rec[`${key}_base`], start = Math.max(Number(requested || 0), base);
      return {
        value: rec[key].slice(start - base),
        from: start,
        next: base + rec[key].length,
        truncated_before: Number(requested || 0) < base ? base : null,
      };
    };
    const out = read("stdout", stdoutOffset), err = read("stderr", stderrOffset);
    return {
      process_id: rec.id, pid: rec.pid, status: rec.status, command: rec.display,
      cwd: rec.cwd_display, context_handle: rec.context_handle,
      started_at: new Date(rec.started_at).toISOString(),
      completed_at: rec.completed_at ? new Date(rec.completed_at).toISOString() : null,
      exit_code: rec.exit_code, signal: rec.signal || null, timed_out: !!rec.timed_out,
      stdout: out.value, stdout_from: out.from, stdout_next: out.next, stdout_truncated_before: out.truncated_before,
      stderr: err.value, stderr_from: err.from, stderr_next: err.next, stderr_truncated_before: err.truncated_before,
      stdin_open: !!rec.stdin_writer, error: rec.error || "",
      success: rec.status === "running" || rec.status === "completed",
    };
  }
  function processSummary(rec, tail = 8192) {
    const stdoutTotal = rec.stdout_base + rec.stdout.length;
    const stderrTotal = rec.stderr_base + rec.stderr.length;
    return processView(
      rec, Math.max(rec.stdout_base, stdoutTotal - tail),
      Math.max(rec.stderr_base, stderrTotal - tail),
    );
  }
  async function terminateProcess(rec, signal = "SIGTERM") {
    if (!rec || !["starting", "running"].includes(rec.status)) return false;
    try { rec.child.kill(signal); }
    catch {
      if (Deno.build.os === "windows" && rec.pid) {
        await new Deno.Command("taskkill", { args: ["/PID", String(rec.pid), "/T", "/F"], stdout: "null", stderr: "null" }).output().catch(() => {});
      }
    }
    rec.signal = signal;
    return true;
  }
  async function startManagedProcess(p, args, background, execution = {}) {
    const target = await resolveWorkspacePath(execution.selection, args.cwd || ".");
    const defaultTimeout = background ? 0 : 120000;
    const spec = commandSpec(args), timeout = Math.max(0, Math.min(
      Number(args.timeout_ms ?? defaultTimeout), 604800000,
    ));
    if (!spec.shell) {
      const mapped = await catalogProgram(spec.program);
      if (mapped) {
        spec.catalog_name = mapped.name;
        spec.program = mapped.absolute;
        spec.display = JSON.stringify([mapped.name, ...spec.argv]);
      }
    }
    const inheritedEnv = Deno.env.toObject();
    const suppliedEnv = Object.fromEntries(Object.entries(args.env || {}).map(([key, value]) => [key, String(value)]));
    const pathKey = Deno.build.os === "windows" ? "Path" : "PATH";
    const includeSystemPath = getCfg("inherit_system_path", "1") === "1";
    const suppliedPathKey = Object.keys(suppliedEnv).find(key => key.toLowerCase() === "path");
    const inheritedPathKey = Object.keys(inheritedEnv).find(key => key.toLowerCase() === "path");
    const inheritedPath = suppliedPathKey ? suppliedEnv[suppliedPathKey]
      : inheritedPathKey ? inheritedEnv[inheritedPathKey] : "";
    for (const key of Object.keys(inheritedEnv)) if (key.toLowerCase() === "path") delete inheritedEnv[key];
    for (const key of Object.keys(suppliedEnv)) if (key.toLowerCase() === "path") delete suppliedEnv[key];
    const processEnv = { ...inheritedEnv, ...suppliedEnv };
    processEnv[pathKey] = includeSystemPath && inheritedPath
      ? BIN_DIR + (Deno.build.os === "windows" ? ";" : ":") + inheritedPath
      : BIN_DIR;
    processEnv.MRMCP_BIN = BIN_DIR;
    const child = new Deno.Command(spec.program, {
      args: spec.argv, cwd: target.path, env: processEnv, clearEnv: true,
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const rec = {
      id: `proc_${randomToken(18)}`, pid: child.pid, child, log_id: Number(execution.logId || 0),
      server_id: p.id, server_name: "mcp", context_id: target.context.id, context_handle: target.context.handle,
      root_id: target.root.id, root_path: target.root.path, root_name: target.root.name,
      display: spec.display, command_json: JSON.stringify({
        program: spec.program, args: spec.argv, shell: spec.shell,
        catalog_name: spec.catalog_name || null, system_path_inherited: includeSystemPath,
      }),
      cwd: target.path, cwd_display: target.display, status: "running", started_at: Date.now(), completed_at: null,
      exit_code: null, signal: "", timed_out: false, error: "",
      stdout: "", stderr: "", stdout_base: 0, stderr_base: 0, updated_at: Date.now(),
      stdin_writer: child.stdin.getWriter(), timeout_timer: null, done: null,
    };
    processes.set(rec.id, rec);
    execution.setCancel?.(signal => terminateProcess(rec, signal), { process_id: rec.id, kind: "process" });
    run(`INSERT INTO process_runs(id,pid,server_id,server_name,context_id,context_handle,root_id,root_name,root_path,
      command_json,cwd,status,started_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id, rec.pid, p.id, "mcp", rec.context_id, rec.context_handle, rec.root_id, rec.root_name, rec.root_path,
      rec.command_json, rec.cwd_display, rec.status, rec.started_at, timeout);
    const stdoutPump = pumpProcess(child.stdout, rec, "stdout"), stderrPump = pumpProcess(child.stderr, rec, "stderr");
    rec.done = child.status.then(async status => {
      await Promise.allSettled([stdoutPump, stderrPump]);
      rec.completed_at = Date.now(); rec.exit_code = status.code; rec.signal ||= status.signal || "";
      rec.status = rec.timed_out ? "timed_out" : status.success ? "completed" : rec.signal ? "killed" : "failed";
      if (rec.timeout_timer) clearTimeout(rec.timeout_timer);
      try { await rec.stdin_writer?.close(); } catch {}
      rec.stdin_writer = null;
      run(`UPDATE process_runs SET status=?,completed_at=?,exit_code=?,signal=?,stdout_tail=?,stderr_tail=?,error=? WHERE id=?`,
        rec.status, rec.completed_at, rec.exit_code, rec.signal, processTail(rec.stdout), processTail(rec.stderr), rec.error, rec.id);
      return rec;
    }).catch(error => {
      rec.completed_at = Date.now(); rec.status = "failed"; rec.error = String(error?.stack || error);
      run("UPDATE process_runs SET status='failed',completed_at=?,error=? WHERE id=?", rec.completed_at, rec.error, rec.id);
      return rec;
    });
    if (timeout > 0) rec.timeout_timer = setTimeout(() => {
      rec.timed_out = true;
      terminateProcess(rec, "SIGKILL").catch(() => {});
    }, timeout);
    if (args.stdin != null) {
      const bytes = args.stdin_encoding === "base64"
        ? new Uint8Array(Buffer.from(String(args.stdin), "base64")) : enc.encode(String(args.stdin));
      await rec.stdin_writer.write(bytes);
    }
    if (!background || args.keep_stdin_open === false) {
      try { await rec.stdin_writer.close(); } catch {}
      rec.stdin_writer = null;
    }
    return rec;
  }
  function ownedProcess(id, contextHandle = "") {
    const rec = processes.get(String(id || ""));
    if (!rec || rec.context_handle !== String(contextHandle || ""))
      throw new Error("Unknown process_id for this context_handle");
    return rec;
  }
  function cleanupProcesses(maxAge = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAge;
    for (const [id, rec] of processes)
      if (rec.completed_at && rec.completed_at < cutoff) processes.delete(id);
  }
  function maintenance() {
    const now = Date.now();
    cleanupProcesses();
    for (const [key, kernel] of jsKernels)
      if (now - kernel.last_used > 60 * 60 * 1000) destroyJsKernel(key, "expired");
    run("DELETE FROM oauth_codes WHERE expires_at<?", now);
    run("DELETE FROM oauth_tokens WHERE expires_at<?", now);
    run(`DELETE FROM oauth_clients WHERE created_at<? AND client_id NOT IN
      (SELECT DISTINCT client_id FROM oauth_tokens UNION SELECT DISTINCT client_id FROM oauth_refresh_tokens)`,
      now - 30 * 24 * 60 * 60 * 1000);
    for (const [token, consent] of oauthConsents)
      if (consent.expires_at < now) oauthConsents.delete(token);
    for (const [key, bucket] of rateBuckets)
      if (now - bucket.started > 2 * 60 * 1000) rateBuckets.delete(key);
    expireDownloadTokens(now).catch(() => {});
  }
  async function pollManagedProcess(rec, args) {
    if (!rec) throw new Error("Unknown process_id (processes do not survive server restart)");
    const before = `${rec.status}:${rec.stdout_base + rec.stdout.length}:${rec.stderr_base + rec.stderr.length}`;
    const wait = Math.max(0, Math.min(Number(args.wait_ms || 0), 30000)), until = Date.now() + wait;
    while (Date.now() < until) {
      const now = `${rec.status}:${rec.stdout_base + rec.stdout.length}:${rec.stderr_base + rec.stderr.length}`;
      if (now !== before) break;
      await sleep(Math.min(100, until - Date.now()));
    }
    return processView(rec, args.stdout_offset, args.stderr_offset);
  }
  function recentProcesses(contextHandle, includeCompleted = true, limit = 50) {
    const handle = String(contextHandle || "");
    const active = [...processes.values()].filter(record =>
      record.context_handle === handle && (includeCompleted || record.status === "running"));
    const ids = new Set(active.map(record => record.id));
    const historic = includeCompleted ? all(
      "SELECT * FROM process_runs WHERE context_handle=? ORDER BY started_at DESC LIMIT ?", handle, limit,
    ).filter(record => !ids.has(record.id)).map(record => ({
      process_id: record.id, pid: record.pid, status: record.status,
      command: parseJson(record.command_json, record.command_json), cwd: record.cwd,
      context_handle: record.context_handle,
      started_at: new Date(record.started_at).toISOString(),
      completed_at: record.completed_at ? new Date(record.completed_at).toISOString() : null,
      exit_code: record.exit_code, signal: record.signal || null,
      stdout_tail: record.stdout_tail, stderr_tail: record.stderr_tail, error: record.error,
    })) : [];
    return [...active.map(record => processView(record)), ...historic].slice(0, limit);
  }

  function jsKernelKey(p, contextHandle, rootId) {
    return `${p.id}:${contextHandle}:${rootId}`;
  }
  function destroyJsKernel(key, reason = "reset") {
    const kernel = jsKernels.get(key);
    if (!kernel) return false;
    kernel.worker.terminate();
    URL.revokeObjectURL(kernel.url);
    for (const pending of kernel.pending.values()) pending.reject(new Error(`JavaScript kernel ${reason}`));
    jsKernels.delete(key);
    return true;
  }
  function createJsKernel(key) {
    const url = URL.createObjectURL(new Blob([JS_KERNEL_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const kernel = { key, url, worker, pending: new Map(), next: 1, module_dirs: [], last_used: Date.now() };
    worker.onmessage = event => {
      const pending = kernel.pending.get(event.data?.id);
      if (!pending) return;
      kernel.pending.delete(event.data.id);
      event.data.ok ? pending.resolve(event.data.result) : pending.reject(new Error(event.data.error));
    };
    worker.onerror = event => {
      for (const pending of kernel.pending.values())
        pending.reject(event.error || new Error(event.message || "JavaScript kernel failed"));
      kernel.pending.clear();
      destroyJsKernel(key, "failed");
    };
    jsKernels.set(key, kernel);
    return kernel;
  }
  function jsKernelCall(kernel, payload, timeout = 30000) {
    kernel.last_used = Date.now();
    const id = kernel.next++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        kernel.pending.delete(id);
        destroyJsKernel(kernel.key, "timed out");
        reject(new Error(`JavaScript evaluation timed out after ${timeout} ms; kernel reset`));
      }, timeout);
      kernel.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolveCall(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      kernel.worker.postMessage({ id, ...payload });
    });
  }
  function jsKernelContext(p, selection) {
    const key = jsKernelKey(p, selection.context.handle, selection.root.id);
    return { selection, key, kernel: jsKernels.get(key) || createJsKernel(key) };
  }

  async function executeTool(p, name, args, execution) {
    const selection = execution.selection;
    if (name === "create_context") return {};
    if (!selection?.context || !selection?.root) throw new Error("Context selection is missing");
    if (name === "context_info") return await contextInfo(selection);

    const resolvePath = path => resolveWorkspacePath(selection, path);
    const readOne = async pathArg => {
      const target = await resolvePath(pathArg);
      const document = await readTextDocument(target.path, args.encoding || "auto");
      const lines = document.text.split(/\r\n|\r|\n/);
      const start = Math.max(1, Number(args.start_line || 1));
      const end = Math.min(lines.length, Number(args.end_line || lines.length));
      return {
        path: target.display, start_line: start, end_line: end,
        encoding: document.encoding, bom: document.bom, line_endings: document.line_endings,
        content: lines.slice(start - 1, end).join("\n"),
      };
    };
    if (name === "read_file") return await readOne(args.path);
    if (name === "read_files") {
      const max = Math.min(Number(args.max_bytes_per_file || 1048576), 5242880), files = [];
      for (const item of args.paths || []) {
        try {
          const target = await resolvePath(item), stat = await Deno.stat(target.path);
          if (stat.size > max) files.push({ path: target.display, error: `File exceeds ${max} bytes`, size: stat.size });
          else {
            const document = await readTextDocument(target.path, args.encoding || "auto");
            files.push({ path: target.display, content: document.text, size: stat.size,
              encoding: document.encoding, bom: document.bom, line_endings: document.line_endings });
          }
        } catch (error) { files.push({ path: String(item), error: String(error?.message || error) }); }
      }
      return { files };
    }
    if (name === "write_file") {
      const target = await resolvePath(args.path);
      let source = null;
      try { source = await readTextDocument(target.path, "auto"); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
      if (args.expected_sha256) {
        const current = source ? await sha256(source.bytes) : "";
        if (current !== args.expected_sha256) throw new Error("File hash changed");
      }
      const output = encodeTextDocument(String(args.content), source, args);
      if (args.create_parents !== false) await Deno.mkdir(dirname(target.path), { recursive: true });
      await Deno.writeFile(target.path, output.bytes);
      return { path: target.display, bytes: output.bytes.length, sha256: await fileHash(target.path),
        encoding: output.encoding, bom: output.bom, line_endings: output.line_endings };
    }
    if (name === "write_files") {
      const changes = [], seen = new Set();
      for (const file of args.files || []) {
        const target = await resolvePath(file.path), key = Deno.build.os === "windows" ? target.path.toLowerCase() : target.path;
        if (seen.has(key)) throw new Error(`Duplicate file path: ${file.path}`);
        seen.add(key);
        let before = null, source = null;
        try { before = await Deno.readFile(target.path); source = decodeTextDocument(before, "auto"); }
        catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
        if (file.expected_sha256) {
          const current = before ? await sha256(before) : "";
          if (current !== file.expected_sha256) throw new Error(`${file.path}: file hash changed`);
        }
        changes.push({ target, before, output: encodeTextDocument(String(file.content), source, file) });
      }
      try {
        for (const change of changes) {
          if (args.create_parents !== false) await Deno.mkdir(dirname(change.target.path), { recursive: true });
          await Deno.writeFile(change.target.path, change.output.bytes);
        }
      } catch (error) {
        for (const change of changes) {
          try {
            if (change.before == null) await Deno.remove(change.target.path);
            else await Deno.writeFile(change.target.path, change.before);
          } catch {}
        }
        throw error;
      }
      return { files: await Promise.all(changes.map(async change => ({
        path: change.target.display, sha256: await fileHash(change.target.path), bytes: change.output.bytes.length,
        encoding: change.output.encoding, bom: change.output.bom, line_endings: change.output.line_endings,
      }))) };
    }
    if (name === "edit") {
      const changes = [], seen = new Set();
      for (const file of args.files || []) {
        const target = await resolvePath(file.path), key = Deno.build.os === "windows" ? target.path.toLowerCase() : target.path;
        if (seen.has(key)) throw new Error(`Duplicate file path: ${file.path}; group all ordered edits in one files entry`);
        seen.add(key);
        const document = await readTextDocument(target.path, file.input_encoding || "auto");
        if (file.expected_sha256 && await sha256(document.bytes) !== file.expected_sha256)
          throw new Error(`${file.path}: file hash changed`);
        let current = document.text, replacements = 0;
        for (let index = 0; index < (file.edits || []).length; index++) {
          const edit = file.edits[index];
          const oldText = editNeedle(edit.old_text, document), newText = editNeedle(edit.new_text, document);
          if (!oldText) throw new Error(`${file.path}: edit ${index + 1} has empty old_text`);
          const count = current.split(oldText).length - 1;
          const expected = Number(edit.expected_occurrences ?? 1);
          if (count !== expected)
            throw new Error(`${file.path}: edit ${index + 1} expected ${expected} occurrences, found ${count}`);
          current = current.split(oldText).join(newText);
          replacements += count;
        }
        const output = encodeTextDocument(current, document, file);
        changes.push({ target, before: document.bytes, output, replacements });
      }
      try { for (const change of changes) await Deno.writeFile(change.target.path, change.output.bytes); }
      catch (error) {
        for (const change of changes) await Deno.writeFile(change.target.path, change.before).catch(() => {});
        throw error;
      }
      return {
        total_replacements: changes.reduce((total, change) => total + change.replacements, 0),
        files: await Promise.all(changes.map(async change => ({
          path: change.target.display, replacements: change.replacements,
          sha256: await fileHash(change.target.path), encoding: change.output.encoding,
          bom: change.output.bom, line_endings: change.output.line_endings,
        }))),
      };
    }
    const excludedPath = (path, patterns = []) => patterns.some(pattern => globRegex(pattern).test(path));
    if (name === "replace") {
      const dryRun = args.dry_run !== false;
      const flags = args.case_sensitive === false ? "gim" : "gm";
      const source = args.regex
        ? String(args.query)
        : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!source) throw new Error("query must not be empty");
      const regex = new RegExp(source, flags), changes = [];
      const maxFiles = Math.min(Number(args.max_files || 200), 1000);
      const maxFileBytes = Math.min(Number(args.max_file_bytes || 5 * 1024 * 1024), 50 * 1024 * 1024);
      let scannedFiles = 0, totalReplacements = 0, limitExceeded = false;
      const paths = await walk(selection.root.path, args.path || ".", {
        pattern: args.glob || "**/*", limit: 10000,
        include_hidden: args.include_hidden === true,
        include_dependencies: args.include_dependencies === true,
      });
      for (const relativePath of paths) {
        if (excludedPath(relativePath, args.exclude || [])) continue;
        const path = await safePath(selection.root.path, relativePath);
        try {
          const stat = await Deno.stat(path);
          scannedFiles++;
          if (!stat.isFile || stat.size > maxFileBytes) continue;
          const document = await readTextDocument(path, args.input_encoding || "auto");
          regex.lastIndex = 0;
          const matches = [...document.text.matchAll(regex)].length;
          regex.lastIndex = 0;
          if (!matches) continue;
          totalReplacements += matches;
          if (changes.length >= maxFiles) {
            limitExceeded = true;
            break;
          }
          changes.push({
            path, display: relativePath, before: document.bytes, matches,
            output: encodeTextDocument(document.text.replace(regex, String(args.replacement)), document, args),
          });
        } catch {}
        if (limitExceeded) break;
      }
      if (limitExceeded) throw new Error(`replace would change more than max_files (${maxFiles}) files`);
      if (args.expected_replacements != null && totalReplacements !== Number(args.expected_replacements))
        throw new Error(`replace expected ${Number(args.expected_replacements)} total replacements, found ${totalReplacements}`);
      if (!dryRun) {
        try { for (const change of changes) await Deno.writeFile(change.path, change.output.bytes); }
        catch (error) {
          for (const change of changes) await Deno.writeFile(change.path, change.before).catch(() => {});
          throw error;
        }
      }
      return {
        dry_run: dryRun,
        scanned_files: scannedFiles,
        total_replacements: totalReplacements,
        files: changes.map(change => ({
          path: change.display, replacements: change.matches,
          encoding: change.output.encoding, bom: change.output.bom, line_endings: change.output.line_endings,
        })),
      };
    }
    if (name === "glob") {
      const limit = Math.min(Number(args.limit || 2000), 10000);
      const paths = await walk(selection.root.path, args.path || ".", {
        pattern: args.pattern || "**/*", limit: 10000,
        include_hidden: args.include_hidden === true,
        include_dependencies: args.include_dependencies === true,
      });
      const filtered = paths.filter(path => !excludedPath(path, args.exclude || []));
      return {
        files: filtered.slice(0, limit),
        truncated: filtered.length > limit || paths.length >= 10000,
      };
    }
    if (name === "grep") {
      const flags = args.case_sensitive ? "g" : "gi";
      const source = args.regex
        ? String(args.pattern)
        : String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!source) throw new Error("pattern must not be empty");
      const regex = new RegExp(source, flags), max = Math.min(Number(args.max_results || 300), 2000);
      const maxFileBytes = Math.min(Number(args.max_file_bytes || 5 * 1024 * 1024), 50 * 1024 * 1024);
      const before = Math.min(Number(args.context_before || 0), 20);
      const after = Math.min(Number(args.context_after || 0), 20);
      const mode = String(args.output_mode || "content"), results = [];
      let scannedFiles = 0, matchedFiles = 0, truncated = false;
      const paths = await walk(selection.root.path, args.path || ".", {
        pattern: args.glob || "**/*", limit: 10000,
        include_hidden: args.include_hidden === true,
        include_dependencies: args.include_dependencies === true,
      });
      for (const relativePath of paths) {
        if (excludedPath(relativePath, args.exclude || [])) continue;
        try {
          const path = await safePath(selection.root.path, relativePath), stat = await Deno.stat(path);
          scannedFiles++;
          if (!stat.isFile || stat.size > maxFileBytes) continue;
          const document = await readTextDocument(path, args.encoding || "auto");
          const lines = document.text.split(/\r\n|\r|\n/), matches = [];
          for (let index = 0; index < lines.length; index++) {
            regex.lastIndex = 0;
            if (regex.test(lines[index])) matches.push(index);
          }
          if (!matches.length) continue;
          matchedFiles++;
          if (mode === "files_with_matches") results.push({ path: relativePath });
          else if (mode === "count") results.push({ path: relativePath, count: matches.length });
          else for (const index of matches) {
            results.push({
              path: relativePath, line: index + 1, text: lines[index],
              ...(before ? { before: lines.slice(Math.max(0, index - before), index).map((text, offset) => ({
                line: Math.max(0, index - before) + offset + 1, text,
              })) } : {}),
              ...(after ? { after: lines.slice(index + 1, index + 1 + after).map((text, offset) => ({
                line: index + offset + 2, text,
              })) } : {}),
            });
            if (results.length >= max) { truncated = true; break; }
          }
        } catch {}
        if (results.length >= max) {
          if (mode !== "content") truncated = true;
          break;
        }
      }
      return {
        output_mode: mode,
        scanned_files: scannedFiles,
        matched_files: matchedFiles,
        results: results.slice(0, max),
        truncated,
      };
    }
    if (name === "file_info") {
      const target = await resolvePath(args.path), stat = await Deno.lstat(target.path);
      return { path: target.display, name: basename(target.path), is_file: stat.isFile,
        is_directory: stat.isDirectory, is_symlink: stat.isSymlink, size: stat.size,
        modified_at: stat.mtime?.toISOString() || null, created_at: stat.birthtime?.toISOString() || null };
    }
    if (name === "create_directory") {
      const target = await resolvePath(args.path); await Deno.mkdir(target.path, { recursive: true });
      return { path: target.display };
    }
    if (name === "copy_path" || name === "move_path") {
      const from = await resolvePath(args.from), to = await resolvePath(args.to);
      await Deno.mkdir(dirname(to.path), { recursive: true });
      if (name === "copy_path") await copyRecursive(from.path, to.path);
      else {
        try { await Deno.rename(from.path, to.path); }
        catch (error) {
          if (!(error instanceof Deno.errors.NotSupported) && error?.code !== "EXDEV") throw error;
          await copyRecursive(from.path, to.path); await Deno.remove(from.path, { recursive: true });
        }
      }
      return { from: from.display, to: to.display };
    }
    if (name === "delete_path") {
      const target = await resolvePath(args.path);
      if (resolve(target.path) === resolve(await Deno.realPath(target.root.path))) throw new Error("Cannot delete the current root");
      await Deno.remove(target.path, { recursive: !!args.recursive });
      return { path: target.display };
    }
    if (name === "publish_file") {
      const target = await resolvePath(args.path);
      const result = await publishPath(target.path, {
        filename: args.filename || basename(target.path), mime_type: args.mime_type,
        expires_in: args.expires_in, one_time: args.one_time,
        return_mode: args.return_mode || "link", allowed_root: target.root.path,
      });
      return { path: target.display, ...result };
    }
    if (name === "list_commands") return await commandCatalog({ ...args, admin: false, include_missing: false });
    if (name === "js") {
      const { key, kernel } = jsKernelContext(p, selection);
      execution.setCancel?.(() => destroyJsKernel(key, "terminated from GUI"), { kernel_id: key, kind: "javascript" });
      const cwd = await resolvePath(args.cwd || ".");
      const result = await jsKernelCall(kernel, {
        action: "eval", code: String(args.code), cwd: cwd.path,
      }, Math.min(Number(args.timeout_ms || 30000), 120000));
      kernel.module_dirs = result.module_dirs || kernel.module_dirs;
      return { kernel_id: kernel.key, cwd: cwd.display, ...result };
    }
    if (name === "js_add_node_module_dir") {
      const { kernel } = jsKernelContext(p, selection);
      const target = await resolvePath(args.path);
      if (!(await Deno.stat(target.path)).isDirectory) throw new Error("Module path is not a directory");
      const result = await jsKernelCall(kernel, { action: "add_dir", path: target.path }, 10000);
      kernel.module_dirs = result.module_dirs;
      return { kernel_id: kernel.key, path: target.display, module_dirs: result.module_dirs };
    }
    if (name === "js_reset") {
      const key = jsKernelKey(p, selection.context.handle, selection.root.id);
      return { reset: destroyJsKernel(key), kernel_id: key };
    }
    if (name === "exec" || name === "exec_start") {
      const record = await startManagedProcess(p, args, name === "exec_start", execution);
      if (name === "exec_start") return processView(record);
      await record.done;
      const view = processView(record), returned = await processReturnFiles(record, args);
      return returned ? { ...view, returned_files: returned.returned_files, mcp_content: returned.mcp_content } : view;
    }
    if (name === "exec_poll") return await pollManagedProcess(ownedProcess(args.process_id, args.context_handle), args);
    if (name === "exec_write") {
      const record = ownedProcess(args.process_id, args.context_handle);
      if (!record.stdin_writer) throw new Error("Process stdin is closed");
      if (args.data) await record.stdin_writer.write(args.encoding === "base64"
        ? new Uint8Array(Buffer.from(String(args.data), "base64")) : enc.encode(String(args.data)));
      if (args.close) { await record.stdin_writer.close(); record.stdin_writer = null; }
      return { process_id: record.id,
        bytes_written: args.data ? (args.encoding === "base64"
          ? Buffer.from(String(args.data), "base64").length : enc.encode(String(args.data)).length) : 0,
        stdin_open: !!record.stdin_writer };
    }
    if (name === "exec_kill") {
      const record = ownedProcess(args.process_id, args.context_handle);
      return { process_id: record.id, killed: await terminateProcess(record, args.signal || "SIGTERM"),
        signal: args.signal || "SIGTERM" };
    }
    if (name === "exec_list") return { processes: recentProcesses(
      args.context_handle, args.include_completed !== false, Math.min(Number(args.limit || 50), 200),
    ) };
    const custom = one("SELECT * FROM custom_tools WHERE server_id=? AND name=?", p.id, name);
    if (!custom) throw new Error("Unknown tool");
    const arrayCommand = parseJson(custom.command, null), customArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const spec = Array.isArray(arrayCommand) && arrayCommand.length
      ? { ...args, program: String(arrayCommand[0]), args: [...arrayCommand.slice(1).map(String), ...customArgs] }
      : { ...args, shell_command: custom.command + (args.shell_command_suffix ? " " + args.shell_command_suffix : "") };
    const record = await startManagedProcess(p, spec, false, execution);
    await record.done;
    return processView(record);
  }

  function redactTemporaryDownloadUrls(value) {
    if (typeof value === "string")
      return value.replace(/\/download\/[A-Za-z0-9_-]{40,}\//g, "/download/[REDACTED]/");
    if (Array.isArray(value)) return value.map(redactTemporaryDownloadUrls);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactTemporaryDownloadUrls(item)]),
    );
    return value;
  }
  function toolResultForLog(value) {
    if (Array.isArray(value)) return value.map(toolResultForLog);
    if (!value || typeof value !== "object") return redactTemporaryDownloadUrls(value);
    const type = String(value.type || "");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && ((type === "image" && key === "data") || key === "blob"))
        return [key, `[binary payload omitted: ${item.length} base64 characters]`];
      return [key, toolResultForLog(item)];
    }));
  }

  function contextEnvelope(handle, extras = {}) {
    return { context_handle: String(handle || ""), ...extras };
  }
  function contextControlMessage(kind) {
    if (kind === "missing") return "context_handle is required. Call create_context, then repeat this tool call with the exact value returned.";
    if (kind === "expired") return "The context_handle has expired. Call create_context, then repeat the requested tool call.";
    if (kind === "invalid") return "The context_handle is invalid. Reuse a valid handle or call create_context.";
    return "";
  }
  function contextControlToolResult(p, name, args, resolution) {
    const handle = resolution.record?.handle || resolution.supplied_handle || "";
    const error = contextControlMessage(resolution.kind);
    const structuredContent = contextEnvelope(handle, { error });
    const id = beginLog(p, name, args, handle);
    const toolResult = {
      content: [{ type: "text", text: error }],
      structuredContent, isError: true,
    };
    updateLog(id, {
      completed_at: Date.now(), duration_ms: 0, status: "failed",
      resolved_json: JSON.stringify(structuredContent), stdout: error,
      result_json: JSON.stringify(toolResultForLog(toolResult)), error,
    });
    indexLog(id);
    return toolResult;
  }

  async function callTool(p, name, args, callInfo) {
    const id = beginLog(p, name, args, callInfo.contextHandle, callInfo.selection?.root), started = Date.now();
    const control = { log_id: id, cancel: null, kind: "", process_id: "", kernel_id: "" };
    activeCallControls.set(id, control);
    const executionState = {
      ...callInfo, logId: id,
      setCancel(cancel, metadata = {}) { control.cancel = cancel; Object.assign(control, metadata); },
    };
    try {
      if (!serverTools(p, true).some(tool => tool.name === name)) throw new Error("Unknown tool");
      updateLog(id, { status: "running" });
      const result = await executeTool(p, name, args, executionState);
      const { mcp_content: mcpContent, ...publicResult } = result && typeof result === "object" ? result : { value: result };
      const publicLogResult = redactTemporaryDownloadUrls(publicResult);
      const stdout = typeof publicLogResult.stdout === "string" ? publicLogResult.stdout : JSON.stringify(publicLogResult, null, 2);
      const stderr = typeof publicLogResult.stderr === "string" ? publicLogResult.stderr : "";
      const status = publicResult.success === false ? "failed" : "completed";
      const envelope = contextEnvelope(callInfo.contextHandle);
      const structuredContent = { ...publicResult, ...envelope };
      const full = typeof publicResult.content === "string"
        ? `${publicResult.content}\n\ncontext_handle: ${envelope.context_handle}`
        : JSON.stringify(structuredContent, null, 2);
      const max = 1024 * 1024, rendered = full.length > max
        ? full.slice(0, max) + `\n\n[truncated; full output in log ${id}]` : full;
      const content = Array.isArray(mcpContent)
        ? [...mcpContent, { type: "text", text: rendered }]
        : [{ type: "text", text: rendered }];
      const toolResult = { content, structuredContent, isError: status !== "completed" };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status,
        resolved_json: JSON.stringify(publicLogResult), stdout, stderr,
        result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      return toolResult;
    } catch (error) {
      const message = String(error?.stack || error);
      const envelope = contextEnvelope(callInfo.contextHandle);
      const structuredContent = { error: String(error?.message || error), ...envelope };
      const toolResult = {
        content: [{ type: "text", text: `${String(error?.message || error)}\ncontext_handle: ${envelope.context_handle}` }],
        structuredContent, isError: true,
      };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status: "failed",
        error: message, result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      return toolResult;
    } finally {
      activeCallControls.delete(id);
    }
  }

  // Authentication is the only tool-call boundary: valid OAuth or Basic credentials grant access.
  function localOrPrivateAddress(host = "") {
    host = String(host).replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const m = /^172\.(\d+)\./.exec(host);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return /^(fc|fd)/i.test(host) || /^fe80:/i.test(host);
  }

  function safeEqual(a, b) {
    const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  }
  async function authenticateRequest(req, p) {
    const authorization = req.headers.get("authorization") || "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer && p.oauth) {
      const hash = await sha256(bearer[1]);
      const token = one(`SELECT t.token_hash,t.client_id,COALESCE(c.name,'') client_name
        FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id=t.client_id
        WHERE t.token_hash=? AND t.server_id=? AND t.expires_at>?`, hash, p.id, Date.now());
      if (token) return { full: true, kind: "oauth", clientId: token.client_id || "", clientName: token.client_name || "" };
    }
    const basic = /^Basic\s+(.+)$/i.exec(authorization);
    if (basic && p.basic_enabled) {
      try {
        const decoded = Buffer.from(basic[1], "base64").toString("utf8"), colon = decoded.indexOf(":"),
          username = colon < 0 ? decoded : decoded.slice(0, colon), password = colon < 0 ? "" : decoded.slice(colon + 1),
          expected = openSecret(p.basic_secret_enc);
        if (expected && safeEqual(username, p.basic_username) && safeEqual(password, expected))
          return { full: true, kind: "basic", clientId: "", clientName: "Basic client" };
      } catch {}
    }
    return { full: false, kind: "anonymous", clientId: "", clientName: "" };
  }
  function authChallenge(p) {
    const schemes = [];
    if (p.oauth) schemes.push(`Bearer resource_metadata="${metadataUrl()}", scope="mcp"`);
    if (p.basic_enabled) schemes.push('Basic realm="MrMCP", charset="UTF-8"');
    return schemes.join(", ");
  }
  function allowRequest(remoteHost) {
    const now = Date.now(), key = String(remoteHost || "unknown"), windowMs = 60000, limit = 600;
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.started >= windowMs) bucket = { started: now, count: 0 };
    bucket.count++; rateBuckets.set(key, bucket);
    return bucket.count <= limit;
  }

  function validOrigin(req) {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return ["127.0.0.1", "localhost"].includes(u.hostname) || origin === new URL(publicBase()).origin;
    } catch { return false; }
  }

  const DEBUG_BODY_LIMIT = 262144;
  const sensitiveKey = key => /authorization|cookie|token|secret|password|code|verifier|basic/i.test(key);
  function redactObject(value, key = "") {
    if (sensitiveKey(key)) return "[REDACTED]";
    if (Array.isArray(value)) return value.map(x => redactObject(x));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactObject(v, k)])
    );
    return value;
  }
  function truncateDebug(value) {
    value = String(value ?? "");
    return value.length > DEBUG_BODY_LIMIT
      ? value.slice(0, DEBUG_BODY_LIMIT) + `\n[truncated ${value.length - DEBUG_BODY_LIMIT} characters]`
      : value;
  }
  function debugHeaders(headers) {
    return JSON.stringify(Object.fromEntries(
      [...headers.entries()].map(([k, v]) => [k, sensitiveKey(k) ? "[REDACTED]" : v])
    ), null, 2);
  }
  function debugUrl(raw) {
    const u = new URL(raw);
    if (u.pathname.startsWith("/download/")) {
      const parts = u.pathname.split("/");
      u.pathname = `/download/[REDACTED]/${parts.at(-1) || "file"}`;
    }
    for (const key of [...u.searchParams.keys()]) if (sensitiveKey(key)) u.searchParams.set(key, "[REDACTED]");
    return u.pathname + u.search;
  }
  async function debugBody(message) {
    const raw = await message.text();
    if (!raw) return "";
    const type = message.headers.get("content-type") || "";
    try {
      if (type.includes("json")) return truncateDebug(JSON.stringify(redactObject(JSON.parse(raw)), null, 2));
      if (type.includes("x-www-form-urlencoded")) {
        const q = new URLSearchParams(raw), out = {};
        for (const [k, v] of q) out[k] = sensitiveKey(k) ? "[REDACTED]" : v;
        return truncateDebug(JSON.stringify(out, null, 2));
      }
    } catch {}
    return truncateDebug(raw);
  }
  // Public request wrapper: metrics, rate limits, redacted diagnostics and headers.
  async function tracedMcp(req, info, transport) {
    run("UPDATE metrics SET value=value+1 WHERE name='requests'");
    const remoteHost = info?.remoteAddr?.hostname || "";
    if (!allowRequest(remoteHost)) return json({ error: "Too many requests" }, 429, { "retry-after": "60" });
    const debugEnabled = getCfg("debug_http_log", "0") === "1";
    const downloadRequest = new URL(req.url).pathname.startsWith("/download/");
    const started = Date.now(), requestCopy = debugEnabled ? req.clone() : null;
    let response, error = "";
    try { response = await mcpHandler(req, info, transport); }
    catch (e) {
      error = String(e?.stack || e);
      response = json({ error: String(e?.message || e) }, String(e?.message || e).includes("too large") ? 413 : 500);
    }
    if (debugEnabled) {
      let requestBody = "", responseBody = "";
      try {
        requestBody = await debugBody(requestCopy);
        responseBody = downloadRequest ? "[binary download body omitted]" : await debugBody(response.clone());
      } catch (e) { error += (error ? "\n" : "") + "Debug capture error: " + String(e?.stack || e); }
      const remote = info?.remoteAddr
        ? `${info.remoteAddr.hostname || ""}${info.remoteAddr.port != null ? ":" + info.remoteAddr.port : ""}` : "";
      run(`INSERT INTO debug_logs(ts,method,path,status,duration_ms,remote_addr,
        request_headers,request_body,response_headers,response_body,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        started, req.method, debugUrl(req.url), response.status, Date.now() - started, remote,
        debugHeaders(req.headers), requestBody, debugHeaders(response.headers), responseBody, error);
    }
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    return compressHttpResponse(req, new Response(response.body, {
      status: response.status, statusText: response.statusText, headers,
    }));
  }


  const oauthRedirectValid = value => {
    try {
      const u = new URL(String(value));
      return !u.username && !u.password && !u.hash &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)));
    } catch { return false; }
  };
  const chatGptRedirect = value => {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" && u.hostname === "chatgpt.com" &&
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname) &&
        !u.username && !u.password && !u.search && !u.hash;
    } catch { return false; }
  };
  function oauthAuthorizeContext(q, recoverChatGpt = false) {
    const responseType = q.get("response_type") || "";
    const clientId = q.get("client_id") || "";
    const redirect = q.get("redirect_uri") || "";
    const resource = q.get("resource") || "";
    const challenge = q.get("code_challenge") || "";
    const challengeMethod = q.get("code_challenge_method") || "";
    if (responseType !== "code") return { error: "unsupported response_type" };
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(clientId)) return { error: "invalid client_id" };
    if (!oauthRedirectValid(redirect)) return { error: "invalid redirect_uri" };
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || challengeMethod !== "S256")
      return { error: "PKCE S256 is required" };
    let resourceUrl;
    try { resourceUrl = new URL(resource); } catch { return { error: "invalid resource" }; }
    const p = serverConfig();
    if (!p?.oauth || resourceUrl.href !== mcpUrl())
      return { error: "resource is not the OAuth-enabled MrMCP endpoint" };
    const scope = q.get("scope") || "mcp";
    if (scope !== "mcp") return { error: "invalid scope" };

    let client = one("SELECT * FROM oauth_clients WHERE client_id=?", clientId);
    let redirects = client ? parseJson(client.redirects_json, []) : [];
    const mayRecover = recoverChatGpt && chatGptRedirect(redirect);
    if (!client && mayRecover) {
      run("INSERT OR IGNORE INTO oauth_clients(client_id,name,redirects_json,created_at) VALUES(?,?,?,?)",
        clientId, "ChatGPT", JSON.stringify([redirect]), Date.now());
      client = one("SELECT * FROM oauth_clients WHERE client_id=?", clientId);
      redirects = client ? parseJson(client.redirects_json, []) : [];
    } else if (client && !redirects.includes(redirect) && mayRecover) {
      redirects = [...new Set([...redirects, redirect])].slice(-20);
      run("UPDATE oauth_clients SET redirects_json=? WHERE client_id=?",
        JSON.stringify(redirects), clientId);
      client = one("SELECT * FROM oauth_clients WHERE client_id=?", clientId);
    }
    if (!client) return { error: "unknown client registration" };
    if (!redirects.includes(redirect)) return { error: "redirect_uri does not match client registration" };
    return { client, p, redirect, resource, scope, challenge };
  }
  const oauthError = reason => text(`Invalid OAuth request: ${reason}`, 400);

  // OAuth discovery/authorization and MCP 2026-07-28 routing.
  async function mcpHandler(req, info, transport = "http") {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/download/")) return await downloadResponse(req, u);
    if (u.pathname === "/.well-known/oauth-authorization-server" ||
        u.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: publicBase(),
        authorization_endpoint: `${publicBase()}/oauth/authorize`,
        token_endpoint: `${publicBase()}/oauth/token`,
        registration_endpoint: `${publicBase()}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: serverConfig()?.oauth ? ["mcp"] : [],
      });
    }
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
      const p = serverConfig();
      return json({
        resource: mcpUrl(),
        authorization_servers: p.oauth ? [publicBase()] : [],
        scopes_supported: p.oauth ? ["mcp"] : [],
        bearer_methods_supported: p.oauth ? ["header"] : [],
      });
    }
    if (u.pathname === "/oauth/register" && req.method === "POST") {
      maintenance();
      if ((one("SELECT COUNT(*) n FROM oauth_clients")?.n || 0) >= 5000)
        return json({ error: "temporarily_unavailable" }, 503, { "retry-after": "3600" });
      const x = await bodyJson(req), redirects = Array.isArray(x.redirect_uris)
        ? [...new Set(x.redirect_uris.map(String))].slice(0, 20) : [];
      if (!redirects.length || redirects.some(r => r.length > 2048 || !oauthRedirectValid(r)))
        return json({ error: "invalid_redirect_uri" }, 400);
      const clientId = randomToken(18), issuedAt = Math.floor(Date.now() / 1000);
      run("INSERT INTO oauth_clients(client_id,name,redirects_json,created_at) VALUES(?,?,?,?)",
        clientId, x.client_name || "MCP client", JSON.stringify(redirects), issuedAt * 1000);
      return json({
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: x.client_name || "MCP client",
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }, 201);
    }
    if (u.pathname === "/oauth/authorize" && req.method === "GET") {
      maintenance();
      const q = u.searchParams, auth = oauthAuthorizeContext(q, true);
      if (auth.error) return oauthError(auth.error);
      const consentToken = randomToken(24);
      oauthConsents.set(consentToken, {
        expires_at: Date.now() + 300000,
        client_id: auth.client.client_id,
        redirect_uri: auth.redirect,
        resource: auth.resource,
        scope: auth.scope,
        code_challenge: auth.challenge,
      });
      const hidden = [...q.entries(), ["consent_token", consentToken]].map(([k, v]) =>
        `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`).join("");
      return text(`<!doctype html><meta charset=utf-8><title>Authorize MrMCP</title>
<style>body{font:16px system-ui;max-width:560px;margin:70px auto;background:#111;color:#eee}
.card{background:#1c1c1c;padding:28px;border-radius:12px}button{padding:10px 18px;margin-right:8px}</style>
<div class=card><h2>Authorize ${htmlEscape(auth.client.name)}</h2>
<p>Allow access to the MrMCP server?</p>
<p><code>${htmlEscape(auth.resource)}</code></p>
<form method=post action=/oauth/authorize>${hidden}<button name=decision value=approve>Approve</button>
<button name=decision value=deny>Deny</button></form></div>`, 200, "text/html; charset=utf-8");
    }
    if (u.pathname === "/oauth/authorize" && req.method === "POST") {
      maintenance();
      const q = await form(req), consentToken = q.get("consent_token") || "";
      const consent = oauthConsents.get(consentToken);
      oauthConsents.delete(consentToken);
      const auth = oauthAuthorizeContext(q, true);
      if (auth.error) return oauthError(auth.error);
      if (!consent || consent.expires_at < Date.now() ||
          consent.client_id !== auth.client.client_id ||
          consent.redirect_uri !== auth.redirect ||
          consent.resource !== auth.resource ||
          consent.scope !== auth.scope ||
          consent.code_challenge !== auth.challenge)
        return oauthError("invalid or expired consent");
      const out = new URL(auth.redirect);
      if (q.get("decision") !== "approve") {
        out.searchParams.set("error", "access_denied");
      } else {
        const code = randomToken(24);
        run(`INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,server_id,resource,scope,expires_at)
          VALUES(?,?,?,?,?,?,?,?)`, await sha256(code), auth.client.client_id, auth.redirect, auth.challenge,
          auth.p.id, auth.resource, auth.scope, Date.now() + 300000);
        out.searchParams.set("code", code);
      }
      if (q.get("state")) out.searchParams.set("state", q.get("state"));
      out.searchParams.set("iss", publicBase());
      return new Response(null, { status: 302, headers: { location: out.href } });
    }
    if (u.pathname === "/oauth/token" && req.method === "POST") {
      const q = await form(req), grantType = q.get("grant_type") || "", now = Date.now();
      if (grantType === "authorization_code") {
        const codeHash = await sha256(q.get("code") || "");
        const c = one("SELECT * FROM oauth_codes WHERE code_hash=?", codeHash);
        const tokenConfig = c ? one("SELECT oauth FROM server_config WHERE id=?", c.server_id) : null;
        const tokenResource = q.get("resource") || "";
        if (!c || !tokenConfig?.oauth || c.expires_at < now ||
            c.client_id !== q.get("client_id") || c.redirect_uri !== q.get("redirect_uri") ||
            (tokenResource && tokenResource !== c.resource) ||
            await sha256(q.get("code_verifier") || "") !== c.code_challenge)
          return json({ error: "invalid_grant" }, 400);
        run("DELETE FROM oauth_codes WHERE code_hash=?", codeHash);
        const accessToken = randomToken(32), refreshToken = randomToken(48);
        run("INSERT INTO oauth_tokens(token_hash,client_id,server_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
          await sha256(accessToken), c.client_id, c.server_id, c.scope, now,
          now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
        run(`INSERT INTO oauth_refresh_tokens(token_hash,client_id,server_id,resource,scope,created_at,last_used_at)
          VALUES(?,?,?,?,?,?,?)`, await sha256(refreshToken), c.client_id, c.server_id, c.resource, c.scope, now, now);
        return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer",
          expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scope: c.scope });
      }
      if (grantType === "refresh_token") {
        const suppliedRefreshToken = q.get("refresh_token") || "";
        const refreshHash = await sha256(suppliedRefreshToken);
        const r = one("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?", refreshHash);
        const tokenConfig = r ? one("SELECT oauth FROM server_config WHERE id=?", r.server_id) : null;
        const tokenResource = q.get("resource") || "";
        const requestedClientId = q.get("client_id") || r?.client_id || "";
        if (!r || !tokenConfig?.oauth || r.client_id !== requestedClientId ||
            (tokenResource && tokenResource !== r.resource))
          return json({ error: "invalid_grant" }, 400);
        const accessToken = randomToken(32);
        run("UPDATE oauth_refresh_tokens SET last_used_at=? WHERE token_hash=?", now, refreshHash);
        run("INSERT INTO oauth_tokens(token_hash,client_id,server_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
          await sha256(accessToken), r.client_id, r.server_id, r.scope, now,
          now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
        return json({ access_token: accessToken, refresh_token: suppliedRefreshToken, token_type: "Bearer",
          expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scope: r.scope });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    if (u.pathname !== "/mcp") return json({ error: "Not found" }, 404);
    if (!validOrigin(req)) return json({ error: "Invalid Origin" }, 403);
    const p = serverConfig();
    if (!p) return json({ error: "MrMCP configuration is missing" }, 500);
    if (req.method !== "POST") return json({ error: "Streamable HTTP accepts POST here" }, 405, { allow: "POST" });
    const remoteHost = info?.remoteAddr?.hostname || "";
    const remoteRequest = !localOrPrivateAddress(remoteHost);
    if (transport === "http" && remoteRequest && mcpTlsActive)
      return json({ error: "Use HTTPS" }, 426, { location: `${automaticExternalBase()}/mcp` });
    const auth = await authenticateRequest(req, p);
    if (remoteRequest && !auth.full && (p.oauth || p.basic_enabled)) return json({ error: "unauthorized" }, 401, {
      "www-authenticate": authChallenge(p),
    });
    const fullAccess = auth.full;
    let x;
    try {
      x = await bodyJson(req);
    } catch {
      return json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }, 400);
    }
    if (Array.isArray(x)) return json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests unsupported" },
    }, 400);
    if (!x || x.jsonrpc !== "2.0" || typeof x.method !== "string") return json({
      jsonrpc: "2.0",
      id: x?.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    }, 400);

    const requestMeta = x.params?._meta && typeof x.params._meta === "object"
      ? x.params._meta : {};
    const bodyProtocol = String(requestMeta["io.modelcontextprotocol/protocolVersion"] || "");
    const headerProtocol = String(req.headers.get("mcp-protocol-version") || "");
    const headerMethod = String(req.headers.get("mcp-method") || "");
    const modernRequest = headerProtocol === MCP_MODERN_PROTOCOL ||
      bodyProtocol === MCP_MODERN_PROTOCOL || x.method === "server/discover";
    const observedProtocol = headerProtocol || bodyProtocol ||
      (x.method === "server/discover" ? MCP_MODERN_PROTOCOL : "");
    const rpcError = (status, code, message, data = undefined) => json({
      jsonrpc: "2.0",
      id: x.id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }, status, {
      "cache-control": "no-store",
      ...(headerProtocol ? { "mcp-protocol-version": headerProtocol } : {}),
    });
    const rejectParsedToolCall = (message, rule = "protocol validation") => {
      if (x.method !== "tools/call") return "";
      const toolName = typeof x.params?.name === "string" && x.params.name
        ? x.params.name : "(invalid tools/call)";
      return rejectToolCall(p, toolName, x.params?.arguments || x.params || {}, message, String(x.params?.arguments?.context_handle || ""));
    };

    if (!modernRequest) {
      rejectParsedToolCall("MCP protocol 2026-07-28 metadata is required");
      return rpcError(200, -32022, "Unsupported or missing MCP protocol version", {
        supported: MCP_PROTOCOLS,
        requested: headerProtocol || bodyProtocol || "missing",
      });
    }
    {
      const effectiveProtocol = headerProtocol || bodyProtocol || MCP_MODERN_PROTOCOL;
      if (headerProtocol && bodyProtocol && headerProtocol !== bodyProtocol) {
        rejectParsedToolCall("MCP header and body metadata do not match");
        return rpcError(200, -32020, "MCP header and body metadata do not match", {
          headerProtocol,
          bodyProtocol,
        });
      }
      if (headerMethod && headerMethod !== x.method) {
        rejectParsedToolCall("Mcp-Method header does not match the JSON-RPC method");
        return rpcError(200, -32020, "Mcp-Method header does not match the JSON-RPC method", {
          headerMethod,
          bodyMethod: x.method,
        });
      }
      if (effectiveProtocol !== MCP_MODERN_PROTOCOL) {
        rejectParsedToolCall(`Unsupported protocol version: ${effectiveProtocol || "missing"}`);
        return rpcError(200, -32022, "Unsupported protocol version", {
          supported: MCP_PROTOCOLS,
          requested: effectiveProtocol,
        });
      }
      if (x.method === "tools/call" || x.method === "resources/read") {
        const headerName = String(req.headers.get("mcp-name") || "");
        const bodyName = String(x.method === "tools/call" ? x.params?.name : x.params?.uri || "");
        if (headerName && headerName !== bodyName) {
          rejectParsedToolCall("Mcp-Name header does not match the request body");
          return rpcError(200, -32020, "Mcp-Name header does not match the request body", {
            headerName,
            bodyName,
          });
        }
      }
    }

    if (x.id == null) {
      rejectParsedToolCall("tools/call notifications are not executed", "request validation");
      return new Response(null, { status: 202 });
    }

    const serverInfoMeta = {
      "io.modelcontextprotocol/serverInfo": {
        name: "MrMCP",
        version: VERSION,
      },
    };
    const instructions = fullAccess
      ? "Call create_context once, then call context_info and pass the exact context_handle unchanged on every later tool call. " +
        "context_info returns the current absolute root and agent_guidance_path; when that path is non-null, read and follow the referenced AGENTS.md before repository work. Call context_info again after the operator changes the Session root. " +
        "Use read_file/read_files, glob, grep, edit and replace directly for file inspection, discovery, search and textual changes; do not spawn shell commands, uv or Python for operations those tools cover. " +
        "Use list_commands before other command-line work and invoke returned logical_name values directly through exec.program without PATH probes. " +
        "Every authenticated client can invoke every published tool; context_handle is the bearer capability selecting persistent context state."
      : "The MrMCP endpoint is reachable, but anonymous access exposes no tools. Authenticate with OAuth or Basic authentication.";

    const r = { jsonrpc: "2.0", id: x.id };
    let responseStatus = 200;
    const responseProtocol = MCP_MODERN_PROTOCOL;

    try {
      if (x.method === "server/discover") {
        r.result = {
          resultType: "complete",
          supportedVersions: MCP_PROTOCOLS,
          capabilities: serverCapabilities(fullAccess),
          _meta: serverInfoMeta,
          instructions,
          ttlMs: 300000,
          cacheScope: "private",
        };
      } else if (x.method === "ping") {
        r.result = { resultType: "complete", _meta: serverInfoMeta };
      } else if (x.method === "tools/list") {
        const tools = serverTools(p, fullAccess);
        r.result = {
          resultType: "complete", tools, ttlMs: 300000,
          cacheScope: "private", _meta: serverInfoMeta,
        };
      } else if (x.method === "resources/list") {
        const resources = fullAccess ? [filePreviewResource()] : [];
        r.result = {
          resultType: "complete", resources, ttlMs: 300000,
          cacheScope: "private", _meta: serverInfoMeta,
        };
      } else if (x.method === "resources/read") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for resource access" };
          responseStatus = 403;
        } else if (String(x.params?.uri || "") !== FILE_PREVIEW_UI_URI) {
          r.error = { code: -32002, message: `Resource not found: ${String(x.params?.uri || "")}` };
          responseStatus = 200;
        } else {
          const resourceResult = {
            contents: [{
              uri: FILE_PREVIEW_UI_URI,
              mimeType: MCP_UI_MIME_TYPE,
              text: filePreviewAppHtml(),
              _meta: filePreviewUiMeta(),
            }],
          };
          r.result = modernRequest
            ? { resultType: "complete", ...resourceResult, _meta: serverInfoMeta }
            : resourceResult;
        }
      } else if (x.method === "tools/call") {
        if (!fullAccess) {
          const toolName = typeof x.params?.name === "string" && x.params.name
            ? x.params.name : "(invalid tools/call)";
          const logId = rejectToolCall(
            p, toolName, x.params?.arguments || x.params || {},
            "Authentication required for tool execution", String(x.params?.arguments?.context_handle || ""),
          );
          r.error = {
            code: -32001, message: "Authentication required for tool execution",
          };
          responseStatus = 403;
        } else if (!x.params?.name || typeof x.params.name !== "string") {
          const logId = rejectToolCall(
            p, "(invalid tools/call)", x.params || {},
            "tools/call requires params.name", String(x.params?.arguments?.context_handle || ""),
          );
          r.error = {
            code: -32602, message: "tools/call requires params.name",
          };
        } else {
          const toolArgs = { ...(x.params?.arguments || {}) };
          let toolResult;
          if (x.params.name === "create_context") {
            delete toolArgs.context_handle;
            const record = createContext(p, observedProtocol, {
              auth_kind: auth.kind,
              oauth_client_id: auth.clientId || "",
              client_name: auth.clientName || "",
              user_agent: req.headers.get("user-agent") || "",
            });
            const selection = { context: record, root: selectedContextRoot(p, record) };
            toolResult = await callTool(
              p, x.params.name, toolArgs,
              { authKind: auth.kind, contextHandle: record.handle, selection },
            );
          } else {
            const resolution = resolveContext(p, toolArgs.context_handle, observedProtocol);
            if (resolution.kind === "active") {
              const selection = { context: resolution.record, root: selectedContextRoot(p, resolution.record) };
              toolResult = await callTool(
                p, x.params.name, toolArgs,
                { authKind: auth.kind, contextHandle: resolution.record.handle, selection },
              );
            } else toolResult = contextControlToolResult(p, x.params.name, toolArgs, resolution);
          }
          r.result = modernRequest
            ? {
                resultType: "complete",
                ...toolResult,
                _meta: serverInfoMeta,
              }
            : toolResult;
        }
      } else {
        r.error = { code: -32601, message: `Method not found: ${x.method}` };
      }
    } catch (e) {
      r.error = { code: -32603, message: String(e?.message || e) };
    }

    return json(r, responseStatus, {
      "cache-control": "no-store",
      "mcp-protocol-version": responseProtocol,
    });
  }

  const hasSession = req => (req.headers.get("cookie") || "").split(/;\s*/)
    .some(x => x === `mrmcp_session=${SESSION}`);
  const requireApi = req => hasSession(req) && (req.method === "GET" || req.headers.get("x-mrmcp-csrf") === CSRF);
  function serverBasicUrl(p) {
    if (!p.basic_enabled) return "";
    const password = openSecret(p.basic_secret_enc);
    if (!password) return "";
    try {
      const url = new URL(mcpUrl());
      url.username = p.basic_username || "mrmcp";
      url.password = password;
      return url.href;
    } catch { return ""; }
  }
  // Local GUI receives a safe administrative state projection.
  const settingsProjection = () => {
    const currentIp = getCfg("public_ip", "").trim(), currentSslip = sslipHostname(currentIp),
      directHttps = directIpBase(), automaticSslipHttps = sslipBase();
    return {
      mcp_host: PUBLIC_HOST,
      mcp_port: HTTPS_PORT,
      mcp_http_enabled: true, mcp_http_port: HTTP_PORT, mcp_http_active: mcpHttpActive,
      mcp_http_role: "acme-only",
      mcp_https_enabled: true, mcp_https_port: HTTPS_PORT, mcp_https_active: mcpTlsActive,
      debug_http_log: getCfg("debug_http_log", "0") === "1",
      inherit_system_path: getCfg("inherit_system_path", "1") === "1",
      external_url: getCfg("external_url", ""), gui_url: `http://127.0.0.1:${GUI_PORT}/`,
      public_ip: currentIp, public_ip_checked_at: Number(getCfg("public_ip_checked_at", "0")),
      sslip_hostname: currentSslip, sslip_http_base_url: "",
      sslip_https_base_url: mcpTlsActive ? automaticSslipHttps : "", sslip_certificate_ready: sslipCertificateReady(),
      direct_ip_http_base_url: "", direct_ip_https_base_url: mcpTlsActive ? directHttps : "",
      public_ip_urls: parseJson(getCfg("public_ip_urls_json", "[]"), []),
      sslip_suffix: getCfg("sslip_suffix", "sslip.io"),
      acme_directory_url: getCfg("acme_directory_url", "https://acme-v02.api.letsencrypt.org/directory"),
      bin_directory: BIN_DIR,
      tls_mode: "letsencrypt", tls_cert_ip: getCfg("tls_cert_ip", ""),
      tls_cert_sslip: getCfg("tls_cert_sslip", ""), tls_email: getCfg("tls_email", "mrmcp@mrmcp.com"),
      tls_auto_renew: true, tls_cert_expires: getCfg("tls_cert_expires", ""),
      tls_cert_not_before: getCfg("tls_cert_not_before", ""),
      tls_cert_environment: getCfg("tls_cert_environment", ""),
      tls_last_error: getCfg("tls_last_error", ""), tls_last_issued_at: Number(getCfg("tls_last_issued_at", "0")),
      tls_last_request_at: Number(getCfg("tls_last_request_at", "0")),
      tls_last_request_status: getCfg("tls_last_request_status", ""),
      tls_last_request_valid: getCfg("tls_last_request_valid", "0") === "1",
      tls_next_attempt_at: Number(getCfg("tls_next_attempt_at", "0")),
      tls_rate_limit_reset_at: Number(getCfg("tls_rate_limit_reset_at", "0")),
      tls_renewal_due_at: Number(getCfg("tls_renewal_due_at", "0")),
      tls_active: mcpTlsActive, tls_active_kind: mcpTlsKind,
      tls_active_valid: mcpTlsValid, tls_active_trusted: mcpTlsTrusted,
      tls_active_expires: mcpTlsInfo?.expiresAt || "",
      tls_active_subject: mcpTlsInfo?.subject || "", tls_active_issuer: mcpTlsInfo?.issuer || "",
      mcp_listen_error: mcpListenError,
      local_base_url: localBase(), local_http_base_url: "",
      local_https_base_url: mcpTlsActive ? localHttpsBase() : "",
      external_base_url: getCfg("external_url", "").replace(/\/+$/, "") || automaticExternalBase(),
      data_dir: DATA, database: DB_PATH,
    };
  };

  const rootsProjection = serverId => all("SELECT * FROM roots WHERE server_id=? ORDER BY id", serverId);

  const contextProjection = (serverId, roots = rootsProjection(serverId), oauthClientId = "") => {
    const oauthFilter = String(oauthClientId || "");
    const rows = all(`SELECT c.id,c.handle,c.label,c.root_id,c.created_at,c.updated_at,c.last_active_at,c.protocol_version,c.auth_kind,c.oauth_client_id,c.client_name,c.user_agent,
        (SELECT COUNT(*) FROM logs l WHERE l.context_id=c.id) tool_calls
      FROM contexts c WHERE c.server_id=? AND c.handle LIKE 'ctx_%' ${oauthFilter ? "AND c.oauth_client_id=?" : ""}
      ORDER BY c.last_active_at DESC,c.created_at DESC LIMIT 500`,
      ...(oauthFilter ? [serverId, oauthFilter] : [serverId]));
    return rows.map(context => {
      const selected = Number(context.root_id || 0);
      const root = selected ? roots.find(item => item.id === selected && item.enabled) : null;
      return {
        ...context,
        id: context.id,
        pk: context.id,
        context_handle: context.handle,
        kind: "context_handle",
        display_label: `#${context.id}`,
        expired: contextExpired(context),
        expires_at: Number(context.last_active_at || context.created_at || 0) + CONTEXT_TTL_MS,
        effective_root: root?.name || "Program folder",
        effective_root_path: root?.path || APP_DIR,
        root_id: root?.id || 0,
        fallback_root: !root,
        available_roots: roots.filter(item => item.enabled)
          .map(item => ({ id: item.id, name: item.name, selected: item.id === root?.id })),
      };
    });
  };

  const oauthProjection = () => all(`SELECT c.*,
      (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id=c.client_id) token_count,
      (SELECT COUNT(*) FROM oauth_refresh_tokens r WHERE r.client_id=c.client_id) refresh_token_count,
      (SELECT COUNT(*) FROM contexts x WHERE x.oauth_client_id=c.client_id) session_count
      FROM oauth_clients c ORDER BY c.created_at DESC`);

  const serverProjection = p => {
    const directHttps = directIpBase(), automaticSslipHttps = sslipBase();
    return {
      id: p.id,
      name: "MrMCP",
      oauth: p.oauth,
      basic_enabled: p.basic_enabled,
      tool_count: serverTools(p, true).length,
      tool_names: serverTools(p, true).map(tool => tool.name),
      basic_url: serverBasicUrl(p),
      mcp_url: mcpUrl(), metadata_url: metadataUrl(),
      local_https_mcp_url: mcpTlsActive ? `${localHttpsBase()}/mcp` : "",
      direct_ip_https_mcp_url: mcpTlsActive && directHttps ? `${directHttps}/mcp` : "",
      sslip_https_mcp_url: mcpTlsActive && automaticSslipHttps ? `${automaticSslipHttps}/mcp` : "",
      sslip_metadata_url: mcpTlsActive && automaticSslipHttps
        ? `${automaticSslipHttps}/.well-known/oauth-protected-resource/mcp` : "",
      fallback_root_path: APP_DIR,
      protocol_versions: MCP_PROTOCOLS,
      context_ttl_days: Math.round(CONTEXT_TTL_MS / 86400000),
    };
  };

  // The UI asks for only the active section. Database projections are evaluated lazily so
  // inactive pages do not query their tables during Eta -> Morphlex rerenders.
  const state = (section = "all") => {
    const valid = new Set(["all", "dashboard", "sessions", "logs", "roots", "commands", "debug", "oauth", "settings", "help"]);
    section = valid.has(section) ? section : "dashboard";
    const p = serverConfig();
    if (!p) throw new Error("MrMCP server configuration is missing");
    const result = { version: VERSION, settings: settingsProjection(), mcp_protocols: MCP_PROTOCOLS };
    let roots;
    if (["all", "sessions", "roots"].includes(section)) {
      roots = rootsProjection(p.id);
      result.roots = roots;
    }
    if (["all", "sessions", "logs"].includes(section)) {
      roots ||= rootsProjection(p.id);
      result.context_values = contextProjection(p.id, roots, section === "sessions" ? uiState.sessions.oauthClientId : "");
    }
    if (["all", "dashboard"].includes(section)) {
      result.server = serverProjection(p);
      result.stats = {
        context_values: one("SELECT COUNT(*) n FROM contexts WHERE server_id=? AND handle LIKE 'ctx_%'", p.id)?.n || 0,
        roots: one("SELECT COUNT(*) n FROM roots WHERE server_id=? AND enabled=1", p.id)?.n || 0,
        logs: one("SELECT COUNT(*) n FROM logs")?.n || 0,
        failures: one("SELECT COUNT(*) n FROM logs WHERE status='failed'")?.n || 0,
        total_requests: one("SELECT value n FROM metrics WHERE name='requests'")?.n || 0,
      };
    }
    if (["all", "oauth"].includes(section)) result.oauth_clients = oauthProjection();
    return result;
  };

  async function restartMcp() {
    await Promise.allSettled([mcpHttpServer?.shutdown(), mcpHttpsServer?.shutdown()]);
    mcpHttpServer = mcpHttpsServer = undefined;
    mcpHttpActive = mcpTlsActive = mcpTlsValid = mcpTlsTrusted = false;
    mcpTlsKind = "none";
    mcpTlsInfo = null;
    mcpListenError = "";
    const errors = [];

    try {
      mcpHttpServer = Deno.serve(
        { hostname: PUBLIC_HOST, port: HTTP_PORT, onListen() {} },
        req => {
          const token = req.method === "GET"
            ? new URL(req.url).pathname.match(/^\/\.well-known\/acme-challenge\/([^/]+)$/)?.[1]
            : "";
          return token && acmeChallenges.has(token)
            ? text(acmeChallenges.get(token), 200, "text/plain; charset=utf-8", {
                "cache-control": "no-store",
              })
            : text("Not found", 404, "text/plain; charset=utf-8", {
                "cache-control": "no-store",
              });
        },
      );
      mcpHttpActive = true;
    } catch (error) {
      errors.push(`ACME HTTP listener 0.0.0.0:80: ${String(error?.message || error)}`);
    }

    try {
      const material = await selectTlsMaterial();
      mcpHttpsServer = Deno.serve(
        {
          hostname: PUBLIC_HOST, port: HTTPS_PORT,
          cert: material.certificate, key: material.key, onListen() {},
        },
        (req, info) => tracedMcp(req, info, "https"),
      );
      mcpTlsActive = true;
      mcpTlsKind = material.kind;
      mcpTlsValid = material.valid;
      mcpTlsTrusted = material.trusted;
      mcpTlsInfo = material;
    } catch (error) {
      errors.push(`MCP HTTPS listener 0.0.0.0:443: ${String(error?.message || error)}`);
    }

    mcpListenError = errors.join("\n");
    if (mcpListenError) setCfg("tls_last_error", [
      getCfg("tls_last_error", ""), mcpListenError,
    ].filter(Boolean).join("\n"));
    emitUiChange(["dashboard", "settings", "help", "tls", "endpoints"], "listeners");
  }

  const eta = new Eta({ tags: ["<?", "?>"], autoEscape: true, cache: true });
  const fragmentTemplates = {
    sidebar: `<? const current=it.data?.state?.currentSection||"dashboard",items=[["dashboard","🏠","Dashboard"],["oauth","🔐","OAuth clients"],["sessions","💬","Sessions"],["logs","📜","Tool calls"],["roots","📁","Roots"],["commands","🧰","Commands"],["debug","🐞","HTTP debug"],["settings","⚙️","Settings"],["help","❓","Help"]]; items.forEach(([id,icon,label])=>{ ?><button data-page="<?= id ?>" class="<?= current===id?'nav-active':'' ?>"<?= current===id?' aria-current=page':'' ?>><span class=menu-icon><?= icon ?></span><?= label ?></button><? }) ?>`,
    view: `<? const s=it.data?.state||{},section=s.currentSection||"dashboard",settings=s.settings||{}; ?>
<? if(section==="dashboard"){ ?><section id=dashboard class=page><div class=row><h2 class=grow>🏠 Dashboard</h2><span class=muted>One server · one endpoint · explicit context capabilities</span></div><div id=cards class=grid></div><div class=dashboard-grid><div><h3>🌐 Server</h3><div id=endpoints></div></div><div><h3>🔒 TLS and connectivity</h3><div id=tlsStatus></div></div></div></section>
<? } else if(section==="sessions"){ ?><section id=sessions class=page><div class=row><h2 class=grow>💬 Sessions</h2><span class=muted>Live updates</span></div><p class=muted>Each session is a persistent MCP context with one current root. The same root may be shared by multiple sessions, and changing this selection affects new tool calls immediately.</p><? if(s.sessions?.oauthClientId){ ?><div class=row><span class=muted>OAuth filter</span><code><?= s.sessions.oauthClientId ?></code><button class=small data-action=clear-session-oauth>✕ Clear</button></div><? } ?><div class=card><b>Client continuity</b><p class=muted>MCP does not reliably expose the ChatGPT model or thinking level. Client name, authentication type and User-Agent are best-effort metadata captured when the context is created. Changing model or thinking level in the same ChatGPT conversation may cause ChatGPT to create a new MCP context, so reuse of the same Session is not guaranteed.</p></div><div id=contextList></div></section>
<? } else if(section==="roots"){ ?><section id=roots class=page><div class=row><h2 class=grow>📁 Roots</h2><button class=primary data-action=new-root>➕ Add root</button></div><p class=muted>Register a logical name and an existing directory path. Tool paths are relative to the root selected for the supplied <code>context_handle</code> value. Values without an explicit selection use the program folder.</p><div id=rootList></div></section>
<? } else if(section==="commands"){ const c=s.commands||{}; ?><section id=commands class=page><div class=row><h2 class=grow>🧰 Extra commands</h2><button data-action=download-all-commands>⬇️ Download all</button><button class=primary data-action=new-command>➕ Register command</button></div><p class=muted>Metadata is stored in <code>commands.yaml</code> in the program folder. Executable files directly in <code>.mrmcp/bin</code> also appear automatically.</p><div class=row><input id=commandQuery class=grow placeholder="Search name, path or description…" value="<?= c.query||'' ?>"><label class=small><input id=commandIncludeMissing type=checkbox<?= c.includeMissing!==false?' checked':'' ?>> show unavailable</label><select id=commandPageSize><? [10,25,50,100].forEach(n=>{ ?><option<?= Number(c.pageSize||25)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=load-commands>🔎 Search</button></div><div id=commandList></div></section>
<? } else if(section==="logs"){ const l=s.logs||{}; ?><section id=logs class=page><h2>📜 MCP tool calls</h2><p class=muted>Click a row to inspect input/output JSON. Active calls and linked managed processes can be terminated from the Actions column.</p><div class=row><input id=logQuery class=grow placeholder="Search input, output, stderr, errors…" value="<?= l.query||'' ?>"><select id=logContext><option value="">All sessions</option><? (s.contextValues||[]).forEach(v=>{ ?><option value="<?= v.pk ?>"<?= String(l.context||"")===String(v.pk)?" selected":"" ?>>#<?= v.pk ?></option><? }) ?></select><select id=logStatus><option value="">All states</option><? ['completed','failed','running'].forEach(v=>{ ?><option<?= l.status===v?' selected':'' ?>><?= v ?></option><? }) ?></select><select id=logPageSize><? [10,25,50,100].forEach(n=>{ ?><option<?= Number(l.pageSize||25)===n?' selected':'' ?>><?= n ?></option><? }) ?></select></div><? if(l.selfTest){ ?><div id=logSelfTest class=card><div class=row><h3 class=grow>🧪 MCP self-test</h3><button class=small data-action=copy-detail data-target=logDetail>📋 Copy JSON</button><button class=small data-action=close-self-test>✕ Close</button></div><pre id=logDetail><?= it.pretty(l.selfTest) ?></pre></div><? } ?><div id=logList></div></section>
<? } else if(section==="debug"){ const d=s.debug||{}; ?><section id=debug class=page><div class=row><h2 class=grow>🐞 HTTP debug log</h2><label class=small style="margin:0"><input id=debugHttpLog type=checkbox<?= s.debug?.enabled?" checked":"" ?>> enabled</label><button data-action=save-debug-settings>✅ Apply</button><button class=danger data-action=clear-debug>🗑️ Clear</button></div><p class=muted>Disabled by default. Authorization, cookies, tokens, codes and secrets are redacted when enabled. Click a row to open or close its JSON directly below it.</p><div class=row><input id=debugQuery class=grow placeholder="Search URL, headers, body or errors…" value="<?= d.query||'' ?>"><select id=debugMethod><option value="">All methods</option><? ['GET','POST','OPTIONS'].forEach(v=>{ ?><option<?= d.method===v?' selected':'' ?>><?= v ?></option><? }) ?></select><input id=debugStatus type=number placeholder="Status" value="<?= d.status||'' ?>"><button data-action=load-debug>🔎 Search</button></div><div id=debugList></div></section>
<? } else if(section==="oauth"){ ?><section id=oauth class=page><h2>🔐 OAuth clients</h2><div id=oauthList></div></section>
<? } else if(section==="settings"){ ?><section id=settings class=page><h2>⚙️ Settings</h2><div class=grid><div class=card><h3>🌐 Fixed listeners</h3><p><b>HTTP</b> <code>0.0.0.0:80</code> · ACME HTTP-01 only</p><p><b>HTTPS</b> <code>0.0.0.0:443</code> · MCP, OAuth and metadata</p><p><b>GUI</b> <code>http://127.0.0.1:${GUI_PORT}</code> · embedded WebView / browser</p><label>Public IPv4</label><div class=row><input id=publicIp readonly class=grow value="<?= settings.public_ip||'' ?>"><button data-action=detect-ip>🔎 Detect</button></div><label>Public base URL override</label><input id=externalUrl class=grow placeholder="https://mcp.example.com" value="<?= settings.external_url||'' ?>"><label>Public IPv4 lookup URLs (one per line)</label><textarea id=publicIpUrls><?= (settings.public_ip_urls||[]).join("\\n") ?></textarea><label>Automatic DNS suffix</label><input id=sslipSuffix placeholder="sslip.io" value="<?= settings.sslip_suffix||'sslip.io' ?>"><label>ACME directory URL</label><input id=acmeDirectoryUrl class=grow value="<?= settings.acme_directory_url||'' ?>"></div><div class=card><h3>🔒 Certificate</h3><label>Let's Encrypt email</label><input id=tlsEmail type=email value="<?= settings.tls_email||'' ?>"><div class=row><button data-action=issue-cert>🛡️ Check / request certificate</button></div><p class=muted>A valid certificate already present in .mrmcp is reused. Requests occur only when renewal is due and backoff permits them.</p></div><div class=card><h3>🖥️ Process environment</h3><label><input id=inheritSystemPath type=checkbox<?= settings.inherit_system_path?" checked":"" ?>> Include the system PATH in spawned processes and commands</label><p class=muted>When disabled, the child PATH contains only <code>.mrmcp/bin</code>. Other environment variables remain available.</p></div></div><p><button class=primary data-action=save-settings>💾 Save settings</button></p></section>
<? } else if(section==="help"){ ?><section id=help class=page><h2>❓ Help</h2><div class=card><h3>Connect ChatGPT Web</h3><ol><li>Make sure the Dashboard shows a trusted HTTPS certificate. ChatGPT needs a remote HTTPS MCP endpoint; use <code><?= settings.external_base_url ? settings.external_base_url + "/mcp" : "https://your-host/mcp" ?></code>.</li><li>In ChatGPT Web, enable Developer mode. In managed workspaces the current path is <b>Workspace settings → Permissions &amp; Roles → Connected Data Developer mode / Create custom MCP connectors</b>. Authorized users may also find the toggle under <b>Settings → Apps → Advanced Settings</b>.</li><li>Create a custom app from <b>Workspace settings → Apps → Create</b> or <b>Settings → Apps → Create</b>, enter the MrMCP endpoint, choose the offered authentication method, then select <b>Scan Tools</b>.</li><li>If OAuth is enabled in MrMCP, complete the authorization prompt. After the tool scan completes, create the app and select it from a new ChatGPT conversation.</li></ol></div><div class=card><h3>Authentication</h3><p>For ChatGPT, OAuth is the preferred MrMCP setup because ChatGPT can discover the authorization metadata, complete consent, and keep refresh-token connectivity. MrMCP also supports Basic authentication for MCP clients that offer it. Authentication grants access to the server; the <code>context_handle</code> selects persistent context state after authentication.</p></div><div class=card><h3>Write access</h3><p>MrMCP does not maintain a separate read/write allowlist: every authenticated client receives every published tool. ChatGPT controls whether write/modify actions are usable through the app's permissions and action controls. As of this build, OpenAI documents full MCP write/modify support for Business, Enterprise and Edu; Pro custom MCP access is limited to read/fetch, and availability may change. Test write tools in Developer mode first. Where available, use <b>Workspace settings → Apps → Configure Actions / Action control</b> to enable the required actions. ChatGPT may still ask for confirmation before a write.</p></div><div class=card><h3>Using MrMCP in a chat</h3><ol><li>Start a new chat and select the MrMCP app from the tools/apps menu.</li><li>On first use, ChatGPT should call <code>create_context</code>; later calls should reuse the returned <code>context_handle</code>.</li><li>Choose the working root for that Session in the MrMCP <b>Sessions</b> page.</li><li>If you change ChatGPT model or thinking level, the MCP context may be recreated even inside the same conversation. Check the Sessions page if continuity matters.</li></ol><p class=muted>ChatGPT UI labels and plan availability can change. Current OpenAI references: <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target=_blank rel=noopener>Developer mode and MCP apps in ChatGPT</a> · <a href="https://help.openai.com/en/articles/11487775-connectors-in-chatgpt" target=_blank rel=noopener>Apps in ChatGPT</a>.</p></div></section><? } ?>`,
    dialogs: `<? const dialog=it.data?.state?.dialog; ?><? if(dialog?.kind==="root"){ const r=dialog.data||{}; ?><dialog id=rootDialog data-managed-dialog=root><form id=rootForm><input id=rid type=hidden value="<?= r.id||'' ?>"><h2>📁 Root</h2><label>Logical name</label><input id=rname required value="<?= r.name||'' ?>"><label>Absolute directory path</label><input id=rpath required placeholder="C:\\projects\\my-root or /srv/my-root" value="<?= r.path||'' ?>"><label><input id=renabled type=checkbox<?= r.enabled!==false?' checked':'' ?>> Enabled</label><p class=row><button class=primary type=submit>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog?.kind==="command"){ const c=dialog.data||{}; ?><dialog id=commandDialog data-managed-dialog=command><form id=commandForm><input id=coldName type=hidden value="<?= c.registered?c.name:'' ?>"><h2>🧰 Command catalog entry</h2><label>Logical name</label><input id=cname pattern="[A-Za-z0-9_.+-]+" required value="<?= c.name||'' ?>"><label>Path below .mrmcp/bin</label><input id=cpath placeholder="Optional; defaults to logical name; Windows suffix optional" value="<?= c.path||'' ?>"><label>Description for the agent</label><textarea id=cdescription placeholder="Optional: what it does and when the agent should use it."><?= c.description||'' ?></textarea><label>Download URL</label><input id=cdownloadUrl type=url placeholder="https://example.com/tool" value="<?= c.download_url||'' ?>"><label>Documentation URL</label><input id=cdocumentationUrl type=url placeholder="https://example.com/docs" value="<?= c.documentation_url||'' ?>"><p class=row><button class=primary type=submit>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog?.kind==="confirm"){ ?><dialog id=confirmDialog data-managed-dialog=confirm><h2>⚠️ <?= dialog.title||"Confirm action" ?></h2><p><?= dialog.message||"Continue?" ?></p><p class=row><button class="primary danger" data-action=confirm-dialog>✓ Confirm</button><button data-action=close-dialog>✕ Cancel</button></p></dialog><? } else if(dialog?.kind==="message"){ ?><dialog id=messageDialog data-managed-dialog=message><h2><?= dialog.title||"MrMCP" ?></h2><pre><?= dialog.message||"" ?></pre><p><button class=primary data-action=close-dialog>✓ Close</button></p></dialog><? } ?>`,
    status: `<? const d=it.data||{},s=d.settings||{}; ?><span class=<?= d.live === "connected" ? "ok" : (d.live === "reconnecting" ? "pending" : "failed") ?>><?= d.live === "connected" ? "🟢 live" : (d.live === "reconnecting" ? "🟡 reconnecting" : "🔴 offline") ?></span><span>v<?= d.version||"" ?> · /mcp · HTTP:80 ACME <?= s.mcp_http_active?"on":"off" ?> · HTTPS:443 <?= s.mcp_https_active?(s.tls_active_kind||"active"):"off" ?></span>`,
    cards: `<? const icons={sessions:"💬",roots:"📁",tool_calls:"📜",failed_calls:"⚠️",http_requests:"🌐"}; Object.entries(it.data || {}).forEach(([key,value]) => { ?><div class=card><div class=muted><?= icons[key]||"•" ?> <?= key.replaceAll("_", " ") ?></div><strong style="font-size:24px"><?= value ?></strong></div><? }) ?>`,
    tls: `<? const t=it.data||{}, problem=!t.tls_active_trusted||!!t.tls_last_error||!!t.mcp_listen_error; ?><div class="card <?= problem ? "tls-alert" : "tls-good" ?>"><div class=row><h3 class=grow>🔒 TLS / Let's Encrypt</h3><b class="<?= t.tls_active_trusted ? "ok" : "failed" ?>"><?= t.tls_active_trusted ? "trusted" : (t.tls_active ? "fallback active" : "offline") ?></b></div><div class=grid><div><span class=muted>HTTPS listener</span><br><b><?= t.mcp_https_active ? "0.0.0.0:443 active" : "not listening" ?></b></div><div><span class=muted>Active certificate</span><br><b><?= t.tls_active_kind || "none" ?> · <?= t.tls_active_valid ? "valid" : "invalid" ?></b></div><div><span class=muted>Expires</span><br><b><?= it.dt(t.tls_active_expires) || "unknown" ?></b></div><div><span class=muted>Last ACME request</span><br><b><?= it.dt(t.tls_last_request_at) || "never recorded" ?></b></div><div><span class=muted>Last ACME result</span><br><b class="<?= t.tls_last_request_valid ? "ok" : (t.tls_last_request_status === "error" ? "failed" : "pending") ?>"><? if (t.tls_last_request_status) { ?><?= t.tls_last_request_status ?> · certificate <?= t.tls_last_request_valid ? "valid" : "not valid" ?><? } else { ?>not recorded<? } ?></b></div><div><span class=muted>Last valid certificate</span><br><b><?= it.dt(t.tls_last_issued_at) || "not recorded" ?></b></div><div><span class=muted>Renewal due</span><br><b><?= it.dt(t.tls_renewal_due_at) || "as soon as allowed" ?></b></div><div><span class=muted>Rate-limit reset</span><br><b><?= it.dt(t.tls_rate_limit_reset_at) || "none" ?></b></div><div><span class=muted>Next ACME attempt</span><br><b><?= it.dt(t.tls_next_attempt_at) || "not scheduled" ?></b></div></div><? if (t.tls_last_error || t.mcp_listen_error) { ?><pre class=tls-error><?= t.tls_last_error || t.mcp_listen_error ?></pre><? } ?><? if (!t.tls_active_trusted) { ?><p class=failed><b>Public clients such as ChatGPT will reject the self-signed fallback until Let's Encrypt succeeds.</b></p><? } ?></div>`,
    urls: `<? (it.data || []).forEach(x => { if (!x?.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?><? if (x.note) { ?> <span class=muted><?= x.note ?></span><? } ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?>`,
    roots: `<? const rows=it.data||[]; ?><? if(!rows.length){ ?><p class=muted>No roots registered.</p><? } else { ?><table><tr><th>Name</th><th>Path</th><th>State</th><th></th></tr><? rows.forEach(r => { ?><tr><td><code><?= r.name ?></code></td><td><code><?= r.path ?></code></td><td><?= r.enabled ? "✅ enabled" : "⏸️ disabled" ?></td><td class=nowrap><button data-action=edit-root data-id="<?= r.id ?>">✏️ Edit</button> <button class=danger data-action=delete-root data-id="<?= r.id ?>">🗑️ Delete</button></td></tr><? }) ?></table><? } ?>`,
    context: `<? const d=it.data||{},values=d.values||[]; ?><? if (!values.length) { ?><p class=muted>No sessions have been issued yet.</p><? } else { ?><table><tr><th>ID</th><th>Context</th><th>Client / auth</th><th>State / protocol</th><th>Current root</th><th>Activity</th><th>Tool calls</th><th></th></tr><? values.forEach(v=>{ const ua=String(v.user_agent||""); ?><tr><td class=idcell>#<?= v.pk ?></td><td class=context-id><code><?= v.context_handle ?></code></td><td><b><?= v.client_name||"Unknown client" ?></b><br><span class=muted><?= v.auth_kind||"unknown auth" ?></span><? if(ua){ ?><div class=muted title="<?= ua ?>"><?= ua.slice(0,72) ?><?= ua.length>72?"…":"" ?></div><? } ?></td><td class=nowrap><b class="<?= v.expired ? 'failed' : 'ok' ?>"><?= v.expired ? "⌛ expired" : "🟢 active" ?></b><br><code><?= v.protocol_version||"unknown" ?></code></td><td><select data-action=context-root data-id="<?= v.pk ?>"><option value="0"<?= v.fallback_root?" selected":"" ?>>Default root</option><? (v.available_roots||[]).forEach(r=>{ ?><option value="<?= r.id ?>"<?= r.selected?" selected":"" ?>><?= r.name ?></option><? }) ?></select><div class=muted><?= v.effective_root_path ?></div></td><td class=context-dates><div><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></div><div><span class=muted>Updated</span> <?= it.logdt(v.updated_at) ?></div><div><span class=muted>Active</span> <?= it.logdt(v.last_active_at) ?></div><div><span class=muted>Expires</span> <?= it.logdt(v.expires_at) ?></div></td><td class=nowrap><?= v.tool_calls||0 ?> <button class=small data-action=session-tool-calls data-id="<?= v.pk ?>">View calls</button></td><td><button class=danger data-action=delete-context data-id="<?= v.pk ?>">🗑️ Delete</button></td></tr><? }) ?></table><? } ?>`,
    commands: `<? const d=it.data || {}, rows=d.commands || []; ?><div class=muted><?= d.total || 0 ?> command<?= d.total === 1 ? "" : "s" ?> · page <?= d.page || 1 ?>/<?= d.pages || 1 ?> · config <code><?= d.config_file || "" ?></code></div><table><tr><th>Name</th><th>Relative path</th><th>Description</th><th>Links</th><th>Source</th><th>State</th><th></th></tr><? rows.forEach(c => { ?><tr><td><code><?= c.name ?></code></td><td><code><?= c.path ?></code></td><td><?= c.description || "—" ?></td><td><? if (c.documentation_url) { ?><a href="<?= c.documentation_url ?>" target=_blank rel=noopener>📖 Docs</a><? } else { ?>—<? } ?></td><td><?= c.source ?></td><td class="<?= c.present && c.executable ? "ok" : "failed" ?>"><?= c.present ? (c.executable ? "✅ available" : "⚠️ not executable") : "❌ missing" ?></td><td class=nowrap><button data-action=edit-command data-name="<?= c.name ?>" data-path="<?= c.path ?>">✏️ Edit</button><? if (c.registered && c.download_url) { ?> <button data-action=download-command data-name="<?= c.name ?>">⬇️ Download</button><? } ?><? if (c.registered) { ?> <button class=danger data-action=delete-command data-name="<?= c.name ?>">🗑️ Delete</button><? } ?></td></tr><? }) ?></table><div class=row><button data-action=commands-prev<?= d.page <= 1 ? " disabled" : "" ?>>Previous</button><button data-action=commands-next<?= d.has_more ? "" : " disabled" ?>>Next</button></div>`,
    oauth: `<table><tr><th>Client</th><th>ID</th><th>Sessions</th><th>Access</th><th>Refresh</th><th></th></tr><? (it.data || []).forEach(c => { ?><tr><td><?= c.name ?></td><td><code><?= c.client_id ?></code></td><td class=nowrap><?= c.session_count||0 ?> <button class=small data-action=oauth-sessions data-id="<?= c.client_id ?>">View sessions</button></td><td><?= c.token_count ?></td><td><?= c.refresh_token_count ?></td><td><button class=danger data-action=revoke-client data-id="<?= c.client_id ?>">🚫 Revoke</button></td></tr><? }) ?></table>`,
    endpoints: `<? const server=it.data||{}; ?><div class=card><div class=row><div class=grow><h3 style="margin:0">🌐 MrMCP <code>/mcp</code></h3><div class=muted>Protocols: <?= (server.protocol_versions||[]).join(", ") ?></div></div><button data-action=self-test>🧪 Self-test</button></div><? it.endpointRows(server).forEach(x => { if (!x.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?><details><summary><?= server.tool_count||0 ?> available tools</summary><p class=muted><?= (server.tool_names||[]).join(", ") ?></p></details></div>`,
    logs: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1),statusIcons={completed:"✅",failed:"❌",running:"⏳",received:"📥"}; ?><div class="row log-pagination"><span class="muted grow"><?= d.total||0 ?> call<?= d.total===1?"":"s" ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Tool call pages"><button class=page-button data-action=logs-page data-log-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?" disabled":"" ?> aria-label="Previous page">‹</button><? items.forEach(item=>{ if(item==="…"){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?" active":"" ?>" data-action=logs-page data-log-page="<?= item ?>"<?= item===(d.page||1)?" aria-current=page":"" ?>><?= item ?></button><? } }) ?><button class=page-button data-action=logs-page data-log-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?" disabled":"" ?> aria-label="Next page">›</button></nav></div><table><tr><th>ID</th><th>Time</th><th>Session</th><th>Tool</th><th>Status</th><th>Duration</th><th>Actions</th></tr><? rows.forEach(l => { ?><tr data-action=select-log data-id="<?= l.id ?>" title="Click to expand details"><td class=idcell>#<?= l.id ?></td><td class=nowrap><?= it.logdt(l.started_at) ?></td><td class=idcell><?= l.context_id ? "#"+l.context_id : "—" ?></td><td><code><?= l.tool ?></code></td><td class="<?= l.status ?>"><?= statusIcons[l.status]||"•" ?> <?= l.status ?></td><td><?= l.duration_ms ?? "" ?><? if (l.duration_ms != null) { ?>ms<? } ?></td><td class=nowrap><? if(l.killable){ ?><button class=small data-action=terminate-log data-id="<?= l.id ?>">⏹️ Terminate</button> <button class="small danger" data-action=kill-log data-id="<?= l.id ?>">⚠️ Force</button><? } else { ?>—<? } ?></td></tr><? if(String(d.openRowId||"")===String(l.id)&&d.openDetail){ const x=d.openDetail; ?><tr class=detail-row data-detail-kind=tool data-detail-id="<?= l.id ?>"><td colspan=7><div class=detail-panel><div class=row><b class=grow>MCP tool call #<?= l.id ?></b><button class=small data-action=copy-detail data-target="tool-full-<?= l.id ?>">📋 Copy full row</button><button class=small data-action=close-row-detail data-kind=tool>✕ Close</button></div><pre id="tool-full-<?= l.id ?>" hidden><?= it.pretty(x) ?></pre><section class=json-detail><div class=row><b class=grow>Input JSON</b><button class=small data-action=copy-detail data-target="tool-input-<?= l.id ?>">📋 Copy JSON</button></div><pre id="tool-input-<?= l.id ?>"><?= it.prettyParsed(x.input_json) ?></pre></section><section class=json-detail><div class=row><b class=grow>MCP result JSON</b><button class=small data-action=copy-detail data-target="tool-output-<?= l.id ?>">📋 Copy JSON</button></div><pre id="tool-output-<?= l.id ?>"><?= it.prettyParsed(x.result_json||x.resolved_json||x.stdout||{}) ?></pre></section><? if(x.stderr){ ?><section class=json-detail><b>Standard error</b><pre><?= x.stderr ?></pre></section><? } ?><? if(x.error){ ?><section class=json-detail><b>Error</b><pre><?= x.error ?></pre></section><? } ?></div></td></tr><? } }) ?></table>`,
    debug: `<? const d=it.data||{}; if (!d.enabled) { ?><p class=muted>HTTP debug logging is disabled.</p><? } else { ?><table><tr><th>ID</th><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Remote</th><th>Error</th></tr><? (d.rows || []).forEach(r => { ?><tr data-action=select-debug data-id="<?= r.id ?>" title="Click to expand"><td class=idcell>#<?= r.id ?></td><td class=nowrap><?= it.logdt(r.ts) ?></td><td><b><?= r.method ?></b></td><td><code><?= r.path ?></code></td><td class="<?= r.status >= 400 ? "failed" : "ok" ?>"><?= r.status ?></td><td><?= r.duration_ms ?>ms</td><td><?= r.remote_addr ?></td><td><?= r.error_preview ?></td></tr><? if(String(d.openRowId||"")===String(r.id)&&d.openDetail){ ?><tr class=detail-row data-detail-kind=http data-detail-id="<?= r.id ?>"><td colspan=8><div class=detail-panel><div class=row><b class=grow>HTTP request #<?= r.id ?></b><button class=small data-action=copy-detail data-target="http-json-<?= r.id ?>">📋 Copy JSON</button><button class=small data-action=close-row-detail data-kind=http>✕ Close</button></div><pre id="http-json-<?= r.id ?>"><?= it.pretty(d.openDetail) ?></pre></div></td></tr><? } }) ?></table><? } ?>`,
  };
  const fragmentDate = value => {
    if (!value) return "";
    const date = new Date(value), now = new Date();
    if (!Number.isFinite(date.getTime())) return "";
    const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return today ? date.toLocaleTimeString() : date.toLocaleString();
  };
  const fragmentRelativeAge = value => {
    if (!value) return "";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} mo`;
    return `${Math.floor(days / 365)} y`;
  };
  const fragmentLogDate = value => {
    const date = fragmentDate(value), age = fragmentRelativeAge(value);
    return date && age ? `${date} (${age})` : date;
  };
  const fragmentPageItems = (page, pages) => {
    page = Math.max(1, Number(page) || 1); pages = Math.max(1, Number(pages) || 1);
    if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
    const values = [...new Set([1, 2, page - 1, page, page + 1, pages - 1, pages]
      .filter(value => value >= 1 && value <= pages))].sort((a, b) => a - b);
    const result = [];
    for (const value of values) {
      if (result.length && value - result.at(-1) > 1) result.push("…");
      result.push(value);
    }
    return result;
  };
  const endpointRows = p => [
    ["MCP sslip.io", p.sslip_https_mcp_url], ["MCP direct IP", p.direct_ip_https_mcp_url],
    ["OAuth metadata", p.sslip_metadata_url], ["Local HTTPS", p.local_https_mcp_url],
    ["Basic URL", p.basic_url],
  ].map(([label, url]) => ({ label, url }));
  async function renderEtaFragment(name, data) {
    if (!fragmentTemplates[name]) throw new Error(`Unknown UI fragment: ${name}`);
    const context = {
      data, dt: fragmentDate, logdt: fragmentLogDate, pages: fragmentPageItems, endpointRows,
      pretty: value => JSON.stringify(value ?? null, null, 2),
      prettyParsed: value => {
        const parsed = typeof value === "string" ? parseJson(value, value) : value;
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? null, null, 2);
      },
    };
    return typeof eta.renderStringAsync === "function"
      ? await eta.renderStringAsync(fragmentTemplates[name], context)
      : eta.renderString(fragmentTemplates[name], context);
  }
  async function uiInternalApi(path, { method = "GET", body } = {}) {
    const headers = new Headers({ cookie: `mrmcp_session=${SESSION}`, "x-mrmcp-csrf": CSRF });
    let payload;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const request = new Request(`http://127.0.0.1:${GUI_PORT}${path}`, { method, headers, body: payload });
    const response = await guiApi(request, new URL(request.url));
    const raw = await response.text();
    const data = raw ? parseJson(raw, { error: raw }) : {};
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }
  function uiSettingsProjection(settings) {
    const draft = uiState.settingsDraft || {};
    const projected = { ...settings, ...draft };
    if (typeof projected.public_ip_urls === "string") projected.public_ip_urls = projected.public_ip_urls.split(/\r?\n/);
    return projected;
  }
  async function buildUiRenderModel() {
    const section = UI_SECTIONS.has(uiState.currentSection) ? uiState.currentSection : "dashboard";
    const projection = state(section);
    const viewState = structuredClone(uiState);
    viewState.currentSection = section;
    viewState.settings = uiSettingsProjection(projection.settings);
    viewState.contextValues = projection.context_values || [];
    viewState.debug.enabled = !!projection.settings.debug_http_log;
    const model = { section, projection, viewState, commandData: null, logData: null, debugData: null };
    if (section === "commands") {
      const current = uiState.commands;
      model.commandData = await commandCatalog({
        query: current.query, page: current.page, page_size: current.pageSize,
        include_missing: current.includeMissing, admin: true,
      });
      current.page = model.commandData.page;
      viewState.commands.page = current.page;
    } else if (section === "logs") {
      const current = uiState.logs;
      const query = new URLSearchParams({
        q: current.query, context: current.context, status: current.status,
        page: String(current.page), page_size: String(current.pageSize),
      });
      model.logData = await uiInternalApi(`/api/logs?${query}`);
      current.page = model.logData.page;
      if (current.openRowId) {
        if ((model.logData.rows || []).some(row => String(row.id) === String(current.openRowId)))
          model.logData.openDetail = await uiInternalApi(`/api/logs/${encodeURIComponent(current.openRowId)}`);
        else current.openRowId = "";
      }
      model.logData.openRowId = current.openRowId;
      viewState.logs.page = current.page;
      viewState.logs.openRowId = current.openRowId;
    } else if (section === "debug") {
      const current = uiState.debug;
      const query = new URLSearchParams({ q: current.query, method: current.method, status: current.status });
      const rows = await uiInternalApi(`/api/debug?${query}`);
      model.debugData = { enabled: !!projection.settings.debug_http_log, rows, openRowId: current.openRowId };
      if (current.openRowId) {
        if ((rows || []).some(row => String(row.id) === String(current.openRowId)))
          model.debugData.openDetail = await uiInternalApi(`/api/debug/${encodeURIComponent(current.openRowId)}`);
        else current.openRowId = "";
      }
      model.debugData.openRowId = current.openRowId;
      viewState.debug.openRowId = current.openRowId;
    }
    return model;
  }
  function fillUiMount(html, id, inner) {
    const pattern = new RegExp(`<([A-Za-z][A-Za-z0-9-]*) id=${id}([^>]*)></\\1>`);
    return html.replace(pattern, (_match, tag, attributes) => `<${tag} id=${id}${attributes}>${inner}</${tag}>`);
  }
  async function renderUiDocument() {
    const model = await buildUiRenderModel();
    const { section, projection, viewState } = model;
    let view = await renderEtaFragment("view", { state: viewState });
    if (section === "dashboard") {
      view = fillUiMount(view, "cards", await renderEtaFragment("cards", {
        sessions: projection.stats?.context_values || 0,
        roots: projection.stats?.roots || 0,
        tool_calls: projection.stats?.logs || 0,
        failed_calls: projection.stats?.failures || 0,
        http_requests: projection.stats?.total_requests || 0,
      }));
      view = fillUiMount(view, "endpoints", await renderEtaFragment("endpoints", projection.server || {}));
      view = fillUiMount(view, "tlsStatus", await renderEtaFragment("tls", projection.settings));
    } else if (section === "sessions") {
      view = fillUiMount(view, "contextList", await renderEtaFragment("context", { values: projection.context_values || [] }));
    } else if (section === "roots") {
      view = fillUiMount(view, "rootList", await renderEtaFragment("roots", projection.roots || []));
    } else if (section === "commands") {
      view = fillUiMount(view, "commandList", await renderEtaFragment("commands", model.commandData || {}));
    } else if (section === "logs") {
      view = fillUiMount(view, "logList", await renderEtaFragment("logs", model.logData || {}));
    } else if (section === "debug") {
      view = fillUiMount(view, "debugList", await renderEtaFragment("debug", model.debugData || {}));
    } else if (section === "oauth") {
      view = fillUiMount(view, "oauthList", await renderEtaFragment("oauth", projection.oauth_clients || []));
    }
    const [sidebar, status, dialogs] = await Promise.all([
      renderEtaFragment("sidebar", { state: viewState }),
      renderEtaFragment("status", { version: projection.version, settings: projection.settings, live: "connected" }),
      renderEtaFragment("dialogs", { state: viewState }),
    ]);
    const banner = uiState.notice
      ? `<div id=errorBanner class=banner style="display:block">${htmlEscape(uiState.notice.message || "")}</div>`
      : `<div id=errorBanner class=banner></div>`;
    return `<div id="app" data-section="${htmlEscape(section)}"><header><b>🧩 MrMCP</b><div id=uiStatus class=status>${status}</div></header>${banner}<aside><div id=sidebar>${sidebar}</div></aside><main><div id=mainView>${view}</div></main><div id=dialogHost>${dialogs}</div></div>`;
  }

  function uiMessage(title, message) {
    uiState.dialog = { kind: "message", title, message: String(message || "") };
    queueUiRender("message", 0);
  }
  function uiConfirm(title, message, confirmAction, data = {}) {
    uiState.dialog = { kind: "confirm", title, message, confirmAction, data };
    queueUiRender("confirm", 0);
  }
  function uiFocusFromEvent(event) {
    if (!event?.focus?.id) return;
    uiState.focus = {
      id: String(event.focus.id),
      start: Number.isInteger(event.focus.start) ? event.focus.start : null,
      end: Number.isInteger(event.focus.end) ? event.focus.end : null,
    };
  }
  function uiUpdateDraft(id, value, checked) {
    const text = value == null ? "" : String(value);
    if (id === "logQuery") uiState.logs.query = text;
    else if (id === "debugQuery") uiState.debug.query = text;
    else if (id === "commandQuery") uiState.commands.query = text;
    else if (uiState.dialog?.kind === "root") {
      const map = { rid: "id", rname: "name", rpath: "path", renabled: "enabled" };
      if (map[id]) uiState.dialog.data[map[id]] = id === "renabled" ? !!checked : text;
    } else if (uiState.dialog?.kind === "command") {
      const map = {
        coldName: "old_name", cname: "name", cpath: "path", cdescription: "description",
        cdownloadUrl: "download_url", cdocumentationUrl: "documentation_url",
      };
      if (map[id]) uiState.dialog.data[map[id]] = text;
    }
    const settingsMap = {
      externalUrl: "external_url", tlsEmail: "tls_email", publicIpUrls: "public_ip_urls",
      sslipSuffix: "sslip_suffix", acmeDirectoryUrl: "acme_directory_url",
      inheritSystemPath: "inherit_system_path",
    };
    if (settingsMap[id]) {
      uiState.settingsDraft ||= {};
      uiState.settingsDraft[settingsMap[id]] = id === "inheritSystemPath" ? !!checked : text;
    }
  }
  async function uiCommandRow(name, path = "") {
    const result = await commandCatalog({ query: name, page: 1, page_size: 100, include_missing: true, admin: true });
    return (result.commands || []).find(row => row.name === name && (!path || row.path === path));
  }
  async function uiDownloadOne(name, overwrite = false) {
    return await uiInternalApi("/api/commands/download", { method: "POST", body: { name, overwrite } });
  }
  async function uiDownloadAll(overwrite = false) {
    const result = await commandCatalog({ query: "", page: 1, page_size: 100, include_missing: true, admin: true });
    const rows = (result.commands || []).filter(row => row.registered && row.download_url);
    const failures = [];
    for (const row of rows) {
      try { await uiDownloadOne(row.name, overwrite || !!row.present); }
      catch (error) { failures.push(`${row.name}: ${String(error?.message || error)}`); }
    }
    if (failures.length) uiMessage("Download errors", failures.join("\n"));
  }
  async function uiRunConfirmedAction(dialog) {
    const data = dialog?.data || {};
    switch (dialog?.confirmAction) {
      case "delete-root":
        await uiInternalApi("/api/roots/delete", { method: "POST", body: { id: Number(data.id) } });
        break;
      case "delete-context":
        await uiInternalApi("/api/context/delete", { method: "POST", body: { id: Number(data.id) } });
        break;
      case "delete-command":
        await uiInternalApi("/api/commands/delete", { method: "POST", body: { name: String(data.name || "") } });
        break;
      case "revoke-client":
        await uiInternalApi("/api/oauth/revoke-client", { method: "POST", body: { client_id: String(data.client_id || "") } });
        break;
      case "clear-debug":
        await uiInternalApi("/api/debug/clear", { method: "POST" });
        uiState.debug.openRowId = "";
        break;
      case "download-command":
        await uiDownloadOne(String(data.name || ""), true);
        break;
      case "download-all-commands":
        await uiDownloadAll(true);
        break;
    }
  }
  async function handleUiAction(event) {
    const action = String(event.action || ""), data = event.dataset || {}, values = event.values || {};
    switch (action) {
      case "new-root":
        uiState.dialog = { kind: "root", data: { enabled: true } };
        break;
      case "edit-root": {
        const root = one("SELECT * FROM roots WHERE id=?", Number(data.id));
        if (!root) throw new Error("Root not found");
        uiState.dialog = { kind: "root", data: { ...root, enabled: !!root.enabled } };
        break;
      }
      case "delete-root":
        uiConfirm("Delete root", "Delete this registered root? Existing files are not removed.", "delete-root", { id: data.id });
        return;
      case "delete-context":
        uiConfirm("Delete session", "Delete this persistent MCP context? Running processes are not terminated.", "delete-context", { id: data.id });
        return;
      case "session-tool-calls":
        uiState.currentSection = "logs";
        uiState.logs.context = String(Number(data.id) || "");
        uiState.logs.query = "";
        uiState.logs.status = "";
        uiState.logs.page = 1;
        uiState.logs.openRowId = "";
        uiState.logs.selfTest = null;
        break;
      case "oauth-sessions":
        uiState.currentSection = "sessions";
        uiState.sessions.oauthClientId = String(data.id || "");
        break;
      case "clear-session-oauth":
        uiState.sessions.oauthClientId = "";
        break;
      case "new-command":
        uiState.dialog = { kind: "command", data: { name: "", path: "", description: "", download_url: "", documentation_url: "", registered: false } };
        break;
      case "edit-command": {
        const row = await uiCommandRow(String(data.name || ""), String(data.path || ""));
        if (!row) throw new Error("Command not found");
        uiState.dialog = { kind: "command", data: { ...row, old_name: row.name } };
        break;
      }
      case "delete-command":
        uiConfirm("Delete command", `Delete metadata for ${data.name || "this command"}?`, "delete-command", { name: data.name });
        return;
      case "download-command": {
        const row = await uiCommandRow(String(data.name || ""));
        if (!row) throw new Error("Command not found");
        if (row.present) {
          uiConfirm("Replace command", `Replace the existing file for ${row.name}?`, "download-command", { name: row.name });
          return;
        }
        await uiDownloadOne(row.name, false);
        break;
      }
      case "download-all-commands": {
        const result = await commandCatalog({ query: "", page: 1, page_size: 100, include_missing: true, admin: true });
        const rows = (result.commands || []).filter(row => row.registered && row.download_url);
        const existing = rows.filter(row => row.present);
        if (existing.length) {
          uiConfirm("Replace commands", `Download ${rows.length} commands and replace ${existing.length} existing file${existing.length === 1 ? "" : "s"}?`, "download-all-commands");
          return;
        }
        await uiDownloadAll(false);
        break;
      }
      case "load-commands":
        uiState.commands.page = 1;
        break;
      case "commands-prev":
        uiState.commands.page = Math.max(1, uiState.commands.page - 1);
        break;
      case "commands-next":
        uiState.commands.page += 1;
        break;
      case "revoke-client":
        uiConfirm("Revoke OAuth client", "Revoke this client and all of its tokens?", "revoke-client", { client_id: data.id });
        return;
      case "self-test":
        uiState.currentSection = "logs";
        uiState.logs.selfTest = await uiInternalApi("/api/mcp/self-test");
        break;
      case "close-self-test":
        uiState.logs.selfTest = null;
        break;
      case "close-row-detail":
        if (data.kind === "tool") uiState.logs.openRowId = "";
        else uiState.debug.openRowId = "";
        break;
      case "logs-page":
        uiState.logs.page = Math.max(1, Number(data.logPage) || 1);
        break;
      case "terminate-log":
      case "kill-log":
        await uiInternalApi(`/api/logs/${encodeURIComponent(data.id)}/kill`, {
          method: "POST", body: { signal: action === "kill-log" ? "SIGKILL" : "SIGTERM" },
        });
        break;
      case "select-log":
        uiState.logs.openRowId = uiState.logs.openRowId === String(data.id) ? "" : String(data.id);
        break;
      case "load-debug":
        break;
      case "save-debug-settings":
        await uiInternalApi("/api/debug/settings", { method: "POST", body: { enabled: !!values.debugHttpLog } });
        break;
      case "select-debug":
        uiState.debug.openRowId = uiState.debug.openRowId === String(data.id) ? "" : String(data.id);
        break;
      case "clear-debug":
        uiConfirm("Clear HTTP debug log", "Delete all HTTP debug log rows?", "clear-debug");
        return;
      case "detect-ip":
        await uiInternalApi("/api/network/detect", { method: "POST" });
        uiState.settingsDraft = null;
        break;
      case "issue-cert": {
        const result = await uiInternalApi("/api/tls/issue", { method: "POST" });
        const certificate = result.certificate || {};
        if (!certificate.requested && certificate.reason)
          uiMessage("Certificate request", certificate.reason + (certificate.next_attempt_at ? `\nNext attempt: ${new Date(certificate.next_attempt_at).toLocaleString()}` : ""));
        break;
      }
      case "save-settings":
        await uiInternalApi("/api/settings", { method: "POST", body: {
          external_url: String(values.externalUrl || ""),
          tls_email: String(values.tlsEmail || ""),
          public_ip_urls: String(values.publicIpUrls || "").split(/\r?\n/),
          sslip_suffix: String(values.sslipSuffix || ""),
          acme_directory_url: String(values.acmeDirectoryUrl || ""),
          inherit_system_path: !!values.inheritSystemPath,
        } });
        uiState.settingsDraft = null;
        break;
      case "close-dialog":
        uiState.dialog = null;
        break;
      case "confirm-dialog": {
        const dialog = uiState.dialog;
        uiState.dialog = null;
        await uiRunConfirmedAction(dialog);
        break;
      }
    }
    queueUiRender(`action:${action}`);
  }
  async function handleUiInput(message) {
    const sequence = Math.max(0, Number(message?.sequence) || 0);
    if (sequence) uiState.lastInputSequence = Math.max(uiState.lastInputSequence, sequence);
    const event = message?.event || message || {};
    uiFocusFromEvent(event);
    if (UI_SECTIONS.has(String(event.viewport?.section || "")))
      uiState.scrollBySection[event.viewport.section] = [Number(event.viewport.x) || 0, Number(event.viewport.y) || 0];
    try {
      switch (event.type) {
        case "bootstrap":
          queueUiRender("bootstrap", 0);
          return;
        case "navigate": {
          const section = String(event.section || "");
          if (UI_SECTIONS.has(section)) {
            uiState.currentSection = section;
            uiState.dialog = null;
            uiState.notice = null;
            if (section === "settings" && !uiState.settingsDraft)
              uiState.settingsDraft = { ...settingsProjection() };
          }
          queueUiRender("navigate", 0);
          return;
        }
        case "scroll":
          if (UI_SECTIONS.has(String(event.section || "")))
            uiState.scrollBySection[event.section] = [Number(event.x) || 0, Number(event.y) || 0];
          return;
        case "focus":
          return;
        case "input": {
          const id = String(event.id || "");
          uiUpdateDraft(id, event.value, event.checked);
          if (id === "logQuery") {
            uiState.logs.page = 1;
            if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
            uiLogFilterTimer = setTimeout(() => {
              uiLogFilterTimer = null;
              queueUiRender("input:logQuery", 0);
            }, 220);
          }
          return;
        }
        case "change": {
          const id = String(event.id || "");
          uiUpdateDraft(id, event.value, event.checked);
          if (["logContext", "logStatus", "logPageSize"].includes(id) && uiLogFilterTimer) {
            clearTimeout(uiLogFilterTimer);
            uiLogFilterTimer = null;
          }
          if (id === "logContext") { uiState.logs.context = String(event.value || ""); uiState.logs.page = 1; }
          else if (id === "logStatus") { uiState.logs.status = String(event.value || ""); uiState.logs.page = 1; }
          else if (id === "logPageSize") { uiState.logs.pageSize = Number(event.value) || 25; uiState.logs.page = 1; }
          else if (id === "debugMethod") uiState.debug.method = String(event.value || "");
          else if (id === "debugStatus") uiState.debug.status = String(event.value || "");
          else if (id === "commandPageSize") { uiState.commands.pageSize = Number(event.value) || 25; uiState.commands.page = 1; }
          else if (id === "commandIncludeMissing") { uiState.commands.includeMissing = !!event.checked; uiState.commands.page = 1; }
          else if (event.dataset?.action === "context-root")
            await uiInternalApi("/api/context/select", { method: "POST", body: { id: Number(event.dataset.id), root_id: Number(event.value) || 0 } });
          queueUiRender(`change:${id}`);
          return;
        }
        case "enter":
          if (event.id === "logQuery") {
            uiState.logs.page = 1;
            if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
            uiLogFilterTimer = null;
          } else if (event.id === "commandQuery") uiState.commands.page = 1;
          queueUiRender(`enter:${event.id}`);
          return;
        case "submit": {
          const values = event.values || {};
          if (event.formId === "rootForm") {
            await uiInternalApi("/api/roots/save", { method: "POST", body: {
              id: Number(values.rid) || null, name: values.rname, path: values.rpath, enabled: !!values.renabled,
            } });
            uiState.dialog = null;
          } else if (event.formId === "commandForm") {
            await uiInternalApi("/api/commands/save", { method: "POST", body: {
              old_name: values.coldName, name: values.cname, path: values.cpath,
              description: values.cdescription, download_url: values.cdownloadUrl,
              documentation_url: values.cdocumentationUrl,
            } });
            uiState.dialog = null;
            uiState.commands.page = 1;
          }
          queueUiRender(`submit:${event.formId}`);
          return;
        }
        case "action":
          await handleUiAction(event);
          return;
      }
    } catch (error) {
      uiState.dialog = { kind: "message", title: "Error", message: String(error?.message || error) };
      queueUiRender("input-error", 0);
    }
  }


  async function guiApi(req, u) {
    if (!requireApi(req)) return json({ error: "Unauthorized" }, 401);
    if (u.pathname === "/api/events" && req.method === "GET") return uiEventStream();
    if (u.pathname === "/api/ui-input" && req.method === "GET") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data || "{}")); }
        catch { return; }
        uiInputChain = uiInputChain.then(async () => {
          uiInputDepth += 1;
          try { await handleUiInput(message); }
          finally {
            uiInputDepth -= 1;
            if (uiRenderQueued) queueUiRender("input-complete", 0);
          }
        }).catch(error => {
          uiState.dialog = { kind: "message", title: "Error", message: String(error?.message || error) };
          queueUiRender("websocket-error", 0);
        });
      };
      socket.onopen = () => queueUiRender("input-connected", 0);
      return response;
    }
    if (u.pathname === "/api/settings" && req.method === "POST") {
      const x = await bodyJson(req);
      if (x.external_url) {
        let external;
        try { external = new URL(String(x.external_url)); }
        catch { return json({ error: "Public base URL must be a valid HTTPS URL" }, 400); }
        if (external.protocol !== "https:" || (external.port && external.port !== "443"))
          return json({ error: "Public base URL must use HTTPS on port 443" }, 400);
      }
      for (const key of ["external_url", "tls_email", "sslip_suffix", "acme_directory_url"])
        if (x[key] != null) setCfg(key, x[key]);
      if (x.inherit_system_path != null) setCfg("inherit_system_path", x.inherit_system_path ? "1" : "0");
      if (Array.isArray(x.public_ip_urls)) setCfg("public_ip_urls_json", JSON.stringify(
        x.public_ip_urls.map(String).map(value => value.trim()).filter(value => /^https:\/\//i.test(value)),
      ));
      await restartMcp();
      automaticRenewal().catch(() => {});
      return json({ ok: true });
    }
    if (u.pathname === "/api/network/detect" && req.method === "POST") {
      const publicIp = await detectPublicIp();
      await restartMcp();
      automaticRenewal().catch(() => {});
      return json({ ok: true, public_ip: publicIp });
    }
    if (u.pathname === "/api/tls/issue" && req.method === "POST") {
      return json({ ok: true, certificate: await requestCertificate() });
    }
    if (u.pathname === "/api/roots/save" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), name = String(x.name || "").trim(),
        path = await Deno.realPath(String(x.path || "")), rootId = Number(x.id) || 0,
        enabled = !!x.enabled;
      if (!validRootName(name)) return json({ error: "Root name must be 1-128 characters and cannot contain slashes or control characters" }, 400);
      if (!(await Deno.stat(path)).isDirectory) return json({ error: "Root path is not a directory" }, 400);
      if (rootId) {
        run("UPDATE roots SET name=?,path=?,enabled=? WHERE id=? AND server_id=?",
          name, path, +enabled, rootId, p.id);
        if (!enabled) run("UPDATE contexts SET root_id=0,updated_at=? WHERE server_id=? AND root_id=?",
          Date.now(), p.id, rootId);
      } else run("INSERT INTO roots(server_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
        p.id, name, path, +enabled, Date.now());
      return json({ ok: true });
    }
    if (u.pathname === "/api/roots/delete" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), root = one(
        "SELECT * FROM roots WHERE id=? AND server_id=?", Number(x.id), p.id,
      );
      if (!root) return json({ error: "Root not found" }, 404);
      run("UPDATE contexts SET root_id=0,updated_at=? WHERE server_id=? AND root_id=?",
        Date.now(), p.id, root.id);
      run("DELETE FROM roots WHERE id=?", root.id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/context/select" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), context = contextById(p, Number(x.id));
      if (!context) return json({ error: "Context not found" }, 404);
      return json({ ok: true, context: selectContextRoot(p, context, Number(x.root_id) || 0) });
    }
    if (u.pathname === "/api/context/delete" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), context = contextById(p, Number(x.id));
      if (!context) return json({ error: "Context not found" }, 404);
      run("DELETE FROM contexts WHERE id=?", context.id);
      for (const key of [...jsKernels.keys()])
        if (key.startsWith(`${p.id}:${context.handle}:`)) destroyJsKernel(key, "context deleted");
      return json({ ok: true });
    }
    if (u.pathname === "/api/processes" && req.method === "GET") {
      return json({
        active: [...processes.values()]
          .filter(r => ["starting", "running"].includes(r.status))
          .map(r => processSummary(r)),
      });
    }
    let processMatch = u.pathname.match(/^\/api\/processes\/([^/]+)$/);
    if (processMatch && req.method === "GET") {
      const rec = processes.get(processMatch[1]);
      return json(rec ? processView(rec) : one("SELECT * FROM process_runs WHERE id=?", processMatch[1]) || { error: "Not found" });
    }
    if (u.pathname === "/api/processes/kill" && req.method === "POST") {
      const x = await bodyJson(req), rec = processes.get(String(x.id));
      return json({ ok: !!rec && await terminateProcess(rec, x.signal || "SIGTERM") });
    }
    if (u.pathname === "/api/processes/write" && req.method === "POST") {
      const x = await bodyJson(req), rec = processes.get(String(x.id));
      if (!rec?.stdin_writer) return json({ error: "Process stdin is closed" }, 400);
      if (x.data) await rec.stdin_writer.write(x.encoding === "base64"
        ? new Uint8Array(Buffer.from(String(x.data), "base64")) : enc.encode(String(x.data)));
      if (x.close) { await rec.stdin_writer.close(); rec.stdin_writer = null; }
      return json({ ok: true });
    }
    if (u.pathname === "/api/tools/save" && req.method === "POST") {
      const x = await bodyJson(req);
      if (BASE_TOOLS.includes(x.name)) return json({ error: "Name conflicts with a base tool" }, 400);
      if (x.id) run("UPDATE custom_tools SET server_id=?,name=?,description=?,command=? WHERE id=?",
        x.server_id, x.name, x.description || "", x.command, x.id);
      else run(`INSERT INTO custom_tools(server_id,name,description,command,created_at)
        VALUES(?,?,?,?,?)`, x.server_id, x.name, x.description || "", x.command, Date.now());
      return json({ ok: true });
    }
    if (u.pathname === "/api/tools/delete" && req.method === "POST") {
      const x = await bodyJson(req); run("DELETE FROM custom_tools WHERE id=?", x.id); return json({ ok: true });
    }
    if (u.pathname === "/api/mcp/self-test" && req.method === "GET")
      return json(mcpSelfTest(serverConfig()));
    if (u.pathname === "/api/commands" && req.method === "GET") return json(await commandCatalog({
      query: u.searchParams.get("q") || "",
      page: u.searchParams.get("page") || 1,
      page_size: u.searchParams.get("page_size") || 25,
      include_missing: u.searchParams.get("include_missing") !== "0",
      admin: true,
    }));
    if (u.pathname === "/api/commands/save" && req.method === "POST") {
      const x = await bodyJson(req), name = String(x.name || "").trim(), old = String(x.old_name || "").trim();
      if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(name)) return json({ error: "Invalid command name" }, 400);
      let target;
      try { target = await binPath(String(x.path || "").trim() || name); } catch (e) { return json({ error: String(e.message || e) }, 400); }
      const row = normalizeCommandEntry({
        logical_name: name,
        path: target.relative,
        description: x.description,
        download_url: x.download_url,
        documentation_url: x.documentation_url,
      });
      const rows = await readCommandConfig(), oldKey = old.toLowerCase(), key = name.toLowerCase();
      if (rows.some(existing => existing.name.toLowerCase() === key && existing.name.toLowerCase() !== oldKey)) return json({ error: "Command name already exists" }, 409);
      const index = rows.findIndex(existing => existing.name.toLowerCase() === oldKey || (!old && existing.name.toLowerCase() === key));
      if (index >= 0) rows[index] = row; else rows.push(row);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      await writeCommandConfig(rows);
      emitUiChange(["commands", "dashboard", "endpoints"], "commands");
      return json({ ok: true, config_file: COMMANDS_PATH });
    }
    if (u.pathname === "/api/commands/delete" && req.method === "POST") {
      const x = await bodyJson(req), key = String(x.name || "").toLowerCase();
      await writeCommandConfig((await readCommandConfig()).filter(row => row.name.toLowerCase() !== key));
      emitUiChange(["commands", "dashboard", "endpoints"], "commands");
      return json({ ok: true });
    }
    if (u.pathname === "/api/commands/download" && req.method === "POST") {
      const x = await bodyJson(req), key = String(x.name || "").toLowerCase();
      const row = (await readCommandConfig()).find(entry => entry.name.toLowerCase() === key);
      if (!row) return json({ error: "Command not found" }, 404);
      if (!row.download_url) return json({ error: "No download URL configured" }, 400);
      let target, temporary;
      try {
        const response = await fetch(row.download_url, { redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
        if (!/^https?:$/.test(new URL(response.url).protocol)) throw new Error("Download redirected to an unsupported URL scheme");
        const filename = responseFilename(response);
        const zipped = filename.toLowerCase().endsWith(".zip") || /(?:^|\b)(?:application|binary)\/(?:x-)?zip(?:\b|$)/i.test(response.headers.get("content-type") || "");
        let archiveEntry = null, content = null;
        if (zipped) {
          const declared = Number(response.headers.get("content-length") || 0);
          if (declared > 512 * 1024 * 1024) throw new Error("ZIP download is too large");
          const archive = new Uint8Array(await response.arrayBuffer());
          if (archive.byteLength > 512 * 1024 * 1024) throw new Error("ZIP download is too large");
          archiveEntry = selectZipCommandEntry(archive, row);
          content = extractZipEntry(archive, archiveEntry);
          target = await archiveCommandTarget(row.path, basename(archiveEntry.name.replaceAll("\\", "/")));
        } else target = await downloadCommandTarget(row.path, response);
        const current = await Deno.stat(target.path).catch(e => {
          if (e instanceof Deno.errors.NotFound) return null;
          throw e;
        });
        if (current && !x.overwrite) return json({
          error: `Target already exists: ${target.relative}`,
          path: target.relative,
          exists: true,
        }, 409);
        temporary = `${target.path}.${crypto.randomUUID()}.download`;
        await Deno.mkdir(dirname(target.path), { recursive: true });
        if (content) await Deno.writeFile(temporary, content, { createNew: true });
        else {
          const file = await Deno.open(temporary, { createNew: true, write: true });
          try { await response.body.pipeTo(file.writable); } catch (e) { try { file.close(); } catch {} throw e; }
        }
        if (Deno.build.os !== "windows") await Deno.chmod(temporary, 0o755);
        if (!current) await Deno.rename(temporary, target.path);
        else if (Deno.build.os !== "windows") await Deno.rename(temporary, target.path);
        else {
          const backup = `${target.path}.${crypto.randomUUID()}.previous`;
          await Deno.rename(target.path, backup);
          try {
            await Deno.rename(temporary, target.path);
            await Deno.remove(backup);
          } catch (e) {
            await Deno.remove(target.path).catch(() => {});
            await Deno.rename(backup, target.path).catch(() => {});
            throw e;
          }
        }
        temporary = "";
      } catch (e) {
        if (temporary) await Deno.remove(temporary).catch(() => {});
        return json({ error: String(e.message || e) }, 400);
      }
      const stat = await Deno.stat(target.path);
      emitUiChange(["commands", "dashboard", "endpoints"], "commands");
      return json({ ok: true, path: target.relative, size: stat.size, executable: executableFile(target.relative, stat) });
    }
    if (u.pathname === "/api/debug/settings" && req.method === "POST") {
      const x = await bodyJson(req);
      setCfg("debug_http_log", +!!x.enabled);
      return json({ ok: true, enabled: getCfg("debug_http_log", "0") === "1" });
    }
    if (u.pathname === "/api/debug" && req.method === "GET") {
      if (getCfg("debug_http_log", "0") !== "1") return json([]);
      const q = (u.searchParams.get("q") || "").trim();
      const method = u.searchParams.get("method") || "";
      const status = u.searchParams.get("status") || "";
      const limit = Math.min(Number(u.searchParams.get("limit") || 300), 1000);
      const like = `%${q}%`;
      return json(all(`SELECT id,ts,method,path,status,duration_ms,remote_addr,
        substr(request_body,1,180) request_preview,substr(error,1,180) error_preview
        FROM debug_logs WHERE (?='' OR method=?) AND (?='' OR CAST(status AS TEXT)=?)
        AND (?='' OR method||path||request_headers||request_body||response_headers||response_body||error LIKE ?)
        ORDER BY id DESC LIMIT ?`,
        method, method, status, status, q, like, limit));
    }
    let dm = u.pathname.match(/^\/api\/debug\/(\d+)$/);
    if (dm && req.method === "GET") return json(
      one("SELECT * FROM debug_logs WHERE id=?", Number(dm[1])) || { error: "Not found" }
    );
    if (u.pathname === "/api/debug/clear" && req.method === "POST") {
      run("DELETE FROM debug_logs");
      return json({ ok: true });
    }
    if (u.pathname === "/api/logs" && req.method === "GET") {
      const q = (u.searchParams.get("q") || "").trim();
      const contextId = Math.max(0, Number(u.searchParams.get("context")) || 0);
      const status = u.searchParams.get("status") || "";
      const page = Math.max(1, Number(u.searchParams.get("page")) || 1);
      const pageSize = Math.max(10, Math.min(Number(u.searchParams.get("page_size")) || 25, 100));
      const offset = (page - 1) * pageSize;
      let rows, total;
      if (q && fts) {
        try {
          total = one(`SELECT COUNT(*) n FROM logs_fts f JOIN logs l ON l.id=CAST(f.log_id AS INTEGER)
            WHERE logs_fts MATCH ? AND (?=0 OR l.context_id=?) AND (?='' OR l.status=?)`,
            q, contextId, contextId, status, status)?.n || 0;
          rows = all(`SELECT l.id,l.started_at,l.completed_at,l.context_id,l.tool,l.status,l.duration_ms
            FROM logs_fts f JOIN logs l ON l.id=CAST(f.log_id AS INTEGER)
            WHERE logs_fts MATCH ? AND (?=0 OR l.context_id=?) AND (?='' OR l.status=?)
            ORDER BY l.started_at DESC LIMIT ? OFFSET ?`,
            q, contextId, contextId, status, status, pageSize, offset);
        } catch {}
      }
      if (!rows) {
        const like = `%${q}%`;
        total = one(`SELECT COUNT(*) n FROM logs WHERE (?=0 OR context_id=?) AND (?='' OR status=?)
          AND (?='' OR CAST(context_id AS TEXT)||context_handle||tool||input_json||result_json||resolved_json||stdout||stderr||error LIKE ?)`,
          contextId, contextId, status, status, q, like)?.n || 0;
        rows = all(`SELECT id,started_at,completed_at,context_id,tool,status,duration_ms FROM logs
          WHERE (?=0 OR context_id=?) AND (?='' OR status=?)
          AND (?='' OR CAST(context_id AS TEXT)||context_handle||tool||input_json||result_json||resolved_json||stdout||stderr||error LIKE ?)
          ORDER BY started_at DESC LIMIT ? OFFSET ?`,
          contextId, contextId, status, status, q, like, pageSize, offset);
      }
      const processByLog = new Map([...processes.values()]
        .filter(record => record.log_id && ["starting", "running"].includes(record.status))
        .map(record => [record.log_id, record]));
      rows = rows.map(row => {
        const process = processByLog.get(row.id), control = activeCallControls.get(row.id);
        return { ...row, killable: !!process || !!control?.cancel,
          process_id: process?.id || control?.process_id || "" };
      });
      return json({ rows, page, page_size: pageSize, total,
        pages: Math.max(1, Math.ceil(total / pageSize)), has_more: offset + rows.length < total });
    }
    const logKill = u.pathname.match(/^\/api\/logs\/(\d+)\/kill$/);
    if (logKill && req.method === "POST") {
      const logId = Number(logKill[1]), x = await bodyJson(req);
      const signal = x.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
      let stopped = false;
      const process = [...processes.values()].find(record =>
        record.log_id === logId && ["starting", "running"].includes(record.status));
      if (process) stopped = await terminateProcess(process, signal) || stopped;
      const control = activeCallControls.get(logId);
      if (!process && control?.cancel) stopped = !!(await control.cancel(signal)) || stopped;
      return json({ ok: stopped, signal, process_id: process?.id || control?.process_id || "" });
    }
    const lm = u.pathname.match(/^\/api\/logs\/(\d+)$/);
    if (lm && req.method === "GET") return json(
      one(`SELECT id,started_at,completed_at,server_id,server_name,tool,status,input_json,resolved_json,
        stdout,stderr,error,result_json,duration_ms,context_id,context_handle FROM logs WHERE id=?`, Number(lm[1])) || { error: "Not found" }
    );
    if (u.pathname === "/api/logs/delete" && req.method === "POST") {
      const x = await bodyJson(req);
      if (x.id) {
        const id = Number(x.id);
        run("DELETE FROM logs WHERE id=?", id);
        if (fts) run("DELETE FROM logs_fts WHERE log_id=?", id);
      }
      return json({ ok: true });
    }
    if (u.pathname === "/api/oauth/revoke-client" && req.method === "POST") {
      const x = await bodyJson(req);
      run("DELETE FROM oauth_tokens WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_refresh_tokens WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_codes WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_clients WHERE client_id=?", x.client_id);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  // Eta renders server-side only. Morphlex is vendored locally and served by this process.
  const UI_CSP = "default-src 'self';base-uri 'none';object-src 'none';frame-ancestors 'self' http://127.0.0.1:*;form-action 'self';style-src 'unsafe-inline';script-src 'self';connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:* ws://localhost:*;img-src 'self' data:";
  const UI_TEMPLATE = String.raw`<!doctype html><html><head><meta charset=utf-8>
<meta name=mrmcp-csrf content="__MRMCP_CSRF__">
<meta http-equiv="Content-Security-Policy" content="${UI_CSP}">
<meta name=viewport content="width=device-width,initial-scale=1"><title>🧩 MrMCP</title><style>
:root{font:14px system-ui;color:#e8e8e8;background:#101114}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding-top:54px}header{position:fixed;inset:0 0 auto 0;z-index:1000;height:54px;display:flex;align-items:center;padding:0 18px;background:#17191e;border-bottom:1px solid #292c33}header b{font-size:18px}.status{margin-left:auto;color:#8b949e;display:flex;gap:8px;align-items:center}aside{position:fixed;top:54px;bottom:0;width:170px;background:#15171b;padding:12px;border-right:1px solid #292c33;overflow:auto}aside button{display:block;width:100%;text-align:left;margin:3px 0;background:transparent;border:0}aside button.nav-active{background:#252a33;color:#fff;font-weight:650;border-left:3px solid #3984e8;padding-left:6px}main{margin-left:170px;padding:16px;max-width:1500px}.page{display:block}.banner{display:none;margin-left:170px;padding:9px 18px;background:#5a2020;color:#ffd7d7}button,input,select,textarea{font:inherit;color:#eee;background:#22252b;border:1px solid #3a3e47;border-radius:6px;padding:7px 9px}button{cursor:pointer}button:hover{background:#2d3139}.danger{color:#ff8585}.primary{background:#2459a8}.small{padding:4px 8px;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.card{background:#181a1f;border:1px solid #2c3037;border-radius:10px;padding:14px;margin-bottom:10px}.tls-alert{border:2px solid #b94a4a;background:#241718}.tls-good{border:2px solid #347a49}.tls-error{max-height:180px;background:#160909}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:180px}.urlrow{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #292d34}.urlrow:last-child{border-bottom:0}.urlrow code{overflow-wrap:anywhere}.label,.muted{color:#89909b}label{display:block;color:#aaa;margin:8px 0 4px}table{width:100%;border-collapse:collapse;background:#181a1f}th,td{padding:8px;border-bottom:1px solid #2b2e35;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#090a0c;padding:12px;border-radius:8px;max-height:58vh;overflow:auto}code{color:#9ecbff}.ok,.completed{color:#75d58b}.failed,.killed,.timed_out{color:#ff8585}.pending,.running{color:#ffd166}.tools{columns:3;min-width:500px}dialog{color:#eee;background:#17191e;border:1px solid #444;border-radius:10px;width:min(880px,94vw)}dialog::backdrop{background:#0009}textarea{width:100%;min-height:78px}h2{margin-top:0}.nowrap{white-space:nowrap}tr[data-action=select-log],tr[data-action=select-debug]{cursor:pointer}tr[data-action=select-log]:hover,tr[data-action=select-debug]:hover{background:#20242a}.detail-row td{padding:0 8px 10px;background:#111318}.detail-panel{border:1px solid #343944;border-radius:8px;background:#0d0f12;padding:10px}.detail-panel pre{margin:8px 0 0;max-height:46vh}.json-detail{margin-top:12px}.json-detail+.json-detail{padding-top:12px;border-top:1px solid #292d34}.idcell{font-variant-numeric:tabular-nums;white-space:nowrap}.menu-icon{display:inline-block;width:22px;text-align:center}.context-id{overflow-wrap:anywhere}.log-pagination{margin:8px 0 10px}.pagination{display:flex;gap:3px;align-items:center}.page-button{min-width:34px;height:34px;padding:4px 8px;border-color:#30343d;background:#1b1e24}.page-button.active{background:#3984e8;border-color:#3984e8;color:white}.page-button:disabled{opacity:.35;cursor:default}.page-ellipsis{min-width:26px;text-align:center;color:#89909b}.dashboard-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(420px,1.25fr);gap:14px}.context-dates{min-width:240px}.context-dates>div{margin-bottom:4px}@media(max-width:900px){.dashboard-grid{grid-template-columns:1fr}}@media(max-width:800px){aside{width:130px}main,.banner{margin-left:130px}.urlrow{grid-template-columns:1fr}.tools{columns:1;min-width:0}}
</style></head><body>
<div id=app data-section=dashboard><header><b>🧩 MrMCP</b><div class=status><span class=pending>connecting…</span></div></header><main style="margin-left:0"><div class=card>Connecting to the MrMCP UI service…</div></main></div>
<script type=module src=/app.js></script></body></html>`;

  function browserAppSource() {/*
import { morphInner } from "/morphlex.js";
const app = document.getElementById("app");
let socket = null, renderStream = null, reconnectTimer = null, scrollTimer = null;
let sequence = 0, lastSentSequence = 0;
const outbox = [];
function wsUrl() {
  const url = new URL("/api/ui-input", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
function focusState(element = document.activeElement) {
  if (!element?.id) return null;
  return {
    id: element.id,
    start: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
    end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
  };
}
function send(event) {
  const envelope = { sequence: ++sequence, event: {
    ...event,
    focus: event.focus || focusState(),
    viewport: { section: app.dataset.section || "dashboard", x: scrollX, y: scrollY },
  } };
  lastSentSequence = envelope.sequence;
  const encoded = JSON.stringify(envelope);
  if (socket?.readyState === WebSocket.OPEN) socket.send(encoded);
  else outbox.push(encoded);
}
function flushOutbox() {
  while (socket?.readyState === WebSocket.OPEN && outbox.length) socket.send(outbox.shift());
}
function connectInput() {
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = new WebSocket(wsUrl());
  socket.addEventListener("open", () => { flushOutbox(); send({ type: "bootstrap" }); });
  socket.addEventListener("close", () => { reconnectTimer = setTimeout(connectInput, 500); });
}
function collectValues(scope) {
  const values = {};
  for (const element of scope.querySelectorAll("input[id],select[id],textarea[id]"))
    values[element.id] = element.type === "checkbox" ? element.checked : element.value;
  return values;
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(String(value || "")); }
  catch {
    const area = document.createElement("textarea");
    area.value = String(value || ""); document.body.append(area); area.select();
    document.execCommand("copy"); area.remove();
  }
}
function applyRender(payload) {
  const preserveChanges = Number(payload.ack || 0) < lastSentSequence;
  morphInner(app, payload.html, { preserveChanges });
  app.dataset.section = String(payload.section || "dashboard");
  const dialog = app.querySelector("[data-managed-dialog]");
  if (dialog && !dialog.open) dialog.showModal();
  const scroll = Array.isArray(payload.scroll) ? payload.scroll : [0, 0];
  requestAnimationFrame(() => {
    scrollTo(Number(scroll[0]) || 0, Number(scroll[1]) || 0);
    const focus = payload.focus;
    const element = focus?.id ? document.getElementById(focus.id) : null;
    if (element) {
      element.focus({ preventScroll: true });
      if (typeof element.setSelectionRange === "function" && Number.isInteger(focus.start))
        element.setSelectionRange(focus.start, Number.isInteger(focus.end) ? focus.end : focus.start);
    }
  });
}
function connectRenderStream() {
  renderStream?.close();
  renderStream = new EventSource("/api/events");
  renderStream.addEventListener("render", event => {
    try { applyRender(JSON.parse(event.data)); }
    catch (error) { console.error("MrMCP render failed", error); }
  });
}
document.addEventListener("click", event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) { copyText(copy.dataset.copy); return; }
  const actionElement = event.target.closest("[data-action]");
  if (actionElement?.dataset.action === "copy-detail") {
    const target = document.getElementById(actionElement.dataset.target || "");
    if (target) copyText(target.textContent);
    return;
  }
  const page = event.target.closest("[data-page]");
  if (page) { send({ type: "navigate", section: page.dataset.page }); return; }
  if (actionElement) {
    const scope = actionElement.closest("form,section") || app;
    send({ type: "action", action: actionElement.dataset.action, dataset: { ...actionElement.dataset }, values: collectValues(scope) });
  }
});
document.addEventListener("change", event => {
  const element = event.target;
  if (!element.id && !element.dataset.action) return;
  send({ type: "change", id: element.id || "", value: element.value, checked: !!element.checked, dataset: { ...element.dataset } });
});
document.addEventListener("input", event => {
  const element = event.target;
  if (!element.id) return;
  send({ type: "input", id: element.id, value: element.value, checked: !!element.checked, focus: focusState(element) });
});
document.addEventListener("focusin", event => {
  if (event.target?.id) send({ type: "focus", focus: focusState(event.target) });
});
document.addEventListener("submit", event => {
  event.preventDefault();
  send({ type: "submit", formId: event.target.id || "", values: collectValues(event.target) });
});
document.addEventListener("cancel", event => {
  if (event.target.matches("[data-managed-dialog]")) {
    event.preventDefault();
    send({ type: "action", action: "close-dialog", dataset: {}, values: {} });
  }
}, true);
document.addEventListener("keydown", event => {
  if (event.key !== "Enter" || !["logQuery", "debugQuery", "commandQuery"].includes(event.target.id)) return;
  event.preventDefault();
  send({ type: "enter", id: event.target.id, value: event.target.value, focus: focusState(event.target) });
});
addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => send({
    type: "scroll", section: app.dataset.section || "dashboard", x: scrollX, y: scrollY,
  }), 80);
}, { passive: true });
connectInput();
connectRenderStream();
*/}

  const BROWSER_JS = browserAppSource.toString().match(/\/\*([\s\S]*)\*\//)[1];
  const PAGE_TEMPLATE = UI_TEMPLATE.replace("__MRMCP_CSRF__", "<?= it.csrf ?>");
  function ui() { return eta.renderString(PAGE_TEMPLATE, { csrf: CSRF }); }

  async function guiHandler(req) {
    const u = new URL(req.url);
    if (u.pathname === "/login" && u.searchParams.get("token") === ADMIN_TOKEN) return new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": `mrmcp_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/` },
    });
    if (!hasSession(req)) return text("Unauthorized", 401);
    if (u.pathname.startsWith("/api/")) return await guiApi(req, u);
    if (u.pathname === "/app.js") return text(BROWSER_JS, 200, "text/javascript; charset=utf-8", {
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    });
    if (u.pathname === "/morphlex.js") {
      const source = await Deno.readTextFile(join(MODULE_DIR, "morphlex.js"));
      return text(source, 200, "text/javascript; charset=utf-8", {
        "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
      });
    }
    if (u.pathname === "/" || u.pathname === "/index.html") return text(ui(), 200, "text/html; charset=utf-8", {
      "cache-control": "no-store",
      "content-security-policy": UI_CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    return text("Not found", 404);
  }

  const guiServer = Deno.serve({ hostname: "127.0.0.1", port: GUI_PORT, onListen() {} }, req =>
    guiHandler(req).catch(e => json({ error: String(e?.stack || e) }, 500)));
  restoreAcmeBackoff();
  await detectPublicIp().catch(error => setCfg("tls_last_error", [
    getCfg("tls_last_error", ""), String(error?.message || error),
  ].filter(Boolean).join("\n")));
  await restartMcp();
  automaticRenewal().catch(() => {});
  renewalTimer = setInterval(automaticRenewal, 60 * 60 * 1000);
  processCleanupTimer = setInterval(maintenance, 60 * 60 * 1000);
  downloadCleanupTimer = setInterval(() => expireDownloadTokens().catch(() => {}), 60 * 1000);
  const readyPayload = {
    type: "ready",
    gui: `http://127.0.0.1:${GUI_PORT}/login?token=${encodeURIComponent(ADMIN_TOKEN)}`,
  };
  console.log(`MRMCP_READY ${JSON.stringify(readyPayload)}`);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const control of activeCallControls.values()) try { await control.cancel?.("SIGTERM"); } catch {}
    activeCallControls.clear();
    if (renewalTimer) clearInterval(renewalTimer);
    if (processCleanupTimer) clearInterval(processCleanupTimer);
    if (downloadCleanupTimer) clearInterval(downloadCleanupTimer);
    if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
    for (const key of [...jsKernels.keys()]) destroyJsKernel(key, "server shutdown");
    await Promise.allSettled(
      [...processes.values()]
        .filter(rec => ["starting", "running"].includes(rec.status))
        .map(rec => terminateProcess(rec, "SIGTERM")),
    );
    await Promise.race([
      Promise.allSettled([...processes.values()].map(rec => rec.done).filter(Boolean)),
      sleep(3000),
    ]);
    await Promise.allSettled([guiServer.shutdown(), mcpHttpServer?.shutdown(), mcpHttpsServer?.shutdown()]);
    await cleanupAllDownloadTokens();
    db.close();
  };
  try { Deno.addSignalListener("SIGINT", shutdown); } catch {}
  if (Deno.build.os !== "windows") try { Deno.addSignalListener("SIGTERM", shutdown); } catch {}
}


function pumpLines(stream, prefix, onLine = () => {}) {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) { if (line) console.log(`${prefix}${line}`); onLine(line); }
    }
    buffer += decoder.decode();
    if (buffer) { console.log(`${prefix}${buffer}`); onLine(buffer); }
  })();
}
async function spawnBackendForDesktop() {
  const admin = crypto.randomUUID().replaceAll("-", "");
  const scriptPath = fileURLToPath(SELF);
  const command = Deno.build.standalone
    ? new Deno.Command(Deno.execPath(), { args: ["--backend", "--admin", admin], stdout: "piped", stderr: "piped" })
    : new Deno.Command(Deno.execPath(), { args: ["run", "-A", scriptPath, "--backend", "--admin", admin], stdout: "piped", stderr: "piped" });
  const child = command.spawn();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  pumpLines(child.stdout, "[backend] ", line => {
    if (!line.startsWith("MRMCP_READY ")) return;
    try { const payload = JSON.parse(line.slice("MRMCP_READY ".length)); if (!payload.gui) throw new Error("Missing GUI URL"); readyResolve(payload); }
    catch (error) { readyReject(error); }
  }).catch(readyReject);
  pumpLines(child.stderr, "[backend:error] ").catch(() => {});
  child.status.then(status => { if (!status.success) readyReject(new Error(`MrMCP backend exited with code ${status.code}`)); });
  const payload = await Promise.race([ready, sleep(60_000).then(() => { throw new Error("MrMCP backend startup timed out"); })]);
  return { child, payload };
}
async function stopChild(child) {
  if (!child) return;
  try { child.kill("SIGTERM"); } catch { try { child.kill("SIGKILL"); } catch {} }
  await Promise.race([child.status.catch(() => {}), sleep(3000)]);
}
async function desktop() {
  const { child: backendChild, payload } = await spawnBackendForDesktop();
  try {
    const { Webview, SizeHint } = await import("jsr:@webview/webview@0.9.0");
    const webview = new Webview(true, { width: 1180, height: 760, hint: SizeHint.NONE });
    webview.title = "🧩 MrMCP";
    webview.navigate(payload.gui);
    webview.run();
  } finally {
    await stopChild(backendChild);
  }
}

if (Deno.args.includes("--backend")) await backend();
else await desktop();
