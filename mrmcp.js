/*
MrMCP 0.10.93 — request-scoped process progress, persistent exec attach and live Tool Call activity.
Runtime data: .mrmcp beside the script or standalone executable.
Run desktop GUI: deno run -A --unstable-ffi mrmcp.js
Run headless backend: deno run -A mrmcp.js --backend
GUI library: Tauriless, imported directly from npm by Deno.
*/

import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { Eta } from "jsr:@bgub/eta@4.6.0";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.1.2";
import { contentType as mediaContentType, typeByExtension } from "jsr:@std/media-types@1.1.0";
import { Tauriless } from "npm:@mefistofelix/tauriless@0.1.11";

const SELF = new URL(import.meta.url);
const IS_BACKEND_WORKER = globalThis.name === "mrmcp-backend";
const MODULE_DIR = dirname(fileURLToPath(SELF));
const ASSETS_DIR = join(MODULE_DIR, "assets");
const APP_DIR = Deno.build.standalone ? dirname(Deno.execPath()) : MODULE_DIR;
const COMMANDS_TEMPLATE_PATH = join(MODULE_DIR, "commands.yaml");
const COMMANDS_PATH = join(APP_DIR, "commands.yaml");
const PORT_FALLBACK_STEP = 50;
const UI_INPUT_EVENT = "tauriless://webview-message", UI_RENDER_EVENT = "mrmcp://ui-render";
const BASE_TOOLS = [
  "list_workspaces", "open_workspace", "read_file", "read_files", "write_file", "write_files",
  "edit", "replace", "glob", "grep",
  "file_info", "create_directory", "copy_path", "move_path", "trash_paths", "untrash_action",
  "publish_file", "publish_html", "list_commands", "query_tool_calls", "exec", "exec_start", "exec_attach", "exec_write", "exec_kill", "exec_list",
  "js", "js_add_node_module_dir", "js_reset",
];
const READ_TOOLS = new Set([
  "list_workspaces", "read_file", "read_files", "glob", "grep",
  "file_info", "list_commands", "query_tool_calls", "exec_attach", "exec_list",
]);
const MCP_MODERN_PROTOCOL = "2026-07-28";
const MCP_PROTOCOLS = [MCP_MODERN_PROTOCOL];
const MCP_DEFAULT_PROTOCOL = MCP_MODERN_PROTOCOL;
const VERSION = "0.10.93";
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ACTIVE_MS = 10 * 60 * 1000, DASHBOARD_TOOL_CALL_TTL_MS = 3000;
const CONTEXT_HANDLE_INPUT_DESCRIPTION = "Required opaque capability returned by open_workspace. Pass the exact value unchanged; never invent, modify, shorten, derive or substitute it.";
const CONTEXT_HANDLE_OUTPUT_DESCRIPTION = "Opaque capability identifying a persistent Session. Pass this exact value unchanged as context_handle on later calls.";
const CONTEXT_HANDLE_RULE = "Requires the exact Session context_handle returned by open_workspace.";
const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";
const FILE_PREVIEW_UI_URI = "ui://mrmcp/file-preview-v4.html";
const HTML_PREVIEW_UI_URI = "ui://mrmcp/html-preview-v1.html";
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
const waitFor = async (promise, ms, fallback) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally { clearTimeout(timer); }
};
const uid = () => crypto.randomUUID();
const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async value => b64url(new Uint8Array(
  await crypto.subtle.digest("SHA-256", value instanceof Uint8Array ? value : enc.encode(String(value))),
));
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const MAX_REQUEST_BODY = 2 * 1024 * 1024;
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
const MCP_PROGRESS_BATCH_BYTES = 16 * 1024, MCP_PROGRESS_BATCH_MS = 100;
const MCP_ATTACH_RESPONSE_BYTES = MCP_PROGRESS_BATCH_BYTES, MCP_ATTACH_RESPONSE_MS = MCP_PROGRESS_BATCH_MS;
function progressTextChunks(value, maxBytes = MCP_PROGRESS_BATCH_BYTES) {
  let text = String(value ?? "");
  const chunks = [];
  while (text) {
    let high = Math.min(text.length, maxBytes);
    if (high < text.length && /[\uD800-\uDBFF]/.test(text[high - 1]) && /[\uDC00-\uDFFF]/.test(text[high])) high--;
    let candidate = text.slice(0, high), bytes = enc.encode(candidate).byteLength;
    if (bytes > maxBytes) {
      let low = 1, best = 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const size = enc.encode(text.slice(0, middle)).byteLength;
        if (size <= maxBytes) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best < text.length && /[\uD800-\uDBFF]/.test(text[best - 1]) && /[\uDC00-\uDFFF]/.test(text[best])) best--;
      candidate = text.slice(0, Math.max(1, best));
    }
    chunks.push(candidate);
    text = text.slice(candidate.length);
  }
  return chunks;
}
function textPrefixByBytes(value, maxBytes) {
  const text = String(value ?? "");
  if (!text) return "";
  let high = Math.min(text.length, maxBytes);
  if (high < text.length && /[\uD800-\uDBFF]/.test(text[high - 1]) && /[\uDC00-\uDFFF]/.test(text[high])) high--;
  let candidate = text.slice(0, high);
  if (enc.encode(candidate).byteLength <= maxBytes) return candidate;
  let low = 1, best = 1;
  while (low <= high) {
    const middle = (low + high) >> 1, slice = text.slice(0, middle);
    if (enc.encode(slice).byteLength <= maxBytes) { best = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (best < text.length && /[\uD800-\uDBFF]/.test(text[best - 1]) && /[\uDC00-\uDFFF]/.test(text[best])) best--;
  return text.slice(0, Math.max(1, best));
}
function acceptsMediaType(value, mediaType) {
  mediaType = String(mediaType).toLowerCase();
  return String(value || "").split(",").some(item => {
    const [rawType, ...params] = item.trim().toLowerCase().split(";");
    if (rawType !== mediaType && rawType !== "*/*") return false;
    const q = params.map(param => param.trim()).find(param => param.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}
function createMcpProgressSink(send, progressToken) {
  let pending = "", pendingBytes = 0, timer = null, progress = 0, closed = false, afterFlush = null;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const flush = () => {
    clearTimer();
    if (closed || progressToken == null || !pending) return false;
    const message = pending, bytes = pendingBytes;
    pending = ""; pendingBytes = 0; progress += bytes;
    send({
      jsonrpc: "2.0", method: "notifications/progress",
      params: { progressToken, progress, message },
    });
    afterFlush?.(message, bytes);
    return true;
  };
  const push = value => {
    if (closed || progressToken == null) return;
    for (const chunk of progressTextChunks(value)) {
      const bytes = enc.encode(chunk).byteLength;
      if (pending && pendingBytes + bytes > MCP_PROGRESS_BATCH_BYTES) flush();
      pending += chunk; pendingBytes += bytes;
      if (pendingBytes >= MCP_PROGRESS_BATCH_BYTES) flush();
      else if (!timer) timer = setTimeout(flush, MCP_PROGRESS_BATCH_MS);
    }
  };
  return {
    push, flush,
    setAfterFlush(callback) { afterFlush = typeof callback === "function" ? callback : null; },
    close() { flush(); closed = true; clearTimer(); },
    cancel() { closed = true; clearTimer(); pending = ""; pendingBytes = 0; },
  };
}
function mcpSseResponse(id, progressToken, runner, headers = {}) {
  let closed = false, progressSink = null;
  const disconnectHandlers = new Set();
  const body = new ReadableStream({
    start(controller) {
      const send = message => {
        if (!closed) controller.enqueue(enc.encode(`data: ${JSON.stringify(message)}\n\n`));
      };
      progressSink = createMcpProgressSink(send, progressToken);
      const stream = {
        progress: progressSink,
        onDisconnect(callback) {
          if (typeof callback !== "function") return;
          if (closed) Promise.resolve().then(callback).catch(() => {});
          else disconnectHandlers.add(callback);
        },
      };
      Promise.resolve().then(() => runner(stream)).then(result => {
        if (closed) return;
        progressSink.close();
        send(result);
        closed = true;
        disconnectHandlers.clear();
        controller.close();
      }).catch(error => {
        if (closed) return;
        progressSink.close();
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message || error) } });
        closed = true;
        disconnectHandlers.clear();
        controller.close();
      });
    },
    cancel() {
      if (closed) return;
      closed = true;
      progressSink?.cancel();
      for (const callback of disconnectHandlers) Promise.resolve().then(callback).catch(() => {});
      disconnectHandlers.clear();
    },
  });
  return new Response(body, { status: 200, headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    ...headers,
  } });
}
const within = (root, path) => {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
};
const staticAssetResponse = async pathname => {
  let requested;
  try { requested = decodeURIComponent(String(pathname).slice("/assets/".length)); }
  catch { return text("Bad request", 400); }
  if (!requested || requested.includes("\0")) return text("Not found", 404);
  const path = resolve(ASSETS_DIR, requested.replaceAll("/", sep));
  if (!within(ASSETS_DIR, path)) return text("Not found", 404);
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return text("Not found", 404);
    const body = await Deno.readFile(path);
    return new Response(body, { headers: {
      "content-type": mediaContentType(extname(path).toLowerCase()) || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return text("Not found", 404);
    throw error;
  }
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
  if (Deno.build.standalone) {
    try { await Deno.lstat(COMMANDS_PATH); }
    catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const source = await Deno.readTextFile(COMMANDS_TEMPLATE_PATH);
      try { await Deno.writeTextFile(COMMANDS_PATH, source, { createNew: true }); }
      catch (writeError) { if (!(writeError instanceof Deno.errors.AlreadyExists)) throw writeError; }
    }
  }
  const DATA = join(APP_DIR, ".mrmcp");
  const TLS_DATA = DATA;
  const DB_PATH = join(DATA, "mrmcp.sqlite");
  const CERT_PATH = join(TLS_DATA, "fullchain.pem");
  const KEY_PATH = join(TLS_DATA, "privkey.pem");
  const SELF_CERT_PATH = join(TLS_DATA, "selfsigned.pem");
  const SELF_KEY_PATH = join(TLS_DATA, "selfsigned-key.pem");
  const PUBLIC_HOST = "0.0.0.0", HTTP_PORT = 80, HTTPS_PORT = 443;
  let mcpHttpPort = HTTP_PORT, mcpHttpsPort = HTTPS_PORT;
  const serveWithPortFallback = (basePort, start) => {
    for (let port = basePort; port <= 65535; port += PORT_FALLBACK_STEP) {
      try { return { server: start(port), port }; }
      catch (error) {
        if (!(error instanceof Deno.errors.AddrInUse) || port + PORT_FALLBACK_STEP > 65535) throw error;
      }
    }
    throw new Error(`No available listener port from ${basePort}`);
  };
  const BIN_DIR = join(DATA, "bin");
  const TEMP_DIR = join(DATA, "tmp");
  Deno.mkdirSync(BIN_DIR, { recursive: true });
  Deno.mkdirSync(DATA, { recursive: true });
  await Deno.remove(TEMP_DIR, { recursive: true }).catch(error => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  Deno.mkdirSync(TEMP_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  let uiRevision = 0, uiRenderConnected = false;
  const deliverUiRender = payload => {
    if (IS_BACKEND_WORKER) self.postMessage({ type: "ui-render", payload });
  };
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
  let uiRenderTimer = null, uiLogFilterTimer = null, uiNoticeTimer = null, uiRenderRunning = false, uiRenderQueued = false;
  let uiInputChain = Promise.resolve(), uiInputDepth = 0, uiInputRenderDelay = null;
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
    if (uiInputDepth) {
      const value = Math.max(0, Number(delay) || 0);
      uiInputRenderDelay = uiInputRenderDelay == null ? value : Math.min(uiInputRenderDelay, value);
      return;
    }
    if (!uiRenderConnected || uiRenderRunning || uiRenderTimer) return;
    uiRenderTimer = setTimeout(() => {
      uiRenderTimer = null;
      drainUiRenderQueue(reason).catch(error => {
        console.error("MrMCP UI render failed", error);
        uiRenderRunning = false;
        uiRenderQueued = false;
        const message = htmlEscape(String(error?.stack || error));
        deliverUiRender({
          revision: ++uiRevision,
          html: `<div id="app" data-section="${htmlEscape(uiState.currentSection)}"><header><div class=brand><img class=brand-mark src="${GUI_LOGO_DATA_URL}" alt=""><b>MrMCP <span class=muted>v${VERSION}</span></b></div></header><main style="margin-left:0"><div class="card tls-alert"><h2>UI Render Failed</h2><pre>${message}</pre></div></main></div>`,
          section: uiState.currentSection,
          scroll: [0, 0], focus: null, ack: uiState.lastInputSequence,
          reason: "render-error", at: Date.now(),
        });
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
        deliverUiRender({
          revision: ++uiRevision,
          html,
          section: uiState.currentSection,
          scroll: uiState.scrollBySection[uiState.currentSection] || [0, 0],
          focus: uiState.focus,
          ack: uiState.lastInputSequence,
          reason,
          at: Date.now(),
        });
        if (uiRenderQueued) await sleep(0);
      }
    } finally {
      uiRenderRunning = false;
      if (uiRenderQueued) queueUiRender("coalesced", 0);
    }
  }
  function uiScopesForSql(sql) {
    const statement = String(sql || "").trim().toLowerCase();
    if (!/^(?:insert|update|delete|replace)\b/.test(statement)) return [];
    const scopes = new Set();
    if (/\blogs\b/.test(statement)) ["logs", "sessions", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\btool_call_transport\b/.test(statement)) ["logs", "dashboard"].forEach(scope => scopes.add(scope));
    if (/\bcontexts\b/.test(statement)) ["sessions", "roots", "logs", "dashboard"].forEach(scope => scopes.add(scope));
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
    CREATE TABLE IF NOT EXISTS tool_call_descriptors(
      log_id INTEGER PRIMARY KEY,
      descriptor_json TEXT NOT NULL,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tool_call_transport(
      log_id INTEGER PRIMARY KEY,
      progress_requested INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );
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
      UNIQUE(name),
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
    CREATE TABLE IF NOT EXISTS published_html(
      id TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL,
      context_handle TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL,
      height INTEGER NOT NULL DEFAULT 600,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS published_html_time ON published_html(created_at DESC);
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
  const desktopNotificationEnabled = type => getCfg(`desktop_notifications_${type}`, getCfg("desktop_notifications", "1")) === "1";
  const postOsNotification = (type, title, body) => {
    if (IS_BACKEND_WORKER && desktopNotificationEnabled(type)) self.postMessage({ type: "os-notification", title, body });
  };
  const notificationAge = (timestamp, now = Date.now()) => {
    const minutes = Math.max(0, Math.floor((now - Number(timestamp || now)) / 60000));
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };
  const TOOL_PREVIEW_ARG_LIMIT = 6, TOOL_PREVIEW_ARG_CHARS = 48, TOOL_PREVIEW_TOTAL_CHARS = 180;
  const TOOL_PREVIEW_HIDDEN_ARGS = new Set(["context_handle", "current_context_handle"]);
  const compactPreviewValue = (value, limit = TOOL_PREVIEW_ARG_CHARS) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    const tail = Math.min(10, Math.max(0, limit - 2));
    return `${text.slice(0, Math.max(1, limit - tail - 1))}…${text.slice(-tail)}`;
  };
  const compactProgramName = value => {
    const text = String(value ?? "").trim();
    return text.split(/[\\/]/).pop() || text;
  };
  const compactExecArg = value => {
    const text = compactPreviewValue(value);
    return /^[A-Za-z0-9_./:\\@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
  };
  const compactToolArg = value => {
    if (typeof value === "string") return compactExecArg(value);
    if (value === null || ["number", "boolean", "bigint"].includes(typeof value)) return String(value);
    let text;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return compactPreviewValue(text);
  };
  const capToolPreview = (line, suffix = "") => {
    const available = Math.max(1, TOOL_PREVIEW_TOTAL_CHARS - suffix.length);
    return (line.length > available ? `${line.slice(0, Math.max(1, available - 1))}…` : line) + suffix;
  };
  const compactShellCommand = value => {
    let text = String(value ?? "").replace(/\s+/g, " ").trim();
    const quoted = text.match(/^"([^"]+)"(.*)$/) || text.match(/^'([^']+)'(.*)$/);
    if (quoted && /[\\/]/.test(quoted[1])) text = `${text[0]}${compactProgramName(quoted[1])}${text[0]}${quoted[2]}`;
    else {
      const first = text.match(/^(\S+)(.*)$/);
      if (first && /[\\/]/.test(first[1])) text = `${compactProgramName(first[1])}${first[2]}`;
    }
    return capToolPreview(text);
  };
  const compactExecCommand = (p, tool, args = {}) => {
    if (!String(tool || "").startsWith("exec")) return "";
    let spec = args && typeof args === "object" ? args : {};
    if (!["exec", "exec_start"].includes(tool)) {
      const label = String(spec.label || ""), handle = String(spec.context_handle || "");
      const live = label ? [...processes.values()].find(record =>
        record.persistent && record.label === label && (!handle || record.context_handle === handle)) : null;
      const command = live?.command_json ? parseJson(live.command_json, {}) : {};
      if (command?.program) spec = command.shell
        ? { shell_command: String(command.args?.at?.(-1) || command.args?.[command.args.length - 1] || "") }
        : { program: command.catalog_name || command.program, args: Array.isArray(command.args) ? command.args : [] };
    }
    if (typeof spec.shell_command === "string" && spec.shell_command) return compactShellCommand(spec.shell_command);
    if (typeof spec.program !== "string" || !spec.program) return "";
    const argv = Array.isArray(spec.args) ? spec.args : [], shown = argv.slice(0, TOOL_PREVIEW_ARG_LIMIT).map(compactExecArg);
    const omitted = Math.max(0, argv.length - shown.length), suffix = omitted ? ` … +${omitted} args` : "";
    return capToolPreview([compactProgramName(spec.program), ...shown].filter(Boolean).join(" "), suffix);
  };
  const compactToolCallPreview = (p, tool, args = {}) => {
    const command = compactExecCommand(p, tool, args);
    if (command) return command;
    if (!args || typeof args !== "object" || Array.isArray(args)) return compactToolArg(args);
    const entries = Object.entries(args).filter(([key]) => !TOOL_PREVIEW_HIDDEN_ARGS.has(key));
    const shown = entries.slice(0, TOOL_PREVIEW_ARG_LIMIT)
      .map(([key, value]) => `${key}=${compactToolArg(value)}`);
    const omitted = Math.max(0, entries.length - shown.length), suffix = omitted ? ` … +${omitted} args` : "";
    return capToolPreview(shown.join(" "), suffix);
  };
  const sessionNotificationLabel = (p, context, toolCalls = null, now = Date.now(), workspaceName = "") => {
    const count = toolCalls == null
      ? Number(one("SELECT COUNT(*) count FROM logs WHERE server_id=? AND context_id=?", p.id, context.id)?.count || 0)
      : Number(toolCalls || 0);
    const workspace = workspaceName || (Number(context.root_id || 0)
      ? one("SELECT name FROM roots WHERE server_id=? AND id=?", p.id, Number(context.root_id))?.name
      : "Program folder") || "Program folder";
    return `💬 Session #${context.id}\n• 📁 ${workspace}\n• 🕒 ${notificationAge(context.created_at, now)}\n• 🛠️ ${count} Tool Call${count === 1 ? "" : "s"}`;
  };
  const compactNotificationError = value => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  };
  const toolCallNotificationBody = (p, tool, args, contextHandle = "", root = null, error = "", progressRequested = false) => {
    const context = contextByHandle(p, contextHandle);
    const session = context ? sessionNotificationLabel(p, context, null, Date.now(), root?.name || "") : "";
    const preview = compactToolCallPreview(p, tool, args);
    return [
      session,
      `• 🔧 ${tool}${preview ? ` ${preview}` : ""}`,
      progressRequested && "• 📡 Progress requested",
      error && `• ⚠️ ${compactNotificationError(error)}`,
    ].filter(Boolean).join("\n");
  };
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
    tool_call_descriptors: ["log_id", "descriptor_json"],
    tool_call_transport: ["log_id", "progress_requested"],
    oauth_refresh_tokens: ["token_hash", "client_id", "server_id", "resource", "scope", "last_used_at"],
    published_html: ["id", "server_id", "context_handle", "title", "html", "height", "created_at"],
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
  const processes = new Map(), persistentProcessLabels = new Set(), jsKernels = new Map(), activeCallControls = new Map(),
    oauthConsents = new Map(), rateBuckets = new Map(), downloadTokens = new Map();
  let toolCallGate = null, toolCallsIdle = Promise.resolve(), resolveToolCallsIdle = null,
    maintenanceAction = "", maintenancePhase = "", waitingToolCalls = 0,
    headerActivityTimer = null, dashboardToolCallTimer = null;

  const maintenanceProjection = () => ({
    active: !!toolCallGate, action: maintenanceAction, phase: maintenancePhase,
    in_flight: activeCallControls.size, waiting: waitingToolCalls,
  });
  const emitMaintenance = () => emitUiChange(["dashboard", "settings"], "maintenance");
  const emitToolCallActivity = () => emitUiChange(["state"], "tool-call-activity");
  function dashboardToolCallsProjection(p) {
    const now = Date.now(), cutoff = now - DASHBOARD_TOOL_CALL_TTL_MS;
    const rows = all(`SELECT l.id,l.started_at,l.completed_at,l.context_id,l.tool,l.status,l.duration_ms,l.input_json,
      COALESCE(t.progress_requested,0) progress_requested
      FROM logs l LEFT JOIN tool_call_transport t ON t.log_id=l.id
      WHERE l.server_id=? AND (l.status IN ('received','running') OR l.completed_at>=?)
      ORDER BY l.started_at DESC`, p.id, cutoff).map(row => {
      const active = !row.completed_at && ["received", "running"].includes(row.status);
      return {
        id: Number(row.id), context_id: Number(row.context_id) || 0, tool: row.tool, status: row.status,
        call_preview: compactToolCallPreview(p, row.tool, parseJson(row.input_json || "{}", {})),
        progress_requested: !!row.progress_requested, active,
        elapsed_ms: Math.max(0, (active ? now : Number(row.completed_at || now)) - Number(row.started_at || now)),
        completed_age_ms: active ? null : Math.max(0, now - Number(row.completed_at || now)),
        ttl_ms: active ? null : Math.max(0, Number(row.completed_at || now) + DASHBOARD_TOOL_CALL_TTL_MS - now),
      };
    });
    if (dashboardToolCallTimer) clearTimeout(dashboardToolCallTimer);
    dashboardToolCallTimer = null;
    if (rows.length && uiRenderConnected) {
      const expiries = rows.filter(row => !row.active).map(row => now + Number(row.ttl_ms || 0));
      const next = Math.min(rows.some(row => row.active) ? now + 1000 : Infinity, ...expiries, Infinity);
      if (Number.isFinite(next)) dashboardToolCallTimer = setTimeout(() => {
        dashboardToolCallTimer = null;
        emitUiChange(["dashboard"], "dashboard-tool-call-tick");
      }, Math.max(50, next - now + 10));
    }
    return rows;
  }
  function headerActivityProjection(p) {
    const now = Date.now(), rows = all(`
      SELECT l.context_id, COUNT(*) tool_calls, MAX(l.started_at) last_at
      FROM logs l
      JOIN contexts c ON c.id=l.context_id AND c.server_id=l.server_id
      WHERE l.server_id=?
      GROUP BY l.context_id
      HAVING MAX(l.started_at)>=?
      ORDER BY last_at DESC
    `, p.id, now - SESSION_ACTIVE_MS);
    if (headerActivityTimer) clearTimeout(headerActivityTimer);
    headerActivityTimer = null;
    if (rows.length && uiRenderConnected) {
      const nextExpiry = Math.min(...rows.map(row => Number(row.last_at) + SESSION_ACTIVE_MS));
      headerActivityTimer = setTimeout(() => {
        headerActivityTimer = null;
        emitUiChange(["state"], "header-activity-expired");
      }, Math.max(50, nextExpiry - now + 10));
    }
    const toolCalls = one(`SELECT COUNT(*) total, SUM(status='failed') errors, SUM(status='invalid') invalid FROM logs WHERE server_id=?`, p.id) || {};
    return {
      active_sessions: rows.length,
      recent_sessions: rows.slice(0, 4).map(row => ({ id: Number(row.context_id), tool_calls: Number(row.tool_calls) || 0 })),
      tool_calls_total: Number(toolCalls.total) || 0,
      tool_calls_in_flight: activeCallControls.size,
      tool_calls_errors: Number(toolCalls.errors) || 0,
      tool_calls_invalid: Number(toolCalls.invalid) || 0,
      active_window_minutes: SESSION_ACTIVE_MS / 60000,
    };
  }
  async function waitForToolCallGate() {
    while (toolCallGate) {
      const gate = toolCallGate;
      waitingToolCalls++;
      emitMaintenance();
      try { await gate; }
      finally { waitingToolCalls--; emitMaintenance(); }
    }
  }
  async function withToolCallsDrained(action, operation) {
    while (toolCallGate) await toolCallGate;
    let release;
    toolCallGate = new Promise(resolve => { release = resolve; });
    maintenanceAction = action;
    maintenancePhase = "waiting";
    emitMaintenance();
    try {
      await toolCallsIdle;
      maintenancePhase = "running";
      emitMaintenance();
      return await operation();
    } finally {
      maintenanceAction = maintenancePhase = "";
      toolCallGate = null;
      release();
      emitMaintenance();
    }
  }
  async function clearOperationalDatabase() {
    return await withToolCallsDrained("database", () => {
      const cleared = {
        tool_calls: one("SELECT COUNT(*) n FROM logs")?.n || 0,
        process_runs: one("SELECT COUNT(*) n FROM process_runs")?.n || 0,
        http_logs: one("SELECT COUNT(*) n FROM debug_logs")?.n || 0,
        published_html: one("SELECT COUNT(*) n FROM published_html")?.n || 0,
        requests: one("SELECT value n FROM metrics WHERE name='requests'")?.n || 0,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM logs").run();
        if (fts) db.prepare("DELETE FROM logs_fts").run();
        db.prepare("DELETE FROM process_runs").run();
        db.prepare("DELETE FROM debug_logs").run();
        db.prepare("DELETE FROM published_html").run();
        db.prepare("UPDATE metrics SET value=0").run();
        db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('logs','debug_logs')").run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      for (const [id, record] of processes)
        if (!["starting", "running"].includes(record.status)) processes.delete(id);
      uiState.logs.page = 1;
      uiState.logs.openRowId = "";
      uiState.logs.selfTest = null;
      uiState.debug.openRowId = "";
      emitUiChange(["dashboard", "logs", "debug", "settings"], "database-clear");
      return { ok: true, cleared };
    });
  }
  const sealSecret = value => String(value || "");
  const openSecret = value => String(value || "");
  let shuttingDown = false, mcpHttpServer, mcpHttpsServer;
  let mcpHttpActive = false, mcpTlsActive = false, mcpTlsKind = "none";
  let mcpTlsValid = false, mcpTlsTrusted = false, mcpTlsInfo = null;
  let mcpListenError = "", renewalTimer, processCleanupTimer, downloadCleanupTimer;
  const listenerFallbacks = () => [
    mcpHttpActive && mcpHttpPort !== HTTP_PORT ? `HTTP ${HTTP_PORT}→${mcpHttpPort}` : "",
    mcpTlsActive && mcpHttpsPort !== HTTPS_PORT ? `HTTPS ${HTTPS_PORT}→${mcpHttpsPort}` : "",
  ].filter(Boolean);
  const acmeChallenges = new Map();

  const ipv4 = value => isIP(String(value || "").trim()) === 4;
  const sslipHostname = ip => {
    ip = String(ip || "").trim();
    const suffix = getCfg("sslip_suffix", "sslip.io").trim().replace(/^\.+|\.+$/g, "") || "sslip.io";
    return ipv4(ip) ? `${ip.replaceAll(".", "-")}.${suffix}` : "";
  };
  const httpsPortSuffix = () => mcpHttpsPort === 443 ? "" : `:${mcpHttpsPort}`;
  const localHttpsBase = () => `https://127.0.0.1${httpsPortSuffix()}`;
  const localBase = () => localHttpsBase();
  const directIpBase = () => {
    const ip = getCfg("public_ip", "").trim();
    return ipv4(ip) ? `https://${ip}${httpsPortSuffix()}` : "";
  };
  const sslipBase = () => {
    const host = sslipHostname(getCfg("public_ip", ""));
    return host ? `https://${host}${httpsPortSuffix()}` : "";
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
  const mcpIconUrl = () => `${publicBase()}/mrmcp-icon.png`;
  const mcpServerInfo = () => ({
    name: "MrMCP", version: VERSION,
    icons: [{ src: mcpIconUrl(), mimeType: "image/png" }],
  });
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
    description: "Sandboxed MCP App used by publish_file. It reads the temporary HTTPS URL from structuredContent, renders image files with a normal img element, and offers an Open File action for other MIME types.",
    mimeType: MCP_UI_MIME_TYPE,
    _meta: filePreviewUiMeta(),
  });
  function filePreviewAppHtml() {
    return String.raw`<!doctype html>
<html lang="en" data-mode="inline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MrMCP file preview</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body, main { margin: 0; width: 100%; min-width: 0; background: transparent; }
#imageStage { position: relative; display: none; width: 100%; place-items: center; overflow: hidden; }
#image { display: block; width: 100%; height: auto; object-fit: contain; }
#actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; opacity: .25; transition: opacity .15s; }
#imageStage:hover #actions, #actions:focus-within { opacity: 1; }
#actions button, #actions a { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid #ffffff55; border-radius: 8px; color: white; background: #000b; font: 20px/1 system-ui, sans-serif; text-decoration: none; cursor: pointer; }
#actions [hidden] { display: none; }
#fileStage { display: none; align-items: center; gap: 12px; padding: 14px; border: 1px solid #ffffff22; border-radius: 10px; font: 14px/1.35 system-ui, sans-serif; }
#fileIcon { font-size: 28px; }
#fileInfo { flex: 1; min-width: 0; }
#fileName { font-weight: 650; overflow-wrap: anywhere; }
#fileMeta { margin-top: 3px; opacity: .65; font-size: 12px; }
#fileOpen { padding: 7px 10px; border: 1px solid #ffffff33; border-radius: 8px; color: inherit; text-decoration: none; white-space: nowrap; }
#error { display: none; padding: 10px; color: var(--color-text-danger, #b42318); font: 14px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
html[data-mode="fullscreen"], html[data-mode="fullscreen"] body, html[data-mode="fullscreen"] main { height: 100%; overflow: hidden; }
html[data-mode="fullscreen"] #imageStage { display: grid; height: 100%; }
html[data-mode="fullscreen"] #image { width: 100%; height: 100%; }
@media (hover: none) { #actions { opacity: 1; } }
</style>
</head>
<body>
<main>
  <div id="imageStage">
    <img id="image" alt="Published image">
    <div id="actions">
      <button id="fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen" hidden>⛶</button>
      <a id="imageOpen" target="_blank" rel="noopener noreferrer" title="Open original" aria-label="Open original">↗</a>
    </div>
  </div>
  <div id="fileStage">
    <div id="fileIcon">📄</div>
    <div id="fileInfo"><div id="fileName"></div><div id="fileMeta"></div></div>
    <a id="fileOpen" target="_blank" rel="noopener noreferrer">Open File ↗</a>
  </div>
  <div id="error" role="alert"></div>
</main>
<script>
(function () {
  'use strict';
  var root = document.documentElement;
  var imageStage = document.getElementById('imageStage');
  var fileStage = document.getElementById('fileStage');
  var image = document.getElementById('image');
  var imageOpen = document.getElementById('imageOpen');
  var fileName = document.getElementById('fileName');
  var fileMeta = document.getElementById('fileMeta');
  var fileOpen = document.getElementById('fileOpen');
  var fullscreen = document.getElementById('fullscreen');
  var error = document.getElementById('error');
  var pending = new Map();
  var nextId = 1;
  var currentMode = 'inline';
  var fullscreenAvailable = false;
  var currentIsImage = false;

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
    fullscreen.hidden = !fullscreenAvailable || !currentIsImage;
  }
  function formatSize(value) {
    var size = Number(value || 0);
    if (!size) return '';
    if (size < 1024) return size + ' B';
    if (size < 1048576) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1048576).toFixed(1) + ' MB';
  }
  function render(result) {
    result = result || {};
    var structured = result.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent : result;
    var uri = typeof structured.uri === 'string' ? structured.uri : '';
    var mime = String(structured.mime_type || '').toLowerCase();
    var filename = String(structured.filename || 'Published file');
    currentIsImage = mime.indexOf('image/') === 0;
    imageStage.style.display = 'none';
    fileStage.style.display = 'none';
    image.removeAttribute('src');
    showError('');
    if (!uri) {
      showError('publish_file did not provide the temporary HTTPS URL required by this widget.');
      return;
    }
    if (currentIsImage) {
      image.alt = filename;
      imageOpen.href = uri;
      image.src = uri;
      imageStage.style.display = 'grid';
      fullscreen.hidden = !fullscreenAvailable;
      return;
    }
    if (currentMode === 'fullscreen') setMode('inline');
    fullscreen.hidden = true;
    fileName.textContent = filename;
    fileMeta.textContent = [mime || 'file', formatSize(structured.size)].filter(Boolean).join(' · ');
    fileOpen.href = uri;
    fileStage.style.display = 'flex';
  }
  function toggleFullscreen() {
    if (!fullscreenAvailable || !currentIsImage) return;
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
    imageStage.style.display = 'none';
    showError('Unable to load the published image. The temporary URL may have expired; call publish_file again.');
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
    appInfo: { name: 'mrmcp-file-preview', version: '1.3.0' },
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
  const htmlPreviewUiMeta = () => ({
    ui: {
      prefersBorder: false,
      csp: { frameDomains: [publicOrigin()] },
    },
  });
  const htmlPreviewResource = () => ({
    uri: HTML_PREVIEW_UI_URI,
    name: "mrmcp_html_preview",
    title: "MrMCP HTML preview",
    description: "Sandboxed MCP App used by publish_html. It loads the persisted HTML URL returned in structuredContent inside a nested sandboxed iframe.",
    mimeType: MCP_UI_MIME_TYPE,
    _meta: htmlPreviewUiMeta(),
  });
  function htmlPreviewAppHtml() {
    return String.raw`<!doctype html>
<html lang="en" data-mode="inline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MrMCP HTML preview</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body, main { margin: 0; width: 100%; min-width: 0; background: transparent; }
#bar { display: none; align-items: center; gap: 8px; min-height: 34px; padding: 4px 6px; font: 13px/1.2 system-ui, sans-serif; }
#title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
#fullscreen { width: 30px; height: 28px; padding: 0; border: 1px solid #ffffff33; border-radius: 7px; color: inherit; background: transparent; cursor: pointer; }
#frame { display: none; width: 100%; min-height: 120px; border: 0; background: transparent; }
#error { display: none; padding: 10px; color: var(--color-text-danger, #b42318); font: 14px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
html[data-mode="fullscreen"], html[data-mode="fullscreen"] body, html[data-mode="fullscreen"] main { height: 100%; overflow: hidden; }
html[data-mode="fullscreen"] main { display: flex; flex-direction: column; }
html[data-mode="fullscreen"] #frame { flex: 1; height: 100% !important; min-height: 0; }
</style>
</head>
<body>
<main>
  <div id="bar"><div id="title"></div><button id="fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen" hidden>⛶</button></div>
  <iframe id="frame" title="Published HTML" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" allow="fullscreen" referrerpolicy="no-referrer"></iframe>
  <div id="error" role="alert"></div>
</main>
<script>
(function () {
  'use strict';
  var root = document.documentElement;
  var bar = document.getElementById('bar');
  var title = document.getElementById('title');
  var frame = document.getElementById('frame');
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
    var uri = typeof structured.uri === 'string' ? structured.uri : '';
    var label = String(structured.title || 'Interactive HTML');
    var height = Math.max(120, Math.min(Number(structured.height || 600), 2000));
    showError('');
    frame.style.display = 'none';
    bar.style.display = 'none';
    frame.removeAttribute('src');
    if (!uri) {
      showError('publish_html did not provide the persisted HTML URL required by this widget.');
      return;
    }
    title.textContent = label;
    frame.title = label;
    frame.style.height = height + 'px';
    frame.src = uri;
    bar.style.display = 'flex';
    frame.style.display = 'block';
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
  frame.addEventListener('load', function () { showError(''); });
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
    appInfo: { name: 'mrmcp-html-preview', version: '1.0.0' },
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
  const publishedHtmlUrl = id => `${publicBase()}/published-html/${encodeURIComponent(id)}`;
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
    const token = randomToken(32);
    const expiresAt = Date.now() + boundedExpirySeconds(options.expires_in) * 1000;
    const record = {
      path: realPath, allowed_root: allowedRoot, filename, mime_type: mimeType, size: stat.size,
      expires_at: expiresAt, one_time: options.one_time === true, delete_after: options.delete_after === true,
    };
    downloadTokens.set(token, record);
    return {
      filename, mime_type: mimeType, size: stat.size,
      uri: downloadUrl(token, filename),
      expires_at: new Date(expiresAt).toISOString(), one_time: record.one_time,
    };
  }

  const contentDisposition = (filename, mode = "attachment") => {
    const fallback = safeDownloadName(filename).replace(/["\\]/g, "_");
    const disposition = mode === "inline" ? "inline" : "attachment";
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  };
  function publishedHtmlResponse(req, u) {
    const match = u.pathname.match(/^\/published-html\/(html_[A-Za-z0-9_-]{24,})$/);
    if (!match || !["GET", "HEAD"].includes(req.method))
      return text("Not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    const record = one("SELECT html FROM published_html WHERE id=?", match[1]);
    if (!record) return text("Not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    };
    return req.method === "HEAD"
      ? new Response(null, { status: 200, headers })
      : new Response(record.html, { status: 200, headers });
  }
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
    if (!mcpHttpActive || mcpHttpPort !== HTTP_PORT)
      throw new Error(`ACME HTTP-01 requires 0.0.0.0:${HTTP_PORT}; this instance is listening on ${mcpHttpPort}`);
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
    if (mcpHttpPort !== HTTP_PORT) return;
    const next = Number(getCfg("tls_next_attempt_at", "0"));
    if (next > Date.now() || !getCfg("tls_email", "").trim()) return;
    if (!getCfg("public_ip", "").trim()) await detectPublicIp();
    await issueLetsEncrypt().catch(() => {});
  }

  // File tools can access every entry inside the selected Workspace.
  async function safePath(root, path = ".") {
    const rootReal = await Deno.realPath(root);
    const target = resolve(rootReal, String(path || "."));
    if (!within(rootReal, target)) throw new Error("Path outside selected Workspace");
    let current = target;
    for (;;) {
      try {
        const real = await Deno.realPath(current);
        if (!within(rootReal, real)) throw new Error("Path resolves outside the selected Workspace");
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

  // Session context handles are globally unique bearer capabilities over the stateless MCP transport.
  // Each Session has exactly one current Workspace; workspace id 0 is the program-folder fallback.
  const serverRoots = p => all(
    "SELECT * FROM roots WHERE server_id=? AND enabled=1 ORDER BY id", p.id,
  );
  const fallbackWorkspaceRoot = p => ({
    id: 0, server_id: p.id, name: "Program folder", path: APP_DIR, enabled: 1, fallback: true,
  });
  const configuredRootPath = value => resolve(APP_DIR, String(value || "."));
  async function emptyManagedTrash(p) {
    return await withToolCallsDrained("trash", async () => {
      const roots = [APP_DIR, ...all("SELECT path FROM roots WHERE server_id=? ORDER BY id", p.id).map(row => configuredRootPath(row.path))];
      const unique = new Map();
      for (const root of roots) unique.set(Deno.build.os === "windows" ? resolve(root).toLowerCase() : resolve(root), resolve(root));
      const result = { trash_roots: 0, entries_removed: 0, failures: [] };
      for (const root of unique.values()) {
        const trashRoot = join(root, ".mrmcp", "trash");
        let stat;
        try { stat = await Deno.stat(trashRoot); }
        catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          result.failures.push(`${trashRoot}: ${String(error?.message || error)}`);
          continue;
        }
        if (!stat.isDirectory) {
          result.failures.push(`${trashRoot}: not a directory`);
          continue;
        }
        result.trash_roots++;
        try {
          for await (const entry of Deno.readDir(trashRoot)) {
            await Deno.remove(join(trashRoot, entry.name), { recursive: true });
            result.entries_removed++;
          }
        } catch (error) {
          result.failures.push(`${trashRoot}: ${String(error?.message || error)}`);
        }
      }
      emitUiChange(["dashboard"], "trash-empty");
      return { ok: result.failures.length === 0, ...result };
    });
  }
  const runtimeWorkspaceRoot = root => ({ ...root, stored_path: root.path, path: configuredRootPath(root.path) });
  async function rootPathWarning(value) {
    const raw = String(value ?? "");
    if (!raw.trim()) return "Path is required.";
    try {
      const stat = await Deno.stat(configuredRootPath(raw));
      return stat.isDirectory ? "" : "Path does not point to a directory.";
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? "Directory does not exist." : `Path is not accessible: ${String(error?.message || error)}`;
    }
  }
  const validRootName = name => {
    const value = String(name || "").trim();
    return value.length >= 1 && value.length <= 128 && !/[\/\\\x00-\x1f\x7f]/.test(value);
  };
  const workspaceNameWarning = (name, id = 0) => {
    const value = String(name || "").trim();
    if (!validRootName(value)) return "Workspace name must be 1-128 characters and cannot contain slashes or control characters.";
    return one("SELECT 1 FROM roots WHERE name=? AND id<>?", value, Number(id) || 0)
      ? "Workspace name already exists."
      : "";
  };
  const rootPathKey = value => {
    const path = configuredRootPath(value);
    return Deno.build.os === "windows" ? path.toLowerCase() : path;
  };
  async function addDroppedRoots(paths) {
    const p = serverConfig(), roots = all("SELECT name,path FROM roots ORDER BY id");
    const rootByPath = new Map(roots.map(root => [rootPathKey(root.path), String(root.name || "")]));
    const labels = new Set(roots.map(root => String(root.name || "").trim().toLowerCase()));
    const added = [], existing = [];
    for (const value of Array.isArray(paths) ? paths : []) {
      const path = String(value || "").trim(), pathKey = rootPathKey(path);
      if (!path) continue;
      if (rootByPath.has(pathKey)) { existing.push(rootByPath.get(pathKey)); continue; }
      let stat;
      try { stat = await Deno.stat(path); } catch { continue; }
      if (!stat.isDirectory) continue;
      const absolute = configuredRootPath(path);
      let base = String(basename(absolute) || absolute.replace(/[\\/]+$/, "") || "Workspace").trim().slice(0, 128) || "Workspace";
      if (!validRootName(base)) base = "Workspace";
      let name = base, suffix = 2;
      while (labels.has(name.toLowerCase())) {
        const tail = ` #${suffix++}`;
        name = `${base.slice(0, 128 - tail.length)}${tail}`;
      }
      run("INSERT INTO roots(server_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
        p.id, name, path, 1, Date.now());
      rootByPath.set(pathKey, name);
      labels.add(name.toLowerCase());
      added.push(name);
    }
    return { added, existing };
  }
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
  const workspaceByName = (p, name, enabledOnly = true) => one(
    `SELECT * FROM roots WHERE server_id=? AND name=?${enabledOnly ? " AND enabled=1" : ""}`,
    p.id, String(name || "").trim(),
  );
  function createContext(p, workspace, protocolVersion = "", client = {}) {
    let handle;
    do handle = `ctx_${randomToken(24)}`;
    while (one("SELECT 1 FROM contexts WHERE handle=?", handle));
    const now = Date.now();
    run(`INSERT INTO contexts(handle,server_id,root_id,label,created_at,updated_at,last_active_at,protocol_version,auth_kind,oauth_client_id,client_name,user_agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, handle, p.id, Number(workspace.id), "", now, now, now, String(protocolVersion || ""),
      String(client.auth_kind || ""), String(client.oauth_client_id || ""), String(client.client_name || ""),
      String(client.user_agent || "").slice(0, 512));
    const record = one("SELECT * FROM contexts WHERE handle=?", handle);
    const clientLabel = String(record.client_name || record.oauth_client_id || record.user_agent || record.auth_kind || "remote client").slice(0, 120);
    postOsNotification("session", "✨ New Session", `${sessionNotificationLabel(p, record, 0, now, workspace.name)}\n• 👤 ${clientLabel}`);
    return record;
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
    return root ? runtimeWorkspaceRoot(root) : fallbackWorkspaceRoot(p);
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
      workspace_id: root.id,
      workspace_name: root.name,
      workspace_path: root.path,
      fallback_workspace: root.id === 0,
      created_at: context.created_at,
      updated_at: context.updated_at,
      last_active_at: context.last_active_at,
      expires_at: Number(context.last_active_at || context.created_at || 0) + CONTEXT_TTL_MS,
      available_workspaces: roots.map(item => ({ id: item.id, name: item.name, selected: item.id === root.id })),
    };
  }
  function selectContextRoot(p, context, rootId) {
    rootId = Math.max(0, Number(rootId) || 0);
    const root = rootId ? serverRoots(p).find(item => item.id === rootId) : null;
    if (rootId && !root) throw new Error(`Unknown or disabled Workspace id: ${rootId}`);
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
  async function workspaceInfo(selection) {
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
      workspace_name: selection.root.name,
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
  async function commandPathWarning(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const target = await commandTarget(raw), stat = await Deno.stat(target.path).catch(() => null);
      return stat?.isFile ? "" : "Command file does not exist yet.";
    } catch (error) {
      return String(error?.message || error);
    }
  }
  const commandPathBlocksSave = warning => !!warning && warning !== "Command file does not exist yet.";
  async function commandNameWarning(name, oldName = "") {
    const value = String(name || "").trim(), previous = String(oldName || "").trim().toLowerCase();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(value)) return "Command name must use only letters, numbers, _, ., + or -.";
    const rows = await readCommandConfig();
    return rows.some(row => row.name.toLowerCase() === value.toLowerCase() && row.name.toLowerCase() !== previous)
      ? "Command name already exists."
      : "";
  }
  const httpUrlWarning = (value, label) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) ? "" : `${label} must use HTTP or HTTPS.`;
    } catch { return `${label} is not a valid URL.`; }
  };
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
    const workspaceNameInput = {
      type: "string", minLength: 1, maxLength: 128,
      description: "Name of the enabled Workspace to open. Any enabled Workspace name may be supplied; the value is validated when the tool runs. The selected Session is attached to this Workspace immediately.",
    };
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
    const processLabelInput = {
      type: "string", minLength: 1, maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      description: "Client-chosen persistent process label. Uniqueness is scoped to the exact Session: the logical key is (context_handle, label), so different Sessions may reuse the same label without conflict. Use a short stable name such as dev-server or worker-1, then pass the exact same label to exec_attach, exec_write and exec_kill.",
    };
    const execInput = {
      program: {
        type: "string",
        description: "Executable path or logical_name returned by list_commands. Invoke catalog names directly without PATH probes.",
      },
      args: {
        type: "array", items: { type: "string" }, default: [],
        description: "Argument vector passed verbatim to the executable in this exact order. Put each option, option value and positional argument in its own array item; do not rewrite or reinterpret CLI syntax. When syntax is uncertain, run the program's --help first.",
      },
      shell_command: { type: "string", description: "Use only when shell syntax such as a pipeline or redirection is required. For normal direct execution use program + args. Never send a shell boolean/field; it is not part of this schema." },
      cwd: { type: "string", default: ".", description: "Directory relative to the Session's current Workspace." },
      env: { type: "object", additionalProperties: { type: "string" } },
      stdin: { type: "string" },
      stdin_encoding: { type: "string", enum: ["text", "base64"], default: "text" },
      timeout_ms: { type: "integer", minimum: 0, maximum: 604800000 },
      separate_streams: {
        type: "boolean", default: false,
        description: "Also return stdout and stderr separately. By default process tools return one combined output stream in the order the server observes data arriving from the two process pipes.",
      },
      ...contextInput,
    };
    const execStartInput = { ...execInput };
    delete execStartInput.separate_streams;

    const defs = {
      list_workspaces: [
        "List the names of all enabled Workspaces that may be passed to open_workspace. This tool does not require a Session.",
        { properties: {} },
      ],
      open_workspace: [
        "Open the named Workspace and return the Session context_handle to use afterward. Pass current_context_handle to move an existing active Session to that Workspace without changing its handle. If current_context_handle is omitted, empty, unknown or expired, a new Session is created instead. The result includes workspace_name, cwd and agent_guidance_path. Read agent_guidance_path when non-null, then pass the returned context_handle unchanged to every later tool.",
        { properties: {
          name: workspaceNameInput,
          current_context_handle: {
            type: "string",
            description: "Optional current Session capability. An active handle is reused and switched to the named Workspace; an omitted, empty, unknown or expired handle causes a new Session to be created.",
          },
        }, required: ["name"] },
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
        "List files recursively under the current Workspace using a glob pattern, optional exclusions and explicit hidden/dependency traversal. Prefer this over find, dir, ls, exec, uv or Python.",
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
        "Search text under the current Workspace without spawning rg, grep, uv or Python. Supports literal/regex matching, globs, exclusions, context lines, hidden/dependency traversal, encoding selection and content/file/count output modes.",
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
      trash_paths: [
        "Move files or directories selected by explicit Workspace-relative paths and/or one glob into a reversible .mrmcp/trash action. Each call creates one timestamped action directory plus a sibling JSON manifest; use untrash_action with the returned action_id to restore the whole action.",
        { anyOf: [{ required: ["paths"] }, { required: ["glob"] }], properties: {
          paths: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
          glob: { type: "string" }, ...contextInput,
        } },
      ],
      untrash_action: [
        "Restore every file and directory from one trash_paths action. Restore is all-or-nothing: if any original target is unavailable, nothing is restored.",
        { properties: { action_id: { type: "string" }, ...contextInput }, required: ["action_id"] },
      ],
      publish_file: [
        "Present an existing file to the user through the attached MCP App widget. This is the supported ChatGPT presentation path: the server puts a temporary HTTPS URL in structuredContent and the widget renders image/* through an HTML img element or shows an Open File action for other MIME types. Do not read/Base64-encode the file and do not try to construct inline or resource_link preview modes; simply call publish_file after creating the file.",
        { properties: {
          path: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" },
          expires_in: { type: "integer", minimum: 30, maximum: 604800, default: 86400 },
          one_time: { type: "boolean", default: false },
          ...contextInput,
        }, required: ["path"] },
      ],
      publish_html: [
        "Render arbitrary interactive HTML through the attached MCP App widget. The HTML is persisted in SQLite and remains available after server restarts; the widget loads its persistent HTTPS URL inside a nested sandboxed iframe that allows scripts, forms, modals and popup links but deliberately omits allow-same-origin, so the document cannot access the MCP App or host DOM and origin-dependent storage/cookie APIs may be unavailable. Prefer self-contained HTML/CSS/JavaScript for portable results. Remote images, fonts, scripts, modules, fetch/WebSocket calls and other network dependencies may work when the current host/browser permits them, but are host/CSP dependent and normal browser CORS still applies, so do not assume they are portable. The whole MCP request, including HTML and JSON, is limited by the server's 2 MiB request-body limit.",
        { properties: {
          html: { type: "string", minLength: 1 },
          title: { type: "string", default: "Interactive HTML", maxLength: 200 },
          height: { type: "integer", minimum: 120, maximum: 2000, default: 600 },
          ...contextInput,
        }, required: ["html"] },
      ],
      list_commands: [
        "Discover installed extra commands by name or purpose. Every returned logical_name is directly callable as exec.program without PATH probes.",
        { properties: {
          query: { type: "string", default: "" }, page: { type: "integer", minimum: 1, default: 1 },
          page_size: { type: "integer", minimum: 1, maximum: 100, default: 25 }, ...contextInput,
        } },
      ],
      query_tool_calls: [
        "Query tool-call history that actually reached the server for this exact context_handle. Filters may be combined. query is a case-insensitive literal substring search across the complete stored log record; tool and status are exact filters; before_id pages backward by stable log id. Use this to diagnose tool behavior or distinguish server-side failures from requests blocked before MCP dispatch; an upstream-blocked request cannot appear here.",
        { properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          tool: { type: "string", maxLength: 128, description: "Exact tool-name filter." },
          status: { type: "string", enum: ["received", "running", "completed", "failed", "invalid", "orphaned"] },
          query: { type: "string", maxLength: 1000, description: "Case-insensitive literal substring search across all stored fields of each log row." },
          before_id: { type: "integer", minimum: 1, description: "Return only rows whose stable log id is lower than this value." },
          ...contextInput,
        } },
      ],
      exec: [
        "Run one foreground command and keep the Tool Call open until it exits. The complete normalized combined stdout/stderr transcript is retained server-side for this call. When the request supplies _meta.progressToken and accepts SSE, new output is also sent incrementally as standard MCP notifications/progress in batches of at most 16 KiB or 100 ms; after exit the final result still contains the complete transcript from process start. Without a progressToken, no incremental progress notifications are emitted and the call returns the complete transcript only when the process exits. If the client disconnects or cancels the request, the foreground child is terminated. For normal direct execution use program + args; use shell_command only for actual shell syntax. Pass argv verbatim and consult --help when syntax is uncertain. Use structured filesystem/text tools instead of exec when they cover the operation.",
        { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
          ...execInput,
          timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 },
        } },
      ],
      exec_start: [
        "Start a persistent interactive/background command and return immediately; this tool never carries live process output. label is mandatory and identifies the process within the exact Session for later exec_attach, exec_write and exec_kill calls; the logical key is (context_handle,label), so another Session may reuse the same label. The process keeps running after this Tool Call ends or its client disconnects. The complete normalized stdout/stderr transcript is retained server-side for the retained process lifetime, and stdin writes are also retained internally for diagnostics. Call exec_attach(label) to consume output. Only one retained persistent process may use a given label in the same Session at a time; concurrent duplicate starts are rejected, while a completed retained process with that label may be replaced. Persistent process state does not survive a server restart. stdin remains open until exec_write closes it or the process exits.",
        { oneOf: [{ required: ["program", "label"] }, { required: ["shell_command", "label"] }], properties: {
          ...execStartInput, label: processLabelInput,
          timeout_ms: { type: "integer", minimum: 0, maximum: 604800000, default: 0 },
        } },
      ],
      exec_attach: [
        "Consume output from one persistent process created by exec_start using its exact Session-scoped label. The complete normalized process transcript is retained server-side and each successful attach advances an internal cursor so already-returned combined output is not repeated. With _meta.progressToken, exec_attach sends all unread backlog and then new combined stdout/stderr incrementally as standard MCP notifications/progress until the process exits; the final result contains the complete unread transcript covered by that attachment and remaining_bytes is 0. Without a progressToken, exec_attach is a long-poll read: if unread output already exists it returns immediately with at most 16 KiB; otherwise, while the process is running, it waits for output and returns when 16 KiB accumulate or 100 ms have elapsed after the first new data. remaining_bytes reports how many already-buffered UTF-8 bytes still follow the returned chunk. Call exec_attach again immediately while remaining_bytes>0; when it is 0 and status is running, call exec_attach again whenever you want to wait for future output. If the process exits or is killed while attached, the call returns the final available chunk plus the final process status; killed/failed status is an error result but still includes that output. A client disconnect detaches only and never terminates the persistent process. Only one exec_attach may be active for a label at a time. separate_streams=true additionally returns complete current stdout/stderr snapshots in the final result. Use exec_list to discover labels and states.",
        { properties: {
          label: processLabelInput,
          separate_streams: { type: "boolean", default: false, description: "Also return separate stdout/stderr in the final result; live MCP progress remains the combined observed-order output." },
          ...contextInput,
        }, required: ["label"] },
      ],
      exec_write: ["Write data to the open stdin of a persistent process created by exec_start. Address the process by its exact Session-scoped label. This call is ordinary JSON and does not attach to output; use exec_attach separately when live output is needed. Set close=true to close stdin after the optional write.", { properties: {
        label: processLabelInput, data: { type: "string", default: "" },
        encoding: { type: "string", enum: ["text", "base64"], default: "text" },
        close: { type: "boolean", default: false }, ...contextInput,
      }, required: ["label"] }],
      exec_kill: ["Terminate a persistent process created by exec_start, addressed by its exact Session-scoped label. Foreground exec calls are cancelled by cancelling/disconnecting their own Tool Call and are not controlled through exec_kill.", { properties: {
        label: processLabelInput, signal: { type: "string", enum: ["SIGTERM", "SIGKILL"], default: "SIGTERM" },
        ...contextInput,
      }, required: ["label"] }],
      exec_list: ["List the persistent processes currently retained for this Session, including their unique labels, state, command and attachment/stdin state. Use this before exec_attach, exec_write or exec_kill when the label or current state is uncertain. include_completed=false restricts the result to still-running processes. Persistent process state is in memory and does not survive a server restart.", { properties: {
        include_completed: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, ...contextInput,
      } }],
      js: [
        "Run JavaScript in a persistent lazy kernel scoped to the current Session and Workspace. Use it for computation or programmatic parsing, not ordinary file inspection, search or edits.",
        { properties: {
          code: { type: "string" }, cwd: { type: "string", default: "." },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000, default: 30000 }, ...contextInput,
        }, required: ["code"] },
      ],
      js_add_node_module_dir: ["Add a directory to the persistent JavaScript kernel for the current Session and Workspace.", { properties: { path: { type: "string" }, ...contextInput }, required: ["path"] }],
      js_reset: ["Reset the persistent JavaScript kernel for the current Session and Workspace.", { properties: { ...contextInput } }],
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
    const sessionlessOutputSchema = (properties = {}) => ({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false,
      properties,
    });
    const textMetadata = {
      encoding: { type: "string" }, bom: { type: "boolean" }, line_endings: { type: "string" },
    };
    const processProperties = {
      label: { type: "string", description: "Present for persistent processes created by exec_start." },
      status: { type: "string" },
      command: {}, cwd: { type: "string" }, started_at: { type: "string" }, completed_at: nullableString,
      exit_code: { anyOf: [{ type: "integer" }, { type: "null" }] }, signal: nullableString,
      requested_signal: nullableString, termination_source: nullableString,
      timed_out: { type: "boolean" },
      output: { type: "string", description: "Normalized combined process output. The complete process transcript is retained server-side for the retained process lifetime; ANSI/OSC/control sequences are removed before buffering or streaming, standalone carriage returns become line breaks and stdout/stderr are combined in observed arrival order." },
      stdout: { type: "string", description: "Complete normalized standard output, returned only when separate_streams=true." },
      stderr: { type: "string", description: "Complete normalized standard error, returned only when separate_streams=true. Some successful CLIs legitimately write progress or diagnostics here." },
      stdin_open: { type: "boolean" }, success: { type: "boolean" },
    };
    const outputSchemas = {
      list_workspaces: sessionlessOutputSchema({ workspaces: stringArray }),
      open_workspace: outputSchema({
        workspace_name: { type: "string", description: "Unique Workspace name selected for the returned Session." },
        cwd: { type: "string", description: "Absolute path of the selected Workspace." },
        agent_guidance_path: {
          ...nullableString,
          description: "Absolute Workspace-level AGENTS.md or agents.md path. When non-null, read and follow it before modifying files under this Workspace.",
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
      trash_paths: outputSchema({ action_id: { type: "string" }, trash_path: { type: "string" }, manifest_path: { type: "string" }, paths: stringArray }),
      untrash_action: outputSchema({ action_id: { type: "string" }, paths: stringArray }),
      publish_file: outputSchema({ path: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" }, size: { type: "integer" }, uri: { type: "string", description: "Temporary HTTPS URL consumed by the attached MCP App widget." }, expires_at: { type: "string" }, one_time: { type: "boolean" } }),
      publish_html: outputSchema({ id: { type: "string" }, title: { type: "string" }, uri: { type: "string", description: "Persistent HTTPS URL loaded by the attached MCP App widget." }, height: { type: "integer" }, created_at: { type: "string" } }),
      list_commands: outputSchema({ query: { type: "string" }, page: { type: "integer" }, page_size: { type: "integer" }, total: { type: "integer" }, pages: { type: "integer" }, has_more: { type: "boolean" }, bin_directory: { type: "string" }, config_file: { type: "string" }, path_precedence: { type: "string" }, invocation: { type: "object", additionalProperties: true }, commands: objectArray }),
      query_tool_calls: outputSchema({ calls: objectArray }),
      exec: outputSchema(processProperties),
      exec_start: outputSchema({
        label: { type: "string" }, status: { type: "string" }, command: {},
        cwd: { type: "string" }, started_at: { type: "string" }, stdin_open: { type: "boolean" },
      }),
      exec_attach: outputSchema({
        ...processProperties,
        remaining_bytes: {
          type: "integer", minimum: 0,
          description: "UTF-8 bytes already buffered after the output returned by this attach call. When greater than zero, call exec_attach again immediately to drain the next chunk. When zero and status is running, exec_attach may still be called again and will wait for new output or process termination.",
        },
      }),
      exec_write: outputSchema({ label: { type: "string" }, bytes_written: { type: "integer" }, stdin_open: { type: "boolean" } }),
      exec_kill: outputSchema({ label: { type: "string" }, killed: { type: "boolean" }, signal: { type: "string" } }),
      exec_list: outputSchema({ processes: objectArray }),
      js: outputSchema({ kernel_id: { type: "string" }, cwd: { type: "string" }, value: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, module_dirs: stringArray }),
      js_add_node_module_dir: outputSchema({ kernel_id: { type: "string" }, path: { type: "string" }, module_dirs: stringArray }),
      js_reset: outputSchema({ reset: { type: "boolean" }, kernel_id: { type: "string" } }),
    };
    const genericOutputSchema = outputSchema();
    const processOutputSchema = outputSchema(processProperties);

    const titles = {
      list_workspaces: "List Workspaces", open_workspace: "Open Workspace", read_file: "Read", read_files: "Read batch",
      write_file: "Write", write_files: "Write batch", edit: "Edit", replace: "Replace",
      glob: "Glob", grep: "Grep", trash_paths: "Trash paths", untrash_action: "Restore trash action",
      publish_file: "Publish File", publish_html: "Publish HTML", list_commands: "Command Catalog", query_tool_calls: "Query Tool Calls",
      exec: "Run Command", exec_start: "Start Persistent Command", exec_attach: "Attach Process Output", exec_write: "Write Stdin",
      exec_kill: "Terminate Process", exec_list: "List Processes", js: "JavaScript Kernel",
      js_add_node_module_dir: "Add Module Directory", js_reset: "Reset JavaScript Kernel",
    };
    const annotations = name => ({
      readOnlyHint: READ_TOOLS.has(name) || name === "publish_file",
      destructiveHint: ["write_file", "write_files", "edit", "replace", "move_path", "exec", "exec_start", "exec_write", "exec_kill", "js", "js_add_node_module_dir", "js_reset"].includes(name),
      idempotentHint: (READ_TOOLS.has(name) && name !== "publish_file") || ["write_file", "write_files", "edit", "create_directory", "js_reset"].includes(name),
      openWorldHint: name.startsWith("exec") || name === "js" || name === "publish_file" || name === "publish_html",
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
      const requiresContext = !["list_workspaces", "open_workspace"].includes(name);
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
        } } : name === "publish_html" ? { _meta: {
          ui: { resourceUri: HTML_PREVIEW_UI_URI }, "openai/outputTemplate": HTML_PREVIEW_UI_URI,
          "openai/toolInvocation/invoking": "Rendering HTML…", "openai/toolInvocation/invoked": "HTML ready.",
        } } : {}),
      };
    });
    for (const custom of all("SELECT * FROM custom_tools WHERE server_id=? ORDER BY name", p.id)) tools.push({
      name: custom.name,
      title: custom.name.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
      description: `${custom.description || `Run configured command: ${custom.command}`} This is a foreground command: normalized combined output may stream as request-scoped progress, the final result contains buffered status/output, and client disconnect/cancellation terminates the child. ${CONTEXT_HANDLE_RULE}`,
      inputSchema: schema({ properties: {
        args: { type: "array", items: { type: "string" }, default: [], description: "Argument vector appended verbatim and in order to the configured command." }, shell_command_suffix: { type: "string" },
        cwd: { type: "string", default: "." }, env: { type: "object", additionalProperties: { type: "string" } },
        stdin: { type: "string" }, separate_streams: { type: "boolean", default: false }, timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 },
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
      if (tool.name !== "list_workspaces" && !tool.outputSchema.required?.includes("context_handle"))
        errors.push("outputSchema missing required context_handle");
      if (tool.name === "list_workspaces" && tool.outputSchema.properties?.context_handle)
        errors.push("list_workspaces output must not expose context_handle");
      const expectedOutputs = {
        list_workspaces: ["workspaces"],
        open_workspace: ["workspace_name", "cwd", "agent_guidance_path"],
        query_tool_calls: ["calls"],
        publish_html: ["id", "title", "uri", "height", "created_at"],
        glob: ["files", "truncated"],
        grep: ["scanned_files", "matched_files", "results", "truncated"],
        replace: ["scanned_files", "total_replacements", "files"],
        edit: ["total_replacements", "files"],
        exec_attach: ["output", "remaining_bytes"],
      };
      for (const key of expectedOutputs[tool.name] || [])
        if (!tool.outputSchema.properties?.[key]) errors.push(`outputSchema missing property ${key}`);
    }
    if (tool.name === "open_workspace") {
      const workspaceName = tool.inputSchema?.properties?.name;
      if (workspaceName?.type !== "string") errors.push("open_workspace name must be a string");
      if (workspaceName?.enum) errors.push("open_workspace name must not enumerate configured Workspace names");
      if (tool.inputSchema?.properties?.context_handle) errors.push("open_workspace must not accept context_handle");
      if (!tool.inputSchema?.properties?.current_context_handle) errors.push("open_workspace missing optional current_context_handle");
      if (tool.inputSchema?.required?.includes("current_context_handle")) errors.push("open_workspace current_context_handle must be optional");
    } else if (tool.name === "list_workspaces") {
      if (tool.inputSchema?.properties?.context_handle) errors.push("list_workspaces must not accept context_handle");
    } else {
      if (!tool.inputSchema?.properties?.context_handle) errors.push("inputSchema missing context_handle");
      if (!tool.inputSchema?.required?.includes("context_handle")) errors.push("inputSchema context_handle must be required");
    }
    const expectedInputs = {
      open_workspace: ["name", "current_context_handle"],
      glob: ["exclude", "include_hidden", "include_dependencies", "limit"],
      grep: ["exclude", "regex", "case_sensitive", "include_hidden", "include_dependencies", "max_file_bytes", "encoding", "context_before", "context_after", "output_mode", "max_results"],
      replace: ["exclude", "regex", "case_sensitive", "include_hidden", "include_dependencies", "max_file_bytes", "expected_replacements", "dry_run", "max_files"],
      publish_html: ["html", "title", "height"],
      query_tool_calls: ["limit", "tool", "status", "query", "before_id"],
      exec_start: ["label"], exec_attach: ["label"], exec_write: ["label"], exec_kill: ["label"],
    };
    for (const key of expectedInputs[tool.name] || [])
      if (!tool.inputSchema.properties?.[key]) errors.push(`inputSchema missing property ${key}`);
    if (["exec_attach", "exec_write", "exec_kill"].includes(tool.name) && tool.inputSchema.properties?.process_id)
      errors.push(`${tool.name} must use label rather than process_id`);
    if (["exec", "exec_start", "exec_attach"].includes(tool.name) && tool.outputSchema.properties?.pid)
      errors.push(`${tool.name} output must not expose OS pid`);
    if (tool.name === "exec_attach" && ["wait_ms", "output_offset", "stdout_offset", "stderr_offset"].some(key => tool.inputSchema.properties?.[key]))
      errors.push("exec_attach must not expose polling or offset arguments");
    if (tool.name === "exec_start" && tool.inputSchema.properties?.separate_streams)
      errors.push("exec_start must not expose separate_streams because it does not return process output");
    return errors;
  }
  function mcpSelfTest(p) {
    const tools = serverTools(p);
    const invalid = tools.map(tool => ({
      name: tool.name,
      errors: validateToolDescriptor(tool),
    })).filter(x => x.errors.length);
    const fileResource = filePreviewResource(), htmlResource = htmlPreviewResource();
    const publishTool = tools.find(tool => tool.name === "publish_file");
    const publishHtmlTool = tools.find(tool => tool.name === "publish_html");
    const uiErrors = [];
    if (fileResource.uri !== FILE_PREVIEW_UI_URI || htmlResource.uri !== HTML_PREVIEW_UI_URI)
      uiErrors.push("unexpected UI resource URI");
    if (fileResource.mimeType !== MCP_UI_MIME_TYPE || htmlResource.mimeType !== MCP_UI_MIME_TYPE)
      uiErrors.push("unexpected UI resource MIME type");
    if (!filePreviewAppHtml().includes("ui/notifications/tool-result") || !htmlPreviewAppHtml().includes("ui/notifications/tool-result"))
      uiErrors.push("UI bridge listener missing");
    if (filePreviewAppHtml().includes("base64") || filePreviewAppHtml().includes("data:"))
      uiErrors.push("file UI must not embed Base64/data URLs");
    if (!filePreviewAppHtml().includes("structured.uri") || !htmlPreviewAppHtml().includes("structured.uri"))
      uiErrors.push("UI structuredContent URL handling missing");
    if (!htmlPreviewAppHtml().includes("sandbox=\"allow-scripts") || htmlPreviewAppHtml().includes("allow-same-origin"))
      uiErrors.push("publish_html nested iframe sandbox is invalid");
    if (!htmlPreviewUiMeta().ui?.csp?.frameDomains?.includes(publicOrigin()))
      uiErrors.push("publish_html frameDomains metadata missing public origin");
    if (publishTool?._meta?.ui?.resourceUri !== FILE_PREVIEW_UI_URI) uiErrors.push("publish_file UI metadata missing");
    if (publishTool?._meta?.["openai/outputTemplate"] !== FILE_PREVIEW_UI_URI) uiErrors.push("publish_file output-template alias missing");
    if (publishHtmlTool?._meta?.ui?.resourceUri !== HTML_PREVIEW_UI_URI) uiErrors.push("publish_html UI metadata missing");
    if (publishHtmlTool?._meta?.["openai/outputTemplate"] !== HTML_PREVIEW_UI_URI) uiErrors.push("publish_html output-template alias missing");
    const serverInfo = mcpServerInfo();
    if (serverInfo.icons?.[0]?.src !== `${publicBase()}/mrmcp-icon.png` || serverInfo.icons?.[0]?.mimeType !== "image/png")
      uiErrors.push("serverInfo public icon metadata missing");
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
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        ttlMs: 300000,
        cacheScope: "private",
      },
      modern_tools_list_result: {
        resultType: "complete",
        tools,
        ttlMs: 300000,
        cacheScope: "private",
      },
      resources_list_result: { resources: [fileResource, htmlResource] },
      resources_read_result: {
        contents: [
          { uri: FILE_PREVIEW_UI_URI, mimeType: MCP_UI_MIME_TYPE, text: filePreviewAppHtml(), _meta: filePreviewUiMeta() },
          { uri: HTML_PREVIEW_UI_URI, mimeType: MCP_UI_MIME_TYPE, text: htmlPreviewAppHtml(), _meta: htmlPreviewUiMeta() },
        ],
      },
    };
  }

  function beginLog(p, tool, args, contextHandle = "", root = null, descriptor = null, notifyStart = true, progressRequested = false) {
    const context = contextByHandle(p, contextHandle), contextId = Number(context?.id || 0), now = Date.now();
    const previous = contextId ? one(
      "SELECT COUNT(*) tool_calls, MAX(started_at) last_call_at FROM logs WHERE server_id=? AND context_id=?",
      p.id, contextId,
    ) : null;
    const previousCalls = Number(previous?.tool_calls || 0), lastCallAt = Number(previous?.last_call_at || 0);
    const inserted = run(`INSERT INTO logs(started_at,server_id,server_name,tool,status,input_json,
      context_id,context_handle,root_id,root_name,root_path) VALUES(?,?,?,?,'received',?,?,?,?,?,?)`,
      now, p.id, "mcp", tool, JSON.stringify(args), contextId, String(contextHandle || ""),
      Number(root?.id || 0), String(root?.name || ""), String(root?.path || ""));
    const id = Number(inserted.lastInsertRowid), sessionLabel = context
      ? sessionNotificationLabel(p, context, previousCalls + 1, now, root?.name || "")
      : "";
    if (descriptor) run(
      "INSERT INTO tool_call_descriptors(log_id,descriptor_json) VALUES(?,?)",
      id, JSON.stringify(descriptor),
    );
    run("INSERT INTO tool_call_transport(log_id,progress_requested) VALUES(?,?)", id, progressRequested ? 1 : 0);
    if (context && previousCalls && now - lastCallAt >= SESSION_ACTIVE_MS)
      postOsNotification("session", "🟢 Session Active", sessionLabel);
    if (notifyStart)
      postOsNotification("tool_call", `🛠️ Tool Call #${id}`, toolCallNotificationBody(p, tool, args, contextHandle, root, "", progressRequested));
    return id;
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
  function rejectToolCall(p, tool, args, message, contextHandle = "", status = "failed", result = { error: message }, descriptor = null, progressRequested = false) {
    const id = beginLog(p, tool, args, contextHandle, null, descriptor, false, progressRequested), completed = Date.now();
    updateLog(id, {
      completed_at: completed, duration_ms: 0, status,
      error: message, result_json: JSON.stringify(result),
    });
    indexLog(id);
    postOsNotification(
      "tool_call",
      status === "invalid" ? `⚠️ Invalid Tool Call #${id}` : `❌ Tool Call Rejected #${id}`,
      toolCallNotificationBody(p, tool, args, contextHandle, null, message, progressRequested),
    );
    emitUiChange(["state"], status === "invalid" ? "tool-call-invalid" : "tool-call-rejected");
    return id;
  }
  const invalidTypeName = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  function inputSchemaError(schema, value, path = "") {
    if (!schema || typeof schema !== "object") return "";
    const label = path ? `Property '${path}'` : "Value";
    if (schema.type) {
      const valid = schema.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
        : schema.type === "array" ? Array.isArray(value)
        : schema.type === "integer" ? Number.isInteger(value)
        : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
        : schema.type === "null" ? value === null
        : typeof value === schema.type;
      if (!valid) return `${label} must be ${schema.type} (received ${invalidTypeName(value)})`;
    }
    if (schema.enum && !schema.enum.some(item => Object.is(item, value)))
      return `${label} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`;
    if (typeof value === "string") {
      if (schema.minLength != null && value.length < schema.minLength) return `${label} must contain at least ${schema.minLength} characters`;
      if (schema.maxLength != null && value.length > schema.maxLength) return `${label} must contain at most ${schema.maxLength} characters`;
      if (schema.pattern) {
        try { if (!new RegExp(schema.pattern).test(value)) return `${label} does not match pattern ${schema.pattern}`; }
        catch {}
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (schema.minimum != null && value < schema.minimum) return `${label} must be >= ${schema.minimum}`;
      if (schema.maximum != null && value > schema.maximum) return `${label} must be <= ${schema.maximum}`;
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) return `${label} must contain at least ${schema.minItems} items`;
      if (schema.maxItems != null && value.length > schema.maxItems) return `${label} must contain at most ${schema.maxItems} items`;
      if (schema.items) for (let i = 0; i < value.length; i++) {
        const error = inputSchemaError(schema.items, value[i], path ? `${path}[${i}]` : `[${i}]`);
        if (error) return error;
      }
    }
    const objectValue = !!value && typeof value === "object" && !Array.isArray(value);
    if (objectValue) {
      for (const key of schema.required || [])
        if (!Object.hasOwn(value, key)) return `Required property is missing ('${key}')`;
      const properties = schema.properties || {};
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue;
        if (schema.additionalProperties === false) return `Additional properties are not allowed ('${key}' was unexpected)`;
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          const error = inputSchemaError(schema.additionalProperties, value[key], path ? `${path}.${key}` : key);
          if (error) return error;
        }
      }
      for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key)) {
        const error = inputSchemaError(child, value[key], path ? `${path}.${key}` : key);
        if (error) return error;
      }
    }
    for (const keyword of ["anyOf", "oneOf"]) if (Array.isArray(schema[keyword])) {
      const results = schema[keyword].map(option => inputSchemaError(option, value, path));
      const matches = results.filter(error => !error).length;
      if (keyword === "anyOf" && matches === 0) return results.find(Boolean) || "Value does not match any allowed schema";
      if (keyword === "oneOf" && matches !== 1)
        return matches === 0 ? (results.find(Boolean) || "Value does not match any allowed schema") : "Value matches more than one mutually exclusive schema";
    }
    return "";
  }
  // Foreground exec is request-scoped and streamed live. Persistent processes are explicitly
  // started with exec_start(label), then observed with exec_attach and controlled by label.
  // Keep the complete normalized process transcript for the retained process lifetime: foreground exec
  // returns the whole transcript once, while repeated exec_attach calls consume it through attach_cursor.
  const processTail = value => value.length > 65536 ? value.slice(-65536) : value;
  function appendProcessBuffer(rec, key, value) { rec[key] += value; }
  function notifyProcessActivity(rec) {
    for (const wake of [...rec.output_waiters]) { rec.output_waiters.delete(wake); wake(); }
  }
  function processActivityWait(rec, timeoutMs = 0) {
    let timer = null, settled = false, wake;
    const promise = new Promise(resolve => {
      wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        rec.output_waiters.delete(wake);
        resolve("activity");
      };
      rec.output_waiters.add(wake);
      if (timeoutMs > 0) timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rec.output_waiters.delete(wake);
        resolve("timeout");
      }, timeoutMs);
    });
    return { promise, cancel() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rec.output_waiters.delete(wake);
    } };
  }
  function recordProcessInput(rec, data, encoding = "utf-8", close = false) {
    if (data !== undefined && data !== null && String(data) !== "") rec.stdin_history.push({
      at: Date.now(), data: String(data), encoding: encoding === "base64" ? "base64" : "utf-8",
    });
    if (close) rec.stdin_history.push({ at: Date.now(), close: true });
  }
  const terminalNormalizer = () => ({ mode: "text", pending_cr: false });
  function normalizeTerminalChunk(state, value, final = false) {
    const text = String(value ?? ""), output = [];
    for (let i = 0; i < text.length;) {
      const code = text.charCodeAt(i), char = text[i];
      if (state.pending_cr) {
        output.push("\n");
        state.pending_cr = false;
        if (code === 0x0a) { i++; continue; }
      }
      if (state.mode === "string") {
        if (code === 0x07 || code === 0x9c) state.mode = "text";
        else if (code === 0x1b) state.mode = "string_esc";
        i++;
        continue;
      }
      if (state.mode === "string_esc") {
        state.mode = char === "\\" ? "text" : (code === 0x1b ? "string_esc" : "string");
        i++;
        continue;
      }
      if (state.mode === "csi") {
        if (code >= 0x40 && code <= 0x7e) state.mode = "text";
        i++;
        continue;
      }
      if (state.mode === "esc") {
        if (char === "[") state.mode = "csi";
        else if ("]P^_".includes(char)) state.mode = "string";
        else if (!(code >= 0x20 && code <= 0x2f)) state.mode = "text";
        i++;
        continue;
      }
      if (code === 0x1b) { state.mode = "esc"; i++; continue; }
      if (code === 0x9b) { state.mode = "csi"; i++; continue; }
      if ([0x90, 0x9d, 0x9e, 0x9f].includes(code)) { state.mode = "string"; i++; continue; }
      if (code === 0x0d) { state.pending_cr = true; i++; continue; }
      if (code === 0x0a || code === 0x09) output.push(char);
      else if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) output.push(char);
      i++;
    }
    if (final) {
      if (state.pending_cr) output.push("\n");
      state.pending_cr = false;
      state.mode = "text";
    }
    return output.join("");
  }
  const normalizeTerminalOutput = value => normalizeTerminalChunk(terminalNormalizer(), value, true);
  function appendProcessOutput(rec, stream, value, final = false) {
    const normalized = normalizeTerminalChunk(rec.output_normalizers[stream], value, final);
    if (!normalized) return;
    appendProcessBuffer(rec, stream, normalized);
    appendProcessBuffer(rec, "output", normalized);
    rec.output_bytes += enc.encode(normalized).byteLength;
    rec.updated_at = Date.now();
    rec.foreground_progress?.push(normalized);
    const attachment = rec.attachment;
    if (attachment?.progress) attachment.progress.push(normalized);
    notifyProcessActivity(rec);
    emitUiChange(["logs"], "process-output");
  }
  async function pumpProcess(stream, rec, key) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    rec.output_readers.add(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        appendProcessOutput(rec, key, decoder.decode(value, { stream: true }));
      }
      appendProcessOutput(rec, key, decoder.decode(), true);
    } catch (e) {
      if (!rec.output_cancelled) rec.error ||= String(e?.message || e);
    } finally {
      rec.output_readers.delete(reader);
      try { reader.releaseLock(); } catch {}
    }
  }
  async function settleProcessOutput(rec, pumps, graceMs = 250) {
    const settled = Promise.allSettled(pumps);
    if (await Promise.race([settled.then(() => true), sleep(graceMs).then(() => false)])) return false;
    rec.output_cancelled = true;
    if (rec.child.closeOutput) rec.child.closeOutput();
    else await Promise.allSettled([...rec.output_readers].map(async reader => {
      try { await reader.cancel(); } catch {}
    }));
    await settled;
    return true;
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
  function processView(rec, options = {}) {
    const read = (key, requested) => {
      const base = rec[`${key}_base`], start = Math.max(Number(requested || 0), base);
      return {
        value: rec[key].slice(start - base),
        from: start,
        next: base + rec[key].length,
        truncated_before: Number(requested || 0) < base ? base : null,
      };
    };
    const combined = read("output", options.output_offset);
    const view = {
      ...(rec.label ? { label: rec.label } : {}),
      status: rec.status, command: rec.display,
      cwd: rec.cwd_display, context_handle: rec.context_handle,
      started_at: new Date(rec.started_at).toISOString(),
      completed_at: rec.completed_at ? new Date(rec.completed_at).toISOString() : null,
      exit_code: rec.exit_code, signal: rec.signal || null, requested_signal: rec.requested_signal || null,
      termination_source: rec.termination_source || null, timed_out: !!rec.timed_out,
      output: combined.value,
      stdin_open: !!rec.stdin_writer, error: rec.error || "",
      success: rec.status === "running" || rec.status === "completed",
    };
    if (options.separate_streams === true) {
      const out = read("stdout", options.stdout_offset), err = read("stderr", options.stderr_offset);
      Object.assign(view, { stdout: out.value, stderr: err.value });
    }
    return view;
  }
  function processStartView(rec) {
    return {
      label: rec.label, status: rec.status, command: rec.display,
      cwd: rec.cwd_display, context_handle: rec.context_handle,
      started_at: new Date(rec.started_at).toISOString(), stdin_open: !!rec.stdin_writer,
    };
  }
  function processListView(rec) {
    return {
      label: rec.label, status: rec.status, command: rec.display,
      cwd: rec.cwd_display, started_at: new Date(rec.started_at).toISOString(),
      completed_at: rec.completed_at ? new Date(rec.completed_at).toISOString() : null,
      exit_code: rec.exit_code, signal: rec.signal || null, stdin_open: !!rec.stdin_writer,
      attached: !!rec.attachment,
    };
  }
  function processAdminView(rec, options = {}) {
    const progressRequested = rec.persistent
      ? !!rec.attachment?.progress_requested
      : !!activeCallControls.get(rec.log_id)?.progress_requested;
    return { process_id: rec.id, pid: rec.pid, progress_requested: progressRequested,
      stdin_history: rec.stdin_history || [], ...processView(rec, options) };
  }
  function processSummary(rec, tail = 8192, separateStreams = false) {
    const outputTotal = rec.output_base + rec.output.length;
    const stdoutTotal = rec.stdout_base + rec.stdout.length;
    const stderrTotal = rec.stderr_base + rec.stderr.length;
    return processView(rec, {
      output_offset: Math.max(rec.output_base, outputTotal - tail),
      separate_streams: separateStreams,
      stdout_offset: Math.max(rec.stdout_base, stdoutTotal - tail),
      stderr_offset: Math.max(rec.stderr_base, stderrTotal - tail),
    });
  }
  async function terminateProcess(rec, signal = "SIGTERM", source = "user") {
    if (!rec || !["starting", "running"].includes(rec.status)) return false;
    try {
      if (rec.child.kill(signal) === false) return false;
      rec.requested_signal = signal;
      rec.termination_source = source;
      return true;
    } catch {
      return false;
    }
  }
  function spawnManagedChild(program, options) {
    if (Deno.build.os !== "windows") return new Deno.Command(program, options).spawn();
    const child = nodeSpawn(program, options.args || [], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const status = new Promise((resolve, reject) => {
      child.once("error", error => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ success: code === 0, code: code ?? -1, signal: signal || null });
      });
    });
    const pid = Number(child.pid);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      stdin: Writable.toWeb(child.stdin),
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      status,
      kill(signal) { return child.kill(signal); },
      closeOutput() {
        for (const stream of [child.stdout, child.stderr]) {
          stream.on("error", () => {});
          stream.destroy();
        }
      },
    };
  }
  async function startManagedProcess(p, args, persistent, execution = {}) {
    const target = await resolveWorkspacePath(execution.selection, args.cwd || ".");
    const label = persistent ? String(args.label || "") : "";
    let replaceExisting = null, labelKey = "";
    if (persistent) {
      labelKey = `${target.context.handle}\0${label}`;
      if (persistentProcessLabels.has(labelKey)) throw new Error(`Persistent process label already in use: ${label}`);
      const existing = [...processes.values()].find(record =>
        record.persistent && record.context_handle === target.context.handle && record.label === label);
      if (existing && ["starting", "running"].includes(existing.status))
        throw new Error(`Persistent process label already in use: ${label}`);
      replaceExisting = existing || null;
      persistentProcessLabels.add(labelKey);
    }
    try {
    const defaultTimeout = persistent ? 0 : 120000;
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
    const child = spawnManagedChild(spec.program, {
      args: spec.argv, cwd: target.path, env: processEnv, clearEnv: true,
      stdin: "piped", stdout: "piped", stderr: "piped",
    });
    if (replaceExisting) processes.delete(replaceExisting.id);
    const rec = {
      id: `proc_${randomToken(18)}`, label, persistent: !!persistent,
      pid: child.pid, child, log_id: Number(execution.logId || 0),
      server_id: p.id, server_name: "mcp", context_id: target.context.id, context_handle: target.context.handle,
      root_id: target.root.id, root_path: target.root.path, root_name: target.root.name,
      display: spec.display, command_json: JSON.stringify({
        program: spec.program, args: spec.argv, shell: spec.shell,
        catalog_name: spec.catalog_name || null, system_path_inherited: includeSystemPath,
        ...(label ? { label } : {}), persistent: !!persistent,
      }),
      cwd: target.path, cwd_display: target.display, status: "running", started_at: Date.now(), completed_at: null,
      exit_code: null, signal: "", requested_signal: "", termination_source: "", timed_out: false, error: "",
      output: "", stdout: "", stderr: "", output_base: 0, stdout_base: 0, stderr_base: 0, output_bytes: 0, updated_at: Date.now(),
      output_readers: new Set(), output_waiters: new Set(), output_normalizers: { stdout: terminalNormalizer(), stderr: terminalNormalizer() }, output_cancelled: false,
      foreground_progress: persistent ? null : execution.progress || null,
      attachment: null, attach_cursor: 0, attach_cursor_bytes: 0, stdin_history: [],
      stdin_writer: child.stdin.getWriter(), timeout_timer: null, done: null,
    };
    processes.set(rec.id, rec);
    if (!persistent) {
      execution.setCancel?.((signal, source = "user") => terminateProcess(rec, signal, source), { process_id: rec.id, kind: "process" });
      execution.onDisconnect?.(() => terminateProcess(rec, "SIGTERM", "client"));
    }
    run(`INSERT INTO process_runs(id,pid,server_id,server_name,context_id,context_handle,root_id,root_name,root_path,
      command_json,cwd,status,started_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id, rec.pid, p.id, "mcp", rec.context_id, rec.context_handle, rec.root_id, rec.root_name, rec.root_path,
      rec.command_json, rec.cwd_display, rec.status, rec.started_at, timeout);
    const stdoutPump = pumpProcess(child.stdout, rec, "stdout"), stderrPump = pumpProcess(child.stderr, rec, "stderr");
    rec.done = child.status.then(async status => {
      const outputInterrupted = await settleProcessOutput(rec, [stdoutPump, stderrPump]);
      rec.completed_at = Date.now(); rec.exit_code = status.code;
      const observedSignal = status.signal || "";
      if (rec.timed_out) {
        rec.termination_source = "timeout";
        rec.signal ||= observedSignal;
        rec.status = "timed_out";
      } else if (rec.requested_signal) {
        rec.termination_source ||= "user";
        rec.signal ||= observedSignal;
        rec.status = "killed";
      } else if (observedSignal || (outputInterrupted && !status.success)) {
        rec.termination_source = "external";
        rec.signal ||= observedSignal;
        rec.status = "killed";
      } else {
        rec.signal ||= observedSignal;
        rec.status = status.success ? "completed" : "failed";
      }
      if (rec.timeout_timer) clearTimeout(rec.timeout_timer);
      try { await rec.stdin_writer?.close(); } catch {}
      rec.stdin_writer = null;
      run(`UPDATE process_runs SET status=?,completed_at=?,exit_code=?,signal=?,stdout_tail=?,stderr_tail=?,error=? WHERE id=?`,
        rec.status, rec.completed_at, rec.exit_code, rec.signal, processTail(rec.output), processTail(rec.stderr), rec.error, rec.id);
      notifyProcessActivity(rec);
      emitUiChange(["logs"], "process-exit");
      return rec;
    }).catch(error => {
      rec.completed_at = Date.now(); rec.status = "failed"; rec.error = String(error?.stack || error);
      run("UPDATE process_runs SET status='failed',completed_at=?,error=? WHERE id=?", rec.completed_at, rec.error, rec.id);
      notifyProcessActivity(rec);
      emitUiChange(["logs"], "process-exit");
      return rec;
    });
    if (timeout > 0) rec.timeout_timer = setTimeout(() => {
      rec.timed_out = true;
      terminateProcess(rec, "SIGKILL", "timeout").catch(() => {});
    }, timeout);
    if (args.stdin != null) {
      recordProcessInput(rec, args.stdin, args.stdin_encoding);
      const bytes = args.stdin_encoding === "base64"
        ? new Uint8Array(Buffer.from(String(args.stdin), "base64")) : enc.encode(String(args.stdin));
      await rec.stdin_writer.write(bytes);
    }
    if (!persistent) {
      recordProcessInput(rec, null, "utf-8", true);
      try { await rec.stdin_writer.close(); } catch {}
      rec.stdin_writer = null;
    }
    return rec;
    } finally {
      if (labelKey) persistentProcessLabels.delete(labelKey);
    }
  }
  function persistentProcess(label, contextHandle = "") {
    const wanted = String(label || ""), handle = String(contextHandle || "");
    const rec = [...processes.values()].find(record =>
      record.persistent && record.context_handle === handle && record.label === wanted);
    if (!rec) throw new Error(`Unknown persistent process label for this Session: ${wanted || "(empty)"}. Use exec_list to inspect available labels.`);
    return rec;
  }
  const processIsRunning = rec => ["starting", "running"].includes(rec.status);
  const processOutputEnd = rec => rec.output_base + rec.output.length;
  function attachProcessView(rec, start, end, args, remainingBytes) {
    const view = processView(rec, { separate_streams: args.separate_streams === true });
    const from = Math.max(start, rec.output_base), to = Math.max(from, Math.min(end, processOutputEnd(rec)));
    view.output = rec.output.slice(from - rec.output_base, to - rec.output_base);
    view.remaining_bytes = Math.max(0, Number(remainingBytes || 0));
    return view;
  }
  async function waitAttachBatch(rec, startBytes, disconnected) {
    if (rec.output_bytes > startBytes || !processIsRunning(rec)) return "ready";
    while (rec.output_bytes <= startBytes && processIsRunning(rec)) {
      const wait = processActivityWait(rec);
      const reason = await Promise.race([wait.promise, disconnected]);
      wait.cancel();
      if (reason === "disconnected") return reason;
    }
    if (rec.output_bytes <= startBytes || !processIsRunning(rec)) return "ready";
    const deadline = Date.now() + MCP_ATTACH_RESPONSE_MS;
    while (processIsRunning(rec) && rec.output_bytes - startBytes < MCP_ATTACH_RESPONSE_BYTES) {
      const delay = deadline - Date.now();
      if (delay <= 0) break;
      const wait = processActivityWait(rec, delay);
      const reason = await Promise.race([wait.promise, disconnected]);
      wait.cancel();
      if (reason === "disconnected") return reason;
      if (reason === "timeout") break;
    }
    return "ready";
  }
  async function attachManagedProcess(rec, args, execution = {}) {
    if (!rec.persistent) throw new Error("exec_attach can attach only to a persistent process created by exec_start");
    if (rec.attachment) throw new Error(`Persistent process ${rec.label} already has an active exec_attach`);
    const progressMode = !!execution.progressRequested, progress = progressMode ? execution.progress : null;
    const start = Math.max(rec.attach_cursor, rec.output_base), startBytes = rec.attach_cursor_bytes;
    let sentCursor = start, sentBytes = startBytes, detached = false, detach;
    const attachment = { progress, progress_requested: progressMode };
    const disconnected = new Promise(resolve => { detach = resolve; });
    if (progress) progress.setAfterFlush((message, bytes) => {
      sentCursor += message.length; sentBytes += bytes;
      rec.attach_cursor = Math.max(rec.attach_cursor, sentCursor);
      rec.attach_cursor_bytes = Math.max(rec.attach_cursor_bytes, sentBytes);
    });
    rec.attachment = attachment;
    execution.onDisconnect?.(() => {
      detached = true;
      if (rec.attachment === attachment) rec.attachment = null;
      progress?.setAfterFlush(null);
      detach("disconnected");
    });
    try {
      if (progressMode) {
        const backlog = rec.output.slice(start - rec.output_base);
        if (progress) { progress.push(backlog); progress.flush(); }
        if (processIsRunning(rec)) await Promise.race([rec.done, disconnected]);
        if (detached) return attachProcessView(
          rec, start, sentCursor, args, Math.max(0, rec.output_bytes - sentBytes),
        );
        progress?.flush();
        const end = processOutputEnd(rec);
        rec.attach_cursor = end; rec.attach_cursor_bytes = rec.output_bytes;
        return attachProcessView(rec, start, end, args, 0);
      }

      const reason = await waitAttachBatch(rec, startBytes, disconnected);
      if (reason === "disconnected" || detached) return attachProcessView(
        rec, start, start, args, Math.max(0, rec.output_bytes - startBytes),
      );
      const available = rec.output.slice(start - rec.output_base);
      const chunk = textPrefixByBytes(available, MCP_ATTACH_RESPONSE_BYTES);
      const chunkBytes = enc.encode(chunk).byteLength, end = start + chunk.length;
      rec.attach_cursor = end; rec.attach_cursor_bytes = startBytes + chunkBytes;
      return attachProcessView(
        rec, start, end, args, Math.max(0, rec.output_bytes - rec.attach_cursor_bytes),
      );
    } finally {
      if (rec.attachment === attachment) rec.attachment = null;
      progress?.setAfterFlush(null);
    }
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
  function recentProcesses(contextHandle, includeCompleted = true, limit = 50) {
    const handle = String(contextHandle || "");
    return [...processes.values()]
      .filter(record => record.persistent && record.context_handle === handle &&
        (includeCompleted || ["starting", "running"].includes(record.status)))
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit)
      .map(processListView);
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
    if (name === "list_workspaces") return {
      workspaces: all("SELECT name FROM roots WHERE server_id=? AND enabled=1 ORDER BY name", p.id).map(row => row.name),
    };
    if (name === "open_workspace") return await workspaceInfo(selection);
    if (!selection?.context || !selection?.root) throw new Error("Session Workspace selection is missing");
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
    if (name === "trash_paths" || name === "untrash_action") {
      const rootReal = await Deno.realPath(selection.root.path);
      const metadataRoot = join(rootReal, ".mrmcp");
      const trashRoot = join(metadataRoot, "trash");
      const exists = async path => {
        try { await Deno.lstat(path); return true; }
        catch (error) { if (error instanceof Deno.errors.NotFound) return false; throw error; }
      };
      const slash = path => relative(rootReal, path).replaceAll("\\", "/") || ".";
      if (name === "trash_paths") {
        const candidates = [];
        const addCandidate = async raw => {
          const target = await resolvePath(raw);
          if (!await exists(target.path)) throw new Error(`Path not found: ${raw}`);
          if (resolve(target.path) === resolve(rootReal)) throw new Error("Cannot trash the current Workspace");
          if (resolve(target.path) === resolve(metadataRoot) || within(metadataRoot, target.path))
            throw new Error("Cannot trash .mrmcp metadata");
          candidates.push(target);
        };
        for (const raw of args.paths || []) await addCandidate(raw);
        const pattern = String(args.glob || "").trim();
        if (pattern) {
          const match = globRegex(pattern);
          async function visit(dir) {
            for await (const entry of Deno.readDir(dir)) {
              const absolute = join(dir, entry.name), display = slash(absolute);
              if (display === ".mrmcp" || display.startsWith(".mrmcp/")) continue;
              const matched = match.test(display);
              if (matched) await addCandidate(display);
              if (entry.isDirectory && !matched) await visit(absolute);
              if (candidates.length > 10000) throw new Error("trash_paths glob matched more than 10000 paths");
            }
          }
          await visit(rootReal);
        }
        if (!candidates.length) throw new Error("trash_paths matched no paths");
        const unique = new Map();
        for (const target of candidates) {
          const key = Deno.build.os === "windows" ? resolve(target.path).toLowerCase() : resolve(target.path);
          if (!unique.has(key)) unique.set(key, target);
        }
        const ordered = [...unique.values()].sort((a, b) =>
          a.display.split("/").length - b.display.split("/").length || a.display.localeCompare(b.display));
        const selected = [];
        for (const target of ordered) {
          if (selected.some(parent => resolve(parent.path) !== resolve(target.path) && within(parent.path, target.path))) continue;
          selected.push(target);
        }
        const date = new Date(), pad = value => String(value).padStart(2, "0");
        const baseId = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
        let actionId = baseId, increment = 1;
        for (;;) {
          const actionDir = join(trashRoot, actionId), manifestPath = join(trashRoot, `${actionId}.json`);
          if (!await exists(actionDir) && !await exists(manifestPath)) break;
          actionId = `${baseId}-${++increment}`;
        }
        const actionDir = join(trashRoot, actionId), manifestPath = join(trashRoot, `${actionId}.json`);
        const trashRootExisted = await exists(trashRoot), moved = [];
        try {
          await Deno.mkdir(actionDir, { recursive: true });
          for (const target of selected) {
            const destination = join(actionDir, ...target.display.split("/"));
            await Deno.mkdir(dirname(destination), { recursive: true });
            await Deno.rename(target.path, destination);
            moved.push({ source: target.path, destination });
          }
          await Deno.writeTextFile(manifestPath, JSON.stringify({
            action_id: actionId,
            created_at: new Date().toISOString(),
            paths: selected.map(target => target.display),
          }, null, 2) + "\n");
        } catch (error) {
          for (const item of moved.reverse()) await Deno.rename(item.destination, item.source).catch(() => {});
          await Deno.remove(actionDir, { recursive: true }).catch(() => {});
          if (!trashRootExisted) await Deno.remove(trashRoot).catch(() => {});
          throw error;
        }
        return {
          action_id: actionId,
          trash_path: `.mrmcp/trash/${actionId}`,
          manifest_path: `.mrmcp/trash/${actionId}.json`,
          paths: selected.map(target => target.display),
        };
      }
      const actionId = String(args.action_id || "").trim();
      if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(actionId)) throw new Error("Invalid trash action_id");
      const actionDir = join(trashRoot, actionId), manifestPath = join(trashRoot, `${actionId}.json`);
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      const paths = Array.isArray(manifest.paths) ? manifest.paths.map(String) : [];
      if (!paths.length) throw new Error("Trash action contains no paths");
      const items = [];
      for (const display of paths) {
        const source = resolve(actionDir, ...display.replaceAll("\\", "/").split("/"));
        if (!within(actionDir, source) || !await exists(source)) throw new Error(`Trashed path is unavailable: ${display}`);
        const target = await resolvePath(display);
        if (await exists(target.path)) throw new Error(`Restore target already exists: ${display}`);
        if (!await exists(dirname(target.path))) throw new Error(`Restore parent is unavailable: ${display}`);
        items.push({ source, target: target.path, display });
      }
      const restored = [];
      try {
        for (const item of items) {
          await Deno.rename(item.source, item.target);
          restored.push(item);
        }
      } catch (error) {
        for (const item of restored.reverse()) await Deno.rename(item.target, item.source).catch(() => {});
        throw error;
      }
      await Deno.remove(actionDir, { recursive: true });
      await Deno.remove(manifestPath);
      return { action_id: actionId, paths };
    }
    if (name === "publish_file") {
      const target = await resolvePath(args.path);
      const result = await publishPath(target.path, {
        filename: args.filename || basename(target.path), mime_type: args.mime_type,
        expires_in: args.expires_in, one_time: args.one_time,
        allowed_root: target.root.path,
      });
      return { path: target.display, ...result };
    }
    if (name === "publish_html") {
      const html = String(args.html ?? "");
      if (!html.trim()) throw new Error("html must not be empty");
      const title = String(args.title || "Interactive HTML").trim().slice(0, 200) || "Interactive HTML";
      const height = Math.max(120, Math.min(Number(args.height || 600), 2000));
      const id = `html_${randomToken(24)}`, createdAt = Date.now();
      run(`INSERT INTO published_html(id,server_id,context_handle,title,html,height,created_at)
        VALUES(?,?,?,?,?,?,?)`, id, p.id, args.context_handle, title, html, height, createdAt);
      return { id, title, uri: publishedHtmlUrl(id), height, created_at: new Date(createdAt).toISOString() };
    }
    if (name === "list_commands") return await commandCatalog({ ...args, admin: false, include_missing: false });
    if (name === "query_tool_calls") {
      const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
      const conditions = ["context_handle=?", "id<>?"];
      const values = [args.context_handle, Number(execution.logId || 0)];
      const tool = String(args.tool || "").trim(), status = String(args.status || "").trim();
      const query = String(args.query || "").trim();
      if (tool) { conditions.push("tool=?"); values.push(tool); }
      if (status) { conditions.push("status=?"); values.push(status); }
      if (args.before_id != null) { conditions.push("id<?"); values.push(Math.max(1, Number(args.before_id))); }
      if (query) {
        conditions.push(`instr(lower(
          CAST(id AS TEXT)||char(10)||COALESCE(CAST(started_at AS TEXT),'')||char(10)||
          COALESCE(CAST(completed_at AS TEXT),'')||char(10)||COALESCE(CAST(server_id AS TEXT),'')||char(10)||
          server_name||char(10)||tool||char(10)||status||char(10)||input_json||char(10)||resolved_json||char(10)||
          stdout||char(10)||stderr||char(10)||error||char(10)||result_json||char(10)||
          COALESCE(CAST(duration_ms AS TEXT),'')||char(10)||CAST(context_id AS TEXT)||char(10)||context_handle||char(10)||
          CAST(root_id AS TEXT)||char(10)||root_name||char(10)||root_path
        ), lower(?)) > 0`);
        values.push(query);
      }
      const rows = all(`SELECT id,started_at,completed_at,tool,status,input_json,resolved_json,stdout,stderr,error,duration_ms,root_name,root_path
        FROM logs WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...values, limit);
      return { calls: rows.map(row => ({
        id: row.id,
        started_at: new Date(row.started_at).toISOString(),
        completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        tool: row.tool, status: row.status, duration_ms: row.duration_ms,
        workspace_name: row.root_name, workspace_path: row.root_path,
        input: parseJson(row.input_json, row.input_json),
        result: parseJson(row.resolved_json, row.resolved_json || null),
        output: row.stdout || "",
        ...(row.stderr ? { stderr: row.stderr } : {}),
        ...(row.error ? { error: row.error } : {}),
      })) };
    }
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
    if (name === "exec") {
      const record = await startManagedProcess(p, args, false, execution);
      await record.done;
      return processView(record, args);
    }
    if (name === "exec_start") {
      const record = await startManagedProcess(p, args, true, execution);
      return processStartView(record);
    }
    if (name === "exec_attach") return await attachManagedProcess(
      persistentProcess(args.label, args.context_handle), args, execution,
    );
    if (name === "exec_write") {
      const record = persistentProcess(args.label, args.context_handle);
      if (!record.stdin_writer) throw new Error(`Persistent process ${record.label} stdin is closed`);
      if (args.data) {
        recordProcessInput(record, args.data, args.encoding);
        await record.stdin_writer.write(args.encoding === "base64"
          ? new Uint8Array(Buffer.from(String(args.data), "base64")) : enc.encode(String(args.data)));
      }
      if (args.close) {
        recordProcessInput(record, null, "utf-8", true);
        await record.stdin_writer.close(); record.stdin_writer = null;
      }
      return { label: record.label,
        bytes_written: args.data ? (args.encoding === "base64"
          ? Buffer.from(String(args.data), "base64").length : enc.encode(String(args.data)).length) : 0,
        stdin_open: !!record.stdin_writer };
    }
    if (name === "exec_kill") {
      const record = persistentProcess(args.label, args.context_handle);
      return { label: record.label, killed: await terminateProcess(record, args.signal || "SIGTERM"),
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
    return processView(record, args);
  }

  function redactPublishedCapabilityUrls(value) {
    if (typeof value === "string")
      return value
        .replace(/\/download\/[A-Za-z0-9_-]{40,}\//g, "/download/[REDACTED]/")
        .replace(/\/published-html\/html_[A-Za-z0-9_-]{24,}/g, "/published-html/[REDACTED]");
    if (Array.isArray(value)) return value.map(redactPublishedCapabilityUrls);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactPublishedCapabilityUrls(item)]),
    );
    return value;
  }
  function toolResultForLog(value) {
    if (Array.isArray(value)) return value.map(toolResultForLog);
    if (!value || typeof value !== "object") return redactPublishedCapabilityUrls(value);
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
    if (kind === "missing") return "context_handle is required. Call open_workspace with the Workspace name, then repeat this tool call with the exact handle returned.";
    if (kind === "expired") return "The Session context_handle has expired. Call open_workspace with the Workspace name, then repeat the requested tool call.";
    if (kind === "invalid") return "The Session context_handle is invalid. Reuse a valid handle or call open_workspace with a Workspace name.";
    return "";
  }
  function contextControlToolResult(p, name, args, resolution, descriptor = null, progressRequested = false) {
    const handle = resolution.record?.handle || resolution.supplied_handle || "";
    const error = contextControlMessage(resolution.kind);
    const structuredContent = contextEnvelope(handle, { error });
    const id = beginLog(p, name, args, handle, null, descriptor, false, progressRequested);
    const toolResult = {
      content: [{ type: "text", text: error }],
      structuredContent, isError: true,
    };
    updateLog(id, {
      completed_at: Date.now(), duration_ms: 0, status: "invalid",
      resolved_json: JSON.stringify(structuredContent), stdout: error,
      result_json: JSON.stringify(toolResultForLog(toolResult)), error,
    });
    indexLog(id);
    postOsNotification("tool_call", `⚠️ Invalid Tool Call #${id}`, toolCallNotificationBody(p, name, args, handle, null, error, progressRequested));
    return toolResult;
  }

  async function callTool(p, name, args, callInfo) {
    await waitForToolCallGate();
    const id = beginLog(
      p, name, args, callInfo.contextHandle, callInfo.selection?.root, callInfo.descriptor, true, !!callInfo.progressRequested,
    ), started = Date.now();
    if (!activeCallControls.size)
      toolCallsIdle = new Promise(resolve => { resolveToolCallsIdle = resolve; });
    const control = { log_id: id, cancel: null, kind: "", process_id: "", kernel_id: "", progress_requested: !!callInfo.progressRequested };
    activeCallControls.set(id, control);
    emitToolCallActivity();
    const executionState = {
      ...callInfo, logId: id,
      progress: callInfo.requestStream?.progress || null,
      onDisconnect(callback) { callInfo.requestStream?.onDisconnect(callback); },
      setCancel(cancel, metadata = {}) {
        control.cancel = cancel; Object.assign(control, metadata);
        emitUiChange(["logs"], "tool-call-cancellable");
      },
    };
    try {
      if (!serverTools(p, true).some(tool => tool.name === name)) throw new Error("Unknown tool");
      updateLog(id, { status: "running" });
      const result = await executeTool(p, name, args, executionState);
      const publicResult = result && typeof result === "object" ? result : { value: result };
      const publicLogResult = redactPublishedCapabilityUrls(publicResult);
      const stdout = typeof publicLogResult.output === "string" ? publicLogResult.output
        : typeof publicLogResult.stdout === "string" ? publicLogResult.stdout
        : JSON.stringify(publicLogResult, null, 2);
      const stderr = typeof publicLogResult.stderr === "string" ? publicLogResult.stderr : "";
      const status = publicResult.success === false ? "failed" : "completed";
      const includeContext = name !== "list_workspaces";
      const envelope = includeContext ? contextEnvelope(callInfo.contextHandle) : {};
      const structuredContent = { ...publicResult, ...envelope };
      const full = typeof publicResult.content === "string"
        ? includeContext ? `${publicResult.content}\n\ncontext_handle: ${envelope.context_handle}` : publicResult.content
        : JSON.stringify(structuredContent, null, 2);
      const max = 1024 * 1024, rendered = full.length > max
        ? full.slice(0, max) + `\n\n[truncated; full output in log ${id}]` : full;
      const toolResult = { content: [{ type: "text", text: rendered }], structuredContent, isError: status !== "completed" };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status,
        resolved_json: JSON.stringify(publicLogResult), stdout, stderr,
        result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      if (status === "failed") {
        const failure = publicLogResult.error || publicLogResult.stderr ||
          (publicLogResult.exit_code != null ? `Exit code ${publicLogResult.exit_code}${publicLogResult.signal ? ` · ${publicLogResult.signal}` : ""}` : "Tool returned an error");
        postOsNotification("tool_call", `❌ Tool Call Failed #${id}`,
          toolCallNotificationBody(p, name, args, callInfo.contextHandle, callInfo.selection?.root, failure, !!callInfo.progressRequested));
      }
      return toolResult;
    } catch (error) {
      const message = String(error?.stack || error);
      const includeContext = name !== "list_workspaces";
      const envelope = includeContext ? contextEnvelope(callInfo.contextHandle) : {};
      const structuredContent = { error: String(error?.message || error), ...envelope };
      const text = includeContext
        ? `${String(error?.message || error)}\ncontext_handle: ${envelope.context_handle}`
        : String(error?.message || error);
      const toolResult = {
        content: [{ type: "text", text }],
        structuredContent, isError: true,
      };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status: "failed",
        error: message, result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      postOsNotification("tool_call", `❌ Tool Call Failed #${id}`,
        toolCallNotificationBody(p, name, args, callInfo.contextHandle, callInfo.selection?.root, error?.message || error, !!callInfo.progressRequested));
      return toolResult;
    } finally {
      activeCallControls.delete(id);
      if (!activeCallControls.size && resolveToolCallsIdle) {
        resolveToolCallsIdle();
        resolveToolCallsIdle = null;
      }
      emitToolCallActivity();
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
    } else if (u.pathname.startsWith("/published-html/")) {
      u.pathname = "/published-html/[REDACTED]";
    }
    for (const key of [...u.searchParams.keys()]) if (sensitiveKey(key)) u.searchParams.set(key, "[REDACTED]");
    return u.pathname + u.search;
  }
  function formatDebugBody(raw, type = "") {
    raw = String(raw || "");
    if (!raw) return "";
    try {
      if (type.includes("json")) return truncateDebug(JSON.stringify(redactObject(JSON.parse(raw)), null, 2));
      if (type.includes("text/event-stream")) return truncateDebug(raw.split(/\r?\n/).map(line => {
        if (!line.startsWith("data:")) return line;
        const payload = line.slice(5).trimStart();
        try { return `data: ${JSON.stringify(redactObject(JSON.parse(payload)))}`; }
        catch { return line; }
      }).join("\n"));
      if (type.includes("x-www-form-urlencoded")) {
        const q = new URLSearchParams(raw), out = {};
        for (const [k, v] of q) out[k] = sensitiveKey(k) ? "[REDACTED]" : v;
        return truncateDebug(JSON.stringify(out, null, 2));
      }
    } catch {}
    return truncateDebug(raw);
  }
  async function debugBody(message) {
    return formatDebugBody(await message.text(), message.headers.get("content-type") || "");
  }
  function debugCaptureBody(body) {
    const reader = body.getReader(), decoder = new TextDecoder();
    let captured = "", omitted = 0, decoderClosed = false;
    const append = value => {
      if (!value) return;
      const room = Math.max(0, DEBUG_BODY_LIMIT - captured.length);
      captured += value.slice(0, room);
      omitted += Math.max(0, value.length - room);
    };
    const finishDecoder = () => {
      if (!decoderClosed) { decoderClosed = true; append(decoder.decode()); }
      return captured + (omitted ? `\n[truncated ${omitted} additional characters]` : "");
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) { finishDecoder(); controller.close(); return; }
          append(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) {
        finishDecoder();
        try { await reader.cancel(reason); } catch {}
      },
    });
    return { stream, text: finishDecoder };
  }
  // Public request wrapper: insert diagnostics immediately, then update the same row when delivery completes.
  async function tracedHttp(req, info, handler, rateLimit = true) {
    run("UPDATE metrics SET value=value+1 WHERE name='requests'");
    const remoteHost = info?.remoteAddr?.hostname || "", started = Date.now();
    const debugEnabled = getCfg("debug_http_log", "0") === "1";
    const requestPath = new URL(req.url).pathname;
    const downloadRequest = requestPath.startsWith("/download/");
    const publishedHtmlRequest = requestPath.startsWith("/published-html/");
    let debugId = 0, debugError = "";
    const requestBodyPromise = debugEnabled
      ? debugBody(req.clone()).catch(error => {
          debugError = `Debug request capture error: ${String(error?.stack || error)}`;
          return "";
        })
      : null;
    if (debugEnabled) {
      const inserted = run(`INSERT INTO debug_logs(ts,method,path,status,duration_ms,remote_addr,
        request_headers,request_body,response_headers,response_body,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        started, req.method, debugUrl(req.url), 0, 0, remoteHost,
        debugHeaders(req.headers), "", "", "", "");
      debugId = Number(inserted.lastInsertRowid);
      requestBodyPromise.then(body => {
        if (debugId) run("UPDATE debug_logs SET request_body=? WHERE id=?", body, debugId);
      }).catch(() => {});
    }

    let response, handlerError = "";
    if (rateLimit && !allowRequest(remoteHost)) response = json({ error: "Too many requests" }, 429, { "retry-after": "60" });
    else try { response = await handler(); }
    catch (error) {
      handlerError = String(error?.stack || error);
      response = json({ error: String(error?.message || error) }, String(error?.message || error).includes("too large") ? 413 : 500);
    }

    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    const responseType = String(headers.get("content-type") || "").toLowerCase();
    let responseCapture = null, responseBody = downloadRequest ? "[binary download body omitted]"
      : publishedHtmlRequest ? "[published HTML body omitted]" : "";
    let body = response.body;
    if (debugEnabled && body && !downloadRequest && !publishedHtmlRequest) {
      responseCapture = debugCaptureBody(body);
      body = responseCapture.stream;
    }
    const finalResponse = new Response(body, {
      status: response.status, statusText: response.statusText, headers,
    });

    if (debugEnabled) {
      const finalize = async deliveryError => {
        let requestBody = "";
        try { requestBody = await requestBodyPromise; }
        catch (error) { debugError += `${debugError ? "\n" : ""}Debug request capture error: ${String(error?.stack || error)}`; }
        if (responseCapture) responseBody = formatDebugBody(responseCapture.text(), responseType);
        const errors = [handlerError, debugError, deliveryError ? `Response delivery error: ${String(deliveryError?.stack || deliveryError)}` : ""]
          .filter(Boolean).join("\n");
        run(`UPDATE debug_logs SET status=?,duration_ms=?,request_body=?,response_headers=?,response_body=?,error=? WHERE id=?`,
          response.status, Date.now() - started, requestBody, debugHeaders(headers), responseBody, errors, debugId);
      };
      Promise.resolve(info?.completed).then(() => finalize(null), error => finalize(error)).catch(() => {});
    }
    return finalResponse;
  }
  const tracedMcp = (req, info, transport) => tracedHttp(req, info, () => mcpHandler(req, info, transport));


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
  const eta = new Eta({ tags: ["<?", "?>"], autoEscape: true, cache: true });
  const OAUTH_PAGE_TEMPLATE = `<? const d=it.data||{}; ?><!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content=dark><title><?= d.title ?> · MrMCP</title>
<style>
:root{color-scheme:dark;--bg:#101114;--card:#181a1f;--panel:#17191e;--text:#e8e8e8;--muted:#89909b;--line:#2c3037;--brand:#3984e8;--brand-soft:#202a3a;--approve:#15956f;--approve-hover:#10785b;--deny:#d95757;--deny-hover:#bf4747;--error:#ff8585;--error-bg:#241718;--error-line:#5b2d32;--shadow:0 24px 70px rgba(0,0,0,.42)}
*{box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}body{margin:0;font:calc(.55vw + .75vh)/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:radial-gradient(circle at 50% -10%,rgba(57,132,232,.12),transparent 36%),var(--bg)}
main{width:100vw;height:100vh;height:100dvh;display:grid;place-items:center;padding:2vh 2vw}.card{width:52vw;max-height:90vh;max-height:90dvh;background:var(--card);border:.06vw solid var(--line);border-radius:min(.8vw,1.6vh);box-shadow:var(--shadow);padding:2vh 1.7vw}.brand{text-align:center}.logo-shell{width:min(4vw,6vh);height:min(4vw,6vh);margin:0 auto .75vh;padding:.4vh;display:grid;place-items:center;border:.06vw solid #343944;border-radius:min(.65vw,1.3vh);background:linear-gradient(145deg,#20242a,var(--panel));box-shadow:0 .6vh 1.8vh rgba(0,0,0,.24)}.logo{display:block;width:100%;height:100%;object-fit:contain;border-radius:min(.5vw,1vh)}.eyebrow{display:inline-flex;align-items:center;padding:.22vh .55vw;border-radius:99vmax;color:#9ecbff;background:var(--brand-soft);font-size:calc(.38vw + .55vh);font-weight:750;letter-spacing:.035em;text-transform:uppercase;margin-bottom:.45vh}h1{font-size:calc(1.25vw + 1.45vh);line-height:1.06;letter-spacing:-.02em;margin:0 0 .45vh}.subtitle{max-width:45vw;margin:0 auto;color:var(--muted);font-size:calc(.62vw + .72vh)}.subtitle strong{color:var(--text)}
.details{margin:1.35vh 0 1.15vh;border:.06vw solid var(--line);border-radius:min(.6vw,1.2vh);background:var(--panel);overflow:hidden}.detail{min-width:0;display:grid;grid-template-columns:11vw minmax(0,1fr);gap:.9vw;align-items:center;padding:.8vh .9vw;border-bottom:.06vw solid var(--line)}.detail:last-child{border-bottom:0}.label{display:block;color:var(--muted);font-size:calc(.43vw + .62vh);font-weight:750;letter-spacing:.04em;text-transform:uppercase}.value{min-width:0;font-size:calc(.56vw + .72vh);font-weight:700;overflow-wrap:anywhere}.value code{font:calc(.49vw + .64vh)/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;color:#9ecbff}.notice{display:flex;gap:.7vw;align-items:flex-start;padding:1vh 1vw;border-radius:min(.55vw,1.1vh);margin:1vh 0 0}.notice.error{background:var(--error-bg);border:.06vw solid var(--error-line);color:#d9a0a7}.notice.error strong{color:var(--error)}.notice-icon{font-size:calc(.55vw + .8vh);line-height:1.3}.actions{display:flex;justify-content:center;gap:.85vw}.btn{appearance:none;border:0;border-radius:min(.5vw,1vh);min-width:0;flex:1;padding:1.05vh 1vw;font:750 calc(.55vw + .72vh) system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;transition:transform .12s ease,background .12s ease,box-shadow .12s ease}.btn:hover{transform:translateY(-.1vh)}.approve{color:#fff;background:var(--approve);box-shadow:0 .5vh 1.4vh rgba(21,149,111,.18)}.approve:hover{background:var(--approve-hover)}.deny{color:#fff;background:var(--deny);box-shadow:0 .5vh 1.4vh rgba(233,85,85,.12)}.deny:hover{background:var(--deny-hover)}.error-card{border-color:#5b2d32}
@media(max-aspect-ratio:4/5){body{font-size:3.4vw}.card{width:86vw;padding:2vh 4vw}.logo-shell{width:12vw;height:12vw}.detail{grid-template-columns:29vw minmax(0,1fr);gap:2vw;padding:.8vh 2vw}.eyebrow{font-size:2.6vw}h1{font-size:5.7vw}.subtitle{font-size:3.5vw;max-width:78vw}.label{font-size:2.8vw}.value{font-size:3.4vw}.value code{font-size:3vw}.btn{font-size:3.5vw;padding:1.1vh 2vw}}
</style></head><body><main><section class="card<?= d.error?' error-card':'' ?>" aria-labelledby=oauth-title><div class=brand><div class=logo-shell><img class=logo src="<?= d.icon_url ?>" alt="MrMCP"></div><div class=eyebrow>MrMCP · OAuth</div><h1 id=oauth-title><?= d.title ?></h1><p class=subtitle><? if(d.error){ ?>MrMCP could not validate this authorization request.<? } else { ?><strong><?= d.client_name ?></strong> wants permission to connect to this MrMCP server.<? } ?></p></div>
<? if(d.error){ ?><div class="notice error"><span class=notice-icon>⚠️</span><div><strong><?= d.error ?></strong><br>Return to your client and start the connection again.</div></div><? } else { ?><div class=details><div class=detail><span class=label>Client</span><div class=value><?= d.client_name ?></div></div><div class=detail><span class=label>Requested access</span><div class=value><?= d.scope ?></div></div><div class=detail><span class=label>Server resource</span><div class=value><code><?= d.resource ?></code></div></div><div class=detail><span class=label>Return destination</span><div class=value><?= d.redirect_host ?></div></div></div><form method=post action=/oauth/authorize><? (d.fields||[]).forEach(([name,value])=>{ ?><input type=hidden name="<?= name ?>" value="<?= value ?>"><? }) ?><div class=actions><button class="btn approve" name=decision value=approve>Authorize Access</button><button class="btn deny" name=decision value=deny>Cancel</button></div></form><? } ?></section></main></body></html>`;
  async function oauthPage(data) {
    const html = typeof eta.renderStringAsync === "function"
      ? await eta.renderStringAsync(OAUTH_PAGE_TEMPLATE, { data })
      : eta.renderString(OAUTH_PAGE_TEMPLATE, { data });
    return text(html, data.error ? 400 : 200, "text/html; charset=utf-8", {
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  }
  const oauthError = reason => oauthPage({
    title: "Authorization couldn't continue", error: reason, icon_url: mcpIconUrl(),
  });

  // OAuth discovery/authorization and MCP 2026-07-28 routing.
  async function mcpHandler(req, info, transport = "http") {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/download/")) return await downloadResponse(req, u);
    if (u.pathname.startsWith("/published-html/")) return publishedHtmlResponse(req, u);
    if (transport === "https" && req.method === "GET" && u.pathname === "/mrmcp-icon.png")
      return await staticAssetResponse("/assets/mrmcp-logo.png");
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
      const fields = [...q.entries(), ["consent_token", consentToken]];
      let redirectHost = auth.redirect;
      try { redirectHost = new URL(auth.redirect).host; } catch {}
      return oauthPage({
        title: "Connect to MrMCP", icon_url: mcpIconUrl(), client_name: auth.client.name,
        scope: auth.scope || "mcp", resource: auth.resource, redirect_host: redirectHost, fields,
      });
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
    const progressRequested = Object.prototype.hasOwnProperty.call(requestMeta, "progressToken");
    const bodyProtocol = String(requestMeta["io.modelcontextprotocol/protocolVersion"] || "");
    const headerProtocol = String(req.headers.get("mcp-protocol-version") || "");
    const headerMethod = String(req.headers.get("mcp-method") || "");
    const modernRequest = headerProtocol === MCP_MODERN_PROTOCOL ||
      bodyProtocol === MCP_MODERN_PROTOCOL || x.method === "server/discover";
    const observedProtocol = headerProtocol || bodyProtocol ||
      (x.method === "server/discover" ? MCP_MODERN_PROTOCOL : "");
    const rejectParsedToolCall = (message, result = { error: message }) => {
      if (x.method !== "tools/call") return "";
      const toolName = typeof x.params?.name === "string" && x.params.name
        ? x.params.name : "(invalid tools/call)";
      const descriptor = fullAccess ? serverTools(p, true).find(tool => tool.name === toolName) : null;
      return rejectToolCall(
        p, toolName, x.params?.arguments || x.params || {}, message,
        String(x.params?.arguments?.context_handle || ""), "invalid", result, descriptor, progressRequested,
      );
    };
    const rpcError = (status, code, message, data = undefined, logInvalid = false) => {
      const payload = {
        jsonrpc: "2.0",
        id: x.id ?? null,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      };
      if (logInvalid) rejectParsedToolCall(message, payload);
      return json(payload, status, {
        "cache-control": "no-store",
        ...(headerProtocol ? { "mcp-protocol-version": headerProtocol } : {}),
      });
    };

    if (!modernRequest) {
      return rpcError(200, -32022, "Unsupported or missing MCP protocol version", {
        supported: MCP_PROTOCOLS,
        requested: headerProtocol || bodyProtocol || "missing",
      }, true);
    }
    {
      const effectiveProtocol = headerProtocol || bodyProtocol || MCP_MODERN_PROTOCOL;
      if (headerProtocol && bodyProtocol && headerProtocol !== bodyProtocol) {
        return rpcError(200, -32020, "MCP header and body metadata do not match", {
          headerProtocol,
          bodyProtocol,
        }, true);
      }
      if (headerMethod && headerMethod !== x.method) {
        return rpcError(200, -32020, "Mcp-Method header does not match the JSON-RPC method", {
          headerMethod,
          bodyMethod: x.method,
        }, true);
      }
      if (effectiveProtocol !== MCP_MODERN_PROTOCOL) {
        return rpcError(200, -32022, "Unsupported protocol version", {
          supported: MCP_PROTOCOLS,
          requested: effectiveProtocol,
        }, true);
      }
      if (x.method === "tools/call" || x.method === "resources/read") {
        const headerName = String(req.headers.get("mcp-name") || "");
        const bodyName = String(x.method === "tools/call" ? x.params?.name : x.params?.uri || "");
        if (headerName && headerName !== bodyName) {
          return rpcError(200, -32020, "Mcp-Name header does not match the request body", {
            headerName,
            bodyName,
          }, true);
        }
      }
    }

    if (x.id == null) {
      rejectParsedToolCall("tools/call notifications are not executed", { http_status: 202, response_body: null });
      return new Response(null, { status: 202 });
    }

    const serverInfoMeta = { "io.modelcontextprotocol/serverInfo": mcpServerInfo() };
    const instructions = fullAccess
      ? "Use list_workspaces when you need to discover the enabled Workspace names, then call open_workspace with the desired name. If you already have the current Session handle, pass it as current_context_handle to move that same Session to the Workspace; if it is omitted, empty, unknown or expired, open_workspace creates a new Session. The result includes workspace_name, absolute cwd and agent_guidance_path; when that path is non-null, read and follow the referenced AGENTS.md before repository work. Pass the returned context_handle unchanged on every later Session-bound tool call. " +
        "Use read_file/read_files, glob, grep, edit and replace directly for file inspection, discovery, search and textual changes; do not spawn shell commands, uv or Python for operations those tools cover. " +
        "Use list_commands before other command-line work and invoke returned logical_name values directly through exec.program without PATH probes. " +
        "Command output is normalized before buffering or streaming: ANSI/OSC/control sequences are removed and standalone carriage-return progress updates become separate lines. exec retains its complete foreground transcript and, when _meta.progressToken is supplied, also emits incremental progress before returning the same complete transcript at exit; cancelling/disconnecting exec terminates its child. For persistent or interactive work, call exec_start with a Session-scoped label, then use exec_attach, exec_write, exec_list and exec_kill. Persistent labels are keyed by (context_handle,label), so different Sessions may reuse a label. exec_start returns immediately and retains the complete process transcript. exec_attach with progressToken streams unread backlog plus live output through progress until process exit and then returns that complete unread transcript; without progressToken it long-polls and returns at most 16 KiB of unread output plus remaining_bytes, so call it repeatedly to drain buffered output and call it again with remaining_bytes=0/status=running to wait for future output. Disconnecting exec_attach only detaches and never kills the persistent process. " +
        "Use publish_file to present existing files through its MCP App widget, and publish_html when an interactive self-contained HTML/CSS/JavaScript visualization is more appropriate. " +
        "Every authenticated client can invoke every published tool; context_handle is the bearer capability selecting the persistent Session and its current Workspace."
      : "The endpoint is reachable, but anonymous access exposes no tools. Authenticate with OAuth or Basic authentication.";

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
        const resources = fullAccess ? [filePreviewResource(), htmlPreviewResource()] : [];
        r.result = {
          resultType: "complete", resources, ttlMs: 300000,
          cacheScope: "private", _meta: serverInfoMeta,
        };
      } else if (x.method === "resources/read") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for resource access" };
          responseStatus = 403;
        } else {
          const resourceUri = String(x.params?.uri || "");
          const resource = resourceUri === FILE_PREVIEW_UI_URI
            ? { uri: FILE_PREVIEW_UI_URI, text: filePreviewAppHtml(), _meta: filePreviewUiMeta() }
            : resourceUri === HTML_PREVIEW_UI_URI
            ? { uri: HTML_PREVIEW_UI_URI, text: htmlPreviewAppHtml(), _meta: htmlPreviewUiMeta() }
            : null;
          if (!resource) {
            r.error = { code: -32002, message: `Resource not found: ${resourceUri}` };
            responseStatus = 200;
          } else {
            const resourceResult = { contents: [{ ...resource, mimeType: MCP_UI_MIME_TYPE }] };
            r.result = modernRequest
              ? { resultType: "complete", ...resourceResult, _meta: serverInfoMeta }
              : resourceResult;
          }
        }
      } else if (x.method === "tools/call") {
        if (!fullAccess) {
          const toolName = typeof x.params?.name === "string" && x.params.name
            ? x.params.name : "(invalid tools/call)";
          const logId = rejectToolCall(
            p, toolName, x.params?.arguments || x.params || {},
            "Authentication required for tool execution", String(x.params?.arguments?.context_handle || ""),
            "failed", { error: "Authentication required for tool execution" }, null, progressRequested,
          );
          r.error = {
            code: -32001, message: "Authentication required for tool execution",
          };
          responseStatus = 403;
        } else if (!x.params?.name || typeof x.params.name !== "string") {
          r.error = { code: -32602, message: "tools/call requires params.name" };
          rejectToolCall(
            p, "(invalid tools/call)", x.params || {}, r.error.message,
            String(x.params?.arguments?.context_handle || ""), "invalid", { jsonrpc: "2.0", id: x.id, error: r.error }, null, progressRequested,
          );
        } else {
          const rawToolArgs = x.params?.arguments ?? {};
          const descriptor = serverTools(p, true).find(tool => tool.name === x.params.name);
          const validationError = descriptor
            ? inputSchemaError(descriptor.inputSchema, rawToolArgs)
            : `Unknown tool: ${x.params.name}`;
          if (validationError) {
            r.error = { code: -32602, message: validationError };
            rejectToolCall(
              p, x.params.name, rawToolArgs, validationError,
              String(rawToolArgs?.context_handle || ""), "invalid", { jsonrpc: "2.0", id: x.id, error: r.error }, descriptor, progressRequested,
            );
          } else {
            const toolArgs = { ...rawToolArgs };
            const invokeTool = async requestStream => {
              let toolResult;
              if (x.params.name === "list_workspaces") {
                toolResult = await callTool(
                  p, x.params.name, toolArgs,
                  { authKind: auth.kind, contextHandle: "", selection: null, descriptor, requestStream, progressRequested },
                );
              } else if (x.params.name === "open_workspace") {
                delete toolArgs.context_handle;
                const workspace = workspaceByName(p, toolArgs.name);
                if (!workspace) {
                  const current = resolveContext(p, toolArgs.current_context_handle, observedProtocol);
                  const handle = current.kind === "active" ? current.record.handle : "";
                  const error = `Unknown or disabled Workspace: ${String(toolArgs.name || "")}`;
                  const structuredContent = contextEnvelope(handle, { error });
                  toolResult = { content: [{ type: "text", text: error }], structuredContent, isError: true };
                  rejectToolCall(p, x.params.name, toolArgs, error, handle, "invalid", toolResult, descriptor, progressRequested);
                } else {
                  const current = resolveContext(p, toolArgs.current_context_handle, observedProtocol);
                  let record;
                  if (current.kind === "active") {
                    run("UPDATE contexts SET root_id=?,updated_at=? WHERE handle=?", workspace.id, Date.now(), current.record.handle);
                    record = getContextRecord(p, current.record.handle);
                  } else {
                    record = createContext(p, workspace, observedProtocol, {
                      auth_kind: auth.kind,
                      oauth_client_id: auth.clientId || "",
                      client_name: auth.clientName || "",
                      user_agent: req.headers.get("user-agent") || "",
                    });
                  }
                  postOsNotification("session", "📂 Workspace Opened", sessionNotificationLabel(p, record, null, Date.now(), workspace.name));
                  const selection = { context: record, root: runtimeWorkspaceRoot(workspace) };
                  toolResult = await callTool(
                    p, x.params.name, toolArgs,
                    { authKind: auth.kind, contextHandle: record.handle, selection, descriptor, requestStream, progressRequested },
                  );
                }
              } else {
                const resolution = resolveContext(p, toolArgs.context_handle, observedProtocol);
                if (resolution.kind === "active") {
                  const selection = { context: resolution.record, root: selectedContextRoot(p, resolution.record) };
                  toolResult = await callTool(
                    p, x.params.name, toolArgs,
                    { authKind: auth.kind, contextHandle: resolution.record.handle, selection, descriptor, requestStream, progressRequested },
                  );
                } else toolResult = contextControlToolResult(p, x.params.name, toolArgs, resolution, descriptor, progressRequested);
              }
              return toolResult;
            };
            const customProcessTool = !!one("SELECT 1 present FROM custom_tools WHERE server_id=? AND name=?", p.id, x.params.name);
            const streamingTool = x.params.name === "exec_attach" ||
              (progressRequested && (x.params.name === "exec" || customProcessTool));
            const acceptsSse = acceptsMediaType(req.headers.get("accept"), "text/event-stream");
            const wrapResult = toolResult => ({
              jsonrpc: "2.0", id: x.id,
              result: { resultType: "complete", ...toolResult, _meta: serverInfoMeta },
            });
            if (streamingTool && acceptsSse) {
              return mcpSseResponse(
                x.id, requestMeta.progressToken,
                async requestStream => wrapResult(await invokeTool(requestStream)),
                { "mcp-protocol-version": responseProtocol },
              );
            }
            r.result = modernRequest
              ? wrapResult(await invokeTool(null)).result
              : await invokeTool(null);
          }
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
      mcp_port: mcpHttpsPort, mcp_port_base: HTTPS_PORT,
      mcp_http_enabled: true, mcp_http_port: mcpHttpPort, mcp_http_port_base: HTTP_PORT, mcp_http_active: mcpHttpActive,
      mcp_http_role: "acme-only", acme_http_available: mcpHttpActive && mcpHttpPort === HTTP_PORT,
      mcp_https_enabled: true, mcp_https_port: mcpHttpsPort, mcp_https_port_base: HTTPS_PORT, mcp_https_active: mcpTlsActive,
      debug_http_log: getCfg("debug_http_log", "0") === "1",
      desktop_notifications_session: desktopNotificationEnabled("session"),
      desktop_notifications_workspace: desktopNotificationEnabled("workspace"),
      desktop_notifications_tool_call: desktopNotificationEnabled("tool_call"),
      inherit_system_path: getCfg("inherit_system_path", "1") === "1",
      external_url: getCfg("external_url", ""), gui_transport: "Tauriless local asset protocol",
      listener_fallback: listenerFallbacks().length > 0, listener_fallbacks: listenerFallbacks(),
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

  const rootAssignmentsProjection = (serverId, roots = rootsProjection(serverId)) => {
    const rootIds = new Set(roots.map(root => Number(root.id)));
    const sessions = all(`SELECT c.id,c.root_id,c.last_active_at,c.created_at,c.client_name,
        (SELECT COUNT(*) FROM logs l WHERE l.context_id=c.id) tool_calls
      FROM contexts c WHERE c.server_id=? AND c.handle LIKE 'ctx_%'
      ORDER BY c.last_active_at DESC,c.created_at DESC`, serverId).map(context => ({
        pk: context.id,
        root_id: rootIds.has(Number(context.root_id)) ? Number(context.root_id) : 0,
        client_name: context.client_name || "Unknown client",
        created_at: context.created_at,
        last_active_at: context.last_active_at,
        tool_calls: Number(context.tool_calls || 0),
        expired: contextExpired(context),
      }));
    const byRoot = new Map(roots.map(root => [Number(root.id), []]));
    const defaultSessions = [];
    for (const session of sessions) {
      if (session.root_id && byRoot.has(session.root_id)) byRoot.get(session.root_id).push(session);
      else defaultSessions.push({ ...session, root_id: 0 });
    }
    return {
      roots: roots.map(root => ({ ...root, sessions: byRoot.get(Number(root.id)) || [] })),
      default_sessions: defaultSessions,
      default_root: { name: "Program folder" },
    };
  };

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
        workspace_name: root?.name || "Program folder",
        workspace_path: root?.path || APP_DIR,
        workspace_id: root?.id || 0,
        fallback_workspace: !root,
      };
    });
  };

  const oauthProjection = () => all(`SELECT c.*,
      (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id=c.client_id) token_count,
      (SELECT MAX(t.created_at) FROM oauth_tokens t WHERE t.client_id=c.client_id) last_token_at,
      (SELECT COUNT(*) FROM oauth_refresh_tokens r WHERE r.client_id=c.client_id) refresh_token_count,
      (SELECT MAX(r.last_used_at) FROM oauth_refresh_tokens r WHERE r.client_id=c.client_id) last_refresh_at,
      (SELECT COUNT(*) FROM contexts x WHERE x.oauth_client_id=c.client_id) session_count,
      (SELECT MIN(x.created_at) FROM contexts x WHERE x.oauth_client_id=c.client_id) first_session_at,
      (SELECT MAX(x.created_at) FROM contexts x WHERE x.oauth_client_id=c.client_id) last_session_at
      FROM oauth_clients c ORDER BY c.created_at DESC`);

  function liveTrashProjection(p) {
    const roots = [APP_DIR, ...all("SELECT path FROM roots WHERE server_id=? ORDER BY id", p.id).map(row => configuredRootPath(row.path))];
    const unique = new Map(), actions = [];
    for (const root of roots) unique.set(Deno.build.os === "windows" ? resolve(root).toLowerCase() : resolve(root), resolve(root));
    for (const root of unique.values()) {
      const trashRoot = join(root, ".mrmcp", "trash");
      try {
        for (const entry of Deno.readDirSync(trashRoot)) {
          if (!entry.isDirectory || !/^\d{8}-\d{6}(?:-\d+)?$/.test(entry.name)) continue;
          const trashPath = join(trashRoot, entry.name);
          let lastAt = 0;
          try { lastAt = Deno.statSync(trashPath).mtime?.getTime() || 0; } catch {}
          actions.push({ action_id: entry.name, trash_path: trashPath, last_at: lastAt });
        }
      } catch {}
    }
    actions.sort((a, b) => b.last_at - a.last_at || b.action_id.localeCompare(a.action_id));
    const latest = actions[0];
    return latest
      ? { count: actions.length, ...latest }
      : { count: 0, last_at: null, action_id: "", trash_path: "" };
  }

  function trashActivityProjection(p, tool) {
    const count = Number(one(
      "SELECT COUNT(*) n FROM logs WHERE server_id=? AND tool=? AND status='completed'", p.id, tool,
    )?.n || 0);
    const row = one(`SELECT started_at,completed_at,root_path,resolved_json FROM logs
      WHERE server_id=? AND tool=? AND status='completed' ORDER BY id DESC LIMIT 1`, p.id, tool);
    if (!row) return { count, last_at: null, action_id: "", trash_path: "" };
    const result = parseJson(row.resolved_json, {}), actionId = String(result?.action_id || "");
    let relativeTrashPath = String(result?.trash_path || "");
    if (!relativeTrashPath && tool === "untrash_action" && actionId) {
      const original = one(`SELECT resolved_json FROM logs
        WHERE server_id=? AND tool='trash_paths' AND status='completed' AND instr(resolved_json,?)>0
        ORDER BY id DESC LIMIT 1`, p.id, `\"action_id\":\"${actionId}\"`);
      relativeTrashPath = String(parseJson(original?.resolved_json || "", {})?.trash_path || "");
    }
    if (!relativeTrashPath && actionId) relativeTrashPath = `.mrmcp/trash/${actionId}`;
    const trashPath = row.root_path && relativeTrashPath
      ? join(String(row.root_path), ...relativeTrashPath.replaceAll("\\", "/").split("/"))
      : relativeTrashPath;
    return {
      count,
      last_at: row.completed_at || row.started_at,
      action_id: actionId,
      trash_path: trashPath,
    };
  }

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
      fallback_workspace_path: APP_DIR,
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
    const result = { version: VERSION, settings: settingsProjection(), mcp_protocols: MCP_PROTOCOLS,
      maintenance: maintenanceProjection(), header_activity: headerActivityProjection(p) };
    let roots;
    if (["all", "sessions", "roots"].includes(section)) {
      roots = rootsProjection(p.id);
      result.roots = roots;
    }
    if (["all", "roots"].includes(section)) result.root_assignments = rootAssignmentsProjection(p.id, roots);
    if (["all", "sessions", "logs"].includes(section)) {
      roots ||= rootsProjection(p.id);
      result.context_values = contextProjection(p.id, roots, section === "sessions" ? uiState.sessions.oauthClientId : "");
    }
    if (["all", "dashboard"].includes(section)) {
      result.server = serverProjection(p);
      result.active_tool_calls = dashboardToolCallsProjection(p);
      result.stats = {
        context_values: one("SELECT COUNT(*) n FROM contexts WHERE server_id=? AND handle LIKE 'ctx_%'", p.id)?.n || 0,
        roots: one("SELECT COUNT(*) n FROM roots WHERE server_id=? AND enabled=1", p.id)?.n || 0,
        logs: one("SELECT COUNT(*) n FROM logs")?.n || 0,
        in_flight: activeCallControls.size,
        failures: one("SELECT COUNT(*) n FROM logs WHERE status='failed'")?.n || 0,
        total_requests: one("SELECT value n FROM metrics WHERE name='requests'")?.n || 0,
      };
      result.trash_activity = {
        trash: liveTrashProjection(p),
        untrash: trashActivityProjection(p, "untrash_action"),
      };
    }
    if (["all", "oauth"].includes(section)) result.oauth_clients = oauthProjection();
    return result;
  };

  async function restartMcp() {
    await Promise.allSettled([mcpHttpServer?.shutdown(), mcpHttpsServer?.shutdown()]);
    mcpHttpServer = mcpHttpsServer = undefined;
    mcpHttpPort = HTTP_PORT;
    mcpHttpsPort = HTTPS_PORT;
    mcpHttpActive = mcpTlsActive = mcpTlsValid = mcpTlsTrusted = false;
    mcpTlsKind = "none";
    mcpTlsInfo = null;
    mcpListenError = "";
    const errors = [];

    try {
      const bound = serveWithPortFallback(HTTP_PORT, port => Deno.serve(
        { hostname: PUBLIC_HOST, port, automaticCompression: true, onListen() {} },
        (req, info) => tracedHttp(req, info, () => {
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
        }, false),
      ));
      mcpHttpServer = bound.server;
      mcpHttpPort = bound.port;
      mcpHttpActive = true;
    } catch (error) {
      errors.push(`ACME HTTP listener 0.0.0.0:80: ${String(error?.message || error)}`);
    }

    try {
      const material = await selectTlsMaterial();
      const bound = serveWithPortFallback(HTTPS_PORT, port => Deno.serve(
        {
          hostname: PUBLIC_HOST, port, automaticCompression: true,
          cert: material.certificate, key: material.key, onListen() {},
        },
        (req, info) => tracedMcp(req, info, "https"),
      ));
      mcpHttpsServer = bound.server;
      mcpHttpsPort = bound.port;
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

  const fragmentTemplates = {
    sidebar: `<? const current=it.data?.state?.currentSection||"dashboard",items=[["dashboard","🏠","Dashboard"],["oauth","🔐","Clients"],["sessions","💬","Sessions"],["roots","📁","Workspaces"],["logs","🛠️","Tool Calls"],["commands","🧰","Commands"],["debug","🐞","HTTP Log"],["settings","⚙️","Settings"],["help","❓","Help"]]; items.forEach(([id,icon,label])=>{ ?><button data-page="<?= id ?>" class="<?= current===id?'nav-active':'' ?>"<?= current===id?' aria-current=page':'' ?>><span class=menu-icon><?= icon ?></span><?= label ?></button><? }) ?>`,
    view: `<? const s=it.data?.state||{},section=s.currentSection||"dashboard",settings=s.settings||{}; ?>
<? if(section==="dashboard"){ ?><section id=dashboard class=page><div class=row><h2 class=grow>🏠 Dashboard</h2><span class=muted>Runtime · activity · endpoints</span></div><div id=cards class=grid></div><div class=row><h3 class=grow>🛠️ Active Tool Calls</h3><span class=muted>Live · finished calls remain for 3s</span></div><div id=activeToolCalls></div><div id=trashActivity class=grid></div><div class=dashboard-grid><div><h3>🌐 Server</h3><div id=endpoints></div></div><div><h3>🔒 TLS and Connectivity</h3><div id=tlsStatus></div></div></div></section>
<? } else if(section==="sessions"){ ?><section id=sessions class=page><div class=row><h2 class=grow>💬 Sessions</h2><span class=muted>Live updates</span></div><p class=muted>Persistent MCP Sessions. Each Session is attached to a <b>📁 Workspace</b>.</p><? if(s.sessions?.oauthClientId){ ?><div class=row><span class=muted>OAuth filter</span><code><?= s.sessions.oauthClientId ?></code><button class=small data-action=clear-session-oauth>✕ Clear</button></div><? } ?><div class=card><b>Client Continuity</b><p class=muted>ChatGPT may create a new Session after model or thinking changes. Client/auth/User-Agent metadata is best effort.</p></div><div id=contextList></div></section>
<? } else if(section==="roots"){ ?><section id=roots class=page><div class=row><h2 class=grow>📁 Workspaces</h2><button class=primary data-action=new-root>➕ Add Workspace</button></div><p class=muted>Workspace names are unique. Drag Sessions to change where future Tool Calls run; running processes stay in their original folder.</p><div id=rootList></div></section>
<? } else if(section==="commands"){ const c=s.commands||{}; ?><section id=commands class=page><div class=row><h2 class=grow>🧰 Extra Commands</h2><button data-action=download-all-commands>⬇️ Download All</button><button class=primary data-action=new-command>➕ Register Command</button></div><p class=muted><code>commands.yaml</code> defines catalog entries. Executables in <code>.mrmcp/bin</code> appear automatically.</p><div class=row><input id=commandQuery class=grow placeholder="Search name, path or description…" value="<?= c.query||'' ?>"><label class=small><input id=commandIncludeMissing type=checkbox<?= c.includeMissing!==false?' checked':'' ?>> Show Unavailable</label><select id=commandPageSize><? [10,25,50,100].forEach(n=>{ ?><option<?= Number(c.pageSize||25)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=load-commands>🔎 Search</button></div><div id=commandList></div></section>
<? } else if(section==="logs"){ const l=s.logs||{}; ?><section id=logs class=page><h2>🛠️ Tool Calls</h2><p class=muted>Click a row for details. Terminate active work from Actions.</p><div class=row><input id=logQuery class=grow placeholder="Search input, output, errors…" value="<?= l.query||'' ?>"><select id=logContext><option value="">All sessions</option><? (s.contextValues||[]).forEach(v=>{ ?><option value="<?= v.pk ?>"<?= String(l.context||"")===String(v.pk)?" selected":"" ?>>#<?= v.pk ?></option><? }) ?></select><select id=logStatus class="<?= l.status||'' ?>"><option value="">All states</option><? ['completed','failed','invalid','running'].forEach(v=>{ ?><option class="<?= v ?>" value="<?= v ?>"<?= l.status===v?' selected':'' ?>><?= v ?></option><? }) ?></select><select id=logPageSize><? [10,25,50,100].forEach(n=>{ ?><option<?= Number(l.pageSize||25)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=clear-log-filters>🧹 Clear Filters</button></div><? if(l.selfTest){ ?><div id=logSelfTest class=card><div class=row><h3 class=grow>🧪 MCP Self-Test</h3><button class=small data-action=copy-detail data-target=logDetail>📋 Copy JSON</button><button class=small data-action=close-self-test>✕ Close</button></div><pre id=logDetail><?= it.pretty(l.selfTest) ?></pre></div><? } ?><div id=logList></div></section>
<? } else if(section==="debug"){ const d=s.debug||{},enabled=!!s.debug?.enabled; ?><section id=debug class=page><div class=row><h2 class=grow>🐞 HTTP Debug Log</h2><button class="debug-toggle <?= enabled?'enabled':'disabled' ?>" data-action=toggle-debug-settings aria-pressed="<?= enabled?'true':'false' ?>"><?= enabled?"🟢 Logging ON · Disable":"🔴 Logging OFF · Enable" ?></button><button class=danger data-action=clear-debug>🗑️ Clear</button></div><p class=muted>Off by default. Secrets are redacted. Disabling stops new records but keeps stored data visible. Click a row for request JSON.</p><div class=row><input id=debugQuery class=grow placeholder="Search URL, headers, body or errors…" value="<?= d.query||'' ?>"><select id=debugMethod><option value="">All methods</option><? ['GET','POST','OPTIONS'].forEach(v=>{ ?><option<?= d.method===v?' selected':'' ?>><?= v ?></option><? }) ?></select><input id=debugStatus type=number placeholder="Status" value="<?= d.status||'' ?>"><button data-action=load-debug>🔎 Search</button></div><div id=debugList></div></section>
<? } else if(section==="oauth"){ ?><section id=oauth class=page><h2>🔐 OAuth Clients</h2><div id=oauthList></div></section>
<? } else if(section==="settings"){ ?><section id=settings class=page><div class=row><h2 class=grow>⚙️ Settings</h2><button class=primary data-action=save-settings<?= settings.save_disabled?' disabled':'' ?>>💾 Save Settings</button></div><div class=grid><div class=card><h3>🌐 Listeners</h3><p><b>HTTP</b> <code>0.0.0.0:<?= settings.mcp_http_port ?></code><? if(settings.mcp_http_port!==settings.mcp_http_port_base){ ?> <span class=pending>⚠ fallback from <?= settings.mcp_http_port_base ?></span><? } ?> · ACME HTTP-01 <?= settings.acme_http_available?"available":"unavailable" ?></p><p><b>HTTPS</b> <code>0.0.0.0:<?= settings.mcp_https_port ?></code><? if(settings.mcp_https_port!==settings.mcp_https_port_base){ ?> <span class=pending>⚠ fallback from <?= settings.mcp_https_port_base ?></span><? } ?> · MCP, OAuth and metadata</p><p><b>GUI</b> <code><?= settings.gui_transport ?></code> · local-only, no network listener</p><label>Public IPv4</label><div class=row><input id=publicIp readonly class=grow value="<?= settings.public_ip||'' ?>"><button data-action=detect-ip>🔎 Detect</button></div><div class=row><label class=grow>Public base URL override</label><? if(settings.field_warnings?.external_url){ ?><span class=field-warning>⚠ <?= settings.field_warnings.external_url ?></span><? } ?></div><input id=externalUrl class=grow placeholder="https://mcp.example.com" value="<?= settings.external_url||'' ?>"><div class=row><label class=grow>Public IPv4 lookup URLs (one per line)</label><? if(settings.field_warnings?.public_ip_urls){ ?><span class=field-warning>⚠ <?= settings.field_warnings.public_ip_urls ?></span><? } ?></div><textarea id=publicIpUrls><?= (settings.public_ip_urls||[]).join("\\n") ?></textarea><div class=row><label class=grow>Automatic DNS suffix</label><? if(settings.field_warnings?.sslip_suffix){ ?><span class=field-warning>⚠ <?= settings.field_warnings.sslip_suffix ?></span><? } ?></div><input id=sslipSuffix placeholder="sslip.io" value="<?= settings.sslip_suffix||'sslip.io' ?>"><div class=row><label class=grow>ACME directory URL</label><? if(settings.field_warnings?.acme_directory_url){ ?><span class=field-warning>⚠ <?= settings.field_warnings.acme_directory_url ?></span><? } ?></div><input id=acmeDirectoryUrl class=grow value="<?= settings.acme_directory_url||'' ?>"></div><div class=card><h3>🔒 Certificate</h3><div class=row><label class=grow>Let's Encrypt email</label><? if(settings.field_warnings?.tls_email){ ?><span class=field-warning>⚠ <?= settings.field_warnings.tls_email ?></span><? } ?></div><input id=tlsEmail value="<?= settings.tls_email||'' ?>"><div class=row><button data-action=issue-cert>🛡️ Check / Request Certificate</button></div><p class=muted>Valid certificates are reused. ACME HTTP-01 requires effective HTTP port 80.</p></div><div class=card><h3>🔔 Desktop Notifications</h3><label><input id=notifySession type=checkbox<?= settings.desktop_notifications_session?" checked":"" ?>> Session notifications</label><label><input id=notifyWorkspace type=checkbox<?= settings.desktop_notifications_workspace?" checked":"" ?>> Workspace notifications</label><label><input id=notifyToolCall type=checkbox<?= settings.desktop_notifications_tool_call?" checked":"" ?>> Tool Call notifications</label><p class=muted>Windows already identifies notifications as belonging to MrMCP. Session references include Workspace, creation age and Tool Call count.</p></div><div class=card><h3>🖥️ Process Environment</h3><label><input id=inheritSystemPath type=checkbox<?= settings.inherit_system_path?" checked":"" ?>> Include the system PATH in spawned processes and commands</label><p class=muted>Off: child <code>PATH</code> contains only <code>.mrmcp/bin</code>. Other environment variables are unchanged.</p></div><div class=card><h3>🧹 Database</h3><p class=muted>Clears Tool Calls, process/HTTP history, published HTML and metrics. Keeps auth, Sessions, Workspaces, settings, tools and files.</p><? const m=s.maintenance||{},busy=m.active&&m.action==="database"; ?><button class=danger data-action=clear-database<?= m.active?" disabled":"" ?>><? if(busy){ ?><span class=spinner>↻</span> <?= m.phase==="waiting" ? m.in_flight+" in flight · "+m.waiting+" waiting" : "Clearing · "+m.waiting+" waiting" ?><? } else { ?>🗑️ Clear Operational Data<? } ?></button></div></div></section>
<? } else if(section==="help"){ ?><section id=help class=page><h2>❓ Help</h2><div class=card><h3>Connect ChatGPT Web</h3><ol><li>Make sure the Dashboard shows a trusted HTTPS certificate. ChatGPT needs a remote HTTPS MCP endpoint; use <code><?= settings.external_base_url ? settings.external_base_url + "/mcp" : "https://your-host/mcp" ?></code>.</li><li>In ChatGPT Web, enable Developer mode. In managed workspaces the current path is <b>Workspace settings → Permissions &amp; Roles → Connected Data Developer mode / Create custom MCP connectors</b>. Authorized users may also find the toggle under <b>Settings → Apps → Advanced Settings</b>.</li><li>Create a custom app from <b>Workspace settings → Apps → Create</b> or <b>Settings → Apps → Create</b>, enter the MrMCP endpoint, choose the offered authentication method, then select <b>Scan Tools</b>.</li><li>If OAuth is enabled in MrMCP, complete the authorization prompt. After the tool scan completes, create the app and select it from a new ChatGPT conversation.</li></ol></div><div class=card><h3>Authentication</h3><p>For ChatGPT, OAuth is the preferred MrMCP setup because ChatGPT can discover the authorization metadata, complete consent, and keep refresh-token connectivity. MrMCP also supports Basic authentication for MCP clients that offer it. Authentication grants access to the server; the <code>context_handle</code> selects persistent context state after authentication.</p></div><div class=card><h3>Write Access</h3><p>MrMCP does not maintain a separate read/write allowlist: every authenticated client receives every published tool. ChatGPT controls whether write/modify actions are usable through the app's permissions and action controls. As of this build, OpenAI documents full MCP write/modify support for Business, Enterprise and Edu; Pro custom MCP access is limited to read/fetch, and availability may change. Test write tools in Developer mode first. Where available, use <b>Workspace settings → Apps → Configure Actions / Action control</b> to enable the required actions. ChatGPT may still ask for confirmation before a write.</p></div><div class=card><h3>Using MrMCP in a Chat</h3><ol><li>Start a new chat and select the MrMCP app from the tools/apps menu.</li><li>If needed, call <code>list_workspaces</code> to discover the enabled Workspace names, then call <code>open_workspace</code> with the desired <code>name</code>. When continuing an existing Session, also pass its handle as <code>current_context_handle</code>; MrMCP moves that same Session to the Workspace. If the handle is omitted, empty, unknown or expired, a new Session is created.</li><li>The result already includes <code>workspace_name</code>, absolute <code>cwd</code> and <code>agent_guidance_path</code>. Read that file when non-null, then reuse the returned <code>context_handle</code> on later Session-bound calls. The Workspaces page can also move Sessions manually.</li><li>If you change ChatGPT model or thinking level, the MCP context may be recreated even inside the same conversation. Check the Sessions page if continuity matters.</li></ol><p class=muted>ChatGPT UI labels and plan availability can change. Current OpenAI references: <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target=_blank rel=noopener>Developer mode and MCP apps in ChatGPT</a> · <a href="https://help.openai.com/en/articles/11487775-connectors-in-chatgpt" target=_blank rel=noopener>Apps in ChatGPT</a>.</p></div></section><? } ?>`,
    dialogs: `<? const dialog=it.data?.state?.dialog; ?><? if(dialog){ ?><div id=dialogOverlay class=dialog-overlay><? if(dialog.kind==="root"){ const r=dialog.data||{}; ?><dialog id=rootDialog open data-managed-dialog=root><form id=rootForm><input id=rid type=hidden value="<?= r.id||'' ?>"><h2>📁 Workspace</h2><div class=row><label class=grow>Workspace name</label><? if(r.name_warning){ ?><span class=field-warning>⚠ <?= r.name_warning ?></span><? } ?></div><input id=rname value="<?= r.name||'' ?>"><div class=row><label class=grow>Directory path</label><? if(r.path_warning){ ?><span class=field-warning>⚠ <?= r.path_warning ?></span><? } else if(!r.path_checked){ ?><span class=muted>Leave the field to validate the directory.</span><? } ?></div><input id=rpath placeholder="C:\\projects\\my-workspace, /srv/my-workspace or ./project" value="<?= r.path||'' ?>"><div class=muted>Relative to the program folder.</div><label><input id=renabled type=checkbox<?= r.enabled!==false?' checked':'' ?>> Enabled</label><? if(r.form_warning){ ?><div class=field-warning>⚠ <?= r.form_warning ?></div><? } ?><p class=row><button class=primary type=submit<?= (r.name_warning||r.path_warning||!r.path_checked||r.form_warning)?' disabled':'' ?>>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="command"){ const c=dialog.data||{}; ?><dialog id=commandDialog open data-managed-dialog=command><form id=commandForm><input id=coldName type=hidden value="<?= c.registered?c.name:'' ?>"><h2>🧰 Command Catalog Entry</h2><div class=row><label class=grow>Logical name</label><? if(c.name_warning){ ?><span class=field-warning>⚠ <?= c.name_warning ?></span><? } ?></div><input id=cname value="<?= c.name||'' ?>"><div class=row><label class=grow>Path below .mrmcp/bin</label><? if(c.path_warning){ ?><span class="<?= c.path_error?'field-warning':'muted' ?>"><?= c.path_error?'⚠ ':'' ?><?= c.path_warning ?></span><? } else if(!c.path_checked){ ?><span class=muted>Leave the field to validate the path.</span><? } ?></div><input id=cpath placeholder="Optional; defaults to logical name; Windows suffix optional" value="<?= c.path||'' ?>"><label>Description for the agent</label><textarea id=cdescription placeholder="Optional: what it does and when the agent should use it."><?= c.description||'' ?></textarea><div class=row><label class=grow>Download URL</label><? if(c.download_warning){ ?><span class=field-warning>⚠ <?= c.download_warning ?></span><? } ?></div><input id=cdownloadUrl placeholder="https://example.com/tool" value="<?= c.download_url||'' ?>"><div class=row><label class=grow>Documentation URL</label><? if(c.documentation_warning){ ?><span class=field-warning>⚠ <?= c.documentation_warning ?></span><? } ?></div><input id=cdocumentationUrl placeholder="https://example.com/docs" value="<?= c.documentation_url||'' ?>"><? if(c.form_warning){ ?><div class=field-warning>⚠ <?= c.form_warning ?></div><? } ?><p class=row><button class=primary type=submit<?= (c.name_warning||c.path_error||!c.path_checked||c.download_warning||c.documentation_warning||c.form_warning)?' disabled':'' ?>>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="confirm"){ ?><dialog id=confirmDialog open data-managed-dialog=confirm><h2>⚠️ <?= dialog.title||"Confirm Action" ?></h2><p><?= dialog.message||"Continue?" ?></p><p class=row><button class="primary danger" data-action=confirm-dialog>✓ Confirm</button><button data-action=close-dialog>✕ Cancel</button></p></dialog><? } ?></div><? } ?>`,
    status: `<? const d=it.data||{},s=d.settings||{},a=d.activity||{},bad=!!s.mcp_listen_error,warn=!!s.listener_fallback,recent=a.recent_sessions||[],inFlight=a.tool_calls_in_flight||0,errors=a.tool_calls_errors||0,invalid=a.tool_calls_invalid||0; ?><span class="status-group <?= d.live!=="connected"?(d.live==="reconnecting"?"pending":"failed"):(bad?"failed":(warn?"pending":"ok")) ?>"><?= d.live!=="connected"?(d.live==="reconnecting"?"🟡 reconnecting":"🔴 offline"):(bad?"🔴 listener error":(warn?"🟡 fallback":"🟢 live")) ?></span><span class="status-group status-link" data-action=header-settings title="HTTP / HTTPS effective listener ports; GUI uses local Tauriless assets">🔌 <span class=status-ports><?= s.mcp_http_active?s.mcp_http_port:"off" ?>/<?= s.mcp_https_active?s.mcp_https_port:"off" ?></span><? if(warn){ ?> <span class=pending>⚠</span><? } ?></span><span class=status-group title="Sessions with a Tool Call in the last <?= a.active_window_minutes||10 ?> minutes">💬 <span class="status-link <?= a.active_sessions?'ok':'muted' ?>" data-action=header-sessions><?= a.active_sessions||0 ?> active</span><? if(recent.length){ ?> · <span class=status-sessions><? recent.forEach((x,i)=>{ ?><?= i?" ":"" ?><span class=status-link data-action=session-tool-calls data-id="<?= x.id ?>">#<?= x.id ?>(<?= x.tool_calls ?>)</span><? }) ?></span><? } ?></span><span class=status-group title="Tool Calls in flight / total recorded / failed / invalid">🛠️ <span class="status-link <?= inFlight?'pending':'muted' ?>" data-action=header-tool-calls data-status=running><?= inFlight ?> in flight</span> · <span class="status-link status-total" data-action=header-tool-calls data-status=""><?= a.tool_calls_total||0 ?> total</span> · <span class="status-link <?= errors?'failed':'muted' ?>" data-action=header-tool-calls data-status=failed><?= errors ?> errors</span> · <span class="status-link <?= invalid?'invalid':'muted' ?>" data-action=header-tool-calls data-status=invalid><?= invalid ?> invalid</span></span>`,
    cards: `<? const meta={sessions:["💬","Sessions"],roots:["📁","Workspaces"],tool_calls:["🛠️","Tool Calls"],tool_calls_in_flight:["🛠️","Tool Calls In Flight"],failed_calls:["⚠️","Failed Calls"],http_requests:["🌐","HTTP Requests"]}; Object.entries(it.data || {}).forEach(([key,value]) => { const item=meta[key]||["•",key]; ?><div class=card><div class=muted><?= item[0] ?> <?= item[1] ?></div><strong style="font-size:24px"><?= value ?></strong></div><? }) ?>`,
    active_tool_calls: `<? const rows=it.data||[],icons={completed:"✅",failed:"❌",invalid:"◆",killed:"❌",timed_out:"❌",running:"⏳",received:"⏳"}; ?><? if(!rows.length){ ?><div class="card muted">No active Tool Calls.</div><? } else { ?><div class="card dashboard-call-card"><table class=dashboard-call-table><thead><tr><th>State</th><th>Tool Call</th><th>Session</th><th>Time</th></tr></thead><tbody><? rows.forEach(l=>{ const ms=Number(l.elapsed_ms||0),elapsed=ms<1000?ms+"ms":(ms/1000).toFixed(ms<10000?1:0)+"s"; ?><tr class="<?= l.active?'':'dashboard-call-recent' ?>"<? if(!l.active){ ?> style="--dashboard-call-ttl:<?= Math.max(50,Number(l.ttl_ms||0)) ?>ms"<? } ?>><td class="<?= l.active?'pending':l.status ?> nowrap"><?= icons[l.status]||"•" ?> <?= l.active?"running":l.status ?></td><td class=dashboard-call-summary><code><?= l.tool ?></code><? if(l.call_preview){ ?> <span class=muted>·</span> <?= l.call_preview ?><? } ?><? if(l.progress_requested){ ?> <span class=progress-requested>📡 progress</span><? } ?></td><td class=idcell><?= l.context_id?"#"+l.context_id:"—" ?></td><td class=nowrap><?= elapsed ?><? if(!l.active){ ?> <span class=muted>· done</span><? } ?></td></tr><? }) ?></tbody></table></div><? } ?>`,
    trash_activity: `<? const d=it.data||{},m=d.maintenance||{},items=[["🗑️","Trash",d.trash,false],["↩️","Untrash",d.untrash,true]]; items.forEach(([icon,label,x,historical])=>{ x=x||{}; ?><div class=card><div class=row><div class=grow><div class=muted><?= icon ?> <?= label ?></div><strong style="font-size:24px"><?= x.count||0 ?></strong></div><? if(!historical){ const busy=m.active&&m.action==="trash"; ?><button class="small danger" data-action=empty-trash<?= m.active?" disabled":"" ?>><? if(busy){ ?><span class=spinner>↻</span> <?= m.phase==="waiting" ? m.in_flight+" in flight · "+m.waiting+" waiting" : "Emptying · "+m.waiting+" waiting" ?><? } else { ?>🗑️ Empty Trash<? } ?></button><? } ?><? if(x.last_at){ ?><div class=muted>Last <?= it.logdt(x.last_at) ?></div><? } ?></div><? if(x.last_at){ ?><div><span class=muted>Action</span> <code><?= x.action_id||"—" ?></code></div><div style="margin-top:5px"><span class=muted><?= historical?"Trash path (historical)":"Trash path" ?></span><br><code class=context-id><?= x.trash_path||"—" ?></code></div><? } else { ?><div class=muted><?= historical ? "No completed untrash actions." : "Trash is empty." ?></div><? } ?></div><? }) ?>`,
    tls: `<? const t=it.data||{}, problem=!t.tls_active_trusted||!!t.tls_last_error||!!t.mcp_listen_error; ?><div class="card <?= problem ? "tls-alert" : "tls-good" ?>"><div class=row><h3 class=grow>🔒 TLS / Let's Encrypt</h3><b class="<?= t.tls_active_trusted ? "ok" : "failed" ?>"><?= t.tls_active_trusted ? "trusted" : (t.tls_active ? "fallback active" : "offline") ?></b></div><div class=grid><div><span class=muted>HTTPS Listener</span><br><b><?= t.mcp_https_active ? "0.0.0.0:"+t.mcp_https_port+" active" : "not listening" ?></b></div><div><span class=muted>Active Certificate</span><br><b><?= t.tls_active_kind || "none" ?> · <?= t.tls_active_valid ? "valid" : "invalid" ?></b></div><div><span class=muted>Expires</span><br><b><?= it.dt(t.tls_active_expires) || "unknown" ?></b></div><div><span class=muted>Last ACME Request</span><br><b><?= it.dt(t.tls_last_request_at) || "never recorded" ?></b></div><div><span class=muted>Last ACME Result</span><br><b class="<?= t.tls_last_request_valid ? "ok" : (t.tls_last_request_status === "error" ? "failed" : "pending") ?>"><? if (t.tls_last_request_status) { ?><?= t.tls_last_request_status ?> · certificate <?= t.tls_last_request_valid ? "valid" : "not valid" ?><? } else { ?>not recorded<? } ?></b></div><div><span class=muted>Last Valid Certificate</span><br><b><?= it.dt(t.tls_last_issued_at) || "not recorded" ?></b></div><div><span class=muted>Renewal Due</span><br><b><?= it.dt(t.tls_renewal_due_at) || "as soon as allowed" ?></b></div><div><span class=muted>Rate-Limit Reset</span><br><b><?= it.dt(t.tls_rate_limit_reset_at) || "none" ?></b></div><div><span class=muted>Next ACME Attempt</span><br><b><?= it.dt(t.tls_next_attempt_at) || "not scheduled" ?></b></div></div><? if (t.tls_last_error || t.mcp_listen_error) { ?><pre class=tls-error><?= t.tls_last_error || t.mcp_listen_error ?></pre><? } ?><? if (!t.tls_active_trusted) { ?><p class=failed><b>Public clients such as ChatGPT will reject the self-signed fallback until Let's Encrypt succeeds.</b></p><? } ?></div>`,
    urls: `<? (it.data || []).forEach(x => { if (!x?.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?><? if (x.note) { ?> <span class=muted><?= x.note ?></span><? } ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?>`,
    roots: `<? const d=it.data||{},rows=d.roots||[],defaults=d.default_sessions||[]; ?><div class=roots-layout><div class=roots-named><h3>📁 Workspaces</h3><? if(!rows.length){ ?><div class=card><p class=muted>No Workspaces registered.</p></div><? } ?><? rows.forEach(r => { ?><div class="card root-card<?= r.enabled?'':' root-disabled' ?>"<? if(r.enabled){ ?> data-root-drop="<?= r.id ?>"<? } ?>><div class=root-card-header><div class=grow><h3>📁 <?= r.name ?></h3><code class="<?= r.path_warning?'failed':'' ?>"<? if(r.path_warning){ ?> title="<?= r.path_warning ?>"<? } ?>><?= r.path ?></code></div><div class=command-actions><button class=small data-action=edit-root data-id="<?= r.id ?>">✏️ Edit</button><button class="small danger" data-action=delete-root data-id="<?= r.id ?>">🗑️ Delete</button></div></div><div class="<?= r.enabled?'ok':'muted' ?>"><?= r.enabled ? "enabled" : "disabled" ?></div><div class=root-session-list><? if(!r.enabled){ ?><div class=muted>Enable this Workspace to assign Sessions.</div><? } else if(!(r.sessions||[]).length){ ?><div class=root-drop-empty>Drop a Session here</div><? } ?><? (r.sessions||[]).forEach(v=>{ ?><div class=session-chip draggable=true data-session-drag data-session-id="<?= v.pk ?>" title="Drag Session #<?= v.pk ?>"><div class=session-chip-main><span>💬</span><b>#<?= v.pk ?></b><span class=grow><?= v.client_name ?></span></div><div class=session-chip-meta><span><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></span><span><span class=muted>Last Activity</span> <?= it.logdt(v.last_active_at) ?></span><span><span class=muted>Status</span> <span class="<?= v.expired?'failed':'ok' ?>"><?= v.expired?'expired':'active' ?></span></span><span><span class=muted>Tool Calls:</span> <?= v.tool_calls||0 ?></span></div></div><? }) ?></div></div><? }) ?></div><div class=roots-default><div class=row><h3 class=grow>💬 Sessions</h3><span class=muted>No Workspace assigned</span></div><div class="card default-root-card" data-root-drop="0"><p class=muted>Uses the program folder until assigned to a Workspace.</p><div class=root-session-list><? if(!defaults.length){ ?><div class=root-drop-empty>Drop a Session here to remove its Workspace association.</div><? } ?><? defaults.forEach(v=>{ ?><div class=session-chip draggable=true data-session-drag data-session-id="<?= v.pk ?>" title="Drag Session #<?= v.pk ?>"><div class=session-chip-main><span>💬</span><b>#<?= v.pk ?></b><span class=grow><?= v.client_name ?></span></div><div class=session-chip-meta><span><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></span><span><span class=muted>Last Activity</span> <?= it.logdt(v.last_active_at) ?></span><span><span class=muted>Status</span> <span class="<?= v.expired?'failed':'ok' ?>"><?= v.expired?'expired':'active' ?></span></span><span><span class=muted>Tool Calls:</span> <?= v.tool_calls||0 ?></span></div></div><? }) ?></div></div></div></div>`,
    context: `<? const d=it.data||{},values=d.values||[]; ?><? if (!values.length) { ?><p class=muted>No Sessions have been issued yet.</p><? } else { ?><table><tr><th>ID</th><th>Session Handle</th><th>Client / Auth</th><th>State / Protocol</th><th>Current Workspace</th><th>Activity</th><th>Tool Calls</th><th></th></tr><? values.forEach(v=>{ const ua=String(v.user_agent||""); ?><tr><td class=idcell>#<?= v.pk ?></td><td class=context-id><code><?= v.context_handle ?></code></td><td><b><?= v.client_name||"Unknown client" ?></b><br><span class=muted><?= v.auth_kind||"unknown auth" ?></span><? if(ua){ ?><div class=muted title="<?= ua ?>"><?= ua.slice(0,72) ?><?= ua.length>72?"…":"" ?></div><? } ?></td><td class=nowrap><b class="<?= v.expired ? 'failed' : 'ok' ?>"><?= v.expired ? "⌛ expired" : "🟢 active" ?></b><br><code><?= v.protocol_version||"unknown" ?></code></td><td><b><?= v.workspace_name ?></b><div class="<?= v.workspace_warning?'failed':'muted' ?>"<? if(v.workspace_warning){ ?> title="<?= v.workspace_warning ?>"<? } ?>><?= v.workspace_path ?></div></td><td class=context-dates><div><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></div><div><span class=muted>Updated</span> <?= it.logdt(v.updated_at) ?></div><div><span class=muted>Active</span> <?= it.logdt(v.last_active_at) ?></div><div><span class=muted>Expires</span> <?= it.logdt(v.expires_at) ?></div></td><td class=nowrap><?= v.tool_calls||0 ?> <button class=small data-action=session-tool-calls data-id="<?= v.pk ?>">🛠️ View Calls</button></td><td><button class=danger data-action=delete-context data-id="<?= v.pk ?>">🗑️ Delete</button></td></tr><? }) ?></table><? } ?>`,
    commands: `<? const d=it.data || {}, rows=d.commands || []; ?><div class=muted><?= d.total || 0 ?> command<?= d.total === 1 ? "" : "s" ?> · page <?= d.page || 1 ?>/<?= d.pages || 1 ?> · config <code><?= d.config_file || "" ?></code></div><table class=commands-table><tr><th>Name</th><th>Relative path</th><th class=command-description>Description</th><th>Links</th><th>Source</th><th>State</th><th class=command-action-cell></th></tr><? rows.forEach(c => { ?><tr><td><code><?= c.name ?></code></td><td><code><?= c.path ?></code></td><td class=command-description><?= c.description || "—" ?></td><td><? if (c.documentation_url) { ?><a href="<?= c.documentation_url ?>" target=_blank rel=noopener>📖 Docs</a><? } else { ?>—<? } ?></td><td><?= c.source ?></td><td class="<?= c.present && c.executable ? "ok" : "failed" ?>"><?= c.present ? (c.executable ? "✅ available" : "⚠️ not executable") : "❌ missing" ?></td><td class=command-action-cell><div class=command-actions><button data-action=edit-command data-name="<?= c.name ?>" data-path="<?= c.path ?>">✏️ Edit</button><? if (c.registered && c.download_url) { ?><button data-action=download-command data-name="<?= c.name ?>">⬇️ Download</button><? } ?><? if (c.registered) { ?><button class=danger data-action=delete-command data-name="<?= c.name ?>">🗑️ Delete</button><? } ?></div></td></tr><? }) ?></table><div class=row><button data-action=commands-prev<?= d.page <= 1 ? " disabled" : "" ?>>Previous</button><button data-action=commands-next<?= d.has_more ? "" : " disabled" ?>>Next</button></div>`,
    oauth: `<table class=oauth-table><tr><th>Client</th><th>Sessions</th><th>Tokens</th><th></th></tr><? (it.data || []).forEach(c => { ?><tr><td class=oauth-client><b><?= c.name ?></b><div class=oauth-client-id title="<?= c.client_id ?>"><code><?= c.client_id ?></code></div><div class=oauth-meta><span class=muted>Created</span> <?= it.logdt(c.created_at) ?></div></td><td class=oauth-meta><div class=oauth-count><b><?= c.session_count||0 ?></b> total</div><div><span class=muted>First</span> <?= c.first_session_at ? it.logdt(c.first_session_at) : "—" ?></div><div><span class=muted>Last</span> <?= c.last_session_at ? it.logdt(c.last_session_at) : "—" ?></div></td><td><div class=oauth-tokens><div class=oauth-token><b><?= c.token_count||0 ?></b> <span>Access</span><div class=oauth-meta><span class=muted>Issued</span> <?= c.last_token_at ? it.logdt(c.last_token_at) : "—" ?></div></div><div class=oauth-token><b><?= c.refresh_token_count||0 ?></b> <span>Refresh</span><div class=oauth-meta><span class=muted>Used</span> <?= c.last_refresh_at ? it.logdt(c.last_refresh_at) : "—" ?></div></div></div></td><td class=oauth-actions><button class=small data-action=oauth-sessions data-id="<?= c.client_id ?>">💬 View Sessions</button><button class="small danger" data-action=revoke-client data-id="<?= c.client_id ?>">🚫 Revoke</button></td></tr><? }) ?></table>`,
    endpoints: `<? const server=it.data||{}; ?><div class=card><div class=row><div class=grow><h3 style="margin:0">🌐 MrMCP <code>/mcp</code></h3><div class=muted>Protocols: <?= (server.protocol_versions||[]).join(", ") ?></div></div><button data-action=self-test>🧪 Self-test</button></div><? it.endpointRows(server).forEach(x => { if (!x.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?><details><summary><?= server.tool_count||0 ?> Available Tools</summary><p class=muted><?= (server.tool_names||[]).join(", ") ?></p></details></div>`,
    logs: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1),statusIcons={completed:"✅",failed:"❌",invalid:"◆",running:"⏳",received:"📥"}; ?><div id=tool-call-pagination class="row log-pagination"><span class="muted grow"><?= d.total||0 ?> call<?= d.total===1?"":"s" ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Tool Call Pages"><button class=page-button data-action=logs-page data-log-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?" disabled":"" ?> aria-label="Previous page">‹</button><? items.forEach(item=>{ if(item==="…"){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?" active":"" ?>" data-action=logs-page data-log-page="<?= item ?>"<?= item===(d.page||1)?" aria-current=page":"" ?>><?= item ?></button><? } }) ?><button class=page-button data-action=logs-page data-log-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?" disabled":"" ?> aria-label="Next page">›</button></nav></div><table id=tool-call-table><thead><tr><th>ID</th><th>Time</th><th>Session</th><th>Tool</th><th>Status</th><th>Duration</th><th>Actions</th></tr></thead><tbody><? rows.forEach(l => { ?><tr id="tool-call-row-<?= l.id ?>" data-action=select-log data-id="<?= l.id ?>" title="Click to expand details"><td class=idcell>#<?= l.id ?></td><td class=nowrap><?= it.logdt(l.started_at) ?></td><td class=idcell><?= l.context_id ? "#"+l.context_id : "—" ?></td><td><code><?= l.tool ?></code><? if(l.call_preview){ ?><div class=tool-command-preview>↳ <?= l.call_preview ?></div><? } ?><? if(l.progress_requested){ ?><div class=progress-requested>📡 Progress requested</div><? } ?></td><td class="<?= l.status ?>"><?= statusIcons[l.status]||"•" ?> <?= l.status ?></td><td><?= l.duration_ms ?? "" ?><? if (l.duration_ms != null) { ?>ms<? } ?></td><td class=nowrap><? if(l.killable){ ?><button class=small data-action=terminate-log data-id="<?= l.id ?>">⏹️ Terminate</button> <button class="small danger" data-action=kill-log data-id="<?= l.id ?>">⚠️ Kill</button><? } else { ?>—<? } ?></td></tr><? if(String(d.openRowId||"")===String(l.id)&&d.openDetail){ const x=d.openDetail,terminal=it.terminal(x); ?><tr id="tool-call-detail-<?= l.id ?>" class=detail-row data-detail-kind=tool data-detail-id="<?= l.id ?>"><td colspan=7><div class=detail-panel><div class=row><b class=grow>Tool Call #<?= l.id ?></b><? if(x.progress_requested){ ?><span class=progress-requested>📡 Progress requested</span><? } ?><button class=small data-action=copy-detail data-target="tool-full-<?= l.id ?>">📋 Copy Full Row</button><button class=small data-action=close-row-detail data-kind=tool>✕ Close</button></div><pre id="tool-full-<?= l.id ?>" hidden><?= it.pretty(x) ?></pre><div class=tool-detail-grid><div class=tool-detail-main><? if(terminal){ ?><section id="tool-terminal-<?= l.id ?>" class=terminal-detail><div class="row terminal-title"><b class=grow>🖥️ Terminal</b><span class=muted><?= terminal.status ?><? if(terminal.termination_source){ ?> · <?= terminal.termination_source ?><? } ?><? if(terminal.requested_signal||terminal.signal){ ?> · <?= terminal.requested_signal&&terminal.signal&&terminal.requested_signal!==terminal.signal ? terminal.requested_signal+"→"+terminal.signal : (terminal.signal||terminal.requested_signal) ?><? } ?><? if(terminal.exit_code!==null){ ?> · exit <?= terminal.exit_code ?><? } ?></span></div><? if(terminal.command){ ?><div class=terminal-command><span class=prompt>&gt;</span><span><?= terminal.command ?></span></div><? } ?><? if(terminal.cwd){ ?><div class=terminal-cwd>cwd <code><?= terminal.cwd ?></code></div><? } ?><? if(terminal.stdin!==null){ ?><div class=terminal-stream-label>Stdin<?= terminal.stdin_encoding==="base64" ? " · base64" : "" ?></div><pre class=terminal-stdin><?= terminal.stdin ?></pre><? } ?><div class=terminal-stream-label>Output</div><pre><?= terminal.output || "(empty)" ?></pre></section><? } ?><section class=json-detail><div class=row><b class=grow>Input JSON</b><button class=small data-action=copy-detail data-target="tool-input-<?= l.id ?>">📋 Copy JSON</button></div><pre id="tool-input-<?= l.id ?>"><?= it.prettyParsed(x.input_json) ?></pre></section><? if(x.resolved_json){ ?><section class=json-detail><div class=row><b class=grow>Tool Return Value JSON</b><button class=small data-action=copy-detail data-target="tool-return-<?= l.id ?>">📋 Copy JSON</button></div><pre id="tool-return-<?= l.id ?>"><?= it.prettyParsed(x.resolved_json) ?></pre></section><? } ?><section class=json-detail><div class=row><b class=grow>MCP Result JSON</b><button class=small data-action=copy-detail data-target="tool-output-<?= l.id ?>">📋 Copy JSON</button></div><pre id="tool-output-<?= l.id ?>"><?= it.prettyParsed(x.result_json||x.resolved_json||x.stdout||{}) ?></pre></section><? if(x.stderr&&!terminal){ ?><section class=json-detail><b>Standard error</b><pre><?= x.stderr ?></pre></section><? } ?><? if(x.error){ ?><section class=json-detail><b>Error</b><pre><?= x.error ?></pre></section><? } ?></div><aside class=tool-descriptor><div class=row><b class=grow>Agent Tool Definition</b><? if(x.tool_descriptor){ ?><span class="descriptor-status <?= x.tool_descriptor_matches_current?'current':'outdated' ?>"><?= x.tool_descriptor_matches_current?'CURRENT':'OUTDATED' ?></span><button class=small data-action=copy-detail data-target="tool-descriptor-<?= l.id ?>">📋 Copy JSON</button><? } ?></div><? if(x.tool_descriptor){ ?><pre id="tool-descriptor-<?= l.id ?>" hidden><?= it.pretty(x.tool_descriptor) ?></pre><? if(x.tool_descriptor.title){ ?><div class=muted>Title</div><div><?= x.tool_descriptor.title ?></div><? } ?><div class=muted>Description</div><p><?= x.tool_descriptor.description||"—" ?></p><div class=muted>Input Schema</div><pre><?= it.pretty(x.tool_descriptor.inputSchema||{}) ?></pre><div class=muted>Output Schema</div><pre><?= it.pretty(x.tool_descriptor.outputSchema||{}) ?></pre><? } else { ?><p class=muted>No descriptor snapshot was recorded for this call.</p><? } ?></aside></div></div></td></tr><? } }) ?></tbody></table>`,
    debug: `<? const d=it.data||{},rows=d.rows||[]; ?><p class="<?= d.enabled?'ok':'failed' ?>"><b><?= d.enabled?'● Recording enabled':'● Recording disabled' ?></b><? if(!d.enabled){ ?> · showing stored requests<? } ?></p><? if(!rows.length){ ?><p class=muted>No stored HTTP debug requests match the current filters.</p><? } else { ?><table><tr><th>ID</th><th>Time</th><th>Session</th><th>Client</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>IP</th><th>Error</th></tr><? rows.forEach(r => { ?><tr data-action=select-debug data-id="<?= r.id ?>" title="Click to expand"><td class=idcell>#<?= r.id ?></td><td class=nowrap><?= it.logdt(r.ts) ?></td><td class=idcell><?= r.context_id ? "#"+r.context_id : "—" ?></td><td><? if(r.client_id){ ?><code><?= r.client_id ?></code><? } else { ?>—<? } ?></td><td><b><?= r.method ?></b></td><td><code><?= r.path ?></code></td><td class="<?= !r.status?'pending':(r.status>=400?'failed':'ok') ?>"><?= r.status||"…" ?></td><td><?= r.status ? r.duration_ms+"ms" : "in flight" ?></td><td class=nowrap><?= r.remote_addr||"—" ?><? if(r.remote_addr){ ?> (<?= r.remote_count||1 ?>)<? } ?></td><td><?= r.error_preview ?></td></tr><? if(String(d.openRowId||"")===String(r.id)&&d.openDetail){ const x=d.openDetail; ?><tr class=detail-row data-detail-kind=http data-detail-id="<?= r.id ?>"><td colspan=10><div class="detail-panel http-detail-panel"><div class="row http-detail-head"><div class=grow><b>HTTP Request #<?= r.id ?></b><div class=http-detail-meta><span><?= it.logdt(x.ts) ?></span><span><? if(x.context_id){ ?>Session #<?= x.context_id ?><? } else { ?>No Session<? } ?></span><span><? if(x.client_id){ ?>Client <code><?= x.client_id ?></code><? } else { ?>No client id<? } ?></span><span><?= x.remote_addr||"unknown IP" ?><? if(x.remote_addr){ ?> · <?= x.remote_count||1 ?> total request<?= Number(x.remote_count||1)===1?'':'s' ?><? } ?></span><span><?= x.status ? x.duration_ms+"ms" : "in flight" ?></span></div></div><button class=small data-action=copy-detail data-target="http-json-<?= r.id ?>">📋 Copy Full Row</button><button class=small data-action=close-row-detail data-kind=http>✕ Close</button></div><div class=http-detail-grid><section class=http-detail-block><div class=row><h4 class=grow>→ Request</h4><b><?= x.method ?></b> <code><?= x.path ?></code></div><div class=muted>Headers</div><pre><?= it.prettyParsed(x.request_headers||{}) ?></pre><div class=muted>Body</div><pre><?= it.prettyParsed(x.request_body||{}) ?></pre></section><section class=http-detail-block><div class=row><h4 class=grow>← Response</h4><b class="<?= !x.status?'pending':(x.status>=400?'failed':'ok') ?>"><?= x.status||"in flight" ?></b></div><div class=muted>Headers</div><pre><?= it.prettyParsed(x.response_headers||{}) ?></pre><div class=muted>Body</div><pre><?= it.prettyParsed(x.response_body||{}) ?></pre></section></div><? if(x.error){ ?><section class="http-detail-block http-detail-error"><h4 class=failed>Error</h4><pre><?= x.error ?></pre></section><? } ?><details class=http-detail-raw><summary>Raw record</summary><pre id="http-json-<?= r.id ?>"><?= it.pretty(x) ?></pre></details></div></td></tr><? } }) ?></table><? } ?>`,
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
  const fragmentShellArg = value => {
    const text = String(value ?? "");
    return /^[A-Za-z0-9_./:\\@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
  };
  const fragmentTerminalOutput = normalizeTerminalOutput;
  const fragmentTerminal = log => {
    if (!log) return null;
    const input = typeof log.input_json === "string" ? parseJson(log.input_json, {}) : (log.input_json || {});
    const resolved = typeof log.resolved_json === "string" ? parseJson(log.resolved_json, {}) : (log.resolved_json || {});
    const live = log.process && typeof log.process === "object" ? log.process : null;
    const source = live || resolved || {};
    const processLike = !!live || (source?.command != null && (
      source.output != null || source.stdout != null || source.stderr != null
    ));
    if (!processLike) return null;
    let command = "";
    if (typeof input.shell_command === "string" && input.shell_command) command = input.shell_command;
    else if (typeof input.program === "string" && input.program) command = [input.program, ...(Array.isArray(input.args) ? input.args : [])].map(fragmentShellArg).join(" ");
    else if (Array.isArray(source.command)) command = source.command.map(fragmentShellArg).join(" ");
    else if (typeof source.command === "string") {
      const parsed = parseJson(source.command, null);
      command = Array.isArray(parsed) ? parsed.map(fragmentShellArg).join(" ") : source.command;
    }
    const stdin = Object.prototype.hasOwnProperty.call(input, "stdin") ? String(input.stdin ?? "") : null;
    return {
      command,
      cwd: String(source.cwd || input.cwd || ""),
      stdin,
      stdin_encoding: String(input.stdin_encoding || "text"),
      output: fragmentTerminalOutput(live?.output ?? resolved.output ?? log.stdout ?? ""),
      status: String(source.status || log.status || ""),
      exit_code: source.exit_code ?? null,
      signal: String(source.signal || ""),
      requested_signal: String(source.requested_signal || ""),
      termination_source: String(source.termination_source || ""),
    };
  };
  const endpointRows = p => [
    ["MCP sslip.io", p.sslip_https_mcp_url], ["MCP direct IP", p.direct_ip_https_mcp_url],
    ["OAuth metadata", p.sslip_metadata_url], ["Local HTTPS", p.local_https_mcp_url],
    ["Basic URL", p.basic_url],
  ].map(([label, url]) => ({ label, url }));
  async function renderEtaFragment(name, data) {
    if (!fragmentTemplates[name]) throw new Error(`Unknown UI fragment: ${name}`);
    const context = {
      data, dt: fragmentDate, logdt: fragmentLogDate, pages: fragmentPageItems, endpointRows, terminal: fragmentTerminal,
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
    const headers = new Headers();
    let payload;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const request = new Request(`http://mrmcp.local${path}`, { method, headers, body: payload });
    const response = await guiApi(request, new URL(request.url));
    const raw = await response.text();
    const data = raw ? parseJson(raw, { error: raw }) : {};
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }
  function settingsFieldWarnings(settings = {}) {
    const warnings = {};
    const external = String(settings.external_url || "").trim();
    if (external) {
      try {
        const url = new URL(external);
        if (url.protocol !== "https:" || (url.port && url.port !== "443")) warnings.external_url = "Public base URL must use HTTPS on port 443.";
      } catch { warnings.external_url = "Public base URL is not a valid URL."; }
    }
    const urls = Array.isArray(settings.public_ip_urls)
      ? settings.public_ip_urls : String(settings.public_ip_urls || "").split(/\r?\n/);
    const invalidLookup = urls.map(String).map(value => value.trim()).filter(Boolean).find(value => {
      try { return new URL(value).protocol !== "https:"; } catch { return true; }
    });
    if (invalidLookup) warnings.public_ip_urls = "Every public IP lookup URL must be a valid HTTPS URL.";
    const suffix = String(settings.sslip_suffix || "").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(suffix) || !suffix.includes(".")) warnings.sslip_suffix = "Automatic DNS suffix must be a valid domain suffix.";
    const acme = String(settings.acme_directory_url || "").trim();
    try { if (!acme || new URL(acme).protocol !== "https:") warnings.acme_directory_url = "ACME directory must be a valid HTTPS URL."; }
    catch { warnings.acme_directory_url = "ACME directory must be a valid HTTPS URL."; }
    const email = String(settings.tls_email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) warnings.tls_email = "Let's Encrypt email is not valid.";
    return warnings;
  }
  function uiSettingsProjection(settings) {
    const draft = uiState.settingsDraft || {};
    const projected = { ...settings, ...draft };
    if (typeof projected.public_ip_urls === "string") projected.public_ip_urls = projected.public_ip_urls.split(/\r?\n/);
    projected.field_warnings = settingsFieldWarnings(projected);
    projected.save_disabled = Object.values(projected.field_warnings).some(Boolean);
    return projected;
  }
  async function buildUiRenderModel() {
    const section = UI_SECTIONS.has(uiState.currentSection) ? uiState.currentSection : "dashboard";
    const projection = state(section);
    const viewState = structuredClone(uiState);
    viewState.currentSection = section;
    viewState.settings = uiSettingsProjection(projection.settings);
    viewState.maintenance = projection.maintenance;
    viewState.contextValues = projection.context_values || [];
    viewState.debug.enabled = !!projection.settings.debug_http_log;
    const model = { section, projection, viewState, commandData: null, logData: null, debugData: null };
    if (section === "roots") {
      const rows = projection.root_assignments?.roots || [];
      const warnings = await Promise.all(rows.map(async root => [Number(root.id), await rootPathWarning(root.path)]));
      const byId = new Map(warnings);
      for (const root of rows) root.path_warning = byId.get(Number(root.id)) || "";
    } else if (section === "sessions") {
      const roots = projection.roots || [];
      const warnings = await Promise.all(roots.map(async root => [Number(root.id), await rootPathWarning(root.path)]));
      const byId = new Map(warnings);
      for (const context of projection.context_values || [])
        context.workspace_warning = context.fallback_workspace ? "" : (byId.get(Number(context.workspace_id)) || "");
    }
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
        tool_calls_in_flight: projection.stats?.in_flight || 0,
        failed_calls: projection.stats?.failures || 0,
        http_requests: projection.stats?.total_requests || 0,
      }));
      view = fillUiMount(view, "activeToolCalls", await renderEtaFragment("active_tool_calls", projection.active_tool_calls || []));
      view = fillUiMount(view, "trashActivity", await renderEtaFragment("trash_activity", {
        ...(projection.trash_activity || {}), maintenance: projection.maintenance,
      }));
      view = fillUiMount(view, "endpoints", await renderEtaFragment("endpoints", projection.server || {}));
      view = fillUiMount(view, "tlsStatus", await renderEtaFragment("tls", projection.settings));
    } else if (section === "sessions") {
      view = fillUiMount(view, "contextList", await renderEtaFragment("context", { values: projection.context_values || [] }));
    } else if (section === "roots") {
      view = fillUiMount(view, "rootList", await renderEtaFragment("roots", projection.root_assignments || {}));
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
      renderEtaFragment("status", { settings: projection.settings, activity: projection.header_activity, live: "connected" }),
      renderEtaFragment("dialogs", { state: viewState }),
    ]);
    const notice = uiState.notice
      ? `<div id=uiNotice class="notice-balloon ${htmlEscape(uiState.notice.kind || "error")}">${htmlEscape(uiState.notice.message || "")}</div>`
      : "";
    return `<div id="app" data-section="${htmlEscape(section)}"><header><div class=brand><img class=brand-mark src="${GUI_LOGO_DATA_URL}" alt=""><b>MrMCP <span class=muted>v${VERSION}</span></b></div><div id=uiStatus class=status>${status}</div></header>${notice}<aside><div id=sidebar>${sidebar}</div></aside><main><div id=mainView>${view}</div></main><div id=dialogHost>${dialogs}</div></div>`;
  }

  function uiNotice(message, kind = "error") {
    if (uiNoticeTimer) clearTimeout(uiNoticeTimer);
    const notice = { message: String(message || ""), kind };
    uiState.notice = notice;
    queueUiRender("notice", 0);
    uiNoticeTimer = setTimeout(() => {
      uiNoticeTimer = null;
      if (uiState.notice !== notice) return;
      uiState.notice = null;
      queueUiRender("notice-dismiss", 0);
    }, kind === "error" ? 6500 : kind === "info" ? 5000 : 3000);
  }
  function uiConfirm(title, message, confirmAction, data = {}) {
    uiState.dialog = { kind: "confirm", title, message, confirmAction, data };
    queueUiRender("confirm", 0);
  }
  function uiFocusFromEvent(event) {
    if (!(event && Object.hasOwn(event, "focus"))) return;
    if (!event.focus?.id) {
      uiState.focus = null;
      return;
    }
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
      notifySession: "desktop_notifications_session", notifyWorkspace: "desktop_notifications_workspace",
      notifyToolCall: "desktop_notifications_tool_call", inheritSystemPath: "inherit_system_path",
    };
    if (settingsMap[id]) {
      uiState.settingsDraft ||= {};
      uiState.settingsDraft[settingsMap[id]] = ["notifySession", "notifyWorkspace", "notifyToolCall", "inheritSystemPath"].includes(id) ? !!checked : text;
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
    if (failures.length) uiNotice(`Download errors:\n${failures.join("\n")}`);
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
      case "clear-database":
        uiInternalApi("/api/database/clear", { method: "POST" }).catch(error =>
          console.error("Clear Operational Data failed", error));
        break;
      case "empty-trash":
        uiInternalApi("/api/trash/empty", { method: "POST" }).catch(error =>
          console.error("Empty Trash failed", error));
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
        uiState.dialog = { kind: "root", data: {
          enabled: true, name_warning: "Workspace name is required.", path_warning: "", path_checked: false, form_warning: "",
        } };
        break;
      case "edit-root": {
        const root = one("SELECT * FROM roots WHERE id=?", Number(data.id));
        if (!root) throw new Error("Workspace not found");
        uiState.dialog = { kind: "root", data: {
          ...root, enabled: !!root.enabled,
          name_warning: workspaceNameWarning(root.name, root.id), path_warning: await rootPathWarning(root.path),
          path_checked: true, form_warning: "",
        } };
        break;
      }
      case "delete-root":
        uiConfirm("Delete Workspace", "Delete this registered Workspace? Existing files are not removed.", "delete-root", { id: data.id });
        return;
      case "delete-context":
        uiConfirm("Delete Session", "Delete this persistent MCP context? Running processes are not terminated.", "delete-context", { id: data.id });
        return;
      case "assign-session-root":
        await uiInternalApi("/api/context/select", { method: "POST", body: {
          id: Number(data.id), root_id: Math.max(0, Number(data.rootId) || 0),
        } });
        break;
      case "header-settings":
        uiState.currentSection = "settings";
        break;
      case "header-sessions":
        uiState.currentSection = "sessions";
        uiState.sessions.oauthClientId = "";
        break;
      case "header-tool-calls":
        uiState.currentSection = "logs";
        uiState.logs.context = "";
        uiState.logs.query = "";
        uiState.logs.status = ["running", "failed", "invalid"].includes(String(data.status || "")) ? String(data.status) : "";
        uiState.logs.page = 1;
        uiState.logs.openRowId = "";
        uiState.logs.selfTest = null;
        break;
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
        uiState.dialog = { kind: "command", data: {
          name: "", path: "", description: "", download_url: "", documentation_url: "", registered: false,
          name_warning: "Command name is required.", path_warning: "", path_error: false, path_checked: true,
          download_warning: "", documentation_warning: "", form_warning: "",
        } };
        break;
      case "edit-command": {
        const row = await uiCommandRow(String(data.name || ""), String(data.path || ""));
        if (!row) throw new Error("Command not found");
        const pathWarning = await commandPathWarning(row.path);
        uiState.dialog = { kind: "command", data: {
          ...row, old_name: row.name,
          name_warning: await commandNameWarning(row.name, row.name),
          path_warning: pathWarning, path_error: commandPathBlocksSave(pathWarning), path_checked: true,
          download_warning: httpUrlWarning(row.download_url, "Download URL"),
          documentation_warning: httpUrlWarning(row.documentation_url, "Documentation URL"), form_warning: "",
        } };
        break;
      }
      case "delete-command":
        uiConfirm("Delete Command", `Delete metadata for ${data.name || "this command"}?`, "delete-command", { name: data.name });
        return;
      case "download-command": {
        const row = await uiCommandRow(String(data.name || ""));
        if (!row) throw new Error("Command not found");
        if (row.present) {
          uiConfirm("Replace Command", `Replace the existing file for ${row.name}?`, "download-command", { name: row.name });
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
          uiConfirm("Replace Commands", `Download ${rows.length} commands and replace ${existing.length} existing file${existing.length === 1 ? "" : "s"}?`, "download-all-commands");
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
        uiConfirm("Revoke OAuth Client", "Revoke this client and all of its tokens?", "revoke-client", { client_id: data.id });
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
      case "clear-log-filters":
        uiState.logs.query = "";
        uiState.logs.context = "";
        uiState.logs.status = "";
        uiState.logs.page = 1;
        uiState.logs.openRowId = "";
        uiState.logs.selfTest = null;
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
      case "toggle-debug-settings":
        await uiInternalApi("/api/debug/settings", {
          method: "POST", body: { enabled: getCfg("debug_http_log", "0") !== "1" },
        });
        break;
      case "select-debug":
        uiState.debug.openRowId = uiState.debug.openRowId === String(data.id) ? "" : String(data.id);
        break;
      case "clear-debug":
        uiConfirm("Clear HTTP Debug Log", "Delete all HTTP debug log rows?", "clear-debug");
        return;
      case "clear-database":
        uiConfirm("Clear Operational Data", "Delete Tool Calls, process history, HTTP logs, published HTML and reset request metrics? Authentication, Sessions, Workspaces, settings and registered tools are preserved. Files, certificates, commands and trash on disk are not touched.", "clear-database");
        return;
      case "empty-trash":
        uiConfirm("Empty Trash", "Permanently delete all contents of .mrmcp/trash under the program folder and every configured Workspace? This cannot be undone.", "empty-trash");
        return;
      case "detect-ip":
        await uiInternalApi("/api/network/detect", { method: "POST" });
        uiState.settingsDraft = null;
        break;
      case "issue-cert": {
        const result = await uiInternalApi("/api/tls/issue", { method: "POST" });
        const certificate = result.certificate || {};
        if (!certificate.requested && certificate.reason)
          uiNotice(certificate.reason + (certificate.next_attempt_at ? `\nNext attempt: ${new Date(certificate.next_attempt_at).toLocaleString()}` : ""), "info");
        break;
      }
      case "save-settings": {
        const body = {
          external_url: String(values.externalUrl || ""),
          tls_email: String(values.tlsEmail || ""),
          public_ip_urls: String(values.publicIpUrls || "").split(/\r?\n/),
          sslip_suffix: String(values.sslipSuffix || ""),
          acme_directory_url: String(values.acmeDirectoryUrl || ""),
          desktop_notifications_session: !!values.notifySession,
          desktop_notifications_workspace: !!values.notifyWorkspace,
          desktop_notifications_tool_call: !!values.notifyToolCall,
          inherit_system_path: !!values.inheritSystemPath,
        };
        const warnings = settingsFieldWarnings(body);
        if (Object.values(warnings).some(Boolean)) {
          uiState.settingsDraft = { ...body, public_ip_urls: body.public_ip_urls.join("\n") };
          queueUiRender("settings-invalid", 0);
          return;
        }
        await uiInternalApi("/api/settings", { method: "POST", body });
        uiState.settingsDraft = null;
        uiNotice("Settings saved.", "ok");
        break;
      }
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
        case "native-drop": {
          const { added, existing } = await addDroppedRoots(event.paths);
          if (added.length) uiNotice(`${added.length === 1 ? "Workspace" : "Workspaces"} added: ${added.join(", ")}`, "ok");
          if (added.length || existing.length) {
            const affected = [...added, ...existing];
            postOsNotification(
              "workspace",
              affected.length === 1 ? "📁 Workspace" : "📁 Workspaces",
              [
                added.length && `✅ Added\n${added.map(name => `• ${name}`).join("\n")}`,
                existing.length && `ℹ️ Already Exists\n${existing.map(name => `• ${name}`).join("\n")}`,
              ].filter(Boolean).join("\n"),
            );
          }
          return;
        }
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
        case "blur": {
          const id = String(event.id || "");
          uiUpdateDraft(id, event.value, event.checked);
          if (id === "rpath" && uiState.dialog?.kind === "root") {
            uiState.dialog.data.path_warning = await rootPathWarning(event.value);
            uiState.dialog.data.path_checked = true;
          } else if (id === "cpath" && uiState.dialog?.kind === "command") {
            const warning = await commandPathWarning(event.value);
            uiState.dialog.data.path_warning = warning;
            uiState.dialog.data.path_error = commandPathBlocksSave(warning);
            uiState.dialog.data.path_checked = true;
          }
          else return;
          queueUiRender(`blur:${id}`, 0);
          return;
        }
        case "input":
        case "inputs": {
          const items = event.type === "inputs" ? (Array.isArray(event.items) ? event.items : []) : [event];
          let renderDraft = false, filterLogs = false;
          for (const item of items) {
            const id = String(item.id || "");
            uiUpdateDraft(id, item.value, item.checked);
            if (uiState.dialog?.kind === "root" && ["rname", "rpath", "renabled"].includes(id)) {
              const d = uiState.dialog.data;
              d.form_warning = "";
              if (id === "rname") d.name_warning = workspaceNameWarning(item.value, d.id);
              if (id === "rpath") { d.path_warning = ""; d.path_checked = false; }
              renderDraft = true;
            }
            if (uiState.dialog?.kind === "command" && ["cname", "cpath", "cdescription", "cdownloadUrl", "cdocumentationUrl"].includes(id)) {
              const d = uiState.dialog.data;
              d.form_warning = "";
              if (id === "cname") d.name_warning = await commandNameWarning(item.value, d.old_name);
              if (id === "cpath") {
                d.path_warning = ""; d.path_error = false; d.path_checked = !String(item.value || "").trim();
              }
              if (id === "cdownloadUrl") d.download_warning = httpUrlWarning(item.value, "Download URL");
              if (id === "cdocumentationUrl") d.documentation_warning = httpUrlWarning(item.value, "Documentation URL");
              renderDraft = true;
            }
            if (["externalUrl", "tlsEmail", "publicIpUrls", "sslipSuffix", "acmeDirectoryUrl"].includes(id)) renderDraft = true;
            if (id === "logQuery") { uiState.logs.page = 1; filterLogs = true; }
          }
          if (renderDraft) queueUiRender("input:draft", 40);
          if (filterLogs) {
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
          else if (["rpath", "cpath"].includes(id)) return;
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
            const d = uiState.dialog?.kind === "root" ? uiState.dialog.data : null;
            if (!d) return;
            d.name_warning = workspaceNameWarning(values.rname, Number(values.rid) || 0);
            d.path_warning = await rootPathWarning(values.rpath);
            d.path_checked = true;
            d.form_warning = "";
            if (d.name_warning || d.path_warning) {
              queueUiRender("submit:rootForm-invalid", 0);
              return;
            }
            try {
              await uiInternalApi("/api/roots/save", { method: "POST", body: {
                id: Number(values.rid) || null, name: values.rname, path: values.rpath, enabled: !!values.renabled,
              } });
              uiState.dialog = null;
              uiNotice(`Workspace ${String(values.rname || "").trim()} saved.`, "ok");
            } catch (error) {
              d.form_warning = String(error?.message || error);
              queueUiRender("submit:rootForm-warning", 0);
              return;
            }
          } else if (event.formId === "commandForm") {
            const d = uiState.dialog?.kind === "command" ? uiState.dialog.data : null;
            if (!d) return;
            d.name_warning = await commandNameWarning(values.cname, values.coldName);
            d.download_warning = httpUrlWarning(values.cdownloadUrl, "Download URL");
            d.documentation_warning = httpUrlWarning(values.cdocumentationUrl, "Documentation URL");
            const pathWarning = await commandPathWarning(values.cpath);
            d.path_warning = pathWarning; d.path_error = commandPathBlocksSave(pathWarning); d.path_checked = true;
            d.form_warning = "";
            if (d.name_warning || d.path_error || d.download_warning || d.documentation_warning) {
              queueUiRender("submit:commandForm-invalid", 0);
              return;
            }
            try {
              await uiInternalApi("/api/commands/save", { method: "POST", body: {
                old_name: values.coldName, name: values.cname, path: values.cpath,
                description: values.cdescription, download_url: values.cdownloadUrl,
                documentation_url: values.cdocumentationUrl,
              } });
              uiState.dialog = null;
              uiState.commands.page = 1;
              uiNotice(`Command ${String(values.cname || "").trim()} saved.`, "ok");
            } catch (error) {
              d.form_warning = String(error?.message || error);
              queueUiRender("submit:commandForm-warning", 0);
              return;
            }
          }
          queueUiRender(`submit:${event.formId}`);
          return;
        }
        case "action":
          await handleUiAction(event);
          return;
      }
    } catch (error) {
      uiNotice(String(error?.message || error));
      queueUiRender("input-error", 0);
    }
  }


  function enqueueUiInput(message) {
    uiRenderConnected = true;
    uiInputChain = uiInputChain.then(async () => {
      uiInputDepth += 1;
      uiInputRenderDelay = null;
      try { await handleUiInput(message); }
      finally {
        uiInputDepth -= 1;
        const delay = uiInputRenderDelay ?? 0;
        uiInputRenderDelay = null;
        if (uiRenderQueued) queueUiRender("input-complete", delay);
      }
    }).catch(error => {
      uiNotice(String(error?.message || error));
      queueUiRender("input-transport-error", 0);
    });
  }

  async function guiApi(req, u) {
    if (u.pathname === "/api/settings" && req.method === "POST") {
      const x = await bodyJson(req);
      const warnings = settingsFieldWarnings(x), firstWarning = Object.values(warnings).find(Boolean);
      if (firstWarning) return json({ error: firstWarning }, 400);
      if (x.external_url) {
        let external;
        try { external = new URL(String(x.external_url)); }
        catch { return json({ error: "Public base URL must be a valid HTTPS URL" }, 400); }
        if (external.protocol !== "https:" || (external.port && external.port !== "443"))
          return json({ error: "Public base URL must use HTTPS on port 443" }, 400);
      }
      for (const key of ["external_url", "tls_email", "sslip_suffix", "acme_directory_url"])
        if (x[key] != null) setCfg(key, x[key]);
      for (const key of ["desktop_notifications_session", "desktop_notifications_workspace", "desktop_notifications_tool_call"])
        if (x[key] != null) setCfg(key, x[key] ? "1" : "0");
      if (x.inherit_system_path != null) setCfg("inherit_system_path", x.inherit_system_path ? "1" : "0");
      if (Array.isArray(x.public_ip_urls)) setCfg("public_ip_urls_json", JSON.stringify(
        x.public_ip_urls.map(String).map(value => value.trim()).filter(value => /^https:\/\//i.test(value)),
      ));
      await restartMcp();
      automaticRenewal().catch(() => {});
      return json({ ok: true });
    }
    if (u.pathname === "/api/database/clear" && req.method === "POST") {
      try { return json(await clearOperationalDatabase()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
    }
    if (u.pathname === "/api/trash/empty" && req.method === "POST") {
      try { return json(await emptyManagedTrash(serverConfig())); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
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
        path = String(x.path ?? ""), rootId = Number(x.id) || 0, enabled = !!x.enabled;
      const nameWarning = workspaceNameWarning(name, rootId);
      if (nameWarning) return json({ error: nameWarning, field: "name" }, 400);
      const pathWarning = await rootPathWarning(path);
      if (pathWarning) return json({ error: pathWarning, field: "path" }, 400);
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
      if (!root) return json({ error: "Workspace not found" }, 404);
      run("UPDATE contexts SET root_id=0,updated_at=? WHERE server_id=? AND root_id=?",
        Date.now(), p.id, root.id);
      run("DELETE FROM roots WHERE id=?", root.id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/context/select" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), context = contextById(p, Number(x.id));
      if (!context) return json({ error: "Session not found" }, 404);
      return json({ ok: true, context: selectContextRoot(p, context, Number(x.root_id) || 0) });
    }
    if (u.pathname === "/api/context/delete" && req.method === "POST") {
      const x = await bodyJson(req), p = serverConfig(), context = contextById(p, Number(x.id));
      if (!context) return json({ error: "Session not found" }, 404);
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
      const nameWarning = await commandNameWarning(name, old);
      if (nameWarning) return json({ error: nameWarning, field: "name" }, 400);
      const downloadWarning = httpUrlWarning(x.download_url, "Download URL");
      if (downloadWarning) return json({ error: downloadWarning, field: "download_url" }, 400);
      const documentationWarning = httpUrlWarning(x.documentation_url, "Documentation URL");
      if (documentationWarning) return json({ error: documentationWarning, field: "documentation_url" }, 400);
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
      const q = (u.searchParams.get("q") || "").trim();
      const method = u.searchParams.get("method") || "";
      const status = u.searchParams.get("status") || "";
      const limit = Math.min(Number(u.searchParams.get("limit") || 300), 1000);
      const like = `%${q}%`;
      return json(all(`WITH enriched AS (
        SELECT d.*, COALESCE(
          CASE WHEN json_valid(d.request_body) THEN json_extract(d.request_body,'$.params.arguments.context_handle') END,
          CASE WHEN json_valid(d.response_body) THEN json_extract(d.response_body,'$.result.structuredContent.context_handle') END,
          ''
        ) context_handle
        FROM debug_logs d
      )
      SELECT d.id,d.ts,d.method,d.path,d.status,d.duration_ms,d.remote_addr,
        c.id context_id,c.oauth_client_id client_id,
        (SELECT COUNT(*) FROM debug_logs ip WHERE ip.remote_addr=d.remote_addr) remote_count,
        substr(d.request_body,1,180) request_preview,substr(d.error,1,180) error_preview
        FROM enriched d LEFT JOIN contexts c ON c.handle=d.context_handle
        WHERE (?='' OR d.method=?) AND (?='' OR CAST(d.status AS TEXT)=?)
        AND (?='' OR d.method||d.path||d.request_headers||d.request_body||d.response_headers||d.response_body||d.error||COALESCE(c.oauth_client_id,'')||COALESCE(CAST(c.id AS TEXT),'') LIKE ?)
        ORDER BY d.id DESC LIMIT ?`,
        method, method, status, status, q, like, limit));
    }
    let dm = u.pathname.match(/^\/api\/debug\/(\d+)$/);
    if (dm && req.method === "GET") return json(one(`WITH enriched AS (
      SELECT d.*, COALESCE(
        CASE WHEN json_valid(d.request_body) THEN json_extract(d.request_body,'$.params.arguments.context_handle') END,
        CASE WHEN json_valid(d.response_body) THEN json_extract(d.response_body,'$.result.structuredContent.context_handle') END,
        ''
      ) context_handle
      FROM debug_logs d WHERE d.id=?
    )
    SELECT d.*,c.id context_id,c.oauth_client_id client_id,
      (SELECT COUNT(*) FROM debug_logs ip WHERE ip.remote_addr=d.remote_addr) remote_count
      FROM enriched d LEFT JOIN contexts c ON c.handle=d.context_handle`, Number(dm[1])) || { error: "Not found" });
    if (u.pathname === "/api/debug/clear" && req.method === "POST") {
      run("DELETE FROM debug_logs");
      return json({ ok: true });
    }
    if (u.pathname === "/api/logs" && req.method === "GET") {
      const p = serverConfig();
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
          rows = all(`SELECT l.id,l.started_at,l.completed_at,l.context_id,l.tool,l.status,l.duration_ms,l.input_json
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
        rows = all(`SELECT id,started_at,completed_at,context_id,tool,status,duration_ms,input_json FROM logs
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
        const input = parseJson(row.input_json || "{}", {}), call_preview = compactToolCallPreview(p, row.tool, input);
        const transport = one("SELECT progress_requested FROM tool_call_transport WHERE log_id=?", row.id);
        const { input_json: _inputJson, ...summary } = row;
        return { ...summary, call_preview, progress_requested: !!transport?.progress_requested,
          killable: !!process || !!control?.cancel, process_id: process?.id || control?.process_id || "" };
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
    if (lm && req.method === "GET") {
      const logId = Number(lm[1]);
      const detail = one(`SELECT id,started_at,completed_at,server_id,server_name,tool,status,input_json,resolved_json,
        stdout,stderr,error,result_json,duration_ms,context_id,context_handle FROM logs WHERE id=?`, logId);
      if (!detail) return json({ error: "Not found" });
      const descriptor = one("SELECT descriptor_json FROM tool_call_descriptors WHERE log_id=?", logId);
      if (descriptor?.descriptor_json) {
        detail.tool_descriptor = parseJson(descriptor.descriptor_json, null);
        const currentDescriptor = serverTools(serverConfig(), true).find(tool => tool.name === detail.tool) || null;
        detail.tool_descriptor_current_available = !!currentDescriptor;
        detail.tool_descriptor_matches_current = !!currentDescriptor && JSON.stringify(currentDescriptor) === JSON.stringify(detail.tool_descriptor);
      }
      let process = [...processes.values()].find(record => record.log_id === logId);
      if (!process && detail.tool === "exec_attach") {
        const input = parseJson(detail.input_json || "{}", {});
        process = [...processes.values()].find(record => record.persistent &&
          record.context_handle === detail.context_handle && record.label === String(input.label || ""));
      }
      const transport = one("SELECT progress_requested FROM tool_call_transport WHERE log_id=?", logId);
      detail.progress_requested = !!transport?.progress_requested;
      if (process) detail.process = processAdminView(process);
      return json(detail);
    }
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

  // Eta renders server-side only. Tauriless serves the complete local UI through its asset protocol.
  const UI_SCRIPT_NONCE = randomToken();
  const GUI_LOGO_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(Deno.readTextFileSync(join(ASSETS_DIR, "mrmcp-logo.svg")))}`;
  const GUI_MORPHLEX_JS = Deno.readTextFileSync(join(ASSETS_DIR, "morphlex.js"))
    .replace(/\nexport \{\n  morphInner,\n  morphDocument,\n  morph\n\};[\s\S]*$/, "");
  const UI_CSP = `default-src 'self';base-uri 'none';object-src 'none';frame-ancestors 'none';form-action 'self';style-src 'unsafe-inline';script-src 'self' 'nonce-${UI_SCRIPT_NONCE}';connect-src 'self' ipc: http://ipc.localhost;img-src 'self' data:`;
  const UI_TEMPLATE = String.raw`<!doctype html><html><head><meta charset=utf-8>
<meta http-equiv="Content-Security-Policy" content="${UI_CSP}">
<meta name=viewport content="width=device-width,initial-scale=1"><link rel=icon href="${GUI_LOGO_DATA_URL}"><title>MrMCP</title><style>
:root{font:14px system-ui;color:#e8e8e8;background:#101114}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding-top:54px}header{position:fixed;inset:0 0 auto 0;z-index:1000;height:54px;display:flex;align-items:center;padding:0 18px;background:#17191e;border-bottom:1px solid #292c33}header b{font-size:18px}.brand{display:flex;align-items:center;gap:8px}.brand-mark{display:block;width:32px;height:32px;flex:0 0 32px}.status{margin-left:auto;color:#8b949e;display:flex;gap:10px;align-items:center;font-size:12px;white-space:nowrap;min-width:0}.status-group{display:inline-flex;align-items:center;gap:3px}.status-link{cursor:pointer;border-radius:4px;padding:2px 3px;margin:-2px -3px}.status-link:hover{background:#252a33;text-decoration:underline}.status-ports{color:#c5cad3}.status-sessions{color:#9ecbff}.status-total{color:#9ecbff}#app>aside{position:fixed;top:54px;bottom:0;width:170px;background:#15171b;padding:12px;border-right:1px solid #292c33;overflow:auto}#app>aside button{display:block;width:100%;text-align:left;margin:3px 0;background:transparent;border:0}#app>aside button.nav-active{background:#252a33;color:#fff;font-weight:650;border-left:3px solid #3984e8;padding-left:6px}main{margin-left:170px;padding:16px;max-width:1500px}.page{display:block}.notice-balloon{position:fixed;top:64px;right:16px;z-index:1900;max-width:min(520px,calc(100vw - 32px));padding:10px 12px;border:1px solid #7d3f47;border-radius:9px;background:#25191b;color:#ffb7bf;box-shadow:0 8px 28px #0008}.notice-balloon.info{border-color:#365a7d;background:#16202b;color:#a9d5ff}.notice-balloon.ok{border-color:#356849;background:#16241b;color:#9ce8b1}button,input,select,textarea{font:inherit;color:#eee;background:#22252b;border:1px solid #3a3e47;border-radius:6px;padding:7px 9px}button{cursor:pointer}button:hover{background:#2d3139}.danger{color:#ff8585}.primary{background:#2459a8}.debug-toggle{font-weight:750;min-width:190px}.debug-toggle.enabled{background:#173f24;border-color:#347a49;color:#9ce8b1}.debug-toggle.disabled{background:#421d21;border-color:#7d3f47;color:#ffb7bf}.debug-toggle.enabled:hover{background:#20512f}.debug-toggle.disabled:hover{background:#53262b}.small{padding:4px 8px;font-size:12px}.spinner{display:inline-block;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.card{background:#181a1f;border:1px solid #2c3037;border-radius:10px;padding:14px;margin-bottom:10px}.tls-alert{border:2px solid #b94a4a;background:#241718}.tls-good{border:2px solid #347a49}.tls-error{max-height:180px;background:#160909}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:180px}.urlrow{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #292d34}.urlrow:last-child{border-bottom:0}.urlrow code{overflow-wrap:anywhere}.label,.muted{color:#89909b}.field-warning{color:#ff8585;font-size:12px;font-weight:600}label{display:block;color:#aaa;margin:8px 0 4px}table{width:100%;border-collapse:collapse;background:#181a1f}th,td{padding:8px;border-bottom:1px solid #2b2e35;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#090a0c;padding:12px;border-radius:8px;max-height:58vh;overflow:auto}code{color:#9ecbff}.ok,.completed{color:#75d58b}.failed,.killed,.timed_out{color:#ff8585}.invalid{color:#c084fc}.pending,.running{color:#ffd166}#logStatus.completed,#logStatus option.completed{color:#75d58b}#logStatus.failed,#logStatus option.failed{color:#ff8585}#logStatus.invalid,#logStatus option.invalid{color:#c084fc}#logStatus.running,#logStatus option.running{color:#ffd166}#logStatus option{background:#22252b}.tools{columns:3;min-width:500px}.dialog-overlay{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:24px;background:#0009}.dialog-overlay dialog{position:static;margin:0;color:#eee;background:#17191e;border:1px solid #444;border-radius:10px;width:min(880px,94vw);max-height:calc(100vh - 48px);overflow:auto}textarea{width:100%;min-height:78px}h2{margin-top:0}.nowrap{white-space:nowrap}tr[data-action=select-log],tr[data-action=select-debug]{cursor:pointer}tr[data-action=select-log]:hover,tr[data-action=select-debug]:hover{background:#20242a}.detail-row td{padding:0 18px 14px 28px;background:#111318}.detail-panel{border:1px solid #343944;border-left:3px solid #3984e8;border-radius:8px;background:#0d0f12;padding:14px 16px}.detail-panel pre{margin:8px 0 0;max-height:46vh}.tool-detail-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,.75fr);gap:14px;align-items:start}.tool-detail-main{min-width:0}.tool-descriptor{min-width:0;position:sticky;top:10px;border:1px solid #343944;border-radius:8px;background:#111318;padding:12px}.tool-descriptor>.muted{margin-top:10px}.tool-descriptor p{margin:5px 0 10px;line-height:1.45}.tool-descriptor pre{margin:5px 0 10px;max-height:28vh}.descriptor-status{font-size:11px;font-weight:800;letter-spacing:.04em;padding:3px 6px;border-radius:5px}.descriptor-status.current{color:#75d58b;background:#16341f}.descriptor-status.outdated{color:#ffd166;background:#3a2f13}.http-detail-head{padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid #292d34}.http-detail-meta{display:flex;gap:7px 16px;flex-wrap:wrap;margin-top:5px;font-size:12px;color:#89909b}.http-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.http-detail-block{min-width:0;border:1px solid #292d34;border-radius:8px;background:#0a0c0f;padding:10px}.http-detail-block h4{margin:0}.http-detail-block pre{max-height:30vh}.http-detail-error{margin-top:12px;border-color:#68353a;background:#1d1012}.http-detail-raw{margin-top:12px}.http-detail-raw summary{cursor:pointer;color:#89909b}@media(max-width:1100px){.tool-detail-grid,.http-detail-grid{grid-template-columns:1fr}.tool-descriptor{position:static}}.terminal-detail{margin-top:12px;border:1px solid #343944;border-radius:8px;background:#080a0d;overflow:hidden}.terminal-title{padding:9px 11px;background:#11151a;border-bottom:1px solid #292d34}.terminal-command{padding:10px 12px;border-bottom:1px solid #20242b;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.terminal-command .prompt{color:#75d58b;margin-right:8px}.tool-command-preview{margin-top:3px;max-width:440px;color:#c5cad3;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.terminal-cwd{padding:7px 12px;color:#89909b;border-bottom:1px solid #20242b}.terminal-stream-label{padding:7px 12px 0;color:#89909b;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.terminal-detail pre{margin:5px 10px 10px;max-height:30vh;border-radius:6px}.json-detail{margin-top:12px}.json-detail+.json-detail{padding-top:12px;border-top:1px solid #292d34}.idcell{font-variant-numeric:tabular-nums;white-space:nowrap}.menu-icon{display:inline-block;width:22px;text-align:center}.context-id{overflow-wrap:anywhere}.log-pagination{margin:8px 0 10px}.pagination{display:flex;gap:3px;align-items:center}.page-button{min-width:34px;height:34px;padding:4px 8px;border-color:#30343d;background:#1b1e24}.page-button.active{background:#3984e8;border-color:#3984e8;color:white}.page-button:disabled{opacity:.35;cursor:default}.page-ellipsis{min-width:26px;text-align:center;color:#89909b}.dashboard-call-card{padding:0;overflow:hidden}.dashboard-call-table{margin:0;background:transparent}.dashboard-call-table th,.dashboard-call-table td{padding:7px 9px}.dashboard-call-summary{max-width:720px;overflow-wrap:anywhere}.dashboard-call-recent{animation:dashboardCallFade var(--dashboard-call-ttl,3s) linear forwards}@keyframes dashboardCallFade{from{opacity:1}to{opacity:.18}}.progress-requested{color:#8fd3ff;white-space:nowrap}.dashboard-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(420px,1.25fr);gap:14px}.context-dates{min-width:240px}.context-dates>div{margin-bottom:4px}.oauth-table{table-layout:fixed}.oauth-table th:nth-child(1){width:30%}.oauth-table th:nth-child(2){width:26%}.oauth-table th:nth-child(3){width:30%}.oauth-table th:nth-child(4){width:130px}.oauth-client,.oauth-meta{line-height:1.45}.oauth-client-id{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:2px 0 5px}.oauth-client-id code{font-size:12px}.oauth-meta{font-size:12px}.oauth-meta>div{margin-top:3px}.oauth-count{font-size:13px;margin-bottom:3px}.oauth-tokens{display:grid;grid-template-columns:1fr 1fr;gap:8px}.oauth-token{min-width:0;padding-right:8px;border-right:1px solid #2b2e35}.oauth-token:last-child{padding-right:0;border-right:0}.oauth-actions{width:130px}.oauth-actions button{display:block;width:100%;white-space:nowrap;margin-bottom:5px}.oauth-actions button:last-child{margin-bottom:0}.commands-table .command-description{width:30%;max-width:360px;overflow-wrap:anywhere}.command-action-cell{width:104px}.command-actions{display:flex;flex-direction:column;gap:5px}.command-actions button{width:100%;white-space:nowrap}.roots-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:14px;align-items:start}.root-card h3,.default-root-card h3{margin:0 0 4px}.root-card-header{display:flex;gap:12px;align-items:flex-start}.root-session-list{display:flex;flex-direction:column;gap:6px;min-height:48px;margin-top:10px;padding:8px;border:1px dashed #3a3e47;border-radius:8px}.session-chip{display:block;padding:7px 9px;border:1px solid #343944;border-radius:7px;background:#202329;cursor:grab}.session-chip-main{display:flex;gap:8px;align-items:center}.session-chip .grow{min-width:0;overflow-wrap:anywhere}.session-chip-meta{display:flex;gap:5px 16px;align-items:center;flex-wrap:wrap;margin-top:6px;padding-left:30px;font-size:12px;line-height:1.35}.session-chip-meta>span{white-space:nowrap}.session-chip:active{cursor:grabbing}.root-drop-empty{padding:6px 2px;color:#89909b}.root-disabled .root-session-list{opacity:.65}.default-root-card{position:sticky;top:70px}@media(max-width:1000px){.roots-layout{grid-template-columns:1fr}.default-root-card{position:static}}@media(max-width:900px){.dashboard-grid{grid-template-columns:1fr}}@media(max-width:800px){#app>aside{width:130px}main{margin-left:130px}.urlrow{grid-template-columns:1fr}.tools{columns:1;min-width:0}}
</style></head><body>
<div id=app data-section=dashboard><header><div class=brand><img class=brand-mark src="${GUI_LOGO_DATA_URL}" alt=""><b>MrMCP <span class=muted>v${VERSION}</span></b></div><div class=status><span class=pending>starting…</span></div></header><main style="margin-left:0"><div class=card>Starting the local MrMCP UI…</div></main></div>
<script type=module nonce="${UI_SCRIPT_NONCE}">__MRMCP_BROWSER_JS__</script></body></html>`;

  function browserAppSource() {/*
import { morphInner } from "/assets/morphlex.js";
const app = document.getElementById("app");
const internals = window.__TAURI_INTERNALS__;
const invoke = (command, payload = {}) => internals.invoke(command, payload);
const UI_INPUT_EVENT = "tauriless://webview-message", UI_RENDER_EVENT = "mrmcp://ui-render";
const currentWindowLabel = internals.metadata.currentWindow.label;
let scrollTimer = null, inputTimer = null, sequence = 0, lastSentSequence = 0;
const pendingInputs = new Map();
function focusState(element = document.activeElement) {
  if (!element?.id) return null;
  return {
    id: element.id,
    start: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
    end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
  };
}
function sendRaw(event) {
  const envelope = { sequence: ++sequence, event: {
    ...event,
    focus: event.focus === undefined ? focusState() : event.focus,
    viewport: { section: app.dataset.section || "dashboard", x: scrollX, y: scrollY },
  } };
  lastSentSequence = envelope.sequence;
  return invoke("plugin:event|emit", { event: UI_INPUT_EVENT, payload: envelope })
    .catch(error => console.error("MrMCP input delivery failed", error));
}
async function flushInputs() {
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
  if (!pendingInputs.size) return;
  const items = [...pendingInputs.values()];
  pendingInputs.clear();
  await sendRaw({ type: "inputs", items });
}
async function send(event) {
  if (event.type !== "inputs") await flushInputs();
  return await sendRaw(event);
}
function queueInput(element) {
  pendingInputs.set(element.id, { id: element.id, value: element.value, checked: !!element.checked });
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(() => { inputTimer = null; void flushInputs(); }, 60);
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
async function listen(event, handler, target = { kind: "Any" }) {
  const handlerId = internals.transformCallback(handler);
  return await invoke("plugin:event|listen", { event, target, handler: handlerId });
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
document.addEventListener("dragstart", event => {
  const session = event.target?.closest?.("[data-session-drag]");
  if (!session || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(session.dataset.sessionId || ""));
});
document.addEventListener("dragover", event => {
  const target = event.target?.closest?.("[data-root-drop]");
  if (!target) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
});
document.addEventListener("drop", event => {
  const target = event.target?.closest?.("[data-root-drop]");
  if (!target || !event.dataTransfer) return;
  event.preventDefault();
  const id = Number(event.dataTransfer.getData("text/plain")) || 0;
  if (!id) return;
  send({ type: "action", action: "assign-session-root", dataset: {
    id: String(id), rootId: String(Number(target.dataset.rootDrop) || 0),
  }, values: {} });
});
document.addEventListener("change", event => {
  const element = event.target;
  if (!element.id && !element.dataset.action) return;
  if (["rpath", "cpath"].includes(element.id)) return;
  send({ type: "change", id: element.id || "", value: element.value, checked: !!element.checked, dataset: { ...element.dataset } });
});
document.addEventListener("focusout", event => {
  const element = event.target;
  if (!["rpath", "cpath"].includes(element?.id)) return;
  send({ type: "blur", id: element.id, value: element.value, checked: !!element.checked, focus: focusState(event.relatedTarget) });
});
document.addEventListener("input", event => {
  const element = event.target;
  if (!element.id) return;
  queueInput(element);
});
document.addEventListener("focusin", event => {
  if (event.target?.id) send({ type: "focus", focus: focusState(event.target) });
});
document.addEventListener("submit", event => {
  event.preventDefault();
  send({ type: "submit", formId: event.target.id || "", values: collectValues(event.target) });
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && app.querySelector("[data-managed-dialog][open]")) {
    event.preventDefault();
    send({ type: "action", action: "close-dialog", dataset: {}, values: {} });
    return;
  }
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
listen("tauri://close-requested", () => {
  void invoke("plugin:window|hide", { label: currentWindowLabel })
    .catch(error => console.error("MrMCP window hide failed", error));
}, { kind: "Window", label: currentWindowLabel }).then(() => listen(UI_RENDER_EVENT, event => {
  try { applyRender(event.payload); }
  catch (error) { console.error("MrMCP render failed", error); }
})).then(() => send({ type: "bootstrap" })).catch(error => {
  console.error("MrMCP UI bootstrap failed", error);
});
*/}

  const BROWSER_JS = browserAppSource.toString().match(/\/\*([\s\S]*)\*\//)[1]
    .replace('import { morphInner } from "/assets/morphlex.js";\n', "");
  const GUI_BROWSER_JS = `${GUI_MORPHLEX_JS}\n${BROWSER_JS}`;
  const PAGE_TEMPLATE = UI_TEMPLATE;
  function ui() { return eta.renderString(PAGE_TEMPLATE, {}).replace("__MRMCP_BROWSER_JS__", GUI_BROWSER_JS); }
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
    gui: IS_BACKEND_WORKER ? "index.html" : null,
    gui_html: IS_BACKEND_WORKER ? ui() : undefined,
    ports: { http: mcpHttpPort, https: mcpHttpsPort },
    fallbacks: listenerFallbacks(),
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const control of activeCallControls.values()) try { await control.cancel?.("SIGTERM", "server"); } catch {}
    activeCallControls.clear();
    if (renewalTimer) clearInterval(renewalTimer);
    if (processCleanupTimer) clearInterval(processCleanupTimer);
    if (downloadCleanupTimer) clearInterval(downloadCleanupTimer);
    if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
    if (uiNoticeTimer) clearTimeout(uiNoticeTimer);
    if (headerActivityTimer) clearTimeout(headerActivityTimer);
    if (dashboardToolCallTimer) clearTimeout(dashboardToolCallTimer);
    for (const key of [...jsKernels.keys()]) destroyJsKernel(key, "server shutdown");
    await Promise.allSettled(
      [...processes.values()]
        .filter(rec => ["starting", "running"].includes(rec.status))
        .map(rec => terminateProcess(rec, "SIGTERM", "server")),
    );
    await Promise.race([
      Promise.allSettled([...processes.values()].map(rec => rec.done).filter(Boolean)),
      sleep(3000),
    ]);
    await Promise.allSettled([mcpHttpServer?.shutdown(), mcpHttpsServer?.shutdown()]);
    await cleanupAllDownloadTokens();
    db.close();
  };
  if (IS_BACKEND_WORKER) {
    self.onmessage = event => {
      if (event.data?.type === "ui-input") {
        enqueueUiInput(event.data.payload);
        return;
      }
      if (event.data?.type !== "shutdown") return;
      (async () => {
        try { await shutdown(); self.postMessage({ type: "stopped" }); }
        catch (error) { self.postMessage({ type: "stopped", error: String(error?.stack || error) }); }
        finally { self.close(); }
      })();
    };
    self.postMessage(readyPayload);
  } else {
    console.log(`MRMCP_READY ${JSON.stringify(readyPayload)}`);
    try { Deno.addSignalListener("SIGINT", shutdown); } catch {}
    if (Deno.build.os !== "windows") try { Deno.addSignalListener("SIGTERM", shutdown); } catch {}
  }
}

async function spawnBackendWorker() {
  const worker = new Worker(SELF.href, { type: "module", name: "mrmcp-backend" });
  let resolveReady, rejectReady;
  const earlyMessages = [];
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const onMessage = event => {
    if (event.data?.type === "ready" && event.data.gui) resolveReady(event.data);
    else earlyMessages.push(event.data);
  };
  const onError = event => rejectReady(event.error || new Error(event.message || "MrMCP backend Worker failed"));
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  try {
    const payload = await waitFor(ready, 60_000, null);
    if (!payload) throw new Error("MrMCP backend Worker startup timed out");
    return { worker, payload, earlyMessages };
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
  }
}
async function stopBackendWorker(worker) {
  if (!worker) return;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const onMessage = event => { if (event.data?.type === "stopped") resolveStopped(event.data); };
  worker.addEventListener("message", onMessage);
  try {
    worker.postMessage({ type: "shutdown" });
    await waitFor(stopped, 5000, null);
  } finally {
    worker.removeEventListener("message", onMessage);
    worker.terminate();
  }
}
async function desktop() {
  const { worker: backendWorker, payload, earlyMessages } = await spawnBackendWorker();
  const tauriless = new Tauriless(), pending = new Map();
  const nativeIcon = () => {
    const ico = Deno.readFileSync(join(ASSETS_DIR, "mrmcp.ico"));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength), count = view.getUint16(4, true);
    let entry = null;
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 16, width = ico[p] || 256, height = ico[p + 1] || 256;
      if (width === 32 && height === 32) {
        entry = { size: view.getUint32(p + 8, true), offset: view.getUint32(p + 12, true) };
        break;
      }
    }
    if (!entry) throw new Error("MrMCP ICO has no 32x32 frame");
    const png = ico.subarray(entry.offset, entry.offset + entry.size);
    const be32 = p => ((png[p] * 0x1000000) + (png[p + 1] << 16) + (png[p + 2] << 8) + png[p + 3]) >>> 0;
    if (png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) throw new Error("MrMCP 32x32 ICO frame is not PNG");
    const idat = [];
    let width = 0, height = 0;
    for (let p = 8; p + 12 <= png.length;) {
      const length = be32(p), type = String.fromCharCode(...png.subarray(p + 4, p + 8)), data = png.subarray(p + 8, p + 8 + length);
      if (type === "IHDR") {
        width = be32(p + 8); height = be32(p + 12);
        if (png[p + 16] !== 8 || png[p + 17] !== 6 || png[p + 20] !== 0) throw new Error("Unsupported MrMCP icon PNG format");
      } else if (type === "IDAT") idat.push(data);
      if (type === "IEND") break;
      p += length + 12;
    }
    const compressed = new Uint8Array(idat.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of idat) { compressed.set(chunk, offset); offset += chunk.length; }
    const raw = inflateSync(compressed), stride = width * 4, rgba = new Uint8Array(width * height * 4);
    const paeth = (a, b, c) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0, src = 0; y < height; y++) {
      const filter = raw[src++], row = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? rgba[row + x - 4] : 0, b = y ? rgba[row - stride + x] : 0,
          c = y && x >= 4 ? rgba[row - stride + x - 4] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b :
          filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : NaN;
        if (!Number.isFinite(predictor)) throw new Error(`Unsupported MrMCP icon PNG filter ${filter}`);
        rgba[row + x] = (raw[src++] + predictor) & 255;
      }
    }
    return { rgba: Array.from(rgba), width, height };
  };
  let nextId = 1, drainTimer = null, closed = false, webviewMessagesReady = false, notificationsReady = false, resolveClosed, resolveWebviewReady;
  const workerMessageQueue = [], notificationQueue = [];
  const channel = () => `__CHANNEL__:${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const windowClosed = new Promise(resolve => { resolveClosed = resolve; });
  const webviewReady = new Promise(resolve => { resolveWebviewReady = resolve; });
  const request = (cmd, requestPayload = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { cmd, resolve, reject });
    try { tauriless.send({ id, cmd, payload: requestPayload }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  const emitToWebview = (event, eventPayload) => request("plugin:event|emit_to", {
    target: { kind: "WebviewWindow", label: "main" }, event, payload: eventPayload,
  });
  const showWindow = async () => {
    await request("plugin:window|unminimize", { label: "main" });
    await request("plugin:window|show", { label: "main" });
    await request("plugin:window|set_focus", { label: "main" });
  };
  const hideWindow = () => request("plugin:window|hide", { label: "main" });
  const toggleWindow = async () => {
    if (await request("plugin:window|is_minimized", { label: "main" })) return showWindow();
    return await request("plugin:window|is_visible", { label: "main" }) ? hideWindow() : showWindow();
  };
  const notify = message => request("plugin:notification|notify", { options: {
    title: String(message.title || "Notification").slice(0, 160), body: String(message.body || "").slice(0, 500),
  } });
  const handleWorkerMessage = data => {
    if (data?.type === "ui-render") {
      void emitToWebview(UI_RENDER_EVENT, data.payload).catch(error => console.error("MrMCP render delivery failed", error));
    } else if (data?.type === "os-notification") {
      if (!notificationsReady) notificationQueue.push(data);
      else void notify(data).catch(error => console.error("MrMCP notification failed", error));
    }
  };
  const queueOrHandleWorkerMessage = data => {
    if (data?.type === "ui-render" && !webviewMessagesReady) workerMessageQueue.push(data);
    else handleWorkerMessage(data);
  };
  const onWorkerMessage = event => queueOrHandleWorkerMessage(event.data);
  backendWorker.addEventListener("message", onWorkerMessage);
  for (const data of earlyMessages) queueOrHandleWorkerMessage(data);
  const drain = () => {
    for (const message of tauriless.drain().messages) {
      if (message.kind === "result") {
        const callback = pending.get(message.id);
        if (!callback) continue;
        pending.delete(message.id);
        message.ok ? callback.resolve(message.value)
          : callback.reject(new Error(`${callback.cmd}: ${JSON.stringify(message.error)}`));
      } else if (message.kind === "asset-request") {
        const pathname = new URL(message.url).pathname;
        void request("tauriless:asset-response", pathname === "/" || pathname === "/index.html" ? {
          requestId: message.requestId, content: payload.gui_html, mime: "text/html; charset=utf-8",
        } : {
          requestId: message.requestId, status: 404, content: `Asset not found: ${pathname}`, mime: "text/plain; charset=utf-8",
        }).catch(error => console.error("MrMCP asset response failed", error));
      } else if (message.kind === "event" && message.window === "main") {
        if (message.event === "tauri://close-requested") void hideWindow().catch(console.error);
        else if (message.event === "tauri://destroyed") resolveClosed();
        else if (message.event === UI_INPUT_EVENT) {
          if (message.payload?.event?.type === "bootstrap") resolveWebviewReady(true);
          backendWorker.postMessage({ type: "ui-input", payload: message.payload });
        }
        else if (message.event === "tauri://drag-drop") backendWorker.postMessage({
          type: "ui-input", payload: { event: { type: "native-drop", paths: message.payload?.paths || [] } },
        });
      } else if (message.kind === "channel") {
        let event = message.message;
        if (typeof event === "string") try { event = JSON.parse(event); } catch {}
        if (event === "tray-quit" || event?.id === "tray-quit" || event?.payload?.id === "tray-quit") resolveClosed();
        else if (event?.type === "Click" && event.button === "Left" && event.buttonState === "Up")
          void toggleWindow().catch(console.error);
      }
    }
  };
  try {
    drainTimer = setInterval(() => {
      if (closed) return;
      try { drain(); }
      catch (error) {
        closed = true;
        for (const callback of pending.values()) callback.reject(error);
        pending.clear();
        resolveClosed();
      }
    }, 16);
    if (Deno.build.os === "windows") await request("tauriless:set-app-user-model-id", {
      appId: Deno.execPath(), name: "MrMCP",
    });
    for (const event of [
      "tauri://resize", "tauri://move", "tauri://focus", "tauri://blur",
      "tauri://scale-change", "tauri://theme-changed", "tauri://window-created", "tauri://webview-created",
      "tauri://drag-enter", "tauri://drag-over", "tauri://drag-leave", "tauri://suspended", "tauri://resumed",
      "deep-link://new-url", "log://log", "store://change",
    ]) await request("tauriless:unsubscribe", { event });
    await request("plugin:webview|create_webview_window", { options: {
      label: "main", title: `MrMCP ${VERSION}`, url: payload.gui,
      width: 1180, height: 760, center: true, visible: false, dragDropEnabled: true,
    } });
    await request("plugin:window|set_size", { label: "main", value: { Logical: { width: 1180, height: 760 } } });
    await request("plugin:window|center", { label: "main" });
    await request("plugin:window|set_icon", { label: "main", value: nativeIcon() });
    if (!await waitFor(webviewReady, 10_000, null)) throw new Error("Tauriless WebView input bootstrap timed out");
    webviewMessagesReady = true;
    for (const message of workerMessageQueue.splice(0)) handleWorkerMessage(message);
    notificationsReady = true;
    for (const message of notificationQueue.splice(0))
      void notify(message).catch(error => console.error("MrMCP notification failed", error));
    const menuChannel = channel();
    const [menuRid] = await request("plugin:menu|new", {
      kind: "Menu", options: { id: "mrmcp-tray-menu", items: [
        { id: "tray-quit", text: "Quit", enabled: true, handler: menuChannel },
      ] }, handler: menuChannel,
    });
    await request("plugin:tray|new", { options: {
      id: "mrmcp-tray", menu: [menuRid, "Menu"], icon: nativeIcon(),
      tooltip: `MrMCP ${VERSION}`, showMenuOnLeftClick: false,
    }, handler: channel() });
    await showWindow();
    await windowClosed;
  } finally {
    backendWorker.removeEventListener("message", onWorkerMessage);
    closed = true;
    if (drainTimer) clearInterval(drainTimer);
    for (const callback of pending.values()) callback.reject(new Error("Tauriless closing"));
    pending.clear();
    try { tauriless.close(); } finally { await stopBackendWorker(backendWorker); }
  }
}

if (IS_BACKEND_WORKER || (import.meta.main && Deno.args.includes("--backend"))) await backend();
else if (import.meta.main) { await desktop(); Deno.exit(0); }
