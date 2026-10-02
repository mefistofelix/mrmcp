/*
MrMCP 0.10.154 — Exclude cross-target and unused-version LanceDB binaries.
Runtime data: .mrmcp beside source/portable executables; macOS .app data lives under ~/Library/Application Support/MrMCP/.
Run desktop GUI: deno run -A --unstable-ffi mrmcp.js
Run headless backend: deno run -A mrmcp.js --backend
Add Workspace and exit: deno run -A mrmcp.js --add-workspace <name> <path>
GUI library: Tauriless, imported directly from npm by Deno.
*/

import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import chardet from "npm:chardet@2.1.1";
import iconv from "npm:iconv-lite@0.7.0";
import * as auto from "npm:@mefistofelix/auto.js";
import * as cdp from "npm:@mefistofelix/cdp.js";
// Pin the parser through a JSON import: newer releases reference unpublished
// optional packages. JSON keeps native code lazy, including in the desktop isolate.
import lucernaParserPackage from "npm:@kreuzberg/tree-sitter-language-pack@1.6.2/package.json" with { type: "json" };
// Intel macOS uses this companion through the parser loader's native-path
// option. Both package loaders remain unmodified; native code stays lazy.
import lucernaMacPackage from "npm:@kreuzberg/tree-sitter-language-pack-darwin-x64@1.10.9/package.json" with { type: "json" };
const loadAutoVips = async () => auto.vips;
import { inflateRawSync, inflateSync, gunzipSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { userInfo } from "node:os";
import { Eta } from "jsr:@bgub/eta@4.6.0";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.1.2";
import { contentType as mediaContentType } from "jsr:@std/media-types@1.1.0";

const SELF = new URL(import.meta.url);
const IS_BACKEND_WORKER = globalThis.name === "mrmcp-backend";
const GUI_RUNTIME = IS_BACKEND_WORKER;
const MODULE_DIR = dirname(fileURLToPath(SELF));
const ASSETS_DIR = join(MODULE_DIR, "assets");
const STANDALONE_DIR = Deno.build.standalone ? dirname(Deno.execPath()) : "";
const MACOS_APP_BUNDLE = Deno.build.standalone && Deno.build.os === "darwin" &&
  basename(dirname(STANDALONE_DIR)) === "Contents" && extname(dirname(dirname(STANDALONE_DIR))).toLowerCase() === ".app";
const macosAppDataDir = () => {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is required to run the macOS app bundle");
  return join(home, "Library", "Application Support", "MrMCP");
};
const APP_DIR = MACOS_APP_BUNDLE ? macosAppDataDir() : Deno.build.standalone ? STANDALONE_DIR : MODULE_DIR;
const DATA_DIR = join(APP_DIR, ".mrmcp"), DATABASE_PATH = join(DATA_DIR, "mrmcp.sqlite");
const configuredWorkspacePath = value => resolve(APP_DIR, String(value || "."));
const nativeHomeDir = () => {
  const home = String(userInfo().homedir || "").trim();
  if (!home) throw new Error("Unable to resolve the current user's home directory from the operating system.");
  return resolve(home);
};
async function desktopDirectory() {
  const home = nativeHomeDir();
  if (Deno.build.os === "linux") {
    try {
      const text = await Deno.readTextFile(join(home, ".config", "user-dirs.dirs"));
      const match = text.match(/^\s*XDG_DESKTOP_DIR\s*=\s*"([^"]*)"/m);
      if (match) {
        const value = match[1].replaceAll("${HOME}", home).replaceAll("$HOME", home);
        if (value) return resolve(value);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw new Error("Unable to resolve Desktop directory.");
    }
  }
  return join(home, "Desktop");
}
const validWorkspaceName = name => {
  const value = String(name || "").trim();
  return value.length >= 1 && value.length <= 128 && !/[\/\\\x00-\x1f\x7f]/.test(value);
};
async function workspacePathWarning(value) {
  const raw = String(value ?? "");
  if (!raw.trim()) return "Path is required.";
  try {
    const stat = await Deno.stat(configuredWorkspacePath(raw));
    return stat.isDirectory ? "" : "Path does not point to a directory.";
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "Directory does not exist." : `Path is not accessible: ${String(error?.message || error)}`;
  }
}
const COMMANDS_TEMPLATE_PATH = join(MODULE_DIR, "commands.yaml");
const COMMANDS_PATH = join(APP_DIR, "commands.yaml");
const GUIDED_PROMPTS_TEMPLATE_PATH = join(MODULE_DIR, "guided_prompts.yaml");
const GUIDED_PROMPTS_PATH = join(APP_DIR, "guided_prompts.yaml");
const PROXIES_TEMPLATE_PATH = join(MODULE_DIR, "proxies.yaml"), PROXIES_PATH = join(APP_DIR, "proxies.yaml");
const SEARCH_TEMPLATE_PATH = join(MODULE_DIR, "search.yaml"), SEARCH_PATH = join(APP_DIR, "search.yaml");
const DEV_PREF_FILENAME = "DEV_PREF.md";
const DEV_PREF_SOURCE_PATH = join(Deno.build.standalone ? STANDALONE_DIR : MODULE_DIR, DEV_PREF_FILENAME);
const PORT_FALLBACK_STEP = 50;
const UI_INPUT_EVENT = "tauriless://webview-message", UI_RENDER_EVENT = "mrmcp://ui-render";
const BASE_TOOLS = ["proxy_get",
  "init_chat_session", "chat_set_goal", "chat_goal_debug", "list_workspaces", "open_workspace", "workspace_dev_preferences_write",
  "fs_glob", "fs_grep", "fs_read", "fs_navigate", "fs_stat", "source_code_search", "document_grep",
  "fs_write", "fs_edit", "fs_text_convert_encoding_eol", "fs_mkdir", "fs_copy", "fs_move", "fs_trash", "fs_untrash",
  "desktop_auto", "publish", "cdp_call", "cdp_subs", "cdp_poll", "memory_find", "memory_set", "telegram_req", "discover_commands", "tools_schema", "tools_log", "exec", "exec_start", "exec_attach", "exec_write", "exec_kill", "exec_list", "exec_status",
  "js", "js_add_node_module_dir", "js_reset",
];
const READ_TOOLS = new Set([
  "list_workspaces", "fs_glob", "fs_grep", "fs_read", "fs_navigate", "fs_stat", "source_code_search", "document_grep",
  "discover_commands", "tools_schema", "tools_log", "exec_attach", "exec_list", "exec_status",
]);
const MCP_MODERN_PROTOCOL = "2026-07-28";
const MCP_PROTOCOLS = [MCP_MODERN_PROTOCOL];
const MCP_DEFAULT_PROTOCOL = MCP_MODERN_PROTOCOL;
const VERSION = "0.10.154";
const DB_SCHEMA_VERSION = 5;
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ACTIVE_MS = 10 * 60 * 1000, ACTIVE_TOOL_CALL_TTL_MS = 5000;
const CHAT_SESSION_INPUT_DESCRIPTION = "Required opaque capability returned by init_chat_session. Pass the exact value unchanged; never invent, modify, shorten, derive or substitute it.";
const CHAT_SESSION_OUTPUT_DESCRIPTION = "Opaque capability identifying a persistent Session. Pass this exact value unchanged as chat_session on every subsequent tool call.";
const CHAT_SESSION_RULE = "Requires the exact chat_session returned by init_chat_session.";
const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";
const PUBLISH_UI_URI = "ui://mrmcp/publish-v3.html";
const enc = new TextEncoder(), dec = new TextDecoder();
const TOOL_RESULT_CONTENT = Symbol("tool-result-content");

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
const freshUiResourceUri = base => `${base}?instance=${randomToken(12)}`;
const matchesUiResourceUri = (uri, base) => uri === base || uri.startsWith(`${base}?instance=`);
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
// Defaults stay below common client/gateway retry boundaries, but callers may opt into longer waits.
// Prefer exec_start for long or non-idempotent work because some clients/proxies may replay long requests.
const MCP_FOREGROUND_EXEC_DEFAULT_TIMEOUT_MS = 45_000, MCP_ATTACH_DEFAULT_TIMEOUT_MS = 45_000;
const MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS = 3_600_000, PROCESS_OPERATION_GRACE_MS = 5 * 60 * 1000;
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

function databaseSchemaIssue(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) return null;
  const schemaTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
  let storedVersion = NaN;
  if (schemaTable) {
    try { storedVersion = Number(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()?.version); }
    catch { /* An invalid schema_meta shape is also incompatible. */ }
  }
  return storedVersion === DB_SCHEMA_VERSION ? null : {
    found: Number.isFinite(storedVersion) ? String(storedVersion) : "unversioned",
    expected: DB_SCHEMA_VERSION,
  };
}
function inspectStartupDatabase() {
  try { Deno.lstatSync(DATABASE_PATH); }
  catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
  const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try { return databaseSchemaIssue(db); } finally { db.close(); }
}
async function recoveryBackupPath() {
  const date = new Date(), pad = value => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const prefix = `${DATA_DIR}.backup-${stamp}`;
  for (let suffix = 0;; suffix++) {
    const path = suffix ? `${prefix}-${suffix + 1}` : prefix;
    try { await Deno.lstat(path); }
    catch (error) { if (error instanceof Deno.errors.NotFound) return path; throw error; }
  }
}
async function archiveIncompatibleData(backupPath) {
  const source = resolve(DATA_DIR), destination = resolve(backupPath), parent = resolve(APP_DIR);
  if (dirname(source) !== parent || basename(source) !== ".mrmcp" || dirname(destination) !== parent ||
      !basename(destination).startsWith(".mrmcp.backup-") || source === destination)
    throw new Error("Invalid data recovery paths");
  try { await Deno.lstat(destination); throw new Error("The backup destination already exists. Choose Start Fresh again to use a new backup name."); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  await Deno.rename(source, destination);
  return destination;
}
async function confirmStartupRecovery(issue) {
  const state = { ...issue, data: DATA_DIR, backup: await recoveryBackupPath(), busy: false, failed: false, error: "" };
  if (!GUI_RUNTIME) {
    const message = `Database schema version mismatch (found ${issue.found}, expected ${issue.expected}).\nData directory: ${DATA_DIR}\nBackup directory: ${state.backup}`;
    if (!Deno.stdin.isTerminal()) throw new Error(`${message}\nStart MrMCP in desktop mode to confirm archiving the old data and starting fresh.`);
    if (!confirm(`${message}\nRename the entire data directory and start with new settings and data?`)) return null;
    const backup = await archiveIncompatibleData(state.backup);
    console.log(`Previous data preserved in ${backup}`);
    return { backup };
  }
  const renderer = new Eta({ tags: ["<?", "?>"], autoEscape: true });
  const template = `<div id="app"><main><div class=brand>MrMCP</div><h1>Start With New Data?</h1>
<p>This database uses schema <b><?= it.found ?></b>; this version requires <b><?= it.expected ?></b>.</p>
<p>Start Fresh renames the entire current data folder to the backup below, then starts MrMCP with new settings, credentials and history.</p>
<label>Current Data Directory</label><code><?= it.data ?></code><label>Backup Directory</label><code><?= it.backup ?></code>
<? if(it.error){ ?><p class=error role=alert><?= it.error ?></p><? } ?>
<? if(it.busy){ ?><p role=status>Preserving old data and starting MrMCP…</p><? } ?>
<div class=actions><button data-action=startup-cancel<?= it.busy?' disabled':'' ?>>Quit</button>
<? if(!it.failed){ ?><button class=primary data-action=startup-reset<?= it.busy?' disabled':'' ?>>Start Fresh</button><? } ?></div></main></div>`;
  const render = () => renderer.renderString(template, state);
  const morphlex = await Deno.readTextFile(join(ASSETS_DIR, "morphlex.js"));
  const script = `${morphlex}\nconst app=document.getElementById("app"),internals=window.__TAURI_INTERNALS__;
const invoke=(command,payload={})=>internals.invoke(command,payload);
const listen=(event,handler,target={kind:"Any"})=>invoke("plugin:event|listen",{event,target,handler:internals.transformCallback(handler)});
const send=event=>invoke("plugin:event|emit",{event:${JSON.stringify(UI_INPUT_EVENT)},payload:{event}});
void listen("tauri://close-requested",()=>{},{kind:"Window",label:"main"}).catch(console.error);
document.addEventListener("click",event=>{const button=event.target.closest("[data-action]");if(button&&!button.disabled)void send({type:"action",action:button.dataset.action}).catch(console.error);});
Promise.all([listen(${JSON.stringify(UI_RENDER_EVENT)},event=>morphInner(app,event.payload.html,{preserveChanges:true})),listen("mrmcp://startup-ready",()=>location.replace(location.pathname+"?ready="+Date.now()))]).then(()=>send({type:"bootstrap"})).catch(console.error);`;
  const nonce = randomToken();
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';base-uri 'none';style-src 'unsafe-inline';script-src 'nonce-${nonce}';connect-src 'self' ipc: http://ipc.localhost">
<title>MrMCP · Data Recovery</title><style>:root{font:15px system-ui;color:#e8e8e8;background:#101114}*{box-sizing:border-box}body{margin:0}main{max-width:780px;margin:9vh auto;padding:28px;background:#191c22;border:1px solid #343a44;border-radius:12px}.brand{font-weight:700;color:#9ecbff}h1{font-size:26px}p{line-height:1.55}label{display:block;font-weight:600;margin:18px 0 8px}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#111419;padding:12px;border-radius:6px}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:26px}button{font:inherit;color:#eee;background:#262b34;border:1px solid #465062;border-radius:6px;padding:9px 18px;cursor:pointer}button:disabled{opacity:.55;cursor:default}.primary{background:#2459a8}.error{color:#ffb7bf}@media(max-width:820px){main{margin:24px 16px}}</style></head><body>${render()}<script type=module nonce="${nonce}">${script}</script></body></html>`;
  let revision = 0, resolveDecision, visible = false;
  const decision = new Promise(resolve => { resolveDecision = resolve; });
  const update = () => {
    if (visible) self.postMessage({ type: "ui-render", payload: { revision: ++revision, html: render(), section: "startup" } });
  };
  const failed = error => {
    state.busy = false; state.failed = true;
    state.error = `The old data is preserved in ${state.backup}. Startup failed: ${String(error?.message || error)}. Quit and restart MrMCP to try again.`;
    update();
  };
  self.onmessage = event => {
    if (event.data?.type === "shutdown") { self.postMessage({ type: "stopped" }); self.close(); return; }
    if (event.data?.type === "ui-visibility") { visible = !!event.data.visible; if (visible) update(); return; }
    const input = event.data?.type === "ui-input" ? event.data.payload?.event : null;
    if (input?.type === "bootstrap") { update(); return; }
    if (input?.type !== "action" || state.busy) return;
    if (input.action === "startup-cancel") { state.busy = true; self.postMessage({ type: "startup-cancelled" }); resolveDecision(null); return; }
    if (input.action !== "startup-reset" || state.failed) return;
    state.busy = true; state.error = ""; update();
    (async () => {
      try { const backup = await archiveIncompatibleData(state.backup); resolveDecision({ backup, failed }); }
      catch (error) {
        state.busy = false; state.error = String(error?.message || error);
        try { state.backup = await recoveryBackupPath(); } catch {}
        update();
      }
    })();
  };
  self.postMessage({ type: "ready", gui: "index.html", gui_html: html, startup_recovery: true });
  return await decision;
}
async function runBackend(options = {}) {
  const issue = inspectStartupDatabase();
  const recovery = issue ? await confirmStartupRecovery(issue) : undefined;
  if (recovery === null) return;
  try { await backend(options); }
  catch (error) { if (recovery?.failed) recovery.failed(error); else throw error; }
}

// Backend lifecycle, persistence and network services.
async function backend({ addWorkspace = null } = {}) {
  if (Deno.build.standalone && !addWorkspace) {
    await Deno.mkdir(APP_DIR, { recursive: true });
    for (const [target, template] of [[COMMANDS_PATH, COMMANDS_TEMPLATE_PATH], [GUIDED_PROMPTS_PATH, GUIDED_PROMPTS_TEMPLATE_PATH], [SEARCH_PATH, SEARCH_TEMPLATE_PATH], [PROXIES_PATH, PROXIES_TEMPLATE_PATH]]) {
      try { await Deno.lstat(target); }
      catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        const source = await Deno.readTextFile(template);
        try { await Deno.writeTextFile(target, source, { createNew: true }); }
        catch (writeError) { if (!(writeError instanceof Deno.errors.AlreadyExists)) throw writeError; }
      }
    }
  }
  const DATA = DATA_DIR;
  const TRASH_ROOT = join(DATA, "trash");
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
  const PUBLISH_DIR = join(DATA, "publish");
  const CDP_DIR = join(DATA, "cdp");
  Deno.mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(DB_PATH), schemaIssue = databaseSchemaIssue(db);
  if (schemaIssue) {
    db.close();
    throw new Error(`Database schema version mismatch (found ${schemaIssue.found}, expected ${schemaIssue.expected}). Restart MrMCP to confirm archiving the old data directory and starting fresh.`);
  }
  if (!addWorkspace) {
    Deno.mkdirSync(BIN_DIR, { recursive: true });
    await Deno.remove(TEMP_DIR, { recursive: true }).catch(error => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    Deno.mkdirSync(TEMP_DIR, { recursive: true });
    Deno.mkdirSync(PUBLISH_DIR, { recursive: true });
    Deno.mkdirSync(CDP_DIR, { recursive: true });
  }
  let uiRevision = 0, uiRenderConnected = false, uiRenderVisible = false, uiRenderVisibilityEpoch = 0;
  const deliverUiRender = payload => {
    if (IS_BACKEND_WORKER) self.postMessage({ type: "ui-render", payload });
  };
  const UI_SECTIONS = new Set(["dashboard", "sessions", "processes", "logs", "browser", "automation", "published", "trash", "memory", "roots", "commands", "prompts", "prompt_help", "debug", "oauth", "telegram", "settings", "help"]);
  const uiState = {
    currentSection: "dashboard",
    scrollBySection: { dashboard: [0, 0] },
    scrollTarget: "",
    focus: null,
    dialog: null,
    notice: null,
    settingsDraft: null,
    settingsTab: "network",
    telegramDraft: null,
    commands: { page: 1, query: "", pageSize: 5, filter: "" },
    prompts: { page: 1, query: "", pageSize: 5 },
    sessions: { oauthClientId: "" },
    logs: { page: 1, toolQuery: "", query: "", context: "", status: "", pageSize: 25, openRowId: "", selfTest: null },
    published: { page: 1, context: "", size: "" },
    memory: { page: 1, query: "", scope: "", context: "", workspace: "", from: "", to: "" },
    browser: { browser: "", target: "", context: "", active: "" },
    automation: { context: "", page: 1 },
    debug: { query: "", method: "", status: "", openRowId: "" },
  };
  let uiRenderTimer = null, uiLogFilterTimer = null, uiNoticeTimer = null, cdpUiTimer = null, uiRenderRunning = false, uiRenderQueued = false;
  let uiRenderGeneration = 0, uiRenderReason = "change";
  let uiInputRunning = false, uiInputDepth = 0, uiInputRenderDelay = null;
  const uiInputQueue = [];
  const normalizedUiScopes = scopes => [...new Set((Array.isArray(scopes) ? scopes : [scopes])
    .map(String).map(value => value.trim()).filter(Boolean))];
  function uiScopesAffectCurrent(scopes) {
    const values = new Set(normalizedUiScopes(scopes));
    return values.has("all") || values.has("state") || values.has("view") ||
      values.has(uiState.currentSection) || (uiState.currentSection === "telegram" && values.has("settings")) ||
      (uiState.currentSection === "dashboard" && values.has("endpoints"));
  }
  function emitUiChange(scopes = ["state"], reason = "change") {
    if (GUI_RUNTIME && uiScopesAffectCurrent(scopes)) queueUiRender(reason);
  }
  function queueCdpUiRender() {
    if (!GUI_RUNTIME || uiState.currentSection !== "browser" || cdpUiTimer) return;
    cdpUiTimer = setTimeout(() => {
      cdpUiTimer = null;
      emitUiChange(["browser"], "cdp-traffic");
    }, 180);
  }
  function setUiRenderVisible(visible) {
    const next = !!visible;
    if (uiRenderVisible === next) {
      if (next && uiRenderQueued) queueUiRender("visibility-sync", 0);
      return;
    }
    uiRenderVisible = next;
    uiRenderVisibilityEpoch += 1;
    uiRenderQueued = true;
    if (!next) {
      if (uiRenderTimer) clearTimeout(uiRenderTimer);
      uiRenderTimer = null;
      return;
    }
    queueUiRender("visibility-sync", 0);
  }
  function queueUiRender(reason = "change", delay = 18) {
    if (!GUI_RUNTIME) return;
    uiRenderQueued = true;
    uiRenderGeneration += 1;
    uiRenderReason = reason;
    if (uiInputDepth) {
      const value = Math.max(0, Number(delay) || 0);
      uiInputRenderDelay = uiInputRenderDelay == null ? value : Math.min(uiInputRenderDelay, value);
      return;
    }
    if (!uiRenderConnected || !uiRenderVisible || uiRenderRunning || uiRenderTimer) return;
    uiRenderTimer = setTimeout(() => {
      uiRenderTimer = null;
      drainUiRenderQueue(reason).catch(error => {
        console.error("MrMCP UI render failed", error);
        uiRenderRunning = false;
        if (!uiRenderVisible) {
          uiRenderQueued = true;
          return;
        }
        uiRenderQueued = false;
        const message = htmlEscape(String(error?.stack || error));
        deliverUiRender({
          revision: ++uiRevision,
          html: `<div id="app" data-section="${htmlEscape(uiState.currentSection)}"><header><div class=brand><img class=brand-mark src="${GUI_LOGO_DATA_URL}" alt=""><b>MrMCP <span class=muted>v${VERSION}</span></b></div></header><main style="margin-left:0"><div class="card tls-alert"><h2>UI Render Failed</h2><pre>${message}</pre></div></main></div>`,
          section: uiState.currentSection,
          scroll: [0, 0], focus: null,
          reason: "render-error", at: Date.now(),
        });
      });
    }, Math.max(0, Number(delay) || 0));
  }
  async function drainUiRenderQueue(reason = "change") {
    if (uiRenderRunning || !uiRenderConnected || !uiRenderVisible) return;
    uiRenderRunning = true;
    try {
      while (uiRenderQueued && uiRenderVisible) {
        uiRenderQueued = false;
        await Promise.resolve();
        if (!uiRenderVisible) {
          uiRenderQueued = true;
          break;
        }
        const generation = uiRenderGeneration, visibilityEpoch = uiRenderVisibilityEpoch, scrollTarget = uiState.scrollTarget;
        let html;
        try { html = await renderUiDocument(generation); }
        catch (error) {
          if (error === UI_RENDER_STALE || generation !== uiRenderGeneration) { uiRenderQueued = true; continue; }
          throw error;
        }
        if (!uiRenderVisible || visibilityEpoch !== uiRenderVisibilityEpoch || generation !== uiRenderGeneration) {
          uiRenderQueued = true;
          if (uiRenderVisible) continue;
          break;
        }
        deliverUiRender({
          revision: ++uiRevision,
          html,
          section: uiState.currentSection,
          scroll: uiState.scrollBySection[uiState.currentSection] || [0, 0],
          scroll_target: scrollTarget,
          focus: uiState.focus,
          reason: uiRenderReason,
          at: Date.now(),
        });
        if (scrollTarget && uiState.scrollTarget === scrollTarget) uiState.scrollTarget = "";
        if (uiRenderQueued && uiRenderVisible) await sleep(0);
      }
    } finally {
      uiRenderRunning = false;
      if (uiRenderQueued && uiRenderVisible) queueUiRender("coalesced", 0);
    }
  }
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA temp_store=MEMORY;
    CREATE TABLE IF NOT EXISTS schema_meta(
      id INTEGER PRIMARY KEY CHECK(id=1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_meta(id,version) VALUES(1,${DB_SCHEMA_VERSION});
    CREATE TABLE IF NOT EXISTS proxy_stats(
      proxy_id TEXT PRIMARY KEY, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, last_selected_at INTEGER NOT NULL DEFAULT 0,
      last_reported_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS proxy_stats_last_selected ON proxy_stats(last_selected_at);
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
      mcp_request_json TEXT NOT NULL DEFAULT '',
      mcp_response_json TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      context_id INTEGER NOT NULL DEFAULT 0,
      context_handle TEXT NOT NULL DEFAULT '',
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      progress_requested INTEGER NOT NULL DEFAULT 0,
      payload_mode TEXT NOT NULL DEFAULT 'payload' CHECK(payload_mode IN ('payload','metadata'))
    );
    CREATE INDEX IF NOT EXISTS logs_time ON logs(started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_server ON logs(server_name,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_tool ON logs(tool,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_context ON logs(context_handle,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_context_cursor ON logs(context_handle,id DESC);
    CREATE INDEX IF NOT EXISTS logs_context_id ON logs(context_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS tool_descriptors(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descriptor_json TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS tool_call_descriptors(
      log_id INTEGER PRIMARY KEY,
      descriptor_id INTEGER NOT NULL,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE,
      FOREIGN KEY(descriptor_id) REFERENCES tool_descriptors(id) ON DELETE CASCADE
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
    CREATE TABLE IF NOT EXISTS debug_log_workspaces(
      debug_log_id INTEGER PRIMARY KEY,
      context_id INTEGER NOT NULL DEFAULT 0,
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(debug_log_id) REFERENCES debug_logs(id) ON DELETE CASCADE
    );
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
      chatgpt_chat_id TEXT NOT NULL DEFAULT '',
      goal_text TEXT NOT NULL DEFAULT '',
      goal_timeout_seconds INTEGER NOT NULL DEFAULT 300,
      goal_revision INTEGER NOT NULL DEFAULT 0,
      goal_updated_at INTEGER NOT NULL DEFAULT 0,
      goal_activity_at INTEGER NOT NULL DEFAULT 0,
      goal_status TEXT NOT NULL DEFAULT 'disabled',
      goal_next_check_at INTEGER NOT NULL DEFAULT 0,
      goal_last_sent_at INTEGER NOT NULL DEFAULT 0,
      goal_error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS contexts_server ON contexts(server_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS contexts_active ON contexts(last_active_at DESC);
    CREATE INDEX IF NOT EXISTS contexts_root ON contexts(server_id,root_id);
    CREATE INDEX IF NOT EXISTS contexts_goals ON contexts(goal_next_check_at) WHERE goal_text<>'';
    CREATE INDEX IF NOT EXISTS contexts_chat_id ON contexts(chatgpt_chat_id) WHERE chatgpt_chat_id<>'';
    CREATE UNIQUE INDEX IF NOT EXISTS contexts_chat_goal ON contexts(chatgpt_chat_id) WHERE chatgpt_chat_id<>'' AND goal_text<>'';
    CREATE TABLE IF NOT EXISTS process_runs(
      id TEXT PRIMARY KEY,
      log_id INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS cdp_browsers(
      browser TEXT PRIMARY KEY,
      port INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cdp_targets(
      browser TEXT NOT NULL,
      target TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(browser,target),
      FOREIGN KEY(browser) REFERENCES cdp_browsers(browser) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cdp_targets_id ON cdp_targets(browser,target_id);
    CREATE TABLE IF NOT EXISTS memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK(scope IN ('session','workspace')),
      owner_id INTEGER NOT NULL,
      owner_name TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      is_json INTEGER NOT NULL DEFAULT 1,
      ttl_seconds INTEGER NOT NULL DEFAULT 0,
      set_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope,owner_id,key)
    );
    CREATE INDEX IF NOT EXISTS memories_owner_time ON memories(scope,owner_id,set_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS memories_owner_cursor ON memories(scope,owner_id,id DESC);
    CREATE INDEX IF NOT EXISTS memories_expiry ON memories(expires_at) WHERE expires_at>0;
    CREATE TRIGGER IF NOT EXISTS memories_context_delete AFTER DELETE ON contexts BEGIN
      DELETE FROM memories WHERE scope='session' AND owner_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memories_root_delete AFTER DELETE ON roots BEGIN
      DELETE FROM memories WHERE scope='workspace' AND owner_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memories_root_rename AFTER UPDATE OF name ON roots BEGIN
      UPDATE memories SET owner_name=NEW.name WHERE scope='workspace' AND owner_id=NEW.id;
    END;
    CREATE TABLE IF NOT EXISTS published(
      id TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL,
      content_key TEXT NOT NULL DEFAULT '',
      context_handle TEXT NOT NULL DEFAULT '',
      context_id INTEGER NOT NULL DEFAULT 0,
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      source_filename TEXT NOT NULL DEFAULT '',
      published_name TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      presentation TEXT NOT NULL DEFAULT 'auto',
      height INTEGER NOT NULL DEFAULT 600,
      created_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_request_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(server_id) REFERENCES server_config(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS published_time ON published(created_at DESC);
    CREATE INDEX IF NOT EXISTS published_context ON published(context_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS published_uses(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      published_id TEXT NOT NULL,
      context_handle TEXT NOT NULL DEFAULT '',
      context_id INTEGER NOT NULL DEFAULT 0,
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      source_filename TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      presentation TEXT NOT NULL DEFAULT 'auto',
      height INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER NOT NULL,
      FOREIGN KEY(published_id) REFERENCES published(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS published_uses_publication ON published_uses(published_id,published_at DESC);
    CREATE INDEX IF NOT EXISTS published_uses_context ON published_uses(context_id,published_at DESC);
    CREATE TABLE IF NOT EXISTS trash_transactions(
      trash_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trash_transactions_time ON trash_transactions(created_at DESC);
    CREATE TABLE IF NOT EXISTS trash_items(
      trash_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      original_path TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('file','directory','symlink','other')),
      size_bytes INTEGER NOT NULL DEFAULT -1,
      PRIMARY KEY(trash_id,payload),
      FOREIGN KEY(trash_id) REFERENCES trash_transactions(trash_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS metrics(
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  const statementCache = new Map(), STATEMENT_CACHE_LIMIT = 256;
  const statement = sql => {
    const key = String(sql);
    let prepared = statementCache.get(key);
    if (prepared) {
      statementCache.delete(key);
      statementCache.set(key, prepared);
      return prepared;
    }
    prepared = db.prepare(key);
    statementCache.set(key, prepared);
    if (statementCache.size > STATEMENT_CACHE_LIMIT) statementCache.delete(statementCache.keys().next().value);
    return prepared;
  };
  const one = (sql, ...args) => statement(sql).get(...args);
  const all = (sql, ...args) => statement(sql).all(...args);
  const serverToolCache = new Map();
  const descriptorJsonCache = new WeakMap();
  let serverConfigCache = null;
  const changed = ({ ui = [], serverTools = false } = {}, reason = "database") => {
    if (serverTools) serverToolCache.clear();
    if (ui.length) emitUiChange(ui, reason);
  };
  const sessionToolCountProjection = serverId => new Map(
    all("SELECT context_id,COUNT(*) n FROM logs WHERE server_id=? AND context_id>0 GROUP BY context_id", Number(serverId || 0))
      .map(row => [Number(row.context_id), Number(row.n || 0)]),
  );
  const toolCallAggregates = p => {
    const row = one("SELECT COUNT(*) total, SUM(status='failed') errors, SUM(status='invalid') invalid FROM logs WHERE server_id=?", p.id) || {};
    return { total: Number(row.total || 0), errors: Number(row.errors || 0), invalid: Number(row.invalid || 0) };
  };
  const run = (sql, ...args) => statement(sql).run(...args);
  const configCache = new Map(all("SELECT key,value FROM config").map(row => [String(row.key), String(row.value)]));
  const getCfg = (key, fallback) => configCache.has(String(key)) ? configCache.get(String(key)) : fallback;
  const desktopNotificationEnabled = type => getCfg(`desktop_notifications_${type}`, getCfg("desktop_notifications", type === "tool_call" ? "0" : "1")) === "1";
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
  const TOOL_PREVIEW_HIDDEN_ARGS = new Set(["chat_session"]);
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
    let spec = args && typeof args === "object" ? args : {}, execPrefix = "";
    if (!["exec", "exec_start"].includes(tool)) {
      const execId = Number(spec.exec_id || 0), handle = String(spec.chat_session || "");
      execPrefix = execId ? `#${execId} ` : "";
      const live = execId ? [...processes.values()].find(record =>
        record.persistent && record.log_id === execId && (!handle || record.context_handle === handle)) : null;
      const command = live?.command_json ? parseJson(live.command_json, {}) : {};
      if (command?.program) spec = command.shell
        ? { shell_command: String(command.args?.at?.(-1) || command.args?.[command.args.length - 1] || "") }
        : { program: command.catalog_name || command.program, args: Array.isArray(command.args) ? command.args : [] };
    }
    if (typeof spec.shell_command === "string" && spec.shell_command) return capToolPreview(execPrefix + compactShellCommand(spec.shell_command));
    if (typeof spec.program !== "string" || !spec.program) return execPrefix.trim();
    const argv = Array.isArray(spec.args) ? spec.args : [], shown = argv.slice(0, TOOL_PREVIEW_ARG_LIMIT).map(compactExecArg);
    const omitted = Math.max(0, argv.length - shown.length), suffix = omitted ? ` … +${omitted} args` : "";
    return capToolPreview(execPrefix + [compactProgramName(spec.program), ...shown].filter(Boolean).join(" "), suffix);
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
  const compactToolCallSummary = (p, tool, args = {}) => {
    const preview = compactToolCallPreview(p, tool, args);
    return `${tool}${preview ? ` · ${preview}` : ""}`;
  };
  const sessionToolStats = (p, contextId) => {
    const row = one("SELECT COUNT(*) tool_calls, MAX(started_at) last_call_at FROM logs WHERE server_id=? AND context_id=?", p.id, contextId) || {};
    return { tool_calls: Number(row.tool_calls || 0), last_call_at: Number(row.last_call_at || 0) };
  };
  const sessionNotificationLabel = (p, context, toolCalls = null, now = Date.now(), workspaceName = "") => {
    const count = toolCalls == null ? sessionToolStats(p, context.id).tool_calls : Number(toolCalls || 0);
    const workspace = workspaceName || (Number(context.root_id || 0)
      ? one("SELECT name FROM roots WHERE server_id=? AND id=?", p.id, Number(context.root_id))?.name
      : "No Workspace") || "No Workspace";
    return `💬 Session #${context.id}\n• 📁 ${workspace}\n• 🕒 ${notificationAge(context.created_at, now)}\n• 🛠️ ${count} Tool Call${count === 1 ? "" : "s"}`;
  };
  const compactNotificationError = value => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  };
  const toolCallNotificationBody = (p, tool, args, contextHandle = "", root = null, error = "", progressRequested = false, contextRecord = null, toolCalls = null) => {
    const context = contextRecord || contextByHandle(p, contextHandle);
    const session = context ? sessionNotificationLabel(p, context, toolCalls, Date.now(), root?.name || "") : "";
    return [
      `🔧 ${compactToolCallSummary(p, tool, args)}`,
      session,
      progressRequested && "• 📡 Progress requested",
      error && `• ⚠️ ${compactNotificationError(error)}`,
    ].filter(Boolean).join("\n");
  };
  const setCfg = (key, value) => {
    const text = String(value);
    const result = run(
      "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key, text,
    );
    configCache.set(String(key), text);
    changed({ ui: ["dashboard", "settings", "commands", "debug", "tls", "endpoints"] }, "config");
    return result;
  };
  if (addWorkspace) {
    const name = String(addWorkspace.name || "").trim(), path = String(addWorkspace.path || "");
    if (!validWorkspaceName(name)) throw new Error("Workspace name must be 1-128 characters and cannot contain slashes or control characters.");
    const pathWarning = await workspacePathWarning(path);
    if (pathWarning) throw new Error(pathWarning);
    if (one("SELECT 1 FROM roots WHERE name=?", name)) throw new Error("Workspace name already exists.");
    if (!one("SELECT 1 FROM server_config WHERE id=1"))
      db.prepare("INSERT INTO server_config(id,name,oauth,created_at) VALUES(1,?,?,?)").run("MrMCP", 1, Date.now());
    db.prepare("INSERT INTO roots(server_id,name,path,enabled,created_at) VALUES(1,?,?,1,?)").run(name, path, Date.now());
    db.close();
    console.log(`Workspace added: ${name} -> ${path}`);
    return;
  }
  const toolCallLogViewSql = `CREATE TEMP VIEW logs AS
    SELECT id,started_at,completed_at,server_id,server_name,tool,status,mcp_request_json,mcp_response_json,error,
      duration_ms,context_id,context_handle,root_id,root_name,root_path,progress_requested,payload_mode,'disk' storage
    FROM main.logs
    UNION ALL
    SELECT id,started_at,completed_at,server_id,server_name,tool,status,mcp_request_json,mcp_response_json,error,
      duration_ms,context_id,context_handle,root_id,root_name,root_path,progress_requested,payload_mode,'memory' storage
    FROM logs_memory;`;
  db.exec(`
    CREATE TEMP TABLE logs_memory(
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      server_id INTEGER,
      server_name TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      mcp_request_json TEXT NOT NULL DEFAULT '',
      mcp_response_json TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      context_id INTEGER NOT NULL DEFAULT 0,
      context_handle TEXT NOT NULL DEFAULT '',
      root_id INTEGER NOT NULL DEFAULT 0,
      root_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      progress_requested INTEGER NOT NULL DEFAULT 0,
      payload_mode TEXT NOT NULL DEFAULT 'payload' CHECK(payload_mode IN ('payload','metadata'))
    );
    CREATE INDEX logs_memory_time ON logs_memory(started_at DESC);
    CREATE INDEX logs_memory_server ON logs_memory(server_name,started_at DESC);
    CREATE INDEX logs_memory_tool ON logs_memory(tool,started_at DESC);
    CREATE INDEX logs_memory_context ON logs_memory(context_handle,started_at DESC);
    CREATE INDEX logs_memory_context_cursor ON logs_memory(context_handle,id DESC);
    CREATE INDEX logs_memory_context_id ON logs_memory(context_id,started_at DESC);
    CREATE TEMP TABLE tool_call_descriptors_memory(
      log_id INTEGER PRIMARY KEY,
      descriptor_json TEXT NOT NULL
    );
    ${toolCallLogViewSql}
    CREATE TEMP VIEW tool_call_descriptor_records AS
      SELECT calls.log_id,descriptors.descriptor_json,'disk' storage
      FROM main.tool_call_descriptors calls JOIN main.tool_descriptors descriptors ON descriptors.id=calls.descriptor_id
      UNION ALL
      SELECT log_id,descriptor_json,'memory' storage FROM tool_call_descriptors_memory;
  `);
  let fts = true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS main.logs_fts USING fts5(
      server, tool, request, response, error,
      content='', contentless_delete=1, tokenize='unicode61'
    )`);
    db.exec(`CREATE VIRTUAL TABLE temp.logs_fts_memory USING fts5(
      server, tool, request, response, error,
      content='', contentless_delete=1, tokenize='unicode61'
    )`);
  } catch { fts = false; }
  run("INSERT OR IGNORE INTO metrics(name,value) VALUES('requests',0)");
  let requestMetricValue = Number(one("SELECT value FROM metrics WHERE name='requests'")?.value || 0);
  let pendingRequestMetric = 0, requestMetricTimer = null;
  function flushRequestMetric() {
    if (requestMetricTimer) clearTimeout(requestMetricTimer);
    requestMetricTimer = null;
    const delta = pendingRequestMetric;
    pendingRequestMetric = 0;
    if (!delta) return;
    statement("UPDATE metrics SET value=value+? WHERE name='requests'").run(delta);
    emitUiChange(["dashboard"], "request-metric");
  }
  function incrementRequestMetric() {
    requestMetricValue++;
    pendingRequestMetric++;
    if (!requestMetricTimer) requestMetricTimer = setTimeout(flushRequestMetric, 1000);
  }
  function resetRequestMetric() {
    if (requestMetricTimer) clearTimeout(requestMetricTimer);
    requestMetricTimer = null;
    requestMetricValue = 0;
    pendingRequestMetric = 0;
  }
  const startupTime = Date.now();
  run("UPDATE main.process_runs SET status='orphaned',completed_at=? WHERE status IN ('starting','running')", startupTime);
  run(`UPDATE main.logs SET status='orphaned',completed_at=?
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
    ["inherit_system_path", "1"], ["git_preserve_line_endings", "1"], ["exec_environment", ""],
    ["text_encoding_detection", "sample"],
    ["tool_call_storage", "disk"], ["tool_call_payload_mode", "payload"],
    ["chat_goals_enabled", "1"], ["chat_goal_timeout_minutes", "5"], ["chat_goal_headless", "0"], ["chat_goal_windows_hide", "auto"], ["chat_goal_disable_images", "0"],
    ["chat_goal_stop_before_send", "0"],
    ["chat_goal_match_on_startup", "0"],
    ["chat_goal_login_verified_at", "0"],
    ["tool_call_retention_hours", "0"], ["tool_call_memory_retention_minutes", "60"],
    ["command_discovery_enabled", "1"], ["telegram_bot_token", ""],
  ]) if (!configCache.has(k)) setCfg(k, v);
  setCfg("tls_cert_path", CERT_PATH);
  setCfg("tls_key_path", KEY_PATH);
  setCfg("tls_staging", "0");
  setCfg("tls_auto_renew", "1");
  setCfg("tls_mode", "letsencrypt");
  if (!one("SELECT 1 FROM server_config")) run(
    `INSERT INTO server_config(id,name,oauth,created_at) VALUES(1,?,?,?)`,
    "MrMCP", 1, Date.now(),
  );
  const processes = new Map(), processOperations = new Map(), jsKernels = new Map(), activeCallControls = new Map(),
    cdpBrowsers = new Map(), cdpBrowserOptions = new Map(), cdpTargetOptions = new Map(), cdpTargetReservations = new Map(), cdpConnectPromises = new Map(), cdpSubscriptions = new Map(), cdpBrowserSequences = new Map(),
    oauthConsents = new Map(), rateBuckets = new Map();

  const CDP_PORT_MIN = 43000, CDP_PORT_MAX = 49999;
  const CDP_RING_MAX_MESSAGES = 10000, CDP_RING_MAX_BYTES = 32 * 1024 * 1024;
  const CDP_CALL_DOCS = "https://chromedevtools.github.io/devtools-protocol/";
  const CDP_BROWSER_INPUT = {
    anyOf: [
      { type: "string", minLength: 1, maxLength: 64 },
      { type: "object", additionalProperties: false, properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Required persistent logical browser label. The string form is shorthand for this name." },
        headless: { type: "boolean", description: "Launch without a visible browser window. Defaults false for a new name; applies only to local launches." },
        windowsHide: { type: "boolean", description: "Hide the spawned process console/window where supported by the OS (Node windowsHide). Defaults to the effective headless value; an explicit value overrides it. Applies only to local launches." },
        images: { type: "boolean", description: "Load page images. Defaults true; false disables image loading through cdp.js launch settings. Applies only to local launches and does not disable screenshots." },
        executable_path: { type: "string", maxLength: 4096, description: "Chromium executable path for local launches. Relative paths resolve against the application directory. Empty resets automatic discovery, including MRMCP_CDP_BROWSER." },
        user_data_dir: { type: "string", maxLength: 4096, description: "Local browser profile directory. Relative paths resolve against the application directory. Empty resets .mrmcp/cdp/<name>." },
        args: { type: "array", maxItems: 100, items: { type: "string", maxLength: 8192 }, description: "Additional verbatim argv for local launches. Matching switches override built-in launch defaults. Headless, user-data-dir and remote-debugging switches are managed separately and cannot be supplied here. Empty clears extra arguments." },
        websocket_url: { type: "string", maxLength: 8192, description: "Direct browser-level ws:// or wss:// CDP endpoint. Connects without local executable discovery, profile creation or browser launch; cannot be combined with local launch options in the same object. Empty switches back to managed local mode." },
        http_url: { type: "string", maxLength: 8192, description: "HTTP(S) debugging base URL or exact /json/version URL. Discovers the browser WebSocket without launching Chrome. Empty returns to managed local mode." },
        port: { anyOf: [{ type: "integer", minimum: 1, maximum: 65535 }, { type: "null" }], description: "Connect to an existing debugging port, without launching Chrome. Uses host or 127.0.0.1. null returns to managed local mode." },
        host: { type: "string", minLength: 1, maxLength: 253, description: "Hostname or IPv4/IPv6 address for port attachment; defaults 127.0.0.1. Requires an effective port." },
        request_timeout_ms: { type: "integer", minimum: 100, maximum: 86400000, description: "Timeout for individual CDP commands, including page setup. Defaults 30000; raise it for long Runtime.evaluate promises or XPath retries. A timeout does not cancel browser execution." },
        connect_timeout_ms: { type: "integer", minimum: 100, maximum: 60000, description: "Timeout for each discovery, WebSocket handshake and connection setup phase; also bounds local launch readiness. Defaults 15000." },
      }, required: ["name"] },
    ],
    description: "Browser name string, or advanced object with required name. Explicit options update that name's configuration in memory only; omitted options retain it, and subsequent string calls reuse it until server restart. Reapply advanced options after restart. Conflicting options for a connected/connecting browser fail rather than restarting it. Launch options apply only when a local browser must be started.",
  };
  const CDP_TARGET_INPUT = {
    anyOf: [
      { type: "string", minLength: 1, maxLength: 128 },
      { type: "object", additionalProperties: false, properties: {
        name: { type: "string", minLength: 1, maxLength: 128, description: "Required persistent logical page label." },
        create_params: { type: "object", additionalProperties: true, description: "Native Target.createTarget params merged over url=about:blank and background=true, e.g. url, newWindow, width, height, browserContextId or hidden. Used only when this logical page must be created; passed unchanged to Chrome. forTab=true is unsupported because logical targets route to pages." },
        initialize: { type: "boolean", description: "Defaults true. false skips all optional page setup below; the debugger pause is always released." },
        runtime: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["bootstrap"] }], description: "Defaults bootstrap: Runtime.enable during setup then Runtime.disable. true keeps Runtime reporting enabled; false sends neither. Does not disable JavaScript execution." },
        page: { type: "boolean", description: "Send Page.enable during setup; defaults true." },
        network: { type: "boolean", description: "Send Network.enable during setup; defaults true. false disables automatic network reporting, not network access." },
        service_worker: { type: "boolean", description: "Send ServiceWorker.enable during setup; defaults true." },
        focus_emulation: { type: "boolean", description: "Enable focus emulation during setup; defaults true." },
        binding: { type: "boolean", description: "Install the _send_to_cdp Runtime binding during setup; defaults true, independent of Runtime reporting." },
        background_service: { type: "boolean", description: "Clear, observe and record pushMessaging BackgroundService events during setup; defaults true." },
      }, required: ["name"] },
    ],
    description: "Optional logical page name or advanced object with required name. Required by _.click/_.find; omit for browser-level calls. Options are remembered per browser/name only during this server run and reapplied on reconnect/recreation. Omitted options retain their values. Changing options for a live or opening page fails; close it first or choose a new name. Creation parameters do not navigate an existing page.",
  };
  const cdpBrowserName = value => {
    const browser = String(value ?? "").trim();
    if (!browser || browser.length > 64 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(browser) || /[. ]$/.test(browser) || browser === "." || browser === "..")
      throw new Error("browser must be a safe 1-64 character directory label");
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(browser)) throw new Error("browser uses a reserved filesystem name");
    return browser;
  };
  const cdpTargetName = value => {
    const target = String(value ?? "").trim();
    if (!target || target.length > 128 || /[\x00-\x1f\x7f]/.test(target)) throw new Error("target must be a non-empty 1-128 character label without control characters");
    return target;
  };
  const cdpPathKey = value => Deno.build.os === "windows" ? resolve(value).toLowerCase() : resolve(value);
  const cdpLaunchSwitch = value => String(value).match(Deno.build.os === "windows" ? /^(?:--?|\/)([^=]+)(?:=|$)/ : /^--?([^=]+)(?:=|$)/)?.[1].toLowerCase() || "";
  const cdpBrowserLabel = value => String(value && typeof value === "object" ? value.name ?? "" : value ?? "").trim();
  const cdpConnectionMode = options => options?.websocket_url ? "websocket" : options?.http_url ? "http" : options?.port ? "port" : "local";
  function cdpEndpoint(value, protocols, field) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${field} must be an absolute ${protocols.join(" or ")} URL`); }
    if (!protocols.includes(url.protocol) || !url.hostname || url.hash || url.username || url.password)
      throw new Error(`${field} must be a ${protocols.join(" or ")} URL without credentials or a fragment`);
    return url;
  }
  function cdpDiscoveryUrl(options) {
    const url = options.http_url ? new URL(options.http_url) : new URL(`http://${options.host}:${options.port}`);
    if (!/\/json\/version\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/, "") + "/json/version";
    return url.href;
  }
  function cdpBrowserSpec(value) {
    const error = inputSchemaError(CDP_BROWSER_INPUT.anyOf[typeof value === "string" ? 0 : 1], value, "browser");
    if (error) throw new Error(error);
    const browser = cdpBrowserName(cdpBrowserLabel(value)), options = typeof value === "string" ? {} : { ...value };
    delete options.name;
    const endpoints = ["websocket_url", "http_url", "port"];
    if (endpoints.filter(key => Object.hasOwn(options, key)).length > 1)
      throw new Error("Specify only one browser endpoint: websocket_url, http_url or port");
    if (options.websocket_url) options.websocket_url = cdpEndpoint(options.websocket_url, ["ws:", "wss:"], "browser.websocket_url").href;
    if (options.http_url) options.http_url = cdpEndpoint(options.http_url, ["http:", "https:"], "browser.http_url").href;
    if (Object.hasOwn(options, "host")) {
      const host = options.host;
      if (/[\s/@?#\\]/.test(host)) throw new Error("browser.host must be a hostname or IP address without a scheme, path or port");
      const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      if (host.includes(":") && isIP(bare) !== 6) throw new Error("browser.host must not include a scheme or port");
      const authority = isIP(bare) === 6 ? `[${bare}]` : bare;
      let url;
      try { url = new URL(`http://${authority}`); } catch { throw new Error("browser.host must be a hostname or IP address without a port"); }
      if (url.port || !url.hostname) throw new Error("browser.host must not include a port");
      options.host = url.hostname;
    }
    for (const key of ["executable_path", "user_data_dir"]) if (Object.hasOwn(options, key)) {
      const path = options[key];
      if (path.includes("\0") || path && !path.trim()) throw new Error(`browser.${key} must be a valid path or an empty string`);
      options[key] = path ? resolve(APP_DIR, path) : key === "user_data_dir" ? join(CDP_DIR, browser) : "";
    }
    if (options.args) for (const arg of options.args) {
      if (arg.includes("\0")) throw new Error("browser.args must not contain NUL characters");
      const flag = cdpLaunchSwitch(arg);
      if (arg === "--" || ["headless", "user-data-dir", "remote-debugging"].includes(flag) || flag.startsWith("remote-debugging-"))
        throw new Error("browser.args cannot override managed headless, user-data-dir or remote-debugging switches");
    }
    return { browser, options };
  }
  function cdpConfiguredOptions(spec, saved = cdpBrowserOptions.get(spec.browser)) {
    const options = {
      headless: false, windowsHide: undefined, images: true, executable_path: "", user_data_dir: join(CDP_DIR, spec.browser), args: [],
      websocket_url: "", http_url: "", port: null, host: "127.0.0.1", connect_timeout_ms: 15000, request_timeout_ms: 30000,
      ...saved,
    };
    if (["websocket_url", "http_url", "port"].some(key => Object.hasOwn(spec.options, key)))
      Object.assign(options, { websocket_url: "", http_url: "", port: null });
    Object.assign(options, spec.options);
    if (cdpConnectionMode(options) !== "local" && ["headless", "windowsHide", "images", "executable_path", "user_data_dir", "args"].some(key => Object.hasOwn(spec.options, key)))
      throw new Error("Browser attachment cannot be combined with local launch options; clear its endpoint to return to local mode");
    if (Object.hasOwn(spec.options, "host") && cdpConnectionMode(options) !== "port")
      throw new Error("browser.host requires browser.port attachment");
    return options;
  }
  const cdpOptionsKey = options => JSON.stringify({
    ...options, executable_path: options.executable_path ? cdpPathKey(options.executable_path) : "",
    user_data_dir: cdpPathKey(options.user_data_dir),
  });
  const cdpOptionsConflict = browser => new Error(`Browser '${browser}' is already connected, connecting or running with different options. Reuse its options or choose another browser name.`);
  function cdpReuseBrowser(record, spec) {
    if (cdpOptionsKey(cdpConfiguredOptions(spec, record.options)) !== cdpOptionsKey(record.options)) throw cdpOptionsConflict(spec.browser);
    return record;
  }
  function cdpTargetSpec(value) {
    const error = inputSchemaError(CDP_TARGET_INPUT.anyOf[typeof value === "string" ? 0 : 1], value, "target");
    if (error) throw new Error(error);
    const target = cdpTargetName(cdpBrowserLabel(value)), options = typeof value === "string" ? {} : { ...value };
    delete options.name;
    if (options.create_params?.forTab === true) throw new Error("target.create_params.forTab=true is unsupported: logical targets must be pages");
    return { target, options };
  }
  const cdpTargetKey = (browser, target) => JSON.stringify([browser, target]);
  const cdpSortedJson = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  function cdpConfigureTarget(browser, spec) {
    const key = cdpTargetKey(browser, spec.target), saved = cdpTargetOptions.get(key);
    const options = { create_params: {}, initialize: true, runtime: "bootstrap", page: true, network: true,
      service_worker: true, focus_emulation: true, binding: true, background_service: true, ...saved, ...spec.options };
    const record = cdpBrowsers.get(browser), targetId = record?.label_targets.get(spec.target);
    if (saved && cdpSortedJson(options) !== cdpSortedJson(saved) &&
        (cdpTargetReservations.has(key) || cdpConnectPromises.has(browser) || record?.target_promises.has(spec.target) || targetId && record.live_targets.has(targetId)))
      throw new Error(`Target '${spec.target}' is already open or opening with different options. Close it first or choose another target name.`);
    cdpTargetOptions.set(key, options);
    return options;
  }
  const cdpFileExists = async path => {
    try { return (await Deno.stat(path)).isFile; }
    catch (error) { if (error instanceof Deno.errors.NotFound) return false; throw error; }
  };
  async function cdpBrowserExecutable() {
    return String(Deno.env.get("MRMCP_CDP_BROWSER") || "").trim() || cdp.browser.find_executable_path();
  }
  async function cdpCanBind(port) {
    let listener;
    try {
      listener = Deno.listen({ hostname: "127.0.0.1", port });
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse || error instanceof Deno.errors.PermissionDenied) return false;
      throw error;
    } finally { try { listener?.close(); } catch {} }
  }
  async function cdpPersistentBrowser(browser) {
    const existing = one("SELECT browser,port FROM cdp_browsers WHERE browser=?", browser);
    if (existing) return { browser: existing.browser, port: Number(existing.port), user_data_dir: join(CDP_DIR, browser) };
    const range = CDP_PORT_MAX - CDP_PORT_MIN + 1;
    const digest = createHash("sha256").update(browser).digest();
    const seed = digest.readUInt32BE(0) % range;
    const used = new Set(all("SELECT port FROM cdp_browsers").map(row => Number(row.port)));
    for (let offset = 0; offset < range; offset++) {
      const port = CDP_PORT_MIN + ((seed + offset) % range);
      if (used.has(port) || !await cdpCanBind(port)) continue;
      const now = Date.now();
      try {
        run("INSERT INTO cdp_browsers(browser,port,created_at,updated_at) VALUES(?,?,?,?)", browser, port, now, now);
      } catch (error) {
        const raced = one("SELECT browser,port FROM cdp_browsers WHERE browser=?", browser);
        if (raced) return { browser: raced.browser, port: Number(raced.port), user_data_dir: join(CDP_DIR, browser) };
        throw error;
      }
      return { browser, port, user_data_dir: join(CDP_DIR, browser) };
    }
    throw new Error(`No free CDP port in ${CDP_PORT_MIN}-${CDP_PORT_MAX}`);
  }
  async function cdpVersion(endpoint, timeoutMs = 800) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(typeof endpoint === "number" ? `http://127.0.0.1:${endpoint}/json/version` : endpoint, { signal: controller.signal });
      if (!response.ok) return null;
      const value = await response.json();
      if (!value || typeof value.webSocketDebuggerUrl !== "string") return null;
      value.webSocketDebuggerUrl = cdpEndpoint(value.webSocketDebuggerUrl, ["ws:", "wss:"], "CDP discovery endpoint").href;
      return value;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  async function cdpLaunchBrowser(record) {
    const options = record.options;
    const executable = options.executable_path || await cdpBrowserExecutable();
    if (!await cdpFileExists(executable)) throw new Error("browser.executable_path does not point to an existing file");
    // Use the package's launch policy; MrMCP additionally needs a stable port,
    // verbatim argv and a detached process that survives backend shutdown.
    const defaults = cdp.browser.build_args({ headless: options.headless, images: options.images, user_data_dir: record.user_data_dir });
    defaults["remote-debugging-port"] = record.port;
    const overrides = new Set(options.args.map(cdpLaunchSwitch).filter(Boolean));
    const args = [...cdp.util.args_to_strings(defaults).filter(arg => !overrides.has(cdpLaunchSwitch(arg))), ...options.args, "about:blank"];
    const profileIndex = args.findLastIndex(arg => arg === "--profile-directory" || arg.startsWith("--profile-directory="));
    const profile = profileIndex < 0 ? "Default" : args[profileIndex] === "--profile-directory" ? args[profileIndex + 1] : args[profileIndex].slice("--profile-directory=".length);
    await cdp.browser.update_profile_preferences(join(record.user_data_dir, profile, "Preferences"), {
      "translate.enabled": false, "signin.allowed": false, "signin.allowed_on_next_startup": false,
    });
    const child = nodeSpawn(executable, args, { detached: true, stdio: "ignore", windowsHide: options.windowsHide ?? options.headless });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
    const deadline = Date.now() + options.connect_timeout_ms;
    while (Date.now() < deadline) {
      const version = await cdpVersion(record.port, 500);
      if (version) return version;
      if (child.exitCode != null) throw new Error(`Browser exited before CDP became ready (exit ${child.exitCode})`);
      await sleep(100);
    }
    throw new Error(`Browser did not expose CDP on 127.0.0.1:${record.port} within ${options.connect_timeout_ms} ms`);
  }
  const cdpPublicMessage = message => {
    const { _bytes, ...publicMessage } = message;
    return publicMessage;
  };
  const cdpMethodMatches = (method, methods, prefixes) => {
    const exact = Array.isArray(methods) ? methods : [], starts = Array.isArray(prefixes) ? prefixes : [];
    if (!exact.length && !starts.length || exact.includes("*") || starts.includes("*")) return true;
    return exact.includes(method) || starts.some(prefix => method.startsWith(prefix));
  };
  const cdpSubscriptionMatches = (subscription, message, regexText = null) => {
    if (!message || subscription.browser !== message.browser) return false;
    if (!cdpMethodMatches(message.method || "", subscription.methods, subscription.method_prefixes)) return false;
    if (subscription.regex) {
      subscription.regex.lastIndex = 0;
      if (!subscription.regex.test(regexText ? regexText() : JSON.stringify(message.cdp ?? null))) return false;
    }
    if (!message.target_id) return !!subscription.include_browser;
    if (!subscription.targets?.length || subscription.targets.includes("*")) return true;
    return !!message.target && subscription.targets.includes(message.target);
  };
  const cdpRingLength = record => Math.max(0, record.ring.length - Number(record.ring_head || 0));
  const cdpRingOldest = record => cdpRingLength(record) ? record.ring[Number(record.ring_head || 0)] : null;
  const cdpRingNewest = record => cdpRingLength(record) ? record.ring.at(-1) : null;
  function cdpCompactRing(record) {
    const head = Number(record.ring_head || 0);
    if (head < 1024 || head * 2 < record.ring.length) return;
    record.ring = record.ring.slice(head);
    record.ring_head = 0;
  }
  function cdpMarkDropped(record, message) {
    record.dropped += 1;
    let serialized;
    const regexText = () => serialized ??= JSON.stringify(message.cdp ?? null);
    for (const subscription of cdpSubscriptions.values()) {
      if (subscription.cursor < message.seq && cdpSubscriptionMatches(subscription, message, regexText)) subscription.dropped += 1;
    }
  }
  function cdpRecordMessage(record, message) {
    const seq = (cdpBrowserSequences.get(record.browser) || 0) + 1;
    cdpBrowserSequences.set(record.browser, seq);
    const stored = { seq, ...message };
    stored._bytes = enc.encode(JSON.stringify(stored)).byteLength;
    if (stored._bytes > CDP_RING_MAX_BYTES) {
      cdpMarkDropped(record, stored);
      return null;
    }
    while (cdpRingLength(record) && (cdpRingLength(record) >= CDP_RING_MAX_MESSAGES || record.ring_bytes + stored._bytes > CDP_RING_MAX_BYTES)) {
      const removed = record.ring[record.ring_head++];
      record.ring_bytes = Math.max(0, record.ring_bytes - Number(removed?._bytes || 0));
      if (removed) cdpMarkDropped(record, removed);
    }
    cdpCompactRing(record);
    record.ring.push(stored);
    record.ring_bytes += stored._bytes;
    queueCdpUiRender();
    return stored;
  }
  const cdpMessageTarget = (record, message) => {
    let sessionId = String(message.sessionId || (message.method === "Target.detachedFromTarget" ? message.params?.sessionId : "") || "");
    let targetId = sessionId ? String(record.session_to_target.get(sessionId) || "") : "";
    const params = message.params || {};
    if (!targetId && message.method === "Target.attachedToTarget") {
      sessionId = String(params.sessionId || sessionId || "");
      targetId = String(params.targetInfo?.targetId || "");
    }
    if (!targetId && ["Target.targetCreated", "Target.targetInfoChanged"].includes(message.method))
      targetId = String(params.targetInfo?.targetId || "");
    if (!targetId && ["Target.targetDestroyed", "Target.targetCrashed"].includes(message.method))
      targetId = String(params.targetId || "");
    return {
      session_id: sessionId || null,
      target_id: targetId || null,
      target: targetId ? record.target_labels.get(targetId) || null : null,
    };
  };
  function cdpRequest(record, method, params = {}, sessionId = "", options = {}) {
    if (!record.open || record.ws.readyState !== WebSocket.OPEN) throw new Error(`CDP browser ${record.browser} is not connected`);
    const request = { method, params };
    if (sessionId) request.sessionId = sessionId;
    // jsrpc owns allocation, wire serialization, protocol errors and response waits.
    // Native params stay untouched: MrMCP routing lives outside CDP params.
    const response = record.ws.req(request), id = record.ws.id;
    const pending = {
      id, method: String(options.logical_method || method), wire_method: method, session_id: sessionId || null,
      target: options.target || null, target_id: options.target_id || null, expose: !!options.expose, raw: null,
    };
    record.pending.set(id, pending);
    const promise = response.then(result => pending.raw || { id, result, ...(sessionId ? { sessionId } : {}) }, error => {
      if (error.cdp && !options.reject_on_error) return error.cdp;
      throw error;
    }).finally(() => {
      // Keep correlation for a late response after a package request timeout.
      // It still belongs in the ring; timeout never implies browser cancellation.
      if (pending.raw || !record.open) record.pending.delete(id);
    });
    if (options.wait === false) { void promise.catch(() => {}); return { id, promise: null }; }
    return { id, promise };
  }
  async function cdpInternal(record, method, params = {}, sessionId = "") {
    const { promise } = cdpRequest(record, method, params, sessionId, { wait: true, reject_on_error: true });
    return (await promise)?.result || {};
  }
  function cdpSyncTargets(record) {
    // These maps are UI/ring projections. The package owns live target/session state.
    const engine = record.engine;
    record.live_targets = new Map(Object.entries(engine.target_info || {}));
    record.session_to_target = new Map(Object.entries(engine.session_targets || {}));
    record.target_to_session = new Map([...record.session_to_target].map(([session, target]) => [target, session]));
    record.target_labels.clear(); record.label_targets.clear(); record.session_setup_errors.clear();
    for (const [name, entry] of Object.entries(engine.targets)) {
      if (!entry.targetId) continue;
      record.target_labels.set(entry.targetId, name); record.label_targets.set(name, entry.targetId);
      if (entry.sessionId) record.session_setup_errors.set(entry.sessionId, [...(entry.setup_errors || [])]);
    }
  }
  function cdpHandleMessage(record, data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message && Number.isInteger(message.id)) {
      const pending = record.pending.get(message.id);
      if (pending) { pending.raw = message; record.pending.delete(message.id); }
      if (pending?.expose) cdpRecordMessage(record, {
        browser: record.browser, type: "response", id: message.id, method: pending.method,
        target: pending.target, target_id: pending.target_id, session_id: pending.session_id, cdp: message,
      });
      return;
    }
    if (!message || typeof message.method !== "string") return;
    // Resolve detach/destroy metadata before refreshing the projection.
    const previous = cdpMessageTarget(record, message);
    if (message.method.startsWith("Target.")) cdpSyncTargets(record);
    const current = cdpMessageTarget(record, message);
    const envelope = {
      browser: record.browser, type: "notification", id: null, method: message.method,
      ...(current.target_id ? current : previous), cdp: message,
    };
    let serialized;
    const regexText = () => serialized ??= JSON.stringify(message);
    for (const subscription of cdpSubscriptions.values()) {
      if (!cdpSubscriptionMatches(subscription, envelope, regexText)) continue;
      cdpRecordMessage(record, envelope); break;
    }
  }
  function cdpDisconnect(record) {
    if (!record.open) return;
    record.open = false;
    if (cdpBrowsers.get(record.browser) === record) cdpBrowsers.delete(record.browser);
    record.pending.clear(); record.target_to_session.clear(); record.session_to_target.clear();
    queueCdpUiRender();
  }
  async function cdpOpenConnection(browserRecord, version) {
    const client = new cdp.cdp({ base_path: CDP_DIR });
    const browser = {
      name: browserRecord.browser, websocket_url: version.webSocketDebuggerUrl,
      connect_timeout_ms: browserRecord.options.connect_timeout_ms,
      request_timeout_ms: browserRecord.options.request_timeout_ms,
    };
    // call() creates the documented browser/socket record synchronously for a
    // direct endpoint. Observe that public socket before connection events arrive.
    const ready = client.call({ method: "Browser.getVersion", params: { browser } });
    const engine = client.browsers[browser.name], ws = engine.socket;
    ws.id = Math.floor(Math.random() * 0x3fffffff) + 1;
    const record = {
      ...browserRecord, client, engine, ws, open: true, connection_id: randomToken(8),
      start_seq: cdpBrowserSequences.get(browser.name) || 0, pending: new Map(),
      target_to_session: new Map(), session_to_target: new Map(), target_labels: new Map(), label_targets: new Map(), live_targets: new Map(),
      session_setup_errors: new Map(), target_promises: new Map(),
      ring: [], ring_head: 0, ring_bytes: 0, dropped: 0,
    };
    for (const row of all("SELECT target,target_id FROM cdp_targets WHERE browser=?", browser.name)) {
      const options = cdpConfigureTarget(browser.name, { target: row.target, options: {} });
      engine.targets[row.target] = { name: row.target, targetId: row.target_id, sessionId: null, ...options };
    }
    cdpSyncTargets(record);
    ws.addEventListener("message", event => cdpHandleMessage(record, event.data));
    ws.addEventListener("close", () => cdpDisconnect(record));
    let timer, setupTimedOut = false;
    try {
      await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => {
          setupTimedOut = true;
          cdpDisconnect(record);
          try { ws.close(); } catch {}
          reject(new Error("CDP connection setup timed out"));
        }, browser.connect_timeout_ms);
      })]);
      const targets = await cdpInternal(record, "Target.getTargets");
      for (const info of targets.targetInfos || []) if (info.targetId)
        Object.assign(engine.target_info[info.targetId] ??= {}, info);
      cdpSyncTargets(record);
      if (cdpConnectionMode(record.options) === "local") try {
        const commandLine = await cdpInternal(record, "Browser.getBrowserCommandLine");
        const actual = (commandLine.arguments || []).find(argument => String(argument).startsWith("--user-data-dir="));
        if (actual && cdpPathKey(String(actual).slice("--user-data-dir=".length)) !== cdpPathKey(record.user_data_dir))
          throw new Error(`CDP port ${record.port} belongs to a browser using a different user-data-dir`);
        const headless = (commandLine.arguments || []).some(argument => /^--headless(?:=|$)/.test(String(argument)));
        if (headless !== record.options.headless) throw new Error(`CDP port ${record.port} belongs to a browser using a different headless setting`);
      } catch (error) {
        if (/different (?:user-data-dir|headless setting)/.test(String(error?.message || error))) throw error;
      }
      if (!record.open) throw new Error("CDP connection closed during setup");
      run("UPDATE cdp_browsers SET updated_at=? WHERE browser=?", Date.now(), browser.name);
      return record;
    } catch (error) {
      try { ws.close(); } catch {}
      cdpDisconnect(record);
      if (setupTimedOut) throw new Error("CDP connection setup timed out");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function ensureCdpBrowser(rawBrowser) {
    const spec = cdpBrowserSpec(rawBrowser), browser = spec.browser;
    const live = cdpBrowsers.get(browser);
    if (live?.open && live.ws.readyState === WebSocket.OPEN) return cdpReuseBrowser(live, spec);
    const connecting = cdpConnectPromises.get(browser);
    if (connecting) return cdpReuseBrowser(await connecting, spec);
    const promise = (async () => {
      const saved = cdpBrowserOptions.get(browser), options = cdpConfiguredOptions(spec, saved);
      const persistent = { ...await cdpPersistentBrowser(browser), options };
      if (saved && cdpOptionsKey(saved) !== cdpOptionsKey(options) && cdpConnectionMode(saved) === "local" && await cdpVersion(persistent.port))
        throw cdpOptionsConflict(browser);
      cdpBrowserOptions.set(browser, options);
      const mode = cdpConnectionMode(options);
      persistent.user_data_dir = mode === "local" ? options.user_data_dir : null;
      if (mode !== "local") persistent.port = mode === "port" ? options.port : null;
      let version = mode === "websocket" ? { webSocketDebuggerUrl: options.websocket_url }
        : mode === "local" ? await cdpVersion(persistent.port)
        : await cdpVersion(cdpDiscoveryUrl(options), options.connect_timeout_ms);
      if (!version && mode !== "local") throw new Error(`Unable to discover CDP browser '${browser}' through ${mode} attachment`);
      if (!version) version = await cdpLaunchBrowser(persistent);
      const record = await cdpOpenConnection(persistent, version);
      cdpBrowsers.set(browser, record);
      return record;
    })();
    cdpConnectPromises.set(browser, promise);
    try { return await promise; }
    finally { cdpConnectPromises.delete(browser); }
  }
  async function cdpEnsureTarget(record, rawTarget) {
    const spec = cdpTargetSpec(rawTarget), target = spec.target, options = cdpConfigureTarget(record.browser, spec);
    const existing = record.target_promises.get(target);
    if (existing) return await existing;
    const promise = (async () => {
      let entry = record.engine.targets[target];
      if (entry && !entry.sessionId) Object.assign(entry, options);
      if (!entry?.sessionId) {
        // Resolve/create/setup through the package's public API. This read has no
        // page-side effects and leaves native dispatch independent of routing keys.
        await record.client.call({ method: "Page.getFrameTree", params: { browser: record.browser, target: { name: target, ...options } } });
        entry = record.engine.targets[target];
      }
      if (!entry?.targetId || !entry.sessionId) throw new Error("CDP did not resolve the logical page");
      cdpSyncTargets(record);
      const now = Date.now();
      run(`INSERT INTO cdp_targets(browser,target,target_id,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(browser,target) DO UPDATE SET target_id=excluded.target_id,updated_at=excluded.updated_at`,
        record.browser, target, entry.targetId, now, now);
      return { target, target_id: entry.targetId, session_id: entry.sessionId };
    })();
    record.target_promises.set(target, promise);
    try { return await promise; }
    finally { record.target_promises.delete(target); }
  }

  const CHAT_GOAL_BROWSER = "mrmcp-chatgpt", CHAT_GOAL_RETRY_MS = 60000;
  const CHAT_GOAL_STATUSES = ["disabled", "pending", "matching", "ready", "waiting_login", "not_found", "busy", "draft_present", "error", "sending", "delivery_uncertain", "expired"];
  let chatGoalTimer = null, chatGoalTask = null, chatGoalGeneration = 0;
  let chatGoalLoginActive = false, chatGoalLoginBusy = false, chatGoalLoginDetail = "";
  let chatGoalLoginStatus = "", chatGoalLoginCheckedAt = 0, chatGoalLoginComposer = "";
  let chatGoalLoginTimer = null, chatGoalLoginTask = null, chatGoalLoginPage = null, chatGoalLoginRefresh = false;
  const chatGoalMonitors = new Set();
  const chatGoalsEnabled = () => getCfg("chat_goals_enabled", "1") === "1";
  const chatGoalLoginReady = () => Number(getCfg("chat_goal_login_verified_at", "0")) > 0;
  const chatGoalsOperational = () => chatGoalsEnabled() && chatGoalLoginReady() && !chatGoalLoginActive;
  const CHAT_GOAL_LOGIN_HINT = "Select Login ChatGPT in Settings → Goals and sign in in the dedicated Chrome window. Login is detected automatically.";
  const chatGoalDefaultTimeout = () => Math.max(1, Math.min(1440, Number(getCfg("chat_goal_timeout_minutes", "5")) || 5)) * 60;
  const chatGoalWindowsHide = (headless = getCfg("chat_goal_headless", "0") === "1") => {
    const mode = getCfg("chat_goal_windows_hide", "auto");
    return mode === "auto" ? headless : mode === "hide";
  };
  function recoverChatGoals() {
    run("UPDATE contexts SET goal_status='delivery_uncertain',goal_error='Server stopped during a send. Inspect the chat before setting the goal again.' WHERE goal_status='sending' AND goal_text<>''");
    run("UPDATE contexts SET goal_status='error',goal_next_check_at=0,goal_error='Server stopped during matching. Call chat_set_goal again to retry matching.' WHERE goal_status='matching' AND chatgpt_chat_id='' AND goal_text<>''");
    // Restart does not inherit queued matching work by default. Only this
    // startup hook may opt into one new attempt; ordinary settings saves cannot.
    run("UPDATE contexts SET goal_revision=goal_revision+1,goal_status='error',goal_next_check_at=0,goal_error='Matching was not resumed at startup. Call chat_set_goal again to retry matching.' WHERE goal_status='pending' AND chatgpt_chat_id='' AND goal_text<>''");
    if (chatGoalsOperational() && getCfg("chat_goal_match_on_startup", "0") === "1") {
      const now = Date.now();
      run(`UPDATE contexts SET goal_revision=goal_revision+1,goal_status='pending',goal_next_check_at=?,goal_error=''
        WHERE chatgpt_chat_id='' AND goal_text<>'' AND goal_status NOT IN ('disabled','expired','sending','delivery_uncertain')
          AND COALESCE(NULLIF(last_active_at,0),created_at,0)>=?`, now + 1000, now - CONTEXT_TTL_MS);
    }
  }
  function chatGoalConfigure() {
    chatGoalGeneration++;
    if (chatGoalTimer) clearInterval(chatGoalTimer);
    for (const monitor of [...chatGoalMonitors]) if (!monitor.login_setup || !chatGoalLoginActive) monitor.stop();
    chatGoalTimer = null;
    if (!chatGoalsOperational()) {
      const record = cdpBrowsers.get(CHAT_GOAL_BROWSER);
      if (record && !chatGoalLoginActive) { try { record.ws.close(); } catch {} cdpDisconnect(record); }
    } else if (!shuttingDown) chatGoalTimer = setInterval(chatGoalTick, 5000);
    serverToolCache.clear();
    changed({ ui: ["sessions", "settings"] }, "chat-goal-config");
  }
  const chatGoalUrl = id => id ? `https://chatgpt.com/c/${id}` : "https://chatgpt.com/";
  const chatGoalChatId = url => {
    try {
      const u = new URL(url);
      return u.origin === "https://chatgpt.com" ? u.pathname.match(/\/c\/([a-z0-9-]{8,80})\/?$/i)?.[1] || "" : "";
    } catch { return ""; }
  };
  function chatGoalView(context) {
    const loginRequired = !!context.goal_text && !chatGoalLoginReady() && !["disabled", "expired", "sending", "delivery_uncertain"].includes(context.goal_status);
    return {
      goal: context.goal_text, timeout_seconds: Number(context.goal_timeout_seconds), status: !chatGoalsEnabled() ? "disabled" : loginRequired ? "waiting_login" : context.goal_status,
      chatgpt_chat_id: context.chatgpt_chat_id || null, chat_url: context.chatgpt_chat_id ? chatGoalUrl(context.chatgpt_chat_id) : null,
      next_check_at: chatGoalsOperational() && context.goal_text && context.goal_next_check_at ? Number(context.goal_next_check_at) : null,
      last_sent_at: context.goal_last_sent_at ? Number(context.goal_last_sent_at) : null,
      detail: !chatGoalsEnabled() ? "Chat goal management is disabled in Settings → Goals." : loginRequired ? CHAT_GOAL_LOGIN_HINT + (context.chatgpt_chat_id ? "" : " Then call chat_set_goal again to retry matching.") : context.goal_error || null,
      browser: CHAT_GOAL_BROWSER, user_data_dir: join(CDP_DIR, CHAT_GOAL_BROWSER),
    };
  }
  function setChatGoal(context, goal, timeoutSeconds = chatGoalDefaultTimeout()) {
    if (typeof goal !== "string" || goal.length > 32000) throw new Error("goal must be a string of at most 32000 characters");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 86400)
      throw new Error("timeout_seconds must be an integer between 30 and 86400");
    if (!chatGoalsEnabled() && goal.trim()) return chatGoalView(context);
    const text = goal.trim() ? goal : "", now = Date.now();
    // The latest explicit set wins if several Sessions belong to the same ChatGPT conversation.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (text && context.chatgpt_chat_id) disableOtherChatGoals(context.id, context.chatgpt_chat_id);
      run(`UPDATE contexts SET goal_text=?,goal_timeout_seconds=?,goal_revision=goal_revision+1,goal_updated_at=?,
        goal_status=?,goal_next_check_at=?,goal_error='',updated_at=? WHERE id=?`,
        text, timeoutSeconds, now, text ? context.chatgpt_chat_id ? "ready" : "pending" : "disabled",
        text ? context.chatgpt_chat_id ? now + timeoutSeconds * 1000 : now + 1000 : 0, now, context.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (text && !chatGoalLoginReady()) chatGoalState(one("SELECT * FROM contexts WHERE id=?", context.id), "waiting_login", CHAT_GOAL_LOGIN_HINT, 0);
    changed({ ui: ["sessions"] }, "chat-goal-set");
    return chatGoalView(one("SELECT * FROM contexts WHERE id=?", context.id));
  }
  function disableOtherChatGoals(id, chatId) {
    run(`UPDATE contexts SET goal_text='',goal_revision=goal_revision+1,goal_status='disabled',goal_next_check_at=0,
      goal_error='Replaced by another Session in this ChatGPT conversation.' WHERE id<>? AND chatgpt_chat_id=? AND goal_text<>''`, id, chatId);
  }
  function chatGoalState(context, status, detail = "", next = Date.now() + CHAT_GOAL_RETRY_MS) {
    if (shuttingDown) return;
    if (!CHAT_GOAL_STATUSES.includes(status)) status = "error";
    if (!context.chatgpt_chat_id && !["pending", "matching", "disabled", "expired"].includes(status)) {
      next = 0;
      detail = `${String(detail).slice(0, 350)} Call chat_set_goal again to retry matching.`.trim();
    }
    run(`UPDATE contexts SET goal_status=?,goal_error=?,goal_next_check_at=? WHERE id=? AND goal_revision=? AND goal_text<>''`,
      status, String(detail).slice(0, 500), next, context.id, context.goal_revision);
    changed({ ui: ["sessions"] }, "chat-goal-state");
  }
  function chatGoalCurrent(context) {
    if (!chatGoalsOperational() || shuttingDown) return null;
    const fresh = one("SELECT * FROM contexts WHERE id=? AND goal_revision=? AND goal_text<>''", context.id, context.goal_revision);
    return fresh && !contextExpired(fresh) ? fresh : null;
  }
  function noteChatGoalActivity(handle) {
    if (!chatGoalsEnabled()) return;
    if (typeof handle !== "string" || !handle || handle.length > 256) return;
    const context = one("SELECT * FROM contexts WHERE handle=?", handle);
    if (!context || contextExpired(context)) return;
    run(`UPDATE contexts SET goal_activity_at=? WHERE goal_text<>'' AND (handle=? OR (chatgpt_chat_id<>'' AND chatgpt_chat_id=?))`,
      Date.now(), handle, context.chatgpt_chat_id);
  }
  const chatGoalDue = context => Math.max(context.last_active_at, context.goal_activity_at, context.goal_updated_at, context.goal_last_sent_at) + context.goal_timeout_seconds * 1000;
  async function chatGoalRpc(page, method, params = {}) {
    if (!(page.login_setup ? chatGoalLoginActive : chatGoalsOperational()) || shuttingDown) throw new Error("Chat goal management is disabled, awaiting login or stopping");
    const { id, promise } = cdpRequest(page.record, method, params, page.session_id, { wait: true, reject_on_error: true });
    let timer;
    try {
      const raw = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ChatGPT browser timed out: ${method}`)), 15000);
      })]);
      return raw?.result || {};
    } finally { clearTimeout(timer); page.record.pending.delete(id); }
  }
  // Re-resolve rendered DOM on every operation. Never classify controls by translated text, generated CSS or icons.
  function chatGoalDom(action, input) {
    if (location.origin !== "https://chatgpt.com" || location.pathname.startsWith("/auth/")) return { status: "waiting_login", url: location.href };
    const selectors = {
      editor: '#prompt-textarea,#mobile-composer-prompt,[data-mobile-composer-prompt],textarea[name="prompt"],[contenteditable="true"][data-testid="prompt-textarea"],[data-composer-markdown][contenteditable],form[data-chatgpt-composer] [role="textbox"][contenteditable]',
      editable: 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"]',
      send: '[data-testid="send-button"]',
      stop: '[data-testid="stop-button"]',
      busy: '[data-testid="stop-button"],[data-is-streaming="true"],[data-state="streaming"],[data-message-author-role="assistant"][aria-busy="true"]',
      history: 'nav,[role="navigation"],aside,#history',
      user: '[data-message-author-role="user"]',
      assistant: '[data-message-author-role="assistant"],article[data-testid^="conversation-turn-"]',
      tool: '[data-message-author-role="tool"],[data-tool-call-id],[data-testid*="tool-call"],[data-testid*="tool-message"],[data-testid*="connector-call"]',
      disclosure: 'button[aria-expanded][aria-controls],[role="button"][aria-expanded][aria-controls],details>summary',
      code: 'pre,code,[role="code"]',
    };
    const visible = el => !!el && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const nodes = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
    const unique = values => [...new Set(values)];
    const available = el => !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true";
    const inModal = el => !!el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const formOf = el => el.form || el.closest("form");
    const formSubmits = form => nodes('button,input[type="submit"]').filter(el => el.form === form && el.type === "submit" && !el.matches(selectors.stop));
    const formEditors = form => nodes(selectors.editable).filter(el => formOf(el) === form);
    const knownEditors = nodes(selectors.editor).filter(el => !inModal(el));
    // Native form ownership also covers submit controls outside the form via their HTML form attribute.
    const fallbackEditors = nodes('main textarea,[role="main"] textarea,main [role="textbox"][contenteditable],[role="main"] [role="textbox"][contenteditable]').filter(el => {
      const form = formOf(el);
      return !inModal(el) && form && formEditors(form).length === 1 && (formSubmits(form).length === 1 ||
        !formSubmits(form).length && nodes(selectors.stop).some(control => control.form === form || form.contains(control))) &&
        !nodes('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]),select', form).length;
    });
    const editors = knownEditors.length ? knownEditors : fallbackEditors;
    const editor = editors.length === 1 ? editors[0] : null, form = editor ? formOf(editor) : null;
    const editorText = () => editor ? (editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText).replace(/\r\n?/g, "\n") : "";
    let composer = form;
    if (editor && !composer) {
      for (let parent = editor.parentElement, depth = 0; parent && !parent.matches('body,main,[role="main"]') && depth < 5; parent = parent.parentElement, depth++) {
        if (nodes(`${selectors.send},${selectors.stop}`, parent).length && nodes(selectors.editable, parent).length === 1) { composer = parent; break; }
      }
    }
    const knownSubmits = nodes(selectors.send).filter(el => !el.matches(selectors.stop) && (form ? el.form === form || form.contains(el) : composer?.contains(el)));
    const submits = unique(knownSubmits.length ? knownSubmits : form && formEditors(form).length === 1 ? formSubmits(form) : []);
    const login = nodes('[data-logged-out],form[action*="/auth/"],form[action^="/unauth-"]').length > 0 ||
      nodes('a[href]').some(el => { try { const url = new URL(el.href); return url.origin === location.origin && /^\/auth\/login(?:[\/_]|$)/.test(url.pathname); } catch { return false; } });
    const busy = nodes(selectors.busy).length > 0 || !!composer?.closest('[aria-busy="true"]') || !!(composer && nodes('[aria-busy="true"]', composer).length);
    const users = nodes(selectors.user).slice(-12).map(el => ({ id: el.getAttribute("data-message-id") || el.closest('[data-message-id]')?.getAttribute("data-message-id") || el.id || "", text: el.innerText.slice(0, 32001) }));
    const dialogs = nodes('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const reason = login ? "login_required" : dialogs.length ? "dialog_open" : editors.length > 1 ? "composer_ambiguous" : !editor ? "composer_missing" :
      !available(editor) ? "composer_disabled" : busy ? "response_busy" : "ready";
    const diagnostics = { adapter: "dom-v2", reason, editors: editors.length, submit_controls: submits.length };
    const base = { status: login ? "waiting_login" : reason === "response_busy" ? "busy" : reason === "ready" ? "ready" : "not_ready", responding: busy, url: location.href, draft: editorText(), users, diagnostics,
      detail: reason === "ready" ? "" : `ChatGPT DOM: ${reason} (editors=${editors.length}, submit_controls=${submits.length}).` };
    const controls = el => el.matches("summary") && el.parentElement?.matches("details") ? [el.parentElement] :
      (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean);
    const disclosure = el => available(el) && !el.closest('form,pre,code,[role="code"]') &&
      (el.matches("summary") || el.getAttribute("aria-expanded") !== null && !!el.getAttribute("aria-controls")?.trim());
    const expand = el => { if (el.matches("summary") ? !el.parentElement.open : el.getAttribute("aria-expanded") === "false") el.click(); };
    const chatUrl = raw => {
      try { const url = new URL(raw, location.href); return url.origin === location.origin && /\/c\/[a-z0-9-]{8,80}\/?$/i.test(url.pathname) ? url.href : ""; }
      catch { return ""; }
    };
    const historyLinks = root => nodes('a[href]', root).map(el => chatUrl(el.href)).filter(Boolean);
    if (action === "state") return base;
    if (action === "stop") {
      const stops = nodes(selectors.stop).filter(el => !inModal(el) && el.matches('button,[role="button"],input[type="button"],input[type="submit"]'));
      const stopReason = location.pathname !== `/c/${input.chatId}` ? "conversation_changed" :
        login || dialogs.length || editors.length > 1 ? reason : base.draft.trim() ? "draft_present" :
        !busy ? "ready" : !stops.length ? "stop_missing" : stops.length > 1 ? "stop_ambiguous" : !available(stops[0]) ? "stop_disabled" : "ready";
      if (stopReason !== "ready") return { ...base, stop_ok: false, stopped: false, detail: `ChatGPT DOM: ${stopReason}.` };
      if (busy) stops[0].click();
      return { ...base, stop_ok: true, stopped: busy };
    }
    if (action === "recent") {
      const history = nodes(selectors.history), urls = unique(history.flatMap(historyLinks));
      if (!urls.length) {
        const openers = nodes(selectors.disclosure).filter(el => disclosure(el) && controls(el).some(target =>
          target.matches(selectors.history) || target.querySelector(selectors.history)));
        if (openers.length === 1) expand(openers[0]);
      }
      return { ...base, urls: urls.slice(0, 20), detail: urls.length ? "" : "ChatGPT DOM: no conversation links in navigation regions; sign in or check the website layout." };
    }
    if (action === "match" || action === "expand") {
      const assistants = nodes(selectors.assistant).filter(el => !el.closest(selectors.user) && !el.querySelector(selectors.user)).slice(-12);
      const candidates = unique(assistants.flatMap(el => nodes(selectors.disclosure, el)).filter(disclosure)).reverse();
      const marked = nodes(selectors.tool).filter(el => !el.closest(selectors.user));
      const related = unique(candidates.flatMap(controls)).filter(visible);
      // Only complete JSON values count. A quoted handle or a JSON fragment in prose is not evidence.
      const hasSession = (value, trusted, depth = 0) => {
        if (depth > 10 || !value) return false;
        if (trusted && typeof value === "string" && value.length <= 262144) {
          try { return hasSession(JSON.parse(value), trusted, depth + 1); } catch { return false; }
        }
        if (typeof value !== "object") return false;
        if (Array.isArray(value)) return value.slice(0, 100).some(item => hasSession(item, trusted, depth + 1));
        if (trusted && Object.hasOwn(value, "chat_session") && value.chat_session === input.handle) return true;
        const call = value.method === "tools/call" && typeof value.params?.name === "string";
        const named = typeof value.name === "string" && (input.tool_names || []).some(name => value.name === name || value.name.endsWith(`__${name}`) || value.name.endsWith(`.${name}`));
        if (call && hasSession(value.params.arguments, true, depth + 1) || named && hasSession(value.arguments, true, depth + 1)) return true;
        // Follow protocol wrappers, never arbitrary goal/message strings containing an example packet.
        return ["params", "arguments", "result", "structuredContent", "input", "output"].some(key => hasSession(value[key], trusted, depth + 1));
      };
      const surfaces = unique([...marked, ...related]);
      const match = surfaces.some(el => {
        const trusted = marked.some(marker => marker === el || marker.contains(el));
        const code = el.matches(selectors.code) ? [el] : nodes(selectors.code, el);
        return unique(code).slice(0, 40).some(block => {
          const text = block.innerText;
          if (text.length > 262144) return false;
          try { return hasSession(JSON.parse(text), trusted); } catch { return false; }
        });
      });
      if (action === "match" || match) return { ...base, match };
      const candidate = candidates[input.index || 0];
      if (candidate) expand(candidate);
      return { ...base, match: false, expanded: !!candidate };
    }
    if (action === "focus") {
      if (!["ready", "busy"].includes(base.status) || !users.at(-1)?.id || base.draft.trim() || location.pathname !== `/c/${input.chatId}`) return { ...base, focused: false };
      editor.focus();
      return { ...base, focused: document.activeElement === editor };
    }
    if (action === "clear") {
      if (editor && location.pathname === `/c/${input.chatId}` && editorText() === input.text) {
        editor.focus();
        if (editor instanceof HTMLTextAreaElement) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, ""); editor.dispatchEvent(new Event("input", { bubbles: true })); }
        else { const range = document.createRange(); range.selectNodeContents(editor); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand("delete"); }
      }
      return { cleared: !!editor && !editorText() };
    }
    if (action === "send") {
      // During generation the site's native form may accept a queued prompt
      // while its only visible button is Stop. Never click Stop as a submit.
      const formSend = !submits.length && form instanceof HTMLFormElement && formEditors(form).length === 1 && (busy || form.hasAttribute("data-chatgpt-composer"));
      const sendReason = !["ready", "busy"].includes(base.status) ? reason : location.pathname !== `/c/${input.chatId}` ? "conversation_changed" :
        busy && input.require_stopped ? "response_still_active" : editorText() !== input.text ? "draft_changed" : !submits.length && !formSend ? "submit_missing" : submits.length > 1 ? "submit_ambiguous" :
        submits.length && !available(submits[0]) ? "submit_disabled" : "ready";
      if (sendReason !== "ready")
        return { sent: false, status: base.status, diagnostics: { ...diagnostics, reason: sendReason }, detail: `ChatGPT DOM: ${sendReason} (submit_controls=${submits.length}).` };
      if (formSend) HTMLFormElement.prototype.requestSubmit.call(form);
      else submits[0].click();
      return { sent: true };
    }
    return base;
  }

  async function chatGoalEvaluate(page, action, input = {}) {
    const result = await chatGoalRpc(page, "Runtime.evaluate", {
      expression: `(${chatGoalDom.toString()})(${JSON.stringify(action)},${JSON.stringify({ ...input, tool_names: BASE_TOOLS })})`, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error("The ChatGPT page could not be inspected. Its interface may have changed.");
    const state = result.result?.value || { status: "not_ready" };
    if (!page.login_setup && state.status === "waiting_login" && state.url && !state.url.startsWith("about:")) chatGoalLoginLost();
    return state;
  }
  function chatGoalLoginLost() {
    if (!chatGoalLoginReady()) return;
    setCfg("chat_goal_login_verified_at", "0");
    chatGoalLoginStatus = "signed_out";
    chatGoalLoginDetail = "ChatGPT login was lost. " + CHAT_GOAL_LOGIN_HINT;
    for (const context of all("SELECT * FROM contexts WHERE goal_text<>'' AND goal_status NOT IN ('disabled','expired','sending','delivery_uncertain')"))
      chatGoalState(context, "waiting_login", CHAT_GOAL_LOGIN_HINT, 0);
    chatGoalConfigure();
  }
  function chatGoalHistorySessions(data, chatId) {
    if (data?.conversation_id && data.conversation_id !== chatId) throw new Error("Conversation response identity mismatch");
    if (!data?.mapping || typeof data.current_node !== "string") throw new Error("Unsupported or incomplete conversation history");
    const seen = new Set(), handles = new Set();
    for (let id = data.current_node; id != null;) {
      if (seen.has(id) || seen.size >= 20000) throw new Error("Invalid conversation branch");
      seen.add(id);
      const node = data.mapping[id];
      if (!node || !Object.hasOwn(node, "parent")) throw new Error("Incomplete conversation branch");
      const message = node.message;
      if (message?.author?.role === "assistant" && message.recipient === "api_tool.call_tool" && typeof message.content?.text === "string") {
        let request;
        try { request = JSON.parse(message.content.text); } catch {}
        const tool = typeof request?.path === "string" ? request.path.split("/").at(-1) : "";
        const handle = request?.args?.chat_session;
        if (BASE_TOOLS.includes(tool) && typeof handle === "string" && /^ctx_[A-Za-z0-9_-]+$/.test(handle) && handle.length <= 256 && handles.size < 100)
          handles.add(handle);
      }
      id = node.parent;
    }
    return handles;
  }
  function chatGoalMonitor(page) {
    if (page.record.goal_monitor?.session_id === page.session_id && page.record.goal_monitor.login_setup === !!page.login_setup && !page.record.goal_monitor.stopped) return page.record.goal_monitor;
    page.record.goal_monitor?.stop();
    const { client } = page.record, requests = new Map(), epochs = new Map(), recent = new Map(), histories = new Map(), pending = new Set();
    const monitor = { session_id: page.session_id, login_setup: !!page.login_setup, recent, histories, pending, stopped: false, error: "", list_at: 0, generation: 0 };
    const active = () => !monitor.stopped && (page.login_setup ? chatGoalLoginActive : chatGoalsOperational()) && !shuttingDown && page.record.open;
    const fromPage = event => active() && event.detail.browser === page.record.browser && event.detail.target === page.target;
    const boundedSet = (map, key, value, limit) => {
      map.delete(key); map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    };
    const started = event => {
      if (!fromPage(event)) return;
      let url;
      try { url = new URL(event.detail.request.url); } catch { return; }
      if (url.origin === "https://chatgpt.com" && /^\/backend-api\/conversations?(?:\/|$)/.test(url.pathname))
        boundedSet(epochs, event.detail.requestId, monitor.generation, 100);
    };
    const response = event => {
      if (!fromPage(event)) return;
      const p = event.detail, r = p.response;
      let url;
      try { url = new URL(r.url); } catch { return; }
      if (url.origin === "https://chatgpt.com" && /^\/backend-api\/conversations?(?:\/|$)/.test(url.pathname) && r.status === 401) {
        monitor.generation++; monitor.list_at = 0;
        if (!page.login_setup) chatGoalLoginLost();
        return;
      }
      if (url.origin !== "https://chatgpt.com" || r.status !== 200 || !String(r.mimeType).includes("json")) return;
      const list = url.pathname === "/backend-api/conversations";
      const id = url.pathname.match(/^\/backend-api\/conversations?\/([a-z0-9-]{8,80})$/i)?.[1];
      if (!list && !id || list && url.searchParams.get("is_archived") === "true") return;
      boundedSet(requests, p.requestId, { list, id, at: Date.now(), generation: epochs.get(p.requestId) }, 100);
    };
    const finished = event => {
      if (!fromPage(event)) return;
      const p = event.detail, request = requests.get(p.requestId);
      requests.delete(p.requestId);
      epochs.delete(p.requestId);
      if (!request || pending.size >= 8 || page.login_setup && request.generation !== monitor.generation) return;
      if (!request.list && request.generation !== monitor.generation) return;
      // Read only bodies already requested by the web application, on their own
      // inspector session. Never copy cookies/headers or issue authenticated fetches.
      const task = (async () => {
        try {
          if (Number(p.encodedDataLength) > 8 * 1024 * 1024) throw new Error("Conversation capture exceeds size limit");
          const body = await chatGoalRpc(page, "Network.getResponseBody", { requestId: p.requestId });
          if (!active() || (!request.list || page.login_setup) && request.generation !== monitor.generation) return;
          if (typeof body.body !== "string" || body.body.length > 12 * 1024 * 1024) throw new Error("Conversation capture exceeds size limit");
          const data = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
          if (request.list) {
            if (!Array.isArray(data.items)) throw new Error("Unsupported conversation list");
            for (const item of data.items.slice(0, 200)) if (/^[a-z0-9-]{8,80}$/i.test(item?.id)) {
              const updated = typeof item.update_time === "number" ? item.update_time : Date.parse(item.update_time) / 1000;
              boundedSet(recent, item.id, { id: item.id, updated: Number.isFinite(updated) ? updated : 0 }, 200);
            }
            monitor.list_at = Date.now();
            if (page.login_setup && chatGoalLoginPage === page) void chatGoalLoginTick();
          } else {
            const handles = chatGoalHistorySessions(data, request.id);
            boundedSet(histories, request.id, { handles, at: request.at }, 20);
          }
          monitor.error = "";
        } catch (error) {
          if (active()) monitor.error = error instanceof SyntaxError ? "Invalid conversation capture" : "Conversation capture unavailable or unsupported";
        }
      })().finally(() => pending.delete(task));
      pending.add(task);
    };
    const failed = event => { if (fromPage(event)) { requests.delete(event.detail.requestId); epochs.delete(event.detail.requestId); } };
    const frame = event => {
      if (!fromPage(event) || event.detail.response?.opcode !== 1) return;
      const text = event.detail.response.payloadData;
      if (typeof text !== "string" || text.length > 65536) return;
      let messages;
      try { messages = JSON.parse(text); } catch { return; }
      if (!Array.isArray(messages)) return;
      for (const message of messages.slice(0, 100)) {
        const notification = message?.type === "message" && message.payload, id = notification?.payload?.conversation_id;
        if (!/^[a-z0-9-]{8,80}$/i.test(id || "") || !["conversation-created", "conversation-turn-complete"].includes(notification.type)) continue;
        // A push is only a discovery hint. Association still requires a captured
        // active-branch tool call or explicit rendered tool details.
        boundedSet(recent, id, { id, updated: Date.now() / 1000 }, 200);
        histories.delete(id);
      }
    };
    const listeners = [["Network.requestWillBeSent", started], ["Network.responseReceived", response], ["Network.loadingFinished", finished],
      ["Network.loadingFailed", failed], ["Network.webSocketFrameReceived", frame]];
    for (const [name, listener] of listeners) client.addEventListener(name, listener);
    monitor.stop = () => {
      monitor.stopped = true;
      for (const [name, listener] of listeners) client.removeEventListener(name, listener);
      requests.clear(); epochs.clear(); recent.clear(); histories.clear();
      chatGoalMonitors.delete(monitor);
      page.record.ws.removeEventListener("close", monitor.stop);
    };
    page.record.ws.addEventListener("close", monitor.stop);
    chatGoalMonitors.add(monitor); page.record.goal_monitor = monitor;
    return monitor;
  }
  async function chatGoalPage(context = null, loginSetup = false) {
    const allowed = () => !shuttingDown && (loginSetup ? chatGoalLoginActive : chatGoalsOperational());
    if (!allowed()) throw new Error(CHAT_GOAL_LOGIN_HINT);
    const generation = chatGoalGeneration;
    const saved = cdpBrowserOptions.get(CHAT_GOAL_BROWSER), port = one("SELECT port FROM cdp_browsers WHERE browser=?", CHAT_GOAL_BROWSER)?.port;
    if (saved && (cdpConnectionMode(saved) !== "local" || cdpPathKey(saved.user_data_dir) !== cdpPathKey(join(CDP_DIR, CHAT_GOAL_BROWSER))))
      throw new Error("The goals browser name is in use with a different profile or endpoint. Release it before initializing the dedicated login profile.");
    const running = saved && (cdpBrowsers.get(CHAT_GOAL_BROWSER)?.open || port && await cdpVersion(Number(port)));
    if (!allowed() || generation !== chatGoalGeneration) throw new Error("Chat goal configuration changed");
    const record = await ensureCdpBrowser(running ? CHAT_GOAL_BROWSER : {
      name: CHAT_GOAL_BROWSER, headless: loginSetup ? false : getCfg("chat_goal_headless", "0") === "1", windowsHide: loginSetup ? false : chatGoalWindowsHide(),
      images: loginSetup || getCfg("chat_goal_disable_images", "0") !== "1",
      user_data_dir: join(CDP_DIR, CHAT_GOAL_BROWSER), args: [], executable_path: "", websocket_url: "", connect_timeout_ms: 15000,
    });
    if (!allowed() || generation !== chatGoalGeneration) {
      try { record.ws.close(); } catch {} cdpDisconnect(record);
      throw new Error("Chat goal management is disabled or stopping");
    }
    let timer;
    try {
      const target = await Promise.race([
        cdpEnsureTarget(record, { name: "goals", create_params: { url: "about:blank", background: false }, initialize: false }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          try { record.ws.close(1000, "Chat goal page setup timed out"); } catch {}
          cdpDisconnect(record, "Chat goal page setup timed out");
          reject(new Error("The dedicated ChatGPT tab did not become available."));
        }, 20000); }),
      ]);
      if (!allowed() || generation !== chatGoalGeneration) throw new Error("Chat goal configuration changed");
      const page = { record, ...target, login_setup: loginSetup }, monitor = chatGoalMonitor(page);
      if (!monitor.enabled) {
        await chatGoalRpc(page, "Network.enable");
        monitor.enabled = true;
      }
      if (record.live_targets.get(target.target_id)?.url === "about:blank") await chatGoalRpc(page, "Page.navigate", { url: chatGoalUrl("") });
      return page;
    } finally { clearTimeout(timer); }
  }
  function chatGoalLoginStop() {
    if (chatGoalLoginTimer) clearInterval(chatGoalLoginTimer);
    chatGoalLoginTimer = null;
    chatGoalLoginActive = false;
    chatGoalLoginPage?.record.goal_monitor?.stop();
    chatGoalLoginPage = null;
  }
  function chatGoalLoginTick() {
    if (!chatGoalLoginActive || shuttingDown || chatGoalLoginTask) return chatGoalLoginTask;
    const page = chatGoalLoginPage;
    if (!page) return;
    chatGoalLoginTask = (async () => {
      if (!page.record.open) { chatGoalLoginStatus = "closed"; throw new Error("The login window was closed or disconnected. Select Login ChatGPT again to continue."); }
      const state = await chatGoalEvaluate(page, "state");
      if (!chatGoalLoginActive || chatGoalLoginPage !== page || shuttingDown) return;
      chatGoalLoginCheckedAt = Date.now();
      chatGoalLoginComposer = state.diagnostics?.reason || state.status;
      const monitor = page.record.goal_monitor;
      if (!monitor || monitor.stopped) throw new Error("Login observation stopped. Select Login ChatGPT again to continue.");
      if (state.status === "waiting_login" && monitor.list_at) { monitor.generation++; monitor.list_at = 0; }
      // The site requests its own recent-list data after login. Never inspect
      // authentication/session payloads; a public composer is not proof of login.
      if (monitor.list_at && state.url?.startsWith("https://chatgpt.com/") && state.status !== "waiting_login") {
        setCfg("chat_goal_login_verified_at", String(Date.now()));
        chatGoalLoginStatus = "authenticated";
        chatGoalLoginStop();
        chatGoalLoginDetail = "ChatGPT login detected. Linked goals can run when goal management is enabled. Call chat_set_goal again for missing matches. Close this Chrome window to apply saved monitoring launch options.";
        chatGoalConfigure();
        return;
      }
      // A browser already signed in may have loaded its data before attachment.
      // Refresh once, as part of the explicit Login action, preserving drafts.
      if (chatGoalLoginRefresh && ["ready", "busy"].includes(state.status) && !state.draft?.trim()) {
        chatGoalLoginRefresh = false;
        monitor.generation++;
        const navigation = await chatGoalRpc(page, "Page.navigate", { url: chatGoalUrl("") });
        if (navigation.errorText) throw new Error(`ChatGPT navigation failed: ${navigation.errorText}`);
      }
      const status = state.status === "waiting_login" && state.url !== "about:blank" ? "signed_out" :
        state.diagnostics?.reason === "dialog_open" || state.status === "not_ready" ? "page_not_ready" : "checking";
      const detail = state.draft?.trim() ? "Login observation is preserving a draft. Send or remove it to allow the page refresh if login has not been detected." :
        monitor.error ? "ChatGPT is open, but its recent-chat data could not be recognized. Finish any challenge; a website change may require an adapter update." :
        state.status === "not_ready" ? "Waiting for the ChatGPT page or challenge to become ready. " + (state.detail || "") :
        "Waiting for ChatGPT login and fresh recent-chat data in this window. Login will be detected automatically.";
      if (chatGoalLoginDetail !== detail || chatGoalLoginStatus !== status) { chatGoalLoginDetail = detail; chatGoalLoginStatus = status; changed({ ui: ["settings"] }, "chat-goal-login-wait"); }
    })().catch(error => {
      if (shuttingDown || chatGoalLoginPage !== page) return;
      chatGoalLoginDetail = String(error?.message || error).slice(0, 500);
      if (chatGoalLoginStatus !== "closed") chatGoalLoginStatus = "error";
      chatGoalLoginStop();
      chatGoalConfigure();
    }).finally(() => {
      chatGoalLoginTask = null;
      if (!shuttingDown && !chatGoalLoginActive) changed({ ui: ["settings", "sessions"] }, "chat-goal-login-observed");
    });
    return chatGoalLoginTask;
  }
  async function chatGoalLogin() {
    if (chatGoalLoginBusy) throw new Error("ChatGPT login setup is already running.");
    chatGoalLoginBusy = true;
    chatGoalLoginStatus = "opening";
    chatGoalLoginDetail = "Opening the dedicated Chrome profile…";
    changed({ ui: ["settings"] }, "chat-goal-login-start");
    try {
      {
        chatGoalLoginStop();
        if (chatGoalLoginTask) await chatGoalLoginTask;
        chatGoalLoginActive = true;
        setCfg("chat_goal_login_verified_at", "0");
        chatGoalConfigure();
        // Drain the previous pass before giving the one shared tab to the user.
        if (chatGoalTask) await chatGoalTask;
        for (const context of all("SELECT * FROM contexts WHERE goal_text<>'' AND goal_status NOT IN ('disabled','expired','sending','delivery_uncertain')"))
          chatGoalState(context, "waiting_login", CHAT_GOAL_LOGIN_HINT, 0);
        const port = one("SELECT port FROM cdp_browsers WHERE browser=?", CHAT_GOAL_BROWSER)?.port;
        const version = port && await cdpVersion(Number(port)), saved = cdpBrowserOptions.get(CHAT_GOAL_BROWSER);
        if (saved && (cdpConnectionMode(saved) !== "local" || cdpPathKey(saved.user_data_dir) !== cdpPathKey(join(CDP_DIR, CHAT_GOAL_BROWSER))))
          throw new Error("The goals browser name is in use with a different profile or endpoint. It cannot be restarted for login.");
        // An explicit login request may restart this dedicated browser to expose
        // a window and images. Never close a draft, response or dialog to do so.
        if (version && (saved?.headless || saved?.images === false || /HeadlessChrome\//.test(version["User-Agent"] || ""))) {
          const record = await ensureCdpBrowser(saved ? CHAT_GOAL_BROWSER : { name: CHAT_GOAL_BROWSER, headless: true });
          const targetId = one("SELECT target_id FROM cdp_targets WHERE browser=? AND target='goals'", CHAT_GOAL_BROWSER)?.target_id;
          if (targetId && record.live_targets.has(targetId)) {
            const target = await cdpEnsureTarget(record, { name: "goals", initialize: false });
            const state = await chatGoalEvaluate({ record, ...target, login_setup: true }, "state");
            if (state.draft?.trim() || state.responding || state.diagnostics?.reason === "dialog_open" ||
                !["ready", "waiting_login"].includes(state.status) && state.url !== "about:blank" ||
                state.status === "waiting_login" && state.url !== "about:blank" && !state.url?.startsWith("https://chatgpt.com/"))
              throw new Error("The dedicated browser must restart for visible login. Finish its response, draft or dialog and try again; its profile is retained.");
          }
          await cdpInternal(record, "Browser.close");
          const deadline = Date.now() + 10000;
          while (await cdpVersion(Number(port))) {
            if (Date.now() >= deadline) throw new Error("The dedicated browser is still closing. Try Login ChatGPT again.");
            await sleep(100);
          }
          try { record.ws.close(); } catch {} cdpDisconnect(record);
        }
        const page = await chatGoalPage(null, true);
        await cdpInternal(page.record, "Target.activateTarget", { targetId: page.target_id });
        chatGoalLoginPage = page;
        chatGoalLoginRefresh = true;
        chatGoalLoginDetail = "Sign in or finish any challenge in the dedicated Chrome window. Login is detected automatically; automatic goals remain paused until then. If already signed in, the page may reload once unless it contains a draft.";
        chatGoalLoginStatus = "checking";
        chatGoalLoginTimer = setInterval(chatGoalLoginTick, 500);
        void chatGoalLoginTick();
      }
      return chatGoalLoginDetail;
    } catch (error) {
      chatGoalLoginDetail = String(error?.message || error).slice(0, 500);
      chatGoalLoginStatus = "error";
      chatGoalLoginStop();
      chatGoalConfigure();
      throw error;
    } finally {
      chatGoalLoginBusy = false;
      changed({ ui: ["sessions", "settings"] }, "chat-goal-login-finish");
    }
  }
  async function chatGoalNavigate(page, url, context) {
    if (url !== chatGoalUrl("") && !chatGoalChatId(url)) throw new Error("Invalid ChatGPT conversation URL");
    if (!chatGoalCurrent(context)) return null;
    const chatId = chatGoalChatId(url);
    if (page.record.goal_monitor) {
      page.record.goal_monitor.generation++;
      if (chatId) page.record.goal_monitor.histories.delete(chatId);
    }
    const navigation = await chatGoalRpc(page, "Page.navigate", { url });
    if (navigation.errorText) throw new Error(`ChatGPT navigation failed: ${navigation.errorText}`);
    const deadline = Date.now() + 15000;
    let lastState = null;
    while (Date.now() < deadline && chatGoalCurrent(context)) {
      const state = await chatGoalEvaluate(page, "state");
      lastState = state;
      if (state.status === "waiting_login") return state;
      if (state.url === url && (["ready", "busy"].includes(state.status) || state.responding)) return state;
      await sleep(250);
    }
    return chatGoalCurrent(context) && lastState ? { ...lastState, status: "not_ready", detail: lastState.detail || "ChatGPT DOM: the expected conversation did not become ready." } : null;
  }
  async function chatGoalFindChat(page, context) {
    const initial = await chatGoalEvaluate(page, "state");
    // Preserve user interaction; a response in another conversation does not own the shared tab.
    if (initial.status === "waiting_login" && !initial.url.startsWith("about:")) return { status: "waiting_login" };
    if (initial.draft?.trim()) return { status: "draft_present" };
    if (initial.diagnostics?.reason === "dialog_open") return { status: "error", detail: initial.detail };
    const state = await chatGoalNavigate(page, chatGoalUrl(""), context);
    if (!state) return { status: "error", detail: "ChatGPT did not become ready." };
    if (state.status === "waiting_login") return state;
    if (state.status === "not_ready") return { status: "error", detail: state.detail };
    let recent = await chatGoalEvaluate(page, "recent");
    if (!recent.urls?.length) { await sleep(500); recent = await chatGoalEvaluate(page, "recent"); }
    const monitor = page.record?.goal_monitor, listDeadline = Date.now() + 2000;
    while (monitor && !monitor.stopped && !monitor.list_at && Date.now() < listDeadline && chatGoalCurrent(context)) await sleep(100);
    const captured = monitor && !monitor.stopped ? [...monitor.recent.values()].sort((a, b) => b.updated - a.updated).map(item => item.id) : [];
    const ids = [...new Set([...captured, ...(recent.urls || []).map(chatGoalChatId).filter(Boolean)])].slice(0, 20), deadline = Date.now() + 90000;
    if (!ids.length) return { status: "not_found", detail: recent.detail };
    for (const id of ids) {
      if (!chatGoalCurrent(context) || toolCallGate || Date.now() >= deadline) return { status: "busy", detail: "Matching was interrupted or reached its time budget." };
      const loaded = await chatGoalNavigate(page, chatGoalUrl(id), context);
      if (loaded?.status === "waiting_login") return loaded;
      if (!loaded || !["ready", "busy"].includes(loaded.status)) continue;
      const captureDeadline = Math.min(deadline, Date.now() + 3000);
      while (monitor && !monitor.stopped && !monitor.histories.has(id) && Date.now() < captureDeadline && chatGoalCurrent(context) && !toolCallGate) await sleep(100);
      if (!chatGoalCurrent(context) || toolCallGate) return { status: "busy" };
      const history = monitor?.histories.get(id);
      if (history) {
        if (history.handles.has(context.handle)) return { status: "ready", chatId: id };
        continue;
      }
      for (let index = 0; index < 12; index++) {
        const result = await chatGoalEvaluate(page, "expand", { handle: context.handle, index });
        if (result.match && chatGoalChatId(result.url) === id) return { status: "ready", chatId: id };
        if (!result.expanded) break;
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(250);
          if (!chatGoalCurrent(context) || toolCallGate || Date.now() >= deadline) return { status: "busy" };
          const match = await chatGoalEvaluate(page, "match", { handle: context.handle });
          if (match.match && chatGoalChatId(match.url) === id) return { status: "ready", chatId: id };
        }
      }
    }
    return { status: "not_found", detail: monitor?.error || "No exact chat_session was found in captured active-branch calls or rendered tool details in the recent chats." };
  }
  function chatGoalBind(context, chatId) {
    if (!/^[a-z0-9-]{8,80}$/i.test(chatId) || !chatGoalCurrent(context)) return false;
    const newer = one("SELECT id FROM contexts WHERE chatgpt_chat_id=? AND goal_text<>'' AND (goal_updated_at>? OR (goal_updated_at=? AND id>?))",
      chatId, context.goal_updated_at, context.goal_updated_at, context.id);
    if (newer) { setChatGoal(context, "", context.goal_timeout_seconds); return false; }
    db.exec("BEGIN IMMEDIATE");
    try {
      disableOtherChatGoals(context.id, chatId);
      run("UPDATE contexts SET chatgpt_chat_id=?,goal_status='ready',goal_error='',goal_next_check_at=? WHERE id=? AND goal_revision=?",
        chatId, chatGoalDue(context), context.id, context.goal_revision);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    changed({ ui: ["sessions"] }, "chat-goal-linked");
    return true;
  }
  async function chatGoalSend(page, context, options = {}) {
    let inserted = false, attempted = false;
    const activity = value => [value.last_active_at, value.goal_activity_at, value.goal_updated_at, value.goal_last_sent_at].join(":");
    const canSend = value => value && !toolCallGate && (options.force ? activity(value) === activity(context) : chatGoalDue(value) <= Date.now());
    try {
      const initial = await chatGoalEvaluate(page, "state");
      if (initial.draft?.trim()) { chatGoalState(context, "draft_present", "The dedicated ChatGPT tab contains a draft; it was left untouched."); return; }
      if (initial.diagnostics?.reason === "dialog_open") { chatGoalState(context, "error", initial.detail); return; }
      if (initial.status === "waiting_login" && !initial.url.startsWith("about:")) {
        chatGoalState(context, "waiting_login", "Sign in to ChatGPT in the dedicated Chrome window."); return;
      }
      const url = chatGoalUrl(context.chatgpt_chat_id);
      // Discovery may already have opened this conversation. After a confirmed
      // send, another conversation's response must not block the next goal.
      let state = initial.url === url && (["ready", "busy"].includes(initial.status) || initial.responding)
        ? initial : await chatGoalNavigate(page, url, context);
      if (!state) throw new Error("ChatGPT did not become ready.");
      const stopBeforeSend = options.stop_before_send ?? (getCfg("chat_goal_stop_before_send", "0") === "1");
      if (stopBeforeSend) {
        const current = chatGoalCurrent(context);
        if (!canSend(current)) return;
        const stopped = await chatGoalEvaluate(page, "stop", { chatId: context.chatgpt_chat_id });
        if (!stopped.stop_ok) { chatGoalState(context, stopped.draft?.trim() ? "draft_present" : "error", stopped.detail || "ChatGPT Stop control is unavailable."); return; }
        const deadline = Date.now() + 5000;
        do {
          const current = chatGoalCurrent(context);
          if (!canSend(current)) return;
          state = await chatGoalEvaluate(page, "state");
          if (!state.responding && state.status === "ready") break;
          if (state.url !== url || state.status === "waiting_login" || state.draft?.trim() || state.diagnostics?.reason === "dialog_open") break;
          await sleep(100);
        } while (Date.now() < deadline);
        if (state.responding || state.status !== "ready") {
          chatGoalState(context, state.draft?.trim() ? "draft_present" : "error", "ChatGPT did not become ready after Stop; no prompt was sent."); return;
        }
      }
      if (!["ready", "busy"].includes(state.status)) { chatGoalState(context, state.status, state.detail || "ChatGPT's composer is unavailable."); return; }
      const focused = await chatGoalEvaluate(page, "focus", { chatId: context.chatgpt_chat_id });
      if (!focused.focused) { chatGoalState(context, focused.draft?.trim() ? "draft_present" : "error", focused.detail || "ChatGPT DOM: composer, conversation or message receipt identity is unavailable."); return; }
      const fresh = chatGoalCurrent(context);
      if (!canSend(fresh)) return;
      inserted = true;
      await chatGoalRpc(page, "Input.insertText", { text: context.goal_text });
      const beforeSend = chatGoalCurrent(context);
      if (!canSend(beforeSend)) return;
      // Commit before dispatch: a crash/uncertain acknowledgement must never cause an automatic duplicate.
      chatGoalState(context, "sending", "Waiting for ChatGPT to acknowledge the message.", 0);
      attempted = true;
      const sent = await chatGoalEvaluate(page, "send", { chatId: context.chatgpt_chat_id, text: context.goal_text, require_stopped: stopBeforeSend });
      if (!sent.sent) { attempted = false; chatGoalState(context, "error", sent.detail || "ChatGPT's submit control was unavailable; no message was sent."); return; }
      const previousIds = new Set(focused.users.map(user => user.id).filter(Boolean));
      for (let step = 0; step < 40 && chatGoalsEnabled() && !shuttingDown; step++) {
        const after = await chatGoalEvaluate(page, "state"), last = after.users?.at(-1);
        if (chatGoalChatId(after.url) === context.chatgpt_chat_id && !after.draft && last?.id && !previousIds.has(last.id) && last.text === context.goal_text) {
          if (chatGoalCurrent(context)) {
            const now = Date.now();
            run("UPDATE contexts SET goal_last_sent_at=?,goal_status='ready',goal_error='',goal_next_check_at=? WHERE id=? AND goal_revision=?",
              now, now + context.goal_timeout_seconds * 1000, context.id, context.goal_revision);
            changed({ ui: ["sessions"] }, "chat-goal-sent");
          }
          return;
        }
        await sleep(250);
      }
      chatGoalState(context, "delivery_uncertain", "The send was dispatched but could not be confirmed. Automatic sending is paused; inspect the conversation before setting the goal again.", 0);
    } catch (error) {
      chatGoalState(context, attempted ? "delivery_uncertain" : "error", attempted
        ? "The send outcome is uncertain. Automatic sending is paused; inspect the conversation before setting the goal again."
        : String(error?.message || error), attempted ? 0 : Date.now() + CHAT_GOAL_RETRY_MS);
    } finally {
      if (inserted && !attempted && chatGoalsEnabled() && !shuttingDown) await chatGoalEvaluate(page, "clear", { chatId: context.chatgpt_chat_id, text: context.goal_text }).catch(() => {});
    }
  }
  async function chatGoalRun(context) {
    context = chatGoalCurrent(context);
    if (!context || toolCallGate) return;
    const matchAttempt = context.chatgpt_chat_id ? null : context;
    if (matchAttempt) {
      if (context.goal_status !== "pending" || context.goal_next_check_at <= 0) return;
      // Consume the explicit request before opening Chrome. Failures, reloads
      // and restart must not silently create another matching attempt.
      chatGoalState(context, "matching", "Matching this Session to a recent ChatGPT conversation.", 0);
    }
    if (context.chatgpt_chat_id && chatGoalDue(context) > Date.now()) {
      chatGoalState(context, "ready", "", chatGoalDue(context)); return;
    }
    try {
      const page = await chatGoalPage(context);
      context = chatGoalCurrent(context);
      if (!context || toolCallGate) return;
      if (!context.chatgpt_chat_id) {
        const found = await chatGoalFindChat(page, context);
        if (!found.chatId) {
          chatGoalState(context, found.status, found.status === "waiting_login" ? "Sign in to ChatGPT in the dedicated Chrome window." : found.detail || "The dedicated ChatGPT tab is unavailable.");
          return;
        }
        if (!chatGoalBind(context, found.chatId)) return;
      }
      // Continue directly from association to delivery, using fresh activity
      // and revision state instead of waiting for another scheduler tick.
      context = chatGoalCurrent(context);
      if (!context || toolCallGate) return;
      if (chatGoalDue(context) > Date.now()) { chatGoalState(context, "ready", "", chatGoalDue(context)); return; }
      await chatGoalSend(page, context);
    } catch (error) { chatGoalState(context, "error", String(error?.message || error)); }
    finally {
      if (matchAttempt && !shuttingDown) {
        const interrupted = one("SELECT * FROM contexts WHERE id=? AND goal_revision=? AND goal_status='matching' AND chatgpt_chat_id='' AND goal_text<>''", matchAttempt.id, matchAttempt.goal_revision);
        if (interrupted) chatGoalState(interrupted, "error", "Matching was interrupted.", 0);
      }
    }
  }
  async function chatGoalDebug(context, { action = "status", stop_before_send } = {}) {
    if (!["status", "match", "send"].includes(action)) throw new Error("Unknown goal debug action");
    if (stop_before_send != null && (typeof stop_before_send !== "boolean" || action !== "send"))
      throw new Error("stop_before_send is a boolean override for action=send only");
    const view = (operationStatus = "inspected", detail) => {
      const fresh = one("SELECT * FROM contexts WHERE id=?", context.id);
      if (!fresh || contextExpired(fresh)) throw new Error("The chat Session is unavailable or expired");
      return { ...chatGoalView(fresh), action, operation_status: operationStatus, operation_detail: detail || null,
        enabled: chatGoalsEnabled(), login_ready: chatGoalLoginReady(),
        login_status: chatGoalLoginStatus || (chatGoalLoginReady() ? "authenticated" : "unknown"),
        chat_session_matched: !!fresh.chatgpt_chat_id, scheduler_busy: !!chatGoalTask,
        due_at: fresh.goal_text && fresh.chatgpt_chat_id ? chatGoalDue(fresh) : null };
    };
    if (action === "status") return view();
    if (!chatGoalsOperational()) return view("deferred", chatGoalsEnabled() ? CHAT_GOAL_LOGIN_HINT : "Goal management is disabled in Settings → Goals.");
    // A diagnostic action owns the same tab/pass lock as the background scheduler.
    while (chatGoalTask) await chatGoalTask;
    context = one("SELECT * FROM contexts WHERE id=?", context.id);
    if (!context || contextExpired(context)) throw new Error("The chat Session is unavailable or expired");
    if (!context.goal_text) return view("deferred", "Set a nonempty goal with chat_set_goal first.");
    if (["sending", "delivery_uncertain"].includes(context.goal_status)) return view("deferred", "Inspect the previous delivery and explicitly rearm with chat_set_goal before another debug action.");
    if (action === "send" && !context.chatgpt_chat_id) return view("deferred", "Match this Session first; no goal is sent to an unassociated conversation.");
    if (!chatGoalsOperational() || toolCallGate || shuttingDown) return view("deferred", "Goal work is paused or maintenance is active.");
    run("UPDATE contexts SET goal_revision=goal_revision+1 WHERE id=?", context.id);
    context = one("SELECT * FROM contexts WHERE id=?", context.id);
    let outcome = "deferred", detail = "The action was cancelled or deferred by the normal goal checks.";
    const task = (async () => {
      try {
        if (action === "match") chatGoalState(context, "matching", "Matching requested by chat_goal_debug.", 0);
        const page = await chatGoalPage(context);
        if (!chatGoalCurrent(context) || toolCallGate) return;
        if (action === "match") {
          const found = await chatGoalFindChat(page, context);
          if (found.chatId && chatGoalBind(context, found.chatId)) { outcome = "matched"; detail = "An exact chat_session tool call confirmed the association. No prompt was sent."; }
          else if (chatGoalCurrent(context)) {
            chatGoalState(context, found.status || "not_found", found.detail || "No exact chat_session match was found.");
            outcome = "not_found"; detail = found.detail || "The matching attempt did not find this Session.";
          }
        } else {
          await chatGoalSend(page, context, { force: true, stop_before_send });
          const fresh = one("SELECT * FROM contexts WHERE id=?", context.id);
          if (fresh?.goal_last_sent_at > context.goal_last_sent_at) { outcome = "sent"; detail = "The usual UI acknowledgement confirmed submission and reset the inactivity interval."; }
          else if (fresh?.goal_error) { detail = fresh.goal_error; if (["error", "delivery_uncertain"].includes(fresh.goal_status)) outcome = "failed"; }
        }
      } catch (error) {
        chatGoalState(context, "error", String(error?.message || error));
        outcome = "failed"; detail = String(error?.message || error).slice(0, 500);
      } finally {
        const interrupted = one("SELECT * FROM contexts WHERE id=? AND goal_revision=? AND goal_status='matching'", context.id, context.goal_revision);
        if (interrupted) chatGoalState(interrupted, "error", "The debug matching attempt was interrupted.", 0);
      }
    })();
    chatGoalTask = task;
    try { await task; }
    finally { if (chatGoalTask === task) chatGoalTask = null; }
    return view(outcome, detail);
  }
  function chatGoalTick() {
    if (!chatGoalsOperational() || shuttingDown || toolCallGate || chatGoalTask) return chatGoalTask;
    chatGoalTask = (async () => {
      const rows = all("SELECT * FROM contexts WHERE goal_text<>'' AND goal_status NOT IN ('sending','delivery_uncertain','expired') AND (chatgpt_chat_id<>'' OR (goal_status='pending' AND goal_next_check_at>0)) AND goal_next_check_at<=? ORDER BY goal_next_check_at,id", Date.now());
      for (const context of rows) {
        if (!chatGoalsOperational() || shuttingDown || toolCallGate) break;
        if (contextExpired(context)) { chatGoalState(context, "expired", "The chat Session has expired.", 0); continue; }
        await chatGoalRun(context);
      }
    })().catch(error => { if (!shuttingDown) console.error("Chat goal scheduler:", String(error?.message || error)); }).finally(() => { chatGoalTask = null; });
    return chatGoalTask;
  }
  // Compile the package's public XPath helpers into one native request, preserving
  // MrMCP ids, raw responses, wait=false and logical method names in the ring.
  const cdpExtensionCompiler = new cdp.cdp();
  cdpExtensionCompiler.call = request => request;
  function cdpExtensionRequest(method, params = {}) {
    if (method !== "_.click" && method !== "_.find") throw new Error(`Unknown CDP extension method: ${method}`);
    const validated = { ...params, xpath: String(params.xpath || ""), target: "page" };
    if (!validated.xpath) throw new Error(`${method} requires params.xpath`);
    if (method === "_.click") {
      validated.attempts = Math.max(1, Math.min(Number(params.attempts || 5), 20));
      validated.interval_ms = Math.max(0, Math.min(Number(params.interval_ms ?? 300), 5000));
      if (!Number.isInteger(validated.attempts) || !Number.isInteger(validated.interval_ms)) throw new Error("_.click attempts/interval_ms must be integers");
    } else {
      validated.limit = Math.max(1, Math.min(Number(params.limit || 20), 100));
      if (!Number.isInteger(validated.limit)) throw new Error("_.find limit must be an integer");
    }
    const request = cdpExtensionCompiler.custom_methods[method].call(cdpExtensionCompiler, validated);
    const { browser: _browser, target: _target, ...native } = request.params;
    return { wire_method: request.method, logical_method: method, params: native };
  }
  const cdpPollMatches = (message, filters) => {
    if (filters.type && filters.type !== "all" && message.type !== filters.type) return false;
    if (filters.id != null && Number(message.id) !== Number(filters.id)) return false;
    if (filters.target && message.target !== filters.target) return false;
    return cdpMethodMatches(String(message.method || ""), filters.methods, filters.method_prefixes);
  };
  function cdpSubscriptionOutput(subscription) {
    return {
      subscription: subscription.id, browser: subscription.browser, targets: [...subscription.targets],
      methods: [...subscription.methods], method_prefixes: [...subscription.method_prefixes], include_browser: subscription.include_browser,
      regex: subscription.regex_source || "", regex_flags: subscription.regex_flags || "",
      cursor: subscription.cursor, dropped: subscription.dropped, stream_resets: subscription.stream_resets,
    };
  }
  function cdpSubscriptionRegex(source, flags = "") {
    source = String(source || ""); flags = String(flags || "");
    if (!source) return null;
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error("CDP subscription regex_flags may contain each of i,m,s,u at most once");
    try { return new RegExp(source, flags); }
    catch (error) { throw new Error(`Invalid CDP subscription regex: ${String(error?.message || error)}`); }
  }
  function cdpCreateSubscription(record, args) {
    const id = `cdpsub_${randomToken(18)}`;
    const targets = [...new Set((args.targets || []).map(value => String(value) === "*" ? "*" : cdpTargetName(value)))];
    const methods = [...new Set((args.methods || []).map(value => String(value).trim()).filter(Boolean))];
    const methodPrefixes = [...new Set((args.method_prefixes || []).map(value => String(value).trim()).filter(Boolean))];
    const regexSource = String(args.regex || ""), regexFlags = String(args.regex_flags || ""), regex = cdpSubscriptionRegex(regexSource, regexFlags);
    const subscription = {
      id, browser: record.browser, targets, methods, method_prefixes: methodPrefixes, regex_source: regexSource, regex_flags: regexFlags, regex,
      include_browser: args.include_browser == null ? !targets.length : !!args.include_browser,
      cursor: cdpBrowserSequences.get(record.browser) || 0,
      dropped: 0, stream_resets: 0, connection_id: record.connection_id,
    };
    cdpSubscriptions.set(id, subscription);
    return subscription;
  }
  async function cdpProcessScreenshot(raw, options, requestParams = {}) {
    if (!raw?.result?.data || raw?.error) return { cdp: raw, image: null };
    const requestedFormat = String(options?.format || "original"), scale = Number(options?.scale ?? 1), quality = Number(options?.quality ?? 80);
    const originalFormat = String(requestParams?.format || "png").toLowerCase() === "jpeg" ? "jpeg"
      : String(requestParams?.format || "png").toLowerCase() === "webp" ? "webp" : "png";
    let bytes = Buffer.from(String(raw.result.data), "base64"), format = originalFormat;
    if (requestedFormat === "webp") {
      if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("_image.scale must be >0 and <=4");
      if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("_image.quality must be an integer from 1 to 100");
      if (quality !== 80) throw new Error("_image.quality currently must be 80: the public Auto.js auto.vips encoder uses WebP Q=80");
      if (!['png', 'webp'].includes(originalFormat)) throw new Error("The public Auto.js auto.vips API can post-process PNG/WebP screenshots; request Page.captureScreenshot format=png or webp before _image.format=webp");
      const { decodeImage, encodeImage } = await loadAutoVips();
      const decoded = await decodeImage(bytes, {}, false, originalFormat);
      bytes = Buffer.from(encodeImage(decoded, "webp", scale));
      format = "webp";
    } else if (requestedFormat !== "original") throw new Error("_image.format must be original or webp");
    const mime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
    return {
      cdp: { ...raw, result: { ...raw.result, data: bytes.toString("base64") } },
      image: { encoding: "base64", format, mime_type: mime, bytes: bytes.length, scale: requestedFormat === "webp" ? scale : 1, quality: requestedFormat === "webp" ? quality : null },
    };
  }
  async function cdpSubs(args) {
    const { browser } = cdpBrowserSpec(args.browser);
    if (args.add === undefined && args.remove === undefined) throw new Error("cdp_subs requires add and/or remove");
    if (typeof args.add === "string" && args.add !== "*") throw new Error("cdp_subs add string must be '*'");
    if (typeof args.remove === "string" && args.remove !== "*") throw new Error("cdp_subs remove string must be '*'");
    const removed = [], missing = [];
    if (args.remove === "*") {
      for (const [id, subscription] of [...cdpSubscriptions]) if (subscription.browser === browser) {
        cdpSubscriptions.delete(id); removed.push(id);
      }
    } else for (const raw of Array.isArray(args.remove) ? args.remove : []) {
      const id = String(raw || ""), subscription = cdpSubscriptions.get(id);
      if (subscription?.browser === browser) { cdpSubscriptions.delete(id); removed.push(id); }
      else missing.push(id);
    }
    const additions = args.add === "*"
      ? [{ targets: ["*"], methods: ["*"], include_browser: true }]
      : Array.isArray(args.add) ? args.add : [];
    const added = [];
    if (additions.length) {
      const record = await ensureCdpBrowser(args.browser);
      for (const spec of additions) added.push(cdpSubscriptionOutput(cdpCreateSubscription(record, spec || {})));
    }
    const subscriptions = [...cdpSubscriptions.values()].filter(subscription => subscription.browser === browser).map(cdpSubscriptionOutput);
    return { browser, added, removed, missing, subscriptions };
  }
  async function cdpPoll(args) {
    const limit = Math.max(1, Math.min(Number(args.limit || 50), 200));
    let subscription = null, record;
    if (args.subscription) {
      subscription = cdpSubscriptions.get(String(args.subscription));
      if (!subscription) throw new Error("Unknown or expired CDP subscription");
      if (args.browser !== undefined && cdpBrowserSpec(args.browser).browser !== subscription.browser)
        throw new Error("browser must name the selected subscription's browser");
      record = await ensureCdpBrowser(args.browser ?? subscription.browser);
      if (subscription.connection_id !== record.connection_id) {
        subscription.connection_id = record.connection_id;
        subscription.cursor = record.start_seq;
        subscription.stream_resets += 1;
      }
    } else {
      record = await ensureCdpBrowser(args.browser);
    }
    const filters = {
      type: String(args.type || "all"), id: args.id == null ? null : Number(args.id),
      target: args.target ? cdpTargetName(args.target) : "",
      methods: (args.methods || []).map(value => String(value).trim()).filter(Boolean),
      method_prefixes: (args.method_prefixes || []).map(value => String(value).trim()).filter(Boolean),
    };
    let messages = [];
    const ringHead = Number(record.ring_head || 0);
    if (subscription) {
      let scannedTo = subscription.cursor;
      for (let index = ringHead; index < record.ring.length; index++) {
        const message = record.ring[index];
        if (message.seq <= subscription.cursor) continue;
        scannedTo = message.seq;
        if (!cdpSubscriptionMatches(subscription, message) || !cdpPollMatches(message, filters)) continue;
        messages.push(cdpPublicMessage(message));
        if (messages.length >= limit) break;
      }
      if (args.advance !== false) subscription.cursor = scannedTo || (cdpBrowserSequences.get(record.browser) || subscription.cursor);
    } else {
      for (let index = record.ring.length - 1; index >= ringHead && messages.length < limit; index--) {
        const message = record.ring[index];
        if (cdpPollMatches(message, filters)) messages.push(cdpPublicMessage(message));
      }
      messages.reverse();
    }
    return {
      browser: record.browser, subscription: subscription?.id || null, messages,
      cursor: subscription?.cursor ?? null, dropped: subscription?.dropped ?? record.dropped,
      stream_resets: subscription?.stream_resets ?? 0,
      oldest_seq: cdpRingOldest(record)?.seq ?? null,
      newest_seq: cdpRingNewest(record)?.seq ?? null,
    };
  }

  const MEMORY_VALUE_MAX_BYTES = 1024 * 1024;
  const GLOBAL_MEMORY_STORAGE_SCOPE = "workspace", GLOBAL_MEMORY_OWNER_ID = 0, GLOBAL_MEMORY_OWNER_NAME = "Global";
  const memoryStorageScope = scope => scope === "global" ? GLOBAL_MEMORY_STORAGE_SCOPE : scope;
  const memoryPublicScope = row => String(row?.scope || "") === GLOBAL_MEMORY_STORAGE_SCOPE && Number(row?.owner_id) === GLOBAL_MEMORY_OWNER_ID
    ? "global" : String(row?.scope || "");
  function memoryOwnerSummary(scope, ownerId) {
    const storageScope = memoryStorageScope(scope), storageOwnerId = scope === "global" ? GLOBAL_MEMORY_OWNER_ID : Number(ownerId);
    const count = Number(one("SELECT COUNT(*) n FROM memories WHERE scope=? AND owner_id=?", storageScope, storageOwnerId)?.n || 0);
    const latestKeys = all("SELECT key FROM memories WHERE scope=? AND owner_id=? ORDER BY set_at DESC,id DESC LIMIT 5", storageScope, storageOwnerId)
      .map(row => String(row.key));
    return { count, latest_keys: latestKeys };
  }
  const memoryPurgeExpired = (now = Date.now()) => {
    const result = statement("DELETE FROM memories WHERE expires_at>0 AND expires_at<=?").run(now);
    if (Number(result.changes || 0)) emitUiChange(["memory"], "memory-expired");
    return Number(result.changes || 0);
  };
  const memoryScopeOwner = (p, selection, rawScope, rawWorkspace = "") => {
    const scope = String(rawScope || "").trim();
    if (!['global', 'session', 'workspace'].includes(scope)) throw new Error("memory scope must be global, session or workspace");
    const workspace = String(rawWorkspace || "").trim();
    if (scope === "global") {
      if (workspace) throw new Error("workspace must be omitted for global memory");
      return { scope, storage_scope: GLOBAL_MEMORY_STORAGE_SCOPE, owner_id: GLOBAL_MEMORY_OWNER_ID, owner_name: GLOBAL_MEMORY_OWNER_NAME, workspace: null, session_id: null };
    }
    if (scope === "session") {
      if (workspace) throw new Error("workspace must be omitted for session memory");
      return { scope, storage_scope: "session", owner_id: Number(selection.context.id), owner_name: `Session #${selection.context.id}`, workspace: null, session_id: Number(selection.context.id) };
    }
    if (!workspace) throw new Error("workspace is required for workspace memory");
    const root = one("SELECT id,name FROM roots WHERE server_id=? AND name=?", p.id, workspace);
    if (!root) throw new Error(`Workspace not found: ${workspace}`);
    return { scope, storage_scope: "workspace", owner_id: Number(root.id), owner_name: String(root.name), workspace: String(root.name), session_id: null };
  };
  const memoryPublicRow = row => {
    const isJson = Number(row.is_json ?? 1) === 1, raw = String(row.value_json ?? ""), scope = memoryPublicScope(row);
    return {
      id: Number(row.id), scope,
      session_id: scope === "session" ? Number(row.owner_id) : null,
      workspace: scope === "workspace" ? String(row.owner_name || "") : null,
      key: String(row.key), json: isJson, value: isJson ? parseJson(raw, null) : raw, ttl_seconds: Number(row.ttl_seconds || 0),
      set_at: new Date(Number(row.set_at)).toISOString(),
      expires_at: Number(row.expires_at || 0) ? new Date(Number(row.expires_at)).toISOString() : null,
    };
  };
  const memoryOwnerFromRow = row => {
    const scope = memoryPublicScope(row);
    return {
      scope, storage_scope: String(row.scope), owner_id: Number(row.owner_id),
      owner_name: scope === "global" ? GLOBAL_MEMORY_OWNER_NAME : String(row.owner_name),
      workspace: scope === "workspace" ? String(row.owner_name) : null,
      session_id: scope === "session" ? Number(row.owner_id) : null,
    };
  };
  function memorySetValue(p, selection, args, options = {}) {
    memoryPurgeExpired();
    const owner = options.owner || memoryScopeOwner(p, selection, args.scope, args.workspace);
    const key = String(args.key ?? "").trim();
    if (!key || key.length > 512 || /[\x00-\x1f\x7f]/.test(key)) throw new Error("memory key must be 1-512 characters without control characters");
    const ttlSeconds = Math.max(0, Number(args.ttl_seconds || 0));
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds > 315360000) throw new Error("ttl_seconds must be an integer from 0 to 315360000");
    const storageScope = owner.storage_scope || memoryStorageScope(owner.scope);
    if (args.delete === true) {
      const result = run("DELETE FROM memories WHERE scope=? AND owner_id=? AND key=?", storageScope, owner.owner_id, key);
      if (Number(result.changes || 0)) changed({ ui: ["memory"] }, "memory-delete");
      return { memory: null, deleted: Number(result.changes || 0) > 0 };
    }
    if (!Object.prototype.hasOwnProperty.call(args, "value")) throw new Error("memory_set requires value unless delete=true");
    if (args.json !== true && args.json !== false) throw new Error("memory_set requires explicit json=true or json=false when setting a value");
    const valueJson = String(args.value);
    if (args.json) {
      try { JSON.parse(valueJson); }
      catch (error) { throw new Error(`memory_set json=true requires valid JSON text: ${String(error?.message || error)}`); }
    }
    if (enc.encode(valueJson).byteLength > MEMORY_VALUE_MAX_BYTES) throw new Error("memory value exceeds the 1 MiB limit");
    const setAt = Date.now(), expiresAt = ttlSeconds ? setAt + ttlSeconds * 1000 : 0;
    if (options.replace_id) run("DELETE FROM memories WHERE id=?", Number(options.replace_id));
    run("DELETE FROM memories WHERE scope=? AND owner_id=? AND key=?", storageScope, owner.owner_id, key);
    const inserted = run("INSERT INTO memories(scope,owner_id,owner_name,key,value_json,is_json,ttl_seconds,set_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      storageScope, owner.owner_id, owner.owner_name, key, valueJson, args.json ? 1 : 0, ttlSeconds, setAt, expiresAt);
    const row = one("SELECT * FROM memories WHERE id=?", Number(inserted.lastInsertRowid));
    changed({ ui: ["memory"] }, "memory-set");
    return { memory: memoryPublicRow(row), deleted: false };
  }
  const telegramChatMigrations = new Map();
  async function telegramRequest(args) {
    const token = String(getCfg("telegram_bot_token", "") || "").trim();
    if (!token) throw new Error("Telegram Bot token is not configured on the Telegram page");
    const request = { ...(args.request || {}) }, method = String(request.method || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method)) throw new Error("telegram_req request.method is required and must be a Bot API method name");
    delete request.method;
    const migrationKey = value => `${token.slice(0, 8)}:${String(value)}`;
    if (typeof request.chat_id === "string" && /^-?\d+$/.test(request.chat_id)) {
      const numeric = Number(request.chat_id);
      if (Number.isSafeInteger(numeric)) request.chat_id = numeric;
    }
    if (request.chat_id != null && telegramChatMigrations.has(migrationKey(request.chat_id)))
      request.chat_id = telegramChatMigrations.get(migrationKey(request.chat_id));
    const send = async () => {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      });
      let body;
      try { body = await response.json(); }
      catch { throw new Error(`Telegram Bot API returned non-JSON HTTP ${response.status}`); }
      return body;
    };
    let response = await send(), migrated = null;
    const migrateTo = response?.ok === false ? response?.parameters?.migrate_to_chat_id : null;
    if (migrateTo != null && request.chat_id != null) {
      const old = request.chat_id;
      telegramChatMigrations.set(migrationKey(old), migrateTo);
      request.chat_id = migrateTo;
      migrated = { from: old, to: migrateTo };
      response = await send();
    }
    return { method, response, migrated_chat_id: migrated };
  }

  function memoryFindRows(p, selection, args) {
    memoryPurgeExpired();
    const rawScope = args.scope;
    const scopes = rawScope === "*"
      ? ["global", "session", "workspace"]
      : Array.isArray(rawScope) ? rawScope.map(value => String(value).trim()) : [String(rawScope || "").trim()];
    if (!scopes.length || scopes.some(scope => !["global", "session", "workspace"].includes(scope)) || new Set(scopes).size !== scopes.length)
      throw new Error("memory_find scope must be '*', one scope, or a unique array of global/session/workspace scopes");
    const workspace = String(args.workspace || "").trim();
    if (workspace && !scopes.includes("workspace")) throw new Error("workspace requires workspace scope");
    const ownerConditions = [], ownerValues = [];
    if (scopes.includes("global")) ownerConditions.push("(scope='workspace' AND owner_id=0)");
    if (scopes.includes("session")) {
      ownerConditions.push("(scope='session' AND owner_id=?)");
      ownerValues.push(Number(selection.context.id));
    }
    if (scopes.includes("workspace")) {
      if (workspace) {
        const root = one("SELECT id,name FROM roots WHERE server_id=? AND name=?", p.id, workspace);
        if (!root) throw new Error(`Workspace not found: ${workspace}`);
        ownerConditions.push("(scope='workspace' AND owner_id=?)");
        ownerValues.push(Number(root.id));
      } else { ownerConditions.push("(scope='workspace' AND owner_id IN (SELECT id FROM roots WHERE server_id=?))"); ownerValues.push(p.id); }
    }
    const limit = Math.max(1, Math.min(Number(args.limit || 20), 100));
    const conditions = [`(${ownerConditions.join(" OR ")})`], values = [...ownerValues];
    const key = String(args.key || ""), keyPrefix = String(args.key_prefix || ""), query = String(args.query || "");
    const regex = args.regex === true, caseSensitive = args.case_sensitive === true;
    if (key) { conditions.push("key=?"); values.push(key); }
    if (keyPrefix) { conditions.push("substr(key,1,length(?))=?"); values.push(keyPrefix, keyPrefix); }
    if (args.set_after) {
      const value = Date.parse(String(args.set_after));
      if (!Number.isFinite(value)) throw new Error("set_after must be an ISO date/time");
      conditions.push("set_at>=?"); values.push(value);
    }
    if (args.set_before) {
      const value = Date.parse(String(args.set_before));
      if (!Number.isFinite(value)) throw new Error("set_before must be an ISO date/time");
      conditions.push("set_at<=?"); values.push(value);
    }
    const beforeId = args.before_id == null ? null : Math.max(1, Number(args.before_id));
    if (!regex) {
      if (query) {
        conditions.push(caseSensitive
          ? "instr(key||char(10)||value_json,?)>0"
          : "instr(lower(key||char(10)||value_json),lower(?))>0");
        values.push(query);
      }
      if (beforeId != null) { conditions.push("id<?"); values.push(beforeId); }
      const rows = all(`SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...values, limit + 1);
      const page = rows.slice(0, limit), hasMore = rows.length > limit;
      return { memories: page.map(memoryPublicRow), next_before_id: hasMore && page.length ? Number(page.at(-1).id) : null };
    }
    let matcher;
    try { matcher = new RegExp(query, caseSensitive ? "" : "i"); }
    catch (error) { throw new Error(`memory_find query regex is invalid: ${String(error?.message || error)}`); }
    const matched = [], batchSize = 500;
    let scanBefore = beforeId;
    while (matched.length < limit + 1) {
      const scanConditions = [...conditions], scanValues = [...values];
      if (scanBefore != null) { scanConditions.push("id<?"); scanValues.push(scanBefore); }
      const rows = all(`SELECT * FROM memories WHERE ${scanConditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...scanValues, batchSize);
      if (!rows.length) break;
      for (const row of rows) {
        if (matcher.test(`${String(row.key)}\n${String(row.value_json ?? "")}`)) matched.push(row);
        if (matched.length >= limit + 1) break;
      }
      scanBefore = Number(rows.at(-1).id);
      if (rows.length < batchSize) break;
    }
    const page = matched.slice(0, limit), hasMore = matched.length > limit;
    return { memories: page.map(memoryPublicRow), next_before_id: hasMore && page.length ? Number(page.at(-1).id) : null };
  }

  let toolCallGate = null, toolCallsIdle = Promise.resolve(), resolveToolCallsIdle = null,
    maintenanceAction = "", maintenancePhase = "", waitingToolCalls = 0,
    headerActivityTimer = null, activeToolCallTimer = null;

  const maintenanceProjection = () => ({
    active: !!toolCallGate, action: maintenanceAction, phase: maintenancePhase,
    in_flight: activeCallControls.size, waiting: waitingToolCalls,
  });
  const emitMaintenance = () => emitUiChange(["dashboard", "settings", "logs", "sessions", "roots", "oauth"], "maintenance");
  const emitToolCallActivity = () => emitUiChange(["state"], "tool-call-activity");
  function toolCallLogPage(id, pageSize = uiState.logs.pageSize) {
    const row = one("SELECT id,started_at FROM logs WHERE id=?", Math.max(0, Number(id) || 0));
    if (!row) return 1;
    const newer = one(`SELECT COUNT(*) n FROM logs
      WHERE started_at>? OR (started_at=? AND id>?)`, row.started_at, row.started_at, row.id)?.n || 0;
    return Math.floor(newer / Math.max(1, Number(pageSize) || 25)) + 1;
  }
  function activeToolCallsProjection(p) {
    const now = Date.now(), cutoff = now - ACTIVE_TOOL_CALL_TTL_MS;
    const rows = all(`SELECT l.id,l.started_at,l.completed_at,l.context_id,l.tool,l.status,l.duration_ms,l.mcp_request_json,l.progress_requested,l.payload_mode,l.storage
      FROM logs l
      WHERE l.server_id=? AND (l.status IN ('received','running') OR l.completed_at>=?)
      ORDER BY l.started_at DESC`, p.id, cutoff).map(row => {
      const active = !row.completed_at && ["received", "running"].includes(row.status);
      return {
        id: Number(row.id), started_at: Number(row.started_at), context_id: Number(row.context_id) || 0, tool: row.tool, status: row.status,
        call_summary: compactToolCallSummary(p, row.tool, mcpToolArgsFromPacket(row.mcp_request_json)),
        progress_requested: !!row.progress_requested, payload_mode: String(row.payload_mode || "payload"), storage: String(row.storage || "disk"), active,
        elapsed_ms: Math.max(0, (active ? now : Number(row.completed_at || now)) - Number(row.started_at || now)),
        completed_age_ms: active ? null : Math.max(0, now - Number(row.completed_at || now)),
        ttl_ms: active ? null : Math.max(0, Number(row.completed_at || now) + ACTIVE_TOOL_CALL_TTL_MS - now),
      };
    });
    if (activeToolCallTimer) clearTimeout(activeToolCallTimer);
    activeToolCallTimer = null;
    if (rows.length && uiRenderConnected) {
      const expiries = rows.filter(row => !row.active).map(row => now + Number(row.ttl_ms || 0));
      const next = Math.min(rows.some(row => row.active) ? now + 1000 : Infinity, ...expiries, Infinity);
      if (Number.isFinite(next)) activeToolCallTimer = setTimeout(() => {
        activeToolCallTimer = null;
        emitUiChange(["processes"], "active-tool-call-tick");
      }, Math.max(50, next - now + 10));
    }
    return rows;
  }
  function headerActivityProjection(p) {
    const now = Date.now(), rows = all(`
      WITH recent AS (
        SELECT l.context_id,MAX(l.started_at) last_at
        FROM logs l JOIN contexts c ON c.id=l.context_id AND c.server_id=l.server_id
        WHERE l.server_id=? AND l.started_at>=? AND l.context_id>0
        GROUP BY l.context_id
      )
      SELECT r.context_id,r.last_at,
        (SELECT COUNT(*) FROM logs x WHERE x.server_id=? AND x.context_id=r.context_id) tool_calls
      FROM recent r ORDER BY r.last_at DESC
    `, p.id, now - SESSION_ACTIVE_MS, p.id).map(row => ({
      ...row, tool_calls: Number(row.tool_calls || 0), last_at: Number(row.last_at || 0),
    }));
    if (headerActivityTimer) clearTimeout(headerActivityTimer);
    headerActivityTimer = null;
    if (rows.length && uiRenderConnected) {
      const nextExpiry = Math.min(...rows.map(row => Number(row.last_at) + SESSION_ACTIVE_MS));
      headerActivityTimer = setTimeout(() => {
        headerActivityTimer = null;
        emitUiChange(["state"], "header-activity-expired");
      }, Math.max(50, nextExpiry - now + 10));
    }
    const toolCalls = toolCallAggregates(p);
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
      flushDeferredLogWork();
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
  function deleteToolCallRecords() {
    const cleared = { tool_calls: one("SELECT COUNT(*) n FROM logs")?.n || 0 };
    statement("DELETE FROM tool_call_descriptors_memory").run();
    statement("DELETE FROM logs_memory").run();
    statement("DELETE FROM main.tool_call_descriptors").run();
    statement("DELETE FROM main.tool_descriptors").run();
    if (fts) { statement("DELETE FROM main.logs_fts").run(); statement("DELETE FROM logs_fts_memory").run(); }
    statement("DELETE FROM main.logs").run();
    descriptorIdCache.clear();
    return cleared;
  }
  function deleteToolCallRecordById(id) {
    const logId = Math.max(0, Number(id) || 0), row = one("SELECT storage FROM logs WHERE id=?", logId);
    if (!row) return false;
    if (row.storage === "memory") {
      if (fts) statement("DELETE FROM logs_fts_memory WHERE rowid=?").run(logId);
      statement("DELETE FROM tool_call_descriptors_memory WHERE log_id=?").run(logId);
      statement("DELETE FROM logs_memory WHERE id=?").run(logId);
    } else {
      if (fts) statement("DELETE FROM main.logs_fts WHERE rowid=?").run(logId);
      statement("DELETE FROM main.logs WHERE id=?").run(logId);
      statement("DELETE FROM main.tool_descriptors WHERE NOT EXISTS (SELECT 1 FROM main.tool_call_descriptors calls WHERE calls.descriptor_id=main.tool_descriptors.id)").run();
    }
    invalidateToolCallHistoryCaches("tool-call-delete");
    return true;
  }
  function deleteDebugLogRecords() {
    const count = one("SELECT COUNT(*) n FROM debug_logs")?.n || 0;
    db.prepare("DELETE FROM debug_log_workspaces").run();
    db.prepare("DELETE FROM debug_logs").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name='debug_logs'").run();
    return count;
  }
  function resetToolCallUi() {
    uiState.logs.page = 1;
    uiState.logs.openRowId = "";
    uiState.logs.selfTest = null;
  }
  async function clearToolCalls() {
    return await withToolCallsDrained("tool-calls", () => {
      db.exec("BEGIN IMMEDIATE");
      let cleared;
      try {
        cleared = deleteToolCallRecords();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      for (const [id, record] of processes)
        if (!["starting", "running"].includes(record.status)) processes.delete(id);
      resetToolCallUi();
      emitUiChange(["dashboard", "logs", "sessions", "roots", "settings"], "tool-calls-clear");
      return { ok: true, cleared };
    });
  }
  async function clearSessions() {
    return await withToolCallsDrained("sessions", async () => {
      const p = serverConfig(), rows = all("SELECT id,handle FROM contexts WHERE server_id=?", p.id);
      const handles = new Set(rows.map(row => row.handle));
      for (const record of processes.values())
        if (record.persistent && handles.has(record.context_handle) && ["starting", "running"].includes(record.status))
          await terminateProcess(record, "SIGTERM", "user");
      run("DELETE FROM contexts WHERE server_id=?", p.id);
      for (const key of [...jsKernels.keys()])
        if (key.startsWith(`${p.id}:`)) destroyJsKernel(key, "sessions cleared");
      uiState.sessions.oauthClientId = "";
      uiState.logs.context = "";
      emitUiChange(["dashboard", "sessions", "roots", "logs", "oauth"], "sessions-clear");
      return { ok: true, cleared: rows.length };
    });
  }
  function clearWorkspaces() {
    const p = serverConfig(), count = one("SELECT COUNT(*) n FROM roots WHERE server_id=?", p.id)?.n || 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      run("UPDATE contexts SET root_id=0,updated_at=? WHERE server_id=?", Date.now(), p.id);
      run("DELETE FROM roots WHERE server_id=?", p.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emitUiChange(["dashboard", "sessions", "roots"], "workspaces-clear");
    return { ok: true, cleared: count };
  }
  function clearOAuthClients() {
    const count = one("SELECT COUNT(*) n FROM oauth_clients")?.n || 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM oauth_tokens").run();
      db.prepare("DELETE FROM oauth_refresh_tokens").run();
      db.prepare("DELETE FROM oauth_codes").run();
      db.prepare("DELETE FROM oauth_clients").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    oauthConsents.clear();
    emitUiChange(["dashboard", "oauth", "sessions"], "clients-clear");
    return { ok: true, cleared: count };
  }
  async function clearOperationalDatabase() {
    return await withToolCallsDrained("database", async () => {
      const cleared = {
        tool_calls: one("SELECT COUNT(*) n FROM logs")?.n || 0,
        process_runs: one("SELECT COUNT(*) n FROM main.process_runs WHERE status NOT IN ('starting','running')")?.n || 0,
        http_logs: one("SELECT COUNT(*) n FROM debug_logs")?.n || 0,
        published: one("SELECT COUNT(*) n FROM published")?.n || 0,
        requests: requestMetricValue,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteToolCallRecords();
        db.prepare("DELETE FROM main.process_runs WHERE status NOT IN ('starting','running')").run();
        deleteDebugLogRecords();
        db.prepare("DELETE FROM published").run();
        db.prepare("UPDATE metrics SET value=0").run();
        db.exec("COMMIT");
        resetRequestMetric();
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // SQLite's VACUUM recreates main indexes by name; the TEMP logs view otherwise shadows main.logs.
      db.exec("DROP VIEW temp.logs");
      try { db.exec("VACUUM"); }
      finally { db.exec(toolCallLogViewSql); statementCache.clear(); }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await Deno.remove(PUBLISH_DIR, { recursive: true }).catch(error => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      Deno.mkdirSync(PUBLISH_DIR, { recursive: true });
      for (const [id, record] of processes)
        if (!["starting", "running"].includes(record.status)) processes.delete(id);
      resetToolCallUi();
      uiState.debug.openRowId = "";
      emitUiChange(["dashboard", "logs", "published", "debug", "sessions", "roots", "settings"], "database-clear");
      return { ok: true, cleared };
    });
  }
  async function clearPublished(filters = {}) {
    return await withToolCallsDrained("published", async () => {
      const { where, values } = publishedAdminFilter(serverConfig().id, filters);
      const rows = all(`SELECT p.id FROM published p WHERE ${where} ORDER BY p.id`, ...values);
      let cleared = 0;
      for (const row of rows) if (await cleanupPublished(String(row.id), true)) cleared += 1;
      return { ok: true, cleared };
    });
  }
  const sealSecret = value => String(value || "");
  const openSecret = value => String(value || "");
  let shuttingDown = false, mcpHttpServer, mcpHttpsServer;
  let mcpHttpActive = false, mcpTlsActive = false, mcpTlsKind = "none";
  let mcpTlsValid = false, mcpTlsTrusted = false, mcpTlsInfo = null;
  let mcpListenError = "", renewalTimer, processCleanupTimer;
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
  const serverConfig = () => {
    if (!serverConfigCache) serverConfigCache = one("SELECT * FROM server_config WHERE id=1");
    return serverConfigCache;
  };
  const mcpUrl = () => `${publicBase()}/mcp`;
  const mcpIconUrl = () => `${publicBase()}/mrmcp-icon.png`;
  const mcpServerInfo = () => ({
    name: "MrMCP", version: VERSION,
    icons: [{ src: mcpIconUrl(), mimeType: "image/png" }],
  });
  const metadataUrl = () => `${publicBase()}/.well-known/oauth-protected-resource/mcp`;
  const serverCapabilities = fullAccess => fullAccess ? {
    tools: { listChanged: false },
    prompts: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    extensions: {
      [MCP_UI_EXTENSION]: { mimeTypes: [MCP_UI_MIME_TYPE] },
    },
  } : {};
  const publishUiMeta = () => ({
    ui: {
      prefersBorder: false,
      csp: { resourceDomains: [publicOrigin()], frameDomains: [publicOrigin()] },
    },
  });
  const publishResource = (uri = PUBLISH_UI_URI) => ({
    uri,
    name: "mrmcp_publish",
    title: "MrMCP publish",
    description: "Smart MCP App used by publish. It reads one persistent HTTPS content URL from structuredContent, shows compact publication metadata, exposes Open original for inline previews, and otherwise uses the file card itself as the content action.",
    mimeType: MCP_UI_MIME_TYPE,
    _meta: publishUiMeta(),
  });
  function publishAppHtml() {
    return String.raw`<!doctype html>
<html lang="en" data-mode="inline">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MrMCP publish</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body, main { margin: 0; width: 100%; min-width: 0; background: transparent; }
#header { display: none; padding: 8px 4px 10px; font-family: system-ui, sans-serif; }
#title { font-size: 16px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
#description { margin-top: 4px; font-size: 13px; line-height: 1.4; opacity: .72; overflow-wrap: anywhere; white-space: pre-wrap; }
#meta { margin-top: 5px; font-size: 11px; line-height: 1.35; opacity: .58; overflow-wrap: anywhere; }
#originalOpen { display: inline-flex; align-items: center; margin-top: 7px; padding: 5px 8px; border: 1px solid #ffffff33; border-radius: 7px; color: inherit; font: 12px/1.2 system-ui, sans-serif; text-decoration: none; }
#originalOpen[hidden] { display: none; }
#imageStage { position: relative; display: none; width: 100%; place-items: center; overflow: hidden; }
#image { display: block; width: 100%; height: auto; object-fit: contain; }
#frameStage { position: relative; display: none; width: 100%; }
#frame { display: block; width: 100%; min-height: 120px; border: 0; background: transparent; }
.actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; opacity: .25; transition: opacity .15s; }
#imageStage:hover .actions, #frameStage:hover .actions, .actions:focus-within { opacity: 1; }
.actions button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid #ffffff55; border-radius: 8px; color: white; background: #000b; font: 20px/1 system-ui, sans-serif; cursor: pointer; }
.actions [hidden] { display: none; }
#fileStage { display: none; align-items: center; gap: 12px; padding: 14px; border: 1px solid #ffffff22; border-radius: 10px; font: 14px/1.35 system-ui, sans-serif; }
#fileIcon { font-size: 28px; }
#fileInfo { flex: 1; min-width: 0; }
#fileName { font-weight: 650; overflow-wrap: anywhere; }
#fileMeta { margin-top: 3px; opacity: .65; font-size: 12px; }
#fileOpen { padding: 7px 10px; border: 1px solid #ffffff33; border-radius: 8px; color: inherit; text-decoration: none; white-space: nowrap; }
#error { display: none; padding: 10px; color: var(--color-text-danger, #b42318); font: 14px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
html[data-mode="fullscreen"], html[data-mode="fullscreen"] body, html[data-mode="fullscreen"] main { height: 100%; overflow: hidden; }
html[data-mode="fullscreen"] main { display: flex; flex-direction: column; }
html[data-mode="fullscreen"] #header { flex: 0 0 auto; }
html[data-mode="fullscreen"] #imageStage, html[data-mode="fullscreen"] #frameStage { flex: 1; min-height: 0; }
html[data-mode="fullscreen"] #imageStage { display: grid; }
html[data-mode="fullscreen"] #image { width: 100%; height: 100%; }
html[data-mode="fullscreen"] #frame { height: 100% !important; min-height: 0; }
@media (hover: none) { .actions { opacity: 1; } }
</style>
</head>
<body>
<main>
  <div id="header"><div id="title"></div><div id="description"></div><div id="meta"></div><a id="originalOpen" target="_blank" rel="noopener noreferrer" hidden>Open original ↗</a></div>
  <div id="imageStage">
    <img id="image" alt="Published image">
    <div class="actions">
      <button id="imageFullscreen" type="button" title="Fullscreen" aria-label="Fullscreen" hidden>⛶</button>
    </div>
  </div>
  <div id="frameStage">
    <iframe id="frame" title="Published content" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" allow="fullscreen" referrerpolicy="no-referrer"></iframe>
    <div class="actions">
      <button id="frameFullscreen" type="button" title="Fullscreen" aria-label="Fullscreen" hidden>⛶</button>
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
  var header = document.getElementById('header');
  var title = document.getElementById('title');
  var description = document.getElementById('description');
  var meta = document.getElementById('meta');
  var originalOpen = document.getElementById('originalOpen');
  var imageStage = document.getElementById('imageStage');
  var frameStage = document.getElementById('frameStage');
  var fileStage = document.getElementById('fileStage');
  var image = document.getElementById('image');
  var frame = document.getElementById('frame');
  var fileName = document.getElementById('fileName');
  var fileMeta = document.getElementById('fileMeta');
  var fileOpen = document.getElementById('fileOpen');
  var imageFullscreen = document.getElementById('imageFullscreen');
  var frameFullscreen = document.getElementById('frameFullscreen');
  var error = document.getElementById('error');
  var pending = new Map();
  var nextId = Math.floor(Math.random() * 1073741823) + 1;
  var currentMode = 'inline';
  var fullscreenAvailable = false;
  var currentPreview = '';
  var publicationId = '';

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
    var label = currentMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
    imageFullscreen.title = label;
    imageFullscreen.setAttribute('aria-label', label);
    frameFullscreen.title = label;
    frameFullscreen.setAttribute('aria-label', label);
  }
  function applyHostContext(context) {
    context = context || {};
    if (context.theme) root.style.colorScheme = context.theme;
    if (context.displayMode) setMode(context.displayMode);
    fullscreenAvailable = array(context.availableDisplayModes).indexOf('fullscreen') >= 0;
    imageFullscreen.hidden = !fullscreenAvailable || currentPreview !== 'image';
    frameFullscreen.hidden = !fullscreenAvailable || currentPreview !== 'frame';
  }
  function formatSize(value) {
    var size = Number(value || 0);
    if (!size) return '';
    if (size < 1024) return size + ' B';
    if (size < 1048576) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1048576).toFixed(1) + ' MB';
  }
  function previewKind(mime) {
    var essence = String(mime || '').split(';', 1)[0].trim().toLowerCase();
    if (essence.indexOf('image/') === 0 && essence !== 'image/svg+xml') return 'image';
    if (essence.indexOf('text/') === 0 || essence.indexOf('audio/') === 0 || essence.indexOf('video/') === 0 ||
        essence === 'application/pdf' || essence === 'application/json' || /\+json$/.test(essence) ||
        essence === 'application/xml' || /\+xml$/.test(essence) || essence === 'image/svg+xml') return 'frame';
    return '';
  }
  function render(result) {
    result = result || {};
    var structured = result.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent : result;
    var uri = typeof structured.uri === 'string' ? structured.uri : '';
    var id = String(structured.id || '');
    if (publicationId && id && id !== publicationId) return;
    if (uri && id) publicationId = id;
    var mime = String(structured.mime_type || '').toLowerCase();
    var filename = String(structured.filename || 'Published content');
    var presentation = String(structured.presentation || 'auto').toLowerCase();
    var source = String(structured.source || '').toLowerCase();
    var label = String(structured.title || '');
    var detail = String(structured.description || '');
    var height = Math.max(120, Math.min(Number(structured.height || 600), 2000));
    var kind = presentation === 'download' ? '' : previewKind(mime);
    currentPreview = kind;
    imageStage.style.display = 'none';
    frameStage.style.display = 'none';
    fileStage.style.display = 'none';
    image.removeAttribute('src');
    frame.removeAttribute('src');
    showError('');
    title.textContent = label;
    description.textContent = detail;
    var sourceLabel = source === 'base64' ? 'Base64' : source === 'text' ? 'Text' : source === 'path' ? 'File' : '';
    meta.textContent = [filename, mime, formatSize(structured.size), sourceLabel].filter(Boolean).join(' · ');
    if (uri && kind) {
      originalOpen.href = uri;
      originalOpen.hidden = false;
    } else {
      originalOpen.removeAttribute('href');
      originalOpen.hidden = true;
    }
    header.style.display = label || detail || meta.textContent || (uri && kind) ? 'block' : 'none';
    if (!uri) return;
    if (kind === 'image') {
      image.alt = label || filename;
      image.src = uri;
      imageStage.style.display = 'grid';
      imageFullscreen.hidden = !fullscreenAvailable;
      frameFullscreen.hidden = true;
      return;
    }
    if (kind === 'frame') {
      frame.title = label || filename;
      frame.style.height = height + 'px';
      frame.src = uri;
      frameStage.style.display = 'block';
      frameFullscreen.hidden = !fullscreenAvailable;
      imageFullscreen.hidden = true;
      return;
    }
    if (currentMode === 'fullscreen') setMode('inline');
    imageFullscreen.hidden = true;
    frameFullscreen.hidden = true;
    fileName.textContent = filename;
    fileMeta.textContent = [mime || 'file', formatSize(structured.size)].filter(Boolean).join(' · ');
    fileOpen.href = uri;
    fileStage.style.display = 'flex';
  }
  function toggleFullscreen() {
    if (!fullscreenAvailable || !currentPreview) return;
    var requested = currentMode === 'fullscreen' ? 'inline' : 'fullscreen';
    imageFullscreen.disabled = true;
    frameFullscreen.disabled = true;
    request('ui/request-display-mode', { mode: requested }, 3000).then(function (result) {
      setMode(result && result.mode ? result.mode : requested);
    }).catch(function () {}).finally(function () {
      imageFullscreen.disabled = false;
      frameFullscreen.disabled = false;
    });
  }

  imageFullscreen.addEventListener('click', toggleFullscreen);
  frameFullscreen.addEventListener('click', toggleFullscreen);
  image.addEventListener('dblclick', toggleFullscreen);
  image.addEventListener('load', function () { showError(''); });
  image.addEventListener('error', function () {
    imageStage.style.display = 'none';
    showError('Unable to load the published image. The publication may have been cleared or the URL could not be loaded; call publish again.');
  });
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

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'mrmcp-publish', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }, 3000).then(function (result) {
    applyHostContext(result && result.hostContext);
    notify('ui/notifications/initialized', {});
  }).catch(function () {
    notify('ui/notifications/initialized', {});
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
  const mimeEssence = value => String(value || "").split(";", 1)[0].trim().toLowerCase();
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
      essence === "application/javascript";
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
  const publishedUrl = (token, filename) => `${publicBase()}/published/${token}/${encodeURIComponent(filename)}`;
  const publishedPath = name => join(PUBLISH_DIR, name);
  const publishedFileName = (id, filename) => {
    const rawExtension = extname(filename), rawStem = basename(filename, rawExtension);
    const extension = rawExtension.replace(/[\u0000-\u001f\u007f<>:\"|?*\/\\]/g, "_");
    const stem = rawStem.replace(/[\u0000-\u001f\u007f<>:\"|?*\/\\]/g, "_").trim() || "content";
    const maxStem = Math.max(1, 240 - id.length - 1 - extension.length);
    return `${id}-${stem.slice(0, maxStem)}${extension}`;
  };
  const defaultPublishedFilename = mimeType => {
    const essence = mimeEssence(mimeType);
    const extension = essence === "text/html" || essence === "application/xhtml+xml" ? ".html"
      : essence === "text/plain" ? ".txt"
      : essence === "application/json" || essence.endsWith("+json") ? ".json"
      : essence === "application/pdf" ? ".pdf"
      : essence === "application/xml" || essence === "text/xml" || essence.endsWith("+xml") ? ".xml"
      : essence === "image/png" ? ".png"
      : essence === "image/jpeg" ? ".jpg"
      : essence === "image/webp" ? ".webp"
      : essence === "image/gif" ? ".gif"
      : essence === "image/svg+xml" ? ".svg"
      : essence === "audio/mpeg" ? ".mp3"
      : essence === "video/mp4" ? ".mp4"
      : essence === "application/zip" ? ".zip"
      : essence === "application/wasm" ? ".wasm" : ".bin";
    return `content${extension}`;
  };
  const normalizePublishMime = value => {
    const mimeType = String(value || "").trim(), essence = mimeEssence(value);
    if (!mimeType || /[^\x20-\x7e]/.test(mimeType) || !/^[^\s\/;]+\/[^\s;]+$/.test(essence))
      throw new Error("mime_type must be a valid MIME type");
    return mimeType;
  };
  const normalizePresentation = value => {
    const presentation = String(value || "auto").trim().toLowerCase() || "auto";
    if (!["auto", "inline", "download"].includes(presentation)) throw new Error("Invalid presentation");
    return presentation;
  };
  const decodePublishBase64 = value => {
    const input = String(value ?? "").replace(/\s+/g, "");
    if (input && (input.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input))) throw new Error("Invalid base64 content");
    const bytes = new Uint8Array(Buffer.from(input, "base64"));
    const canonical = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
    if (canonical !== input.replace(/=+$/, "")) throw new Error("Invalid base64 content");
    return bytes;
  };
  let publishSerial = Promise.resolve();
  const serializePublish = work => {
    const result = publishSerial.then(work, work);
    publishSerial = result.then(() => undefined, () => undefined);
    return result;
  };
  const hashContent = (prefix, parts) => {
    const hash = createHash("sha256");
    for (const part of parts) {
      hash.update(part);
      hash.update("\0");
    }
    return `${prefix}_${hash.digest("base64url")}`;
  };
  async function fileSlice(file, offset, length) {
    if (!length) return new Uint8Array();
    await file.seek(offset, Deno.SeekMode.Start);
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = await file.read(bytes.subarray(read));
      if (n === null) break;
      read += n;
    }
    return bytes.subarray(0, read);
  }
  async function fileContentKey(path, size) {
    const file = await Deno.open(path, { read: true });
    try {
      const length = Math.min(10, size);
      const first = await fileSlice(file, 0, length);
      const last = await fileSlice(file, Math.max(0, size - length), length);
      const middle = await fileSlice(file, Math.max(0, Math.floor((size - length) / 2)), length);
      return hashContent("content", [String(size), first, last, middle]);
    } finally { file.close(); }
  }
  const bytesContentKey = bytes => {
    const size = bytes.byteLength, length = Math.min(10, size);
    const first = bytes.subarray(0, length);
    const last = bytes.subarray(Math.max(0, size - length), size);
    const middleStart = Math.max(0, Math.floor((size - length) / 2));
    return hashContent("content", [String(size), first, last, bytes.subarray(middleStart, middleStart + length)]);
  };
  const addPublishedUse = (publishedId, metadata) => {
    const contextHandle = String(metadata.context_handle || ""), contextId = Number(metadata.context_id || 0), rootId = Number(metadata.root_id || 0);
    const values = [
      contextHandle, String(metadata.root_name || ""), String(metadata.root_path || ""), String(metadata.source_path || ""), String(metadata.source_filename || ""),
      String(metadata.filename || ""), String(metadata.mime_type || ""), String(metadata.title || ""), String(metadata.description || ""),
      normalizePresentation(metadata.presentation), Number(metadata.height || 0), Number(metadata.published_at || Date.now()),
    ];
    const existing = one(`SELECT id FROM published_uses
      WHERE published_id=? AND context_id=? AND root_id=? ORDER BY id DESC LIMIT 1`, publishedId, contextId, rootId);
    if (existing) return run(`UPDATE published_uses SET
      context_handle=?,root_name=?,root_path=?,source_path=?,source_filename=?,filename=?,mime_type=?,title=?,description=?,presentation=?,height=?,published_at=?
      WHERE id=?`, ...values, existing.id);
    return run(`INSERT INTO published_uses(
      published_id,context_handle,context_id,root_id,root_name,root_path,source_path,source_filename,filename,mime_type,title,description,presentation,height,published_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, publishedId, contextHandle, contextId, rootId, ...values.slice(1));
  };
  async function cleanupPublished(id, strict = false) {
    const record = one("SELECT published_name FROM published WHERE id=?", id);
    if (!record) return false;
    if (record.published_name) {
      try { await Deno.remove(publishedPath(record.published_name)); }
      catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          if (strict) throw error;
          return false;
        }
      }
    }
    run("DELETE FROM published WHERE id=?", id);
    changed({ ui: ["published"] }, "published-delete");
    return true;
  }
  async function openPublished(id) {
    const record = one("SELECT id,filename FROM published WHERE id=?", id);
    if (!record) throw new Error("Published item not found");
    const latest = one("SELECT filename FROM published_uses WHERE published_id=? ORDER BY published_at DESC,id DESC LIMIT 1", id);
    const filename = latest?.filename || record.filename;
    if (!IS_BACKEND_WORKER) throw new Error("URL opening is available only in the desktop UI");
    self.postMessage({ type: "os-open-url", url: publishedUrl(record.id, filename) });
  }
  async function cleanupPublishedOrphans() {
    const live = new Set(all("SELECT published_name FROM published").map(record => String(record.published_name)));
    for await (const entry of Deno.readDir(PUBLISH_DIR))
      if (entry.isFile && !live.has(entry.name)) await Deno.remove(join(PUBLISH_DIR, entry.name)).catch(() => {});
  }
  async function publishContent(source, options = {}) {
    return await serializePublish(async () => {
      const mimeType = normalizePublishMime(options.mime_type);
      const presentation = normalizePresentation(options.presentation);
      const title = String(options.title || "").trim().slice(0, 200);
      const description = String(options.description || "").trim().slice(0, 2000);
      const height = Math.max(120, Math.min(Number(options.height || 600), 2000));
      let realPath = "", sourceFilename = "", bytes = null, size = 0, contentKey = "";
      if (source.path) {
        const allowedRoot = await Deno.realPath(options.allowed_root || dirname(source.path));
        realPath = await Deno.realPath(source.path);
        if (!within(allowedRoot, realPath)) throw new Error("Published file resolves outside its allowed root");
        const stat = await Deno.stat(realPath);
        if (!stat.isFile) throw new Error("Only regular files can be published");
        sourceFilename = basename(realPath);
        size = stat.size;
        contentKey = await fileContentKey(realPath, size);
      } else {
        bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes || []);
        size = bytes.byteLength;
        contentKey = bytesContentKey(bytes);
      }
      const filename = safeDownloadName(options.filename || sourceFilename || defaultPublishedFilename(mimeType));
      let record = one("SELECT * FROM published WHERE server_id=? AND content_key=?", options.server_id, contentKey), created = false;
      if (!record) {
        const id = randomToken(32), publishedName = publishedFileName(id, filename), snapshotPath = publishedPath(publishedName), createdAt = Date.now();
        if (realPath) await Deno.copyFile(realPath, snapshotPath);
        else await Deno.writeFile(snapshotPath, bytes, { createNew: true });
        const snapshotStat = await Deno.stat(snapshotPath);
        if (snapshotStat.size !== size || await fileContentKey(snapshotPath, snapshotStat.size) !== contentKey) {
          await Deno.remove(snapshotPath).catch(() => {});
          throw new Error(realPath ? "File changed while it was being published; retry the publication." : "Published content verification failed");
        }
        try {
          run(`INSERT INTO published(id,server_id,content_key,context_handle,context_id,root_id,root_name,root_path,source_path,source_filename,published_name,filename,mime_type,size,title,description,presentation,height,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, options.server_id, contentKey, options.context_handle || "", Number(options.context_id || 0), Number(options.root_id || 0), String(options.root_name || ""), String(options.root_path || ""),
            realPath, sourceFilename, publishedName, filename, mimeType, snapshotStat.size, title, description, presentation, height, createdAt,
          );
        } catch (error) {
          await Deno.remove(snapshotPath).catch(() => {});
          throw error;
        }
        record = one("SELECT * FROM published WHERE id=?", id);
        created = true;
      } else {
        const snapshotPath = publishedPath(record.published_name);
        const snapshotStat = await Deno.stat(snapshotPath).catch(() => null);
        if (!snapshotStat?.isFile || snapshotStat.size !== size || await fileContentKey(snapshotPath, snapshotStat.size) !== contentKey) {
          if (realPath) await Deno.copyFile(realPath, snapshotPath);
          else await Deno.writeFile(snapshotPath, bytes);
          const repaired = await Deno.stat(snapshotPath);
          if (repaired.size !== size || await fileContentKey(snapshotPath, repaired.size) !== contentKey)
            throw new Error(realPath ? "File changed while it was being published; retry the publication." : "Published content verification failed");
        }
      }
      const publishedAt = Date.now();
      try {
        addPublishedUse(record.id, {
          ...options, source_path: realPath, source_filename: sourceFilename, filename, mime_type: mimeType,
          title, description, presentation, height, published_at: publishedAt,
        });
      } catch (error) {
        if (created) await cleanupPublished(record.id).catch(() => {});
        throw error;
      }
      changed({ ui: ["published"] }, "published");
      return {
        id: record.id, content_id: contentKey, filename, mime_type: mimeType, size: Number(record.size || size),
        source: String(options.source || ''), uri: publishedUrl(record.id, filename), presentation, title, description, height,
        created_at: new Date(record.created_at).toISOString(),
      };
    });
  }

  const contentDisposition = (filename, mode = "attachment") => {
    const fallback = safeDownloadName(filename).replace(/["\\]/g, "_");
    const disposition = mode === "inline" ? "inline" : "attachment";
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  };
  async function publishedContentResponse(req, u) {
    const match = u.pathname.match(/^\/published\/([A-Za-z0-9_-]{24,})\/([^/]+)$/);
    if (!match || !["GET", "HEAD"].includes(req.method))
      return text("Not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    const token = match[1], record = one("SELECT * FROM published WHERE id=?", token);
    if (!record) return text("Published content not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    let requestedName;
    try { requestedName = decodeURIComponent(match[2]); } catch { requestedName = ""; }
    const use = requestedName ? one(`SELECT filename,mime_type FROM published_uses
      WHERE published_id=? AND filename=? ORDER BY published_at DESC,id DESC LIMIT 1`, token, requestedName) : null;
    const effectiveMime = use?.mime_type || record.mime_type;
    const effectiveName = safeDownloadName(requestedName || record.filename);
    const allowedRoot = await Deno.realPath(PUBLISH_DIR).catch(() => null);
    const realPath = await Deno.realPath(publishedPath(record.published_name)).catch(() => null);
    const stat = realPath && allowedRoot && within(allowedRoot, realPath)
      ? await Deno.stat(realPath).catch(() => null) : null;
    if (!stat?.isFile) {
      await cleanupPublished(token);
      return text("Published content not found", 404, "text/plain; charset=utf-8", { "cache-control": "no-store" });
    }
    run("UPDATE published SET request_count=request_count+1,last_request_at=? WHERE id=?", Date.now(), token);
    changed({ ui: ["published"] }, "published-request");
    const inlinePreview = isInlinePreviewMime(effectiveMime);
    const essence = mimeEssence(effectiveMime);
    const activeDocument = isActiveDocumentMime(effectiveMime);
    const htmlDocument = essence === "text/html" || essence === "application/xhtml+xml";
    const headers = {
      "content-type": responseContentType(effectiveMime, effectiveName),
      "content-length": String(stat.size),
      "content-disposition": contentDisposition(effectiveName, inlinePreview ? "inline" : "attachment"),
      "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(inlinePreview ? {
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      } : {}),
      ...(!htmlDocument && activeDocument ? {
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
      } : !inlinePreview ? { "content-security-policy": "default-src 'none'; sandbox" } : {}),
    };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers });
    const file = await Deno.open(realPath, { read: true });
    const reader = file.readable.getReader();
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      try { reader.releaseLock(); } catch {}
      try { file.close(); } catch {}
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
  async function safePath(root, path = ".", knownRootReal = "") {
    const rootReal = knownRootReal || await Deno.realPath(root);
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
  const TEXT_ENCODINGS = new Set(["utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"]);
  const TEXT_ENCODING_SAMPLE_BYTES = 16 * 1024;
  const textEncodingDetection = () => getCfg("text_encoding_detection", "sample") === "full" ? "full" : "sample";
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
    value = String(value || "");
    let kind = "none";
    const seen = current => {
      if (kind === "none") { kind = current; return false; }
      return kind !== current;
    };
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 13) {
        if (value.charCodeAt(index + 1) === 10) { if (seen("crlf")) return "mixed"; index++; }
        else if (seen("cr")) return "mixed";
      } else if (code === 10 && seen("lf")) return "mixed";
    }
    return kind;
  }
  function normalizeLineEndings(value, mode, source = null) {
    mode = String(mode || "preserve").toLowerCase();
    if (mode === "preserve") mode = !source ? "lf" : ["lf", "crlf", "cr"].includes(source.line_endings) ? source.line_endings : "preserve";
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
  function decodeAscii(bytes) {
    for (const byte of bytes) if (byte > 0x7f) throw new Error(`Invalid ASCII byte 0x${byte.toString(16).toUpperCase().padStart(2, "0")}`);
    return decodeLatin1(bytes);
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
  function encodeAscii(value) {
    const bytes = [];
    for (const character of String(value)) {
      const code = character.codePointAt(0);
      if (code > 0x7f) throw new Error(`Character U+${code.toString(16).toUpperCase()} cannot be encoded as ascii`);
      bytes.push(code);
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
  function encodeUtf32(value, bigEndian = false) {
    const codePoints = [...String(value)], bytes = new Uint8Array(codePoints.length * 4);
    let offset = 0;
    for (const character of codePoints) {
      const code = character.codePointAt(0);
      if (bigEndian) {
        bytes[offset++] = code >>> 24; bytes[offset++] = code >>> 16; bytes[offset++] = code >>> 8; bytes[offset++] = code;
      } else {
        bytes[offset++] = code; bytes[offset++] = code >>> 8; bytes[offset++] = code >>> 16; bytes[offset++] = code >>> 24;
      }
    }
    return bytes;
  }
  function decodeUtf32(bytes, bigEndian = false) {
    if (bytes.length % 4) throw new Error(`Invalid ${bigEndian ? "UTF-32BE" : "UTF-32LE"} byte length`);
    let out = "";
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const code = bigEndian
        ? ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
        : ((bytes[offset + 3] << 24) >>> 0) + (bytes[offset + 2] << 16) + (bytes[offset + 1] << 8) + bytes[offset];
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`Invalid UTF-32 code point U+${code.toString(16).toUpperCase()}`);
      if (offset === 0 && code === 0xfeff) continue;
      out += String.fromCodePoint(code);
    }
    return out;
  }
  function normalizeDetectedEncoding(value) {
    const encoding = String(value || "").trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "");
    if (!encoding) return "";
    if (encoding === "utf8") return "utf-8";
    if (["utf16le", "utf-16-le"].includes(encoding)) return "utf-16le";
    if (["utf16be", "utf-16-be"].includes(encoding)) return "utf-16be";
    if (["utf32le", "utf-32-le"].includes(encoding)) return "utf-32le";
    if (["utf32be", "utf-32-be"].includes(encoding)) return "utf-32be";
    if (encoding === "iso-8859-1") return "latin1";
    return encoding;
  }
  function textBom(bytes) {
    return (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
      || (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      || (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
      || (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff);
  }
  function sameBytes(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
  function decodeTextBytes(bytes, encoding) {
    if (encoding === "ascii") return decodeAscii(bytes);
    if (encoding === "latin1") return decodeLatin1(bytes);
    if (encoding === "windows-1252") return decodeWindows1252(bytes);
    if (encoding === "utf-32le") return decodeUtf32(bytes, false);
    if (encoding === "utf-32be") return decodeUtf32(bytes, true);
    let decoder;
    try { decoder = new TextDecoder(encoding, { fatal: true }); }
    catch (error) {
      if (!iconv.encodingExists(encoding)) throw new Error(`Unsupported detected text encoding: ${encoding}`, { cause: error });
      const decoded = iconv.decode(Buffer.from(bytes), encoding);
      if (!sameBytes(iconv.encode(decoded, encoding), bytes)) throw new Error(`Text cannot be decoded losslessly as ${encoding}`);
      return decoded;
    }
    return decoder.decode(bytes);
  }
  function encodeText(value, encoding) {
    if (encoding === "ascii") return encodeAscii(value);
    if (encoding === "utf-8") return enc.encode(String(value));
    if (encoding === "utf-16le") return encodeUtf16(value, false);
    if (encoding === "utf-16be") return encodeUtf16(value, true);
    if (encoding === "utf-32le") return encodeUtf32(value, false);
    if (encoding === "utf-32be") return encodeUtf32(value, true);
    if (encoding === "windows-1252") return encodeLatin1(value, true);
    if (encoding === "latin1") return encodeLatin1(value, false);
    if (iconv.encodingExists(encoding)) return new Uint8Array(iconv.encode(String(value), encoding));
    throw new Error(`Unsupported output encoding: ${encoding}`);
  }
  function decodeTextDocument(bytes, requested = "auto", detection = "full") {
    requested = textEncoding(requested, "auto");
    const bom = textBom(bytes);
    const detect = input => {
      const encoding = normalizeDetectedEncoding(chardet.detect(input));
      if (!encoding) throw new Error("Unable to detect text encoding");
      return encoding;
    };
    let encoding = requested, text;
    if (requested !== "auto") text = decodeTextBytes(bytes, encoding);
    else if (detection === "sample" && bytes.length > TEXT_ENCODING_SAMPLE_BYTES) {
      try {
        const candidate = chardet.analyse(bytes.subarray(0, TEXT_ENCODING_SAMPLE_BYTES))[0];
        if (!(candidate?.confidence >= 80)) throw new Error("Sample encoding confidence is too low");
        encoding = normalizeDetectedEncoding(candidate.name);
        if (!encoding) throw new Error("Unable to detect text encoding");
        text = decodeTextBytes(bytes, encoding);
      } catch {
        // A prefix may miss later non-ASCII bytes or end inside a character.
        // Retry charset detection over the complete buffer, keeping decoding strict.
        encoding = detect(bytes);
        text = decodeTextBytes(bytes, encoding);
      }
    } else {
      encoding = detect(bytes);
      text = decodeTextBytes(bytes, encoding);
    }
    return { text, encoding, bom, line_endings: lineEndingKind(text), bytes };
  }
  async function readTextDocument(path, requested = "auto", detection = "full") {
    return decodeTextDocument(await Deno.readFile(path), requested, detection);
  }
  function encodeTextDocument(value, source = null, options = {}) {
    const requested = textEncoding(options.output_encoding || "preserve", "preserve", true);
    const encoding = requested === "preserve" ? (source?.encoding || "utf-8") : requested;
    const text = normalizeLineEndings(value, options.line_endings || "preserve", source);
    const bomMode = String(options.bom || "preserve").toLowerCase();
    if (!["preserve", "add", "remove"].includes(bomMode)) throw new Error("bom must be preserve, add, or remove");
    const bom = bomMode === "add" || (bomMode === "preserve" && !!source?.bom);
    const bomEncoding = ["utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be"].includes(encoding);
    if (bomMode === "add" && !bomEncoding) throw new Error(`BOM cannot be added for ${encoding}`);
    const payload = encodeText(text, encoding);
    const emitBom = bom && bomEncoding;
    const prefix = !emitBom ? new Uint8Array() : encoding === "utf-8"
      ? new Uint8Array([0xef, 0xbb, 0xbf]) : encoding === "utf-16le"
      ? new Uint8Array([0xff, 0xfe]) : encoding === "utf-16be"
      ? new Uint8Array([0xfe, 0xff]) : encoding === "utf-32le"
      ? new Uint8Array([0xff, 0xfe, 0x00, 0x00]) : new Uint8Array([0x00, 0x00, 0xfe, 0xff]);
    const bytes = new Uint8Array(prefix.length + payload.length);
    bytes.set(prefix); bytes.set(payload, prefix.length);
    const physicalBom = textBom(bytes);
    if (physicalBom !== bom) throw new Error(`Requested BOM ${bom ? "presence" : "absence"} cannot be represented losslessly as ${encoding}`);
    let decoded;
    try { decoded = decodeTextBytes(bytes, encoding); }
    catch (error) { throw new Error(`Text cannot be encoded losslessly as ${encoding}`, { cause: error }); }
    if (decoded !== text) throw new Error(`Text cannot be encoded losslessly as ${encoding}`);
    return { bytes, encoding, bom: physicalBom, line_endings: lineEndingKind(text) };
  }
  function globRegex(pattern = "**/*") {
    const source = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
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
  const slashPath = value => String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const compileGlobs = (patterns, fallback = ["**/*"]) =>
    (Array.isArray(patterns) && patterns.length ? patterns : fallback).map(pattern => globRegex(pattern));
  const matchesGlobs = (path, globs) => globs.some(regex => regex.test(path));
  const excludedByGlobs = (path, globs) => matchesGlobs(path, globs) || matchesGlobs(`${path}/x`, globs);
  function fixedGlobPrefix(pattern) {
    const source = slashPath(pattern);
    if (!source || source.startsWith("/")) return "";
    const parts = source.split("/"), fixed = [];
    for (const part of parts) {
      if (!part || /[*?]/.test(part)) break;
      fixed.push(part);
    }
    return fixed.join("/");
  }
  function includeTraversalPrefixes(patterns) {
    const values = Array.isArray(patterns) && patterns.length ? patterns : ["**/*"];
    const prefixes = values.map(fixedGlobPrefix);
    return prefixes.some(prefix => !prefix) ? null : [...new Set(prefixes)];
  }
  function includeMayMatchBelow(directory, prefixes) {
    if (!prefixes) return true;
    const local = slashPath(directory).replace(/\/$/, "");
    return prefixes.some(prefix => local === prefix || prefix.startsWith(`${local}/`) || local.startsWith(`${prefix}/`));
  }
  const fingerprintBytes = async bytes => `fp_${await sha256(bytes)}`;
  const fileFingerprint = async path => await fingerprintBytes(await Deno.readFile(path));

  function parseGitignore(source, base = "") {
    const rules = [];
    for (let raw of String(source || "").split(/\r?\n/)) {
      if (!raw || raw.startsWith("#")) continue;
      if (raw.startsWith("\\#")) raw = raw.slice(1);
      let negated = false;
      if (raw.startsWith("!")) { negated = true; raw = raw.slice(1); }
      else if (raw.startsWith("\\!")) raw = raw.slice(1);
      raw = raw.replace(/(?<!\\)\s+$/, "").replaceAll("\\ ", " ");
      if (!raw) continue;
      const directoryOnly = raw.endsWith("/");
      if (directoryOnly) raw = raw.slice(0, -1);
      const anchored = raw.startsWith("/");
      if (anchored) raw = raw.slice(1);
      if (!raw) continue;
      const prefix = base ? `${base}/` : "";
      const pattern = anchored || raw.includes("/") ? `${prefix}${raw}` : `${prefix}**/${raw}`;
      rules.push({ negated, directoryOnly, match: globRegex(pattern), descendant: globRegex(`${pattern}/**`) });
    }
    return rules;
  }
  async function gitignoreRules(rootReal, directory, inherited = []) {
    const base = slashPath(relative(rootReal, directory));
    try {
      const source = await Deno.readTextFile(join(directory, ".gitignore"));
      return [...inherited, ...parseGitignore(source, base === "." ? "" : base)];
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return inherited;
    }
  }
  function gitignored(path, isDirectory, rules) {
    let ignored = false;
    for (const rule of rules) {
      const direct = rule.match.test(path) && (!rule.directoryOnly || isDirectory);
      const descendant = rule.descendant.test(path) || (isDirectory && rule.descendant.test(`${path}/x`));
      if (direct || descendant) ignored = !rule.negated;
    }
    return ignored;
  }
  async function inheritedGitignoreRules(rootReal, base) {
    const rel = slashPath(relative(rootReal, base));
    const parts = !rel || rel === "." ? [] : rel.split("/");
    let directory = rootReal, rules = await gitignoreRules(rootReal, rootReal, []);
    for (const part of parts) {
      directory = join(directory, part);
      const stat = await Deno.stat(directory).catch(() => null);
      if (!stat?.isDirectory) break;
      rules = await gitignoreRules(rootReal, directory, rules);
    }
    return rules;
  }
  function compareFsPaths(left, right) {
    // Cursor order must match traversal before its hard limit, including siblings
    // such as a.txt beside a/; sorting only the collected page can skip files.
    if (left === right) return 0;
    const a = left.split("/"), b = right.split("/");
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const order = a[index].localeCompare(b[index]) || (a[index] < b[index] ? -1 : a[index] > b[index] ? 1 : 0);
      if (order) return order;
    }
    return a.length - b.length;
  }
  const fsWalkLimit = options => Math.min(Math.max(Number(options.hard_limit || 100000), 1), 200000);
  async function* fsWalkEntries(root, start = ".", options = {}) {
    const rootReal = options.root_real || await Deno.realPath(root), base = await safePath(rootReal, start, rootReal);
    const stat = await Deno.lstat(base), include = compileGlobs(options.include), exclude = compileGlobs(options.exclude, []);
    const includePrefixes = includeTraversalPrefixes(options.include);
    const hidden = options.hidden === true, useGitignore = options.gitignore !== false, metadata = options.metadata !== false;
    const hardLimit = fsWalkLimit(options);
    let yielded = 0;
    const afterPath = slashPath(options.after_path || ""), fromPath = slashPath(options.from_path || "");
    const inPage = path => (!afterPath || compareFsPaths(path, afterPath) > 0) && (!fromPath || compareFsPaths(path, fromPath) >= 0);
    const pageStart = compareFsPaths(afterPath, fromPath) >= 0 ? afterPath : fromPath;
    const baseDirectory = stat.isDirectory ? base : dirname(base);
    const initialRules = useGitignore ? await inheritedGitignoreRules(rootReal, baseDirectory) : [];
    const localPath = absolute => {
      if (stat.isFile || stat.isSymlink) return basename(absolute);
      return slashPath(relative(base, absolute));
    };
    const displayPath = absolute => slashPath(relative(rootReal, absolute)) || ".";
    if (stat.isFile || stat.isSymlink) {
      const local = basename(base), display = displayPath(base);
      if (inPage(display) && (hidden || !basename(base).startsWith(".")) && matchesGlobs(local, include) && !excludedByGlobs(local, exclude)
        && (!useGitignore || !gitignored(display, false, initialRules)))
        yield metadata ? {
          path: display,
          type: stat.isSymlink ? "symlink" : "file",
          size: stat.size,
          modified_at: stat.mtime?.toISOString() || null,
          created_at: stat.birthtime?.toISOString() || null,
          ...(stat.isSymlink ? { link_target: await Deno.readLink(base) } : {}),
        } : { path: display, type: stat.isSymlink ? "symlink" : "file" };
      return;
    }
    async function* visit(directory, inheritedRules, loadRules = true) {
      if (yielded >= hardLimit) return;
      const rules = useGitignore && loadRules ? await gitignoreRules(rootReal, directory, inheritedRules) : inheritedRules;
      const entries = [];
      for await (const entry of Deno.readDir(directory)) entries.push(entry);
      entries.sort((a, b) => compareFsPaths(a.name, b.name));
      for (let offset = 0; offset < entries.length; offset += 16) {
        if (yielded >= hardLimit) return;
        const batch = await Promise.all(entries.slice(offset, offset + 16).map(async entry => {
          if (!hidden && entry.name.startsWith(".")) return null;
          const absolute = join(directory, entry.name), display = displayPath(absolute), local = localPath(absolute);
          if (pageStart && compareFsPaths(display, pageStart) < 0 && !pageStart.startsWith(display + "/")) return null;
          const ignored = useGitignore && gitignored(display, entry.isDirectory, rules);
          const excluded = excludedByGlobs(local, exclude);
          let resultEntry = null;
          if (inPage(display) && !ignored && !excluded && matchesGlobs(local, include)) {
            const type = entry.isDirectory ? "directory" : entry.isSymlink ? "symlink" : "file";
            if (!metadata) resultEntry = { path: display, type };
            else {
              const entryStat = await Deno.lstat(absolute);
              resultEntry = {
                path: display, type, size: entryStat.size,
                modified_at: entryStat.mtime?.toISOString() || null,
                created_at: entryStat.birthtime?.toISOString() || null,
                ...(entry.isSymlink ? { link_target: await Deno.readLink(absolute) } : {}),
              };
            }
          }
          return { entry, absolute, local, ignored, excluded, resultEntry };
        }));
        for (const item of batch) {
          if (yielded >= hardLimit) return;
          if (!item) continue;
          if (item.resultEntry) { yielded++; yield item.resultEntry; }
          if (item.entry.isDirectory && !item.ignored && !item.excluded && includeMayMatchBelow(item.local, includePrefixes))
            yield* visit(item.absolute, rules);
        }
      }
    }
    yield* visit(base, initialRules, false);
  }
  async function fsWalk(root, start = ".", options = {}) {
    const entries = [];
    for await (const entry of fsWalkEntries(root, start, options)) entries.push(entry);
    return { entries, limited: entries.length >= fsWalkLimit(options) };
  }
  async function copyRecursive(from, to) {
    const st = await Deno.lstat(from);
    if (st.isSymlink) {
      await Deno.mkdir(dirname(to), { recursive: true });
      const target = await Deno.readLink(from);
      if (Deno.build.os === "windows") {
        const targetStat = await Deno.stat(from).catch(() => null);
        await Deno.symlink(target, to, { type: targetStat?.isDirectory ? "dir" : "file" });
      } else await Deno.symlink(target, to);
    } else if (st.isDirectory) {
      await Deno.mkdir(to, { recursive: true });
      for await (const e of Deno.readDir(from)) await copyRecursive(join(from, e.name), join(to, e.name));
    } else {
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(from, to);
    }
  }
  async function moveRecursive(from, to) {
    await Deno.mkdir(dirname(to), { recursive: true });
    try { await Deno.rename(from, to); }
    catch (error) {
      if (!(error instanceof Deno.errors.NotSupported) && error?.code !== "EXDEV") throw error;
      try {
        await copyRecursive(from, to);
        await Deno.remove(from, { recursive: true });
      } catch (copyError) {
        await Deno.remove(to, { recursive: true }).catch(() => {});
        throw copyError;
      }
    }
  }

  // Chat Session handles are globally unique bearer capabilities over the stateless MCP transport.
  // Workspace id 0 means no selected Workspace; initialization never grants an implicit working directory.
  const serverRoots = p => all(
    "SELECT * FROM roots WHERE server_id=? AND enabled=1 ORDER BY id", p.id,
  );
  const unassignedWorkspaceRoot = p => ({
    id: 0, server_id: p.id, name: "", path: "", enabled: 0,
  });
  const configuredRootPath = configuredWorkspacePath;
  const lstatIfExists = async path => {
    try { return await Deno.lstat(path); }
    catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
  };
  async function trashItemMetadata(path, knownStat = null) {
    const stat = knownStat || await Deno.lstat(path);
    const item_type = stat.isFile ? "file" : stat.isDirectory ? "directory" : stat.isSymlink ? "symlink" : "other";
    const size_bytes = stat.isDirectory ? -1 : Number(stat.size || 0);
    return { item_type, size_bytes };
  }
  async function emptyManagedTrash() {
    return await withToolCallsDrained("trash", async () => {
      const result = {
        trash_roots: 0, entries_removed: 0,
        metadata_items: Number(one("SELECT COUNT(*) n FROM trash_items")?.n || 0), failures: [],
      };
      let stat;
      try { stat = await Deno.stat(TRASH_ROOT); }
      catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) result.failures.push(TRASH_ROOT + ": " + String(error?.message || error));
      }
      if (stat) {
        if (!stat.isDirectory) result.failures.push(TRASH_ROOT + ": not a directory");
        else {
          result.trash_roots = 1;
          try {
            for await (const entry of Deno.readDir(TRASH_ROOT)) {
              await Deno.remove(join(TRASH_ROOT, entry.name), { recursive: true });
              result.entries_removed++;
            }
          } catch (error) { result.failures.push(TRASH_ROOT + ": " + String(error?.message || error)); }
        }
      }
      if (!result.failures.length) run("DELETE FROM trash_transactions");
      changed({ ui: ["state", "trash"] }, "trash-empty");
      return { ok: result.failures.length === 0, ...result };
    });
  }
  const runtimeWorkspaceRoot = root => ({ ...root, stored_path: root.path, path: configuredRootPath(root.path) });
  const rootPathWarning = workspacePathWarning;
  const validRootName = validWorkspaceName;
  const workspaceNameWarning = (name, id = 0) => {
    const value = String(name || "").trim();
    if (!validRootName(value)) return "Workspace name must be 1-128 characters and cannot contain slashes or control characters.";
    return one("SELECT 1 FROM roots WHERE name=? AND id<>?", value, Number(id) || 0)
      ? "Workspace name already exists."
      : "";
  };
  const createdWorkspaceNameWarning = name => {
    const value = String(name || "").trim(), warning = workspaceNameWarning(value);
    if (warning) return warning;
    if (value === "." || value === ".." || /[<>:\"|?*]/.test(value))
      return "Workspace name cannot be used as a Desktop folder name.";
    if (Deno.build.os === "windows" && (/[ .]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)))
      return "Workspace name cannot be used as a Windows folder name.";
    return "";
  };
  const rootPathKey = value => {
    const path = configuredRootPath(value);
    return Deno.build.os === "windows" ? path.toLowerCase() : path;
  };
  async function createDesktopWorkspace(p, name) {
    const value = String(name || "").trim(), warning = createdWorkspaceNameWarning(value);
    if (warning) throw new Error(warning);
    const desktop = await desktopDirectory();
    let desktopStat;
    try { desktopStat = await Deno.stat(desktop); }
    catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error("Desktop directory does not exist.");
      throw new Error("Unable to access Desktop directory.");
    }
    if (!desktopStat.isDirectory) throw new Error("Desktop path is not a directory.");
    const path = join(desktop, value), pathKey = rootPathKey(path);
    const registered = all("SELECT name,path FROM roots WHERE server_id=?", p.id)
      .find(root => rootPathKey(root.path) === pathKey);
    if (registered) throw new Error(`Workspace folder is already registered by Workspace '${registered.name}'.`);
    try {
      await Deno.lstat(path);
      throw new Error("Desktop folder already exists.");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        if (error?.message === "Desktop folder already exists.") throw error;
        throw new Error("Unable to inspect Desktop target.");
      }
    }
    try { await Deno.mkdir(path); }
    catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) throw new Error("Desktop folder already exists.");
      throw new Error("Unable to create Desktop folder.");
    }
    run("INSERT INTO roots(server_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)", p.id, value, path, 1, Date.now());
    changed({ ui: ["dashboard", "roots", "sessions", "memory"] }, "workspace-created");
    return { created: true };
  }
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
    if (added.length) changed({ ui: ["dashboard", "roots", "sessions", "memory"] }, "workspace-drop");
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
  function createContext(p, protocolVersion = "", client = {}) {
    let handle;
    do handle = `ctx_${randomToken(24)}`;
    while (one("SELECT 1 FROM contexts WHERE handle=?", handle));
    const now = Date.now();
    run(`INSERT INTO contexts(handle,server_id,root_id,label,created_at,updated_at,last_active_at,protocol_version,auth_kind,oauth_client_id,client_name,user_agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, handle, p.id, 0, "", now, now, now, String(protocolVersion || ""),
      String(client.auth_kind || ""), String(client.oauth_client_id || ""), String(client.client_name || ""),
      String(client.user_agent || "").slice(0, 512));
    changed({ ui: ["sessions", "roots", "logs", "memory", "dashboard", "oauth"] }, "session-created");
    const record = one("SELECT * FROM contexts WHERE handle=?", handle);
    const clientLabel = String(record.client_name || record.oauth_client_id || record.user_agent || record.auth_kind || "remote client").slice(0, 120);
    postOsNotification("session", "✨ New Session", `${sessionNotificationLabel(p, record, 0, now)}\n• 👤 ${clientLabel}`);
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
    changed({ ui: ["sessions", "roots"] }, "session-activity");
    context.last_active_at = now;
    context.protocol_version = observed;
    return { kind: "active", record: context, supplied_handle: handle };
  }
  function getContextRecord(p, handle = "") {
    const context = contextByHandle(p, handle);
    if (!context) throw new Error("Unknown chat_session");
    if (contextExpired(context)) throw new Error("The chat_session has expired");
    return context;
  }
  function selectedContextRoot(p, context) {
    const rootId = Number(context.root_id || 0);
    const root = rootId ? serverRoots(p).find(item => item.id === rootId) : null;
    if (rootId && !root) {
      run("UPDATE contexts SET root_id=0,updated_at=? WHERE handle=?", Date.now(), context.handle);
      changed({ ui: ["sessions", "roots"] }, "session-workspace-repair");
      context.root_id = 0;
    }
    return root ? runtimeWorkspaceRoot(root) : unassignedWorkspaceRoot(p);
  }
  function contextSnapshot(p, context) {
    const roots = serverRoots(p), root = selectedContextRoot(p, context);
    return {
      id: context.id,
      pk: context.id,
      chat_session: context.handle,
      label: context.label || `#${context.id}`,
      expired: contextExpired(context),
      protocol_version: context.protocol_version || "unknown",
      workspace_id: root.id,
      workspace_name: root.name,
      workspace_path: root.path,
      workspace_selected: root.id !== 0,
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
    changed({ ui: ["sessions", "roots", "dashboard"] }, "session-workspace");
    return contextSnapshot(p, getContextRecord(p, context.handle));
  }
  function selectedRoot(p, args = {}) {
    const context = getContextRecord(p, String(args.chat_session || ""));
    return { context, root: selectedContextRoot(p, context) };
  }
  async function resolveWorkspacePath(selection, path = ".", knownRootReal = "") {
    const absolute = await safePath(selection.root.path, path, knownRootReal);
    return {
      ...selection,
      path: absolute,
      display: relative(selection.root.path, absolute).replaceAll("\\", "/") || ".",
    };
  }
  async function workspaceInfo(selection, options = {}) {
    let agentGuidancePath = null;
    const rootReal = await Deno.realPath(selection.root.path);
    for (const name of ["AGENTS.md", "agents.md", "CLAUDE.md", "Claude.md", "claude.md"]) {
      const candidate = await resolveWorkspacePath(selection, name, rootReal).catch(() => null);
      const stat = candidate ? await Deno.stat(candidate.path).catch(() => null) : null;
      if (stat?.isFile) {
        agentGuidancePath = candidate.path;
        break;
      }
    }
    memoryPurgeExpired();
    return {
      workspace_name: selection.root.name,
      cwd: selection.root.path,
      agent_guidance_path: agentGuidancePath,
      workspace_created: !!options.created,
      memory_summary: {
        global: memoryOwnerSummary("global", GLOBAL_MEMORY_OWNER_ID),
        workspace: memoryOwnerSummary("workspace", selection.root.id),
        session: memoryOwnerSummary("session", selection.context.id),
      },
    };
  }
  // Functional document indices are independent of Tool Call history policies.
  const documentSearchTasks = new Map();
  const documentLanceLibrary = () => Deno.build.os === "darwin" && Deno.build.arch === "x86_64"
    ? import("npm:@lancedb/lancedb@0.22.3") : import("npm:@lancedb/lancedb@0.27.2");
  let extractionLibraryPromise;
  function searchConfig(text = Deno.readTextFileSync(SEARCH_PATH)) {
    if (text.length > 262144) throw new Error("Search configuration exceeds 256 KiB");
    const c = parseYaml(text);
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Search configuration must be a YAML mapping");
    const e = c.embedding;
    if (!e || !["ollama", "openai"].includes(e.provider)) throw new Error("embedding.provider must be ollama or openai");
    const httpUrl = value => { const u = new URL(String(value)); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Expected HTTP(S) URL without credentials"); return u; };
    httpUrl(e.endpoint);
    if (typeof e.model !== "string" || typeof e.api_key !== "string") throw new Error("Embedding model and api_key must be strings");
    if (!["native", "disabled"].includes(c.ocr)) throw new Error("ocr must be native or disabled");
    if (c.default_path !== undefined && (typeof c.default_path !== "string" || c.default_path.length > 32768 || c.default_path.includes("\0"))) throw new Error("default_path must be a path string or empty for Desktop/_default");
    return c;
  }
  const searchDefaultDirectory = async c => String(c.default_path || "").trim()
    ? configuredWorkspacePath(c.default_path) : join(await desktopDirectory(), "_default");
  async function searchSelection(selection) {
    if (selection.root?.id) return { ...selection, search_default: false };
    const config = searchConfig(), path = await searchDefaultDirectory(config);
    if (!String(config.default_path || "").trim()) {
      try { await Deno.mkdir(path); }
      catch (error) { if (!(error instanceof Deno.errors.AlreadyExists)) throw error; }
    }
    const real = await Deno.realPath(path);
    if (!(await Deno.stat(real)).isDirectory) throw new Error("Search default_path must be a directory");
    return { ...selection, search_default: true, search_config: config, root: { ...selection.root, path: real } };
  }
  const searchScopeKey = (selection, root) => `${selection.search_default ? "_default" : "workspace"}:${cdpPathKey(root)}`;
  const searchIndexDirectory = (selection, root) => join(DATA_DIR, "search", ...(selection.search_default ? ["_default"] : []), createHash("sha256").update(cdpPathKey(root)).digest("hex"));
  async function searchFileSelection(root, scope, args) {
    const storage = join(DATA_DIR, "search"); await Deno.mkdir(storage, { recursive: true });
    const realStorage = await Deno.realPath(storage);
    if (within(realStorage, scope.path)) throw new Error("Search index storage cannot be searched as source files");
    const exclude = [...(args.exclude || [])];
    if (within(scope.path, realStorage)) {
      const path = slashPath(relative(scope.path, realStorage));
      exclude.push(path, `${path}/**`);
    }
    return { ...args, exclude, root_real: root };
  }
  const searchScopeOutput = (selection, root, dir) => ({ source_directory: root, index_directory: dir, workspace_selected: !!selection.root.id });
  async function searchReadResponse(response, maxBytes) {
    if (!response.ok) { await response.body?.cancel(); const e = new Error(`HTTP ${response.status}`); e.status = response.status; e.retryAfter = response.headers.get("retry-after"); throw e; }
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new Error("Download exceeds byte limit"); }
    const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
    const parts = []; let size = 0;
    try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error("Download exceeds byte limit"); parts.push(value); } }
    catch (e) { await reader.cancel().catch(()=>{}); throw e; }
    finally { reader.releaseLock(); }
    const data = new Uint8Array(size); let offset=0; for (const part of parts) {data.set(part,offset);offset+=part.length;} return data;
  }
  const proxySourceCache = new Map(), proxySourceTasks = new Map();
  function normalizeProxy(value) {
    if (value === "direct") return value;
    if (typeof value !== "string") throw new Error("Proxy entries must be strings");
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) || !u.hostname || !u.port || !["/", ""].includes(u.pathname) || u.search || u.hash) throw new Error("Expected direct or HTTP(S)/SOCKS5 proxy URL with a port");
    return u.href;
  }
  function proxyConfig(text = Deno.readTextFileSync(PROXIES_PATH)) {
    if (text.length > 262144) throw new Error("Proxy configuration exceeds 256 KiB");
    const c = parseYaml(text);
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Proxy configuration must be a YAML mapping");
    if (!Array.isArray(c.proxies) || !Array.isArray(c.proxy_lists) || c.proxies.length + c.proxy_lists.length > 2000) throw new Error("Expected bounded proxies and proxy_lists arrays");
    if (c.proxy_lists.length > 20) throw new Error("Configure at most 20 proxy list sources");
    c.proxies = c.proxies.map(normalizeProxy);
    for (const source of c.proxy_lists) {
      const u = new URL(source); if (typeof source !== "string" || !["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Proxy list sources must be HTTP(S) URLs without credentials");
    }
    for (const [key, min, max] of [["list_ttl_minutes",1,1440],["request_timeout_seconds",1,60],["max_entries",1,10000],["failure_cooldown_seconds",1,86400]])
      if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    if (!c.proxies.length && !c.proxy_lists.length) throw new Error("Configure proxy entries or list sources");
    return c;
  }
  async function proxyPool(c) {
    const errors = [], entries = [...c.proxies];
    // Source requests share one bounded deadline and execute only on explicit tool calls.
    await Promise.all(c.proxy_lists.map(async (source, index) => {
      let cached = proxySourceCache.get(source);
      if (!cached || cached.expires <= Date.now()) {
        let task = proxySourceTasks.get(source);
        if (!task) {
          task = (async () => {
            const response = await fetch(source, { signal: AbortSignal.timeout(c.request_timeout_seconds * 1000) });
            const lines = dec.decode(await searchReadResponse(response, 1048576)).split(/\r?\n/), parsed = [];
            for (const line of lines) { const value = line.trim(); if (!value || value.startsWith("#")) continue;
              try { parsed.push(normalizeProxy(value)); } catch { continue; }
              if (parsed.length >= c.max_entries) break;
            }
            const item = { entries: [...new Set(parsed)], expires: Date.now() + c.list_ttl_minutes * 60000 };
            proxySourceCache.set(source, item); return item;
          })().finally(() => { if (proxySourceTasks.get(source) === task) proxySourceTasks.delete(source); });
          proxySourceTasks.set(source, task);
        }
        try { cached = await task; } catch { errors.push({ source: index + 1, error: "Proxy list download failed or exceeded its timeout/byte limit" }); }
      }
      // Entries are appended later in configured order, independent of fetch completion.
    }));
    for (const source of c.proxy_lists) {
      const cached = proxySourceCache.get(source); if (cached?.expires > Date.now()) entries.push(...cached.entries);
    }
    const configuredSources = new Set(c.proxy_lists); for (const key of proxySourceCache.keys()) if (!configuredSources.has(key)) proxySourceCache.delete(key);
    return { entries: [...new Set(entries)].slice(0, c.max_entries), errors: errors.sort((a,b) => a.source - b.source) };
  }
  const proxyIdentity = proxy => createHash("sha256").update(proxy).digest("hex");
  function proxyStats(id) {
    const row = one("SELECT successes,failures,consecutive_failures,last_selected_at,last_reported_at,cooldown_until FROM proxy_stats WHERE proxy_id=?", id);
    return row || { successes: 0, failures: 0, consecutive_failures: 0, last_selected_at: 0, last_reported_at: 0, cooldown_until: 0 };
  }
  async function proxyGet(args) {
    const c = proxyConfig(), action = args.action || "pick", mode = args.mode || "round_robin", now = Date.now();
    if (action === "report") {
      if (!args.proxy_id || typeof args.success !== "boolean") throw new Error("report requires proxy_id and success");
      if (!one("SELECT 1 AS found FROM proxy_stats WHERE proxy_id=?", args.proxy_id)) throw new Error("Report only proxy_id values previously selected by proxy_get");
      const previous = proxyStats(args.proxy_id), cooldown = args.success ? 0 : now + Math.min(86400000, (args.retry_after_seconds ?? Math.min(86400, c.failure_cooldown_seconds * 2 ** Math.min(10, previous.consecutive_failures))) * 1000);
      run("UPDATE proxy_stats SET successes=successes+?,failures=failures+?,consecutive_failures=?,last_reported_at=?,cooldown_until=? WHERE proxy_id=?", +args.success, +!args.success, args.success ? 0 : previous.consecutive_failures + 1, now, cooldown, args.proxy_id);
      return { action, mode, total: 1, offset: 0, returned: 1, next_offset: null, next_retry_at: null,
        proxies: [{ proxy_id: args.proxy_id, proxy: null, available: args.success || cooldown <= now, stats: proxyStats(args.proxy_id) }], errors: [] };
    }
    if (args.proxy_id != null || args.success != null || args.retry_after_seconds != null) throw new Error("Report arguments require action=report");
    if (action === "pick" && (args.offset ?? 0) !== 0) throw new Error("offset applies only to action=list");
    const pool = await proxyPool(c), clock = Date.now();
    const rows = pool.entries.filter(v => args.include_direct !== false || v !== "direct").map(proxy => {
      const proxy_id = proxyIdentity(proxy), stats = proxyStats(proxy_id);
      return { proxy_id, proxy, stats, available: stats.cooldown_until <= clock };
    });
    let selected, nextOffset = null; const limit = args.limit ?? (action === "list" ? 20 : 1), offset = action === "list" ? args.offset ?? 0 : 0;
    if (action === "list") { selected = rows.slice(offset, offset + limit); if (offset + limit < rows.length) nextOffset = offset + limit; }
    else {
      const eligible = rows.filter(row => row.available); selected = [];
      const weight = row => (row.stats.successes + 1) / (row.stats.successes + row.stats.failures + 2) / (row.stats.consecutive_failures + 1);
      while (eligible.length && selected.length < limit) {
        let index;
        if (mode === "random") {
          let sample = Math.random() * eligible.reduce((sum,row) => sum + weight(row), 0); index = eligible.length - 1;
          for (let i = 0; i < eligible.length; i++) { sample -= weight(eligible[i]); if (sample <= 0) { index = i; break; } }
        } else {
          index = 0;
          for (let i = 1; i < eligible.length; i++) if (eligible[i].stats.last_selected_at < eligible[index].stats.last_selected_at ||
            eligible[i].stats.last_selected_at === eligible[index].stats.last_selected_at && weight(eligible[i]) > weight(eligible[index])) index = i;
        }
        const row = eligible.splice(index, 1)[0];
        // No await between selection and reservation: concurrent calls cannot race the cursor.
        const cursor = Math.max(clock, Number(one("SELECT COALESCE(MAX(last_selected_at),0) AS last FROM proxy_stats").last) + 1);
        run("INSERT INTO proxy_stats(proxy_id,last_selected_at) VALUES(?,?) ON CONFLICT(proxy_id) DO UPDATE SET last_selected_at=excluded.last_selected_at", row.proxy_id, cursor);
        row.stats = proxyStats(row.proxy_id); selected.push(row);
      }
    }
    const paused = rows.filter(row => !row.available).map(row => row.stats.cooldown_until);
    return { action, mode, total: rows.length, offset, returned: selected.length, next_offset: nextOffset,
      next_retry_at: action === "pick" && !selected.length && paused.length ? Math.min(...paused) : null, proxies: selected, errors: pool.errors };
  }

  async function documentExtractionLibrary() {
    return extractionLibraryPromise ||= (async()=>{
      let x, wasmBackend=false;
      if(Deno.build.os==="darwin" && Deno.build.arch==="x86_64") {
        const wasm=await import("npm:@xberg-io/xberg-wasm@1.3.2");wasmBackend=true;
        await wasm.default();
        x={...wasm,extract:async(input,options={})=>{
          const wi=wasm.WasmExtractInput.fromBytes(input.bytes,input.mimeType,input.filename),wc=wasm.WasmExtractionConfig.default();
          wc.disableOcr=!!options.disableOcr;wc.useCache=false;
          if(options.ocr){const oc=wasm.WasmOcrConfig.default();oc.backend=options.ocr.backend;wc.ocr=oc;oc.free();}
          // extract takes ownership of input/config; getters return owned result copies.
          const result=await wasm.extract(wi,wc),docs=result.results,errors=result.errors;
          try{return {results:docs.map(v=>({content:v.content,mimeType:v.mimeType})),errors:errors.map(v=>({message:v.message}))};}
          finally{docs.forEach(v=>v.free());errors.forEach(v=>v.free());result.free();}
        }};
      } else x=await import("npm:@xberg-io/xberg@1.3.2");
      const processImage=async argument=>{
        // NAPI 1.3.2 sends callback arguments in one tuple despite its TS signature.
        const raw=Array.isArray(argument)&&(Array.isArray(argument[0])||argument[0] instanceof Uint8Array)?argument[0]:argument;
        const bytes=raw instanceof Uint8Array?raw:Uint8Array.from(raw);
        const image=await auto.vips.decodeImage(bytes), result=await auto.ocr({provider:"native",image});
        if(!result)throw new Error("Native OS OCR is unavailable for this image/platform or no installed OCR language is available");
        const document={content:result.text||"",mimeType:"text/plain",metadata:{additional:{ocr_provider:"native-os"}},tables:[]};
        // WASM's public trait bridge consumes serialized Rust document fields.
        return wasmBackend?JSON.stringify({content:document.content,mime_type:document.mimeType,metadata:document.metadata,tables:[],counts:{pages:0,tables:0,images:0},processing_warnings:[],formulas:[],form_fields:[]}):document;
      };
      // Public Xberg plugin hooks; never patch package internals or load an OCR engine.
      x.registerOcrBackend({name:()=>"mrmcp-native-os",version:()=>"1",initialize:()=>{},shutdown:()=>{},processImage,processImageFile:async path=>processImage(await Deno.readFile(Array.isArray(path)?path[0]:path)),processDocument:async()=>{throw new Error("Document-level OCR unsupported; use Xberg page rasterization");},supportsLanguage:()=>true,supportedLanguages:()=>[],supportedLanguagesFor:()=>[],supportsLanguageFor:()=>true,backendType:()=>"custom",supportsTableDetection:()=>false,supportsDocumentProcessing:()=>false,emitsStructuredMarkdown:()=>false,confidenceSemantics:()=>"uncalibrated",pageOrientationHandling:()=>"requires_upright"});
      return x;
    })().catch(e=>{extractionLibraryPromise=null;throw e;});
  }
  async function searchEmbedding(texts,c,signal) {
    const e=c.embedding;if(!e.model.trim())throw new Error("Vector/hybrid search requires embedding.model in Settings → Search");
    const base=e.endpoint.replace(/\/$/,""), ollama=e.provider==="ollama";
    const response=await fetch(`${base}${ollama?"/api/embed":"/embeddings"}`,{method:"POST",headers:{"content-type":"application/json",...(e.api_key?{authorization:`Bearer ${e.api_key}`}:{})},body:JSON.stringify({model:e.model,input:texts,...(ollama?{truncate:false}:{})}),signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    const packet=JSON.parse(new TextDecoder().decode(await searchReadResponse(response,8388608)));
    const vectors=ollama?packet.embeddings:packet.data?.slice().sort((a,b)=>a.index-b.index).map(v=>v.embedding);
    if(!Array.isArray(vectors)||vectors.length!==texts.length||!vectors.every(v=>Array.isArray(v)&&v.length>0&&v.length<=16384&&v.every(Number.isFinite)&&v.length===vectors[0].length))throw new Error("Invalid or inconsistent embedding response");
    return vectors;
  }
  const searchSql = value => `'${String(value).replaceAll("'","''")}'`;
  function searchChunks(text,source,hash,mime) {
    const lines=String(text).split(/\r?\n/), out=[];let buffer=[],size=0,start=1,end=1;
    const flush=()=>{if(!buffer.length)return;const content=buffer.join("\n");out.push({id:createHash("sha256").update(`${source}\0${hash}\0${out.length}`).digest("hex"),path:source,mime,hash,chunk:out.length,text:content,start_line:start,end_line:end});buffer=[];size=0;};
    for(let i=0;i<lines.length;i++){
      let line=lines[i];
      do{let cut=Math.min(2400,line.length);if(cut<line.length&&/[\uD800-\uDBFF]/.test(line[cut-1]))cut--;const part=line.slice(0,cut);line=line.slice(cut);
        if(size+part.length+1>2400&&buffer.length)flush();if(!buffer.length)start=i+1;end=i+1;buffer.push(part);size+=part.length+1;if(line.length)flush();
      }while(line.length);
    }flush();return out;
  }
  async function documentGrep(selection,args) {
    if(!String(args.query||"").trim())throw new Error("query must contain non-whitespace text");
    const c=selection.search_config||searchConfig(), mode=args.mode||"auto", effective=mode==="auto"?(c.embedding.model.trim()?"hybrid":"fulltext"):mode;
    if(effective!=="fulltext"&&!c.embedding.model.trim())throw new Error("Configure embedding.model in Settings → Search for vector/hybrid mode, or use fulltext/auto");
    const root=await Deno.realPath(selection.root.path), scope=await resolveWorkspacePath(selection,args.path||".",root), base=scope.path, key=searchScopeKey(selection,root), walkOptions=await searchFileSelection(root,scope,args);
    while(documentSearchTasks.has(key))await documentSearchTasks.get(key);
    let release;documentSearchTasks.set(key,new Promise(r=>{release=r;}));
    try {
      const lance=await documentLanceLibrary(), x=await documentExtractionLibrary();
      const dir=searchIndexDirectory(selection,root);await Deno.mkdir(dir,{recursive:true});
      const connection=await lance.connect(dir), manifestPath=join(dir,"manifest.json");
      let manifest;try {manifest=JSON.parse(await Deno.readTextFile(manifestPath));}catch(e){if(!(e instanceof Deno.errors.NotFound))throw e;manifest={};}
      const names=await connection.tableNames(), table=names.includes("chunks")?await connection.openTable("chunks"):null;
      let chunksTable=table, changed=0, unchanged=0, removed=0, scanned=0,totalBytes=0,truncated=false;const errors=[], eligible=new Set(), discovered=new Set(), replacements=[], deletions=[];
      const mimeMatches=mime=>!args.mime?.length||args.mime.some(v=>v.endsWith("/*")?mime.startsWith(v.slice(0,-1)):mime===v);
      const baseStat=await Deno.lstat(base), include=compileGlobs(args.include?.length?args.include:["**/*"]),exclude=compileGlobs(walkOptions.exclude,[]);
      const selectedPath=path=>{
        if(/^https:\/\//.test(path))return false;
        const absolute=resolve(root,path), local=baseStat.isFile?basename(absolute):slashPath(relative(base,absolute));
        return (baseStat.isFile?absolute===base:!local.startsWith("../")&&!isAbsolute(local))&&(args.hidden||!local.split("/").some(v=>v.startsWith(".")))&&matchesGlobs(local,include)&&!excludedByGlobs(local,exclude);
      };
      const extractionSignature=`xberg1.3.2:${c.ocr}:chunks1`;
      const indexSource=async (source,mime,bytes,input)=>{
        const hash=createHash("sha256").update(bytes).update(extractionSignature).digest("hex");
        if(manifest[source]?.hash===hash){unchanged++;eligible.add(source);return;}
        const result=await x.extract(input,c.ocr==="native"?{ocr:{backend:"mrmcp-native-os"},useCache:false}:{disableOcr:true,useCache:false});
        if(result.errors?.length)throw new Error(result.errors.map(v=>v.message||v.error||"Extraction failed").join("; "));
        const text=result.results.map(v=>v.content).filter(Boolean).join("\n\n");
        if(text.length>8388608)throw new Error("Extracted document exceeds 8 MiB");
        if(!text.trim())throw new Error("Extraction returned no searchable text");
        const chunks=searchChunks(text,source,hash,mime);if(replacements.length+chunks.length>20000)throw new Error("Selected extraction exceeds 20,000 chunks");
        replacements.push(...chunks);deletions.push(source);manifest[source]={hash,mime,chunks:chunks.length};eligible.add(source);changed++;
      };
      try {
        let walked=0;
        for await(const entry of fsWalkEntries(root,scope.display,{...walkOptions,gitignore:args.gitignore!==false,hidden:!!args.hidden,hard_limit:100000})) {
          if(++walked>=100000){truncated=true;break;}
          if(entry.type!=="file")continue;
          const mime=(mediaContentType(extname(entry.path))||"application/octet-stream").split(";")[0];if(!mimeMatches(mime))continue;
          if(scanned>=(args.max_files??1000)){truncated=true;break;}scanned++;
          discovered.add(entry.path);
          if(entry.size>(args.max_file_bytes??20971520)){errors.push({path:entry.path,error:"File exceeds max_file_bytes"});continue;}
          try {
            const path=await safePath(root,entry.path,root);if(cdpPathKey(path).startsWith(cdpPathKey(dir)+sep))continue;
            const bytes=await Deno.readFile(path);if(bytes.length>(args.max_file_bytes??20971520))throw new Error("File grew beyond max_file_bytes");totalBytes+=bytes.length;if(totalBytes>67108864){truncated=true;break;}
            await indexSource(entry.path,mime,bytes,{kind:"bytes",bytes,mimeType:mime,filename:basename(path)});
          }catch(e){errors.push({path:entry.path,error:String(e.message||e).slice(0,1000)});}
        }
      }catch(e){truncated=true;errors.push({path:args.path||".",error:String(e.message||e).slice(0,1000)});}
      // Only prune paths proven inside this complete requested glob/MIME selection.
      if(!truncated)for(const [path,v] of Object.entries(manifest))if(selectedPath(path)&&mimeMatches(v.mime)&&!discovered.has(path)){deletions.push(path);delete manifest[path];removed++;}
      if(chunksTable && deletions.length)await chunksTable.delete(`path IN (${[...new Set(deletions)].map(searchSql).join(",")})`);
      for(const name of names.filter(v=>v.startsWith("vectors_")))if(deletions.length){const vt=await connection.openTable(name);await vt.delete(`path IN (${[...new Set(deletions)].map(searchSql).join(",")})`);}
      if(replacements.length){
        if(!chunksTable){chunksTable=await connection.createTable("chunks",replacements);await chunksTable.createIndex("text",{config:lance.Index.fts({stem:false})});}
        else await chunksTable.add(replacements);
      }
      const temporary=manifestPath+".tmp";await Deno.writeTextFile(temporary,JSON.stringify(manifest));await Deno.rename(temporary,manifestPath);
      const paths=[...eligible], filter=paths.length?`path IN (${paths.map(searchSql).join(",")})`:"false", limit=args.limit??10;
      let hits=[],indexedChunks=0;
      if(chunksTable && paths.length){
        indexedChunks=await chunksTable.countRows(filter);
        const lexical=effective!=="vector"?await chunksTable.search(args.query).where(filter).limit(effective==="hybrid"?Math.min(100,limit*4):limit).toArray():[];
        let vectors=[];
        if(effective!=="fulltext"){
          const signature=createHash("sha256").update(JSON.stringify([c.embedding.provider,c.embedding.endpoint,c.embedding.model])).digest("hex").slice(0,24),name=`vectors_${signature}`;
          let vt=names.includes(name)?await connection.openTable(name):null;
          const rows=await chunksTable.query().where(filter).limit(20001).toArray();if(rows.length>20000)throw new Error("Vector selection exceeds 20,000 chunks; narrow globs");
          const validIds=rows.map(v=>v.id), vf=`id IN (${validIds.map(searchSql).join(",")})`;
          const existing=vt?new Set((await vt.query().where(vf).select(["id"]).limit(20001).toArray()).map(v=>v.id)):new Set();
          const missing=rows.filter(v=>!existing.has(v.id)), signal=AbortSignal.timeout(300000);
          for(let offset=0;offset<missing.length;offset+=32){const batch=missing.slice(offset,offset+32),embedded=await searchEmbedding(batch.map(v=>v.text),c,signal),data=batch.map((v,i)=>({...v,vector:embedded[i]}));if(vt)await vt.add(data);else vt=await connection.createTable(name,data);}
          const [vector]=await searchEmbedding([args.query],c,signal);vectors=await vt.search(vector).where(vf).limit(effective==="hybrid"?Math.min(100,limit*4):limit).toArray();
        }
        if(effective==="hybrid"){
          const ranked=new Map();for(const group of [lexical,vectors])group.forEach((v,i)=>{const old=ranked.get(v.id);ranked.set(v.id,{...v,rrf:(old?.rrf||0)+1/(60+i+1)});});hits=[...ranked.values()].sort((a,b)=>b.rrf-a.rrf||a.id.localeCompare(b.id)).slice(0,limit);
        }else hits=effective==="vector"?vectors:lexical;
      }
      return {...searchScopeOutput(selection,root,dir),mode:effective,gitignore:args.gitignore!==false,indexed_files:eligible.size,indexed_chunks:indexedChunks,reindexed_files:changed,unchanged_files:unchanged,removed_files:removed,scanned_files:scanned,truncated,error_count:errors.length,errors:errors.slice(0,100),returned:hits.length,results:hits.map(v=>({id:v.id,path:v.path,mime:v.mime,chunk:v.chunk,text:v.text,start_line:v.start_line,end_line:v.end_line,score:Number(v.rrf??v._score??-v._distance)}))};
    }finally{documentSearchTasks.delete(key);release();}
  }

  const SOURCE_CODE_ACTIONS = ["search", "map", "files", "chunks", "stats"];
  // Languages with actual extractors in the pinned public Lucerna version.
  const SOURCE_CODE_LANGUAGES = ["javascript","typescript","json","markdown","go","c","cpp","zig","html","python","yaml","php","java","rust","csharp","kotlin","swift","ruby","bash","powershell","sql","css","scss","vue","svelte","toml","lua","r","scala","dart","perl","haskell","elixir","clojure","matlab","groovy","solidity","julia","ocaml","erlang","objc"];
  const SOURCE_CODE_LANGUAGE_ALIASES = { "c++": "cpp", "c#": "csharp", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", yml: "yaml", sh: "bash", shell: "bash", shellscript: "bash", ps1: "powershell", md: "markdown", "objective-c": "objc", ocaml_interface: "ocaml" };
  const sourceCodeLanguageName = value => {
    const name = String(value).trim().toLowerCase();
    return SOURCE_CODE_LANGUAGE_ALIASES[name] || name;
  };
  const sourceCodeLanguage = (lib, path) => {
    const extension = extname(path);
    const override = extension === ".C" ? "cpp" : ({ ".c++": "cpp", ".h++": "cpp", ".hh": "cpp", ".phtml": "php", ".phps": "php", ".php3": "php", ".php4": "php", ".php5": "php", ".php7": "php", ".php8": "php" })[extension.toLowerCase()];
    const detected = override || lib.TreeSitterChunker.detectLanguage(path.toLowerCase());
    const language = detected && sourceCodeLanguageName(detected);
    return SOURCE_CODE_LANGUAGES.includes(language) ? language : null;
  };
  const sourceCodeTasks = new Map();
  let lucernaPromise;
  function loadLucernaIntelParser(requireModule = createRequire(SELF.href), bindingPath = fileURLToPath(import.meta.resolve("npm:@kreuzberg/tree-sitter-language-pack-darwin-x64@1.10.9")), parserPath = fileURLToPath(import.meta.resolve("npm:@kreuzberg/tree-sitter-language-pack@1.6.2"))) {
    // Public NAPI loader option. Synchronous loading prevents Tool Call interleaving.
    const previous = Deno.env.get("NAPI_RS_NATIVE_LIBRARY_PATH");
    try {
      Deno.env.set("NAPI_RS_NATIVE_LIBRARY_PATH", bindingPath);
      requireModule(parserPath);
    } finally {
      if (previous === undefined) Deno.env.delete("NAPI_RS_NATIVE_LIBRARY_PATH");
      else Deno.env.set("NAPI_RS_NATIVE_LIBRARY_PATH", previous);
    }
  }
  const sourceCodeLibrary = () => lucernaPromise ||= Promise.resolve().then(() => {
    if (Deno.build.os === "darwin" && Deno.build.arch === "x86_64") loadLucernaIntelParser();
    return import("npm:@upstart.gg/lucerna@0.2.9");
  }).catch(error => {
    lucernaPromise = null;
    throw new Error(`Lucerna parser could not load (${lucernaParserPackage.version}; macOS companion ${lucernaMacPackage.version}): ${error.message}`);
  });
  const sourceCodeWords = text => (String(text).match(/[\p{L}\p{N}_]+/gu) || []).flatMap(word => [...new Set([
    word, ...word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").split(/[\s_]+/).filter(Boolean),
  ])]);
  async function sourceCodeSearch(selection, args) {
    const action = args.action || "search", limit = args.limit ?? 10, offset = args.offset ?? 0;
    if (action === "search" && !String(args.query || "").trim()) throw new Error("search requires a nonempty query");
    if (action === "chunks" && !args.file_path) throw new Error("chunks requires file_path");
    const root = await Deno.realPath(selection.root.path), scope = await resolveWorkspacePath(selection, args.path || ".", root);
    if (args.file_path && !/[?*]/.test(args.file_path)) await safePath(root, args.file_path, root);
    const walkOptions = await searchFileSelection(root, scope, args), key = searchScopeKey(selection, root), dir = searchIndexDirectory(selection, root);
    // Only this source index is serialized; unrelated Tool Calls stay concurrent.
    while (sourceCodeTasks.has(key)) await sourceCodeTasks.get(key);
    let release; sourceCodeTasks.set(key, new Promise(resolveTask => { release = resolveTask; }));
    let index;
    try {
      await Deno.mkdir(dir, { recursive: true });
      index = new DatabaseSync(join(dir, "lucerna.sqlite"));
      index.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS indexed_files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, signature TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS indexed_chunks(row_id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL REFERENCES indexed_files(path) ON DELETE CASCADE, chunk_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS indexed_chunks_path ON indexed_chunks(path);
        CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(content,content='',contentless_delete=1,tokenize='unicode61');
        CREATE TEMP TABLE search_scope(path TEXT PRIMARY KEY);`);
      const readFile = index.prepare("SELECT hash,signature FROM indexed_files WHERE path=?");
      const deleteText = index.prepare("DELETE FROM source_fts WHERE rowid IN (SELECT row_id FROM indexed_chunks WHERE path=?)");
      const deleteFile = index.prepare("DELETE FROM indexed_files WHERE path=?");
      const writeFile = index.prepare("INSERT INTO indexed_files(path,hash,signature) VALUES(?,?,?)");
      const writeChunk = index.prepare("INSERT INTO indexed_chunks(chunk_id,path,chunk_json) VALUES(?,?,?)");
      const writeText = index.prepare("INSERT INTO source_fts(rowid,content) VALUES(?,?)");
      const selectFile = index.prepare("INSERT INTO search_scope(path) VALUES(?)");
      const transaction = operation => {
        index.exec("BEGIN IMMEDIATE");
        try { operation(); index.exec("COMMIT"); }
        catch (error) { index.exec("ROLLBACK"); throw error; }
      };
      const removeFile = path => { deleteText.run(path); deleteFile.run(path); };
      const lib = await sourceCodeLibrary(), parser = new lib.TreeSitterChunker();
      const signature = `lucerna0.2.9:${lucernaParserPackage.version}:${lucernaMacPackage.version}:${Deno.build.os}:${Deno.build.arch}:words1:languages3`;
      const projectId = createHash("sha256").update(cdpPathKey(root)).digest("hex").slice(0, 16);
      const files = [], discovered = new Set(), errors = [];
      const maxFiles = args.max_files ?? 5000, maxFileBytes = args.max_file_bytes ?? 1048576;
      let parserReady = false, scanned = 0, bytes = 0, changed = 0, unchanged = 0, removed = 0;
      let skippedLarge = 0, skippedUnsupported = 0, errorCount = 0, truncationReason = null;
      const addError = (path, error) => { errorCount++; if (errors.length < 100) errors.push({ path, error: String(error?.message || error).slice(0, 500) }); };
      try {
        for await (const entry of fsWalkEntries(root, scope.display, { ...walkOptions, hidden: args.hidden === true, gitignore: true, hard_limit: 100001 })) {
          if (++scanned > 100000) { truncationReason = "walk_limit"; break; }
          if (entry.type !== "file") continue;
          discovered.add(entry.path);
          const language = sourceCodeLanguage(lib, entry.path);
          if (!language) { skippedUnsupported++; continue; }
          if (entry.size > maxFileBytes) { skippedLarge++; continue; }
          if (files.length >= maxFiles) { truncationReason = "max_files"; break; }
          try {
            const absolute = await safePath(root, entry.path, root), source = await Deno.readFile(absolute);
            if (source.byteLength > maxFileBytes) { skippedLarge++; continue; }
            if (bytes + source.byteLength > 33554432) { truncationReason = "total_bytes"; break; }
            bytes += source.byteLength;
            const hash = createHash("sha256").update(source).digest("hex"), previous = readFile.get(entry.path);
            if (previous?.hash === hash && previous.signature === signature) unchanged++;
            else {
              if (!parserReady) { await parser.initialize(); parserReady = true; }
              const text = decodeTextDocument(source, "auto", "full").text;
              const parsed = await parser.chunkSource(text, entry.path, projectId, language);
              // Lucerna ids use file/start-line: distinct symbols on one line can collide.
              const reservedIds = new Set(parsed.map(chunk => chunk.id)), writtenIds = new Set();
              for (let i = 0; i < parsed.length; i++) {
                const chunk = parsed[i];
                if (writtenIds.has(chunk.id)) {
                  let id, salt = 0;
                  do { id = createHash("sha256").update(JSON.stringify([chunk.id, chunk.type, chunk.name, chunk.startLine, chunk.endLine, chunk.content, i, salt++])).digest("hex"); }
                  while (reservedIds.has(id) || writtenIds.has(id));
                  parsed[i] = { ...chunk, id, metadata: { ...chunk.metadata, lucerna_id: chunk.id } };
                }
                writtenIds.add(parsed[i].id);
              }
              transaction(() => {
                removeFile(entry.path); writeFile.run(entry.path, hash, signature);
                for (const chunk of parsed) {
                  const inserted = writeChunk.run(chunk.id, entry.path, JSON.stringify(chunk));
                  writeText.run(inserted.lastInsertRowid, sourceCodeWords(`${chunk.name || ""} ${chunk.content}`).join(" "));
                }
              });
              changed++;
            }
            files.push(entry.path); selectFile.run(entry.path);
          } catch (error) { addError(entry.path, error); }
        }
      } catch (error) { addError(scope.display, error); truncationReason ||= "walk_error"; }
      finally { await parser.close(); }
      // Unseen paths are pruned only inside a completely traversed path/glob scope.
      if (!truncationReason) {
        const stat = await Deno.lstat(scope.path), include = compileGlobs(args.include?.length ? args.include : ["**/*"]), exclude = compileGlobs(walkOptions.exclude, []);
        const selected = path => {
          const absolute = resolve(root, path), local = stat.isFile ? basename(absolute) : slashPath(relative(scope.path, absolute));
          return (stat.isFile ? absolute === scope.path : within(scope.path, absolute)) && (args.hidden || !local.split("/").some(v => v.startsWith("."))) && matchesGlobs(local, include) && !excludedByGlobs(local, exclude);
        };
        const absent = index.prepare("SELECT path FROM indexed_files").all().filter(row => selected(row.path) && !discovered.has(row.path));
        if (absent.length) transaction(() => { for (const row of absent) { removeFile(row.path); removed++; } });
      }
      const rows = index.prepare("SELECT row_id,chunk_json FROM indexed_chunks JOIN search_scope USING(path) ORDER BY row_id").all();
      const chunks = rows.map(row => JSON.parse(row.chunk_json));
      const byId = new Map(chunks.map(chunk => [chunk.id, chunk])), byRow = new Map(rows.map((row, i) => [Number(row.row_id), chunks[i]]));
      const store = {
        getChunksByIds: async ids => ids.map(id => byId.get(id)).filter(Boolean),
        getChunksByFile: async path => chunks.filter(chunk => chunk.filePath === path),
        searchText: async (query, options) => {
          const words = [...new Set(sourceCodeWords(query).map(word => word.toLowerCase()))];
          if (!words.length) return [];
          const languages = options.language == null ? null : (Array.isArray(options.language) ? options.language : [options.language]).map(sourceCodeLanguageName);
          const paths = options.filePath ? compileGlobs([options.filePath]) : null;
          const found = index.prepare(`SELECT indexed_chunks.row_id FROM source_fts JOIN indexed_chunks ON indexed_chunks.row_id=source_fts.rowid
            JOIN search_scope ON search_scope.path=indexed_chunks.path WHERE source_fts MATCH ? ORDER BY bm25(source_fts),indexed_chunks.row_id`).all(words.map(word => `"${word}"`).join(" OR "));
          return found.map(row => byRow.get(Number(row.row_id))).filter(chunk =>
            (!languages || languages.includes(chunk.language)) && (!options.types?.length || options.types.includes(chunk.type)) && (!paths || matchesGlobs(chunk.filePath, paths))
          ).slice(0, options.limit ?? 10).map(chunk => ({ chunk, matchType: "lexical" }));
        },
      };
      const options = { limit: offset + limit + 1, language: args.language, types: args.types, filePath: args.file_path };
      let data, results, nextOffset = null;
      if (action === "search") results = await new lib.Searcher(store, false, false).searchLexical(args.query, options);
      else if (action === "chunks") results = await store.getChunksByFile(slashPath(args.file_path));
      else if (action === "files") results = files;
      else if (action === "map") results = chunks.filter(chunk => chunk.name && (!args.types?.length || args.types.includes(chunk.type))).map(({ id, filePath, type, name, startLine, endLine }) => ({ id, filePath, type, name, startLine, endLine }));
      else data = { stats: { files: files.length, chunks: chunks.length, by_language: Object.fromEntries([...new Set(chunks.map(chunk => chunk.language))].map(language => [language, chunks.filter(chunk => chunk.language === language).length])) } };
      let returned = 0;
      if (results) {
        if (results.length > offset + limit) nextOffset = offset + limit;
        results = results.slice(offset, offset + limit); returned = results.length; data = { results };
      }
      if (args.include_content === false) {
        const strip = value => Array.isArray(value) ? value.map(strip) : !value || typeof value !== "object" ? value
          : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "content" && key !== "contextContent").map(([key, item]) => [key, strip(item)]));
        data = strip(data);
      }
      return { ...searchScopeOutput(selection, root, dir), action, mode: "lexical", gitignore: true, path: scope.display, indexed_files: files.length, indexed_chunks: chunks.length,
        reindexed_files: changed, unchanged_files: unchanged, removed_files: removed, scanned_files: scanned,
        skipped_large_files: skippedLarge, skipped_unsupported_files: skippedUnsupported, error_count: errorCount, errors, truncation_reason: truncationReason,
        truncated: !!truncationReason || nextOffset != null, returned, next_offset: nextOffset, data };
    } finally { try { index?.close(); } finally { sourceCodeTasks.delete(key); release(); } }
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
    return selectCommandArchiveEntry(files, row);
  }
  function selectCommandArchiveEntry(files, row) {
    if (row.archive_path) {
      const found = files.find(entry => entry.name.replaceAll("\\", "/").replace(/^\.\//, "") === row.archive_path);
      if (!found) throw new Error(`Archive entry not found: ${row.archive_path}`);
      return found;
    }
    const bases = [...new Set([basename(String(row.path || row.name)), basename(row.name)].map(v => v.toLowerCase()))];
    for (const base of bases) for (const wanted of [base, ...WINDOWS_EXECUTABLE_SUFFIXES.map(suffix => base + suffix)]) {
      const found = files.filter(entry => basename(entry.name.replaceAll("\\", "/")).toLowerCase() === wanted);
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new Error(`Ambiguous archive entry ${wanted}; configure archive_path`);
    }
    throw new Error(`Archive does not contain an unambiguous executable for ${row.name}`);
  }
  function tarCommandEntries(bytes) {
    const entries = []; let offset = 0, extended = {}, longName = "";
    const text = (start, length) => dec.decode(bytes.subarray(start, start + length)).split("\0")[0];
    while (offset + 512 <= bytes.length) {
      if (bytes.subarray(offset, offset + 512).every(v => v === 0)) break;
      let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : bytes[offset + i];
      if (parseInt(text(offset + 148, 8).trim(), 8) !== checksum) throw new Error("Invalid TAR header checksum");
      const sizeText = text(offset + 124, 12).trim();
      if (!/^[0-7]+$/.test(sizeText)) throw new Error("Unsupported TAR size encoding");
      const size = parseInt(sizeText, 8), data = offset + 512, type = text(offset + 156, 1);
      if (!Number.isSafeInteger(size) || size < 0 || data + size > bytes.length) throw new Error("Truncated TAR entry");
      const prefix = text(offset + 345, 155), name = longName || extended.path || [prefix, text(offset, 100)].filter(Boolean).join("/");
      if (type === "x" || type === "g") {
        if (size > 1048576) throw new Error("TAR metadata exceeds limit");
        let p = data; const fields = {};
        while (p < data + size) {
          const space = bytes.indexOf(32, p); if (space < 0 || space >= data + size) throw new Error("Invalid TAR PAX record");
          const length = Number(text(p, space - p)); if (!Number.isSafeInteger(length) || length <= space - p + 1 || p + length > data + size) throw new Error("Invalid TAR PAX length");
          const record = dec.decode(bytes.subarray(space + 1, p + length - 1)), equal = record.indexOf("=");
          if (equal > 0) fields[record.slice(0, equal)] = record.slice(equal + 1); p += length;
        }
        if (type === "x") extended = fields;
      } else if (type === "L") { if (size > 1048576) throw new Error("TAR name exceeds limit"); longName = text(data, size); }
      else { if (type === "" || type === "0") entries.push({ name, offset: data, size }); extended = {}; longName = ""; }
      offset = data + Math.ceil(size / 512) * 512;
    }
    return entries;
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
  function normalizeCommandPlatforms(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("platforms must be a YAML mapping");
    const result = {};
    for (const [key, variant] of Object.entries(value)) {
      if (!/^(windows|linux|darwin)(-(x86_64|aarch64))?$/.test(key)) throw new Error(`Unsupported platform key: ${key}`);
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) throw new Error(`Platform ${key} must be a mapping`);
      if (Object.keys(variant).some(field => !["path", "download_url", "archive_path"].includes(field))) throw new Error(`Unknown field in platform ${key}`);
      result[key] = {};
      for (const field of ["path", "download_url", "archive_path"]) if (variant[field] != null) {
        if (typeof variant[field] !== "string") throw new Error(`${key}.${field} must be a string`);
        result[key][field] = variant[field].trim();
      }
    }
    return result;
  }
  function normalizeCommandEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each commands.yaml entry must be an object");
    const name = String(entry.logical_name || "").trim();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(name)) throw new Error(`Invalid logical_name in commands.yaml: ${name || "(empty)"}`);
    return { name, logical_name: name, path: String(entry.path || "").trim() || name,
      description: String(entry.description || "").trim(), download_url: String(entry.download_url || "").trim(),
      archive_path: String(entry.archive_path || "").trim(), documentation_url: String(entry.documentation_url || "").trim(),
      platforms: normalizeCommandPlatforms(entry.platforms) };
  }
  function commandPlatform(row, os = Deno.build.os, arch = Deno.build.arch) {
    const variants = row.platforms || {}, key = `${os}-${arch}`, variant = variants[key] ?? variants[os];
    return { path: variant?.path || row.path, download_url: variant?.download_url ?? row.download_url,
      archive_path: variant?.archive_path ?? row.archive_path, supported: !Object.keys(variants).length || variant !== undefined };
  }
  async function validateCommandEntry(row) {
    for (const entry of [row, ...Object.values(row.platforms)]) {
      if (entry.path) await binPath(entry.path);
      if (entry.archive_path && (entry.archive_path.startsWith("/") || entry.archive_path.split(/[\\/]/).includes(".."))) throw new Error("archive_path must be a relative archive entry");
      const warning = httpUrlWarning(entry.download_url, "Download URL"); if (warning) throw new Error(warning);
    }
    const warning = httpUrlWarning(row.documentation_url, "Documentation URL"); if (warning) throw new Error(warning);
  }
  async function commandPlatformsWarning(text) {
    try { await validateCommandEntry(normalizeCommandEntry({ logical_name: "probe", platforms: parseYaml(text || "{}") })); return ""; }
    catch (e) { return e.message; }
  }
  async function readCommandConfig() {
    let source;
    try { source = await Deno.readTextFile(COMMANDS_PATH); }
    catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; return []; }
    const document = parseYaml(source || "commands: []", { schema: "core" });
    if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.commands)) throw new Error("commands.yaml must contain a commands array");
    const rows = document.commands.map(normalizeCommandEntry), names = new Set();
    for (const row of rows) {
      const key = row.name.toLowerCase(); if (names.has(key)) throw new Error(`Duplicate logical_name in commands.yaml: ${row.name}`);
      names.add(key); await validateCommandEntry(row);
    }
    return rows;
  }
  async function writeCommandConfig(rows) {
    const commands = rows.map(row => ({ logical_name: row.name, ...(row.path !== row.name ? { path: row.path } : {}),
      description: row.description || "", ...(row.download_url ? { download_url: row.download_url } : {}),
      ...(row.archive_path ? { archive_path: row.archive_path } : {}), documentation_url: row.documentation_url || "",
      ...(Object.keys(row.platforms || {}).length ? { platforms: row.platforms } : {}) }));
    const temporary = `${COMMANDS_PATH}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, stringifyYaml({ commands }, { lineWidth: -1 }));
    if (Deno.build.os === "windows") await Deno.remove(COMMANDS_PATH).catch(e => { if (!(e instanceof Deno.errors.NotFound)) throw e; });
    await Deno.rename(temporary, COMMANDS_PATH);
  }

  function normalizeGuidedPromptArgument(argument, promptName) {
    if (!argument || typeof argument !== "object" || Array.isArray(argument))
      throw new Error(`Each argument for ${promptName} must be an object`);
    const name = String(argument.name || "").trim();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(name)) throw new Error(`Invalid argument name for ${promptName}: ${name || "(empty)"}`);
    return {
      name,
      ...(String(argument.title || "").trim() ? { title: String(argument.title).trim() } : {}),
      ...(String(argument.description || "").trim() ? { description: String(argument.description).trim() } : {}),
      ...(argument.required === true ? { required: true } : {}),
    };
  }
  function normalizeGuidedPromptEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each guided_prompts.yaml entry must be an object");
    const name = String(entry.name || "").trim();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(name)) throw new Error(`Invalid prompt name in guided_prompts.yaml: ${name || "(empty)"}`);
    const args = Array.isArray(entry.arguments) ? entry.arguments.map(argument => normalizeGuidedPromptArgument(argument, name)) : [];
    const argNames = new Set();
    for (const argument of args) {
      const key = argument.name.toLowerCase();
      if (argNames.has(key)) throw new Error(`Duplicate argument ${argument.name} for prompt ${name}`);
      argNames.add(key);
    }
    const template = String(entry.template || "");
    if (!template.trim()) throw new Error(`Prompt ${name} requires a non-empty template`);
    return {
      name,
      title: String(entry.title || "").trim(),
      description: String(entry.description || "").trim(),
      arguments: args,
      template,
    };
  }
  async function readGuidedPromptConfig() {
    let source;
    try { source = await Deno.readTextFile(GUIDED_PROMPTS_PATH); }
    catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      return [];
    }
    const document = parseYaml(source || "prompts: []", { schema: "core" });
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("guided_prompts.yaml must contain a mapping");
    if (!Array.isArray(document.prompts)) throw new Error("guided_prompts.yaml must contain a prompts array");
    const rows = document.prompts.map(normalizeGuidedPromptEntry), names = new Set();
    for (const row of rows) {
      const key = row.name.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate prompt name in guided_prompts.yaml: ${row.name}`);
      names.add(key);
    }
    return rows;
  }
  async function writeGuidedPromptConfig(rows) {
    const prompts = rows.map(row => ({
      name: row.name,
      ...(row.title ? { title: row.title } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.arguments?.length ? { arguments: row.arguments } : {}),
      template: row.template,
    }));
    const temporary = `${GUIDED_PROMPTS_PATH}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, stringifyYaml({ prompts }, { lineWidth: -1 }));
    if (Deno.build.os === "windows") await Deno.remove(GUIDED_PROMPTS_PATH).catch(e => { if (!(e instanceof Deno.errors.NotFound)) throw e; });
    await Deno.rename(temporary, GUIDED_PROMPTS_PATH);
  }
  const guidedPromptDescriptor = row => ({
    name: row.name,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.arguments.length ? { arguments: row.arguments } : {}),
  });
  async function guidedPromptCatalog({ query = "", page = 1, page_size = 5 } = {}) {
    let rows = await readGuidedPromptConfig();
    const needle = String(query).trim().toLowerCase();
    rows = rows.filter(row => !needle || `${row.name}\n${row.title}\n${row.description}\n${row.arguments.map(x => `${x.name} ${x.description}`).join("\n")}`.toLowerCase().includes(needle));
    page_size = Math.max(1, Math.min(Number(page_size) || 5, 100));
    const total = rows.length, pages = Math.max(1, Math.ceil(total / page_size));
    page = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
    const start = (page - 1) * page_size;
    return {
      query: String(query), page, page_size, total,
      pages,
      has_more: start + page_size < total,
      config_file: GUIDED_PROMPTS_PATH,
      prompts: rows.slice(start, start + page_size),
    };
  }
  async function guidedPromptNameWarning(name, oldName = "") {
    const value = String(name || "").trim(), previous = String(oldName || "").trim().toLowerCase();
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(value)) return "Prompt name must use only letters, numbers, _, ., + or -.";
    return (await readGuidedPromptConfig()).some(row => row.name.toLowerCase() === value.toLowerCase() && row.name.toLowerCase() !== previous)
      ? "Prompt name already exists." : "";
  }
  function parseGuidedPromptArguments(value, promptName = "prompt") {
    const source = String(value || "").trim();
    if (!source) return [];
    const parsed = parseYaml(source, { schema: "core" });
    if (!Array.isArray(parsed)) throw new Error("Arguments must be a YAML list.");
    return parsed.map(argument => normalizeGuidedPromptArgument(argument, promptName));
  }
  const guidedPromptArgumentsText = args => args?.length ? stringifyYaml(args, { lineWidth: -1 }).trim() : "";
  const GUIDED_PROMPTS_HELP_YAML = String.raw`prompts:
  - name: project_review
    title: Project review
    description: Review the current project with an optional focus.
    arguments:
      - name: focus
        title: Review focus
        description: Area to focus on.
        required: false
      - name: chat_session
        description: Optional MrMCP Session handle when Session/Workspace context is needed.
        required: false
    template: |
      Review this project.
      <% if (it.args.focus) { %>Focus on: <%= it.args.focus %>.<% } %>
      <% if (it.workspace) { %>Workspace: <%= it.workspace.name %> at <%= it.workspace.path %>.<% } %>
      Running on <%= it.runtime.os %>/<%= it.runtime.arch %> with MrMCP <%= it.server.version %>.`;
  const GUIDED_PROMPTS_HELP_MODEL = JSON.stringify({
    args: { focus: "string argument values supplied by the client" },
    prompt: { name: "project_review", title: "Project review", description: "...", arguments: ["..."] },
    session: "current Session snapshot when a valid chat_session argument is supplied; otherwise null",
    workspace: "selected Workspace when chat_session is valid and has an open Workspace; otherwise null",
    workspaces: [{ id: 1, name: "Project", path: "..." }],
    server: { name: "MrMCP", version: VERSION, public_base_url: "...", mcp_url: "...", protocol_version: MCP_MODERN_PROTOCOL, protocol_versions: MCP_PROTOCOLS },
    client: { auth_kind: "oauth|basic|anonymous", client_id: "...", client_name: "...", user_agent: "..." },
    request: { url: "...", method: "POST", transport: "http|https", remote_host: "..." },
    runtime: { os: Deno.build.os, arch: Deno.build.arch, standalone: Deno.build.standalone, app_dir: APP_DIR, now: "ISO timestamp", now_ms: 0 },
  }, null, 2);
  async function commandRow(row) {
    const effective = commandPlatform(row), configured = await binPath(effective.path), target = await commandTarget(effective.path);
    const stat = await Deno.stat(target.path).catch(() => null);
    return {
      ...row, ...effective,
      catalog_path: row.path, catalog_download_url: row.download_url, catalog_archive_path: row.archive_path,
      platform: `${Deno.build.os}-${Deno.build.arch}`,
      source: "catalog",
      registered: true,
      path: configured.relative,
      resolved_path: target.relative,
      present: effective.supported && !!stat?.isFile,
      executable: effective.supported && !!stat?.isFile && executableFile(target.relative, stat),
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
  async function commandRows({ include_missing = false, admin = false } = {}) {
    const registered = await Promise.all((await readCommandConfig()).map(commandRow));
    const names = new Set(registered.map(row => row.name.toLowerCase()));
    const paths = new Set(registered.flatMap(row => [row.path, row.resolved_path]).filter(Boolean).map(path => path.toLowerCase()));
    const automatic = (await automaticCommands()).filter(
      row => !names.has(row.name.toLowerCase()) && !paths.has(row.path.toLowerCase()),
    ).sort((a, b) => a.name.localeCompare(b.name));
    return admin
      ? [...registered, ...automatic].filter(row => include_missing || (row.present && row.executable))
      : [...registered, ...automatic].filter(row => row.present && row.executable);
  }
  async function commandCatalog({
    query = "", page = 1, page_size = 5, include_missing = false, admin = false, filter = "",
  } = {}) {
    let rows = await commandRows({ include_missing, admin });
    const needle = String(query).trim().toLowerCase();
    rows = rows.filter(row =>
      !needle || `${row.name}\n${row.path}\n${row.description}\n${row.download_url || ""}\n${row.documentation_url || ""}`.toLowerCase().includes(needle)
    );
    filter = ["available", "unavailable", "yaml", "disk"].includes(String(filter)) ? String(filter) : "";
    if (filter === "available") rows = rows.filter(row => row.present && row.executable);
    else if (filter === "unavailable") rows = rows.filter(row => !row.present || !row.executable);
    else if (filter === "yaml") rows = rows.filter(row => row.registered);
    else if (filter === "disk") rows = rows.filter(row => !row.registered);
    page_size = Math.max(1, Math.min(Number(page_size) || 5, 100));
    const total = rows.length, pages = Math.max(1, Math.ceil(total / page_size));
    page = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
    const start = (page - 1) * page_size;
    return {
      query: String(query), filter, page, page_size, total,
      pages,
      has_more: start + page_size < total,
      bin_directory: BIN_DIR,
      config_file: COMMANDS_PATH,
      discovery_enabled: getCfg("command_discovery_enabled", "1") === "1",
      commands: rows.slice(start, start + page_size),
    };
  }
  async function discoverCommands() {
    if (getCfg("command_discovery_enabled", "1") !== "1") return { commands: [] };
    return {
      commands: (await commandRows()).map(row => ({
        logical_name: row.logical_name || row.name,
        description: row.description || "",
        ...(row.documentation_url ? { documentation_url: row.documentation_url } : {}),
      })),
    };
  }
  async function catalogProgram(name) {
    const registered = (await readCommandConfig()).find(row => row.name.toLowerCase() === String(name).toLowerCase());
    if (registered) {
      const target = await commandRow(registered);
      if (!target.supported) throw new Error(`Catalog command "${registered.name}" is not supported on ${target.platform}`);
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
  function serverTools(p, fullAccess = true, freshUiResources = false) {
    if (!fullAccess) return [];
    const cacheKey = Number(p.id || 0);
    if (freshUiResources) {
      const canonical = serverTools(p, true, false), resourceUri = freshUiResourceUri(PUBLISH_UI_URI);
      return canonical.map(tool => tool.name === "publish"
        ? { ...tool, _meta: { ...(tool._meta || {}), ui: { ...(tool._meta?.ui || {}), resourceUri } } }
        : tool);
    }
    const cached = serverToolCache.get(cacheKey);
    if (cached) return cached.list;
    const available = new Set(BASE_TOOLS);
    const publishUiResourceUri = PUBLISH_UI_URI;
    const workspaceNameInput = {
      type: "string", minLength: 1, maxLength: 128,
      description: "Name of the enabled Workspace to open. Any enabled Workspace name may be supplied; the value is validated when the tool runs. The selected Session is attached to this Workspace immediately.",
    };
    const contextInput = {
      chat_session: {
        type: "string", minLength: 12, maxLength: 256,
        pattern: "^ctx_[A-Za-z0-9_-]+$", description: CHAT_SESSION_INPUT_DESCRIPTION,
      },
    };
    const inputEncoding = {
      type: "string",
      enum: ["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"],
      default: "auto",
      description: "Text decoding mode. auto uses chardet: reading/searching follows the server setting (initial 16 KiB sample or complete file), with full-file detection retried if sample confidence is below 80 or the sample charset cannot decode the complete content. Mutations always detect the complete file. Samples may miss later charset clues; an explicit known encoding bypasses detection. Physical BOM presence is independent metadata and never selects the charset.",
    };
    const outputText = {
      output_encoding: {
        type: "string",
        enum: ["preserve", "utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"],
        default: "preserve",
        description: "Preserve the detected source charset or convert explicitly. For a new file, preserve means UTF-8. Writes fail rather than substitute characters when the requested/preserved charset cannot represent the text losslessly.",
      },
      line_endings: { type: "string", enum: ["preserve", "lf", "crlf", "cr"], default: "preserve", description: "Preserve a uniform source line-ending style, or convert explicitly to lf, crlf, or cr. For a new file, preserve defaults to lf. Incoming LF/CRLF/CR/mixed agent text is logical content and is normalized to the selected output style. If an existing source is mixed or has no line-ending style, preserve is rejected when the result introduces line breaks; no explicit choice is needed when the result has no line breaks." },
      bom: { type: "string", enum: ["preserve", "add", "remove"], default: "preserve", description: "Preserve, add or remove physical recognized Unicode BOM bytes independently of charset detection. A new file with preserve has no BOM; add requires a BOM-capable Unicode output encoding." },
    };
    const exactEdit = {
      type: "object", additionalProperties: false,
      properties: {
        old_text: { type: "string", minLength: 1, description: "Exact text to replace in the evolving document state produced by earlier edits for this same file." },
        new_text: { type: "string", description: "Exact replacement text after JSON string decoding. The tool performs no second C/JavaScript-style escape decoding." },
        expected_occurrences: { type: "integer", minimum: 1, default: 1, description: "Exact number of occurrences that must exist at this edit step before replacement." },
      },
      required: ["old_text", "new_text"],
    };
    const fingerprintInput = {
      type: "string", pattern: "^fp_[A-Za-z0-9_-]+$",
      description: "Opaque whole-file content fingerprint returned by fs_read, fs_grep, fs_navigate, fs_stat or a previous mutation. When supplied, the mutation is applied only if the current bytes still match it.",
    };
    const pathSelection = {
      path: { type: "string", default: ".", description: "Workspace-relative file or directory at which selection starts." },
      include: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" }, default: ["**/*"], description: "Globstar patterns selecting candidate paths relative to path." },
      exclude: { type: "array", maxItems: 100, items: { type: "string" }, default: [], description: "Globstar patterns removed from the selected set relative to path." },
      gitignore: { type: "boolean", default: true, description: "Apply .gitignore files recursively, including nested .gitignore files encountered below path and applicable parent rules." },
      hidden: { type: "boolean", default: false, description: "Include dot-prefixed files and directories. .gitignore rules are still read when hidden=false." },
    };
    const lineContext = {
      context_lines_before: { type: "integer", minimum: 0, maximum: 100, default: 0, description: "Number of text lines returned before each requested range or match." },
      context_lines_after: { type: "integer", minimum: 0, maximum: 100, default: 0, description: "Number of text lines returned after each requested range or match." },
    };
    const execIdInput = {
      type: "integer", minimum: 1,
      description: "Persistent execution id returned by exec_start. It is the stable Tool Call id of the exec_start operation and is valid only with the same chat_session that created it.",
    };
    const operationIdInput = {
      type: "string", minLength: 1, maxLength: 256,
      description: "Optional client-chosen opaque replay key. Within the same Session and tool, matching requests with the same operation_id reuse the original process while it is active and for 5 minutes after completion instead of starting another process. Reusing the key with different process arguments during that window is rejected. The key is not permanently unique and may be reused after the grace period.",
    };
    const execInput = {
      program: {
        type: "string",
        description: "Executable path or logical_name returned by discover_commands. MrMCP resolves catalog logical names before normal platform PATH lookup; invoke them directly without PATH probes.",
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
      operation_id: operationIdInput,
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
      init_chat_session: [
        "Initialize a new persistent chat Session independently of Workspaces. Call once at the start of a chat, then pass the exact returned chat_session on every subsequent tool call, including list_workspaces, open_workspace and tools_schema. This tool accepts no arguments and always creates a new Session; reuse a valid existing chat_session instead of initializing again. It does not open or create a Workspace.",
        { properties: {} },
      ],
      chat_set_goal: [
        "The global Settings → Goals switch defaults enabled. When off, this tool remains available but returns status=disabled without setting a goal; background monitoring and browser opening stop. Set a persistent goal for this ChatGPT conversation, or clear it with goal=\"\". Use only when the user asks for automatic follow-ups. First initialize the dedicated Chrome profile in Settings → Goals: select Login ChatGPT and sign in; login is detected automatically. Without a verified login, this tool saves the goal as waiting_login and opens no browser; after setup call it again to trigger an unassociated match. Settings → Goals also controls headless/process visibility. For an unassociated Session, each explicit nonempty set schedules one matching attempt after this call returns. It examines up to 20 recent chats ordered by observed update time, with rendered sidebar fallback, and links only one whose captured active-branch tool call or rendered tool details contain this exact chat_session. An unsuccessful attempt, missing login or interrupted match is not retried continuously: inspect status/detail and call chat_set_goal again to retry. Restart does not resume matching by default; Settings → Goals can enable one missing-match attempt per active unassociated goal at startup. No message is sent before association. An existing association is reused. After timeout_seconds without Tool Call activity (including completion), the server sends the exact goal in the linked conversation and repeats after each idle interval. Association continues directly to an already-due send on the same page. When the inactivity interval expires, it attempts delivery even while ChatGPT is responding or an earlier Tool Call is still running. Settings → Goals can optionally stop the current response first (off by default). New Tool Call activity still resets the timer; existing drafts and maintenance defer delivery. After confirming submission it moves to other goals without waiting for the assistant answer. A send with uncertain delivery pauses automatically until explicitly rearmed. The newest goal replaces any earlier goal on another Session linked to that same conversation. Goal, association and timer survive server restart; no Workspace is needed. Inspect state or stop the goal in Sessions. Never claim the chat is linked when status is pending.",
        { properties: {
          goal: { type: "string", maxLength: 32000, description: "Exact follow-up message. Empty or whitespace-only text disables automatic follow-ups and retains the chat association." },
          timeout_seconds: { type: "integer", minimum: 30, maximum: 86400, default: chatGoalDefaultTimeout(), description: "Inactivity interval in seconds. When omitted, uses Settings → Goals default timeout (initially 5 minutes). Each goal retains the interval selected when set." },
        }, required: ["goal"] },
      ],
      chat_goal_debug: [
        "Inspect or explicitly exercise the current Session's ChatGPT goal. Requires chat_session; no Workspace is needed. status (default) returns the stored chat_session-to-chatgpt_chat_id association, goal state, login readiness, enable switch and inactivity deadline without opening Chrome. match performs one exact Session scan now, including rechecking an existing association; a failed recheck retains the existing id and never sends a prompt. send sends the saved goal now to the already-associated chat and resets its timer only after normal UI acknowledgement. It uses the same shared tab, draft/revision/activity/maintenance checks, optional Stop, and uncertain-delivery suspension as normal goal delivery, bypassing only the inactivity deadline. Optional stop_before_send overrides Settings for this one send; omitted uses the saved setting. Global disable or missing login defers mutations. Set a nonempty goal first; sending/delivery_uncertain must be inspected and rearmed with chat_set_goal first. Use only for user-requested diagnostics/actions. These calls count as normal MrMCP activity. Never claim a forced send succeeded unless operation_status=sent.",
        { properties: { action: { type: "string", enum: ["status", "match", "send"], default: "status" },
          stop_before_send: { type: "boolean", description: "Override Stop-before-send for action=send only. Does not change global settings." } } },
      ],
      list_workspaces: [
        "List the names of all enabled Workspaces that may be passed to open_workspace. Requires a chat Session but does not open or create a Workspace.",
        { properties: {} },
      ],
      open_workspace: [
        "Attach the existing chat Session to the named Workspace without changing chat_session or creating a Session. Pass create=true only when you explicitly want a missing Workspace created as a new empty Desktop folder; otherwise a missing/disabled name is an error. The result includes workspace identity/guidance plus a compact Memory summary (counts and up to five latest keys for Global, Workspace and Session scope). Read agent_guidance_path when non-null before repository work.",
        { properties: {
          name: workspaceNameInput,
          create: { type: "boolean", default: false, description: "Explicitly create the named Workspace on the Desktop only when it does not already exist. false never creates implicitly." },
        }, required: ["name"] },
      ],
      workspace_dev_preferences_write: [
        "Copy the operator's DEV_PREF.md into the current Workspace only when the user explicitly asks you to save, copy, or materialize their development preferences in that project. Never call this tool proactively, while opening a Workspace, to discover preferences, or to decide which instructions to follow. This is not a preferences read API and it returns no preference content. It copies the physical DEV_PREF.md stored beside the running MrMCP executable (beside mrmcp.js in source mode) to Workspace-root DEV_PREF.md only when that destination is absent. If the Workspace already contains DEV_PREF.md, that project file is authoritative for this operation and is left byte-for-byte untouched; the source is not read, compared, merged, or used. Calling this tool does not mean the agent should read or apply DEV_PREF.md afterward; existing project/user guidance controls that separately.",
        { properties: { ...contextInput } },
      ],
      fs_glob: [
        "Discover files, directories and symlinks by path with globstar include/exclude patterns; use fs_grep when selecting files by their text content. This is also the filesystem tree navigator. The default result is intentionally lightweight (path + type); set metadata=true only when size/timestamps/link targets are needed. Results are deterministically ordered and statelessly paginated: when truncated=true, pass next_after_path back as after_path with the same selection arguments. .gitignore handling follows applicable parent rules and nested .gitignore files recursively.",
        { properties: {
          ...pathSelection,
          metadata: { type: "boolean", default: false, description: "Include size, modification/creation timestamps and stored symlink target. Leave false for faster/lighter repository navigation." },
          limit: { type: "integer", minimum: 1, maximum: 10000, default: 1000, description: "Maximum entries returned on this page. The result echoes the effective limit and a stateless next_after_path when more entries remain." },
          after_path: { type: "string", description: "Workspace-relative final path returned as next_after_path by the previous page. Only later entries in depth-first path-component order are returned; a directory and its descendants precede its next sibling." },
          ...contextInput,
        } },
      ],
      proxy_get: [
        "Get configured proxies without probing them. Requires chat_session, no Workspace. action=pick (default) selects distinct eligible entries with stats-aware round_robin (default) or weighted random; picks persist the global cursor in SQLite. action=list paginates the configured/resolved order with limit/offset and includes cooled-down entries and stats. action=report requires a previously picked proxy_id and success boolean; failures apply exponential cooldown or retry_after_seconds, successes clear consecutive failures. Report actual outcomes explicitly: MrMCP cannot observe requests made by external commands. direct is a placeholder for a direct request; include_direct=false excludes it. Explicit entries and lazily downloaded list sources come from Settings → Proxies / proxies.yaml; lists are bounded/cached, failed sources are reported. Empty picks return next_retry_at when all entries are cooling down. The tool returns proxy URLs including configured credentials; use them only for the intended request.",
        { properties: { action: { type: "string", enum: ["pick", "list", "report"], default: "pick" }, mode: { type: "string", enum: ["random", "round_robin"], default: "round_robin" },
          limit: { type: "integer", minimum: 1, maximum: 50 }, offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 }, include_direct: { type: "boolean", default: true },
          proxy_id: { type: "string", pattern: "^[a-f0-9]{64}$" }, success: { type: "boolean" }, retry_after_seconds: { type: "integer", minimum: 0, maximum: 86400 } } },
      ],
      document_grep: [
        "Rank document passages with Xberg extraction and persistent LanceDB retrieval. Uses the current Workspace, or Settings → Search default_path (Desktop/_default when empty) without assigning a Workspace. mode=auto chooses hybrid when an embedding model is configured, otherwise fulltext; vector and hybrid require Settings → Search embeddings. Each call incrementally refreshes ONLY the requested path/include/exclude/MIME selection and restricts results to its currently eligible files. Globstar ** and parent/nested .gitignore are supported (gitignore defaults true); symlinks are skipped. Local files are hashed every call; unchanged extraction is reused across restarts. Use the catalog yt-dlp command to download subtitles to Workspace files before indexing them. Failed, ignored or oversized inputs are not searched. Native OS OCR uses Auto.js's native provider with no external OCR engine; unavailable OS support is reported. Returned line numbers refer to extracted text, not original PDF pages. Use fs_grep for exact literal/regex source occurrences. The selected index survives Tool Call history cleanup.",
        {properties:{
          query:{type:"string",minLength:1,maxLength:4096},mode:{type:"string",enum:["auto","fulltext","vector","hybrid"],default:"auto"},...pathSelection,path:{...pathSelection.path,description:"File or directory relative to the current Workspace or configured default search directory."},
          mime:{type:"array",minItems:1,maxItems:100,uniqueItems:true,items:{type:"string",pattern:"^[a-zA-Z0-9.+_-]+/([a-zA-Z0-9.+_-]+|\\*)$"},description:"Exact MIME types or type/*; inferred from filename extension for local files. "},
          limit:{type:"integer",minimum:1,maximum:100,default:10},max_files:{type:"integer",minimum:1,maximum:5000,default:1000},max_file_bytes:{type:"integer",minimum:1,maximum:52428800,default:20971520},
        },required:["query"]},
      ],
      source_code_search: [
        "Search source code by relevance and explore AST functions, classes, methods, interfaces and imports using Lucerna. Uses the current Workspace, or Settings → Search default_path (Desktop/_default when empty) without assigning a Workspace. This deployment uses local BM25 lexical retrieval plus AST, without semantic embeddings or remote providers. Every call refreshes the selected live files; unchanged AST chunks and the SQLite BM25 index persist under the server data directory and are reused after restart. Only a completely traversed selection prunes absent/ignored files; other scopes remain stored and cannot appear in results. Applicable parent and nested .gitignore rules are always enforced, including negations, and cannot be disabled. Symlinks are not indexed. Default action=search; use fs_grep for literal/regex occurrences and fs_read for exact ranges. Results retain Lucerna chunk ids, source-directory-relative filePath and one-based startLine/endLine. Reuse the same scope for stateless offset pagination. Errors, skipped files and truncation indicate incomplete coverage.",
        { properties: {
          action: { type: "string", enum: SOURCE_CODE_ACTIONS, default: "search" },
          query: { type: "string", minLength: 1, description: "Natural-language or identifier query; required for search. Retrieval is lexical BM25 in this deployment." },
          path: { type: "string", default: ".", description: "File/directory relative to the current Workspace or configured default search directory." },
          include: { type: "array", items: { type: "string" }, description: "Glob patterns relative to path; default **/*. Gitignore always applies." },
          exclude: { type: "array", items: { type: "string" } }, hidden: { type: "boolean", default: false },
          language: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, uniqueItems: true, minItems: 1 }], description: `Search language filter. Supported: ${SOURCE_CODE_LANGUAGES.join(", ")}. Aliases include c++, c#, js, ts, py, yml and sh; results use canonical names. Grammars download on first use into the OS parser cache.` },
          types: { type: "array", items: { type: "string" }, uniqueItems: true, description: "Lucerna chunk types, e.g. function, class, method, import, interface." },
          file_path: { type: "string", description: "Path relative to the current Workspace or configured default search directory; required for chunks. Search also accepts a glob filter." },
          include_content: { type: "boolean", default: true, description: "false removes source content and contextContent from all returned chunks." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 10 }, offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
          max_files: { type: "integer", minimum: 1, maximum: 10000, default: 5000 },
          max_file_bytes: { type: "integer", minimum: 1, maximum: 2097152, default: 1048576 },
        } },
      ],
      fs_grep: [
        "Search textual occurrences across files, including comments, strings and configuration. Use source_code_search for ranked lexical retrieval and AST symbols; prefer a suitable discover_commands entry for additional caller/impact exploration. Narrow path/include when scope is known. Use mode=files for paths only, matches for source lines, count for per-file matching-line counts (grep -c, not substring occurrences). With regex=false, pattern is one literal substring including spaces and punctuation. Request a few context lines, e.g. 2 before/after, when nearby code can avoid another read; default 0. Matched files include edit fingerprints. Counters are page-local; skipped_large_files and per-file errors indicate incomplete coverage. When truncated=true, pass next_resume_after as resume_after with unchanged search arguments; remaining paths may yield no matches.",
        { properties: {
          pattern: { type: "string", minLength: 1, description: "Literal substring when regex=false, including any spaces exactly as supplied; regular expression source only when regex=true." }, ...pathSelection,
          regex: { type: "boolean", default: false }, case_sensitive: { type: "boolean", default: false },
          encoding: inputEncoding, ...lineContext,
          mode: { type: "string", enum: ["matches", "files", "count"], default: "matches", description: "matches returns matching lines, files returns matching file metadata only, and count returns the number of matching lines in each file (not the number of substring occurrences)." },
          max_file_bytes: { type: "integer", minimum: 1, maximum: 52428800, default: 5242880, description: "Skip source files larger than this byte size. The result echoes this limit and counts omitted candidates in skipped_large_files; those files have not been searched." },
          limit: { type: "integer", minimum: 1, maximum: 2000, default: 300, description: "Maximum matching lines in mode=matches or matched files in mode=files/count." },
          resume_after: {
            type: "object", additionalProperties: false,
            properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path"],
            description: "Stateless continuation point returned as next_resume_after. path alone means continue after that whole file; path+line means continue after that line within the file.",
          },
          ...contextInput,
        }, required: ["pattern"] },
      ],
      fs_read: [
        "Read known text files, batching independent files/ranges in one call. Prefer targeted ranges when their locations are known; use fs_grep to locate textual occurrences or fs_navigate to move between matches in known files. Optional context can include nearby code in the same read. Every successful file result includes an opaque whole-file fingerprint plus encoding/BOM/line-ending metadata. For a truncated file range, pass its next_start_line as start_line while retaining the requested end_line. Output text uses LF line separators; preservation/conversion is handled by mutation tools.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: {
              path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
              ...lineContext, encoding: inputEncoding,
            }, required: ["path"],
          } },
          max_output_bytes_per_file: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576, description: "Per-file ceiling for normalized text. A single complete line may exceed it so line content is never split." },
          ...contextInput,
        }, required: ["files"] },
      ],
      fs_navigate: [
        "Find the next or previous text match relative to explicit positions in one or many known files. Navigation is completely stateless: each file supplies from_line and direction; searching is strict, so forward starts after from_line and backward starts before it. A returned match line can therefore be sent back unchanged as the next from_line to continue.",
        { properties: {
          pattern: { type: "string", minLength: 1 },
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: {
              path: { type: "string" }, from_line: { type: "integer", minimum: 0, description: "Exclusive reference line. forward starts at from_line+1; backward starts at from_line-1. Use 0 to search forward from the first line." },
              direction: { type: "string", enum: ["forward", "backward"] },
              max_matches: { type: "integer", minimum: 1, maximum: 100, default: 1 }, encoding: inputEncoding,
            }, required: ["path", "from_line", "direction"],
          } },
          regex: { type: "boolean", default: false }, case_sensitive: { type: "boolean", default: false }, ...lineContext,
          ...contextInput,
        }, required: ["pattern", "files"] },
      ],
      fs_stat: [
        "Read filesystem metadata for one or many paths. Set fingerprint=true to hash regular-file content when a concurrency token is needed without reading text.",
        { properties: {
          paths: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
          fingerprint: { type: "boolean", default: false }, ...contextInput,
        }, required: ["paths"] },
      ],
      fs_write: [
        "Create or replace complete text files. Per-file expected_fingerprint provides optimistic concurrency. Batch entries are independent: successful files are never rolled back because another file fails, and the structured result reports every outcome.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: { path: { type: "string" }, content: { type: "string" }, expected_fingerprint: fingerprintInput, ...outputText },
            required: ["path", "content"],
          } },
          create_parents: { type: "boolean", default: true }, ...contextInput,
        }, required: ["files"] },
      ],
      fs_edit: [
        "Apply multiple ordered exact edits to one or many existing text files. For each file MrMCP reads once, verifies expected_fingerprint against that initial version, applies edits sequentially to the evolving in-memory document, then writes once. Thus edit N sees edits 1..N-1. If validation for any edit in a file fails, that file is not written. Other files in the batch remain independent and are never rolled back.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: {
              path: { type: "string" }, expected_fingerprint: fingerprintInput, input_encoding: inputEncoding,
              ...outputText, edits: { type: "array", minItems: 1, maxItems: 200, items: exactEdit },
            }, required: ["path", "edits"],
          } },
          ...contextInput,
        }, required: ["files"] },
      ],
      fs_text_convert_encoding_eol: [
        "Explicitly convert the physical text representation of existing regular files without changing their logical text content. Use only explicit files[] paths: this tool never discovers or globs files. Set one or more targets among encoding, line_endings and bom; preserve leaves that property unchanged, including mixed/none line endings. Source encoding is detected with the same authoritative chardet path used by the other text tools. Files whose bytes already match the requested representation return unchanged and are not rewritten. Each file is independent and may include expected_fingerprint for optimistic concurrency. Use this tool when the user explicitly requests an encoding/EOL/BOM conversion or when the current task specifically requires that representation; do not call it proactively to normalize a repository or treat one text representation as universally preferred.",
        { properties: {
          files: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: { path: { type: "string" }, expected_fingerprint: fingerprintInput, input_encoding: inputEncoding }, required: ["path"],
          } },
          encoding: { type: "string", enum: ["preserve", "utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"], default: "preserve", description: "Target character encoding. preserve keeps the detected source encoding." },
          line_endings: { type: "string", enum: ["preserve", "lf", "crlf", "cr"], default: "preserve", description: "Target line-ending convention. preserve keeps the source exactly, including mixed or none." },
          bom: { type: "string", enum: ["preserve", "add", "remove"], default: "preserve", description: "Preserve, add or remove a recognized Unicode BOM. add requires a BOM-capable Unicode target encoding." },
          ...contextInput,
        }, required: ["files"] },
      ],
      fs_mkdir: [
        "Create one or many directories. parents=true creates missing parents. Batch entries are independent; successful directories remain in place when another entry fails.",
        { properties: {
          paths: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
          parents: { type: "boolean", default: true }, ...contextInput,
        }, required: ["paths"] },
      ],
      fs_copy: [
        "Copy one or many files, directories or symlinks recursively while preserving symlinks as links instead of dereferencing them. Destinations must not already exist. Batch entries are independent; successful copies remain in place when another entry fails.",
        { properties: {
          entries: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"],
          } },
          create_parents: { type: "boolean", default: true }, ...contextInput,
        }, required: ["entries"] },
      ],
      fs_move: [
        "Move or rename one or many files, directories or symlinks, with cross-filesystem copy/remove fallback that preserves symlinks. Destinations must not already exist. Batch entries are independent; successful moves are never reversed because another entry fails.",
        { properties: {
          entries: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false,
            properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"],
          } },
          create_parents: { type: "boolean", default: true }, ...contextInput,
        }, required: ["entries"] },
      ],
      fs_trash: [
        "Reversibly move explicit paths and/or a globstar selection into MrMCP's single application trash store. Selection uses the same include/exclude/gitignore/hidden semantics as fs_glob. Entries are independent: successful paths remain in one returned trash_id when another path fails. No cross-entry rollback is attempted.",
        { anyOf: [{ required: ["paths"] }, { required: ["selection"] }], properties: {
          paths: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
          selection: { type: "object", additionalProperties: false, properties: { ...pathSelection } },
          ...contextInput,
        } },
      ],
      fs_untrash: [
        "Restore paths still present under one trash_id. Entries are independent: successful restores remain restored, failed or missing tracked items stay visible for inspection or retry, and the trash transaction is removed only when no tracked item metadata remains.",
        { properties: { trash_id: { type: "string", description: "Trash transaction identifier returned by fs_trash." }, ...contextInput }, required: ["trash_id"] },
      ],
      desktop_auto: [
        "Run one Automation Action Format (AAF) YAML scenario against the current desktop through @mefistofelix/auto.js. Actions execute sequentially in one run and may find/control windows and accessibility elements, send keyboard/mouse input, use the clipboard, capture screenshots, run OCR, wait on conditions, inspect displays, and control supported system state. AAF references such as $.prev, $.ret, and $.state compose steps without hidden persistent desktop state. The structured result preserves Auto.js run() output: ordered action results plus the arbitrary final state built by the scenario, so OCR text, window records, coordinates, arrays, objects and zero/one/many retained images may coexist. Every retained final-state image stays at its original nested state location with its metadata and an image_id replacing binary data; each distinct image is additionally emitted as an MCP image content block for direct model vision. Returned screenshot rect coordinates remain absolute desktop coordinates even when scale reduces the transported image.",
        { properties: {
          yaml: {
            type: "string", minLength: 1, maxLength: 1000000,
            description: "AAF scenario as YAML. The top level is an ordered array and every item contains exactly one action. Full AAF specification and examples: https://github.com/mefistofelix/auto.js/blob/main/AAF_SPEC.md . The scenario itself determines the final state shape and may mix ordinary JSON values with any number of retained screenshots. To make a screenshot directly visible to the model, retain its handle anywhere in final state, for example: `- screenshot: {scale: 50%}` followed by `- state: {shot: \"$.ret.image\"}`. MrMCP preserves that nesting, removes only the final WebP/PNG byte array, adds image_id at that same object, and emits the corresponding MCP image content block.",
          },
          ...contextInput,
        }, required: ["yaml"] },
      ],
      publish: [
        "Publish content to the user through one MIME-aware MCP App. Provide exactly one source: path snapshots an existing Workspace file, text stores the UTF-8 bytes of the supplied string, and base64 decodes supplied bytes directly without requiring an intermediate file. Every source is persisted as a normal file under .mrmcp/publish using a random capability prefix plus a sanitized filename, deduplicated by the same fast content fingerprint, and remains available across server restarts until explicitly cleared. mime_type is required and controls the actual HTTPS resource response: browser-displayable MIME types are served inline with the filename retained in Content-Disposition, while opaque/binary types are served as attachments. presentation is only a UI hint: auto chooses a sensible preview from MIME type, inline asks for preview when supported, and download asks the widget to present the resource as a file action. The widget always links to the persistent content URL itself, not to the widget resource. title and description render above the published element; height controls iframe-style inline previews. Self-contained HTML is portable; remote HTML dependencies remain subject to host/browser CSP and CORS. The whole MCP request, including text/base64, is limited by the server request-body limit.",
        { oneOf: [{ required: ["path"] }, { required: ["text"] }, { required: ["base64"] }], properties: {
          path: { type: "string", description: "Existing Workspace file to snapshot into publish storage." },
          text: { type: "string", description: "String content encoded as UTF-8 bytes before publication." },
          base64: { type: "string", description: "Base64-encoded bytes decoded directly into publish storage." },
          mime_type: { type: "string", minLength: 3, maxLength: 200, description: "Required MIME type describing the published bytes and controlling browser inline-vs-attachment delivery." },
          filename: { type: "string", maxLength: 240, description: "Optional user-facing filename. For path it defaults to the source basename; for text/base64 a MIME-based content name is generated when omitted." },
          presentation: { type: "string", enum: ["auto", "inline", "download"], default: "auto", description: "Presentation hint for the smart widget. It never changes the bytes or MIME response semantics; unsupported inline previews fall back to a file action." },
          title: { type: "string", maxLength: 200, description: "Optional heading rendered above the published element." },
          description: { type: "string", maxLength: 2000, description: "Optional descriptive text rendered below the title and above the published element." },
          height: { type: "integer", minimum: 120, maximum: 2000, default: 600, description: "Preferred height for iframe-style inline previews." },
          ...contextInput,
        }, required: ["mime_type"] },
      ],
      cdp_call: [
        `Send one or more CDP operations in one batch. Each entry selects an optional browser name or advanced browser object with required name, optional logical page target, and call; omitted browser defaults to the persistent profile label main. Browser objects support local launch options (headless, executable_path, user_data_dir, args), existing browser attachment (port plus optional host, http_url, or direct websocket_url), and connect_timeout_ms. target also accepts an object with required name, native create_params and startup controls initialize/runtime/page/network/service_worker/focus_emulation/binding/background_service. Both configurations are reused by name only for this server run. Every call uses {method,params}: standard CDP methods pass through unchanged; local extension methods use the reserved _. namespace, currently _.click and _.find with augmented XPath ends-with()/icontains() rewrites. These extensions require a target and translate internally to Runtime.evaluate. Different browsers/targets may be mixed. MrMCP owns JSON-RPC ids/session routing and preserves result order. wait=true waits for every response independently; wait=false returns assigned ids for later cdp_poll. Page.captureScreenshot natively returns Base64 in the CDP response and is never implicitly saved to disk. Optional outer _image requests response post-processing without changing CDP screenshot params: original preserves the CDP bytes; webp uses public Auto.js auto.vips to decode/scale/re-encode at its current fixed WebP Q=80. Official protocol documentation: ${CDP_CALL_DOCS}`,
        { properties: {
          wait: { type: "boolean", default: true, description: "Apply to the whole batch. true waits for every dispatched response; false returns after all dispatch attempts and leaves responses for cdp_poll. _image requires wait=true." },
          calls: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", additionalProperties: false, properties: {
              browser: { ...CDP_BROWSER_INPUT, default: "main", description: `${CDP_BROWSER_INPUT.description} Omit browser to use main.` },
              target: CDP_TARGET_INPUT,
              call: { type: "object", additionalProperties: false, properties: {
                method: { type: "string", minLength: 3, maxLength: 200, description: "Exact standard CDP method, for example Page.navigate, Runtime.evaluate or Page.captureScreenshot, or local extension _.click / _.find. _.click retries an augmented XPath and invokes element.click(); _.find returns compact element/text/rect metadata. The _. namespace is reserved for local extensions." },
                params: { type: "object", additionalProperties: true, default: {}, description: "For standard methods: raw CDP params unchanged. For _.click: xpath plus optional attempts (1-20) and interval_ms (0-5000). For _.find: xpath plus optional limit (1-100)." },
              }, required: ["method"] },
              _image: { type: "object", additionalProperties: false, properties: {
                return: { type: "string", enum: ["base64"], description: "Explicitly keep the screenshot payload as Base64 in cdp.result.data after optional post-processing." },
                format: { type: "string", enum: ["original", "webp"], default: "original", description: "original leaves CDP image encoding unchanged; webp decodes the returned screenshot and re-encodes WebP through the public Auto.js vips helpers." },
                quality: { type: "integer", const: 80, default: 80, description: "WebP quality. The current public Auto.js auto.vips encoder uses fixed Q=80, so 80 is the only accepted value." },
                scale: { type: "number", exclusiveMinimum: 0, maximum: 4, default: 1, description: "Multiply decoded screenshot dimensions before WebP encoding; 1 preserves dimensions." },
              }, required: ["return"], description: "MrMCP response post-processing for standard Page.captureScreenshot only. It never modifies the raw CDP request params." },
            }, required: ["call"],
          } },
          ...contextInput,
        }, required: ["calls"] },
      ],
      cdp_subs: [
        "Add and/or remove global runtime CDP subscriptions for one browser in one call; removals are applied before additions. add accepts subscription specs or '*' for one catch-all subscription; remove accepts opaque subscription ids or '*' to remove every subscription for that browser. Each spec can filter logical targets (including '*'), exact methods/prefixes (including '*'), browser-level traffic, and an optional JavaScript-compatible regex tested against JSON.stringify of the complete raw inbound CDP message. Filters are AND across target/method/regex dimensions and OR within exact+prefix methods. Subscriptions are runtime-global, not Session-owned, and disappear on restart.",
        { properties: {
          browser: CDP_BROWSER_INPUT,
          add: { anyOf: [
            { type: "string", const: "*" },
            { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, properties: {
              targets: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 }, description: "Logical target labels; '*' matches every target. Omit for every target-associated message." },
              methods: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 }, default: [], description: "Exact methods; '*' matches every method." },
              method_prefixes: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 }, default: [], description: "Method prefixes such as Network.; '*' matches every method." },
              include_browser: { type: "boolean", description: "Include messages with no target association. Defaults true only when no targets are supplied." },
              regex: { type: "string", maxLength: 4000, description: "Optional regex source matched against the serialized complete raw CDP message, useful for diagnostics/content matching." },
              regex_flags: { type: "string", pattern: "^[imsu]*$", maxLength: 4, default: "", description: "Optional regex flags: i, m, s, u; no duplicates." },
            } } },
          ], description: "Subscriptions to add, or '*' for one all-target/all-method/browser-level catch-all subscription." },
          remove: { anyOf: [
            { type: "string", const: "*" },
            { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^cdpsub_[A-Za-z0-9_-]+$" } },
          ], description: "Subscription ids to remove, or '*' to remove all live subscriptions for this browser." },
          ...contextInput,
        }, required: ["browser"] },
      ],
      cdp_poll: [
        "Read retained CDP traffic. With subscription, read matching traffic forward from that subscription's cursor; advance defaults true and moves only that cursor. Subscription target/method/wildcard/full-message-regex filters are applied first. Without subscription, browser is required and the tool returns the latest matching retained messages from the tail without consuming them. wait=false responses are retained independently of notification subscriptions and may be selected by id. type, target, methods and method_prefixes are additional ad-hoc filters; method filters use the remembered standard or logical _. extension request name for responses. The per-browser ring is bounded by count and bytes; dropped and stream_resets make loss/reconnection explicit.",
        { anyOf: [{ required: ["subscription"] }, { required: ["browser"] }], properties: {
          subscription: { type: "string", pattern: "^cdpsub_[A-Za-z0-9_-]+$" },
          browser: { ...CDP_BROWSER_INPUT, description: `${CDP_BROWSER_INPUT.description} Required for ad-hoc polling when subscription is omitted; when supplied with subscription, its name must match that subscription's browser.` },
          target: { type: "string", minLength: 1, maxLength: 128, description: "Optional additional logical target filter." },
          type: { type: "string", enum: ["all", "notification", "response"], default: "all" },
          id: { type: "integer", minimum: 1, description: "Optional JSON-RPC response id, especially for a previous cdp_call(wait=false)." },
          methods: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 }, default: [], description: "Exact method filter; '*' matches every method. For responses this is the remembered standard method or logical _. extension method." },
          method_prefixes: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 }, default: [], description: "Method prefixes such as Network. or _.; '*' matches every method. For responses this filters the remembered standard/logical request method." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          advance: { type: "boolean", default: true, description: "With subscription, advance its cursor through the scanned retained stream. Ignored for ad-hoc browser polling." },
          ...contextInput,
        } },
      ],
      memory_find: [
        "Find persistent key-value memories across one or more explicitly selected scopes. scope accepts global, session, workspace, an array of those scopes, or '*' for all three. Session results are always restricted to the current chat_session's Session. Workspace scope searches every registered Workspace when workspace is omitted, or one named Workspace when supplied. Each result reports its stable id, public scope/owner, key, explicit json type, value, TTL and set/expiry timestamps. Expired TTL entries are removed before searching. key is exact, key_prefix matches the start of keys, and query searches key plus stored value text as a case-insensitive literal by default or as a JavaScript regex when regex=true. set_after/set_before filter the set timestamp and before_id provides stable backward pagination. Exact-key lookup through this tool replaces a separate memory_get surface.",
        { properties: {
          scope: { anyOf: [
            { type: "string", enum: ["global", "session", "workspace", "*"] },
            { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["global", "session", "workspace"] } },
          ], description: "Required memory scope selector: one scope, a unique array of scopes, or '*' for global + current Session + every Workspace." },
          workspace: { type: "string", minLength: 1, maxLength: 128, description: "Optional Workspace filter when workspace scope is selected. Omit to search every registered Workspace included by the scope selector." },
          key: { type: "string", maxLength: 512, description: "Optional exact key filter." },
          key_prefix: { type: "string", maxLength: 512, description: "Optional key-prefix filter." },
          query: { type: "string", maxLength: 2000, description: "Optional search across key plus stored JSON/text value. Literal by default; JavaScript regex source when regex=true." },
          regex: { type: "boolean", default: false, description: "Interpret query as a JavaScript regular expression instead of a literal substring." },
          case_sensitive: { type: "boolean", default: false, description: "Use case-sensitive matching for query. Applies to both literal and regex search." },
          set_after: { type: "string", description: "Optional ISO date/time lower bound for when the memory was last set." },
          set_before: { type: "string", description: "Optional ISO date/time upper bound for when the memory was last set." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          before_id: { type: "integer", minimum: 1, description: "Return only entries with a lower stable memory id." },
          ...contextInput,
        }, required: ["scope"] },
      ],
      memory_set: [
        "Set, replace, or delete one persistent key-value memory in an explicitly selected scope. global scope is shared across the whole MrMCP server, session scope belongs to the current chat_session's Session, and workspace scope requires a Workspace label and is shared by every Session using that Workspace. When setting, value is text and json must explicitly say how to interpret it: json=true validates the text with JSON.parse and rejects invalid JSON; json=false stores ordinary text unchanged. ttl_seconds=0 means no expiry; positive TTL is measured from this set operation. Every replacement gets a new set timestamp/id. Use delete=true without value/json to remove the key.",
        { properties: {
          scope: { type: "string", enum: ["global", "session", "workspace"], description: "Required explicit memory scope." },
          workspace: { type: "string", minLength: 1, maxLength: 128, description: "Workspace label required only when scope=workspace; omit for global and session scope." },
          key: { type: "string", minLength: 1, maxLength: 512 },
          value: { type: "string", maxLength: 1048576, description: "Exact value text. Required unless delete=true. With json=true it must be valid JSON text; with json=false it is stored unchanged." },
          json: { type: "boolean", description: "Required when setting value. true validates/parses JSON; false stores ordinary text. Omit only when delete=true." },
          delete: { type: "boolean", default: false, description: "Delete this key instead of setting it. value and json must be omitted when true." },
          ttl_seconds: { type: "integer", minimum: 0, maximum: 315360000, default: 0, description: "0 keeps the memory indefinitely; positive values expire it this many seconds after set_at." },
          ...contextInput,
        }, required: ["scope", "key"] },
      ],
      telegram_req: [
        "Send one authenticated Telegram Bot API JSON request using the Bot token configured by the local user on the Telegram page. Pass one request object containing method plus that Bot API method's ordinary JSON fields; MrMCP removes method, POSTs the remaining object to Telegram, normalizes numeric-string chat_id values, remembers migrate_to_chat_id redirects for the running process and retries once when Telegram requests a chat migration. The token is never an agent argument or returned value. No TDLib or Telegram client library is used; the returned response is Telegram's JSON body for the agent to interpret.",
        { properties: {
          request: { type: "object", additionalProperties: true, properties: { method: { type: "string", minLength: 1, maxLength: 64, description: "Telegram Bot API method name, for example getUpdates, sendMessage or editMessageText." } }, required: ["method"], description: "Telegram Bot API request. Put method beside the normal JSON parameters for that method. Authentication is injected by MrMCP." },
          ...contextInput,
        }, required: ["request"] },
      ],
      discover_commands: [
        "Read the complete catalog of extra executable commands intentionally made available to the agent. Call this proactively whenever a task might benefit from capabilities beyond MrMCP's built-in tools, before inventing a workaround, assuming a utility is unavailable, or choosing a generic alternative. When a listed command fits the task, prefer it: its presence reflects an explicit user choice. The whole available catalog is returned in one call with descriptions and documentation links, so normally call it once per Session and reuse what you learned; there is no search or pagination, which also avoids failures from guessed or misspelled command names. If the operator globally disables command discovery, this tool returns an empty commands array. Every returned logical_name is directly callable as exec.program. MrMCP resolves catalog logical names before normal platform PATH lookup; do not probe PATH or search the filesystem first.",
        { properties: { ...contextInput } },
      ],
      tools_schema: [
        "Return the canonical complete MCP tool descriptors generated by the same serverTools source used by tools/list for exact published tool names. This exposes name, title, full description, inputSchema, outputSchema, annotations and _meta without connector summarization. Publication View resource URIs are canonical here; tools/list may add a fresh ?instance suffix solely for cache busting. This diagnostic tool requires a chat Session but no Workspace.",
        { properties: {
          names: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 }, description: "Exact published tool names to inspect, returned in this order when present. Duplicate names are rejected at execution time." },
        }, required: ["names"] },
      ],
      tools_log: [
        "Query Tool Call history for this exact chat_session across both Disk and Memory storage. summary is the default. Every row reports storage and payload_mode: payload retains the canonical MCP JSON-RPC request and response packets, while metadata retains no MCP payload. detail=full returns mcp_request and mcp_response only when retained; payload_retained and payload_complete make availability explicit. Filters may be combined. query is a case-insensitive literal substring search across retained MCP packets and metadata; before_id pages backward by stable Tool Call id. When truncated=true, pass next_before_id back as before_id with the same filters. An upstream-blocked request cannot appear here.",
        { properties: {
          id: { type: "integer", minimum: 1, description: "Inspect one exact stable Tool Call id. When present, before_id is ignored and at most one matching call is returned." },
          detail: { type: "string", enum: ["summary", "full"], default: "summary", description: "summary avoids returning stored packet bodies; full includes retained mcp_request and mcp_response packets." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          tool: { type: "string", maxLength: 128, description: "Exact tool-name filter." },
          status: { type: "string", enum: ["received", "running", "completed", "failed", "invalid", "orphaned"] },
          query: { type: "string", maxLength: 1000, description: "Case-insensitive literal substring search across all stored fields of each log row." },
          before_id: { type: "integer", minimum: 1, description: "Return only rows whose stable log id is lower than this value. Ignored when id is supplied." },
          ...contextInput,
        } },
      ],
      exec: [
        "Run one foreground command and keep the Tool Call open until it exits. Optional operation_id provides replay protection: the same Session/tool/key with identical process arguments reuses the original process while active and for 5 minutes after completion; different arguments with the same live key are rejected, and the key may be reused after that grace period. timeout_ms defaults to 45 seconds but may be increased up to 1 hour. Be careful with high request timeouts: some clients, proxies or gateways retry/replay long-running requests; during ChatGPT testing a replay boundary was observed around 60 seconds, which can execute a non-idempotent foreground command more than once. Prefer exec_start plus exec_status/exec_attach for long, expensive or non-idempotent work. The complete normalized combined stdout/stderr transcript is retained server-side for this call. When the request supplies _meta.progressToken and accepts SSE, new output is also sent incrementally as standard MCP notifications/progress in batches of at most 16 KiB or 100 ms; after exit the final result still contains the complete transcript from process start. Without a progressToken, no incremental progress notifications are emitted and the call returns the complete transcript only when the process exits. When the HTTP runtime reports client disconnect/cancellation, the foreground child is terminated; the hard timeout remains the fallback when a transport cannot surface disconnect before a response exists. For normal direct execution use program + args; use shell_command only when shell syntax is required. Pass argv verbatim and consult --help when syntax is uncertain. Use structured filesystem/text tools instead of exec when they cover the operation.",
        { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
          ...execInput,
          timeout_ms: { type: "integer", minimum: 1, maximum: MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS, default: MCP_FOREGROUND_EXEC_DEFAULT_TIMEOUT_MS, description: "Foreground child timeout in milliseconds. Defaults to 45000; values above that are allowed up to 1 hour, but long request lifetimes may cross client/proxy retry or replay windows and can duplicate non-idempotent commands. Prefer exec_start for long-running work." },
        } },
      ],
      exec_start: [
        "Start a persistent interactive/background command and return immediately; this tool never carries live process output. Optional operation_id provides replay protection: matching retries in the same Session return the same exec_id while the process is active and for 5 minutes after completion, and the key may be reused after that grace period. The result contains exec_id, the integer Tool Call id of the original exec_start call. Pass that exact exec_id together with the same chat_session to exec_attach, exec_write, exec_kill or exec_status. The process keeps running after this Tool Call ends or its client disconnects. The complete normalized stdout/stderr transcript is retained in memory for the process lifetime and for up to 24 hours after completion, and stdin writes are retained internally for diagnostics. Use exec_attach to consume incremental output and exec_status to inspect state or retrieve all/tail output without consuming the attach cursor. Persistent state does not survive a server restart. stdin remains open until exec_write closes it or the process exits.",
        { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
          ...execStartInput,
          timeout_ms: { type: "integer", minimum: 0, maximum: 604800000, default: 0 },
        } },
      ],
      exec_attach: [
        "Consume unread output from one persistent process created by exec_start. Pass the exact exec_id returned by exec_start and the same chat_session; ids from another Session are inaccessible. Each successful attach advances an internal cursor so already-returned combined output is not repeated. Every attachment is request-bounded: timeout_ms defaults to 45 seconds and may be increased up to 1 hour; after it expires, a still-running process returns normally with wait_timed_out=true and may be attached again. Be careful with high attachment timeouts because client/proxy retries can overlap the still-active attachment and receive the intentional already-active error; short repeated attaches or exec_status are safer across uncertain gateways. With _meta.progressToken, exec_attach sends unread backlog and live output until process exit, disconnect, or that wait timeout, then returns the unread transcript covered by this attachment. Without a progressToken, existing unread data returns immediately up to 16 KiB; otherwise the call long-polls only within the same bounded wait. remaining_bytes reports already-buffered UTF-8 bytes after the returned chunk. Call again while remaining_bytes>0 or when wait_timed_out=true/status=running. When the HTTP runtime reports a client disconnect, the attachment detaches without terminating the persistent child; the bounded wait still releases the slot when a transport cannot surface disconnect before a response exists. Only one attachment may be active per exec id. Use exec_status for non-consuming snapshots.",
        { properties: {
          exec_id: execIdInput,
          timeout_ms: { type: "integer", minimum: 1, maximum: MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS, default: MCP_ATTACH_DEFAULT_TIMEOUT_MS, description: "Maximum time this attachment may wait/stream before returning while the process remains running. Defaults to 45000 and allows up to 1 hour. High values may cross client/proxy retry windows and cause overlapping attach attempts; prefer shorter repeated attaches or exec_status when transport behavior is uncertain." },
          separate_streams: { type: "boolean", default: false, description: "Also return complete current stdout/stderr snapshots in the final result; live MCP progress remains the combined observed-order output." },
          ...contextInput,
        }, required: ["exec_id"] },
      ],
      exec_write: ["Write data to the open stdin of a persistent process created by exec_start. Pass the exact exec_id returned by exec_start and the same chat_session. This call does not attach to output. Set close=true to close stdin after the optional write.", { properties: {
        exec_id: execIdInput, data: { type: "string", default: "" },
        encoding: { type: "string", enum: ["text", "base64"], default: "text" },
        close: { type: "boolean", default: false }, ...contextInput,
      }, required: ["exec_id"] }],
      exec_kill: ["Terminate a still-running persistent process created by exec_start. Pass its exec_id and the same chat_session. Foreground exec calls are cancelled by cancelling/disconnecting their own Tool Call and are not controlled through exec_kill. After termination, use exec_status with output=all or output=tail to inspect retained output.", { properties: {
        exec_id: execIdInput, signal: { type: "string", enum: ["SIGTERM", "SIGKILL"], default: "SIGTERM" },
        ...contextInput,
      }, required: ["exec_id"] }],
      exec_list: ["List only the persistent processes that are currently running for this exact Session. Each row includes exec_id, command, state and attachment/stdin state. Completed, failed, timed-out and killed processes are intentionally omitted; query a known completed exec_id with exec_status instead. Persistent process state is in memory and does not survive a server restart.", { properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, ...contextInput,
      } }],
      exec_status: ["Inspect one persistent process created by exec_start without consuming its exec_attach cursor. Pass the exact exec_id and the same chat_session. This works while the process is running and after completion, failure, timeout or kill while its in-memory record is retained (normally up to 24 hours after completion; records do not survive a server restart). output=none returns status/metadata only; output=all returns the complete retained normalized combined stdout/stderr transcript; output=tail returns the last tail_lines normalized lines. separate_streams=true additionally applies the same output selection to stdout and stderr.", { properties: {
        exec_id: execIdInput,
        output: { type: "string", enum: ["none", "all", "tail"], default: "none" },
        tail_lines: { type: "integer", minimum: 1, maximum: 10000, default: 200 },
        separate_streams: { type: "boolean", default: false },
        ...contextInput,
      }, required: ["exec_id"] }],
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
    const fsLine = {
      type: "object", additionalProperties: false,
      properties: { line: { type: "integer", minimum: 1 }, text: { type: "string" } }, required: ["line", "text"],
    };
    const fsMatch = {
      type: "object", additionalProperties: false,
      properties: {
        line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, text: { type: "string" },
        context_before: { type: "array", items: fsLine }, context_after: { type: "array", items: fsLine },
      }, required: ["line", "column", "text"],
    };
    const fsEditResult = {
      type: "object", additionalProperties: false,
      properties: {
        index: { type: "integer", minimum: 1 }, expected_occurrences: { type: "integer", minimum: 1 },
        occurrences: { type: "integer", minimum: 0, description: "Occurrences found at this step in the evolving in-memory document." },
      }, required: ["index", "expected_occurrences", "occurrences"],
    };
    const fsStatus = values => ({ type: "string", enum: values });
    const fsEntry = (properties, required = ["path", "status"]) => ({ type: "object", additionalProperties: false, properties, required });
    const fsArray = items => ({ type: "array", items });
    const fsErrorProperty = { error: { type: "string" } };
    const fsTextProperties = {
      encoding: { type: "string", description: "Character encoding actually used to decode or encode the file." },
      bom: { type: "boolean", description: "Whether the original/resulting file physically contains a recognized Unicode BOM. This is detected from bytes independently of encoding heuristics." },
      line_endings: { type: "string", description: "Physical CR/LF style: lf, crlf, cr, mixed, or none. none means the text contains no CR/LF separator, not necessarily that the file is empty." },
    };
    const fsFingerprintProperties = {
      fingerprint: { type: "string" }, expected_fingerprint: { type: "string" },
      fingerprint_before: { type: "string" }, fingerprint_after: { type: "string" },
    };
    const fsGlobEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["ok"]), type: fsStatus(["file", "directory", "symlink"]), size: { type: "integer", minimum: 0 },
      modified_at: nullableString, created_at: nullableString, link_target: { type: "string" },
    }, ["path", "status", "type"]);
    const fsGrepEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["ok", "not_found", "permission_denied", "failed"]), ...fsErrorProperty,
      fingerprint: { type: "string" }, size: { type: "integer", minimum: 0 }, ...fsTextProperties,
      count: { type: "integer", minimum: 0 }, matches: { type: "array", items: fsMatch },
    });
    const fsReadEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["ok", "not_found", "not_file", "range_out_of_bounds", "permission_denied", "failed"]), ...fsErrorProperty,
      content: { type: "string" }, size: { type: "integer", minimum: 0 }, fingerprint: { type: "string" }, ...fsTextProperties,
      start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 0 }, total_lines: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" }, next_start_line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    });
    const fsNavigateEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["ok", "not_found", "permission_denied", "failed"]), ...fsErrorProperty,
      fingerprint: { type: "string" }, size: { type: "integer", minimum: 0 }, total_lines: { type: "integer", minimum: 0 }, ...fsTextProperties,
      count: { type: "integer", minimum: 0 }, matches: { type: "array", items: fsMatch },
    });
    const fsStatEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["ok", "not_found", "permission_denied", "failed"]), ...fsErrorProperty,
      type: fsStatus(["file", "directory", "symlink", "other"]), size: { type: "integer", minimum: 0 },
      modified_at: nullableString, created_at: nullableString, fingerprint: { type: "string" },
    });
    const fsWriteEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["written", "fingerprint_mismatch", "source_changed", "mixed_line_endings", "line_endings_required", "parent_missing", "not_found", "permission_denied", "failed"]), ...fsErrorProperty,
      size: { type: "integer", minimum: 0 }, size_before: { type: "integer", minimum: 0 }, size_after: { type: "integer", minimum: 0 },
      ...fsFingerprintProperties, ...fsTextProperties,
    });
    const fsEditEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["edited", "fingerprint_mismatch", "source_changed", "occurrence_mismatch", "mixed_line_endings", "line_endings_required", "not_found", "permission_denied", "failed"]), ...fsErrorProperty,
      size: { type: "integer", minimum: 0 }, size_before: { type: "integer", minimum: 0 }, size_after: { type: "integer", minimum: 0 },
      ...fsFingerprintProperties, ...fsTextProperties, replacements: { type: "integer", minimum: 0 }, edits: { type: "array", items: fsEditResult },
    });
    const fsTextRepresentation = {
      type: "object", additionalProperties: false,
      properties: {
        encoding: { type: "string" },
        line_endings: { type: "string", enum: ["lf", "crlf", "cr", "mixed", "none"] },
        bom: { type: "boolean" },
      },
      required: ["encoding", "line_endings", "bom"],
    };
    const fsTextConvertEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["converted", "unchanged", "fingerprint_mismatch", "source_changed", "not_found", "not_file", "permission_denied", "failed"]), ...fsErrorProperty,
      size: { type: "integer", minimum: 0 }, size_before: { type: "integer", minimum: 0 }, size_after: { type: "integer", minimum: 0 },
      ...fsFingerprintProperties, before: fsTextRepresentation, after: fsTextRepresentation,
    });
    const fsMkdirEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["created", "exists", "not_directory", "parent_missing", "permission_denied", "failed"]), ...fsErrorProperty,
      type: fsStatus(["directory"]), size: { type: "integer", minimum: 0 },
    });
    const fsCopyEntry = fsEntry({
      from: { type: "string" }, to: { type: "string" },
      status: fsStatus(["copied", "not_found", "destination_exists", "invalid_destination", "parent_missing", "failed_partial", "permission_denied", "failed"]),
      ...fsErrorProperty,
    }, ["from", "to", "status"]);
    const fsMoveEntry = fsEntry({
      from: { type: "string" }, to: { type: "string" },
      status: fsStatus(["moved", "not_found", "destination_exists", "invalid_destination", "parent_missing", "failed_partial", "permission_denied", "failed"]),
      ...fsErrorProperty,
    }, ["from", "to", "status"]);
    const fsTrashEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["trashed", "not_found", "invalid_target", "failed_partial", "permission_denied", "failed"]), ...fsErrorProperty,
    });
    const fsUntrashEntry = fsEntry({
      path: { type: "string" }, status: fsStatus(["restored", "wrong_workspace", "invalid_payload", "not_in_trash", "destination_exists", "parent_missing", "failed_partial", "permission_denied", "failed"]), ...fsErrorProperty,
    });
    const fsResumePoint = {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path"],
    };
    const stringArray = { type: "array", items: { type: "string" } };
    const envelopeProperties = {
      chat_session: { type: "string", description: CHAT_SESSION_OUTPUT_DESCRIPTION },
      error: { type: "string" },
    };
    const outputSchema = (properties = {}) => ({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false,
      properties: { ...envelopeProperties, ...properties },
      required: ["chat_session"],
    });
    const strictOutputSchema = properties => ({ ...outputSchema(properties), required: ["chat_session", ...Object.keys(properties)] });
    const inspectedToolOutput = {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: "string" },
        descriptor_json: { type: "string", description: "Exact canonical published MCP tool descriptor serialized as JSON." },
      },
      required: ["name", "descriptor_json"],
    };
    const cdpImageOutput = {
      type: "object", additionalProperties: false,
      properties: {
        encoding: { type: "string", const: "base64" }, format: { type: "string", enum: ["png", "jpeg", "webp"] }, mime_type: { type: "string" },
        bytes: { type: "integer", minimum: 0 }, scale: { type: "number", exclusiveMinimum: 0, maximum: 4 }, quality: { anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, { type: "null" }] },
      },
      required: ["encoding", "format", "mime_type", "bytes", "scale", "quality"],
    };
    const cdpCallResultOutput = {
      type: "object", additionalProperties: false,
      properties: {
        browser: { type: "string" }, port: { anyOf: [{ type: "integer" }, { type: "null" }] }, user_data_dir: nullableString,
        target: nullableString, target_id: nullableString, session_id: nullableString,
        id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, queued: { type: "boolean" },
        cdp: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] }, image: { anyOf: [cdpImageOutput, { type: "null" }] }, setup_errors: stringArray,
        success: { type: "boolean" }, error: nullableString,
      },
      required: ["browser", "port", "user_data_dir", "target", "target_id", "session_id", "id", "queued", "cdp", "image", "setup_errors", "success", "error"],
    };
    const cdpSubscriptionOutputSchema = {
      type: "object", additionalProperties: false,
      properties: {
        subscription: { type: "string" }, browser: { type: "string" }, targets: stringArray, methods: stringArray, method_prefixes: stringArray,
        include_browser: { type: "boolean" }, regex: { type: "string" }, regex_flags: { type: "string" }, cursor: { type: "integer", minimum: 0 },
        dropped: { type: "integer", minimum: 0 }, stream_resets: { type: "integer", minimum: 0 },
      },
      required: ["subscription", "browser", "targets", "methods", "method_prefixes", "include_browser", "regex", "regex_flags", "cursor", "dropped", "stream_resets"],
    };
    const memorySummaryOutput = {
      type: "object", additionalProperties: false,
      properties: { count: { type: "integer", minimum: 0 }, latest_keys: stringArray }, required: ["count", "latest_keys"],
    };
    const memoryOutput = {
      type: "object", additionalProperties: false,
      properties: {
        id: { type: "integer", minimum: 1 }, scope: { type: "string", enum: ["global", "session", "workspace"] },
        session_id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, workspace: nullableString,
        key: { type: "string" }, json: { type: "boolean" }, value: {}, ttl_seconds: { type: "integer", minimum: 0 }, set_at: { type: "string" }, expires_at: nullableString,
      },
      required: ["id", "scope", "session_id", "workspace", "key", "json", "value", "ttl_seconds", "set_at", "expires_at"],
    };
    const processProperties = {
      exec_id: { type: "integer", minimum: 1, description: "Present for persistent processes created by exec_start; equals that exec_start Tool Call id." },
      operation_id: { type: "string", description: "Echoed only when the process was started with a client-chosen operation_id replay key." },
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
    const searchScopeOutputSchema = {source_directory:{type:"string",description:"Absolute directory containing the searched files."},index_directory:{type:"string",description:"Absolute persistent search index directory."},workspace_selected:{type:"boolean",description:"false means the configured default search directory was used; the Session still has no Workspace."}};
    const outputSchemas = {
      init_chat_session: outputSchema(),
      chat_set_goal: outputSchema({
        goal: { type: "string" }, timeout_seconds: { type: "integer" }, status: { type: "string", enum: CHAT_GOAL_STATUSES },
        chatgpt_chat_id: nullableString, chat_url: nullableString, detail: nullableString,
        next_check_at: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Next scheduler check as Unix milliseconds; null when disabled or suspended." },
        last_sent_at: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Last confirmed message as Unix milliseconds." },
        browser: { type: "string" }, user_data_dir: { type: "string" },
      }),
      list_workspaces: outputSchema({ workspaces: stringArray }),
      open_workspace: outputSchema({
        workspace_name: { type: "string", description: "Unique Workspace name selected for the returned Session." },
        cwd: { type: "string", description: "Absolute path of the selected Workspace." },
        agent_guidance_path: {
          ...nullableString,
          description: "Absolute Workspace-level guidance path. Resolution prefers AGENTS.md/agents.md, then falls back to CLAUDE.md/Claude.md/claude.md. When non-null, read and follow it before modifying files under this Workspace.",
        },
        workspace_created: { type: "boolean", description: "True only when this open_workspace call explicitly used create=true and created the missing Workspace." },
        memory_summary: { type: "object", additionalProperties: false, properties: { global: memorySummaryOutput, workspace: memorySummaryOutput, session: memorySummaryOutput }, required: ["global", "workspace", "session"] },
      }),
      fs_glob: strictOutputSchema({ metadata: { type: "boolean" }, returned: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 }, entries: fsArray(fsGlobEntry), next_after_path: nullableString, truncated: { type: "boolean" } }),
      fs_grep: strictOutputSchema({ mode: { type: "string", enum: ["matches", "files", "count"] }, scanned_files: { type: "integer", minimum: 0, description: "Candidate files examined on this page after path resolution, including oversized files and later read/decode failures. Not a count of successfully searched files." }, matched_files: { type: "integer", minimum: 0 }, skipped_large_files: { type: "integer", minimum: 0, description: "Candidates omitted on this page because their observed source size exceeds max_file_bytes. Excludes filtered paths and candidates not yet visited." }, max_file_bytes: { type: "integer", minimum: 1, maximum: 52428800 }, returned: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 }, truncation_reason: { anyOf: [{ type: "string", enum: ["limit", "walk_limit"] }, { type: "null" }] }, files: fsArray(fsGrepEntry), next_resume_after: { anyOf: [fsResumePoint, { type: "null" }] }, truncated: { type: "boolean" } }),
      fs_read: strictOutputSchema({ files: fsArray(fsReadEntry) }),
      fs_navigate: strictOutputSchema({ files: fsArray(fsNavigateEntry) }),
      document_grep: strictOutputSchema({...searchScopeOutputSchema,mode:{type:"string",enum:["fulltext","vector","hybrid"]},gitignore:{type:"boolean"},indexed_files:{type:"integer",minimum:0},indexed_chunks:{type:"integer",minimum:0},reindexed_files:{type:"integer",minimum:0},unchanged_files:{type:"integer",minimum:0},removed_files:{type:"integer",minimum:0},scanned_files:{type:"integer",minimum:0},truncated:{type:"boolean"},error_count:{type:"integer",minimum:0},errors:{type:"array",items:{type:"object",additionalProperties:false,properties:{path:{type:"string"},error:{type:"string"}},required:["path","error"]}},returned:{type:"integer",minimum:0},results:{type:"array",items:{type:"object",additionalProperties:false,properties:{id:{type:"string"},path:{type:"string"},mime:{type:"string"},chunk:{type:"integer",minimum:0},text:{type:"string"},start_line:{type:"integer",minimum:1},end_line:{type:"integer",minimum:1},score:{type:"number"}},required:["id","path","mime","chunk","text","start_line","end_line","score"]}}}),
      proxy_get: strictOutputSchema({ action: { type: "string", enum: ["pick", "list", "report"] }, mode: { type: "string", enum: ["random", "round_robin"] }, total: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 }, returned: { type: "integer", minimum: 0 }, next_offset: { anyOf: [{ type: "integer" }, { type: "null" }] }, next_retry_at: { anyOf: [{ type: "integer" }, { type: "null" }] }, proxies: { type: "array", items: { type: "object", additionalProperties: false, properties: { proxy_id: { type: "string" }, proxy: { anyOf: [{ type: "string" }, { type: "null" }] }, available: { type: "boolean" }, stats: { type: "object", additionalProperties: false, properties: Object.fromEntries(["successes","failures","consecutive_failures","last_selected_at","last_reported_at","cooldown_until"].map(key => [key, { type: "integer", minimum: 0 }])), required: ["successes","failures","consecutive_failures","last_selected_at","last_reported_at","cooldown_until"] } }, required: ["proxy_id","proxy","available","stats"] } }, errors: { type: "array", items: { type: "object", additionalProperties: false, properties: { source: { type: "integer" }, error: { type: "string" } }, required: ["source","error"] } } }),
      source_code_search: strictOutputSchema({ ...searchScopeOutputSchema, reindexed_files: {type:"integer",minimum:0}, unchanged_files: {type:"integer",minimum:0}, removed_files: {type:"integer",minimum:0}, scanned_files: {type:"integer",minimum:0}, action: { type: "string", enum: SOURCE_CODE_ACTIONS }, mode: { type: "string", const: "lexical" }, gitignore: { type: "boolean", const: true }, path: { type: "string" }, indexed_files: { type: "integer", minimum: 0 }, indexed_chunks: { type: "integer", minimum: 0 }, skipped_large_files: { type: "integer", minimum: 0 }, skipped_unsupported_files: { type: "integer", minimum: 0 }, error_count: { type: "integer", minimum: 0 }, errors: { type: "array", items: { type: "object", properties: { path: { type: "string" }, error: { type: "string" } }, required: ["path", "error"], additionalProperties: false } }, truncation_reason: { anyOf: [{ type: "string", enum: ["walk_limit", "walk_error", "max_files", "total_bytes"] }, { type: "null" }] }, truncated: { type: "boolean" }, returned: { type: "integer", minimum: 0 }, next_offset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, data: { type: "object", additionalProperties: true } }),
      fs_stat: strictOutputSchema({ entries: fsArray(fsStatEntry) }),
      fs_write: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, files: fsArray(fsWriteEntry) }),
      fs_edit: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, total_replacements: { type: "integer" }, files: fsArray(fsEditEntry) }),
      fs_text_convert_encoding_eol: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, files: fsArray(fsTextConvertEntry) }),
      fs_mkdir: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, entries: fsArray(fsMkdirEntry) }),
      fs_copy: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, entries: fsArray(fsCopyEntry) }),
      fs_move: strictOutputSchema({ succeeded: { type: "integer" }, failed: { type: "integer" }, entries: fsArray(fsMoveEntry) }),
      fs_trash: strictOutputSchema({ trash_id: nullableString, trash_path: nullableString, succeeded: { type: "integer" }, failed: { type: "integer" }, entries: fsArray(fsTrashEntry) }),
      fs_untrash: strictOutputSchema({ trash_id: { type: "string" }, succeeded: { type: "integer" }, failed: { type: "integer" }, entries: fsArray(fsUntrashEntry) }),
      workspace_dev_preferences_write: strictOutputSchema({
        path: { type: "string", enum: ["DEV_PREF.md"] },
        status: { type: "string", enum: ["created", "already_exists"] },
        created: { type: "boolean" },
      }),
      desktop_auto: strictOutputSchema({
        results: { type: "array", items: {} },
        state: { type: "object", additionalProperties: true },
        images: { type: "array", items: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string", description: "Transport id inserted into each corresponding retained image object as image_id." }, state_paths: { ...stringArray, description: "Every final $.state path referencing this same materialized image." },
            format: { type: "string", enum: ["webp", "png"] }, mime_type: { type: "string" },
            bytes: { type: "integer", minimum: 0 }, rect: { type: "object", additionalProperties: true },
            grayscale: { type: "boolean" }, scale: { type: "number", exclusiveMinimum: 0, maximum: 1 },
            content_index: { type: "integer", minimum: 1, description: "Zero-based index in the MCP CallToolResult.content array. Index 0 is the JSON TextContent; image blocks therefore start at 1." },
          },
          required: ["id", "state_paths", "format", "mime_type", "bytes", "rect", "grayscale", "scale", "content_index"],
        } },
      }),
      publish: outputSchema({
        id: { type: "string" }, content_id: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" }, size: { type: "integer" },
        source: { type: "string", enum: ["path", "text", "base64"], description: "Source form used by this publish call; useful only as presentation/debug metadata." },
        uri: { type: "string", description: "Persistent HTTPS URL of the published content itself. Browser-displayable MIME types open inline; opaque/binary MIME types are attachments." },
        presentation: { type: "string", enum: ["auto", "inline", "download"] }, title: { type: "string" }, description: { type: "string" },
        height: { type: "integer" }, created_at: { type: "string" },
      }),
      cdp_call: outputSchema({ wait: { type: "boolean" }, results: { type: "array", items: cdpCallResultOutput } }),
      cdp_subs: outputSchema({
        browser: { type: "string" }, added: { type: "array", items: cdpSubscriptionOutputSchema }, removed: stringArray, missing: stringArray,
        subscriptions: { type: "array", items: cdpSubscriptionOutputSchema },
      }),
      cdp_poll: outputSchema({
        browser: { type: "string" }, subscription: nullableString, messages: objectArray, cursor: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        dropped: { type: "integer", minimum: 0 }, stream_resets: { type: "integer", minimum: 0 }, oldest_seq: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, newest_seq: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      }),
      memory_find: outputSchema({ memories: { type: "array", items: memoryOutput }, next_before_id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] } }),
      memory_set: outputSchema({ memory: { anyOf: [memoryOutput, { type: "null" }] }, deleted: { type: "boolean" } }),
      telegram_req: outputSchema({
        method: { type: "string" }, response: { type: "object", additionalProperties: true },
        migrated_chat_id: { anyOf: [
          { type: "object", additionalProperties: false, properties: { from: {}, to: {} }, required: ["from", "to"] },
          { type: "null" },
        ] },
      }),
      discover_commands: outputSchema({ commands: {
        type: "array", items: {
          type: "object", additionalProperties: false,
          properties: {
            logical_name: { type: "string", description: "Pass this value directly as exec.program." },
            description: { type: "string" },
            documentation_url: { type: "string" },
          },
          required: ["logical_name", "description"],
        },
      } }),
      tools_schema: outputSchema({ tools: { type: "array", items: inspectedToolOutput }, missing: stringArray }),
      tools_log: outputSchema({ detail: { type: "string", enum: ["summary", "full"] }, returned: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 }, next_before_id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, truncated: { type: "boolean" }, calls: objectArray }),
      exec: outputSchema(processProperties),
      exec_start: outputSchema({
        operation_id: processProperties.operation_id,
        exec_id: { type: "integer", minimum: 1 }, status: { type: "string" }, command: {},
        cwd: { type: "string" }, started_at: { type: "string" }, stdin_open: { type: "boolean" },
      }),
      exec_attach: outputSchema({
        ...processProperties,
        remaining_bytes: {
          type: "integer", minimum: 0,
          description: "UTF-8 bytes already buffered after the output returned by this attach call. When greater than zero, call exec_attach again immediately to drain the next chunk.",
        },
        wait_timed_out: { type: "boolean", description: "True when this attachment's bounded wait expired while the persistent process was still running. This does not mean the process itself timed out." },
      }),
      exec_write: outputSchema({ exec_id: { type: "integer", minimum: 1 }, bytes_written: { type: "integer" }, stdin_open: { type: "boolean" } }),
      exec_kill: outputSchema({ exec_id: { type: "integer", minimum: 1 }, killed: { type: "boolean" }, signal: { type: "string" } }),
      exec_list: outputSchema({ processes: objectArray }),
      exec_status: outputSchema({
        ...processProperties,
        output_mode: { type: "string", enum: ["none", "all", "tail"] },
        attached: { type: "boolean" },
      }),
      js: outputSchema({ kernel_id: { type: "string" }, cwd: { type: "string" }, value: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, module_dirs: stringArray }),
      js_add_node_module_dir: outputSchema({ kernel_id: { type: "string" }, path: { type: "string" }, module_dirs: stringArray }),
      js_reset: outputSchema({ reset: { type: "boolean" }, kernel_id: { type: "string" } }),
    };
    const genericOutputSchema = outputSchema();
    const processOutputSchema = outputSchema(processProperties);

    outputSchemas.chat_goal_debug = outputSchema({ ...outputSchemas.chat_set_goal.properties,
      action: { type: "string", enum: ["status", "match", "send"] },
      operation_status: { type: "string", enum: ["inspected", "deferred", "matched", "not_found", "sent", "failed"] },
      operation_detail: nullableString, enabled: { type: "boolean" }, login_ready: { type: "boolean" },
      login_status: { type: "string" }, chat_session_matched: { type: "boolean" }, scheduler_busy: { type: "boolean" },
      due_at: { anyOf: [{ type: "integer" }, { type: "null" }] },
    });
    const titles = {
      init_chat_session: "Initialize Chat Session", chat_set_goal: "Set Chat Goal", chat_goal_debug: "Debug Chat Goal", list_workspaces: "List Workspaces", open_workspace: "Open Workspace",
      fs_glob: "FS Glob", fs_grep: "FS Grep", fs_read: "FS Read", fs_navigate: "FS Navigate", fs_stat: "FS Stat", source_code_search: "Source Code Search", document_grep: "Document Grep", proxy_get: "Get Proxy",
      fs_write: "FS Write", fs_edit: "FS Edit", fs_mkdir: "FS Mkdir", fs_copy: "FS Copy", fs_move: "FS Move", fs_trash: "FS Trash", fs_untrash: "FS Untrash",
      desktop_auto: "Desktop Auto", publish: "Publish to User", cdp_call: "CDP Call", cdp_subs: "CDP Subscriptions", cdp_poll: "CDP Poll", memory_find: "Memory Find", memory_set: "Memory Set", telegram_req: "Telegram Request", discover_commands: "Discover Commands", tools_schema: "Tools Schema", tools_log: "Tools Log",
      exec: "Run Command", exec_start: "Start Persistent Command", exec_attach: "Attach Process Output", exec_write: "Write Stdin",
      exec_kill: "Terminate Process", exec_list: "List Processes", exec_status: "Process Status", js: "JavaScript Kernel",
      js_add_node_module_dir: "Add Module Directory", js_reset: "Reset JavaScript Kernel",
      workspace_dev_preferences_write: "Write Workspace Dev Preferences", fs_text_convert_encoding_eol: "Convert Text Encoding / EOL",
    };
    const annotations = name => ({
      readOnlyHint: READ_TOOLS.has(name) || name === "publish" || name === "cdp_poll" || name === "memory_find",
      destructiveHint: ["desktop_auto", "cdp_call", "memory_set", "telegram_req", "fs_write", "fs_edit", "fs_text_convert_encoding_eol", "fs_move", "exec", "exec_start", "exec_write", "exec_kill", "js", "js_add_node_module_dir", "js_reset"].includes(name),
      idempotentHint: (READ_TOOLS.has(name) && name !== "publish") || ["fs_write", "fs_mkdir", "fs_text_convert_encoding_eol", "js_reset", "workspace_dev_preferences_write"].includes(name),
      openWorldHint: name === "proxy_get" || name === "document_grep" || name === "desktop_auto" || name === "chat_goal_debug" || name.startsWith("cdp_") || name.startsWith("exec") || name === "js" || name === "publish" || name === "telegram_req",
    });
    const schema = value => ({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false, ...value,
    });
    const withRequiredContext = value => ({
      ...value,
      properties: { ...contextInput, ...value.properties },
      required: [...new Set([...(value.required || []), "chat_session"])],
    });
    const tools = [...available].filter(name => defs[name]).map(name => {
      const requiresContext = name !== "init_chat_session";
      return {
        name,
        title: titles[name] || name.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
        description: requiresContext ? `${defs[name][0]} ${CHAT_SESSION_RULE}` : defs[name][0],
        inputSchema: schema(requiresContext ? withRequiredContext(defs[name][1]) : defs[name][1]),
        outputSchema: outputSchemas[name] || genericOutputSchema,
        annotations: annotations(name),
        ...(name === "publish" ? { _meta: { ui: { resourceUri: publishUiResourceUri } } } : {}),
      };
    });
    for (const custom of all("SELECT * FROM custom_tools WHERE server_id=? ORDER BY name", p.id)) tools.push({
      name: custom.name,
      title: custom.name.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
      description: `${custom.description || `Run configured command: ${custom.command}`} This is a foreground command with the same replay/timeout contract as exec: optional operation_id deduplicates identical retries for the active process plus a 5-minute completion grace, and timeout_ms defaults to 45 seconds but is configurable up to 1 hour. High request timeouts can cross client/proxy retry or replay windows and may run non-idempotent commands more than once, so prefer exec_start for long-running work. Normalized combined output may stream as request-scoped progress, the final result contains buffered status/output, and client disconnect/cancellation terminates the child. ${CHAT_SESSION_RULE}`,
      inputSchema: schema({ properties: {
        args: { type: "array", items: { type: "string" }, default: [], description: "Argument vector appended verbatim and in order to the configured command." }, shell_command_suffix: { type: "string" },
        cwd: { type: "string", default: "." }, env: { type: "object", additionalProperties: { type: "string" } },
        stdin: { type: "string" }, operation_id: operationIdInput, separate_streams: { type: "boolean", default: false }, timeout_ms: { type: "integer", minimum: 1, maximum: MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS, default: MCP_FOREGROUND_EXEC_DEFAULT_TIMEOUT_MS },
        ...contextInput,
      }, required: ["chat_session"] }),
      outputSchema: processOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
    serverToolCache.set(cacheKey, { list: tools, byName: new Map(tools.map(tool => [tool.name, tool])) });
    return tools;
  }
  function serverToolDescriptor(p, name) {
    const cacheKey = Number(p.id || 0);
    let cached = serverToolCache.get(cacheKey);
    if (!cached) {
      serverTools(p, true, false);
      cached = serverToolCache.get(cacheKey);
    }
    return cached?.byName.get(String(name || "")) || null;
  }
  function descriptorJson(descriptor) {
    if (!descriptor || typeof descriptor !== "object") return "";
    let json = descriptorJsonCache.get(descriptor);
    if (json == null) {
      json = JSON.stringify(descriptor);
      descriptorJsonCache.set(descriptor, json);
    }
    return json;
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
      if (!tool.outputSchema.required?.includes("chat_session"))
        errors.push("outputSchema missing required chat_session");
      const expectedOutputs = {
        chat_set_goal: ["goal", "timeout_seconds", "status", "chatgpt_chat_id", "chat_url", "next_check_at", "last_sent_at", "detail", "browser", "user_data_dir"],
        chat_goal_debug: ["goal", "status", "action", "operation_status", "operation_detail", "enabled", "login_ready", "login_status", "chat_session_matched", "scheduler_busy", "due_at"],
        list_workspaces: ["workspaces"],
        open_workspace: ["workspace_name", "cwd", "agent_guidance_path", "workspace_created", "memory_summary"],
        tools_schema: ["tools", "missing"],
        tools_log: ["detail", "returned", "limit", "next_before_id", "truncated", "calls"],
        publish: ["id", "filename", "mime_type", "source", "uri", "presentation", "title", "description", "height", "created_at"],
        cdp_call: ["wait", "results"],
        cdp_subs: ["browser", "added", "removed", "missing", "subscriptions"],
        cdp_poll: ["browser", "subscription", "messages", "cursor", "dropped", "stream_resets", "oldest_seq", "newest_seq"],
        memory_find: ["memories", "next_before_id"], memory_set: ["memory", "deleted"], telegram_req: ["method", "response", "migrated_chat_id"],
        fs_glob: ["metadata", "returned", "limit", "entries", "next_after_path", "truncated"],
        fs_grep: ["scanned_files", "matched_files", "skipped_large_files", "max_file_bytes", "returned", "limit", "truncation_reason", "files", "next_resume_after", "truncated"],
        fs_read: ["files"], fs_navigate: ["files"], fs_stat: ["entries"], source_code_search: ["action", "mode", "gitignore", "indexed_files", "indexed_chunks", "data", "errors", "truncated", "next_offset"], document_grep: ["mode", "gitignore", "indexed_files", "indexed_chunks", "reindexed_files", "unchanged_files", "removed_files", "errors", "results", "truncated"],
        fs_write: ["succeeded", "failed", "files"], fs_edit: ["succeeded", "failed", "total_replacements", "files"],
        fs_text_convert_encoding_eol: ["succeeded", "failed", "files"],
        fs_mkdir: ["succeeded", "failed", "entries"], fs_copy: ["succeeded", "failed", "entries"], fs_move: ["succeeded", "failed", "entries"],
        fs_trash: ["trash_id", "succeeded", "failed", "entries"], fs_untrash: ["trash_id", "succeeded", "failed", "entries"],
        workspace_dev_preferences_write: ["path", "status", "created"],
        desktop_auto: ["results", "state", "images"],
        exec_start: ["exec_id"],
        exec_attach: ["exec_id", "output", "remaining_bytes", "wait_timed_out"],
        exec_status: ["exec_id", "status", "output_mode"],
      };
      for (const key of expectedOutputs[tool.name] || [])
        if (!tool.outputSchema.properties?.[key]) errors.push(`outputSchema missing property ${key}`);
    }
    if (tool.name === "open_workspace") {
      const workspaceName = tool.inputSchema?.properties?.name;
      if (workspaceName?.type !== "string") errors.push("open_workspace name must be a string");
      if (workspaceName?.enum) errors.push("open_workspace name must not enumerate configured Workspace names");
      if (!tool.inputSchema?.properties?.create || tool.inputSchema.properties.create.type !== "boolean") errors.push("open_workspace missing optional boolean create");
      if (tool.inputSchema?.required?.includes("create")) errors.push("open_workspace create must be optional");
    }
    if (tool.inputSchema?.properties?.context_handle || tool.inputSchema?.properties?.current_context_handle || tool.inputSchema?.properties?.current_chat_session)
      errors.push("inputSchema exposes an obsolete Session argument");
    if (tool.name === "init_chat_session") {
      if (Object.keys(tool.inputSchema?.properties || {}).length || tool.inputSchema?.required?.length) errors.push("init_chat_session must accept no arguments");
    } else {
      if (!tool.inputSchema?.properties?.chat_session) errors.push("inputSchema missing chat_session");
      if (!tool.inputSchema?.required?.includes("chat_session")) errors.push("inputSchema chat_session must be required");
    }
    const expectedInputs = {
      chat_set_goal: ["goal", "timeout_seconds", "chat_session"],
      chat_goal_debug: ["action", "stop_before_send", "chat_session"],
      open_workspace: ["name", "create", "chat_session"],
      fs_glob: ["path", "include", "exclude", "gitignore", "hidden", "metadata", "limit", "after_path"],
      fs_grep: ["pattern", "path", "include", "exclude", "gitignore", "hidden", "regex", "case_sensitive", "encoding", "context_lines_before", "context_lines_after", "mode", "max_file_bytes", "limit", "resume_after"],
      fs_read: ["files", "max_output_bytes_per_file"], fs_navigate: ["pattern", "files", "regex", "case_sensitive", "context_lines_before", "context_lines_after"], fs_stat: ["paths", "fingerprint"], source_code_search: ["action", "query", "path", "include", "exclude", "file_path", "include_content", "limit", "offset"], document_grep: ["query", "mode", "path", "include", "exclude", "mime", "gitignore", "limit"],
      fs_write: ["files", "create_parents"], fs_edit: ["files"], fs_text_convert_encoding_eol: ["files", "encoding", "line_endings", "bom"], fs_mkdir: ["paths", "parents"],
      fs_copy: ["entries", "create_parents"], fs_move: ["entries", "create_parents"], fs_trash: ["paths", "selection"], fs_untrash: ["trash_id"],
      desktop_auto: ["yaml"], publish: ["path", "text", "base64", "mime_type", "filename", "presentation", "title", "description", "height"],
      cdp_call: ["wait", "calls"],
      cdp_subs: ["browser", "add", "remove"],
      cdp_poll: ["subscription", "browser", "target", "type", "id", "methods", "method_prefixes", "limit", "advance"],
      memory_find: ["scope", "workspace", "key", "key_prefix", "query", "regex", "case_sensitive", "set_after", "set_before", "limit", "before_id"],
      memory_set: ["scope", "workspace", "key", "value", "json", "delete", "ttl_seconds"],
      telegram_req: ["request"],
      tools_schema: ["names"],
      tools_log: ["id", "detail", "limit", "tool", "status", "query", "before_id"],
      exec: ["operation_id"], exec_start: ["operation_id"], exec_attach: ["exec_id", "timeout_ms"], exec_write: ["exec_id"], exec_kill: ["exec_id"], exec_status: ["exec_id", "output", "tail_lines"],
    };
    for (const key of expectedInputs[tool.name] || [])
      if (!tool.inputSchema.properties?.[key]) errors.push(`inputSchema missing property ${key}`);
    if (["exec_start", "exec_attach", "exec_write", "exec_kill", "exec_list", "exec_status"].includes(tool.name) && tool.inputSchema.properties?.label)
      errors.push(`${tool.name} must not expose a client-chosen process label`);
    if (["exec_attach", "exec_write", "exec_kill", "exec_status"].includes(tool.name) && tool.inputSchema.properties?.process_id)
      errors.push(`${tool.name} must use exec_id rather than process_id`);
    if (["exec", "exec_start", "exec_attach"].includes(tool.name) && tool.outputSchema.properties?.pid)
      errors.push(`${tool.name} output must not expose OS pid`);
    if (tool.name === "exec_attach" && ["wait_ms", "output_offset", "stdout_offset", "stderr_offset"].some(key => tool.inputSchema.properties?.[key]))
      errors.push("exec_attach must not expose offsets or a second polling-duration argument");
    if (tool.name === "exec") {
      const timeout = tool.inputSchema.properties?.timeout_ms;
      if (!timeout || timeout.default !== MCP_FOREGROUND_EXEC_DEFAULT_TIMEOUT_MS || timeout.maximum !== MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS)
        errors.push("exec foreground timeout default/maximum contract is invalid");
    }
    if (tool.name === "exec_attach") {
      const timeout = tool.inputSchema.properties?.timeout_ms;
      if (!timeout || timeout.default !== MCP_ATTACH_DEFAULT_TIMEOUT_MS || timeout.maximum !== MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS)
        errors.push("exec_attach timeout default/maximum contract is invalid");
      if (!tool.outputSchema.properties?.wait_timed_out) errors.push("exec_attach output missing wait_timed_out");
    }
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
    const publishView = publishResource();
    const publishTool = tools.find(tool => tool.name === "publish");
    const freshToolsA = serverTools(p, true, true), freshToolsB = serverTools(p, true, true);
    const freshPublishA = freshToolsA.find(tool => tool.name === "publish")?._meta?.ui?.resourceUri || "";
    const freshPublishB = freshToolsB.find(tool => tool.name === "publish")?._meta?.ui?.resourceUri || "";
    const uiErrors = [];
    const publishSchema = publishTool?.inputSchema;
    const openWorkspaceTool = tools.find(tool => tool.name === "open_workspace");
    const cdpCallTool = tools.find(tool => tool.name === "cdp_call");
    const cdpSubsTool = tools.find(tool => tool.name === "cdp_subs");
    const cdpPollTool = tools.find(tool => tool.name === "cdp_poll");
    const memoryFindTool = tools.find(tool => tool.name === "memory_find");
    const memorySetTool = tools.find(tool => tool.name === "memory_set");
    if (!publishTool || tools.some(tool => ["publish_file", "publish_html"].includes(tool.name)))
      uiErrors.push("unified publish tool surface is invalid");
    if (!tools.some(tool => tool.name === "init_chat_session") || !openWorkspaceTool || tools.some(tool => tool.name === "create_workspace") ||
        !openWorkspaceTool.inputSchema?.properties?.create || !openWorkspaceTool.inputSchema?.required?.includes("chat_session") ||
        !openWorkspaceTool.outputSchema?.properties?.memory_summary?.required?.includes("global") ||
        !openWorkspaceTool.outputSchema?.properties?.workspace_created)
      uiErrors.push("Workspace open/create surface is invalid");
    if (!publishSchema?.required?.includes("mime_type") || !publishSchema?.required?.includes("chat_session") || publishSchema?.oneOf?.length !== 3 ||
        !["path", "text", "base64"].every(name => publishSchema.oneOf.some(branch => branch.required?.length === 1 && branch.required[0] === name)))
      uiErrors.push("publish source/MIME schema is invalid");
    if (!cdpCallTool || !cdpSubsTool || !cdpPollTool || tools.some(tool => ["cdp_launch", "cdp_subscribe", "cdp_unsubscribe"].includes(tool.name)))
      uiErrors.push("CDP tool surface is invalid");
    const cdpCallSchema = cdpCallTool?.inputSchema;
    const cdpCallItem = cdpCallSchema?.properties?.calls?.items;
    const cdpOperationSchema = cdpCallItem?.properties?.call;
    const cdpBrowserSchemaValid = schema => schema?.anyOf?.some(option => option.type === "string") &&
      schema.anyOf.some(option => option.type === "object" && option.additionalProperties === false && option.required?.includes("name") &&
        ["name", "headless", "executable_path", "user_data_dir", "args", "websocket_url", "http_url", "port", "host", "connect_timeout_ms"].every(key => option.properties?.[key]));
    if (!cdpCallSchema?.required?.includes("calls") || !cdpCallSchema?.required?.includes("chat_session") ||
        cdpCallSchema?.properties?.browser || cdpCallSchema?.properties?.call || cdpCallSchema?.properties?.target ||
        cdpCallSchema?.properties?.calls?.minItems !== 1 || cdpCallItem?.required?.includes("browser") || !cdpCallItem?.required?.includes("call") ||
        cdpCallItem?.properties?.browser?.default !== "main" || !cdpBrowserSchemaValid(cdpCallItem?.properties?.browser) ||
        !cdpCallItem?.properties?.target?.anyOf?.some(option => option.type === "string") ||
        !cdpCallItem?.properties?.target?.anyOf?.some(option => option.type === "object" && option.additionalProperties === false && option.required?.includes("name") &&
          ["create_params", "initialize", "runtime", "page", "network", "service_worker", "focus_emulation", "binding", "background_service"].every(key => option.properties?.[key])) ||
        !cdpCallItem?.properties?._image || !cdpOperationSchema?.required?.includes("method") ||
        !cdpOperationSchema?.properties?.method || !cdpOperationSchema?.properties?.params || cdpOperationSchema?.additionalProperties !== false ||
        Object.keys(cdpOperationSchema?.properties || {}).some(key => !["method", "params"].includes(key)))
      uiErrors.push("CDP call schema must be always-batched with optional browser defaulting to main, method/params operations with _. extensions, optional image post-processing, and server-owned transport routing");
    if (!cdpSubsTool?.inputSchema?.properties?.add || !cdpSubsTool?.inputSchema?.properties?.remove ||
        !cdpBrowserSchemaValid(cdpSubsTool?.inputSchema?.properties?.browser) || !cdpBrowserSchemaValid(cdpPollTool?.inputSchema?.properties?.browser) ||
        !JSON.stringify(cdpSubsTool.inputSchema).includes("regex_flags") || !JSON.stringify(cdpSubsTool.inputSchema).includes('"const":"*"') ||
        !cdpPollTool?.inputSchema?.properties?.subscription || !cdpPollTool?.inputSchema?.properties?.id || !cdpPollTool?.inputSchema?.properties?.advance)
      uiErrors.push("CDP subscription/poll schema is incomplete");
    if (!memoryFindTool || !memorySetTool || tools.some(tool => tool.name === "memory_get") ||
        !memoryFindTool?.inputSchema?.required?.includes("scope") || !memorySetTool?.inputSchema?.required?.includes("scope") ||
        !JSON.stringify(memoryFindTool?.inputSchema?.properties?.scope || {}).includes('"*"') ||
        !JSON.stringify(memoryFindTool?.inputSchema?.properties?.scope || {}).includes('"uniqueItems":true') ||
        !memoryFindTool?.inputSchema?.properties?.regex || !memoryFindTool?.inputSchema?.properties?.case_sensitive ||
        !memorySetTool?.inputSchema?.properties?.scope?.enum?.includes("global") ||
        !memorySetTool?.inputSchema?.required?.includes("key") || !memorySetTool?.inputSchema?.properties?.ttl_seconds)
      uiErrors.push("memory tool surface/schema is invalid");
    if (!matchesUiResourceUri(freshPublishA, PUBLISH_UI_URI) || freshPublishA === PUBLISH_UI_URI || freshPublishA === freshPublishB)
      uiErrors.push("fresh UI resource URI generation failed");
    if (publishView.uri !== PUBLISH_UI_URI) uiErrors.push("unexpected UI resource URI");
    if (publishView.mimeType !== MCP_UI_MIME_TYPE) uiErrors.push("unexpected UI resource MIME type");
    if (!publishAppHtml().includes("ui/notifications/tool-result")) uiErrors.push("UI bridge listener missing");
    if (publishAppHtml().includes("data:")) uiErrors.push("publish UI must not embed data URLs");
    if (!publishAppHtml().includes("structured.uri") || !publishAppHtml().includes("structured.presentation") ||
        !publishAppHtml().includes("structured.title") || !publishAppHtml().includes("structured.description") ||
        !publishAppHtml().includes("structured.source") || !publishAppHtml().includes("structured.size"))
      uiErrors.push("UI structuredContent presentation/metadata handling missing");
    if (!publishAppHtml().includes('id="originalOpen"') || !publishAppHtml().includes("if (uri && kind)") ||
        !publishAppHtml().includes("originalOpen.href = uri") || !publishAppHtml().includes('target="_blank"'))
      uiErrors.push("UI preview-only original-content action missing");
    if (!publishAppHtml().includes("publicationId")) uiErrors.push("UI publication identity pinning missing");
    if (publishAppHtml().includes("openai:set_globals") || publishAppHtml().includes("openai.toolOutput"))
      uiErrors.push("UI must not consume ChatGPT-global tool output");
    if (publishAppHtml().includes("var nextId = 1;")) uiErrors.push("UI bridge request ids must not share a fixed initial value");
    if ((publishAppHtml().match(/ui\/notifications\/initialized/g) || []).length < 2)
      uiErrors.push("UI initialize-timeout recovery missing");
    if (!publishAppHtml().includes("sandbox=\"allow-scripts") || publishAppHtml().includes("allow-same-origin"))
      uiErrors.push("publish nested iframe sandbox is invalid");
    if (!publishUiMeta().ui?.csp?.frameDomains?.includes(publicOrigin()) || !publishUiMeta().ui?.csp?.resourceDomains?.includes(publicOrigin()))
      uiErrors.push("publish UI CSP metadata missing public origin");
    if (publishTool?._meta?.ui?.resourceUri !== PUBLISH_UI_URI) uiErrors.push("publish UI metadata missing");
    if (Object.keys(publishTool?._meta || {}).some(key => key.startsWith("openai/")))
      uiErrors.push("publish widget must use only MCP Apps UI metadata");
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
        ttlMs: 0,
        cacheScope: "private",
      },
      modern_tools_list_result: {
        resultType: "complete",
        tools,
        ttlMs: 0,
        cacheScope: "private",
      },
      resources_list_result: { resources: [publishView] },
      resources_read_result: {
        resultType: "complete",
        contents: [
          { uri: PUBLISH_UI_URI, mimeType: MCP_UI_MIME_TYPE, text: publishAppHtml(), _meta: publishUiMeta() },
        ],
        ttlMs: 0,
        cacheScope: "private",
      },
    };
  }

  const sniffLogBinaryMime = bytes => {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
    if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
    return "";
  };
  const decodeLogBase64 = value => {
    const text = String(value || "").replace(/\s+/g, "");
    if (text.length < 16 || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
    try { return Buffer.from(text, "base64"); } catch { return null; }
  };
  const sniffLogBase64ValueMime = value => {
    const source = String(value || "");
    let prefix = "";
    for (let index = 0; index < source.length && prefix.length < 24; index++) {
      const character = source[index];
      if (/\s/.test(character)) continue;
      if (!/[A-Za-z0-9+/=]/.test(character)) return "";
      prefix += character;
    }
    if (prefix.length < 16) return "";
    const usable = prefix.slice(0, prefix.length - (prefix.length % 4));
    try { return sniffLogBinaryMime(Buffer.from(usable, "base64")); } catch { return ""; }
  };
  const TOOL_CALL_PAYLOAD_MODES = new Set(["payload", "metadata"]), TOOL_CALL_STORAGES = new Set(["disk", "memory"]);
  const METADATA_ERROR_CHARS = 2000;
  const toolCallPolicyById = new Map();
  let lastToolCallId = Math.max(Number(one("SELECT MAX(id) id FROM main.logs")?.id || 0), Date.now() * 1000);
  function toolCallPayloadMode() {
    const mode = String(getCfg("tool_call_payload_mode", "payload")).toLowerCase();
    return TOOL_CALL_PAYLOAD_MODES.has(mode) ? mode : "payload";
  }
  function toolCallStorage() {
    const storage = String(getCfg("tool_call_storage", "disk")).toLowerCase();
    return TOOL_CALL_STORAGES.has(storage) ? storage : "disk";
  }
  function allocateToolCallId() {
    lastToolCallId = Math.max(lastToolCallId + 1, Date.now() * 1000);
    if (!Number.isSafeInteger(lastToolCallId)) throw new Error("Tool Call id space exhausted");
    return lastToolCallId;
  }
  const toolCallModeKeepsJson = mode => mode === "payload";
  const logTableForStorage = storage => storage === "memory" ? "logs_memory" : "main.logs";
  function toolCallJsonForMode(mode, value) {
    if (mode !== "payload") return "";
    return JSON.stringify(value, (_key, item) => typeof item === "string" ? redactPublishedText(item) : item);
  }
  function toolCallMcpRequest(tool, args, packet = null) {
    return packet && typeof packet === "object" ? packet : {
      jsonrpc: "2.0", id: null, method: "tools/call", params: { name: String(tool || ""), arguments: args || {} },
    };
  }
  function toolCallMcpResponse(result, packet = undefined) {
    return packet !== undefined ? packet : { jsonrpc: "2.0", id: null, result };
  }
  function mcpPacketObject(value) {
    return typeof value === "string" ? parseJson(value, null) : (value && typeof value === "object" ? value : null);
  }
  function mcpToolArgsFromPacket(value) {
    const packet = mcpPacketObject(value), args = packet?.params?.arguments;
    return args && typeof args === "object" ? args : {};
  }
  function mcpToolStructuredResultFromPacket(value) {
    const packet = mcpPacketObject(value), structured = packet?.result?.structuredContent;
    return structured && typeof structured === "object" ? structured : {};
  }
  function toolCallErrorForMode(mode, value) {
    const text = redactPublishedText(value);
    return mode === "payload" ? text : text.slice(0, METADATA_ERROR_CHARS);
  }
  function finishToolCallRuntime(id) {
    toolCallPolicyById.delete(Number(id || 0));
  }

  function beginLog(p, tool, args, contextHandle = "", root = null, descriptor = null, notifyStart = true, progressRequested = false, contextRecord = null, mcpRequest = null) {
    const context = contextRecord || contextByHandle(p, contextHandle), contextId = Number(context?.id || 0), now = Date.now();
    const previous = contextId ? sessionToolStats(p, contextId) : null;
    const previousCalls = Number(previous?.tool_calls || 0), lastCallAt = Number(previous?.last_call_at || 0);
    const policy = { storage: toolCallStorage(), payloadMode: toolCallPayloadMode() }, id = allocateToolCallId();
    const table = logTableForStorage(policy.storage), begin = policy.storage === "disk" ? "BEGIN IMMEDIATE" : "BEGIN";
    db.exec(begin);
    try {
      run(`INSERT INTO ${table}(id,started_at,server_id,server_name,tool,status,mcp_request_json,
        context_id,context_handle,root_id,root_name,root_path,progress_requested,payload_mode) VALUES(?,?,?,?,?,'running',?,?,?,?,?,?,?,?)`,
        id, now, p.id, "mcp", tool, toolCallJsonForMode(policy.payloadMode, toolCallMcpRequest(tool, args, mcpRequest)), contextId, String(contextHandle || ""),
        Number(root?.id || 0), String(root?.name || ""), String(root?.path || ""), progressRequested ? 1 : 0, policy.payloadMode);
      if (descriptor) recordToolCallDescriptor(id, descriptorJson(descriptor), policy.storage);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    toolCallPolicyById.set(id, policy);
    const currentCalls = previousCalls + 1, sessionLabel = context
      ? sessionNotificationLabel(p, context, currentCalls, now, root?.name || "") : "";
    if (context && previousCalls && now - lastCallAt >= SESSION_ACTIVE_MS) postOsNotification("session", "🟢 Session Active", sessionLabel);
    if (notifyStart) postOsNotification("tool_call", `🛠️ Tool Call #${id}`, toolCallNotificationBody(p, tool, args, contextHandle, root, "", progressRequested, context, currentCalls));
    return id;
  }
  function updateLog(id, fields) {
    const logId = Number(id || 0), policy = toolCallPolicyById.get(logId);
    if (!policy) return;
    const keys = Object.keys(fields);
    if (!keys.length) return;
    run(`UPDATE ${logTableForStorage(policy.storage)} SET ${keys.map(k => `${k}=?`).join(",")} WHERE id=?`, ...keys.map(k => fields[k]), logId);
  }
  const deferredLogIndexes = new Map(), descriptorIdCache = new Map();
  let deferredLogMaintenanceTimer = null, nextToolCallRetentionSweepAt = 0, nextToolCallMemorySweepAt = 0;
  function recordToolCallDescriptor(logId, descriptorJsonText, storage) {
    if (storage === "memory") {
      statement("INSERT INTO tool_call_descriptors_memory(log_id,descriptor_json) VALUES(?,?)").run(logId, descriptorJsonText);
      return;
    }
    let descriptorId = descriptorIdCache.get(descriptorJsonText);
    if (!descriptorId) {
      statement("INSERT OR IGNORE INTO main.tool_descriptors(descriptor_json) VALUES(?)").run(descriptorJsonText);
      descriptorId = Number(one("SELECT id FROM main.tool_descriptors WHERE descriptor_json=?", descriptorJsonText)?.id || 0);
      if (descriptorId) descriptorIdCache.set(descriptorJsonText, descriptorId);
    }
    if (descriptorId) statement("INSERT INTO main.tool_call_descriptors(log_id,descriptor_id) VALUES(?,?)").run(logId, descriptorId);
  }
  function flushDeferredLogWork() {
    if (deferredLogMaintenanceTimer) clearTimeout(deferredLogMaintenanceTimer);
    deferredLogMaintenanceTimer = null;
    for (const [id, storage] of deferredLogIndexes) indexLog(id, storage);
    deferredLogIndexes.clear();
  }
  function indexLog(id, storage = "disk") {
    if (!fts) return;
    try {
      const source = logTableForStorage(storage), target = storage === "memory" ? "logs_fts_memory" : "main.logs_fts";
      const l = one(`SELECT server_name,tool,mcp_request_json,mcp_response_json,error FROM ${source} WHERE id=?`, id);
      if (!l) return;
      statement(`DELETE FROM ${target} WHERE rowid=?`).run(id);
      statement(`INSERT INTO ${target}(rowid,server,tool,request,response,error) VALUES(?,?,?,?,?,?)`).run(
        id, l.server_name, l.tool, l.mcp_request_json, l.mcp_response_json, l.error,
      );
    } catch {}
  }
  function toolCallRetentionHours() {
    const hours = Number(getCfg("tool_call_retention_hours", "0"));
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  }
  function toolCallMemoryRetentionMinutes() {
    const minutes = Number(getCfg("tool_call_memory_retention_minutes", "60"));
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  }
  function invalidateToolCallHistoryCaches(reason) {
    descriptorIdCache.clear();
    emitUiChange(["dashboard", "logs", "sessions", "roots", "settings"], reason);
  }
  function pruneDiskToolCallRetention(now = Date.now()) {
    nextToolCallRetentionSweepAt = now + 60 * 60 * 1000;
    const hours = toolCallRetentionHours();
    if (!hours) return 0;
    const cutoff = now - hours * 60 * 60 * 1000;
    const eligible = `completed_at IS NOT NULL AND completed_at<?`;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (fts) statement(`DELETE FROM main.logs_fts WHERE rowid IN (SELECT id FROM main.logs WHERE ${eligible})`).run(cutoff);
      const result = statement(`DELETE FROM main.logs WHERE ${eligible}`).run(cutoff);
      statement("DELETE FROM main.tool_descriptors WHERE NOT EXISTS (SELECT 1 FROM main.tool_call_descriptors calls WHERE calls.descriptor_id=main.tool_descriptors.id)").run();
      db.exec("COMMIT");
      const removed = Number(result.changes || 0);
      if (removed) invalidateToolCallHistoryCaches("tool-call-retention-disk");
      return removed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function pruneMemoryToolCallRetention(now = Date.now()) {
    nextToolCallMemorySweepAt = now + 60 * 1000;
    const minutes = toolCallMemoryRetentionMinutes();
    if (!minutes) return 0;
    const cutoff = now - minutes * 60 * 1000;
    const ids = all(`SELECT id FROM logs_memory WHERE completed_at IS NOT NULL AND completed_at<?`, cutoff).map(row => Number(row.id));
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    db.exec("BEGIN");
    try {
      if (fts) statement(`DELETE FROM logs_fts_memory WHERE rowid IN (${placeholders})`).run(...ids);
      statement(`DELETE FROM tool_call_descriptors_memory WHERE log_id IN (${placeholders})`).run(...ids);
      const result = statement(`DELETE FROM logs_memory WHERE id IN (${placeholders})`).run(...ids);
      db.exec("COMMIT");
      const removed = Number(result.changes || 0);
      if (removed) invalidateToolCallHistoryCaches("tool-call-retention-memory");
      return removed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function flushDeferredLogMaintenance() {
    deferredLogMaintenanceTimer = null;
    const next = deferredLogIndexes.entries().next();
    if (!next.done) {
      const [id, storage] = next.value;
      deferredLogIndexes.delete(id);
      indexLog(id, storage);
    }
    if (deferredLogIndexes.size) {
      deferredLogMaintenanceTimer = setTimeout(flushDeferredLogMaintenance, 0);
      return;
    }
    const now = Date.now();
    if (now >= nextToolCallMemorySweepAt) {
      try { pruneMemoryToolCallRetention(now); } catch (error) { console.error("Memory Tool Call retention cleanup failed:", error); }
    }
    if (now >= nextToolCallRetentionSweepAt) {
      try { pruneDiskToolCallRetention(now); } catch (error) { console.error("Disk Tool Call retention cleanup failed:", error); }
    }
  }
  function scheduleLogIndex(id, storage = "disk") {
    deferredLogIndexes.set(Number(id), storage);
    if (!deferredLogMaintenanceTimer) deferredLogMaintenanceTimer = setTimeout(flushDeferredLogMaintenance, 0);
  }
  function requestToolCallRetentionSweep() {
    nextToolCallRetentionSweepAt = 0;
    nextToolCallMemorySweepAt = 0;
    if (!deferredLogMaintenanceTimer) deferredLogMaintenanceTimer = setTimeout(flushDeferredLogMaintenance, 0);
  }
  requestToolCallRetentionSweep();

  function rejectToolCall(p, tool, args, message, contextHandle = "", status = "failed", result = { error: message }, descriptor = null, progressRequested = false, mcpRequest = null, mcpResponse = undefined) {
    const context = contextByHandle(p, contextHandle);
    const id = beginLog(p, tool, args, contextHandle, null, descriptor, false, progressRequested, context, mcpRequest), completed = Date.now();
    const policy = toolCallPolicyById.get(id) || { storage: "disk", payloadMode: "payload" }, mode = policy.payloadMode;
    updateLog(id, {
      completed_at: completed, duration_ms: 0, status,
      error: toolCallErrorForMode(mode, message), mcp_response_json: toolCallJsonForMode(mode, toolCallMcpResponse(result, mcpResponse)),
    });
    scheduleLogIndex(id, policy.storage);
    postOsNotification(
      "tool_call",
      status === "invalid" ? `⚠️ Invalid Tool Call #${id}` : `❌ Tool Call Rejected #${id}`,
      toolCallNotificationBody(p, tool, args, contextHandle, null, message, progressRequested, context),
    );
    emitUiChange(["state"], status === "invalid" ? "tool-call-invalid" : "tool-call-rejected");
    finishToolCallRuntime(id);
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
      if (schema.uniqueItems === true) {
        const seen = new Set();
        for (const item of value) {
          const key = JSON.stringify(item);
          if (seen.has(key)) return `${label} must contain unique items`;
          seen.add(key);
        }
      }
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
  // started with exec_start, whose Tool Call id becomes exec_id for attach/status/write/kill.
  // Retain one ordered normalized chunk ledger. Combined/stdout/stderr strings are materialized only
  // for the response that asks for them, so process lifetime storage never duplicates transcript text.
  const processTextLength = (rec, key = "output") => key === "output"
    ? Number(rec.output_chars || 0) : Number(rec[`${key}_chars`] || 0);
  function processOutputChunkIndex(rec, position) {
    const chunks = rec.output_chunks || [];
    let low = 0, high = chunks.length;
    while (low < high) {
      const middle = (low + high) >> 1, chunk = chunks[middle];
      if (Number(chunk.output_start || 0) + chunk.text.length <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function processOutputRangeEach(rec, start, end, visit) {
    const total = processTextLength(rec), chunks = rec.output_chunks || [];
    start = Math.max(0, Math.min(Number(start || 0), total));
    end = Math.max(start, Math.min(Number(end ?? total), total));
    for (let index = processOutputChunkIndex(rec, start); index < chunks.length; index++) {
      const chunk = chunks[index], chunkStart = Number(chunk.output_start || 0), chunkEnd = chunkStart + chunk.text.length;
      if (chunkStart >= end) break;
      if (chunkEnd <= start) continue;
      const text = chunk.text.slice(Math.max(0, start - chunkStart), Math.min(chunk.text.length, end - chunkStart));
      if (text) visit(text, chunk);
    }
  }
  function processTextRange(rec, key = "output", start = 0, end = processTextLength(rec, key)) {
    const total = processTextLength(rec, key), parts = [];
    start = Math.max(0, Math.min(Number(start || 0), total));
    end = Math.max(start, Math.min(Number(end ?? total), total));
    if (key === "output") {
      processOutputRangeEach(rec, start, end, text => parts.push(text));
      return parts.join("");
    }
    for (const chunk of rec.output_chunks || []) {
      if (chunk.stream !== key) continue;
      const chunkStart = Number(chunk.stream_start || 0), chunkEnd = chunkStart + chunk.text.length;
      if (chunkStart >= end) break;
      if (chunkEnd <= start) continue;
      parts.push(chunk.text.slice(Math.max(0, start - chunkStart), Math.min(chunk.text.length, end - chunkStart)));
    }
    return parts.join("");
  }
  const processTextTail = (rec, key = "output", maxChars = 65536) => {
    const total = processTextLength(rec, key), size = Math.max(0, Number(maxChars || 0));
    return processTextRange(rec, key, Math.max(0, total - size), total);
  };
  function processTailLinesFromChunks(rec, key, limit) {
    const wanted = Math.max(1, Number(limit || 200)), parts = [];
    let newlines = 0;
    for (let index = (rec.output_chunks || []).length - 1; index >= 0; index--) {
      const chunk = rec.output_chunks[index];
      if (key !== "output" && chunk.stream !== key) continue;
      parts.push(chunk.text);
      for (let offset = chunk.text.length - 1; offset >= 0; offset--)
        if (chunk.text.charCodeAt(offset) === 10) newlines++;
      if (newlines > wanted) break;
    }
    return processTailLines(parts.reverse().join(""), wanted);
  }
  function processOutputPrefix(rec, start, maxBytes) {
    const total = processTextLength(rec), parts = [];
    start = Math.max(0, Math.min(Number(start || 0), total));
    maxBytes = Math.max(1, Number(maxBytes || 1));
    let bytes = 0, chars = 0;
    for (let index = processOutputChunkIndex(rec, start); index < (rec.output_chunks || []).length; index++) {
      const chunk = rec.output_chunks[index], chunkStart = Number(chunk.output_start || 0);
      let text = chunk.text.slice(Math.max(0, start - chunkStart));
      if (!text) continue;
      const whole = text.length === chunk.text.length, textBytes = whole ? Number(chunk.bytes || 0) : enc.encode(text).byteLength;
      if (bytes + textBytes <= maxBytes) {
        parts.push(text); bytes += textBytes; chars += text.length; continue;
      }
      const remaining = maxBytes - bytes;
      if (remaining <= 0) break;
      text = textPrefixByBytes(text, remaining);
      if (text) { parts.push(text); bytes += enc.encode(text).byteLength; chars += text.length; }
      break;
    }
    return { text: parts.join(""), bytes, end: start + chars };
  }
  function appendProcessChunk(rec, stream, text) {
    const bytes = enc.encode(text).byteLength;
    rec.output_chunks.push({
      stream, text, bytes,
      output_start: rec.output_chars,
      stream_start: rec[`${stream}_chars`],
    });
    rec.output_chars += text.length;
    rec[`${stream}_chars`] += text.length;
    rec.output_bytes += bytes;
    return bytes;
  }
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
    appendProcessChunk(rec, stream, normalized);
    rec.updated_at = Date.now();
    rec.foreground_progress?.push(normalized);
    const attachment = rec.attachment;
    if (attachment?.progress) attachment.progress.push(normalized);
    notifyProcessActivity(rec);
    emitUiChange(["processes", "logs"], "process-output");
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
    const view = {
      ...(rec.persistent ? { exec_id: rec.log_id } : {}),
      ...(rec.operation_id ? { operation_id: rec.operation_id } : {}),
      status: rec.status, command: rec.display,
      cwd: rec.cwd_display, chat_session: rec.context_handle,
      started_at: new Date(rec.started_at).toISOString(),
      completed_at: rec.completed_at ? new Date(rec.completed_at).toISOString() : null,
      exit_code: rec.exit_code, signal: rec.signal || null, requested_signal: rec.requested_signal || null,
      termination_source: rec.termination_source || null, timed_out: !!rec.timed_out,
      stdin_open: !!rec.stdin_writer, error: rec.error || "",
      success: rec.status === "running" || rec.status === "completed",
    };
    if (options.include_output !== false)
      view.output = processTextRange(rec, "output", Number(options.output_offset || 0));
    if (options.separate_streams === true) Object.assign(view, {
      stdout: processTextRange(rec, "stdout", Number(options.stdout_offset || 0)),
      stderr: processTextRange(rec, "stderr", Number(options.stderr_offset || 0)),
    });
    return view;
  }
  function processStartView(rec) {
    return {
      exec_id: rec.log_id, ...(rec.operation_id ? { operation_id: rec.operation_id } : {}), status: rec.status, command: rec.display,
      cwd: rec.cwd_display, chat_session: rec.context_handle,
      started_at: new Date(rec.started_at).toISOString(), stdin_open: !!rec.stdin_writer,
    };
  }
  function processListView(rec) {
    return {
      exec_id: rec.log_id, ...(rec.operation_id ? { operation_id: rec.operation_id } : {}), status: rec.status, command: rec.display,
      cwd: rec.cwd_display, started_at: new Date(rec.started_at).toISOString(),
      completed_at: rec.completed_at ? new Date(rec.completed_at).toISOString() : null,
      exit_code: rec.exit_code, signal: rec.signal || null, stdin_open: !!rec.stdin_writer,
      attached: !!rec.attachment,
    };
  }
  function processTailLines(value, limit) {
    const text = String(value || "");
    if (!text) return "";
    const trailing = text.endsWith("\n"), lines = text.split("\n");
    if (trailing) lines.pop();
    const result = lines.slice(-Math.max(1, Number(limit || 200))).join("\n");
    return trailing && result ? result + "\n" : result;
  }
  function processStatusView(rec, args = {}) {
    const mode = String(args.output || "none"), includeStreams = mode !== "none" && args.separate_streams === true;
    const view = processView(rec, {
      include_output: mode === "all",
      separate_streams: mode === "all" && includeStreams,
    });
    view.output_mode = mode; view.attached = !!rec.attachment; delete view.success;
    if (mode === "tail") {
      view.output = processTailLinesFromChunks(rec, "output", args.tail_lines);
      if (includeStreams) {
        view.stdout = processTailLinesFromChunks(rec, "stdout", args.tail_lines);
        view.stderr = processTailLinesFromChunks(rec, "stderr", args.tail_lines);
      }
    }
    return view;
  }
  function processAdminView(rec, options = {}) {
    const progressRequested = rec.persistent
      ? !!rec.attachment?.progress_requested
      : !!activeCallControls.get(rec.log_id)?.progress_requested;
    return { process_id: rec.id, pid: rec.pid, progress_requested: progressRequested,
      stdin_history: rec.stdin_history || [], ...processView(rec, options) };
  }
  function processHistoryAdminView(row) {
    const spec = parseJson(row?.command_json || "{}", {}), argv = Array.isArray(spec.args) ? spec.args : [];
    const command = spec.shell ? String(argv.at(-1) || spec.program || "") : [spec.catalog_name || spec.program || "", ...argv].filter(Boolean);
    return {
      process_id: String(row?.id || ""), pid: row?.pid == null ? null : Number(row.pid), progress_requested: false,
      stdin_history: [], exec_id: Number(row?.log_id || 0), status: String(row?.status || ""), command,
      cwd: String(row?.cwd || ""), chat_session: String(row?.context_handle || ""),
      started_at: row?.started_at ? new Date(Number(row.started_at)).toISOString() : null,
      completed_at: row?.completed_at ? new Date(Number(row.completed_at)).toISOString() : null,
      exit_code: row?.exit_code == null ? null : Number(row.exit_code), signal: String(row?.signal || ""),
      requested_signal: null, termination_source: null, timed_out: String(row?.status || "") === "timed_out",
      output: String(row?.stdout_tail || ""), stdout: String(row?.stdout_tail || ""), stderr: String(row?.stderr_tail || ""),
      stdin_open: false, error: String(row?.error || ""), success: ["running", "completed"].includes(String(row?.status || "")),
    };
  }
  function processSummary(rec, tail = 8192, separateStreams = false) {
    const outputTotal = processTextLength(rec), stdoutTotal = processTextLength(rec, "stdout"), stderrTotal = processTextLength(rec, "stderr");
    return processView(rec, {
      output_offset: Math.max(0, outputTotal - tail),
      separate_streams: separateStreams,
      stdout_offset: Math.max(0, stdoutTotal - tail),
      stderr_offset: Math.max(0, stderrTotal - tail),
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
  function configuredExecEnvironment(value, placeholders = null) {
    const environment = {};
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      const separator = line.indexOf("=");
      const name = separator > 0 ? line.slice(0, separator).trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`Environment line ${index + 1} must use NAME=value with a portable variable name`);
      let resolved = line.slice(separator + 1);
      for (const [placeholder, replacement] of Object.entries(placeholders || {}))
        resolved = resolved.replaceAll(`\${${placeholder}}`, () => String(replacement));
      environment[name] = resolved;
    }
    return environment;
  }
  function mergeProcessEnvironment(...sources) {
    const environment = {}, windowsKeys = new Map();
    for (const source of sources) for (const [key, value] of Object.entries(source || {})) {
      if (Deno.build.os === "windows") {
        const normalized = key.toLowerCase(), previous = windowsKeys.get(normalized);
        if (previous && previous !== key) delete environment[previous];
        windowsKeys.set(normalized, key);
      }
      environment[key] = String(value);
    }
    return environment;
  }
  function processOperationCanonical(value) {
    if (Array.isArray(value)) return value.map(processOperationCanonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, processOperationCanonical(value[key])]));
  }
  function processOperationSignature(args, selection) {
    const processArgs = Object.fromEntries(Object.entries(args || {}).filter(([key]) =>
      key !== "operation_id" && key !== "chat_session"));
    return createHash("sha256").update(JSON.stringify(processOperationCanonical({
      root_id: Number(selection?.root?.id || 0),
      root_path: String(selection?.root?.path || ""),
      args: processArgs,
    }))).digest("base64url");
  }
  const processOperationKey = (tool, contextHandle, operationId) =>
    `${String(contextHandle)}\u0000${String(tool)}\u0000${String(operationId)}`;
  function processOperationReusable(record, now = Date.now()) {
    return ["starting", "running"].includes(record?.status) ||
      (!!record?.completed_at && now - record.completed_at <= PROCESS_OPERATION_GRACE_MS);
  }
  function cleanupProcessOperations(now = Date.now()) {
    for (const [key, entry] of processOperations) {
      const record = entry.record;
      if (record && !processOperationReusable(record, now)) processOperations.delete(key);
    }
  }
  async function processOperation(p, tool, args, persistent, execution = {}) {
    const operationId = typeof args.operation_id === "string" ? args.operation_id : "";
    if (!operationId) return await startManagedProcess(p, args, persistent, execution);
    cleanupProcessOperations();
    const contextHandle = execution.contextHandle || execution.selection?.context?.handle || "";
    const key = processOperationKey(tool, contextHandle, operationId);
    const signature = processOperationSignature(args, execution.selection);
    const existing = processOperations.get(key);
    if (existing) {
      if (existing.signature !== signature)
        throw new Error("operation_id is already mapped to different process arguments during its replay-protection window");
      const record = await existing.promise;
      if (processOperationReusable(record)) return record;
      processOperations.delete(key);
    }
    const entry = { signature, promise: null, record: null };
    entry.promise = startManagedProcess(p, args, persistent, execution);
    processOperations.set(key, entry);
    try {
      const record = await entry.promise;
      entry.record = record;
      record.operation_id = operationId;
      return record;
    } catch (error) {
      if (processOperations.get(key) === entry) processOperations.delete(key);
      throw error;
    }
  }
  async function startManagedProcess(p, args, persistent, execution = {}) {
    const target = await resolveWorkspacePath(execution.selection, args.cwd || ".");
    const defaultTimeout = persistent ? 0 : MCP_FOREGROUND_EXEC_DEFAULT_TIMEOUT_MS;
    const maxTimeout = persistent ? 604800000 : MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS;
    const spec = commandSpec(args), timeout = Math.max(0, Math.min(
      Number(args.timeout_ms ?? defaultTimeout), maxTimeout,
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
    const configuredEnv = configuredExecEnvironment(getCfg("exec_environment", ""), {
      MRMCP_DIR: DATA, MRMCP_BIN: BIN_DIR, WORKSPACE: target.root.path, CWD: target.path,
    });
    const suppliedEnv = Object.fromEntries(Object.entries(args.env || {}).map(([key, value]) => [key, String(value)]));
    const pathKey = Deno.build.os === "windows" ? "Path" : "PATH";
    const includeSystemPath = getCfg("inherit_system_path", "1") === "1";
    let processEnv = mergeProcessEnvironment(inheritedEnv, configuredEnv, suppliedEnv);
    const effectivePathKey = Object.keys(processEnv).find(key => key.toLowerCase() === "path");
    const inheritedPath = effectivePathKey ? processEnv[effectivePathKey] : "";
    for (const key of Object.keys(processEnv)) if (key.toLowerCase() === "path") delete processEnv[key];
    if (getCfg("git_preserve_line_endings", "1") === "1") {
      const countKey = Object.keys(processEnv).find(key =>
        (Deno.build.os === "windows" ? key.toUpperCase() : key) === "GIT_CONFIG_COUNT");
      const inheritedGitConfigCount = Number.parseInt(processEnv[countKey] || "0", 10);
      const gitConfigIndex = Number.isInteger(inheritedGitConfigCount) && inheritedGitConfigCount >= 0
        ? inheritedGitConfigCount : 0;
      processEnv = mergeProcessEnvironment(processEnv, {
        [`GIT_CONFIG_KEY_${gitConfigIndex}`]: "core.autocrlf",
        [`GIT_CONFIG_VALUE_${gitConfigIndex}`]: "false",
        GIT_CONFIG_COUNT: String(gitConfigIndex + 1),
      });
    }
    processEnv[pathKey] = includeSystemPath && inheritedPath
      ? BIN_DIR + (Deno.build.os === "windows" ? ";" : ":") + inheritedPath
      : BIN_DIR;
    processEnv.MRMCP_BIN = BIN_DIR;
    const child = spawnManagedChild(spec.program, {
      args: spec.argv, cwd: target.path, env: processEnv, clearEnv: true,
      stdin: "piped", stdout: "piped", stderr: "piped",
    });
    const rec = {
      id: `proc_${randomToken(18)}`, persistent: !!persistent,
      pid: child.pid, child, log_id: Number(execution.logId || 0),
      server_id: p.id, server_name: "mcp", context_id: target.context.id, context_handle: target.context.handle,
      root_id: target.root.id, root_path: target.root.path, root_name: target.root.name,
      display: spec.display, command_json: JSON.stringify({
        program: spec.program, args: spec.argv, shell: spec.shell,
        catalog_name: spec.catalog_name || null, system_path_inherited: includeSystemPath,
        ...(persistent ? { exec_id: Number(execution.logId || 0) } : {}), persistent: !!persistent,
      }),
      cwd: target.path, cwd_display: target.display, status: "running", started_at: Date.now(), completed_at: null,
      exit_code: null, signal: "", requested_signal: "", termination_source: "", timed_out: false, error: "",
      output_chunks: [], output_chars: 0, stdout_chars: 0, stderr_chars: 0, output_bytes: 0, updated_at: Date.now(),
      output_readers: new Set(), output_waiters: new Set(), output_normalizers: { stdout: terminalNormalizer(), stderr: terminalNormalizer() }, output_cancelled: false,
      foreground_progress: persistent ? null : execution.progress || null,
      attachment: null, attach_cursor: 0, attach_cursor_bytes: 0, stdin_history: [],
      stdin_writer: child.stdin.getWriter(), timeout_timer: null, done: null,
    };
    processes.set(rec.id, rec);
    emitUiChange(["state", "processes"], "process-start");
    if (!persistent) {
      execution.setCancel?.((signal, source = "user") => terminateProcess(rec, signal, source), { process_id: rec.id, kind: "process" });
      execution.onDisconnect?.(() => terminateProcess(rec, "SIGTERM", "client"));
    }
    run(`INSERT INTO main.process_runs(id,log_id,pid,server_id,server_name,context_id,context_handle,root_id,root_name,root_path,
      command_json,cwd,status,started_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id, rec.log_id, rec.pid, p.id, "mcp", rec.context_id, rec.context_handle, rec.root_id, rec.root_name, rec.root_path,
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
      run(`UPDATE main.process_runs SET status=?,completed_at=?,exit_code=?,signal=?,stdout_tail=?,stderr_tail=?,error=? WHERE id=?`,
        rec.status, rec.completed_at, rec.exit_code, rec.signal, processTextTail(rec), processTextTail(rec, "stderr"), rec.error, rec.id);
      notifyProcessActivity(rec);
      emitUiChange(["state", "processes", "logs"], "process-exit");
      return rec;
    }).catch(error => {
      rec.completed_at = Date.now(); rec.status = "failed"; rec.error = String(error?.stack || error);
      run(`UPDATE main.process_runs SET status='failed',completed_at=?,error=? WHERE id=?`,
        rec.completed_at, rec.error, rec.id);
      notifyProcessActivity(rec);
      emitUiChange(["state", "processes", "logs"], "process-exit");
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
  }
  function persistentProcess(execId, contextHandle = "") {
    const wanted = Number(execId || 0), handle = String(contextHandle || "");
    const rec = [...processes.values()].find(record =>
      record.persistent && record.context_handle === handle && record.log_id === wanted);
    if (!rec) throw new Error(`Unknown persistent exec_id for this Session: ${wanted || "(missing)"}. Use exec_list for active executions; completed records are retained in memory for up to 24 hours and do not survive a server restart.`);
    return rec;
  }
  const processIsRunning = rec => ["starting", "running"].includes(rec.status);
  const processOutputEnd = rec => processTextLength(rec);
  function attachProcessView(rec, start, end, args, remainingBytes, waitTimedOut = false) {
    const view = processView(rec, { include_output: false, separate_streams: args.separate_streams === true });
    const from = Math.max(0, Number(start || 0)), to = Math.max(from, Math.min(Number(end ?? processOutputEnd(rec)), processOutputEnd(rec)));
    view.output = processTextRange(rec, "output", from, to);
    view.remaining_bytes = Math.max(0, Number(remainingBytes || 0));
    view.wait_timed_out = !!waitTimedOut;
    return view;
  }
  async function waitAttachBatch(rec, startBytes, disconnected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    if (rec.output_bytes > startBytes || !processIsRunning(rec)) return "ready";
    while (rec.output_bytes <= startBytes && processIsRunning(rec)) {
      const delay = deadline - Date.now();
      if (delay <= 0) return "timeout";
      const wait = processActivityWait(rec, delay);
      const reason = await Promise.race([wait.promise, disconnected]);
      wait.cancel();
      if (reason === "disconnected" || reason === "timeout") return reason;
    }
    if (rec.output_bytes <= startBytes || !processIsRunning(rec)) return "ready";
    const batchDeadline = Math.min(deadline, Date.now() + MCP_ATTACH_RESPONSE_MS);
    while (processIsRunning(rec) && rec.output_bytes - startBytes < MCP_ATTACH_RESPONSE_BYTES) {
      const delay = batchDeadline - Date.now();
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
    if (rec.attachment) throw new Error(`Persistent exec_id ${rec.log_id} already has an active exec_attach`);
    const progressMode = !!execution.progressRequested, progress = progressMode ? execution.progress : null;
    const timeoutMs = Math.max(1, Math.min(Number(args.timeout_ms ?? MCP_ATTACH_DEFAULT_TIMEOUT_MS), MCP_REQUEST_PROCESS_MAX_TIMEOUT_MS));
    const start = Math.max(0, rec.attach_cursor), startBytes = rec.attach_cursor_bytes;
    let sentCursor = start, sentBytes = startBytes, detached = false, detach, progressTimeoutTimer = null;
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
        if (progress) {
          processOutputRangeEach(rec, start, processOutputEnd(rec), text => progress.push(text));
          progress.flush();
        }
        let reason = "ready";
        if (processIsRunning(rec)) {
          const timedOut = new Promise(resolve => {
            progressTimeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
          });
          reason = await Promise.race([rec.done.then(() => "ready"), disconnected, timedOut]);
        }
        if (detached || reason === "disconnected") return attachProcessView(
          rec, start, sentCursor, args, Math.max(0, rec.output_bytes - sentBytes), false,
        );
        progress?.flush();
        const end = processOutputEnd(rec);
        rec.attach_cursor = end; rec.attach_cursor_bytes = rec.output_bytes;
        return attachProcessView(rec, start, end, args, 0, reason === "timeout" && processIsRunning(rec));
      }

      const reason = await waitAttachBatch(rec, startBytes, disconnected, timeoutMs);
      if (reason === "disconnected" || detached) return attachProcessView(
        rec, start, start, args, Math.max(0, rec.output_bytes - startBytes), false,
      );
      if (reason === "timeout" && rec.output_bytes <= startBytes) return attachProcessView(
        rec, start, start, args, Math.max(0, rec.output_bytes - startBytes), processIsRunning(rec),
      );
      const chunk = processOutputPrefix(rec, start, MCP_ATTACH_RESPONSE_BYTES);
      const end = chunk.end;
      rec.attach_cursor = end; rec.attach_cursor_bytes = startBytes + chunk.bytes;
      return attachProcessView(
        rec, start, end, args, Math.max(0, rec.output_bytes - rec.attach_cursor_bytes),
        reason === "timeout" && processIsRunning(rec),
      );
    } finally {
      if (progressTimeoutTimer) clearTimeout(progressTimeoutTimer);
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
    cleanupProcessOperations(now);
    for (const [key, kernel] of jsKernels)
      if (now - kernel.last_used > 60 * 60 * 1000) destroyJsKernel(key, "expired");
    const oauthChanges = Number(run("DELETE FROM oauth_codes WHERE expires_at<?", now).changes || 0)
      + Number(run("DELETE FROM oauth_tokens WHERE expires_at<?", now).changes || 0)
      + Number(run(`DELETE FROM oauth_clients WHERE created_at<? AND client_id NOT IN
        (SELECT DISTINCT client_id FROM oauth_tokens UNION SELECT DISTINCT client_id FROM oauth_refresh_tokens)`,
        now - 30 * 24 * 60 * 60 * 1000).changes || 0);
    if (oauthChanges) changed({ ui: ["oauth", "dashboard"] }, "oauth-maintenance");
    for (const [token, consent] of oauthConsents)
      if (consent.expires_at < now) oauthConsents.delete(token);
    for (const [key, bucket] of rateBuckets)
      if (now - bucket.started > 2 * 60 * 1000) rateBuckets.delete(key);
  }
  function activeProcesses(contextHandle, limit = 50) {
    const handle = String(contextHandle || "");
    return [...processes.values()]
      .filter(record => record.persistent && record.context_handle === handle && processIsRunning(record))
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit)
      .map(processListView);
  }
  function activeProcessAdminProjection() {
    const rows = [...processes.values()]
      .filter(processIsRunning)
      .sort((a, b) => b.started_at - a.started_at)
      .map(rec => ({
        process_id: rec.id, pid: rec.pid, persistent: !!rec.persistent,
        progress_requested: rec.persistent ? !!rec.attachment?.progress_requested : !!activeCallControls.get(rec.log_id)?.progress_requested,
        attached: !!rec.attachment,
        ...processSummary(rec, 8192),
      }));
    return { active: rows.length, rows };
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

  const runDesktopScenario = yaml => auto.run(parseYaml(String(yaml)));
  async function runCdpBatch(args) {
    const wait = args.wait !== false, calls = Array.isArray(args.calls) ? args.calls : [];
    if (!calls.length || calls.length > 100) throw new Error("cdp_call calls must contain 1-100 entries");
    const results = await Promise.all(calls.map(async spec => {
      const browserInput = spec?.browser ?? "main", targetInput = spec?.target == null ? null : cdpBrowserLabel(spec.target);
      let targetReservation = "";
      let base = {
        browser: cdpBrowserLabel(browserInput), port: null, user_data_dir: null, target: targetInput, target_id: null, session_id: null,
        id: null, queued: false, cdp: null, image: null, setup_errors: [], success: false, error: null,
      };
      try {
        const rawMethod = String(spec?.call?.method || "").trim(), extension = rawMethod.startsWith("_.");
        if (!rawMethod) throw new Error("call requires method");
        const rawParams = spec?.call?.params == null ? {} : spec.call.params;
        if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) throw new Error("call.params must be an object");
        if (extension && !targetInput) throw new Error(`${rawMethod} requires target`);
        if (spec._image && (!rawMethod || rawMethod !== "Page.captureScreenshot")) throw new Error("_image is supported only with standard Page.captureScreenshot");
        if (spec._image && !wait) throw new Error("_image requires cdp_call wait=true");
        if (spec._image && spec._image.return !== "base64") throw new Error("_image.return must be base64");
        const operation = extension ? cdpExtensionRequest(rawMethod, rawParams) : { wire_method: rawMethod, logical_method: rawMethod, params: rawParams };
        const browserSpec = cdpBrowserSpec(browserInput);
        cdpConfiguredOptions(browserSpec);
        if (spec.target !== undefined) {
          const targetSpec = cdpTargetSpec(spec.target);
          cdpConfigureTarget(browserSpec.browser, targetSpec);
          targetReservation = cdpTargetKey(browserSpec.browser, targetSpec.target);
          cdpTargetReservations.set(targetReservation, (cdpTargetReservations.get(targetReservation) || 0) + 1);
        }
        const record = await ensureCdpBrowser(browserInput);
        let target = null, targetId = null, sessionId = null;
        if (spec.target !== undefined) {
          const resolvedTarget = await cdpEnsureTarget(record, spec.target);
          target = resolvedTarget.target; targetId = resolvedTarget.target_id; sessionId = resolvedTarget.session_id;
        }
        base = {
          browser: record.browser, port: record.port, user_data_dir: record.user_data_dir,
          target, target_id: targetId, session_id: sessionId, id: null, queued: false, cdp: null, image: null,
          setup_errors: sessionId ? [...(record.session_setup_errors.get(sessionId) || [])] : [], success: false, error: null,
        };
        const request = cdpRequest(record, operation.wire_method, operation.params, sessionId || "", {
          wait, expose: !spec._image, target, target_id: targetId, logical_method: operation.logical_method,
        });
        base.id = request.id;
        if (!wait) return { ...base, queued: true, success: true };
        const raw = await request.promise;
        const processed = spec._image && !raw?.error ? await cdpProcessScreenshot(raw, spec._image, rawParams) : { cdp: raw, image: null };
        if (spec._image) cdpRecordMessage(record, {
          browser: record.browser, type: "response", id: request.id, method: operation.logical_method,
          target, target_id: targetId, session_id: sessionId || null, cdp: processed.cdp,
        });
        return { ...base, ...processed, success: !processed.cdp?.error, error: processed.cdp?.error ? String(processed.cdp.error.message || processed.cdp.error) : null };
      } catch (error) {
        return { ...base, success: false, error: String(error?.message || error) };
      } finally {
        if (targetReservation) {
          const remaining = (cdpTargetReservations.get(targetReservation) || 1) - 1;
          if (remaining) cdpTargetReservations.set(targetReservation, remaining);
          else cdpTargetReservations.delete(targetReservation);
        }
      }
    }));
    return { wait, results };
  }

  async function executeTool(p, name, args, execution) {
    const selection = execution.selection;
    if (!selection?.context) throw new Error("Chat Session selection is missing");
    if (name === "init_chat_session") return {};
    if (name === "list_workspaces") return {
      workspaces: all("SELECT name FROM roots WHERE server_id=? AND enabled=1 ORDER BY name", p.id).map(row => row.name),
    };
    if (name === "open_workspace") {
      let workspace = workspaceByName(p, args.name), created = false;
      if (!workspace && args.create === true) {
        await createDesktopWorkspace(p, args.name);
        workspace = workspaceByName(p, args.name);
        created = true;
      }
      if (!workspace) throw new Error(`Unknown or disabled Workspace: ${String(args.name || "")}`);
      const root = runtimeWorkspaceRoot(workspace);
      const result = await workspaceInfo({ context: selection.context, root }, { created });
      selectContextRoot(p, selection.context, workspace.id);
      selection.context = getContextRecord(p, selection.context.handle);
      selection.root = root;
      updateLog(execution.logId, { root_id: root.id, root_name: root.name, root_path: root.path });
      postOsNotification("session", "📂 Workspace Opened", sessionNotificationLabel(p, selection.context, null, Date.now(), root.name));
      return result;
    }
    if (name === "chat_set_goal") return setChatGoal(selection.context, args.goal, args.timeout_seconds ?? chatGoalDefaultTimeout());
    if (name === "chat_goal_debug") return await chatGoalDebug(selection.context, args);
    if (name === "tools_schema") {
      const published = new Map(serverTools(p, true).map(tool => [tool.name, tool]));
      const names = (args.names || []).map(name => String(name));
      if (new Set(names).size !== names.length) throw new Error("names must contain unique tool names");
      return {
        tools: names.flatMap(name => published.has(name) ? [{ name, descriptor_json: descriptorJson(published.get(name)) }] : []),
        missing: names.filter(name => !published.has(name)),
      };
    }
    const requiresWorkspace = name.startsWith("fs_") || ["workspace_dev_preferences_write", "exec", "exec_start", "js", "js_add_node_module_dir", "js_reset"].includes(name) ||
      name === "publish" && args.path !== undefined || !BASE_TOOLS.includes(name);
    if (requiresWorkspace && !selection.root?.id) throw new Error("No Workspace is open for this chat_session. Call open_workspace with the same chat_session before this operation.");
    if (name === "desktop_auto") {
      const result = await runDesktopScenario(args.yaml);
      const images = [], seenImages = new WeakMap();
      const childPath = (path, key) => /^[$A-Z_a-z][$0-9A-Z_a-z]*$/.test(String(key))
        ? `${path}.${key}` : `${path}[${JSON.stringify(String(key))}]`;
      const convert = (value, path) => {
        if (!value || typeof value !== "object") return value;
        if (value.data instanceof Uint8Array && value.rect && typeof value.format === "string") {
          const format = value.format.toLowerCase();
          if (format !== "webp" && format !== "png")
            throw new Error(`desktop_auto cannot transport final image format ${value.format}; use WebP or PNG`);
          let image = seenImages.get(value);
          if (!image) {
            const id = `image_${images.length + 1}`;
            image = {
              id, value, state_paths: [], format,
              mime_type: `image/${format}`, bytes: value.data.byteLength,
              rect: value.rect, grayscale: !!value.grayscale, scale: Number(value.scale ?? 1),
            };
            seenImages.set(value, image); images.push(image);
          }
          image.state_paths.push(path);
          const { data: _data, ...metadata } = value;
          return { ...metadata, image_id: image.id };
        }
        if (value instanceof Uint8Array) throw new Error(`desktop_auto returned unsupported binary data at ${path}`);
        if (Array.isArray(value)) return value.map((item, index) => convert(item, `${path}[${index}]`));
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item, childPath(path, key))]));
      };
      const state = convert(result?.state || {}, "$.state");
      const content = images.map(image => ({
        type: "image",
        data: Buffer.from(image.value.data.buffer, image.value.data.byteOffset, image.value.data.byteLength).toString("base64"),
        mimeType: image.mime_type,
        annotations: { audience: ["assistant"], priority: 1 },
        _meta: { "com.mefistofelix.mrmcp/imageId": image.id },
      }));
      const imageMetadata = images.map((image, index) => ({
        id: image.id, state_paths: image.state_paths, format: image.format, mime_type: image.mime_type,
        bytes: image.bytes, rect: image.rect, grayscale: image.grayscale, scale: image.scale,
        content_index: index + 1,
      }));
      return { results: result?.results || [], state, images: imageMetadata, [TOOL_RESULT_CONTENT]: content };
    }
    let workspaceRootRealPromise = null;
    const workspaceRootReal = () => workspaceRootRealPromise ||= Deno.realPath(selection.root.path);
    const resolvePath = async path => resolveWorkspacePath(selection, path, await workspaceRootReal());
    if (name === "document_grep") return await documentGrep(await searchSelection(selection), args);
    if (name === "proxy_get") return await proxyGet(args);
    if (name === "source_code_search") return await sourceCodeSearch(await searchSelection(selection), args);
    const pathKey = path => Deno.build.os === "windows" ? resolve(path).toLowerCase() : resolve(path);
    const exists = async path => {
      try { return await Deno.lstat(path); }
      catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
    };
    const errorStatus = error => error instanceof Deno.errors.NotFound ? "not_found"
      : error instanceof Deno.errors.PermissionDenied ? "permission_denied" : "failed";
    const textLines = document => {
      const text = String(document.text || "");
      if (!text) return [];
      const lines = [];
      let start = 0;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;
        lines.push(text.slice(start, index));
        if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
        start = index + 1;
      }
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    };
    const searchRegex = (pattern, regex, caseSensitive) => new RegExp(
      regex ? String(pattern) : String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      caseSensitive ? "" : "i",
    );
    const contextMatches = (lines, indexes, before, after, regex) => indexes.map(index => {
      regex.lastIndex = 0;
      const match = regex.exec(lines[index]);
      return {
        line: index + 1, column: (match?.index ?? 0) + 1, text: lines[index],
        ...(before ? { context_before: lines.slice(Math.max(0, index - before), index).map((text, offset) => ({
          line: Math.max(0, index - before) + offset + 1, text,
        })) } : {}),
        ...(after ? { context_after: lines.slice(index + 1, index + 1 + after).map((text, offset) => ({ line: index + offset + 2, text })) } : {}),
      };
    });

    if (name === "workspace_dev_preferences_write") {
      const destination = join(selection.root.path, DEV_PREF_FILENAME);
      if (await exists(destination))
        return { path: DEV_PREF_FILENAME, status: "already_exists", created: false };
      let sourceStat;
      try { sourceStat = await Deno.stat(DEV_PREF_SOURCE_PATH); }
      catch (error) {
        if (error instanceof Deno.errors.NotFound)
          throw new Error(`${DEV_PREF_FILENAME} was not found beside the running MrMCP executable`);
        throw error;
      }
      if (!sourceStat.isFile)
        throw new Error(`${DEV_PREF_FILENAME} beside the running MrMCP executable is not a regular file`);
      const bytes = await Deno.readFile(DEV_PREF_SOURCE_PATH);
      let file;
      try { file = await Deno.open(destination, { write: true, createNew: true }); }
      catch (error) {
        if (error instanceof Deno.errors.AlreadyExists)
          return { path: DEV_PREF_FILENAME, status: "already_exists", created: false };
        throw error;
      }
      let complete = false;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await file.write(bytes.subarray(offset));
          if (!written) throw new Error(`Failed to write ${DEV_PREF_FILENAME}`);
          offset += written;
        }
        complete = true;
      } finally {
        file.close();
        if (!complete) await Deno.remove(destination).catch(() => {});
      }
      return { path: DEV_PREF_FILENAME, status: "created", created: true };
    }
    if (name === "fs_glob") {
      const limit = Math.min(Number(args.limit || 1000), 10000), metadata = args.metadata === true;
      const walked = await fsWalk(selection.root.path, args.path || ".", { ...args, root_real: await workspaceRootReal(), metadata, after_path: args.after_path, hard_limit: limit + 1 });
      const page = walked.entries.slice(0, limit), truncated = walked.entries.length > limit || walked.limited;
      return {
        metadata, returned: page.length, limit,
        entries: page.map(entry => ({ ...entry, status: "ok" })),
        next_after_path: truncated && page.length ? page.at(-1).path : null,
        truncated,
      };
    }
    if (name === "fs_grep") {
      const pattern = String(args.pattern || "");
      if (!pattern) throw new Error("pattern must not be empty");
      const regex = searchRegex(pattern, args.regex === true, args.case_sensitive === true);
      const before = Math.min(Number(args.context_lines_before || 0), 100), afterContext = Math.min(Number(args.context_lines_after || 0), 100);
      const mode = String(args.mode || "matches"), limit = Math.min(Number(args.limit || 300), 2000);
      const maxFileBytes = Math.min(Number(args.max_file_bytes || 5 * 1024 * 1024), 50 * 1024 * 1024);
      const cursor = args.resume_after || null;
      const walkOptions = { ...args, root_real: await workspaceRootReal(), from_path: cursor?.path, metadata: false };
      const walkLimit = fsWalkLimit(walkOptions), walk = fsWalkEntries(selection.root.path, args.path || ".", walkOptions);
      const files = []; let scannedFiles = 0, matchedFiles = 0, skippedLargeFiles = 0, returned = 0;
      let truncated = false, truncationReason = null, nextAfter = null, lastWalkedPath = null;
      let lastReturned = cursor ? { ...cursor } : null;
      let walkedCount = 0;
      for await (const entry of walk) {
        walkedCount++;
        lastWalkedPath = entry.path;
        if (entry.type !== "file") continue;
        if (cursor && compareFsPaths(entry.path, String(cursor.path)) < 0) continue;
        if (cursor && entry.path === cursor.path && cursor.line == null) continue;
        try {
          const path = await safePath(selection.root.path, entry.path, await workspaceRootReal());
          scannedFiles++;
          const stat = await Deno.stat(path);
          if (stat.size > maxFileBytes) { skippedLargeFiles++; continue; }
          const document = await readTextDocument(path, args.encoding || "auto", textEncodingDetection());
          if (args.regex !== true) {
            regex.lastIndex = 0;
            if (!regex.test(document.text)) continue;
          }
          const lines = textLines(document), indexes = [];
          for (let index = 0; index < lines.length; index++) {
            regex.lastIndex = 0;
            if (regex.test(lines[index])) indexes.push(index);
          }
          if (!indexes.length) continue;
          const fingerprint = await fingerprintBytes(document.bytes);
          const metadata = { size: stat.size, encoding: document.encoding, bom: document.bom, line_endings: document.line_endings };
          if (mode === "matches") {
            const eligible = indexes.filter(index => !cursor || entry.path !== cursor.path || index + 1 > Number(cursor.line));
            if (!eligible.length) {
              if (cursor && entry.path === cursor.path) lastReturned = { path: entry.path };
              continue;
            }
            matchedFiles++;
            const matches = [];
            for (let eligibleIndex = 0; eligibleIndex < eligible.length && returned < limit; eligibleIndex++) {
              const lineIndex = eligible[eligibleIndex], match = contextMatches(lines, [lineIndex], before, afterContext, regex)[0];
              matches.push(match); returned++;
              const moreInFile = eligibleIndex < eligible.length - 1;
              lastReturned = moreInFile ? { path: entry.path, line: lineIndex + 1 } : { path: entry.path };
            }
            if (matches.length) files.push({ path: entry.path, status: "ok", fingerprint, ...metadata, matches, count: eligible.length });
          } else {
            matchedFiles++;
            const result = { path: entry.path, status: "ok", fingerprint, ...metadata, ...(mode === "count" ? { count: indexes.length } : {}) };
            files.push(result); returned++; lastReturned = { path: entry.path };
          }
        } catch (error) {
          files.push({ path: entry.path, status: errorStatus(error), error: String(error?.message || error) });
        }
        if (returned >= limit) {
          // One path of lookahead distinguishes EOF from a continuation without
          // enumerating the remaining tree. Traversal failures stay outside the file error handler.
          if (lastReturned?.line != null || walkedCount >= walkLimit || !(await walk.next()).done) {
            truncated = true; truncationReason = "limit"; nextAfter = lastReturned;
          }
          break;
        }
      }
      if (!truncated && walkedCount >= walkLimit && lastWalkedPath) {
        truncated = true; truncationReason = "walk_limit"; nextAfter = { path: lastWalkedPath };
      }
      return {
        mode, scanned_files: scannedFiles, matched_files: matchedFiles, skipped_large_files: skippedLargeFiles, max_file_bytes: maxFileBytes,
        returned, limit, truncation_reason: truncationReason,
        files, next_resume_after: nextAfter, truncated,
      };
    }
    if (name === "fs_read") {
      const requests = args.files || [];
      const maxBytesPerFile = Math.min(Number(args.max_output_bytes_per_file || 1048576), 5242880);
      const files = [];
      for (const file of requests) {
        const fileBudget = maxBytesPerFile;
        try {
          const target = await resolvePath(file.path), stat = await Deno.stat(target.path);
          if (!stat.isFile) { files.push({ path: target.display, status: "not_file", size: stat.size }); continue; }
          const document = await readTextDocument(target.path, file.encoding || "auto", textEncodingDetection()), lines = textLines(document), total = lines.length;
          const requestedStart = Number(file.start_line || 1), requestedEnd = Math.min(total, Number(file.end_line || total));
          if (total === 0 && file.start_line == null && file.end_line == null) {
            files.push({
              path: target.display, status: "ok", content: "", start_line: 1, end_line: 0, total_lines: 0,
              truncated: false, next_start_line: null, size: stat.size, fingerprint: await fingerprintBytes(document.bytes),
              encoding: document.encoding, bom: document.bom, line_endings: document.line_endings,
            });
            continue;
          }
          if (requestedStart > total || requestedEnd < requestedStart) {
            files.push({
              path: target.display, status: "range_out_of_bounds", total_lines: total, size: stat.size,
              fingerprint: await fingerprintBytes(document.bytes), encoding: document.encoding, bom: document.bom, line_endings: document.line_endings,
            });
            continue;
          }
          const contextStart = Math.max(1, requestedStart - Number(file.context_lines_before || 0));
          const contextEnd = Math.min(total, requestedEnd + Number(file.context_lines_after || 0));
          // Requested lines own the byte budget. Optional context may use only space left after
          // the requested page, so context can never displace requested content or stall continuation.
          const requested = []; let used = 0, requestedLast = requestedStart - 1;
          for (let line = requestedStart; line <= requestedEnd; line++) {
            const text = lines[line - 1], bytes = enc.encode((requested.length ? "\n" : "") + text).length;
            if (requested.length && used + bytes > fileBudget) break;
            requested.push(text); used += bytes; requestedLast = line;
            if (used >= fileBudget) break;
          }
          const before = []; let start = requestedStart;
          for (let line = requestedStart - 1; line >= contextStart; line--) {
            const bytes = enc.encode(lines[line - 1]).length + 1;
            if (used + bytes > fileBudget) break;
            before.unshift(lines[line - 1]); used += bytes; start = line;
          }
          const after = []; let last = requestedLast;
          if (requestedLast >= requestedEnd) {
            for (let line = requestedEnd + 1; line <= contextEnd; line++) {
              const bytes = enc.encode(lines[line - 1]).length + 1;
              if (used + bytes > fileBudget) break;
              after.push(lines[line - 1]); used += bytes; last = line;
            }
          }
          const selected = [...before, ...requested, ...after], content = selected.join("\n");
          const truncated = requestedLast < requestedEnd;
          files.push({
            path: target.display, status: "ok", content, start_line: start, end_line: last, total_lines: total,
            truncated, next_start_line: truncated ? requestedLast + 1 : null, size: stat.size, fingerprint: await fingerprintBytes(document.bytes),
            encoding: document.encoding, bom: document.bom, line_endings: document.line_endings,
          });
        } catch (error) {
          files.push({ path: String(file.path), status: errorStatus(error), error: String(error?.message || error) });
        }
      }
      return { files };
    }
    if (name === "fs_navigate") {
      const pattern = String(args.pattern || "");
      if (!pattern) throw new Error("pattern must not be empty");
      const regex = searchRegex(pattern, args.regex === true, args.case_sensitive === true);
      const before = Math.min(Number(args.context_lines_before || 0), 100), afterContext = Math.min(Number(args.context_lines_after || 0), 100), files = [];
      for (const file of args.files || []) {
        try {
          const target = await resolvePath(file.path), document = await readTextDocument(target.path, file.encoding || "auto", textEncodingDetection()), lines = textLines(document);
          const limit = Math.min(Number(file.max_matches || 1), 100), indexes = [], fromLine = Math.max(Number(file.from_line), 0);
          if (file.direction === "backward") {
            for (let index = Math.min(fromLine - 2, lines.length - 1); index >= 0 && indexes.length < limit; index--) {
              regex.lastIndex = 0; if (regex.test(lines[index])) indexes.push(index);
            }
          } else {
            for (let index = Math.min(fromLine, lines.length); index < lines.length && indexes.length < limit; index++) {
              regex.lastIndex = 0; if (regex.test(lines[index])) indexes.push(index);
            }
          }
          files.push({
            path: target.display, status: "ok", fingerprint: await fingerprintBytes(document.bytes), count: indexes.length,
            matches: contextMatches(lines, indexes, before, afterContext, regex), size: document.bytes.length, total_lines: lines.length,
            encoding: document.encoding, bom: document.bom, line_endings: document.line_endings,
          });
        } catch (error) { files.push({ path: String(file.path), status: errorStatus(error), error: String(error?.message || error) }); }
      }
      return { files };
    }
    if (name === "fs_stat") {
      const entries = [];
      for (const raw of args.paths || []) {
        try {
          const target = await resolvePath(raw), stat = await Deno.lstat(target.path);
          entries.push({
            path: target.display, status: "ok", type: stat.isFile ? "file" : stat.isDirectory ? "directory" : stat.isSymlink ? "symlink" : "other",
            size: stat.size, modified_at: stat.mtime?.toISOString() || null, created_at: stat.birthtime?.toISOString() || null,
            ...(args.fingerprint === true && stat.isFile ? { fingerprint: await fileFingerprint(target.path) } : {}),
          });
        } catch (error) { entries.push({ path: String(raw), status: errorStatus(error), error: String(error?.message || error) }); }
      }
      return { entries };
    }
    if (name === "fs_write") {
      const seen = new Set(), files = [];
      for (const file of args.files || []) {
        let target;
        try {
          target = await resolvePath(file.path);
          const key = pathKey(target.path);
          if (seen.has(key)) throw new Error(`Duplicate file path: ${file.path}`);
          seen.add(key);
          const before = await Deno.readFile(target.path).catch(error => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          });
          const content = String(file.content);
          const lineEndingMode = String(file.line_endings || "preserve").toLowerCase();
          const outputEncodingMode = String(file.output_encoding || "preserve").toLowerCase();
          const outputHasLineBreaks = lineEndingKind(content) !== "none";
          const needsDecodedSource = !!before && (outputEncodingMode === "preserve" || (lineEndingMode === "preserve" && outputHasLineBreaks));
          const source = before ? (needsDecodedSource ? decodeTextDocument(before, "auto") : { bom: textBom(before) }) : null;
          const fingerprintBefore = before ? await fingerprintBytes(before) : "";
          if (file.expected_fingerprint && file.expected_fingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "fingerprint_mismatch", expected_fingerprint: file.expected_fingerprint,
              ...(fingerprintBefore ? { fingerprint: fingerprintBefore } : {}), size: before?.length || 0,
            });
            continue;
          }
          if (lineEndingMode === "preserve" && outputHasLineBreaks && source?.line_endings === "mixed") {
            files.push({
              path: target.display, status: "mixed_line_endings", fingerprint: fingerprintBefore, size: before.length,
              error: "The result contains line breaks, but a mixed source has no single line-ending style to preserve; choose lf, crlf, or cr explicitly",
            });
            continue;
          }
          if (lineEndingMode === "preserve" && outputHasLineBreaks && source?.line_endings === "none") {
            files.push({
              path: target.display, status: "line_endings_required", ...(fingerprintBefore ? { fingerprint: fingerprintBefore } : {}), size: before?.length || 0,
              error: "The result introduces line breaks, but the existing source has no line-ending style to preserve; choose lf, crlf, or cr explicitly",
            });
            continue;
          }
          if (args.create_parents === false && !await exists(dirname(target.path))) {
            files.push({ path: target.display, status: "parent_missing", size: before?.length || 0 });
            continue;
          }
          const output = encodeTextDocument(content, source, file);
          const currentBytes = await Deno.readFile(target.path).catch(error => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          });
          const currentFingerprint = currentBytes ? await fingerprintBytes(currentBytes) : "";
          if (currentFingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "source_changed", ...(fingerprintBefore ? { fingerprint_before: fingerprintBefore } : {}),
              ...(currentFingerprint ? { fingerprint: currentFingerprint } : {}), size: currentBytes?.length || 0,
            });
            continue;
          }
          if (args.create_parents !== false) await Deno.mkdir(dirname(target.path), { recursive: true });
          await Deno.writeFile(target.path, output.bytes);
          files.push({
            path: target.display, status: "written", size_before: before?.length || 0, size_after: output.bytes.length,
            ...(fingerprintBefore ? { fingerprint_before: fingerprintBefore } : {}),
            fingerprint_after: await fingerprintBytes(output.bytes), encoding: output.encoding,
            bom: output.bom, line_endings: output.line_endings,
          });
        } catch (error) {
          files.push({ path: target?.display || String(file.path), status: errorStatus(error), error: String(error?.message || error) });
        }
      }
      const succeeded = files.filter(file => file.status === "written").length;
      return { succeeded, failed: files.length - succeeded, files };
    }
    if (name === "fs_text_convert_encoding_eol") {
      const encodingMode = textEncoding(args.encoding || "preserve", "preserve", true);
      const lineEndingMode = String(args.line_endings || "preserve").toLowerCase();
      const bomMode = String(args.bom || "preserve").toLowerCase();
      if (!["preserve", "lf", "crlf", "cr"].includes(lineEndingMode)) throw new Error("line_endings must be preserve, lf, crlf, or cr");
      if (!["preserve", "add", "remove"].includes(bomMode)) throw new Error("bom must be preserve, add, or remove");
      if (encodingMode === "preserve" && lineEndingMode === "preserve" && bomMode === "preserve")
        throw new Error("At least one conversion target must differ from preserve");
      const seen = new Set(), files = [];
      for (const file of args.files || []) {
        let target, before;
        try {
          target = await resolvePath(file.path);
          const key = pathKey(target.path);
          if (seen.has(key)) throw new Error(`Duplicate file path: ${file.path}`);
          seen.add(key);
          const stat = await exists(target.path);
          if (!stat) { files.push({ path: target.display, status: "not_found" }); continue; }
          if (!stat.isFile) { files.push({ path: target.display, status: "not_file", size: stat.size }); continue; }
          const beforeBytes = await Deno.readFile(target.path);
          const fingerprintBefore = await fingerprintBytes(beforeBytes);
          if (file.expected_fingerprint && file.expected_fingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "fingerprint_mismatch", expected_fingerprint: file.expected_fingerprint,
              fingerprint: fingerprintBefore, size: beforeBytes.length,
            });
            continue;
          }
          const source = decodeTextDocument(beforeBytes, file.input_encoding || "auto");
          before = { encoding: source.encoding, line_endings: source.line_endings, bom: source.bom };
          const output = encodeTextDocument(source.text, source, {
            output_encoding: encodingMode, line_endings: lineEndingMode, bom: bomMode,
          });
          const after = { encoding: output.encoding, line_endings: output.line_endings, bom: output.bom };
          const currentBytes = await Deno.readFile(target.path).catch(error => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          });
          const currentFingerprint = currentBytes ? await fingerprintBytes(currentBytes) : "";
          if (currentFingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "source_changed", fingerprint_before: fingerprintBefore,
              ...(currentFingerprint ? { fingerprint: currentFingerprint } : {}), size: currentBytes?.length || 0, before,
            });
            continue;
          }
          if (sameBytes(beforeBytes, output.bytes)) {
            files.push({
              path: target.display, status: "unchanged", size_before: beforeBytes.length, size_after: beforeBytes.length,
              fingerprint_before: fingerprintBefore, fingerprint_after: fingerprintBefore, before, after,
            });
            continue;
          }
          await Deno.writeFile(target.path, output.bytes);
          files.push({
            path: target.display, status: "converted", size_before: beforeBytes.length, size_after: output.bytes.length,
            fingerprint_before: fingerprintBefore, fingerprint_after: await fingerprintBytes(output.bytes), before, after,
          });
        } catch (error) {
          files.push({
            path: target?.display || String(file.path), status: errorStatus(error), error: String(error?.message || error),
            ...(before ? { before } : {}),
          });
        }
      }
      const succeeded = files.filter(file => file.status === "converted" || file.status === "unchanged").length;
      return { succeeded, failed: files.length - succeeded, files };
    }
    if (name === "fs_edit") {
      const seen = new Set(), files = []; let totalReplacements = 0;
      for (const file of args.files || []) {
        let target;
        try {
          target = await resolvePath(file.path);
          const key = pathKey(target.path);
          if (seen.has(key)) throw new Error(`Duplicate file path: ${file.path}; group all ordered edits for one file in one files entry`);
          seen.add(key);
          const document = await readTextDocument(target.path, file.input_encoding || "auto"), fingerprintBefore = await fingerprintBytes(document.bytes);
          if (file.expected_fingerprint && file.expected_fingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "fingerprint_mismatch", expected_fingerprint: file.expected_fingerprint,
              fingerprint: fingerprintBefore, size: document.bytes.length,
            });
            continue;
          }
          let current = normalizeLineEndings(document.text, "lf"), replacements = 0, failed = null;
          const editResults = [];
          for (let index = 0; index < (file.edits || []).length; index++) {
            const edit = file.edits[index], oldText = normalizeLineEndings(String(edit.old_text), "lf");
            const newText = normalizeLineEndings(String(edit.new_text), "lf"), expected = Number(edit.expected_occurrences ?? 1);
            const parts = oldText ? current.split(oldText) : null;
            const occurrences = parts ? parts.length - 1 : 0;
            editResults.push({ index: index + 1, expected_occurrences: expected, occurrences });
            if (!oldText || occurrences !== expected) { failed = { index: index + 1, expected, occurrences }; break; }
            current = parts.join(newText);
            replacements += occurrences;
          }
          if (failed) {
            files.push({
              path: target.display, status: "occurrence_mismatch", fingerprint: fingerprintBefore, size: document.bytes.length,
              replacements, edits: editResults,
              error: `Edit ${failed.index} expected ${failed.expected} occurrences, found ${failed.occurrences}`,
            });
            continue;
          }
          const lineEndingMode = String(file.line_endings || "preserve").toLowerCase();
          const outputHasLineBreaks = lineEndingKind(current) !== "none";
          if (lineEndingMode === "preserve" && outputHasLineBreaks && document.line_endings === "mixed") {
            files.push({
              path: target.display, status: "mixed_line_endings", fingerprint: fingerprintBefore, size: document.bytes.length,
              replacements, edits: editResults,
              error: "The edited result contains line breaks, but a mixed source has no single line-ending style to preserve; choose lf, crlf, or cr explicitly",
            });
            continue;
          }
          if (lineEndingMode === "preserve" && outputHasLineBreaks && document.line_endings === "none") {
            files.push({
              path: target.display, status: "line_endings_required", fingerprint: fingerprintBefore, size: document.bytes.length,
              replacements, edits: editResults,
              error: "The edited result introduces line breaks, but the source has no line-ending style to preserve; choose lf, crlf, or cr explicitly",
            });
            continue;
          }
          const output = encodeTextDocument(current, document, file);
          const currentFingerprint = await fileFingerprint(target.path);
          if (currentFingerprint !== fingerprintBefore) {
            files.push({
              path: target.display, status: "source_changed", fingerprint_before: fingerprintBefore,
              fingerprint: currentFingerprint, size: (await Deno.stat(target.path)).size, replacements, edits: editResults,
            });
            continue;
          }
          await Deno.writeFile(target.path, output.bytes);
          totalReplacements += replacements;
          files.push({
            path: target.display, status: "edited", fingerprint_before: fingerprintBefore,
            fingerprint_after: await fingerprintBytes(output.bytes), size_before: document.bytes.length, size_after: output.bytes.length,
            replacements, edits: editResults, encoding: output.encoding, bom: output.bom, line_endings: output.line_endings,
          });
        } catch (error) {
          files.push({ path: target?.display || String(file.path), status: errorStatus(error), error: String(error?.message || error) });
        }
      }
      const succeeded = files.filter(file => file.status === "edited").length;
      return { succeeded, failed: files.length - succeeded, total_replacements: totalReplacements, files };
    }
    if (name === "fs_mkdir") {
      const entries = [], seen = new Set();
      for (const raw of args.paths || []) {
        let target;
        try {
          target = await resolvePath(raw);
          const key = pathKey(target.path);
          if (seen.has(key)) throw new Error(`Duplicate directory path: ${raw}`);
          seen.add(key);
          const stat = await exists(target.path);
          if (stat && !stat.isDirectory) entries.push({ path: target.display, status: "not_directory" });
          else if (stat) entries.push({ path: target.display, status: "exists", type: "directory", size: stat.size });
          else if (args.parents === false && !await exists(dirname(target.path))) entries.push({ path: target.display, status: "parent_missing" });
          else {
            await Deno.mkdir(target.path, { recursive: args.parents !== false });
            entries.push({ path: target.display, status: "created", type: "directory" });
          }
        } catch (error) {
          entries.push({ path: target?.display || String(raw), status: errorStatus(error), error: String(error?.message || error) });
        }
      }
      const succeeded = entries.filter(entry => entry.status === "created" || entry.status === "exists").length;
      return { succeeded, failed: entries.length - succeeded, entries };
    }
    if (name === "fs_copy" || name === "fs_move") {
      const entries = [], destinations = new Set();
      for (const entry of args.entries || []) {
        let from, to;
        try {
          from = await resolvePath(entry.from); to = await resolvePath(entry.to);
          const destinationKey = pathKey(to.path);
          if (destinations.has(destinationKey)) throw new Error(`Duplicate destination path: ${entry.to}`);
          destinations.add(destinationKey);
          const sourceStat = await exists(from.path), destinationStat = await exists(to.path);
          if (!sourceStat) { entries.push({ from: from.display, to: to.display, status: "not_found" }); continue; }
          if (sourceStat.isDirectory && within(from.path, to.path)) {
            entries.push({ from: from.display, to: to.display, status: "invalid_destination", error: "Destination cannot be inside the source directory" });
            continue;
          }
          if (destinationStat) { entries.push({ from: from.display, to: to.display, status: "destination_exists" }); continue; }
          if (args.create_parents === false && !await exists(dirname(to.path))) {
            entries.push({ from: from.display, to: to.display, status: "parent_missing" }); continue;
          }
          if (args.create_parents !== false) await Deno.mkdir(dirname(to.path), { recursive: true });
          if (name === "fs_copy") await copyRecursive(from.path, to.path);
          else await moveRecursive(from.path, to.path);
          entries.push({ from: from.display, to: to.display, status: name === "fs_copy" ? "copied" : "moved" });
        } catch (error) {
          const partial = to?.path && !!await exists(to.path).catch(() => false);
          entries.push({
            from: from?.display || String(entry.from), to: to?.display || String(entry.to),
            status: partial ? "failed_partial" : errorStatus(error), error: String(error?.message || error),
          });
        }
      }
      const wanted = name === "fs_copy" ? "copied" : "moved";
      const succeeded = entries.filter(entry => entry.status === wanted).length;
      return { succeeded, failed: entries.length - succeeded, entries };
    }
    if (name === "fs_trash" || name === "fs_untrash") {
      const rootReal = await workspaceRootReal(), metadataRoot = resolve(DATA), trashRoot = resolve(TRASH_ROOT);
      const slash = path => slashPath(relative(rootReal, path)) || ".";
      if (name === "fs_trash") {
        const candidates = [], entries = [];
        const addCandidate = async raw => {
          let target;
          try {
            target = await resolvePath(raw);
            const stat = await exists(target.path);
            if (!stat) { entries.push({ path: target.display, status: "not_found" }); return; }
            if (resolve(target.path) === resolve(rootReal)) { entries.push({ path: target.display, status: "invalid_target", error: "Cannot trash the current Workspace" }); return; }
            if (resolve(target.path) === metadataRoot || within(metadataRoot, target.path)) {
              entries.push({ path: target.display, status: "invalid_target", error: "Cannot trash MrMCP metadata" }); return;
            }
            candidates.push({ ...target, stat });
          } catch (error) {
            entries.push({ path: target?.display || String(raw), status: errorStatus(error), error: String(error?.message || error) });
          }
        };
        for (const raw of args.paths || []) await addCandidate(raw);
        if (args.selection) {
          const walked = await fsWalk(selection.root.path, args.selection.path || ".", { ...args.selection, root_real: rootReal, hard_limit: 10001, metadata: false });
          if (walked.limited || walked.entries.length > 10000) throw new Error("fs_trash selection matched more than 10000 paths");
          for (const entry of walked.entries) await addCandidate(entry.path);
        }
        const unique = new Map();
        for (const target of candidates) if (!unique.has(pathKey(target.path))) unique.set(pathKey(target.path), target);
        const ordered = [...unique.values()].sort((a, b) =>
          a.display.split("/").length - b.display.split("/").length || a.display.localeCompare(b.display));
        const selected = [];
        for (const target of ordered) {
          if (selected.some(parent => resolve(parent.path) !== resolve(target.path) && within(parent.path, target.path))) continue;
          selected.push(target);
        }
        if (!selected.length) return { trash_id: null, trash_path: null, succeeded: 0, failed: entries.length, entries };
        const date = new Date(), pad = value => String(value).padStart(2, "0");
        const baseId = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
        let trashId = baseId, increment = 1;
        for (;;) {
          const trashDir = join(trashRoot, trashId);
          if (!await exists(trashDir) && !one("SELECT 1 FROM trash_transactions WHERE trash_id=?", trashId)) break;
          trashId = baseId + "-" + (++increment);
        }
        const trashDir = join(trashRoot, trashId), planned = [];
        for (const [index, target] of selected.entries()) {
          try {
            const metadata = await trashItemMetadata(target.path, target.stat);
            planned.push({ target, original_path: resolve(target.path), payload: index + "-" + basename(target.path), ...metadata });
          } catch (error) {
            entries.push({ path: target.display, status: errorStatus(error), error: String(error?.message || error) });
          }
        }
        if (!planned.length) return { trash_id: null, trash_path: null, succeeded: 0, failed: entries.length, entries };
        db.exec("BEGIN IMMEDIATE");
        try {
          run("INSERT INTO trash_transactions(trash_id,created_at) VALUES(?,?)", trashId, Date.now());
          for (const item of planned) run(
            "INSERT INTO trash_items(trash_id,payload,original_path,item_type,size_bytes) VALUES(?,?,?,?,?)",
            trashId, item.payload, item.original_path, item.item_type, item.size_bytes,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        try { await Deno.mkdir(trashDir, { recursive: true }); }
        catch (error) { run("DELETE FROM trash_transactions WHERE trash_id=?", trashId); throw error; }
        let succeeded = 0;
        for (const item of planned) {
          const destination = join(trashDir, item.payload);
          try {
            await moveRecursive(item.target.path, destination);
            entries.push({ path: item.target.display, status: "trashed" });
            succeeded++;
          } catch (error) {
            const partial = !!await exists(destination).catch(() => false);
            if (!partial) run("DELETE FROM trash_items WHERE trash_id=? AND payload=?", trashId, item.payload);
            entries.push({ path: item.target.display, status: partial ? "failed_partial" : errorStatus(error), error: String(error?.message || error) });
          }
        }
        if (!one("SELECT 1 FROM trash_items WHERE trash_id=? LIMIT 1", trashId)) {
          await Deno.remove(trashDir, { recursive: true }).catch(error => { if (!(error instanceof Deno.errors.NotFound)) throw error; });
          run("DELETE FROM trash_transactions WHERE trash_id=?", trashId);
          return { trash_id: null, trash_path: null, succeeded: 0, failed: entries.length, entries };
        }
        changed({ ui: ["state", "trash"] }, "fs-trash");
        return { trash_id: trashId, trash_path: trashDir, succeeded, failed: entries.length - succeeded, entries };
      }
      const trashId = String(args.trash_id || "").trim();
      if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(trashId)) throw new Error("Invalid trash_id");
      if (!one("SELECT 1 FROM trash_transactions WHERE trash_id=?", trashId)) throw new Error("Trash transaction not found");
      const trashDir = join(trashRoot, trashId), items = all(
        "SELECT payload,original_path,item_type,size_bytes FROM trash_items WHERE trash_id=? ORDER BY payload", trashId,
      );
      if (!items.length) throw new Error("Trash transaction contains no items");
      const entries = []; let succeeded = 0;
      for (const item of items) {
        const target = resolve(String(item.original_path || "")), source = resolve(trashDir, String(item.payload || ""));
        if (!within(rootReal, target)) { entries.push({ path: slash(target), status: "wrong_workspace" }); continue; }
        if (!within(trashDir, source)) { entries.push({ path: slash(target), status: "invalid_payload" }); continue; }
        if (!await exists(source)) { entries.push({ path: slash(target), status: "not_in_trash" }); continue; }
        if (await exists(target)) { entries.push({ path: slash(target), status: "destination_exists" }); continue; }
        if (!await exists(dirname(target))) { entries.push({ path: slash(target), status: "parent_missing" }); continue; }
        try {
          await moveRecursive(source, target);
          run("DELETE FROM trash_items WHERE trash_id=? AND payload=?", trashId, item.payload);
          entries.push({ path: slash(target), status: "restored" });
          succeeded++;
        } catch (error) {
          const partial = !!await exists(target).catch(() => false);
          entries.push({ path: slash(target), status: partial ? "failed_partial" : errorStatus(error), error: String(error?.message || error) });
        }
      }
      await cleanupTrashTransactionIfEmpty(trashId, trashDir);
      changed({ ui: ["state", "trash"] }, "fs-untrash");
      return { trash_id: trashId, succeeded, failed: entries.length - succeeded, entries };
    }
    if (name === "publish") {
      const sourceCount = [args.path !== undefined, args.text !== undefined, args.base64 !== undefined].filter(Boolean).length;
      if (sourceCount !== 1) throw new Error("Provide exactly one of path, text or base64");
      const options = {
        filename: args.filename, mime_type: args.mime_type, presentation: args.presentation,
        title: args.title, description: args.description, height: args.height,
        server_id: p.id, context_handle: args.chat_session,
        context_id: selection.context.id, root_id: selection.root.id, root_name: selection.root.name, root_path: selection.root.path,
      };
      if (args.path !== undefined) {
        const target = await resolvePath(args.path);
        return await publishContent({ path: target.path }, {
          ...options, source: "path", filename: args.filename || basename(target.path), allowed_root: target.root.path,
        });
      }
      const bytes = args.text !== undefined ? enc.encode(String(args.text)) : decodePublishBase64(args.base64);
      return await publishContent({ bytes }, { ...options, source: args.text !== undefined ? "text" : "base64" });
    }
    if (name === "cdp_call") return await runCdpBatch(args);
    if (name === "cdp_subs") return await cdpSubs(args);
    if (name === "cdp_poll") return await cdpPoll(args);
    if (name === "memory_find") return memoryFindRows(p, selection, args);
    if (name === "memory_set") {
      if (args.delete === true && (Object.prototype.hasOwnProperty.call(args, "value") || Object.prototype.hasOwnProperty.call(args, "json")))
        throw new Error("memory_set value and json must be omitted when delete=true");
      return memorySetValue(p, selection, args);
    }
    if (name === "telegram_req") return await telegramRequest(args);
    if (name === "discover_commands") return await discoverCommands();
    if (name === "tools_log") {
      const requestedLimit = Math.max(1, Math.min(Number(args.limit || 10), 50));
      const exactId = args.id == null ? 0 : Math.max(1, Number(args.id));
      const detail = args.detail === "full" ? "full" : "summary", limit = exactId ? 1 : requestedLimit;
      const conditions = ["context_handle=?", "id<>?"];
      const values = [args.chat_session, Number(execution.logId || 0)];
      const tool = String(args.tool || "").trim(), status = String(args.status || "").trim();
      const query = String(args.query || "").trim();
      if (exactId) { conditions.push("id=?"); values.push(exactId); }
      if (tool) { conditions.push("tool=?"); values.push(tool); }
      if (status) { conditions.push("status=?"); values.push(status); }
      if (!exactId && args.before_id != null) { conditions.push("id<?"); values.push(Math.max(1, Number(args.before_id))); }
      if (query) {
        conditions.push(`instr(lower(
          CAST(id AS TEXT)||char(10)||COALESCE(CAST(started_at AS TEXT),'')||char(10)||
          COALESCE(CAST(completed_at AS TEXT),'')||char(10)||COALESCE(CAST(server_id AS TEXT),'')||char(10)||
          server_name||char(10)||tool||char(10)||status||char(10)||payload_mode||char(10)||mcp_request_json||char(10)||mcp_response_json||char(10)||
          error||char(10)||
          COALESCE(CAST(duration_ms AS TEXT),'')||char(10)||CAST(context_id AS TEXT)||char(10)||context_handle||char(10)||
          CAST(root_id AS TEXT)||char(10)||root_name||char(10)||root_path
        ), lower(?)) > 0`);
        values.push(query);
      }
      const select = detail === "full"
        ? "id,started_at,completed_at,tool,status,storage,payload_mode,mcp_request_json,mcp_response_json,error,duration_ms,root_name,root_path"
        : `id,started_at,completed_at,tool,status,storage,payload_mode,duration_ms,root_name,root_path,
           length(mcp_request_json) request_bytes,length(mcp_response_json) response_bytes,substr(error,1,1000) error_preview`;
      const rows = all(`SELECT ${select} FROM logs WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...values, limit + 1);
      const truncated = !exactId && rows.length > limit, page = rows.slice(0, limit);
      const calls = page.map(row => {
        const payloadMode = String(row.payload_mode || "payload");
        const summary = {
          id: row.id, started_at: new Date(row.started_at).toISOString(),
          completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
          tool: row.tool, status: row.status, storage: String(row.storage || "disk"), payload_mode: payloadMode, duration_ms: row.duration_ms,
          workspace_name: row.root_name, workspace_path: row.root_path,
        };
        if (detail === "summary") return {
          ...summary, payload_retained: toolCallModeKeepsJson(payloadMode),
          request_bytes: Number(row.request_bytes || 0), response_bytes: Number(row.response_bytes || 0),
          ...(row.error_preview ? { error_preview: row.error_preview } : {}),
        };
        if (!toolCallModeKeepsJson(payloadMode)) return {
          ...summary, payload_retained: false,
          ...(row.error ? { error: row.error } : {}),
        };
        return {
          ...summary, payload_retained: true, payload_complete: true,
          mcp_request: parseJson(row.mcp_request_json, row.mcp_request_json),
          mcp_response: parseJson(row.mcp_response_json, row.mcp_response_json || null),
          ...(row.error ? { error: row.error } : {}),
        };
      });
      return { detail, returned: calls.length, limit, calls, next_before_id: truncated && page.length ? Number(page.at(-1).id) : null, truncated };
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
      const record = await processOperation(p, name, args, false, execution);
      await record.done;
      return processView(record, args);
    }
    if (name === "exec_start") {
      const record = await processOperation(p, name, args, true, execution);
      return processStartView(record);
    }
    if (name === "exec_attach") return await attachManagedProcess(
      persistentProcess(args.exec_id, args.chat_session), args, execution,
    );
    if (name === "exec_write") {
      const record = persistentProcess(args.exec_id, args.chat_session);
      if (!record.stdin_writer) throw new Error(`Persistent exec_id ${record.log_id} stdin is closed`);
      if (args.data) {
        recordProcessInput(record, args.data, args.encoding);
        await record.stdin_writer.write(args.encoding === "base64"
          ? new Uint8Array(Buffer.from(String(args.data), "base64")) : enc.encode(String(args.data)));
      }
      if (args.close) {
        recordProcessInput(record, null, "utf-8", true);
        await record.stdin_writer.close(); record.stdin_writer = null;
      }
      return { exec_id: record.log_id,
        bytes_written: args.data ? (args.encoding === "base64"
          ? Buffer.from(String(args.data), "base64").length : enc.encode(String(args.data)).length) : 0,
        stdin_open: !!record.stdin_writer };
    }
    if (name === "exec_kill") {
      const record = persistentProcess(args.exec_id, args.chat_session);
      return { exec_id: record.log_id, killed: await terminateProcess(record, args.signal || "SIGTERM"),
        signal: args.signal || "SIGTERM" };
    }
    if (name === "exec_list") return { processes: activeProcesses(
      args.chat_session, Math.min(Number(args.limit || 50), 200),
    ) };
    if (name === "exec_status") return processStatusView(
      persistentProcess(args.exec_id, args.chat_session), args,
    );
    const custom = one("SELECT * FROM custom_tools WHERE server_id=? AND name=?", p.id, name);
    if (!custom) throw new Error("Unknown tool");
    const arrayCommand = parseJson(custom.command, null), customArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const spec = Array.isArray(arrayCommand) && arrayCommand.length
      ? { ...args, program: String(arrayCommand[0]), args: [...arrayCommand.slice(1).map(String), ...customArgs] }
      : { ...args, shell_command: custom.command + (args.shell_command_suffix ? " " + args.shell_command_suffix : "") };
    const record = await processOperation(p, name, spec, false, execution);
    await record.done;
    return processView(record, args);
  }

  function redactPublishedText(value) {
    const text = String(value ?? "");
    if (!text.includes("/published/")) return text;
    return text.replace(/\/published\/[A-Za-z0-9_-]{24,}\//g, "/published/[REDACTED]/");
  }
  function contextEnvelope(handle, extras = {}) {
    return { chat_session: String(handle || ""), ...extras };
  }
  function contextControlMessage(kind) {
    if (kind === "missing") return "chat_session is required. Call init_chat_session, then repeat this tool call with the exact value returned.";
    if (kind === "expired") return "The chat_session has expired. Call init_chat_session to create a new Session, then open a Workspace if needed before repeating this tool call.";
    if (kind === "invalid") return "The chat_session is invalid. Reuse a valid value or call init_chat_session.";
    return "";
  }
  function contextControlToolResult(p, name, args, resolution, descriptor = null, progressRequested = false, mcpRequest = null, mcpResponse = null) {
    const handle = resolution.record?.handle || resolution.supplied_handle || "";
    const error = contextControlMessage(resolution.kind);
    const structuredContent = contextEnvelope(handle, { error });
    const id = beginLog(p, name, args, handle, null, descriptor, false, progressRequested, resolution.record || null, mcpRequest);
    const policy = toolCallPolicyById.get(id) || { storage: "disk", payloadMode: "payload" }, mode = policy.payloadMode;
    const toolResult = { content: [{ type: "text", text: error }], structuredContent, isError: true };
    const responsePacket = typeof mcpResponse === "function" ? mcpResponse(toolResult) : toolCallMcpResponse(toolResult, mcpResponse ?? undefined);
    updateLog(id, {
      completed_at: Date.now(), duration_ms: 0, status: "invalid",
      mcp_response_json: toolCallJsonForMode(mode, responsePacket), error: toolCallErrorForMode(mode, error),
    });
    scheduleLogIndex(id, policy.storage);
    postOsNotification("tool_call", `⚠️ Invalid Tool Call #${id}`, toolCallNotificationBody(p, name, args, handle, null, error, progressRequested, resolution.record || null));
    finishToolCallRuntime(id);
    return toolResult;
  }

  function toolResultSummary(name, result, status) {
    // Summaries inspect only result metadata, never source text, transcripts or nested payloads.
    const continuation = field => `; continuation available via ${field}`;
    switch (name) {
      case "document_grep":
        return `${result.returned} passages; ${result.reindexed_files} files refreshed, ${result.unchanged_files} reused; ${result.mode}; ${result.error_count} errors${result.truncated ? "; incomplete selection" : ""}`;
      case "proxy_get":
        return `Proxies: ${result.returned ?? 0} · ${result.action || "pick"} · ${result.mode || "round_robin"}`;
      case "source_code_search":
        return `${result.returned} results; ${result.indexed_files} files / ${result.indexed_chunks} chunks indexed; ${result.error_count} errors; ${result.mode}` + (result.next_offset != null ? "; continue with next_offset" : "") + (result.truncation_reason ? `; incomplete: ${result.truncation_reason}` : "");
      case "fs_glob":
        return `${result.returned} entries returned on this page${result.truncated ? continuation("next_after_path") : ""}`;
      case "fs_grep": {
        const failures = result.files.reduce((count, file) => count + (file.status !== "ok" ? 1 : 0), 0);
        const matches = result.mode === "matches" ? `${result.returned} matching lines in ${result.matched_files} files`
          : `${result.returned} matched files${result.mode === "count" ? " with per-file matching-line counts" : ""}`;
        return `${matches} on this page; ${failures} files failed` +
          (result.skipped_large_files ? `; ${result.skipped_large_files} files skipped above max_file_bytes=${result.max_file_bytes}` : "") +
          (failures || result.skipped_large_files ? "; search coverage incomplete" : "") +
          (result.truncated ? `${continuation("next_resume_after")} (${result.truncation_reason}); remaining paths may have no matches` : "");
      }
      case "fs_read": case "fs_navigate": case "fs_stat": {
        let succeeded = 0, failed = 0, truncated = 0, matches = 0;
        for (const entry of result.files || result.entries) {
          if (entry.status !== "ok") { failed++; continue; }
          succeeded++;
          if (entry.truncated) truncated++;
          matches += entry.matches?.length || 0;
        }
        const activity = name === "fs_read" ? "files read" : name === "fs_navigate" ? "files searched" : "paths inspected";
        return `${succeeded} ${activity}; ${failed} failed` +
          (name === "fs_navigate" ? `; ${matches} matching lines returned` : "") +
          (truncated ? `; ${truncated} ranges truncated, continue each via next_start_line` : "");
      }
      case "fs_write": case "fs_edit": case "fs_text_convert_encoding_eol": case "fs_mkdir":
      case "fs_copy": case "fs_move": case "fs_trash": case "fs_untrash":
        return `${result.succeeded} entries succeeded; ${result.failed} failed` +
          (name === "fs_edit" ? `; ${result.total_replacements} replacements applied` : "") +
          (result.failed ? "; inspect per-entry outcomes before retrying" : "");
      case "tools_log":
        return `${result.returned} Tool Calls returned on this page${result.truncated ? continuation("next_before_id") : ""}`;
      case "memory_find":
        return `${result.memories.length} memories returned on this page${result.next_before_id != null ? continuation("next_before_id") : ""}`;
      case "chat_set_goal": return result.status === "disabled" ? "goal management disabled" : result.goal ? `goal ${result.status}; inactivity ${result.timeout_seconds} s; ${result.chatgpt_chat_id ? "conversation linked" : "conversation unassociated"}` : "goal disabled";
      case "chat_goal_debug": return `goal debug ${result.action}: ${result.operation_status}; ${result.chat_session_matched ? "conversation linked" : "conversation unassociated"}; login ${result.login_status}`;
      case "list_workspaces": return `${result.workspaces.length} enabled Workspaces`;
      case "discover_commands": return `${result.commands.length} available commands in the discovery catalog`;
      case "tools_schema": return `${result.tools.length} tool descriptors returned; ${result.missing.length} names unresolved`;
      default: return status;
    }
  }

  async function callTool(p, name, args, callInfo) {
    await waitForToolCallGate();
    if (name === "init_chat_session" && callInfo.descriptor) {
      const context = createContext(p, callInfo.protocolVersion || "", callInfo.clientMetadata || {});
      callInfo.contextHandle = context.handle;
      callInfo.selection = { context, root: unassignedWorkspaceRoot(p) };
    }
    const id = beginLog(
      p, name, args, callInfo.contextHandle, callInfo.selection?.root, callInfo.descriptor, true, !!callInfo.progressRequested,
      callInfo.selection?.context || null, callInfo.mcpRequest || null,
    ), started = Date.now(), policy = toolCallPolicyById.get(id) || { storage: "disk", payloadMode: "payload" }, payloadMode = policy.payloadMode;
    if (!activeCallControls.size) toolCallsIdle = new Promise(resolve => { resolveToolCallsIdle = resolve; });
    const control = { log_id: id, context_handle: callInfo.contextHandle, cancel: null, kind: "", process_id: "", kernel_id: "", progress_requested: !!callInfo.progressRequested };
    activeCallControls.set(id, control);
    emitToolCallActivity();
    const executionState = {
      ...callInfo, logId: id, payloadMode,
      progress: callInfo.requestStream?.progress || null,
      onDisconnect(callback) {
        if (typeof callback !== "function") return;
        let called = false;
        const once = () => {
          if (called) return;
          called = true;
          Promise.resolve().then(callback).catch(() => {});
        };
        callInfo.requestStream?.onDisconnect(once);
        const signal = callInfo.requestSignal;
        if (signal?.aborted) once();
        else signal?.addEventListener?.("abort", once, { once: true });
      },
      setCancel(cancel, metadata = {}) {
        control.cancel = cancel; Object.assign(control, metadata);
        emitUiChange(["logs"], "tool-call-cancellable");
      },
    };
    try {
      if (!callInfo.descriptor) throw new Error("Unknown tool");
      const result = await executeTool(p, name, args, executionState);
      const publicResult = result && typeof result === "object" ? result : { value: result };
      const extraContent = Array.isArray(publicResult[TOOL_RESULT_CONTENT]) ? publicResult[TOOL_RESULT_CONTENT] : [];
      const { [TOOL_RESULT_CONTENT]: _toolResultContent, ...structuredResult } = publicResult;
      const status = structuredResult.success === false ? "failed" : "completed";
      const envelope = contextEnvelope(callInfo.contextHandle);
      const structuredContent = { ...structuredResult, ...envelope };
      const rendered = typeof structuredResult.content === "string"
        ? `${structuredResult.content}\n\nchat_session: ${envelope.chat_session}`
        : `${name}: ${toolResultSummary(name, structuredResult, status)}. Complete result is available in structuredContent.\nchat_session: ${envelope.chat_session}`;
      const resultUiResourceUri = name === "publish" ? freshUiResourceUri(PUBLISH_UI_URI) : "";
      const toolResult = {
        content: [{ type: "text", text: rendered }, ...extraContent], structuredContent, isError: status !== "completed",
        ...(resultUiResourceUri ? { _meta: { ui: { resourceUri: resultUiResourceUri } } } : {}),
      };
      const responsePacket = typeof callInfo.mcpResponse === "function"
        ? callInfo.mcpResponse(toolResult) : toolCallMcpResponse(toolResult, callInfo.mcpResponse);
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status,
        mcp_response_json: toolCallJsonForMode(payloadMode, responsePacket),
      });
      scheduleLogIndex(id, policy.storage);
      if (status === "failed") {
        const failure = structuredResult.error || structuredResult.stderr ||
          (structuredResult.exit_code != null ? `Exit code ${structuredResult.exit_code}${structuredResult.signal ? ` · ${structuredResult.signal}` : ""}` : "Tool returned an error");
        postOsNotification("tool_call", `❌ Tool Call Failed #${id}`,
          toolCallNotificationBody(p, name, args, callInfo.contextHandle, callInfo.selection?.root, redactPublishedText(failure), !!callInfo.progressRequested, callInfo.selection?.context || null));
      }
      return toolResult;
    } catch (error) {
      const message = String(error?.stack || error);
      const envelope = contextEnvelope(callInfo.contextHandle);
      const structuredContent = { error: String(error?.message || error), ...envelope };
      const text = `${String(error?.message || error)}\nchat_session: ${envelope.chat_session}`;
      const toolResult = { content: [{ type: "text", text }], structuredContent, isError: true };
      const responsePacket = typeof callInfo.mcpResponse === "function"
        ? callInfo.mcpResponse(toolResult) : toolCallMcpResponse(toolResult, callInfo.mcpResponse);
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status: "failed",
        mcp_response_json: toolCallJsonForMode(payloadMode, responsePacket), error: toolCallErrorForMode(payloadMode, message),
      });
      scheduleLogIndex(id, policy.storage);
      postOsNotification("tool_call", `❌ Tool Call Failed #${id}`,
        toolCallNotificationBody(p, name, args, callInfo.contextHandle, callInfo.selection?.root, error?.message || error, !!callInfo.progressRequested, callInfo.selection?.context || null));
      return toolResult;
    } finally {
      activeCallControls.delete(id);
      if (callInfo.selection?.context) noteChatGoalActivity(callInfo.selection.context.handle);
      if (!activeCallControls.size && resolveToolCallsIdle) {
        resolveToolCallsIdle();
        resolveToolCallsIdle = null;
      }
      finishToolCallRuntime(id);
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
    if (u.pathname.startsWith("/published/")) {
      const parts = u.pathname.split("/");
      u.pathname = `/published/[REDACTED]/${parts.at(-1) || "content"}`;
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
    incrementRequestMetric();
    const remoteHost = info?.remoteAddr?.hostname || "", started = Date.now();
    const debugEnabled = getCfg("debug_http_log", "0") === "1";
    const requestPath = new URL(req.url).pathname;
    const publishedRequest = requestPath.startsWith("/published/");
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
      changed({ ui: ["debug"] }, "http-log-start");
      requestBodyPromise.then(body => {
        if (debugId) {
          run("UPDATE debug_logs SET request_body=? WHERE id=?", body, debugId);
          changed({ ui: ["debug"] }, "http-log-body");
        }
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
    let responseCapture = null, responseBody = publishedRequest ? "[published content body omitted]" : "";
    let body = response.body;
    if (debugEnabled && body && !publishedRequest) {
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
        const requestJson = parseJson(requestBody, null), responseJson = parseJson(responseBody, null);
        const contextHandle = String(
          responseJson?.result?.structuredContent?.chat_session ||
          requestJson?.params?.arguments?.chat_session ||
          "",
        );
        if (contextHandle) {
          const tool = String(requestJson?.params?.name || ""), finished = Date.now();
          const call = tool
            ? one(`SELECT context_id,root_id,root_name,root_path FROM logs
                WHERE context_handle=? AND tool=? AND started_at BETWEEN ? AND ?
                ORDER BY abs(started_at-?) ASC,id DESC LIMIT 1`, contextHandle, tool, started - 1000, finished + 1000, started)
            : null;
          const snapshot = call || one(`SELECT c.id context_id,c.root_id,
              COALESCE(r.name,'') root_name,COALESCE(r.path,'') root_path
              FROM contexts c LEFT JOIN roots r ON r.id=c.root_id WHERE c.handle=?`, contextHandle);
          if (snapshot) run(`INSERT OR REPLACE INTO debug_log_workspaces(debug_log_id,context_id,root_id,root_name,root_path)
              VALUES(?,?,?,?,?)`, debugId, Number(snapshot.context_id || 0), Number(snapshot.root_id || 0),
            String(snapshot.root_name || ""), String(snapshot.root_path || ""));
        }
        const errors = [handlerError, debugError, deliveryError ? `Response delivery error: ${String(deliveryError?.stack || deliveryError)}` : ""]
          .filter(Boolean).join("\n");
        run(`UPDATE debug_logs SET status=?,duration_ms=?,request_body=?,response_headers=?,response_body=?,error=? WHERE id=?`,
          response.status, Date.now() - started, requestBody, debugHeaders(headers), responseBody, errors, debugId);
        changed({ ui: ["debug"] }, "http-log-complete");
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
      changed({ ui: ["oauth", "dashboard"] }, "oauth-client");
      client = one("SELECT * FROM oauth_clients WHERE client_id=?", clientId);
      redirects = client ? parseJson(client.redirects_json, []) : [];
    } else if (client && !redirects.includes(redirect) && mayRecover) {
      redirects = [...new Set([...redirects, redirect])].slice(-20);
      run("UPDATE oauth_clients SET redirects_json=? WHERE client_id=?",
        JSON.stringify(redirects), clientId);
      changed({ ui: ["oauth", "dashboard"] }, "oauth-client");
      client = one("SELECT * FROM oauth_clients WHERE client_id=?", clientId);
    }
    if (!client) return { error: "unknown client registration" };
    if (!redirects.includes(redirect)) return { error: "redirect_uri does not match client registration" };
    return { client, p, redirect, resource, scope, challenge };
  }
  const eta = new Eta({ tags: ["<?", "?>"], autoEscape: true, cache: true });
  const promptEta = new Eta({ autoEscape: false, cache: false });
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

  async function renderGuidedPrompt(p, row, rawArgs, req, info, auth, transport, protocolVersion) {
    const args = rawArgs == null ? {} : rawArgs;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Prompt arguments must be an object");
    const allowed = new Set(row.arguments.map(argument => argument.name));
    for (const [name, value] of Object.entries(args)) {
      if (!allowed.has(name)) throw new Error(`Unknown argument for ${row.name}: ${name}`);
      if (typeof value !== "string") throw new Error(`Prompt argument ${name} must be a string`);
    }
    for (const argument of row.arguments)
      if (argument.required && !Object.hasOwn(args, argument.name)) throw new Error(`Missing required argument: ${argument.name}`);

    let session = null, workspace = null;
    const contextHandle = typeof args.chat_session === "string" ? args.chat_session : "";
    if (contextHandle) {
      const context = contextByHandle(p, contextHandle);
      if (!context || contextExpired(context)) throw new Error("Unknown or expired chat_session in prompt arguments");
      session = contextSnapshot(p, context);
      const root = selectedContextRoot(p, context);
      workspace = root.id ? { id: root.id, name: root.name, path: root.path } : null;
    }
    const now = new Date();
    const model = {
      args,
      prompt: guidedPromptDescriptor(row),
      session,
      workspace,
      workspaces: serverRoots(p).map(runtimeWorkspaceRoot).map(root => ({
        id: root.id, name: root.name, path: root.path,
      })),
      server: {
        name: "MrMCP", version: VERSION, public_base_url: publicBase(), mcp_url: mcpUrl(),
        protocol_version: protocolVersion || MCP_MODERN_PROTOCOL, protocol_versions: MCP_PROTOCOLS,
      },
      client: {
        auth_kind: auth.kind, client_id: auth.clientId || "", client_name: auth.clientName || "",
        user_agent: req.headers.get("user-agent") || "",
      },
      request: {
        url: req.url, method: req.method, transport,
        remote_host: info?.remoteAddr?.hostname || "",
      },
      runtime: {
        os: Deno.build.os, arch: Deno.build.arch, standalone: Deno.build.standalone,
        app_dir: APP_DIR, now: now.toISOString(), now_ms: now.getTime(),
      },
    };
    const text = typeof promptEta.renderStringAsync === "function"
      ? await promptEta.renderStringAsync(row.template, model)
      : promptEta.renderString(row.template, model);
    return {
      ...(row.description ? { description: row.description } : {}),
      messages: [{ role: "user", content: { type: "text", text: String(text) } }],
    };
  }

  // OAuth discovery/authorization and MCP 2026-07-28 routing.
  async function mcpHandler(req, info, transport = "http") {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/published/")) return await publishedContentResponse(req, u);
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
      changed({ ui: ["oauth", "dashboard"] }, "oauth-client");
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
        changed({ ui: ["oauth", "dashboard"] }, "oauth-code");
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
        changed({ ui: ["oauth", "dashboard"] }, "oauth-token");
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
        changed({ ui: ["oauth", "dashboard"] }, "oauth-token");
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
      const descriptor = fullAccess ? serverToolDescriptor(p, toolName) : null;
      return rejectToolCall(
        p, toolName, x.params?.arguments || x.params || {}, message,
        String(x.params?.arguments?.chat_session || ""), "invalid", result, descriptor, progressRequested, x, result,
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
      if (x.method === "tools/call") {
        const headerName = String(req.headers.get("mcp-name") || "");
        const bodyName = String(x.params?.name || "");
        if (headerName && headerName !== bodyName) {
          return rpcError(200, -32020, "Mcp-Name header does not match the request body", {
            headerName,
            bodyName,
          }, true);
        }
      }
    }

    if (x.id == null) {
      rejectParsedToolCall("tools/call notifications are not executed", null);
      return new Response(null, { status: 202 });
    }

    const serverInfoMeta = { "io.modelcontextprotocol/serverInfo": mcpServerInfo() };
    const instructions = fullAccess
      ? "Start a chat by calling init_chat_session with no arguments, unless you already have its valid chat_session. Reuse the exact returned chat_session on every subsequent tool call, including list_workspaces and tools_schema. Initialization creates no Workspace and selects no working directory. Use list_workspaces to discover enabled Workspace names, then open_workspace(chat_session,name) to attach or move this same Session. Only pass create=true when you explicitly want a missing Workspace created as a new empty Desktop folder. Filesystem tools, new processes, configured commands and JavaScript kernels require an open Workspace; desktop/CDP, discovery, diagnostics, memory, Telegram and text/base64 publication work without one. Existing process follow-ups remain available by chat_session after its Workspace is removed. The result includes workspace_name, absolute cwd, agent_guidance_path, whether this call created the Workspace, and a compact count/latest-key Memory summary for Global, Workspace and Session scopes. When guidance is non-null, read and follow it before repository work. Workspace changes preserve chat_session; only init_chat_session creates a Session. Invalid or expired values never create replacement Sessions implicitly. " +
        "Use fs_glob, fs_grep, fs_read, fs_navigate, fs_stat, fs_write and fs_edit directly for filesystem discovery, inspection, textual search and changes; do not spawn shell commands, uv or Python for operations those tools cover. Use document_grep for Xberg document extraction, scoped incremental fulltext/vector/hybrid retrieval over files. document_grep and source_code_search also work without a Workspace using Search default_path (initially Desktop/_default); they keep persistent indices across restarts and report effective source/index paths without assigning a Workspace. Use source_code_search for Lucerna BM25 retrieval, AST symbols and source maps with gitignore always enabled. This installation uses local lexical/AST search without semantic embeddings or call-graph analysis. For additional caller/impact exploration, prefer a suitable discovered catalog command. Batch independent reads and request small optional context when nearby text avoids another call. Check per-entry failures, skipped_large_files and continuation fields before claiming complete coverage or successful batch changes. Use fs_text_convert_encoding_eol only for explicit encoding/EOL/BOM representation conversion of named files when requested or specifically required by the task; never use it proactively to normalize a repository. Use desktop_auto for desktop observation and interaction through AAF YAML; when the model needs to see a screenshot, retain its image handle anywhere in the scenario's final state so the tool returns that image directly as MCP image content. Multiple retained screenshots and ordinary OCR/text/geometry/state values may coexist in one result. " +
        "workspace_dev_preferences_write is strictly opt-in: call it only when the user explicitly asks to copy/save/materialize their development preferences into the current Workspace. Never call it proactively, for preference discovery, or merely because DEV_PREF.md might exist; the tool returns no preference content and calling it does not imply that DEV_PREF.md should then be read or applied. " +
        "When work may benefit from command-line capability beyond the structured tools, call discover_commands proactively before inventing workarounds or assuming a utility is unavailable. It returns the complete user-chosen available command catalog in one call; prefer a listed command when it fits, remember the catalog for the Session, and invoke its logical_name directly through exec.program without PATH probes. Use chat_set_goal only for user-requested automatic ChatGPT follow-ups; goal empty stops them. It opens a dedicated Chrome login profile, tries to match the chat once per explicit set, and uses the configured default Tool Call inactivity timeout (initially 5 minutes). When globally disabled it returns disabled and performs no monitoring. After a failed/login/interrupted match, call chat_set_goal again only when a new attempt is wanted; background ticks and login completion do not retry it. Startup matching is an optional global setting, off by default. Check status before claiming the association is ready. Use tools_schema when exact live tool descriptor data is needed instead of relying on a connector-synthesized schema view. " +
        "Command output is normalized before buffering or streaming: ANSI/OSC/control sequences are removed and standalone carriage-return progress updates become separate lines. exec retains its complete foreground transcript and, when _meta.progressToken is supplied, also emits incremental progress before returning the same complete transcript at exit; observed cancellation/disconnect terminates exec's child, while the hard timeout covers transports that cannot report a disconnect before a response exists. Foreground exec and configured foreground commands default to 45 seconds but may be raised to 1 hour; high request timeouts can cross client/proxy retry or replay windows, so for long, expensive or non-idempotent work use exec_start, which immediately returns exec_id and leaves the persistent child independent of request lifetime. Pass that exec_id together with the same chat_session to exec_attach, exec_write, exec_kill or exec_status; ids from other Sessions are inaccessible. exec_list shows only currently running persistent executions in this Session. exec_status is the non-consuming way to inspect running or recently completed/killed executions and optionally retrieve all output or a tail. exec_attach is also request-bounded: timeout_ms defaults to 45 seconds and may be raised to 1 hour; high values can overlap client/proxy retries, so shorter repeated attaches or exec_status are safer, returns wait_timed_out=true when only the attachment wait expires while the child remains running, and can then be called again. With progressToken it streams unread backlog/live output only until exit/disconnect/that bounded wait; without progressToken it returns at most 16 KiB of unread output per call. An observed disconnect or the bounded attachment timeout detaches and never kills the persistent process; the timeout is also the fallback when a transport cannot report disconnect. " +
        "Use publish to present content to the user from exactly one of path, text or base64. Supply the real MIME type and optional filename; presentation=auto lets the smart MCP App choose an inline preview or file action, while inline/download are presentation hints. title and description appear above the published element. " +
        "Every authenticated client can invoke every published tool; chat_session is the bearer capability selecting the persistent Session and its current Workspace."
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
          ttlMs: 0,
          cacheScope: "private",
        };
      } else if (x.method === "ping") {
        r.result = { resultType: "complete", _meta: serverInfoMeta };
      } else if (x.method === "tools/list") {
        const tools = serverTools(p, fullAccess, true);
        r.result = {
          resultType: "complete", tools, ttlMs: 0,
          cacheScope: "private", _meta: serverInfoMeta,
        };
      } else if (x.method === "prompts/list") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for prompt access" };
          responseStatus = 403;
        } else {
          r.result = {
            resultType: "complete", prompts: (await readGuidedPromptConfig()).map(guidedPromptDescriptor),
            ttlMs: 0, cacheScope: "private", _meta: serverInfoMeta,
          };
        }
      } else if (x.method === "prompts/get") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for prompt access" };
          responseStatus = 403;
        } else {
          const name = typeof x.params?.name === "string" ? x.params.name : "";
          const row = (await readGuidedPromptConfig()).find(prompt => prompt.name === name);
          if (!name || !row) r.error = { code: -32602, message: `Unknown prompt: ${name || "(missing)"}` };
          else {
            try {
              r.result = {
                resultType: "complete",
                ...await renderGuidedPrompt(p, row, x.params?.arguments, req, info, auth, transport, observedProtocol),
                ttlMs: 0, cacheScope: "private", _meta: serverInfoMeta,
              };
            } catch (error) {
              r.error = { code: -32602, message: String(error?.message || error) };
            }
          }
        }
      } else if (x.method === "resources/list") {
        const resources = fullAccess ? [publishResource(freshUiResourceUri(PUBLISH_UI_URI))] : [];
        r.result = {
          resultType: "complete", resources, ttlMs: 0,
          cacheScope: "private", _meta: serverInfoMeta,
        };
      } else if (x.method === "resources/read") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for resource access" };
          responseStatus = 403;
        } else {
          const resourceUri = String(x.params?.uri || "");
          const resource = matchesUiResourceUri(resourceUri, PUBLISH_UI_URI)
            ? { uri: resourceUri, text: publishAppHtml(), _meta: publishUiMeta() } : null;
          if (!resource) {
            r.error = { code: -32002, message: `Resource not found: ${resourceUri}` };
            responseStatus = 200;
          } else {
            const resourceResult = { contents: [{ ...resource, mimeType: MCP_UI_MIME_TYPE }] };
            r.result = modernRequest
              ? { resultType: "complete", ...resourceResult, ttlMs: 0, cacheScope: "private", _meta: serverInfoMeta }
              : resourceResult;
          }
        }
      } else if (x.method === "tools/call") {
        if (!fullAccess) {
          const toolName = typeof x.params?.name === "string" && x.params.name
            ? x.params.name : "(invalid tools/call)";
          r.error = { code: -32001, message: "Authentication required for tool execution" };
          const logId = rejectToolCall(
            p, toolName, x.params?.arguments || x.params || {}, r.error.message,
            String(x.params?.arguments?.chat_session || ""), "failed", r.error, null, progressRequested,
            x, { jsonrpc: "2.0", id: x.id, error: r.error },
          );
          responseStatus = 403;
        } else if (!x.params?.name || typeof x.params.name !== "string") {
          r.error = { code: -32602, message: "tools/call requires params.name" };
          rejectToolCall(
            p, "(invalid tools/call)", x.params || {}, r.error.message,
            String(x.params?.arguments?.chat_session || ""), "invalid", r.error, null, progressRequested,
            x, { jsonrpc: "2.0", id: x.id, error: r.error },
          );
        } else {
          const rawToolArgs = x.params?.arguments ?? {};
          noteChatGoalActivity(rawToolArgs?.chat_session);
          const descriptor = serverToolDescriptor(p, x.params.name);
          const validationError = descriptor
            ? inputSchemaError(descriptor.inputSchema, rawToolArgs)
            : `Unknown tool: ${x.params.name}`;
          if (validationError) {
            r.error = { code: -32602, message: validationError };
            rejectToolCall(
              p, x.params.name, rawToolArgs, validationError,
              String(rawToolArgs?.chat_session || ""), "invalid", r.error, descriptor, progressRequested,
              x, { jsonrpc: "2.0", id: x.id, error: r.error },
            );
          } else {
            const toolArgs = { ...rawToolArgs };
            const wrapResult = toolResult => ({
              jsonrpc: "2.0", id: x.id,
              result: { resultType: "complete", ...toolResult, _meta: serverInfoMeta },
            });
            const invokeTool = async requestStream => {
              let toolResult;
              if (x.params.name === "init_chat_session") {
                toolResult = await callTool(p, x.params.name, toolArgs, {
                  authKind: auth.kind, contextHandle: "", selection: null, descriptor, requestStream,
                  requestSignal: req.signal, progressRequested, mcpRequest: x, mcpResponse: wrapResult,
                  protocolVersion: observedProtocol,
                  clientMetadata: { auth_kind: auth.kind, oauth_client_id: auth.clientId || "", client_name: auth.clientName || "", user_agent: req.headers.get("user-agent") || "" },
                });
              } else {
                const resolution = resolveContext(p, toolArgs.chat_session, observedProtocol);
                if (resolution.kind === "active") {
                  const selection = { context: resolution.record, root: selectedContextRoot(p, resolution.record) };
                  toolResult = await callTool(
                    p, x.params.name, toolArgs,
                    { authKind: auth.kind, contextHandle: resolution.record.handle, selection, descriptor, requestStream, requestSignal: req.signal, progressRequested, mcpRequest: x, mcpResponse: wrapResult },
                  );
                } else toolResult = contextControlToolResult(p, x.params.name, toolArgs, resolution, descriptor, progressRequested, x, wrapResult);
              }
              return toolResult;
            };
            const customProcessTool = !!descriptor && !BASE_TOOLS.includes(x.params.name);
            const streamingTool = x.params.name === "exec_attach" ||
              (progressRequested && (x.params.name === "exec" || customProcessTool));
            const acceptsSse = acceptsMediaType(req.headers.get("accept"), "text/event-stream");
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
      data_directory: DATA,
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
      git_preserve_line_endings: getCfg("git_preserve_line_endings", "1") === "1",
      chat_goals_enabled: chatGoalsEnabled(),
      chat_goal_login_verified_at: Number(getCfg("chat_goal_login_verified_at", "0")) || 0,
      chat_goal_login_active: chatGoalLoginActive,
      chat_goal_login_busy: chatGoalLoginBusy,
      chat_goal_login_detail: chatGoalLoginDetail,
      chat_goal_login_status: chatGoalLoginStatus || (chatGoalLoginReady() ? "authenticated" : "unknown"),
      chat_goal_login_checked_at: chatGoalLoginCheckedAt,
      chat_goal_login_composer: chatGoalLoginComposer,
      chat_goal_timeout_minutes: chatGoalDefaultTimeout() / 60,
      chat_goal_headless: getCfg("chat_goal_headless", "0") === "1",
      chat_goal_disable_images: getCfg("chat_goal_disable_images", "0") === "1",
      chat_goal_stop_before_send: getCfg("chat_goal_stop_before_send", "0") === "1",
      chat_goal_match_on_startup: getCfg("chat_goal_match_on_startup", "0") === "1",
      chat_goal_windows_hide: getCfg("chat_goal_windows_hide", "auto"),
      search_configuration: Deno.readTextFileSync(SEARCH_PATH),
      search_configuration_path: SEARCH_PATH,
      proxy_configuration: Deno.readTextFileSync(PROXIES_PATH), proxy_configuration_path: PROXIES_PATH,
      text_encoding_detection: textEncodingDetection(),
      exec_environment: getCfg("exec_environment", ""),
      tool_call_storage: toolCallStorage(),
      tool_call_payload_mode: toolCallPayloadMode(),
      tool_call_retention_hours: Number(getCfg("tool_call_retention_hours", "0")) || 0,
      tool_call_memory_retention_minutes: Number(getCfg("tool_call_memory_retention_minutes", "60")) || 0,
      telegram_bot_token: getCfg("telegram_bot_token", ""),
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
    const rootIds = new Set(roots.map(root => Number(root.id))), toolCounts = sessionToolCountProjection(serverId);
    const sessions = all(`SELECT c.id,c.root_id,c.last_active_at,c.created_at,c.client_name
      FROM contexts c WHERE c.server_id=? AND c.handle LIKE 'ctx_%'
      ORDER BY c.last_active_at DESC,c.created_at DESC`, serverId).map(context => ({
        pk: context.id,
        root_id: rootIds.has(Number(context.root_id)) ? Number(context.root_id) : 0,
        client_name: context.client_name || "Unknown client",
        created_at: context.created_at,
        last_active_at: context.last_active_at,
        tool_calls: toolCounts.get(Number(context.id)) || 0,
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
      default_root: { name: "No Workspace" },
    };
  };

  const contextProjection = (serverId, roots = rootsProjection(serverId), oauthClientId = "") => {
    const oauthFilter = String(oauthClientId || ""), toolCounts = sessionToolCountProjection(serverId),
      rootsById = new Map(roots.filter(root => root.enabled).map(root => [Number(root.id), root]));
    const rows = all(`SELECT c.id,c.handle,c.label,c.root_id,c.created_at,c.updated_at,c.last_active_at,c.protocol_version,c.auth_kind,c.oauth_client_id,c.client_name,c.user_agent,
      c.chatgpt_chat_id,c.goal_text,c.goal_timeout_seconds,c.goal_status,c.goal_next_check_at,c.goal_last_sent_at,c.goal_error
      FROM contexts c WHERE c.server_id=? AND c.handle LIKE 'ctx_%' ${oauthFilter ? "AND c.oauth_client_id=?" : ""}
      ORDER BY c.last_active_at DESC,c.created_at DESC LIMIT 500`,
      ...(oauthFilter ? [serverId, oauthFilter] : [serverId]));
    return rows.map(context => {
      const selected = Number(context.root_id || 0);
      const root = selected ? rootsById.get(selected) || null : null;
      const goal = chatGoalView(context);
      return {
        ...context,
        goal_status: goal.status,
        goal_next_check_at: goal.next_check_at || 0,
        goal_error: goal.detail || "",
        tool_calls: toolCounts.get(Number(context.id)) || 0,
        id: context.id,
        pk: context.id,
        chat_session: context.handle,
        kind: "chat_session",
        display_label: `#${context.id}`,
        expired: contextExpired(context),
        expires_at: Number(context.last_active_at || context.created_at || 0) + CONTEXT_TTL_MS,
        workspace_name: root?.name || "No Workspace",
        workspace_path: root?.path || "",
        workspace_id: root?.id || 0,
        workspace_selected: !!root,
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

  const validTrashId = value => /^\d{8}-\d{6}(?:-\d+)?$/.test(String(value || ""));
  function trashSummaryProjection() {
    const row = one(`SELECT
      (SELECT COUNT(*) FROM trash_transactions) transactions,
      (SELECT COUNT(*) FROM trash_items) items,
      COALESCE((SELECT SUM(CASE WHEN size_bytes>=0 THEN size_bytes ELSE 0 END) FROM trash_items),0) cached_bytes,
      COALESCE((SELECT SUM(CASE WHEN size_bytes<0 THEN 1 ELSE 0 END) FROM trash_items),0) unknown_sizes`) || {};
    return {
      transactions: Number(row.transactions || 0), items: Number(row.items || 0),
      cached_bytes: Number(row.cached_bytes || 0), unknown_sizes: Number(row.unknown_sizes || 0),
    };
  }
  function trashAdminProjection() {
    const transactions = all("SELECT trash_id,created_at FROM trash_transactions ORDER BY created_at DESC,trash_id DESC");
    const byId = new Map(transactions.map(row => [String(row.trash_id), {
      trash_id: String(row.trash_id), created_at: Number(row.created_at || 0), items: [], cached_bytes: 0, missing_count: 0, unknown_sizes: 0,
    }]));
    let itemCount = 0, cachedBytes = 0, unknownSizes = 0;
    for (const item of all("SELECT trash_id,payload,original_path,item_type,size_bytes FROM trash_items ORDER BY trash_id DESC,payload")) {
      itemCount++;
      const parent = byId.get(String(item.trash_id));
      if (!parent) continue;
      const trashPath = join(TRASH_ROOT, parent.trash_id), source = resolve(trashPath, String(item.payload || ""));
      let stat = null;
      if (within(trashPath, source)) try { stat = Deno.lstatSync(source); } catch {}
      const disk_type = stat ? (stat.isDirectory ? "directory" : stat.isSymlink ? "symlink" : stat.isFile ? "file" : "other") : "";
      const size = Number(item.size_bytes);
      if (size >= 0) { parent.cached_bytes += size; cachedBytes += size; }
      else { parent.unknown_sizes++; unknownSizes++; }
      if (!stat) parent.missing_count++;
      parent.items.push({
        payload: String(item.payload || ""), original: String(item.original_path || ""), type: String(item.item_type || "other"),
        size_cached: size >= 0 ? size : null, disk_present: !!stat, disk_type,
      });
    }
    for (const row of byId.values()) row.restorable = row.items.some(item => item.disk_present && item.original);
    return {
      transactions: [...byId.values()], transaction_count: transactions.length,
      item_count: itemCount, cached_bytes: cachedBytes, unknown_sizes: unknownSizes,
    };
  }
  async function cleanupTrashTransactionIfEmpty(trashId, trashDir = join(TRASH_ROOT, trashId)) {
    if (one("SELECT 1 FROM trash_items WHERE trash_id=? LIMIT 1", trashId)) return false;
    await Deno.remove(trashDir, { recursive: true }).catch(error => { if (!(error instanceof Deno.errors.NotFound)) throw error; });
    run("DELETE FROM trash_transactions WHERE trash_id=?", trashId);
    return true;
  }
  async function restoreManagedTrash(trashId, payload = "") {
    trashId = String(trashId || "").trim(); payload = String(payload || "");
    if (!validTrashId(trashId)) throw new Error("Invalid trash_id");
    return await withToolCallsDrained("trash", async () => {
      if (!one("SELECT 1 FROM trash_transactions WHERE trash_id=?", trashId)) throw new Error("Trash transaction not found");
      const trashDir = join(TRASH_ROOT, trashId), selected = payload
        ? all("SELECT payload,original_path FROM trash_items WHERE trash_id=? AND payload=?", trashId, payload)
        : all("SELECT payload,original_path FROM trash_items WHERE trash_id=? ORDER BY payload", trashId);
      if (!selected.length) throw new Error(payload ? "Trash item not found" : "Trash transaction contains no items");
      const entries = []; let succeeded = 0;
      for (const item of selected) {
        const name = String(item.payload || ""), source = resolve(trashDir, name), target = resolve(String(item.original_path || ""));
        if (!name || !within(trashDir, source)) { entries.push({ payload: name, original: String(item.original_path || ""), status: "invalid_payload" }); continue; }
        if (!await lstatIfExists(source)) { entries.push({ payload: name, original: target, status: "not_in_trash" }); continue; }
        if (await lstatIfExists(target)) { entries.push({ payload: name, original: target, status: "destination_exists" }); continue; }
        if (!await lstatIfExists(dirname(target))) { entries.push({ payload: name, original: target, status: "parent_missing" }); continue; }
        try {
          await moveRecursive(source, target);
          run("DELETE FROM trash_items WHERE trash_id=? AND payload=?", trashId, name);
          succeeded++;
          entries.push({ payload: name, original: target, status: "restored" });
        } catch (error) { entries.push({ payload: name, original: target, status: "failed", error: String(error?.message || error) }); }
      }
      await cleanupTrashTransactionIfEmpty(trashId, trashDir);
      changed({ ui: ["state", "trash"] }, "trash-restore");
      return { ok: succeeded === entries.length, trash_id: trashId, succeeded, failed: entries.length - succeeded, entries };
    });
  }
  async function deleteManagedTrash(trashId, payload = "") {
    trashId = String(trashId || "").trim(); payload = String(payload || "");
    if (!validTrashId(trashId)) throw new Error("Invalid trash_id");
    return await withToolCallsDrained("trash", async () => {
      if (!one("SELECT 1 FROM trash_transactions WHERE trash_id=?", trashId)) throw new Error("Trash transaction not found");
      const trashDir = join(TRASH_ROOT, trashId);
      if (!payload) {
        await Deno.remove(trashDir, { recursive: true }).catch(error => { if (!(error instanceof Deno.errors.NotFound)) throw error; });
        run("DELETE FROM trash_transactions WHERE trash_id=?", trashId);
        changed({ ui: ["state", "trash"] }, "trash-delete");
        return { ok: true, trash_id: trashId, deleted: "transaction" };
      }
      const item = one("SELECT payload FROM trash_items WHERE trash_id=? AND payload=?", trashId, payload);
      if (!item) throw new Error("Trash item not found");
      const source = resolve(trashDir, payload);
      if (!within(trashDir, source)) throw new Error("Invalid trash payload");
      await Deno.remove(source, { recursive: true }).catch(error => { if (!(error instanceof Deno.errors.NotFound)) throw error; });
      run("DELETE FROM trash_items WHERE trash_id=? AND payload=?", trashId, payload);
      await cleanupTrashTransactionIfEmpty(trashId, trashDir);
      changed({ ui: ["state", "trash"] }, "trash-delete");
      return { ok: true, trash_id: trashId, payload, deleted: "item" };
    });
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
      unassigned_workspace_label: "No Workspace",
      protocol_versions: MCP_PROTOCOLS,
      context_ttl_days: Math.round(CONTEXT_TTL_MS / 86400000),
    };
  };

  // Every render has a small shell projection (header/sidebar/settings state) plus exactly one
  // active-page projection. Inactive pages never query their tables during Eta -> Morphlex rerenders.
  const shellProjection = p => ({
    version: VERSION,
    settings: settingsProjection(),
    mcp_protocols: MCP_PROTOCOLS,
    maintenance: maintenanceProjection(),
    header_activity: headerActivityProjection(p),
    trash_summary: trashSummaryProjection(),
    process_summary: { active: [...processes.values()].filter(processIsRunning).length },
  });
  const pageProjection = (p, section, shell) => {
    const result = {};
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
    if (["all", "processes"].includes(section)) result.active_tool_calls = activeToolCallsProjection(p);
    if (["all", "dashboard"].includes(section)) {
      result.server = serverProjection(p);
      const toolCalls = shell.header_activity;
      result.stats = {
        context_values: one("SELECT COUNT(*) n FROM contexts WHERE server_id=? AND handle LIKE 'ctx_%'", p.id)?.n || 0,
        roots: one("SELECT COUNT(*) n FROM roots WHERE server_id=? AND enabled=1", p.id)?.n || 0,
        logs: toolCalls.tool_calls_total,
        in_flight: activeCallControls.size,
        failures: toolCalls.tool_calls_errors,
        total_requests: requestMetricValue,
      };
    }
    if (["all", "oauth"].includes(section)) result.oauth_clients = oauthProjection();
    return result;
  };
  const state = (section = "all") => {
    const valid = new Set(["all", "dashboard", "sessions", "processes", "logs", "browser", "automation", "published", "trash", "memory", "roots", "commands", "prompts", "prompt_help", "debug", "oauth", "telegram", "settings", "help"]);
    section = valid.has(section) ? section : "dashboard";
    const p = serverConfig();
    if (!p) throw new Error("MrMCP server configuration is missing");
    const shell = shellProjection(p);
    return { ...shell, ...pageProjection(p, section, shell) };
  };
  const publishedAdminFilter = (serverId, current = {}) => {
    const conditions = ["p.server_id=?"], values = [serverId];
    const contextId = Math.max(0, Number(current.context) || 0);
    const size = ["small", "medium", "large", "huge"].includes(String(current.size || "")) ? String(current.size) : "";
    if (contextId) {
      conditions.push("(p.context_id=? OR EXISTS(SELECT 1 FROM published_uses u WHERE u.published_id=p.id AND u.context_id=?))");
      values.push(contextId, contextId);
    }
    if (size === "small") conditions.push("p.size<1048576");
    else if (size === "medium") conditions.push("p.size>=1048576 AND p.size<10485760");
    else if (size === "large") conditions.push("p.size>=10485760 AND p.size<104857600");
    else if (size === "huge") conditions.push("p.size>=104857600");
    return { where: conditions.join(" AND "), values, context: contextId || "", size };
  };
  const publishedAdminProjection = (serverId, current = {}) => {
    const { where, values, context, size } = publishedAdminFilter(serverId, current), pageSize = 25;
    const total = Number(one(`SELECT COUNT(*) n FROM published p WHERE ${where}`, ...values)?.n || 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, Number(current.page) || 1)), offset = (page - 1) * pageSize;
    const rows = all(`SELECT p.id,p.content_key,p.context_id,p.root_id,p.root_name,p.root_path,p.source_path,p.source_filename,p.published_name,p.filename,p.mime_type,p.size,p.title,p.description,p.presentation,p.height,p.created_at,p.request_count,p.last_request_at
      FROM published p WHERE ${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`, ...values, pageSize, offset);
    const referencesByPublication = new Map();
    if (rows.length) {
      const ids = rows.map(row => String(row.id)), placeholders = ids.map(() => "?").join(",");
      const references = all(`SELECT u.published_id,u.context_id,u.root_id,u.root_name,u.root_path,u.source_path,u.source_filename,u.filename,u.mime_type,u.title,u.description,u.presentation,u.height,u.published_at
        FROM published_uses u
        WHERE u.published_id IN (${placeholders}) AND u.id=(SELECT MAX(u2.id) FROM published_uses u2
          WHERE u2.published_id=u.published_id AND u2.context_id=u.context_id AND u2.root_id=u.root_id)
        ORDER BY u.published_at DESC,u.id DESC`, ...ids);
      for (const reference of references) {
        const key = String(reference.published_id), group = referencesByPublication.get(key) || [];
        group.push(reference);
        referencesByPublication.set(key, group);
      }
    }
    for (const row of rows) {
      row.references = referencesByPublication.get(String(row.id)) || [];
      if (!row.references.length && row.context_id) row.references = [{
        context_id: row.context_id, root_id: row.root_id, root_name: row.root_name, root_path: row.root_path,
        source_path: row.source_path, source_filename: row.source_filename, filename: row.filename, mime_type: row.mime_type,
        title: row.title, description: row.description, presentation: row.presentation, height: row.height, published_at: row.created_at,
      }];
      row.reference_count = row.references.length;
    }
    const sessions = all(`SELECT context_id FROM published WHERE server_id=? AND context_id>0
      UNION SELECT u.context_id FROM published_uses u JOIN published p ON p.id=u.published_id WHERE p.server_id=? AND u.context_id>0
      ORDER BY context_id DESC`, serverId, serverId).map(row => Number(row.context_id));
    return { rows, total, page, pages, page_size: pageSize, sessions, context, size };
  };
  const memoryAdminProjection = (current = {}) => {
    memoryPurgeExpired();
    const conditions = ["1=1"], values = [], scope = ["global", "session", "workspace"].includes(String(current.scope || "")) ? String(current.scope) : "";
    const context = Math.max(0, Number(current.context) || 0), workspace = String(current.workspace || "").trim(), query = String(current.query || "").trim();
    if (scope === "global") conditions.push("scope='workspace' AND owner_id=0");
    else if (scope === "session") conditions.push("scope='session'");
    else if (scope === "workspace") conditions.push("scope='workspace' AND owner_id<>0");
    if (context) { conditions.push("scope='session' AND owner_id=?"); values.push(context); }
    if (workspace) { conditions.push("scope='workspace' AND owner_id<>0 AND owner_name=?"); values.push(workspace); }
    if (query) { conditions.push("instr(lower(key||char(10)||value_json),lower(?))>0"); values.push(query); }
    const from = String(current.from || "").trim(), to = String(current.to || "").trim();
    if (from) {
      const value = Date.parse(from.length === 10 ? `${from}T00:00:00` : from);
      if (Number.isFinite(value)) { conditions.push("set_at>=?"); values.push(value); }
    }
    if (to) {
      const value = Date.parse(to.length === 10 ? `${to}T23:59:59.999` : to);
      if (Number.isFinite(value)) { conditions.push("set_at<=?"); values.push(value); }
    }
    const pageSize = 25, where = conditions.join(" AND ");
    const total = Number(one(`SELECT COUNT(*) n FROM memories WHERE ${where}`, ...values)?.n || 0), pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, Number(current.page) || 1)), offset = (page - 1) * pageSize;
    const rows = all(`SELECT id,scope,owner_id,owner_name,key,value_json,is_json,ttl_seconds,set_at,expires_at FROM memories WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...values, pageSize, offset)
      .map(row => ({ ...row, scope: memoryPublicScope(row), owner_name: memoryPublicScope(row) === "global" ? GLOBAL_MEMORY_OWNER_NAME : String(row.owner_name), value_preview: String(row.value_json || "").slice(0, 320) }));
    const serverId = Number(serverConfig()?.id || 0);
    const sessions = all("SELECT id FROM contexts WHERE server_id=? AND handle LIKE 'ctx_%' ORDER BY id DESC", serverId).map(row => Number(row.id));
    const workspaces = all("SELECT name FROM roots WHERE server_id=? ORDER BY name COLLATE NOCASE", serverId).map(row => String(row.name));
    return { rows, total, page, pages, page_size: pageSize, sessions, workspaces, scope, context: context || "", workspace, query, from, to };
  };
  const adminInlineImages = (value, direction = "output") => {
    const images = [], seen = new WeakSet();
    const add = (path, mimeType, base64) => {
      const bytes = decodeLogBase64(base64);
      if (!bytes?.length) return;
      const mime = String(mimeType || sniffLogBinaryMime(bytes) || "").split(";")[0].trim().toLowerCase();
      if (!mime.startsWith("image/")) return;
      images.push({
        direction, json_path: path, content_type: "inline", mime_type: mime, bytes: bytes.length,
        data_url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
      });
    };
    const visit = (item, path = "$") => {
      if (typeof item === "string") {
        const dataUrl = item.startsWith("data:") ? item.match(/^data:([^;,\s]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i) : null;
        if (dataUrl) add(path, dataUrl[1], dataUrl[2]);
        else {
          const mime = sniffLogBase64ValueMime(item);
          if (mime.startsWith("image/")) add(path, mime, item);
        }
        return;
      }
      if (!item || typeof item !== "object" || seen.has(item)) return;
      seen.add(item);
      if (item.type === "image" && typeof item.data === "string")
        add(`${path}.data`, item.mimeType || item.mime_type || "image/png", item.data);
      for (const [key, child] of Object.entries(item)) visit(child, `${path}.${key}`);
    };
    visit(value);
    return images;
  };
  const cdpAdminMessage = message => {
    const value = cdpPublicMessage(message), data = value?.cdp?.result?.data;
    if (typeof data !== "string" || data.length <= 256) return value;
    return { ...value, cdp: { ...value.cdp, result: {
      ...value.cdp.result, data: `[base64 payload omitted from Browser JSON: ${data.length} characters]`,
    } } };
  };
  const browserAdminProjection = (current = {}) => {
    const p = serverConfig(), browserFilter = String(current.browser || ""), targetFilter = String(current.target || ""),
      contextFilter = Math.max(0, Number(current.context) || 0), activeFilter = ["active", "inactive"].includes(String(current.active || "")) ? String(current.active) : "";
    const persistent = all("SELECT browser,port,created_at,updated_at FROM cdp_browsers ORDER BY browser COLLATE NOCASE"),
      persistentByBrowser = new Map(persistent.map(row => [String(row.browser), row])),
      targetRows = all("SELECT browser,target,target_id,created_at,updated_at FROM cdp_targets ORDER BY browser COLLATE NOCASE,target COLLATE NOCASE"),
      targetsByBrowser = new Map(), targetSet = new Set();
    for (const row of targetRows) {
      const browser = String(row.browser), group = targetsByBrowser.get(browser) || [];
      group.push(row); targetsByBrowser.set(browser, group); targetSet.add(String(row.target));
    }
    const subscriptionsByBrowser = new Map();
    for (const subscription of cdpSubscriptions.values()) {
      const browser = String(subscription.browser), group = subscriptionsByBrowser.get(browser) || [];
      group.push(subscription); subscriptionsByBrowser.set(browser, group);
    }
    const browserSet = new Set(persistent.map(row => String(row.browser)));
    for (const name of cdpBrowsers.keys()) browserSet.add(String(name));
    const operations = [], originBrowserMatches = new Set(), operationSessionsByBrowser = new Map(),
      scanBatchSize = 50, scanLimit = 500, operationLimit = 200;
    let scannedToolCalls = 0, beforeId = Number.MAX_SAFE_INTEGER, scanExhausted = false;
    const operationMatchesFilters = operation =>
      (!browserFilter || operation.browser === browserFilter) && (!targetFilter || operation.target === targetFilter) &&
      (!contextFilter || operation.context_id === contextFilter) && (!activeFilter || (activeFilter === "active") === operation.active);
    while (scannedToolCalls < scanLimit && operations.length < operationLimit) {
      const batchLimit = Math.min(scanBatchSize, scanLimit - scannedToolCalls);
      const logRows = all(`SELECT id,started_at,completed_at,context_id,root_name,status,duration_ms,mcp_request_json,mcp_response_json
        FROM logs WHERE server_id=? AND tool='cdp_call' AND payload_mode='payload' AND (?=0 OR context_id=?) AND id<?
        ORDER BY id DESC LIMIT ?`, p.id, contextFilter, contextFilter, beforeId, batchLimit);
      if (!logRows.length) { scanExhausted = true; break; }
      scannedToolCalls += logRows.length;
      beforeId = Number(logRows.at(-1).id);
      for (const row of logRows) {
        const input = mcpToolArgsFromPacket(row.mcp_request_json), resolved = mcpToolStructuredResultFromPacket(row.mcp_response_json), calls = Array.isArray(input.calls) ? input.calls : [];
        for (let index = 0; index < calls.length; index++) {
          const spec = calls[index], browser = cdpBrowserLabel(spec?.browser ?? "main"), target = spec?.target == null ? "" : cdpBrowserLabel(spec.target),
            call = spec?.call && typeof spec.call === "object" ? spec.call : {}, live = cdpBrowsers.get(browser),
            active = !!(live?.open && live.ws?.readyState === WebSocket.OPEN),
            operationResult = Array.isArray(resolved?.results) ? resolved.results[index] : null, contextId = Number(row.context_id) || 0;
          browserSet.add(browser); if (target) targetSet.add(target);
          if (contextId) {
            const sessions = operationSessionsByBrowser.get(browser) || new Set();
            sessions.add(contextId); operationSessionsByBrowser.set(browser, sessions);
          }
          if ((!contextFilter || contextId === contextFilter) && (!targetFilter || target === targetFilter)) originBrowserMatches.add(browser);
          const operation = {
            log_id: Number(row.id), call_index: index, batch_size: calls.length, started_at: Number(row.started_at), completed_at: Number(row.completed_at || 0),
            context_id: contextId, root_name: String(row.root_name || ""), status: String(row.status), duration_ms: row.duration_ms,
            browser, target, active, method: String(call.method || ""),
            wait: input.wait !== false, call: spec, response: operationResult ? cdpAdminMessage(operationResult) : null,
            success: operationResult ? operationResult.success !== false && !operationResult.error : null,
            images: operationResult ? adminInlineImages(operationResult, "output") : [],
          };
          if (operationMatchesFilters(operation)) operations.push(operation);
          if (operations.length >= operationLimit) break;
        }
        if (operations.length >= operationLimit) break;
      }
      if (logRows.length < batchLimit) { scanExhausted = true; break; }
    }
    const operationHasMore = !scanExhausted && (operations.length >= operationLimit || scannedToolCalls >= scanLimit);
    const ringStatsByBrowser = new Map(), ringGroups = [];
    for (const [browser, record] of cdpBrowsers) {
      const active = !!(record?.open && record.ws?.readyState === WebSocket.OPEN), group = [];
      let notifications = 0, responses = 0;
      const includeRing = (!browserFilter || browser === browserFilter) && (!activeFilter || (activeFilter === "active") === active) &&
        (!contextFilter || originBrowserMatches.has(browser));
      for (let index = record.ring.length - 1, head = Number(record.ring_head || 0); index >= head; index--) {
        const message = record.ring[index];
        if (message.type === "notification") notifications++;
        else if (message.type === "response") responses++;
        if (includeRing && group.length < 150 && (!targetFilter || String(message.target || "") === targetFilter))
          group.push({ browser, bytes: Number(message._bytes || 0), ...cdpAdminMessage(message) });
      }
      ringStatsByBrowser.set(browser, { notifications, responses });
      if (includeRing) ringGroups.push(group);
    }
    const browserRows = [...browserSet].sort((a, b) => a.localeCompare(b)).map(browser => {
      const saved = persistentByBrowser.get(browser) || {}, live = cdpBrowsers.get(browser), active = !!(live?.open && live.ws?.readyState === WebSocket.OPEN),
        targets = targetsByBrowser.get(browser) || [], subscriptions = subscriptionsByBrowser.get(browser) || [],
        ringStats = ringStatsByBrowser.get(browser) || { notifications: 0, responses: 0 };
      const liveTargets = live ? [...live.live_targets.values()].map(info => {
        const targetId = String(info?.targetId || "");
        return {
          label: targetId ? String(live.target_labels.get(targetId) || "") : "", target_id: targetId,
          session_id: targetId ? String(live.target_to_session.get(targetId) || "") : "",
          type: String(info?.type || ""), title: String(info?.title || ""), url: String(info?.url || ""), attached: !!info?.attached,
        };
      }).sort((a, b) => (a.label || a.type || a.target_id).localeCompare(b.label || b.type || b.target_id)) : [];
      const options = live?.options || cdpBrowserOptions.get(browser), mode = cdpConnectionMode(options), remote = mode !== "local";
      return {
        browser, port: remote ? options?.port || null : Number(saved.port || live?.port || 0),
        user_data_dir: remote ? null : options?.user_data_dir || join(CDP_DIR, browser), active,
        connection_mode: mode, host: mode === "port" ? options.host : null, headless: remote ? null : options?.headless ?? false,
        connection_id: live?.connection_id || "", pending: live?.pending?.size || 0,
        ring_count: live ? cdpRingLength(live) : 0, ring_bytes: live?.ring_bytes || 0, dropped: live?.dropped || 0,
        recorded_sequence: cdpBrowserSequences.get(browser) || 0, notifications: ringStats.notifications, responses: ringStats.responses,
        oldest_seq: live ? cdpRingOldest(live)?.seq ?? null : null, newest_seq: live ? cdpRingNewest(live)?.seq ?? null : null,
        stream_resets: subscriptions.reduce((sum, subscription) => sum + Number(subscription.stream_resets || 0), 0),
        live_target_count: liveTargets.length, logical_target_count: targets.length, live_targets: liveTargets, subscription_count: subscriptions.length,
        session_ids: [...(operationSessionsByBrowser.get(browser) || [])].sort((a, b) => b - a),
        targets, subscriptions: subscriptions.map(subscription => ({
          id: subscription.id, targets: subscription.targets, methods: subscription.methods, method_prefixes: subscription.method_prefixes,
          include_browser: subscription.include_browser, regex: subscription.regex_source || "", regex_flags: subscription.regex_flags || "",
          cursor: subscription.cursor, dropped: subscription.dropped, stream_resets: subscription.stream_resets,
        })), created_at: Number(saved.created_at || 0), updated_at: Number(saved.updated_at || 0),
      };
    }).filter(row =>
      (!browserFilter || row.browser === browserFilter) && (!activeFilter || (activeFilter === "active") === row.active) &&
      (!contextFilter || originBrowserMatches.has(row.browser)) &&
      (!targetFilter || row.targets.some(target => String(target.target) === targetFilter) || originBrowserMatches.has(row.browser))
    );
    const ring = [];
    for (let index = 0; ring.length < 150; index++) {
      let added = false;
      for (const group of ringGroups) {
        if (!group[index]) continue;
        ring.push(group[index]); added = true;
        if (ring.length >= 150) break;
      }
      if (!added) break;
    }
    return {
      browsers: browserRows, browser_total: browserSet.size, operations, operation_matches: operations.length, operation_has_more: operationHasMore,
      operation_scan_calls: scannedToolCalls, operation_scan_limit: scanLimit, ring,
      browser_values: [...browserSet].sort((a, b) => a.localeCompare(b)), target_values: [...targetSet].sort((a, b) => a.localeCompare(b)),
      sessions: all("SELECT DISTINCT context_id FROM logs WHERE server_id=? AND tool='cdp_call' AND payload_mode='payload' AND context_id>0 ORDER BY context_id DESC", p.id).map(row => Number(row.context_id)),
      browser: browserFilter, target: targetFilter, context: contextFilter || "", active: activeFilter,
      tool_calls_total: Number(one("SELECT COUNT(*) n FROM logs WHERE server_id=? AND tool='cdp_call' AND payload_mode='payload'", p.id)?.n || 0),
    };
  };
  const automationAdminProjection = (current = {}) => {
    const p = serverConfig(), contextFilter = Math.max(0, Number(current.context) || 0), values = [p.id], where = ["server_id=?", "tool='desktop_auto'", "payload_mode='payload'"], pageSize = 10;
    if (contextFilter) { where.push("context_id=?"); values.push(contextFilter); }
    const sqlWhere = where.join(" AND "), total = Number(one(`SELECT COUNT(*) n FROM logs WHERE ${sqlWhere}`, ...values)?.n || 0),
      pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(pages, Math.max(1, Number(current.page) || 1)), offset = (page - 1) * pageSize;
    const sourceRows = all(`SELECT id,started_at,completed_at,context_id,context_handle,root_name,status,duration_ms,mcp_request_json,mcp_response_json,error
      FROM logs WHERE ${sqlWhere} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`, ...values, pageSize, offset);
    const rows = sourceRows.map(row => {
      const input = mcpToolArgsFromPacket(row.mcp_request_json), resolved = mcpToolStructuredResultFromPacket(row.mcp_response_json), yaml = String(input.yaml || "");
      let scenario = null, scenario_error = "";
      try { scenario = yaml ? parseYaml(yaml) : null; } catch (error) { scenario_error = String(error?.message || error); }
      const actions = Array.isArray(scenario) ? scenario.map((step, index) => {
        const entries = step && typeof step === "object" && !Array.isArray(step) ? Object.entries(step) : [];
        const [action, params] = entries[0] || ["unknown", step];
        return { index: index + 1, action: String(action), params };
      }) : [];
      const contents = [...adminInlineImages(input, "input"), ...adminInlineImages(resolved, "output")];
      return {
        id: Number(row.id), started_at: Number(row.started_at), completed_at: Number(row.completed_at || 0), context_id: Number(row.context_id) || 0,
        root_name: String(row.root_name || ""), status: String(row.status), duration_ms: row.duration_ms, yaml, scenario, scenario_error, actions,
        result: resolved, results_count: Array.isArray(resolved?.results) ? resolved.results.length : 0,
        images: contents, contents, error: String(row.error || ""),
      };
    });
    const sessions = all("SELECT DISTINCT context_id FROM logs WHERE server_id=? AND tool='desktop_auto' AND payload_mode='payload' AND context_id>0 ORDER BY context_id DESC", p.id).map(row => Number(row.context_id));
    return { rows, sessions, context: contextFilter || "", total, page, pages, page_size: pageSize };
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

  const fragmentTemplates = GUI_RUNTIME ? {
    sidebar: `<? const current=it.data?.state?.currentSection||"dashboard",items=[["dashboard","🏠","Dashboard"],["oauth","🔐","Clients"],["sessions","💬","Sessions"],["processes","🖥️","Processes",Number(it.data?.state?.processCount||0)],["roots","📁","Workspaces"],["logs","🛠️","Tool Calls"],["browser","🌐","Browser"],["automation","🖱️","Automation"],["published","📦","Published"],["trash","🗑️","Trash",Number(it.data?.state?.trashCount||0)],["memory","🧠","Memory"],["commands","🧰","Commands"],["prompts","🧭","Guided Prompts"],["debug","🐞","HTTP Log"],["telegram","✈️","Telegram"],["settings","⚙️","Settings"],["help","❓","Help"]]; items.forEach(([id,icon,label,badge])=>{ ?><button data-page="<?= id ?>" class="<?= current===id?'nav-active':'' ?>"<?= current===id?' aria-current=page':'' ?>><span class=menu-icon><?= icon ?></span><span class=menu-label><?= label ?></span><? if(Number(badge)>0){ ?><span class=menu-badge><?= badge ?></span><? } ?></button><? }) ?>`,
    view: `<? const s=it.data?.state||{},section=s.currentSection||"dashboard",settings=s.settings||{}; ?>
<? if(section==="dashboard"){ ?><section id=dashboard class=page><div class=row><h2 class=grow>🏠 Dashboard</h2><span class=muted>Runtime · activity · endpoints</span></div><div id=cards class=grid></div><div class=dashboard-grid><div><h3>🌐 Server</h3><div id=endpoints></div></div><div><h3>🔒 TLS and Connectivity</h3><div id=tlsStatus></div></div></div></section>
<? } else if(section==="sessions"){ ?><section id=sessions class=page><div class=row><h2 class=grow>💬 Sessions</h2><span class=muted>Live updates</span><button class=danger data-action=clear-sessions<?= s.maintenance?.active?' disabled':'' ?>>🗑️ Clear</button></div><p class=muted>Persistent MCP Sessions. Each Session is attached to a <b>📁 Workspace</b>.</p><? if(s.sessions?.oauthClientId){ ?><div class=row><span class=muted>OAuth filter</span><code><?= s.sessions.oauthClientId ?></code><button class=small data-action=clear-session-oauth>✕ Clear</button></div><? } ?><div class=card><b>Client Continuity</b><p class=muted>ChatGPT may create a new Session after model or thinking changes. Client/auth/User-Agent metadata is best effort.</p></div><div id=contextList></div></section>
<? } else if(section==="processes"){ ?><section id=processes class=page><div class=row><h2 class=grow>🖥️ Processes</h2><span class=muted>Live runtime state · independent of Tool Call payload retention</span></div><div class=row><h3 class=grow>🛠️ Active Tool Calls</h3><span class=muted>Live · finished calls remain for 5s</span></div><div id=activeToolCalls></div><div class=row><h3 class=grow>🖥️ Active Processes</h3><span class=muted>Foreground exec + persistent exec_start</span></div><p class=muted>Processes currently running in this MrMCP instance. Output below is an 8 KiB live tail; process control does not depend on Tool Call history.</p><div id=processList></div></section>
<? } else if(section==="roots"){ ?><section id=roots class=page><div class=row><h2 class=grow>📁 Workspaces</h2><button class=primary data-action=new-root>➕ Add Workspace</button><button class=danger data-action=clear-workspaces<?= s.maintenance?.active?' disabled':'' ?>>🗑️ Clear</button></div><p class=muted>Workspace names are unique. Drag Sessions to change where future Tool Calls run; running processes stay in their original folder.</p><div id=rootList></div></section>
<? } else if(section==="commands"){ const c=s.commands||{}, discoveryEnabled=c.discoveryEnabled!==false; ?><section id=commands class=page><div class=row><h2 class=grow>🧰 Extra Commands</h2><button class="<?= discoveryEnabled?'ok':'failed' ?>" data-action=toggle-command-discovery><?= discoveryEnabled?'🟢 Agent Discovery Enabled':'🔴 Agent Discovery Disabled' ?></button><button data-action=download-all-commands>⬇️ Download All</button><button class=primary data-action=new-command>➕ Register Command</button></div><p class=muted><code>commands.yaml</code> defines catalog entries and platform variants. Downloads select the current OS/architecture. Executables in <code>.mrmcp/bin</code> appear automatically.</p><div class=row><input id=commandQuery class=grow placeholder="Search name, path or description…" value="<?= c.query||'' ?>"><select id=commandFilter><option value=""<?= !c.filter?' selected':'' ?>>All Commands</option><option value=available<?= c.filter==='available'?' selected':'' ?>>Available</option><option value=unavailable<?= c.filter==='unavailable'?' selected':'' ?>>Unavailable</option><option value=yaml<?= c.filter==='yaml'?' selected':'' ?>>YAML Metadata</option><option value=disk<?= c.filter==='disk'?' selected':'' ?>>Disk Only</option></select><select id=commandPageSize><? [5,10,25,50].forEach(n=>{ ?><option<?= Number(c.pageSize||5)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=load-commands>🔎 Search</button></div><div id=commandList></div></section>
<? } else if(section==="prompts"){ const p=s.prompts||{}; ?><section id=prompts class=page><div class=row><h2 class=grow>🧭 Guided Prompts</h2><button data-action=prompt-help>❓ Template Help</button><button class=primary data-action=new-prompt>➕ Add Prompt</button></div><p class=muted><code>guided_prompts.yaml</code> is authoritative. Entries are exposed through MCP <code>prompts/list</code> and rendered on demand through <code>prompts/get</code>.</p><div class=row><input id=promptQuery class=grow placeholder="Search name, title, description or arguments…" value="<?= p.query||'' ?>"><select id=promptPageSize><? [5,10,25,50].forEach(n=>{ ?><option<?= Number(p.pageSize||5)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=load-prompts>🔎 Search</button></div><div id=promptList></div></section>
<? } else if(section==="prompt_help"){ const h=s.promptHelp||{}; ?><section id=prompt_help class=page><div class=row><h2 class=grow>🧭 Guided Prompt Templates</h2><button data-action=prompts-back>← Guided Prompts</button></div><div class=card><h3>YAML shape</h3><p><code>guided_prompts.yaml</code> contains a top-level <code>prompts</code> array. Prompt arguments are MCP string arguments with <code>name</code> plus optional <code>title</code>, <code>description</code> and <code>required</code>; <code>required</code> controls whether the client must supply them.</p><pre><?= h.yaml||'' ?></pre></div><div class=card><h3>Eta</h3><p>The <code>template</code> is rendered with Eta using standard tags and no HTML escaping. Read values with <code>&lt;%= it.args.focus %&gt;</code>, use normal JavaScript in <code>&lt;% ... %&gt;</code>, and branch on any model field. Templates are trusted local configuration and are not sandboxed.</p><pre><?= h.model||'' ?></pre></div><div class=card><h3>Session / Workspace context</h3><p><code>it.session</code> and <code>it.workspace</code> are populated only when the prompt declares a <code>chat_session</code> argument and the client supplies a valid active MrMCP Session handle. For a Session with no selected Workspace, <code>it.workspace</code> remains null. <code>it.workspaces</code> is always available and includes the fallback Workspace plus enabled named Workspaces.</p></div></section>
<? } else if(section==="logs"){ const l=s.logs||{}; ?><section id=logs class=page><div class=row><h2 class=grow>🛠️ Tool Calls</h2><button class=danger data-action=clear-tool-calls<?= s.maintenance?.active?' disabled':'' ?>>🗑️ Clear</button></div><p class=muted>Click a row for details. Terminate active work from Actions.</p><div class=row><input id=logTool placeholder="Tool / command…" value="<?= l.toolQuery||'' ?>"><input id=logQuery class=grow placeholder="Search input, output, errors…" value="<?= l.query||'' ?>"><select id=logContext><option value="">All sessions</option><? (s.contextValues||[]).forEach(v=>{ ?><option value="<?= v.pk ?>"<?= String(l.context||"")===String(v.pk)?" selected":"" ?>>#<?= v.pk ?></option><? }) ?></select><select id=logStatus class="<?= l.status||'' ?>"><option value="">All states</option><? ['completed','failed','invalid','running'].forEach(v=>{ ?><option class="<?= v ?>" value="<?= v ?>"<?= l.status===v?' selected':'' ?>><?= v ?></option><? }) ?></select><select id=logPageSize><? [10,25,50,100].forEach(n=>{ ?><option<?= Number(l.pageSize||25)===n?' selected':'' ?>><?= n ?></option><? }) ?></select><button data-action=clear-log-filters>🧹 Clear Filters</button></div><? if(l.selfTest){ ?><div id=logSelfTest class=card><div class=row><h3 class=grow>🧪 MCP Self-Test</h3><button class=small data-action=copy-detail data-target=logDetail>📋 Copy JSON</button><button class=small data-action=close-self-test>✕ Close</button></div><pre id=logDetail><?= it.pretty(l.selfTest) ?></pre></div><? } ?><div id=logList></div></section>
<? } else if(section==="browser"){ ?><section id=browser class=page><div class=row><h2 class=grow>🌐 Browser</h2><span class=muted>CDP state · retained traffic · replay</span></div><p class=muted>Diagnostic view over existing CDP browser/profile state, logical targets, subscriptions and retained ring traffic. Recorded request/response inspection and Replay use only Tool Calls retained with Payload mode.</p><div id=browserList></div></section>
<? } else if(section==="automation"){ ?><section id=automation class=page><div class=row><h2 class=grow>🖱️ Automation</h2><span class=muted>AAF scenarios · screenshots · replay</span></div><p class=muted>Diagnostic view over <code>desktop_auto</code> Tool Calls retained with Payload mode. Open a scenario/result to inspect its retained payloads, or replay it through the same stateless Auto.js engine.</p><div id=automationList></div></section>
<? } else if(section==="published"){ ?><section id=published class=page><div class=row><h2 class=grow>📦 Published</h2><button class=danger data-action=clear-published<?= s.maintenance?.active?' disabled':'' ?>>🗑️ Clear Matching</button></div><p class=muted>Deduplicated persistent content snapshots created by <code>publish</code>. Path, text and Base64 sources all become ordinary files under <code>.mrmcp/publish</code>; one resource may have references from multiple Sessions and Workspaces.</p><div id=publishedList></div></section>
<? } else if(section==="trash"){ ?><section id=trash class=page><div class=row><h2 class=grow>🗑️ Trash</h2><span class=muted>SQLite metadata · live payload presence · independent of Tool Call logging</span></div><p class=muted>Original path and type are cached when an item enters Trash; byte size is cached for non-directory payloads. Disk presence is checked live; missing payloads remain visible until their metadata is explicitly deleted.</p><div id=trashList></div></section>
<? } else if(section==="memory"){ const m=s.memory||{}; ?><section id=memory class=page><div class=row><h2 class=grow>🧠 Memory</h2><button class=primary data-action=new-memory>➕ New Memory</button></div><p class=muted>Persistent explicit key-value memory. Create it here or through <code>memory_set</code>. Each value is explicitly JSON or plain text; Global memory is server-wide, Session memory belongs to one Session, and Workspace memory is shared by Workspace label. Expired TTL entries are removed automatically.</p><div class=row><input id=memoryQuery class=grow placeholder="Search keys or values…" value="<?= m.query||'' ?>"><select id=memoryScope><option value=""<?= !m.scope?' selected':'' ?>>All scopes</option><option value=global<?= m.scope==='global'?' selected':'' ?>>Global</option><option value=session<?= m.scope==='session'?' selected':'' ?>>Session</option><option value=workspace<?= m.scope==='workspace'?' selected':'' ?>>Workspace</option></select><select id=memoryContext><option value="">All sessions</option><? (m.sessions||[]).forEach(id=>{ ?><option value="<?= id ?>"<?= String(m.context||'')===String(id)?' selected':'' ?>>#<?= id ?></option><? }) ?></select><select id=memoryWorkspace><option value="">All workspaces</option><? (m.workspaces||[]).forEach(name=>{ ?><option value="<?= name ?>"<?= String(m.workspace||'')===String(name)?' selected':'' ?>><?= name ?></option><? }) ?></select><input id=memoryFrom type=date title="Set on or after" value="<?= m.from||'' ?>"><input id=memoryTo type=date title="Set on or before" value="<?= m.to||'' ?>"><button data-action=load-memory>🔎 Search</button><button data-action=clear-memory-filters>🧹 Clear Filters</button></div><div id=memoryList></div></section>
<? } else if(section==="debug"){ const d=s.debug||{},enabled=!!s.debug?.enabled; ?><section id=debug class=page><div class=row><h2 class=grow>🐞 HTTP Debug Log</h2><button class="debug-toggle <?= enabled?'enabled':'disabled' ?>" data-action=toggle-debug-settings aria-pressed="<?= enabled?'true':'false' ?>"><?= enabled?"🟢 Logging ON · Disable":"🔴 Logging OFF · Enable" ?></button><button class=danger data-action=clear-debug>🗑️ Clear</button></div><p class=muted>Off by default. Secrets are redacted. Disabling stops new records but keeps stored data visible. Click a row for request JSON.</p><div class=row><input id=debugQuery class=grow placeholder="Search URL, headers, body or errors…" value="<?= d.query||'' ?>"><select id=debugMethod><option value="">All methods</option><? ['GET','POST','OPTIONS'].forEach(v=>{ ?><option<?= d.method===v?' selected':'' ?>><?= v ?></option><? }) ?></select><input id=debugStatus type=number placeholder="Status" value="<?= d.status||'' ?>"><button data-action=load-debug>🔎 Search</button></div><div id=debugList></div></section>
<? } else if(section==="oauth"){ ?><section id=oauth class=page><div class=row><h2 class=grow>🔐 OAuth Clients</h2><button class=danger data-action=clear-clients<?= s.maintenance?.active?' disabled':'' ?>>🗑️ Clear</button></div><div id=oauthList></div></section>
<? } else if(section==="telegram"){ const t=s.telegram||{}; ?><section id=telegram class=page><div class=row><h2 class=grow>✈️ Telegram</h2><button class=primary data-action=save-telegram<?= t.save_disabled?' disabled':'' ?>>💾 Save Telegram</button></div><div class=card><h3>🤖 Telegram Bot</h3><div class=row><label class=grow>Bot token</label><? if(t.field_warning){ ?><span class=field-warning>⚠ <?= t.field_warning ?></span><? } ?></div><input id=telegramBotToken type=password autocomplete=off value="<?= t.telegram_bot_token||'' ?>" placeholder="123456789:AA…"><p class=muted>Used only by <code>telegram_req</code> to authenticate Bot API requests. Chat IDs, channels and application state are intentionally left to the agent/Memory.</p></div></section>
<? } else if(section==="settings"){ const tab=s.settingsTab||"network"; ?><section id=settings class=page><div class=row><h2 class=grow>⚙️ Settings</h2><button class=primary data-action=save-settings<?= settings.save_disabled?' disabled':'' ?>>💾 Save Settings</button></div><nav class=settings-tabs aria-label="Settings sections"><? [["network","🌐","Network"],["security","🔒","Security"],["process","🖥️","Process"],["files","📄","Files"],["goals","🎯","Goals"],["search","🔎","Search"],["proxies","🌐","Proxies"],["notifications","🔔","Notifications"],["maintenance","🧹","Maintenance"]].forEach(([id,icon,label])=>{ ?><button data-action=settings-tab data-settings-tab="<?= id ?>" class="<?= tab===id?'active':'' ?>"<?= tab===id?' aria-current=page':'' ?>><?= icon ?> <?= label ?></button><? }) ?></nav><p class=muted>📂 Data Directory · <code style="overflow-wrap:anywhere"><?= settings.data_directory||'' ?></code></p><div class=settings-layout><div class=settings-main><div class=card<? if(tab!=="network"){ ?> hidden<? } ?>><h3>🌐 Listeners</h3><p><b>HTTP</b> <code>0.0.0.0:<?= settings.mcp_http_port ?></code><? if(settings.mcp_http_port!==settings.mcp_http_port_base){ ?> <span class=pending>⚠ fallback from <?= settings.mcp_http_port_base ?></span><? } ?> · ACME HTTP-01 <?= settings.acme_http_available?"available":"unavailable" ?></p><p><b>HTTPS</b> <code>0.0.0.0:<?= settings.mcp_https_port ?></code><? if(settings.mcp_https_port!==settings.mcp_https_port_base){ ?> <span class=pending>⚠ fallback from <?= settings.mcp_https_port_base ?></span><? } ?> · MCP, OAuth and metadata</p><p><b>GUI</b> <code><?= settings.gui_transport ?></code> · local-only, no network listener</p><label>Public IPv4</label><div class=row><input id=publicIp readonly class=grow value="<?= settings.public_ip||'' ?>"><button data-action=detect-ip>🔎 Detect</button></div><div class=row><label class=grow>Public base URL override</label><? if(settings.field_warnings?.external_url){ ?><span class=field-warning>⚠ <?= settings.field_warnings.external_url ?></span><? } ?></div><input id=externalUrl class=grow placeholder="https://mcp.example.com" value="<?= settings.external_url||'' ?>"><div class=row><label class=grow>Public IPv4 lookup URLs (one per line)</label><? if(settings.field_warnings?.public_ip_urls){ ?><span class=field-warning>⚠ <?= settings.field_warnings.public_ip_urls ?></span><? } ?></div><textarea id=publicIpUrls><?= (settings.public_ip_urls||[]).join("\\n") ?></textarea><div class=row><label class=grow>Automatic DNS suffix</label><? if(settings.field_warnings?.sslip_suffix){ ?><span class=field-warning>⚠ <?= settings.field_warnings.sslip_suffix ?></span><? } ?></div><input id=sslipSuffix placeholder="sslip.io" value="<?= settings.sslip_suffix||'sslip.io' ?>"><div class=row><label class=grow>ACME directory URL</label><? if(settings.field_warnings?.acme_directory_url){ ?><span class=field-warning>⚠ <?= settings.field_warnings.acme_directory_url ?></span><? } ?></div><input id=acmeDirectoryUrl class=grow value="<?= settings.acme_directory_url||'' ?>"></div><div class=card<? if(tab!=="security"){ ?> hidden<? } ?>><h3>🔒 Certificate</h3><div class=row><label class=grow>Let's Encrypt email</label><? if(settings.field_warnings?.tls_email){ ?><span class=field-warning>⚠ <?= settings.field_warnings.tls_email ?></span><? } ?></div><input id=tlsEmail value="<?= settings.tls_email||'' ?>"><div class=row><button data-action=issue-cert>🛡️ Check / Request Certificate</button></div><p class=muted>Valid certificates are reused. ACME HTTP-01 requires effective HTTP port 80.</p></div></div><div class=settings-side><div class=card<?= tab==="proxies"?'':' hidden' ?>><h3>🌐 Proxies</h3><p class=muted>Configure proxy entries, public list sources and cooldowns. proxy_get selects entries and records reported successes/failures in SQLite.</p><p class=muted><code><?= settings.proxy_configuration_path ?></code></p><? if(settings.field_warnings?.proxy_configuration){ ?><div class=field-warning>⚠ <?= settings.field_warnings.proxy_configuration ?></div><? } ?><textarea id=proxyConfiguration rows=20><?= settings.proxy_configuration||'' ?></textarea><p class=muted>direct means a direct request. Lists refresh on tool use; no background checks run.</p></div><div class=card<?= tab==="search"?'':' hidden' ?>><h3>🔎 Search</h3><p class=muted>Configuration file: <?= settings.search_configuration_path ?>. Fulltext is ready without an embedding model. Configure Ollama or an OpenAI-compatible embedding endpoint for vector/hybrid search.</p><p>Without a Workspace: <code><?= settings.default_search_path||'Desktop/_default' ?></code></p><p class=muted>default_path in this YAML selects the source folder. Empty uses Desktop/_default, created on the first search. Both document and source indices persist under the data directory; source files stay in their own folder.</p><label>Search and native OCR configuration<textarea id=searchConfiguration rows=20 spellcheck=false><?= settings.search_configuration ?></textarea></label><? if(settings.field_warnings.search_configuration){ ?><small class=field-warning>⚠ <?= settings.field_warnings.search_configuration ?></small><? } ?><p class=muted>Native OCR uses the OS installed recognition support. Download subtitles with the catalog yt-dlp command, then search those Workspace files.</p></div><div class=card<? if(tab!=="notifications"){ ?> hidden<? } ?>><h3>🔔 Desktop Notifications</h3><label><input id=notifySession type=checkbox<?= settings.desktop_notifications_session?" checked":"" ?>> Session notifications</label><label><input id=notifyWorkspace type=checkbox<?= settings.desktop_notifications_workspace?" checked":"" ?>> Workspace notifications</label><label><input id=notifyToolCall type=checkbox<?= settings.desktop_notifications_tool_call?" checked":"" ?>> Tool Call notifications</label><p class=muted>Notifications use the native OS integration. Session references include Workspace, creation age and Tool Call count.</p></div><div class=card<? if(tab!=="process"){ ?> hidden<? } ?>><h3>🖥️ Process Environment</h3><label><input id=inheritSystemPath type=checkbox<?= settings.inherit_system_path?" checked":"" ?>> Include the system PATH in spawned processes and commands</label><label><input id=gitPreserveLineEndings type=checkbox<?= settings.git_preserve_line_endings?" checked":"" ?>> Disable automatic Git CRLF conversion</label><p class=muted>When enabled, managed processes use <code>core.autocrlf=false</code>. An existing CRLF checkout made with <code>core.autocrlf=true</code> may then appear modified without a file edit. Turn this off to use the repository and machine Git policy. Repository <code>.gitattributes</code> and explicit <code>git -c</code> options still apply.</p><div class=row><label class=grow>Environment variables for all spawned processes · one <code>NAME=value</code> per line</label><? if(settings.field_warnings?.exec_environment){ ?><span class=field-warning>⚠ <?= settings.field_warnings.exec_environment ?></span><? } ?></div><textarea id=execEnvironment rows=8 placeholder="CACHE_DIR=\${MRMCP_DIR}&#10;TOOLS=\${MRMCP_BIN}&#10;PROJECT=\${WORKSPACE}&#10;RUN_FROM=\${CWD}"><?= settings.exec_environment||'' ?></textarea><p class=muted>Available placeholders: <code>\${MRMCP_DIR}</code> = MrMCP data directory, <code>\${MRMCP_BIN}</code> = managed bin directory, <code>\${WORKSPACE}</code> = current Workspace root, <code>\${CWD}</code> = effective exec directory. Precedence: system environment → these settings → per-call <code>env</code>. Off PATH inheritance leaves child <code>PATH</code> as only <code>.mrmcp/bin</code>; PATH remains governed by this toggle rather than the generic environment list.</p></div><div class=card<? if(tab!=="files"){ ?> hidden<? } ?>><h3>📄 Text Encoding</h3><div class=row><label class=grow for=textEncodingDetection>Automatic detection for reading and searching</label><? if(settings.field_warnings?.text_encoding_detection){ ?><span class=field-warning>⚠ <?= settings.field_warnings.text_encoding_detection ?></span><? } ?></div><select id=textEncodingDetection><option value=sample<?= (settings.text_encoding_detection||"sample")==="sample"?" selected":"" ?>>Initial 16 KiB · faster</option><option value=full<?= settings.text_encoding_detection==="full"?" selected":"" ?>>Complete file · more thorough</option></select><p class=muted>The initial sample reduces detection work on large files. If the result is uncertain or its encoding cannot decode the complete file, detection retries with the full content. A sample can miss later charset clues; choose Complete file when accuracy matters more than speed.</p><p class=muted>File edits and conversions always use the complete content. An explicitly requested encoding skips detection in both modes.</p></div><div class=card<? if(tab!=="goals"){ ?> hidden<? } ?>><h3>🎯 Chat Goals</h3><h3>ChatGPT login profile</h3><? const loginLabels={unknown:'Not initialized',opening:'Opening Chrome…',checking:'Checking login…',authenticated:'Signed in',signed_out:'Sign-in required',page_not_ready:'Waiting for page or challenge',closed:'Login window closed',error:'Login check failed'},loginStatus=settings.chat_goal_login_status||'unknown'; ?><p><b class="<?= loginStatus==='authenticated'?'ok':['signed_out','closed','error'].includes(loginStatus)?'failed':'pending' ?>"><? if(settings.chat_goal_login_busy||settings.chat_goal_login_active){ ?><span class=spinner>↻</span> <? } ?><?= loginLabels[loginStatus]||loginStatus ?></b></p><p>Goal monitoring: <b><?= !settings.chat_goals_enabled?'Disabled by your setting':settings.chat_goal_login_active?'Paused during login check':settings.chat_goal_login_verified_at?'Enabled':'Paused · login required' ?></b></p><? if(settings.chat_goal_login_verified_at){ ?><p class=muted>Login confirmed: <?= it.logdt(settings.chat_goal_login_verified_at) ?></p><? } ?><? if(settings.chat_goal_login_composer){ ?><p class=muted>Chat editor: <?= settings.chat_goal_login_composer==='ready'?'Ready':settings.chat_goal_login_composer==='response_busy'?'Response in progress':'Not ready yet' ?></p><? } ?><p class=muted>Initialize the separate Chrome profile here before using goals. Select Login ChatGPT and sign in or complete any challenge in the dedicated window. Login is detected automatically. An existing login may reload once to observe fresh recent-chat data; drafts are preserved.</p><div class=row><button data-action=open-chat-goal-login<?= settings.chat_goal_login_busy?' disabled':'' ?>><? if(settings.chat_goal_login_busy){ ?><span class=spinner>↻</span> Opening Chrome…<? } else { ?>Login ChatGPT<? } ?></button></div><? if(settings.chat_goal_login_detail){ ?><p class=muted><?= settings.chat_goal_login_detail ?></p><? } ?><p class=muted>Login setup pauses automatic goals and works even when goal management is disabled. It uses a visible window with images; a running headless/image-blocked browser may need to restart with the same profile. Close the login window after verification to apply the saved monitoring launch options. Login readiness is independent of the enable switch. Losing login during a match or send pauses goals until you use this button again. Failed matches require a new chat_set_goal after login.</p><label><input id=chatGoalsEnabled type=checkbox<?= settings.chat_goals_enabled?" checked":"" ?>> Enable chat goal management</label><p class=muted>Off stops background monitoring and browser opening. The tool remains available and returns disabled. Saved goals and the login profile are retained; enabling resumes eligible goals.</p><label><input id=chatGoalMatchOnStartup type=checkbox<?= settings.chat_goal_match_on_startup?" checked":"" ?>> Retry missing chat matches at startup</label><p class=muted>Off by default: restarting does not resume matching, even if it was queued. When enabled, each startup schedules one attempt per active goal without an associated chat. Requires goal management to be enabled and a verified login profile. Saving this option does not start a match now.</p><div class=row><label class=grow for=chatGoalTimeoutMinutes>Default inactivity timeout · minutes</label><? if(settings.field_warnings?.chat_goal_timeout_minutes){ ?><span class=field-warning>⚠ <?= settings.field_warnings.chat_goal_timeout_minutes ?></span><? } ?></div><input id=chatGoalTimeoutMinutes type=number min=1 max=1440 step=1 value="<?= settings.chat_goal_timeout_minutes??5 ?>"><p class=muted>Default: 5 minutes. Used when a new goal omits timeout_seconds; existing goals keep their own timeout.</p><label><input id=chatGoalStopBeforeSend type=checkbox<?= settings.chat_goal_stop_before_send?" checked":"" ?>> Stop the current response before sending</label><p class=muted>Off by default: send the goal even while ChatGPT is working. When enabled, press Stop first and wait briefly for it to take effect. Applies to subsequent send attempts without restarting Chrome. New Tool Calls reset the inactivity timer; an older call still running does not block the prompt.</p><h3>Browser launch</h3><label><input id=chatGoalHeadless type=checkbox<?= settings.chat_goal_headless?" checked":"" ?>> Headless · no browser window</label><label><input id=chatGoalDisableImages type=checkbox<?= settings.chat_goal_disable_images?" checked":"" ?>> Disable page images</label><p class=muted>Images load by default. Enable this option to reduce image loading during monitoring. Screenshots remain available.</p><label for=chatGoalWindowsHide>Spawned process window / console</label><select id=chatGoalWindowsHide><option value=auto<?= settings.chat_goal_windows_hide==="auto"?" selected":"" ?>>Automatic · follows headless</option><option value=hide<?= settings.chat_goal_windows_hide==="hide"?" selected":"" ?>>Always hide</option><option value=show<?= settings.chat_goal_windows_hide==="show"?" selected":"" ?>>Always show</option></select><p class=muted>Headless defaults off so you can sign in or complete a challenge. Automatic sets windowsHide equal to headless: hide when headless, show otherwise. You may override it independently. Launch changes apply after the dedicated browser is closed and started again. Its login profile is preserved.</p></div><div class=card<? if(tab!=="maintenance"){ ?> hidden<? } ?>><h3>🧹 Tool Call History</h3><label>History storage</label><select id=toolCallStorage><option value=disk<?= settings.tool_call_storage==='disk'?' selected':'' ?>>Disk · survives restart</option><option value=memory<?= settings.tool_call_storage==='memory'?' selected':'' ?>>Memory · SQLite TEMP, volatile</option></select><p class=muted>Storage and payload retention are independent. Disk writes Tool Call history to the main SQLite database. Memory uses SQLite TEMP tables in RAM with the same Tool Call ids, GUI and tools_log behavior; rows disappear on restart.</p><label>Payload retention</label><select id=toolCallPayloadMode><option value=payload<?= settings.tool_call_payload_mode==='payload'?' selected':'' ?>>Payload · canonical MCP request and response packets</option><option value=metadata<?= settings.tool_call_payload_mode==='metadata'?' selected':'' ?>>Metadata · no Tool Call request/response payload copies</option></select><p class=muted>Payload retention affects only diagnostic copies in Tool Call history. Functional state required by tools remains available in its owning subsystem; for example persistent-process command/output state is retained independently so exec_attach and exec_status keep working.</p><div class=row><label class=grow>Disk retention hours · 0 keeps indefinitely</label><? if(settings.field_warnings?.tool_call_retention_hours){ ?><span class=field-warning>⚠ <?= settings.field_warnings.tool_call_retention_hours ?></span><? } ?></div><input id=toolCallRetentionHours type=number min=0 step=1 value="<?= settings.tool_call_retention_hours??0 ?>"><div class=row><label class=grow>Memory retention minutes · 0 keeps until restart</label><? if(settings.field_warnings?.tool_call_memory_retention_minutes){ ?><span class=field-warning>⚠ <?= settings.field_warnings.tool_call_memory_retention_minutes ?></span><? } ?></div><input id=toolCallMemoryRetentionMinutes type=number min=0 step=1 value="<?= settings.tool_call_memory_retention_minutes??60 ?>"><p class=muted>Retention removes completed Tool Call history from its own storage tier. Process, CDP and other functional state are unaffected. Changing the current storage or payload setting affects new Tool Calls only; existing rows retain their own storage and payload capabilities.</p><h3>🧹 Database</h3><p class=muted>Clears Tool Calls, process/HTTP history, published snapshots and metrics. Keeps auth, Sessions, Workspaces, Memory, CDP browser state, settings, tools and Workspace files.</p><? const m=s.maintenance||{},busy=m.active&&m.action==="database"; ?><button class=danger data-action=clear-database<?= m.active?" disabled":"" ?>><? if(busy){ ?><span class=spinner>↻</span> <?= m.phase==="waiting" ? m.in_flight+" in flight · "+m.waiting+" waiting" : "Clearing · "+m.waiting+" waiting" ?><? } else { ?>🗑️ Clear Operational Data<? } ?></button></div></div></div></section>
<? } else if(section==="help"){ ?><section id=help class=page><h2>❓ Help</h2><div class=card><h3>Connect ChatGPT Web</h3><ol><li>Make sure the Dashboard shows a trusted HTTPS certificate. ChatGPT needs a remote HTTPS MCP endpoint; use <code><?= settings.external_base_url ? settings.external_base_url + "/mcp" : "https://your-host/mcp" ?></code>.</li><li>In ChatGPT Web, enable Developer mode. In managed workspaces the current path is <b>Workspace settings → Permissions &amp; Roles → Connected Data Developer mode / Create custom MCP connectors</b>. Authorized users may also find the toggle under <b>Settings → Apps → Advanced Settings</b>.</li><li>Create a custom app from <b>Workspace settings → Apps → Create</b> or <b>Settings → Apps → Create</b>, enter the MrMCP endpoint, choose the offered authentication method, then select <b>Scan Tools</b>.</li><li>If OAuth is enabled in MrMCP, complete the authorization prompt. After the tool scan completes, create the app and select it from a new ChatGPT conversation.</li></ol></div><div class=card><h3>Authentication</h3><p>For ChatGPT, OAuth is the preferred MrMCP setup because ChatGPT can discover the authorization metadata, complete consent, and keep refresh-token connectivity. MrMCP also supports Basic authentication for MCP clients that offer it. Authentication grants access to the server; the <code>chat_session</code> selects persistent context state after authentication.</p></div><div class=card><h3>Write Access</h3><p>MrMCP does not maintain a separate read/write allowlist: every authenticated client receives every published tool. ChatGPT controls whether write/modify actions are usable through the app's permissions and action controls. As of this build, OpenAI documents full MCP write/modify support for Business, Enterprise and Edu; Pro custom MCP access is limited to read/fetch, and availability may change. Test write tools in Developer mode first. Where available, use <b>Workspace settings → Apps → Configure Actions / Action control</b> to enable the required actions. ChatGPT may still ask for confirmation before a write.</p></div><div class=card><h3>Using MrMCP in a Chat</h3><ol><li>Start a new chat and select the MrMCP app from the tools/apps menu.</li><li>Call <code>init_chat_session</code> once to create a chat Session, then pass its returned <code>chat_session</code> on every subsequent tool call. Initialization selects no Workspace. Use <code>list_workspaces</code> to discover names, then <code>open_workspace</code> with the same <code>chat_session</code> and the desired <code>name</code> before working on files or starting processes.</li><li>The result already includes <code>workspace_name</code>, absolute <code>cwd</code> and <code>agent_guidance_path</code>. Read that file when non-null. Workspace changes preserve the same <code>chat_session</code>. The Workspaces page can also move Sessions manually.</li><li>If you change ChatGPT model or thinking level, the MCP context may be recreated even inside the same conversation. Check the Sessions page if continuity matters.</li></ol><p class=muted>ChatGPT UI labels and plan availability can change. Current OpenAI references: <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target=_blank rel=noopener>Developer mode and MCP apps in ChatGPT</a> · <a href="https://help.openai.com/en/articles/11487775-connectors-in-chatgpt" target=_blank rel=noopener>Apps in ChatGPT</a>.</p></div></section><? } ?>`,
    dialogs: `<? const dialog=it.data?.state?.dialog; ?><? if(dialog){ ?><div id=dialogOverlay class=dialog-overlay><? if(dialog.kind==="root"){ const r=dialog.data||{}; ?><dialog id=rootDialog open data-managed-dialog=root><form id=rootForm><input id=rid type=hidden value="<?= r.id||'' ?>"><h2>📁 Workspace</h2><div class=row><label class=grow>Workspace name</label><? if(r.name_warning){ ?><span class=field-warning>⚠ <?= r.name_warning ?></span><? } ?></div><input id=rname value="<?= r.name||'' ?>"><div class=row><label class=grow>Directory path</label><? if(r.path_warning){ ?><span class=field-warning>⚠ <?= r.path_warning ?></span><? } else if(!r.path_checked){ ?><span class=muted>Leave the field to validate the directory.</span><? } ?></div><input id=rpath placeholder="C:\\projects\\my-workspace, /srv/my-workspace or ./project" value="<?= r.path||'' ?>"><div class=muted>Relative to the program folder.</div><label><input id=renabled type=checkbox<?= r.enabled!==false?' checked':'' ?>> Enabled</label><? if(r.form_warning){ ?><div class=field-warning>⚠ <?= r.form_warning ?></div><? } ?><p class=row><button class=primary type=submit<?= (r.name_warning||r.path_warning||!r.path_checked||r.form_warning)?' disabled':'' ?>>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="command"){ const c=dialog.data||{}; ?><dialog id=commandDialog open data-managed-dialog=command><form id=commandForm><input id=coldName type=hidden value="<?= c.registered?c.name:'' ?>"><h2>🧰 Command Catalog Entry</h2><div class=row><label class=grow>Logical name</label><? if(c.name_warning){ ?><span class=field-warning>⚠ <?= c.name_warning ?></span><? } ?></div><input id=cname value="<?= c.name||'' ?>"><div class=row><label class=grow>Path below .mrmcp/bin</label><? if(c.path_warning){ ?><span class="<?= c.path_error?'field-warning':'muted' ?>"><?= c.path_error?'⚠ ':'' ?><?= c.path_warning ?></span><? } else if(!c.path_checked){ ?><span class=muted>Leave the field to validate the path.</span><? } ?></div><input id=cpath placeholder="Optional; defaults to logical name; Windows suffix optional" value="<?= c.path||'' ?>"><label>Description for the agent</label><textarea id=cdescription placeholder="Optional: what it does and when the agent should use it."><?= c.description||'' ?></textarea><div class=row><label class=grow>Download URL</label><? if(c.download_warning){ ?><span class=field-warning>⚠ <?= c.download_warning ?></span><? } ?></div><input id=cdownloadUrl placeholder="https://example.com/tool" value="<?= c.download_url||'' ?>"><label>Archive entry · optional exact path inside ZIP/TAR</label><input id=carchivePath value="<?= c.archive_path||'' ?>"><div class=row><label class=grow>Platforms · YAML mapping</label><? if(c.platforms_warning){ ?><span class=field-warning>⚠ <?= c.platforms_warning ?></span><? } ?></div><textarea id=cplatforms rows=10><?= c.platforms_text||'{}' ?></textarea><p class=muted>Keys: windows-x86_64, linux-x86_64, darwin-x86_64, darwin-aarch64, or OS names. Each variant accepts path, download_url and archive_path. Missing variants are unsupported; an empty mapping uses the shared fields.</p><div class=row><label class=grow>Documentation URL</label><? if(c.documentation_warning){ ?><span class=field-warning>⚠ <?= c.documentation_warning ?></span><? } ?></div><input id=cdocumentationUrl placeholder="https://example.com/docs" value="<?= c.documentation_url||'' ?>"><? if(c.form_warning){ ?><div class=field-warning>⚠ <?= c.form_warning ?></div><? } ?><p class=row><button class=primary type=submit<?= (c.name_warning||c.path_error||!c.path_checked||c.download_warning||c.documentation_warning||c.platforms_warning||c.form_warning)?' disabled':'' ?>>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="prompt"){ const p=dialog.data||{}; ?><dialog id=promptDialog open data-managed-dialog=prompt><form id=promptForm><input id=poldName type=hidden value="<?= p.old_name||'' ?>"><h2>🧭 Guided Prompt</h2><div class=row><label class=grow>Name</label><? if(p.name_warning){ ?><span class=field-warning>⚠ <?= p.name_warning ?></span><? } ?></div><input id=pname value="<?= p.name||'' ?>"><label>Title</label><input id=ptitle value="<?= p.title||'' ?>" placeholder="Human-readable title shown by MCP clients"><label>Description</label><textarea id=pdescription placeholder="What this guided prompt does."><?= p.description||'' ?></textarea><div class=row><label class=grow>Arguments · YAML list</label><? if(p.args_warning){ ?><span class=field-warning>⚠ <?= p.args_warning ?></span><? } ?></div><textarea id=parguments rows=8 placeholder="- name: focus&#10;  description: Area to focus on.&#10;  required: false"><?= p.arguments_text||'' ?></textarea><div class=row><label class=grow>Eta template</label><? if(p.template_warning){ ?><span class=field-warning>⚠ <?= p.template_warning ?></span><? } ?></div><textarea id=ptemplate rows=14 placeholder="Review the project. &lt;%= it.args.focus %&gt;"><?= p.template||'' ?></textarea><div class=muted>Standard Eta tags. Model documentation is available from Guided Prompts → Template Help.</div><? if(p.form_warning){ ?><div class=field-warning>⚠ <?= p.form_warning ?></div><? } ?><p class=row><button class=primary type=submit<?= (p.name_warning||p.args_warning||p.template_warning||p.form_warning)?' disabled':'' ?>>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="memory"){ const m=dialog.data||{},creating=!m.id; ?><dialog id=memoryDialog open data-managed-dialog=memory><form id=memoryForm><input id=mid type=hidden value="<?= m.id||'' ?>"><h2><?= creating?'➕ New Memory':'🧠 Memory' ?></h2><? if(creating){ ?><label>Scope</label><select id=mscope><option value=global<?= m.scope==='global'?' selected':'' ?>>Global</option><option value=session<?= m.scope==='session'?' selected':'' ?><?= !(m.sessions||[]).length?' disabled':'' ?>>Session</option><option value=workspace<?= m.scope==='workspace'?' selected':'' ?><?= !(m.workspaces||[]).length?' disabled':'' ?>>Workspace</option></select><? if(m.scope==='workspace'){ ?><label>Workspace</label><select id=mworkspace><? (m.workspaces||[]).forEach(name=>{ ?><option value="<?= name ?>"<?= String(m.workspace||'')===String(name)?' selected':'' ?>><?= name ?></option><? }) ?></select><? } else if(m.scope==='session'){ ?><label>Session</label><select id=mcontext><? (m.sessions||[]).forEach(id=>{ ?><option value="<?= id ?>"<?= String(m.context||'')===String(id)?' selected':'' ?>>#<?= id ?></option><? }) ?></select><? } else { ?><div class=muted>Shared across all Sessions and Workspaces on this MrMCP server.</div><? } ?><? } else { ?><div class=muted><?= m.scope==='global'?'Global':(m.scope==='workspace'?'Workspace':'Session') ?> · <?= m.owner_name||'' ?></div><? } ?><label>Key</label><input id=mkey value="<?= m.key||'' ?>"><label>Value</label><? if(m.json){ ?><textarea id=mvalue rows=14 hidden><?= m.value_text||'' ?></textarea><div id=memoryJsonEditor class="json-editor-host memory" data-json-source=mvalue data-json-edit=memory data-json-error=memoryJsonError></div><div id=memoryJsonError class=field-warning hidden></div><? } else { ?><textarea id=mvalue rows=14><?= m.value_text||'' ?></textarea><? } ?><label><input id=mjson type=checkbox<?= m.json?' checked':'' ?>> Value is JSON · validate before saving</label><div class=muted>Switching between TEXT and JSON keeps the current draft unchanged.</div><label>TTL seconds · 0 = permanent</label><input id=mttl type=number min=0 max=315360000 value="<?= m.ttl_seconds||0 ?>"><? if(m.form_warning){ ?><div class=field-warning>⚠ <?= m.form_warning ?></div><? } ?><p class=row><button class=primary type=submit>💾 Save</button><button type=button data-action=close-dialog>✕ Cancel</button></p></form></dialog><? } else if(dialog.kind==="confirm"){ ?><dialog id=confirmDialog open data-managed-dialog=confirm><h2>⚠️ <?= dialog.title||"Confirm Action" ?></h2><p><?= dialog.message||"Continue?" ?></p><p class=row><button class="primary danger" data-action=confirm-dialog>✓ Confirm</button><button data-action=close-dialog>✕ Cancel</button></p></dialog><? } ?></div><? } ?>`,
    status: `<? const d=it.data||{},s=d.settings||{},a=d.activity||{},bad=!!s.mcp_listen_error,warn=!!s.listener_fallback,recent=a.recent_sessions||[],inFlight=a.tool_calls_in_flight||0,errors=a.tool_calls_errors||0,invalid=a.tool_calls_invalid||0; ?><span class="status-group <?= d.live!=="connected"?(d.live==="reconnecting"?"pending":"failed"):(bad?"failed":(warn?"pending":"ok")) ?>"><?= d.live!=="connected"?(d.live==="reconnecting"?"🟡 reconnecting":"🔴 offline"):(bad?"🔴 listener error":(warn?"🟡 fallback":"🟢 live")) ?></span><span class="status-group status-link" data-action=header-settings title="HTTP / HTTPS effective listener ports; GUI uses local Tauriless assets">🔌 <span class=status-ports><?= s.mcp_http_active?s.mcp_http_port:"off" ?>/<?= s.mcp_https_active?s.mcp_https_port:"off" ?></span><? if(warn){ ?> <span class=pending>⚠</span><? } ?></span><span class=status-group title="Sessions with a Tool Call in the last <?= a.active_window_minutes||10 ?> minutes">💬 <span class="status-link <?= a.active_sessions?'ok':'muted' ?>" data-action=header-sessions><?= a.active_sessions||0 ?> active</span><? if(recent.length){ ?> · <span class=status-sessions><? recent.forEach((x,i)=>{ ?><?= i?" ":"" ?><span class=status-link data-action=session-tool-calls data-id="<?= x.id ?>">#<?= x.id ?>(<?= x.tool_calls ?>)</span><? }) ?></span><? } ?></span><span class=status-group title="Tool Calls in flight / total recorded / failed / invalid">🛠️ <span class="status-link <?= inFlight?'pending':'muted' ?>" data-action=header-tool-calls data-status=running><?= inFlight ?> in flight</span> · <span class="status-link status-total" data-action=header-tool-calls data-status=""><?= a.tool_calls_total||0 ?> total</span> · <span class="status-link <?= errors?'failed':'muted' ?>" data-action=header-tool-calls data-status=failed><?= errors ?> errors</span> · <span class="status-link <?= invalid?'invalid':'muted' ?>" data-action=header-tool-calls data-status=invalid><?= invalid ?> invalid</span></span>`,
    cards: `<? const meta={sessions:["💬","Sessions"],roots:["📁","Workspaces"],tool_calls:["🛠️","Tool Calls"],tool_calls_in_flight:["🛠️","Tool Calls In Flight"],failed_calls:["⚠️","Failed Calls"],http_requests:["🌐","HTTP Requests"]}; Object.entries(it.data || {}).forEach(([key,value]) => { const item=meta[key]||["•",key]; ?><div class=card><div class=muted><?= item[0] ?> <?= item[1] ?></div><strong style="font-size:24px"><?= value ?></strong></div><? }) ?>`,
    active_tool_calls: `<? const rows=it.data||[],icons={completed:"✅",failed:"❌",invalid:"◆",killed:"❌",timed_out:"❌",running:"⏳",received:"⏳"}; ?><div class="card active-call-card"><table class=active-call-table><thead><tr><th>State</th><th>Tool Call</th><th>Session</th><th>Time</th></tr></thead><tbody><? if(!rows.length){ ?><tr><td colspan=4 class=muted>No active Tool Calls.</td></tr><? } else { rows.forEach(l=>{ const ms=Number(l.elapsed_ms||0),elapsed=ms<1000?ms+"ms":(ms/1000).toFixed(ms<10000?1:0)+"s"; ?><tr data-action=process-tool-call title="Open Tool Call #<?= l.id ?>" data-id="<?= l.id ?>" class="<?= l.active?'':'active-call-recent' ?>"<? if(!l.active){ ?> style="--active-call-ttl:<?= Math.max(50,Number(l.ttl_ms||0)) ?>ms"<? } ?>><td class="<?= l.active?'pending':l.status ?> nowrap"><?= icons[l.status]||"•" ?> <?= l.active?"running":l.status ?></td><td class=active-call-summary><?= l.call_summary ?><? if(l.storage==='memory'){ ?> <span class=muted>· MEMORY</span><? } ?><? if(l.progress_requested){ ?> <span class=progress-requested>📡 progress</span><? } ?></td><td class=idcell><?= l.context_id?"#"+l.context_id:"—" ?></td><td class=nowrap><?= elapsed ?><? if(!l.active){ ?> <span class=muted>· done</span><? } ?></td></tr><? }) } ?></tbody></table></div>`,
    trash: `<? const d=it.data||{},rows=d.transactions||[],m=d.maintenance||{}; ?><div class=row><div class=grow><b><?= d.item_count||0 ?></b> tracked item<?= Number(d.item_count||0)===1?'':'s' ?> in <b><?= d.transaction_count||0 ?></b> transaction<?= Number(d.transaction_count||0)===1?'':'s' ?> · <b><?= it.bytes(d.cached_bytes||0) ?></b> cached<? if(d.unknown_sizes){ ?> · <span class=pending><?= d.unknown_sizes ?> unknown size<?= Number(d.unknown_sizes)===1?'':'s' ?></span><? } ?></div><button class="danger" data-action=empty-trash<?= m.active?' disabled':'' ?>>🗑️ Empty Trash</button></div><? if(!rows.length){ ?><div class=card><p class=muted>Trash metadata is empty.</p></div><? } else { rows.forEach(t=>{ ?><article class="card trash-transaction"><div class=row><div class=grow><h3 style="margin:0"><code><?= t.trash_id ?></code></h3><div class=muted><?= t.created_at?it.logdt(t.created_at):'Unknown creation time' ?> · <?= (t.items||[]).length ?> item<?= (t.items||[]).length===1?'':'s' ?> · <?= it.bytes(t.cached_bytes||0) ?> cached<? if(t.unknown_sizes){ ?> · <?= t.unknown_sizes ?> unknown<? } ?><? if(t.missing_count){ ?> · <span class=failed><?= t.missing_count ?> missing on disk</span><? } ?></div></div><? if(t.restorable){ ?><button class=small data-action=restore-trash data-id="<?= t.trash_id ?>">↩️ Restore available</button><? } ?><button class="small danger" data-action=delete-trash data-id="<?= t.trash_id ?>">🗑️ Delete transaction</button></div><table class=trash-table><thead><tr><th>Original path</th><th>Cached metadata</th><th>Disk payload</th><th>Stored payload</th><th></th></tr></thead><tbody><? (t.items||[]).forEach(x=>{ ?><tr><td><? if(x.original){ ?><code><?= x.original ?></code><? } else { ?><span class=muted>Original path unavailable</span><? } ?></td><td class=nowrap><b><?= x.type ?></b><? if(x.size_cached!==null){ ?> · <?= it.bytes(x.size_cached) ?><? } else { ?> · <span class=pending>size unknown</span><? } ?></td><td class=nowrap><? if(x.disk_present){ ?><span class=ok>✅ Present</span><? if(x.disk_type&&x.disk_type!==x.type){ ?> <span class=pending>· now <?= x.disk_type ?></span><? } ?><? } else { ?><span class=failed>❌ Missing</span><? } ?></td><td><code><?= x.payload ?></code></td><td class=nowrap><? if(x.disk_present&&x.original){ ?><button class=small data-action=restore-trash-item data-id="<?= t.trash_id ?>" data-payload="<?= x.payload ?>">↩️ Restore</button> <? } ?><button class="small danger" data-action=delete-trash-item data-id="<?= t.trash_id ?>" data-payload="<?= x.payload ?>"><?= x.disk_present?'🗑️ Delete':'🧹 Remove metadata' ?></button></td></tr><? }) ?></tbody></table></article><? }) } ?>`,
    tls: `<? const t=it.data||{}, problem=!t.tls_active_trusted||!!t.tls_last_error||!!t.mcp_listen_error; ?><div class="card <?= problem ? "tls-alert" : "tls-good" ?>"><div class=row><h3 class=grow>🔒 TLS / Let's Encrypt</h3><b class="<?= t.tls_active_trusted ? "ok" : "failed" ?>"><?= t.tls_active_trusted ? "trusted" : (t.tls_active ? "fallback active" : "offline") ?></b></div><div class=grid><div><span class=muted>HTTPS Listener</span><br><b><?= t.mcp_https_active ? "0.0.0.0:"+t.mcp_https_port+" active" : "not listening" ?></b></div><div><span class=muted>Active Certificate</span><br><b><?= t.tls_active_kind || "none" ?> · <?= t.tls_active_valid ? "valid" : "invalid" ?></b></div><div><span class=muted>Expires</span><br><b><?= it.dt(t.tls_active_expires) || "unknown" ?></b></div><div><span class=muted>Last ACME Request</span><br><b><?= it.dt(t.tls_last_request_at) || "never recorded" ?></b></div><div><span class=muted>Last ACME Result</span><br><b class="<?= t.tls_last_request_valid ? "ok" : (t.tls_last_request_status === "error" ? "failed" : "pending") ?>"><? if (t.tls_last_request_status) { ?><?= t.tls_last_request_status ?> · certificate <?= t.tls_last_request_valid ? "valid" : "not valid" ?><? } else { ?>not recorded<? } ?></b></div><div><span class=muted>Last Valid Certificate</span><br><b><?= it.dt(t.tls_last_issued_at) || "not recorded" ?></b></div><div><span class=muted>Renewal Due</span><br><b><?= it.dt(t.tls_renewal_due_at) || "as soon as allowed" ?></b></div><div><span class=muted>Rate-Limit Reset</span><br><b><?= it.dt(t.tls_rate_limit_reset_at) || "none" ?></b></div><div><span class=muted>Next ACME Attempt</span><br><b><?= it.dt(t.tls_next_attempt_at) || "not scheduled" ?></b></div></div><? if (t.tls_last_error || t.mcp_listen_error) { ?><pre class=tls-error><?= t.tls_last_error || t.mcp_listen_error ?></pre><? } ?><? if (!t.tls_active_trusted) { ?><p class=failed><b>Public clients such as ChatGPT will reject the self-signed fallback until Let's Encrypt succeeds.</b></p><? } ?></div>`,
    urls: `<? (it.data || []).forEach(x => { if (!x?.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?><? if (x.note) { ?> <span class=muted><?= x.note ?></span><? } ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?>`,
    roots: `<? const d=it.data||{},rows=d.roots||[],defaults=d.default_sessions||[]; ?><div class=roots-layout><div class=roots-named><h3>📁 Workspaces</h3><? if(!rows.length){ ?><div class=card><p class=muted>No Workspaces registered.</p></div><? } ?><? rows.forEach(r => { ?><div class="card root-card<?= r.enabled?'':' root-disabled' ?>"<? if(r.enabled){ ?> data-root-drop="<?= r.id ?>"<? } ?>><div class=root-card-header><div class=grow><h3>📁 <?= r.name ?></h3><code class="<?= r.path_warning?'failed':'' ?>"<? if(r.path_warning){ ?> title="<?= r.path_warning ?>"<? } ?>><?= r.path ?></code></div><div class=command-actions><button class=small data-action=edit-root data-id="<?= r.id ?>">✏️ Edit</button><button class="small danger" data-action=delete-root data-id="<?= r.id ?>">🗑️ Delete</button></div></div><div class="<?= r.enabled?'ok':'muted' ?>"><?= r.enabled ? "enabled" : "disabled" ?></div><div class=root-session-list><? if(!r.enabled){ ?><div class=muted>Enable this Workspace to assign Sessions.</div><? } else if(!(r.sessions||[]).length){ ?><div class=root-drop-empty>Drop a Session here</div><? } ?><? (r.sessions||[]).forEach(v=>{ ?><div class=session-chip draggable=true data-session-drag data-session-id="<?= v.pk ?>" title="Drag Session #<?= v.pk ?>"><div class=session-chip-main><span>💬</span><b>#<?= v.pk ?></b><span class=grow><?= v.client_name ?></span></div><div class=session-chip-meta><span><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></span><span><span class=muted>Last Activity</span> <?= it.logdt(v.last_active_at) ?></span><span><span class=muted>Status</span> <span class="<?= v.expired?'failed':'ok' ?>"><?= v.expired?'expired':'active' ?></span></span><span><span class=muted>Tool Calls:</span> <?= v.tool_calls||0 ?></span></div></div><? }) ?></div></div><? }) ?></div><div class=roots-default><div class=row><h3 class=grow>💬 Sessions</h3><span class=muted>No Workspace assigned</span></div><div class="card default-root-card" data-root-drop="0"><p class=muted>Open a Workspace before file operations or starting processes.</p><div class=root-session-list><? if(!defaults.length){ ?><div class=root-drop-empty>Drop a Session here to remove its Workspace association.</div><? } ?><? defaults.forEach(v=>{ ?><div class=session-chip draggable=true data-session-drag data-session-id="<?= v.pk ?>" title="Drag Session #<?= v.pk ?>"><div class=session-chip-main><span>💬</span><b>#<?= v.pk ?></b><span class=grow><?= v.client_name ?></span></div><div class=session-chip-meta><span><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></span><span><span class=muted>Last Activity</span> <?= it.logdt(v.last_active_at) ?></span><span><span class=muted>Status</span> <span class="<?= v.expired?'failed':'ok' ?>"><?= v.expired?'expired':'active' ?></span></span><span><span class=muted>Tool Calls:</span> <?= v.tool_calls||0 ?></span></div></div><? }) ?></div></div></div></div>`,
    context: `<? const d=it.data||{},values=d.values||[]; ?><? if (!values.length) { ?><p class=muted>No Sessions have been issued yet.</p><? } else { ?><table><tr><th>ID</th><th>Session Handle</th><th>Client / Auth</th><th>State / Protocol</th><th>Current Workspace</th><th>Activity</th><th>Tool Calls</th><th></th></tr><? values.forEach(v=>{ const ua=String(v.user_agent||""); ?><tr><td class=idcell>#<?= v.pk ?></td><td class=context-id><code><?= v.chat_session ?></code><? if(v.goal_text||v.chatgpt_chat_id){ ?><div><b>Goal: <?= v.goal_status ?></b><? if(v.goal_text){ ?><div title="<?= v.goal_text ?>"><?= v.goal_text.slice(0,120) ?><?= v.goal_text.length>120?"…":"" ?></div><div class=muted>Idle: <?= v.goal_timeout_seconds ?> s<? if(v.goal_next_check_at){ ?> · Check: <?= it.logdt(v.goal_next_check_at) ?><? } ?></div><button class="small danger" data-action=stop-chat-goal data-id="<?= v.pk ?>">Stop goal</button><? } ?> <button class=small data-action=open-chat-goal data-id="<?= v.pk ?>">Login settings</button><? if(v.chatgpt_chat_id){ ?><div class=muted>Chat: <code><?= v.chatgpt_chat_id ?></code></div><? } ?><? if(v.goal_last_sent_at){ ?><div class=muted>Last sent: <?= it.logdt(v.goal_last_sent_at) ?></div><? } ?><? if(v.goal_error){ ?><div class=failed><?= v.goal_error ?></div><? } ?></div><? } ?></td><td><b><?= v.client_name||"Unknown client" ?></b><br><span class=muted><?= v.auth_kind||"unknown auth" ?></span><? if(ua){ ?><div class=muted title="<?= ua ?>"><?= ua.slice(0,72) ?><?= ua.length>72?"…":"" ?></div><? } ?></td><td class=nowrap><b class="<?= v.expired ? 'failed' : 'ok' ?>"><?= v.expired ? "⌛ expired" : "🟢 active" ?></b><br><code><?= v.protocol_version||"unknown" ?></code></td><td><b><?= v.workspace_name ?></b><div class="<?= v.workspace_warning?'failed':'muted' ?>"<? if(v.workspace_warning){ ?> title="<?= v.workspace_warning ?>"<? } ?>><?= v.workspace_path ?></div></td><td class=context-dates><div><span class=muted>Created</span> <?= it.logdt(v.created_at) ?></div><div><span class=muted>Updated</span> <?= it.logdt(v.updated_at) ?></div><div><span class=muted>Active</span> <?= it.logdt(v.last_active_at) ?></div><div><span class=muted>Expires</span> <?= it.logdt(v.expires_at) ?></div></td><td class=nowrap><?= v.tool_calls||0 ?> <button class=small data-action=session-tool-calls data-id="<?= v.pk ?>">🛠️ View Calls</button></td><td><button class=danger data-action=delete-context data-id="<?= v.pk ?>">🗑️ Delete</button></td></tr><? }) ?></table><? } ?>`,
    commands: `<? const d=it.data || {}, rows=d.commands || []; ?><div class=muted><?= d.total || 0 ?> command<?= d.total === 1 ? "" : "s" ?> · page <?= d.page || 1 ?>/<?= d.pages || 1 ?> · config <code><?= d.config_file || "" ?></code></div><table class=commands-table><tr><th>Name</th><th>Relative path</th><th class=command-description>Description</th><th>Links</th><th>Source</th><th>State</th><th class=command-action-cell></th></tr><? rows.forEach(c => { ?><tr><td><code><?= c.name ?></code></td><td><code><?= c.path ?></code></td><td class=command-description><?= c.description || "—" ?></td><td><? if (c.documentation_url) { ?><a href="<?= c.documentation_url ?>" target=_blank rel=noopener>📖 Docs</a><? } else { ?>—<? } ?></td><td><?= c.source ?></td><td class="<?= c.present && c.executable ? "ok" : "failed" ?>"><?= c.supported===false ? "— unsupported platform" : c.present ? (c.executable ? "✅ available" : "⚠️ not executable") : "❌ missing" ?></td><td class=command-action-cell><div class=command-actions><button data-action=edit-command data-name="<?= c.name ?>" data-path="<?= c.path ?>">✏️ Edit</button><? if (c.registered && c.supported!==false && c.download_url) { ?><button data-action=download-command data-name="<?= c.name ?>">⬇️ Download</button><? } ?><? if (c.registered) { ?><button class=danger data-action=delete-command data-name="<?= c.name ?>">🗑️ Delete</button><? } ?></div></td></tr><? }) ?></table><div class=row><button data-action=commands-prev<?= d.page <= 1 ? " disabled" : "" ?>>Previous</button><button data-action=commands-next<?= d.has_more ? "" : " disabled" ?>>Next</button></div>`,
    prompts: `<? const d=it.data||{},rows=d.prompts||[]; ?><div class=muted><?= d.total||0 ?> prompt<?= d.total===1?'':'s' ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?> · config <code><?= d.config_file||'' ?></code></div><? if(!rows.length){ ?><div class=card><p class=muted>No guided prompts match the current search.</p></div><? } else { ?><table class=commands-table><tr><th>Name</th><th>Title</th><th class=command-description>Description</th><th>Arguments</th><th class=command-action-cell></th></tr><? rows.forEach(p=>{ ?><tr><td><code><?= p.name ?></code></td><td><?= p.title||'—' ?></td><td class=command-description><?= p.description||'—' ?></td><td><? if(p.arguments?.length){ p.arguments.forEach(a=>{ ?><div><code><?= a.name ?></code><? if(a.required){ ?> <b>required</b><? } ?></div><? }) } else { ?>—<? } ?></td><td class=command-action-cell><div class=command-actions><button data-action=edit-prompt data-name="<?= p.name ?>">✏️ Edit</button><button class=danger data-action=delete-prompt data-name="<?= p.name ?>">🗑️ Delete</button></div></td></tr><? }) ?></table><? } ?><div class=row><button data-action=prompts-prev<?= d.page<=1?' disabled':'' ?>>Previous</button><button data-action=prompts-next<?= d.has_more?'':' disabled' ?>>Next</button></div>`,
    oauth: `<table class=oauth-table><tr><th>Client</th><th>Sessions</th><th>Tokens</th><th></th></tr><? (it.data || []).forEach(c => { ?><tr><td class=oauth-client><b><?= c.name ?></b><div class=oauth-client-id title="<?= c.client_id ?>"><code><?= c.client_id ?></code></div><div class=oauth-meta><span class=muted>Created</span> <?= it.logdt(c.created_at) ?></div></td><td class=oauth-meta><div class=oauth-count><b><?= c.session_count||0 ?></b> total</div><div><span class=muted>First</span> <?= c.first_session_at ? it.logdt(c.first_session_at) : "—" ?></div><div><span class=muted>Last</span> <?= c.last_session_at ? it.logdt(c.last_session_at) : "—" ?></div></td><td><div class=oauth-tokens><div class=oauth-token><b><?= c.token_count||0 ?></b> <span>Access</span><div class=oauth-meta><span class=muted>Issued</span> <?= c.last_token_at ? it.logdt(c.last_token_at) : "—" ?></div></div><div class=oauth-token><b><?= c.refresh_token_count||0 ?></b> <span>Refresh</span><div class=oauth-meta><span class=muted>Used</span> <?= c.last_refresh_at ? it.logdt(c.last_refresh_at) : "—" ?></div></div></div></td><td class=oauth-actions><button class=small data-action=oauth-sessions data-id="<?= c.client_id ?>">💬 View Sessions</button><button class="small danger" data-action=revoke-client data-id="<?= c.client_id ?>">🚫 Revoke</button></td></tr><? }) ?></table>`,
    endpoints: `<? const server=it.data||{}; ?><div class=card><div class=row><div class=grow><h3 style="margin:0">🌐 MrMCP <code>/mcp</code></h3><div class=muted>Protocols: <?= (server.protocol_versions||[]).join(", ") ?></div></div><button data-action=self-test>🧪 Self-test</button></div><? it.endpointRows(server).forEach(x => { if (!x.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?></code><button class=small data-copy="<?= x.url ?>">📋 Copy</button></div><? }) ?><details><summary><?= server.tool_count||0 ?> Available Tools</summary><p class=muted><?= (server.tool_names||[]).join(", ") ?></p></details></div>`,
    processes: `<? const d=it.data||{},rows=d.rows||[]; ?><? if(!rows.length){ ?><div class=card><p class=muted>No active processes.</p></div><? } else { rows.forEach(p=>{ ?><article class=card><div class=row><div class=grow><b><? if(p.persistent){ ?>exec #<?= p.exec_id ?><? } else { ?>foreground exec<? } ?></b><? if(p.pid!=null){ ?> <span class=muted>· PID <?= p.pid ?></span><? } ?><? if(p.attached){ ?> <span class=progress-requested>· attached</span><? } ?></div><span class="<?= p.status ?>"><?= p.status ?></span><button class=small data-action=terminate-process data-id="<?= p.process_id ?>">⏹️ Terminate</button><button class="small danger" data-action=kill-process data-id="<?= p.process_id ?>">⚠️ Kill</button></div><div class=terminal-command><span class=prompt>&gt;</span><span><?= p.command ?></span></div><div class=terminal-cwd>cwd <code><?= p.cwd ?></code><? if(p.chat_session){ ?> · Session <code><?= p.chat_session ?></code><? } ?></div><div class=row><span class=muted>Started <?= it.logdt(Date.parse(p.started_at)) ?></span><span class=muted>· stdin <?= p.stdin_open?"open":"closed" ?></span><? if(p.progress_requested){ ?><span class=progress-requested>· progress requested</span><? } ?></div><div class=terminal-stream-label>Live output tail</div><pre><?= p.output||"(no output yet)" ?></pre></article><? }) } ?>`,
    logs: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1),statusIcons={completed:"✅",failed:"❌",invalid:"◆",running:"⏳",received:"📥"}; ?><div id=tool-call-pagination class="row log-pagination"><span class="muted grow"><?= d.total||0 ?> call<?= d.total===1?"":"s" ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Tool Call Pages"><button class=page-button data-action=logs-page data-log-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?" disabled":"" ?> aria-label="Previous page">‹</button><? items.forEach(item=>{ if(item==="…"){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?" active":"" ?>" data-action=logs-page data-log-page="<?= item ?>"<?= item===(d.page||1)?" aria-current=page":"" ?>><?= item ?></button><? } }) ?><button class=page-button data-action=logs-page data-log-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?" disabled":"" ?> aria-label="Next page">›</button></nav></div><table id=tool-call-table><thead><tr><th>ID</th><th>Time</th><th>Session</th><th>Tool</th><th>Status</th><th>Duration</th><th>Actions</th></tr></thead><tbody><? rows.forEach(l => { ?><tr id="tool-call-row-<?= l.id ?>" data-action=select-log data-id="<?= l.id ?>" title="Open Tool Call details"><td class=idcell>#<?= l.id ?></td><td class=nowrap><?= it.logdt(l.started_at) ?></td><td class=http-session><? if(l.context_id){ ?><div class=idcell>#<?= l.context_id ?></div><? if(l.root_id&&l.root_name){ ?><div class=workspace-label>📁 <?= l.root_name ?></div><? } ?><? } else { ?>—<? } ?></td><td><code><?= l.tool ?></code><? if(l.payload_mode&&l.payload_mode!=='payload'){ ?> <span class="descriptor-status <?= l.payload_mode==='metadata'?'outdated':'current' ?>"><?= String(l.payload_mode).toUpperCase() ?></span><? } ?><? if(l.call_preview){ ?><div class=tool-command-preview>↳ <?= l.call_preview ?></div><? } ?><? if(l.progress_requested){ ?><div class=progress-requested>📡 Progress requested</div><? } ?></td><td class="<?= l.status ?>"><?= statusIcons[l.status]||"•" ?> <?= l.status ?></td><td><?= l.duration_ms ?? "" ?><? if (l.duration_ms != null) { ?>ms<? } ?></td><td class=nowrap><? if(l.killable){ ?><button class=small data-action=terminate-log data-id="<?= l.id ?>">⏹️ Terminate</button> <button class="small danger" data-action=kill-log data-id="<?= l.id ?>">⚠️ Kill</button><? } else { ?>—<? } ?></td></tr><? }) ?></tbody></table><? if(d.openDetail&&d.openRowId){ const x=d.openDetail,l=rows.find(row=>String(row.id)===String(d.openRowId))||{id:d.openRowId},terminal=it.terminal(x); ?><div id="tool-call-detail-<?= l.id ?>" class=tool-detail-overlay data-detail-kind=tool data-detail-id="<?= l.id ?>"><div class="detail-panel tool-detail-screen"><div class="row tool-detail-screen-head"><b class=grow>Tool Call #<?= l.id ?></b><span class="descriptor-status <?= x.payload_mode==='metadata'?'outdated':'current' ?>"><?= String(x.payload_mode||'payload').toUpperCase() ?></span><? if(x.progress_requested){ ?><span class=progress-requested>📡 Progress requested</span><? } ?><? if(x.payload_mode==='payload'&&x.tool==='desktop_auto'){ ?><button class=small data-action=replay-automation data-id="<?= l.id ?>">▶ Replay</button><? } else if(x.payload_mode==='payload'&&x.tool==='cdp_call'){ ?><button class=small data-action=replay-cdp data-id="<?= l.id ?>">▶ Replay batch</button><? } ?><button class=small data-action=copy-detail data-target="tool-full-<?= l.id ?>">📋 Copy Full Row</button><button class=small data-action=close-row-detail data-kind=tool>✕ Close</button></div><pre id="tool-full-<?= l.id ?>" hidden><?= it.pretty(x) ?></pre><div class=tool-detail-grid><div class=tool-detail-main><? if(terminal){ ?><section id="tool-terminal-<?= l.id ?>" class=terminal-detail><div class="row terminal-title"><b class=grow>🖥️ Terminal</b><span class=muted><?= terminal.status ?><? if(terminal.termination_source){ ?> · <?= terminal.termination_source ?><? } ?><? if(terminal.requested_signal||terminal.signal){ ?> · <?= terminal.requested_signal&&terminal.signal&&terminal.requested_signal!==terminal.signal ? terminal.requested_signal+"→"+terminal.signal : (terminal.signal||terminal.requested_signal) ?><? } ?><? if(terminal.exit_code!==null){ ?> · exit <?= terminal.exit_code ?><? } ?></span></div><? if(terminal.command){ ?><div class=terminal-command><span class=prompt>&gt;</span><span><?= terminal.command ?></span></div><? } ?><? if(terminal.cwd){ ?><div class=terminal-cwd>cwd <code><?= terminal.cwd ?></code></div><? } ?><? if(terminal.stdin!==null){ ?><div class=terminal-stream-label>Stdin<?= terminal.stdin_encoding==="base64" ? " · base64" : "" ?></div><pre class=terminal-stdin><?= terminal.stdin ?></pre><? } ?><div class=terminal-stream-label>Output</div><pre><?= terminal.output || "(empty)" ?></pre></section><? } ?><? if(x.payload_mode==='metadata'){ ?><section class=json-detail><b>Payload</b><p class=muted>MCP request/response packets were not retained for this Tool Call. Metadata and the historical tool descriptor remain available.</p></section><? } else { ?><section class="json-detail debug-packet"><div class=row><b class=grow>→ MCP Request</b><span class=muted>canonical stored packet · decoded only for this view</span><button class=small data-action=copy-detail data-target="tool-request-<?= l.id ?>">📋 Copy Raw JSON</button></div><pre id="tool-request-<?= l.id ?>" hidden><?= x.mcp_request_json||'' ?></pre><?~ it.debugPayload(x.mcp_request_json) ?></section><section class="json-detail debug-packet"><div class=row><b class=grow>← MCP Response</b><span class=muted>canonical stored packet · decoded only for this view</span><button class=small data-action=copy-detail data-target="tool-response-<?= l.id ?>">📋 Copy Raw JSON</button></div><pre id="tool-response-<?= l.id ?>" hidden><?= x.mcp_response_json||'' ?></pre><?~ it.debugPayload(x.mcp_response_json) ?></section><? } ?><? if(x.error){ ?><section class=json-detail><b>Error metadata</b><pre><?= x.error ?></pre></section><? } ?></div><aside class=tool-descriptor><div class=row><b class=grow>Agent Tool Definition</b><? if(x.tool_descriptor){ ?><span class="descriptor-status <?= x.tool_descriptor_matches_current?'current':'outdated' ?>"><?= x.tool_descriptor_matches_current?'CURRENT':'OUTDATED' ?></span><button class=small data-action=copy-detail data-target="tool-descriptor-<?= l.id ?>">📋 Copy JSON</button><? } ?></div><? if(x.tool_descriptor){ ?><pre id="tool-descriptor-<?= l.id ?>" hidden><?= it.pretty(x.tool_descriptor) ?></pre><? if(x.tool_descriptor.title){ ?><div class=muted>Title</div><div><?= x.tool_descriptor.title ?></div><? } ?><div class=muted>Description</div><p><?= x.tool_descriptor.description||"—" ?></p><div class=muted>Input Schema</div><pre id="tool-descriptor-input-<?= l.id ?>" class=json-editor-source hidden><?= it.pretty(x.tool_descriptor.inputSchema||{}) ?></pre><div class="json-editor-host compact" data-json-source="tool-descriptor-input-<?= l.id ?>"></div><div class=muted>Output Schema</div><pre id="tool-descriptor-output-<?= l.id ?>" class=json-editor-source hidden><?= it.pretty(x.tool_descriptor.outputSchema||{}) ?></pre><div class="json-editor-host compact" data-json-source="tool-descriptor-output-<?= l.id ?>"></div><? } else { ?><p class=muted>No descriptor snapshot was recorded for this call.</p><? } ?></aside></div></div></div><? } ?>`,
    browser: `<? const d=it.data||{},ops=d.operations||[],ring=d.ring||[],cards=d.browsers||[],clicks=ops.filter(x=>x.method==='_.click').length,finds=ops.filter(x=>x.method==='_.find').length; ?><div class=row><select id=browserName><option value="">All browsers</option><? (d.browser_values||[]).forEach(name=>{ ?><option value="<?= name ?>"<?= d.browser===name?' selected':'' ?>><?= name ?></option><? }) ?></select><select id=browserTarget><option value="">All targets</option><? (d.target_values||[]).forEach(name=>{ ?><option value="<?= name ?>"<?= d.target===name?' selected':'' ?>><?= name ?></option><? }) ?></select><select id=browserContext><option value="">All sessions</option><? (d.sessions||[]).forEach(id=>{ ?><option value="<?= id ?>"<?= String(d.context||'')===String(id)?' selected':'' ?>>#<?= id ?></option><? }) ?></select><select id=browserActive><option value="">Any connection state</option><option value=active<?= d.active==='active'?' selected':'' ?>>Active / connected</option><option value=inactive<?= d.active==='inactive'?' selected':'' ?>>Inactive / disconnected</option></select><button data-action=clear-browser-filters>🧹 Clear Filters</button></div><div class=grid><div class=card><div class=muted>Browser profiles</div><strong style="font-size:24px"><?= cards.length ?><?= Number(d.browser_total||0)>cards.length?'/'+d.browser_total:'' ?></strong></div><div class=card><div class=muted>Payload-retained cdp_call Tool Calls</div><strong style="font-size:24px"><?= d.tool_calls_total||0 ?></strong></div><div class=card><div class=muted>Visible operations</div><strong style="font-size:24px"><?= ops.length ?><?= d.operation_has_more?'+':'' ?></strong><div class=muted><?= clicks ?> click · <?= finds ?> find</div></div><div class=card><div class=muted>Retained CDP messages</div><strong style="font-size:24px"><?= ring.length ?></strong><div class=muted>after current filters</div></div></div><? if(!cards.length){ ?><div class=card><p class=muted>No browser profiles match the current filters.</p></div><? } else { ?><div class=grid><? cards.forEach(b=>{ ?><article class=card><div class=row><h3 class=grow style="margin:0"><code><?= b.browser ?></code></h3><b class="<?= b.active?'ok':'muted' ?>"><?= b.active?'🟢 connected':'⚪ disconnected' ?></b></div><div class=grid><div><span class=muted>Port</span><br><b><?= b.port||'—' ?></b></div><div><span class=muted>Logical targets</span><br><b><?= b.logical_target_count ?></b></div><div><span class=muted>Live CDP targets</span><br><b><?= b.live_target_count ?></b></div><div><span class=muted>Subscriptions</span><br><b><?= b.subscription_count ?></b></div><div><span class=muted>Ring</span><br><b><?= b.ring_count ?></b> · <?= it.bytes(b.ring_bytes) ?></div><div><span class=muted>Recorded sequence</span><br><b><?= b.recorded_sequence ?></b></div><div><span class=muted>Retained seq range</span><br><b><?= b.oldest_seq==null?'—':b.oldest_seq+'–'+b.newest_seq ?></b></div><div><span class=muted>Notifications / responses</span><br><b><?= b.notifications ?> / <?= b.responses ?></b></div><div><span class=muted>Stream resets</span><br><b class="<?= b.stream_resets?'pending':'muted' ?>"><?= b.stream_resets ?></b></div><div><span class=muted>Dropped</span><br><b class="<?= b.dropped?'failed':'muted' ?>"><?= b.dropped ?></b></div></div><div class=muted style="margin-top:8px"><? if(b.connection_mode==="websocket"){ ?>Direct WebSocket<? } else if(b.connection_mode==="http"){ ?>HTTP discovery<? } else if(b.connection_mode==="port"){ ?>Debugging port · <code><?= b.host ?>:<?= b.port ?></code><? } else { ?><?= b.headless?"Headless":"Visible" ?> · Profile <code><?= b.user_data_dir ?></code><? } ?><? if(b.connection_id){ ?> · connection <code><?= b.connection_id ?></code><? } ?><? if(b.pending){ ?> · <?= b.pending ?> pending<? } ?></div><? if((b.session_ids||[]).length){ ?><div class=muted>Recorded origins: <? b.session_ids.forEach((id,i)=>{ ?><?= i?', ':'' ?><span class=idcell>#<?= id ?></span><? }) ?></div><? } ?><? if((b.targets||[]).length){ ?><details><summary>Logical targets (<?= b.targets.length ?>)</summary><table><tr><th>Label</th><th>Target ID</th><th>Updated</th></tr><? b.targets.forEach(t=>{ ?><tr><td><code><?= t.target ?></code></td><td><code><?= t.target_id ?></code></td><td><?= it.logdt(t.updated_at) ?></td></tr><? }) ?></table></details><? } ?><? if((b.live_targets||[]).length){ ?><details><summary>Live CDP targets (<?= b.live_targets.length ?>)</summary><table><tr><th>Label</th><th>Type</th><th>Title / URL</th><th>Target / Session</th></tr><? b.live_targets.forEach(t=>{ ?><tr><td><? if(t.label){ ?><code><?= t.label ?></code><? } else { ?>—<? } ?></td><td><code><?= t.type||'—' ?></code></td><td><? if(t.title){ ?><div><?= t.title ?></div><? } ?><code><?= t.url||'—' ?></code></td><td><code><?= t.target_id||'—' ?></code><? if(t.session_id){ ?><div class=muted>session <code><?= t.session_id ?></code></div><? } ?></td></tr><? }) ?></table></details><? } ?><? if((b.subscriptions||[]).length){ const sid='browser-subs-'+b.browser.replace(/[^A-Za-z0-9_-]/g,'_'); ?><details><summary>Subscriptions (<?= b.subscriptions.length ?>)</summary><pre id="<?= sid ?>" class=json-editor-source hidden><?= it.pretty(b.subscriptions) ?></pre><div class="json-editor-host compact" data-json-source="<?= sid ?>"></div></details><? } ?></article><? }) ?></div><? } ?><div class=row><h3 class=grow>→ Recorded CDP sends</h3><span class=muted>scanned <?= d.operation_scan_calls||0 ?> of up to <?= d.operation_scan_limit||500 ?> recent Payload-retained cdp_call Tool Calls · stops after 200 matching operations</span></div><? if(!ops.length){ ?><div class=card><p class=muted>No recorded operations match the current filters.</p></div><? } else { ?><table><thead><tr><th>Time</th><th>Session</th><th>Browser / Target</th><th>Operation</th><th>State</th><th></th></tr></thead><tbody><? ops.forEach(o=>{ const jid='browser-call-'+o.log_id+'-'+o.call_index,rid=jid+'-response'; ?><tr><td class=nowrap><?= it.logdt(o.started_at) ?></td><td><? if(o.context_id){ ?><span class=idcell>#<?= o.context_id ?></span><? if(o.root_name){ ?><div class=workspace-label>📁 <?= o.root_name ?></div><? } ?><? } else { ?>—<? } ?></td><td><code><?= o.browser ?></code><div class=muted><?= o.target?('target '+o.target):'browser-level' ?></div></td><td><b><?= o.method||'unknown' ?></b><div class=muted>Tool Call #<?= o.log_id ?> · item <?= o.call_index+1 ?> · wait <?= o.wait?'true':'false' ?><? if(o.duration_ms!=null){ ?> · <?= o.duration_ms ?>ms<? } ?></div><? if((o.images||[]).length){ ?><div class=tool-content-grid><? o.images.forEach(c=>{ ?><img class=tool-content-preview src="<?= c.data_url ?>" alt="CDP screenshot preview"><? }) ?></div><? } ?><details><summary>Request JSON</summary><pre id="<?= jid ?>" class=json-editor-source hidden><?= it.pretty(o.call) ?></pre><div class="json-editor-host compact" data-json-source="<?= jid ?>"></div></details><? if(o.response){ ?><details><summary>Response JSON</summary><pre id="<?= rid ?>" class=json-editor-source hidden><?= it.pretty(o.response) ?></pre><div class="json-editor-host compact" data-json-source="<?= rid ?>"></div></details><? } ?></td><td><? if(o.success===true){ ?><div class=ok>success</div><? } else if(o.success===false){ ?><div class=failed>failed</div><? } else { ?><div class="<?= o.status ?>"><?= o.status ?></div><? } ?><div class=muted>Tool Call <?= o.status ?></div><div class="<?= o.active?'ok':'muted' ?>"><?= o.active?'browser connected':'browser disconnected' ?></div></td><td><button class=small data-action=replay-cdp data-id="<?= o.log_id ?>" data-index="<?= o.call_index ?>">▶ Replay</button></td></tr><? }) ?></tbody></table><? } ?><div class=row><h3 class=grow>← Retained CDP traffic</h3><span class=muted>existing bounded ring only; notifications appear only when retained by a live subscription · Session filter narrows relevant browsers, because ring events themselves are global</span></div><? if(!ring.length){ ?><div class=card><p class=muted>No retained CDP messages match the current browser/target filters.</p></div><? } else { ?><table><thead><tr><th>Seq</th><th>Browser / Target</th><th>Type</th><th>Method</th><th>Bytes</th><th>Payload</th></tr></thead><tbody><? ring.forEach((m,i)=>{ const jid='browser-ring-'+i; ?><tr><td class=idcell>#<?= m.seq ?></td><td><code><?= m.browser ?></code><div class=muted><?= m.target||'browser-level' ?></div></td><td><?= m.type ?></td><td><code><?= m.method||'—' ?></code></td><td><?= it.bytes(m.bytes) ?></td><td><details><summary>JSON</summary><pre id="<?= jid ?>" class=json-editor-source hidden><?= it.pretty(m) ?></pre><div class="json-editor-host compact" data-json-source="<?= jid ?>"></div></details></td></tr><? }) ?></tbody></table><? } ?>`,
    automation: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1); ?><div class=row><select id=automationContext><option value="">All sessions</option><? (d.sessions||[]).forEach(id=>{ ?><option value="<?= id ?>"<?= String(d.context||'')===String(id)?' selected':'' ?>>#<?= id ?></option><? }) ?></select><button data-action=clear-automation-filters>🧹 Clear Filters</button><span class="muted grow"><?= d.total||0 ?> Payload-retained desktop_auto Tool Call<?= Number(d.total||0)===1?'':'s' ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Automation Pages"><button class=page-button data-action=automation-page data-automation-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?' disabled':'' ?>>‹</button><? items.forEach(item=>{ if(item==='…'){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?' active':'' ?>" data-action=automation-page data-automation-page="<?= item ?>"<?= item===(d.page||1)?' aria-current=page':'' ?>><?= item ?></button><? } }) ?><button class=page-button data-action=automation-page data-automation-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?' disabled':'' ?>>›</button></nav></div><? if(!rows.length){ ?><div class=card><p class=muted>No automation runs match the current Session filter.</p></div><? } else { rows.forEach(r=>{ const scenarioId='automation-scenario-'+r.id,resultId='automation-result-'+r.id; ?><article class=card><div class=row><div class=grow><h3 style="margin:0">🖱️ Automation #<?= r.id ?></h3><div class=muted><?= it.logdt(r.started_at) ?> · <? if(r.context_id){ ?>Session #<?= r.context_id ?><? } else { ?>No Session<? } ?><? if(r.root_name){ ?> · 📁 <?= r.root_name ?><? } ?> · <?= r.duration_ms==null?'in flight':r.duration_ms+'ms' ?></div></div><b class="<?= r.status ?>"><?= r.status ?></b><button class=small data-action=replay-automation data-id="<?= r.id ?>">▶ Replay scenario</button></div><div class=grid><div><span class=muted>Engine results</span><br><b><?= r.results_count ?></b></div><div><span class=muted>Retained images</span><br><b><?= (r.images||[]).length ?></b></div><div><span class=muted>Retained binary items</span><br><b><?= (r.contents||[]).length ?></b></div></div><? if((r.actions||[]).length){ ?><details><summary>Scenario actions (<?= r.actions.length ?>)</summary><table><thead><tr><th>#</th><th>Action</th><th>Parameters</th></tr></thead><tbody><? r.actions.forEach(a=>{ ?><tr><td class=idcell>#<?= a.index ?></td><td><code><?= a.action ?></code></td><td><pre style="margin:0;white-space:pre-wrap"><?= it.pretty(a.params) ?></pre></td></tr><? }) ?></tbody></table></details><? } ?><? if((r.images||[]).length){ ?><div class=tool-content-grid><? r.images.forEach(c=>{ ?><article class=tool-content-card><div class=row><b class=grow><?= c.direction==='input'?'→ Input':'← Output' ?></b><span class=muted><?= it.bytes(c.bytes) ?></span></div><div class=tool-content-path><?= c.json_path ?></div><img class=tool-content-preview src="<?= c.data_url ?>" alt="Automation screenshot"></article><? }) ?></div><? } ?><details><summary>YAML scenario</summary><pre><?= r.yaml||'(empty)' ?></pre></details><? if(r.scenario!==null){ ?><details><summary>Parsed scenario</summary><pre id="<?= scenarioId ?>" class=json-editor-source hidden><?= it.pretty(r.scenario) ?></pre><div class=json-editor-host data-json-source="<?= scenarioId ?>"></div></details><? } else if(r.scenario_error){ ?><div class=failed><?= r.scenario_error ?></div><? } ?><details><summary>Returned state / results</summary><pre id="<?= resultId ?>" class=json-editor-source hidden><?= it.pretty(r.result||{}) ?></pre><div class=json-editor-host data-json-source="<?= resultId ?>"></div></details><? if((r.contents||[]).some(c=>!c.data_url)){ ?><details><summary>Other retained binary content</summary><? r.contents.filter(c=>!c.data_url).forEach(c=>{ ?><div><code><?= c.mime_type ?></code> · <?= it.bytes(c.bytes) ?> · <?= c.direction ?> · <code><?= c.json_path ?></code></div><? }) ?></details><? } ?><? if(r.error){ ?><pre class=failed><?= r.error ?></pre><? } ?></article><? }) } ?>`,
    published: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1); ?><div class=row><select id=publishedContext><option value="">All sessions</option><? (d.sessions||[]).forEach(id=>{ ?><option value="<?= id ?>"<?= String(d.context||'')===String(id)?' selected':'' ?>>#<?= id ?></option><? }) ?></select><select id=publishedSize><option value="">All sizes</option><option value=small<?= d.size==='small'?' selected':'' ?>>&lt; 1 MB</option><option value=medium<?= d.size==='medium'?' selected':'' ?>>1–10 MB</option><option value=large<?= d.size==='large'?' selected':'' ?>>10–100 MB</option><option value=huge<?= d.size==='huge'?' selected':'' ?>>≥ 100 MB</option></select><button data-action=clear-published-filters>🧹 Clear Filters</button></div><div class="row log-pagination"><span class="muted grow"><?= d.total||0 ?> publication<?= d.total===1?'':'s' ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Published Pages"><button class=page-button data-action=published-page data-published-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?' disabled':'' ?>>‹</button><? items.forEach(item=>{ if(item==='…'){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?' active':'' ?>" data-action=published-page data-published-page="<?= item ?>"<?= item===(d.page||1)?' aria-current=page':'' ?>><?= item ?></button><? } }) ?><button class=page-button data-action=published-page data-published-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?' disabled':'' ?>>›</button></nav></div><? if(!rows.length){ ?><div class=card><p class=muted>No published items match the current filters.</p></div><? } else { ?><table class=published-table><thead><tr><th>Created</th><th>Resource</th><th>Published By</th><th>Published File</th><th>Activity</th><th>Source</th><th></th></tr></thead><tbody><? rows.forEach(r=>{ ?><tr><td class=nowrap><?= it.logdt(r.created_at) ?></td><td class=published-id><div class=nowrap>📦 <?= r.mime_type||'content' ?></div><code title="<?= r.id ?>"><?= r.id ?></code><? if(r.content_key){ ?><div class=published-file-meta title="<?= r.content_key ?>">key <?= r.content_key ?></div><? } ?></td><td class=http-session><? const refs=r.references||[]; if(refs.length){ refs.forEach(u=>{ ?><div class=published-reference><span class=idcell>#<?= u.context_id ?></span><? if(u.root_name){ ?> <span class=workspace-label title="<?= u.root_name ?>">📁 <?= u.root_name ?></span><? } ?></div><? }); } else { ?>—<? } ?></td><td><button class=published-open data-action=open-published data-id="<?= r.id ?>" title="<?= r.published_name ?> · Open public URL in browser"><code><?= r.published_name ?></code></button><? if(r.title){ ?><div class=published-file-meta><?= r.title ?></div><? } ?><? if(r.filename&&r.filename!==r.source_filename){ ?><div class=published-file-meta>Presented as: <?= r.filename ?></div><? } ?><? if(r.presentation&&r.presentation!=='auto'){ ?><div class=published-file-meta><?= r.presentation ?></div><? } ?></td><td class=published-activity><b><?= r.request_count||0 ?> req</b><div class=published-file-meta><?= it.bytes(r.size) ?></div><? if(r.last_request_at){ ?><div class=published-file-meta>last <?= it.logdt(r.last_request_at) ?></div><? } ?></td><td class=published-source><? const latest=(r.references||[])[0]; if(latest?.source_path){ ?><code title="<?= latest.source_path ?>"><?= latest.source_path ?></code><? } else if(r.source_path){ ?><code title="<?= r.source_path ?>"><?= r.source_path ?></code><? } else { ?><span class=muted>Direct content</span><? } ?><? if((r.reference_count||0)>1){ ?><div class=published-file-meta><?= r.reference_count ?> references</div><? } ?></td><td class=nowrap><button class="small danger" data-action=delete-published data-id="<?= r.id ?>">🗑️ Delete</button></td></tr><? }) ?></tbody></table><? } ?>`,
    memory: `<? const d=it.data||{},rows=d.rows||[],items=it.pages(d.page||1,d.pages||1); ?><div class="row log-pagination"><span class="muted grow"><?= d.total||0 ?> memor<?= d.total===1?'y':'ies' ?> · page <?= d.page||1 ?>/<?= d.pages||1 ?></span><nav class=pagination aria-label="Memory Pages"><button class=page-button data-action=memory-page data-memory-page="<?= Math.max(1,(d.page||1)-1) ?>"<?= (d.page||1)<=1?' disabled':'' ?>>‹</button><? items.forEach(item=>{ if(item==='…'){ ?><span class=page-ellipsis>…</span><? } else { ?><button class="page-button<?= item===(d.page||1)?' active':'' ?>" data-action=memory-page data-memory-page="<?= item ?>"<?= item===(d.page||1)?' aria-current=page':'' ?>><?= item ?></button><? } }) ?><button class=page-button data-action=memory-page data-memory-page="<?= Math.min(d.pages||1,(d.page||1)+1) ?>"<?= (d.page||1)>=(d.pages||1)?' disabled':'' ?>>›</button></nav></div><? if(!rows.length){ ?><div class=card><p class=muted>No memories match the current filters.</p></div><? } else { ?><table><thead><tr><th>Set</th><th>Scope</th><th>Key</th><th>Value</th><th>TTL</th><th></th></tr></thead><tbody><? rows.forEach(r=>{ ?><tr><td class=nowrap><?= it.logdt(r.set_at) ?></td><td><? if(r.scope==='global'){ ?><span class=workspace-label>🌐 Global</span><? } else if(r.scope==='session'){ ?><span class=idcell>💬 #<?= r.owner_id ?></span><? } else { ?><span class=workspace-label>📁 <?= r.owner_name ?></span><? } ?></td><td><code><?= r.key ?></code></td><td><span class="descriptor-status <?= Number(r.is_json)?'current':'outdated' ?>"><?= Number(r.is_json)?'JSON':'TEXT' ?></span> <code title="Open View / Edit to inspect the complete value"><?= r.value_preview ?><?= String(r.value_json||'').length>320?'…':'' ?></code></td><td class=nowrap><? if(r.expires_at){ ?><?= r.ttl_seconds ?>s<div class=muted>until <?= it.logdt(r.expires_at) ?></div><? } else { ?><span class=muted>permanent</span><? } ?></td><td class=nowrap><button class=small data-action=edit-memory data-id="<?= r.id ?>">✏️ View / Edit</button> <button class="small danger" data-action=delete-memory data-id="<?= r.id ?>">🗑️ Delete</button></td></tr><? }) ?></tbody></table><? } ?>`,
    debug: `<? const d=it.data||{},rows=d.rows||[]; ?><p class="<?= d.enabled?'ok':'failed' ?>"><b><?= d.enabled?'● Recording enabled':'● Recording disabled' ?></b><? if(!d.enabled){ ?> · showing stored requests<? } ?></p><? if(!rows.length){ ?><p class=muted>No stored HTTP debug requests match the current filters.</p><? } else { ?><table><tr><th>ID</th><th>Time</th><th>Session</th><th>Client</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>IP</th><th>Error</th></tr><? rows.forEach(r => { ?><tr data-action=select-debug data-id="<?= r.id ?>" title="Click to expand"><td class=idcell>#<?= r.id ?></td><td class=nowrap><?= it.logdt(r.ts) ?></td><td class=http-session><? if(r.context_id){ ?><div class=idcell>#<?= r.context_id ?></div><? if(r.workspace_name){ ?><div class=workspace-label>📁 <?= r.workspace_name ?></div><? } ?><? } else { ?>—<? } ?></td><td><? if(r.client_id){ ?><code><?= r.client_id ?></code><? } else { ?>—<? } ?></td><td><b><?= r.method ?></b></td><td><code><?= r.path ?></code></td><td class="<?= !r.status?'pending':(r.status>=400?'failed':'ok') ?>"><?= r.status||"…" ?></td><td><?= r.status ? r.duration_ms+"ms" : "in flight" ?></td><td class=nowrap><?= r.remote_addr||"—" ?><? if(r.remote_addr){ ?> (<?= r.remote_count||1 ?>)<? } ?></td><td><?= r.error_preview ?></td></tr><? if(String(d.openRowId||"")===String(r.id)&&d.openDetail){ const x=d.openDetail; ?><tr class=detail-row data-detail-kind=http data-detail-id="<?= r.id ?>"><td colspan=10><div class="detail-panel http-detail-panel"><div class="row http-detail-head"><div class=grow><b>HTTP Request #<?= r.id ?></b><div class=http-detail-meta><span><?= it.logdt(x.ts) ?></span><span><? if(x.context_id){ ?>Session #<?= x.context_id ?><? } else { ?>No Session<? } ?></span><? if(x.workspace_name){ ?><span>📁 <?= x.workspace_name ?></span><? } ?><span><? if(x.client_id){ ?>Client <code><?= x.client_id ?></code><? } else { ?>No client id<? } ?></span><span><?= x.remote_addr||"unknown IP" ?><? if(x.remote_addr){ ?> · <?= x.remote_count||1 ?> total request<?= Number(x.remote_count||1)===1?'':'s' ?><? } ?></span><span><?= x.status ? x.duration_ms+"ms" : "in flight" ?></span></div></div><button class=small data-action=copy-detail data-target="http-json-<?= r.id ?>">📋 Copy Full Row</button><button class=small data-action=close-row-detail data-kind=http>✕ Close</button></div><div class=http-detail-grid><section class=http-detail-block><div class=row><h4 class=grow>→ Request</h4><b><?= x.method ?></b> <code><?= x.path ?></code></div><div class=muted>Headers</div><pre><?= it.prettyParsed(x.request_headers||{}) ?></pre><div class=muted>Body</div><pre><?= it.prettyParsed(x.request_body||{}) ?></pre></section><section class=http-detail-block><div class=row><h4 class=grow>← Response</h4><b class="<?= !x.status?'pending':(x.status>=400?'failed':'ok') ?>"><?= x.status||"in flight" ?></b></div><div class=muted>Headers</div><pre><?= it.prettyParsed(x.response_headers||{}) ?></pre><div class=muted>Body</div><pre><?= it.prettyParsed(x.response_body||{}) ?></pre></section></div><? if(x.error){ ?><section class="http-detail-block http-detail-error"><h4 class=failed>Error</h4><pre><?= x.error ?></pre></section><? } ?><details class=http-detail-raw><summary>Raw record</summary><pre id="http-json-<?= r.id ?>"><?= it.pretty(x) ?></pre></details></div></td></tr><? } }) ?></table><? } ?>`,
  } : {};
  const fragmentBytes = value => {
    const size = Math.max(0, Number(value) || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1048576) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
    if (size < 1073741824) return `${(size / 1048576).toFixed(size < 10485760 ? 1 : 0)} MB`;
    return `${(size / 1073741824).toFixed(1)} GB`;
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
    const input = mcpToolArgsFromPacket(log.mcp_request_json);
    const resolved = mcpToolStructuredResultFromPacket(log.mcp_response_json);
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
      output: fragmentTerminalOutput(live?.output ?? resolved.output ?? ""),
      status: String(source.status || log.status || ""),
      exit_code: source.exit_code ?? null,
      signal: String(source.signal || ""),
      requested_signal: String(source.requested_signal || ""),
      termination_source: String(source.termination_source || ""),
    };
  };
  const fragmentDebugPayload = source => {
    const root = mcpPacketObject(source) ?? source;
    const render = (value, depth = 0, key = null, parent = null, allowBase64 = true) => {
      const label = key === null ? "" : `<span class="debug-key">${htmlEscape(key === "" ? '""' : key)}:</span> `;
      if (value === null) return `${label}<span class="debug-null">null</span>`;
      if (typeof value === "boolean" || typeof value === "number") return `${label}<span class="debug-scalar">${htmlEscape(String(value))}</span>`;
      if (typeof value === "string") {
        const text = value, trimmed = text.trim();
        const dataUrl = text.startsWith("data:") ? text.match(/^data:([^;,\s]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i) : null;
        const hintedMime = key === "data" && parent?.type === "image" ? String(parent.mimeType || parent.mime_type || "image/png") : "";
        const renderBase64 = (mime, base64) => {
          const bytes = decodeLogBase64(base64);
          if (!bytes?.length) return "";
          mime = String(mime || sniffLogBinaryMime(bytes) || "").split(";")[0].trim().toLowerCase();
          if (mime.startsWith("image/")) return `${label}<figure class="debug-image"><img src="data:${htmlEscape(mime)};base64,${Buffer.from(bytes).toString("base64")}" alt="decoded ${htmlEscape(mime)}"><figcaption>${htmlEscape(mime)} · ${fragmentBytes(bytes.length)}</figcaption></figure>`;
          try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (decoded && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded))
              return `<details class="debug-decoded" open><summary>${label}Base64 text · ${fragmentBytes(bytes.length)}</summary>${render(decoded, depth + 1, null, parent, false)}</details>`;
          } catch {}
          return "";
        };
        if (dataUrl) {
          const decoded = renderBase64(dataUrl[1], dataUrl[2]);
          if (decoded) return decoded;
        }
        if (allowBase64) {
          if (hintedMime) {
            const decoded = renderBase64(hintedMime, text);
            if (decoded) return decoded;
          } else if (text.length >= 16 && (/[=]\s*$/.test(text) || text.replace(/\s+/g, "").length >= 64 || /base64|blob|data/i.test(key))) {
            const decoded = renderBase64(sniffLogBase64ValueMime(text), text);
            if (decoded) return decoded;
          }
        }
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          const parsed = parseJson(trimmed, null);
          if (parsed && typeof parsed === "object")
            return `<details class="debug-decoded" open><summary>${label}JSON string</summary>${render(parsed, depth + 1)}</details>`;
        }
        if (text.includes("\n") && (/^\s*-\s+\S/m.test(text) || /^\s*[A-Za-z0-9_.-]+\s*:\s*/m.test(text))) {
          try {
            const parsed = parseYaml(text);
            if (parsed && typeof parsed === "object")
              return `<details class="debug-decoded" open><summary>${label}YAML string</summary>${render(parsed, depth + 1)}</details>`;
          } catch {}
        }
        return text.includes("\n") ? `${label}<pre class="debug-multiline">${htmlEscape(text)}</pre>` : `${label}<span class="debug-string">${htmlEscape(text || '""')}</span>`;
      }
      if (Array.isArray(value)) {
        return `<details class="debug-node"${depth < 2 ? " open" : ""}><summary>${label}Array · ${value.length}</summary><div class="debug-children">${value.map((item, index) => `<div class="debug-entry">${render(item, depth + 1, String(index), value)}</div>`).join("")}</div></details>`;
      }
      if (value && typeof value === "object") {
        const entries = Object.entries(value);
        return `<details class="debug-node"${depth < 2 ? " open" : ""}><summary>${label}Object · ${entries.length}</summary><div class="debug-children">${entries.map(([childKey, child]) => `<div class="debug-entry">${render(child, depth + 1, childKey, value)}</div>`).join("")}</div></details>`;
      }
      return `${label}<span class="debug-scalar">${htmlEscape(String(value))}</span>`;
    };
    return `<div class="debug-payload-tree">${render(root)}</div>`;
  };
  const endpointRows = p => [
    ["MCP sslip.io", p.sslip_https_mcp_url], ["MCP direct IP", p.direct_ip_https_mcp_url],
    ["OAuth metadata", p.sslip_metadata_url], ["Local HTTPS", p.local_https_mcp_url],
    ["Basic URL", p.basic_url],
  ].map(([label, url]) => ({ label, url }));
  const UI_RENDER_STALE = Symbol("ui-render-stale");
  function requireCurrentUiRender(generation) {
    if (!uiRenderVisible || generation !== uiRenderGeneration) throw UI_RENDER_STALE;
  }
  async function currentUiRender(value, generation) {
    requireCurrentUiRender(generation);
    const result = await value;
    requireCurrentUiRender(generation);
    return result;
  }
  async function renderEtaFragment(name, data, generation) {
    if (!fragmentTemplates[name]) throw new Error(`Unknown UI fragment: ${name}`);
    requireCurrentUiRender(generation);
    const context = {
      data, dt: fragmentDate, logdt: fragmentLogDate, bytes: fragmentBytes, pages: fragmentPageItems, endpointRows, terminal: fragmentTerminal,
      debugPayload: fragmentDebugPayload,
      pretty: value => JSON.stringify(value ?? null, null, 2),
      prettyParsed: value => {
        const parsed = typeof value === "string" ? parseJson(value, value) : value;
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? null, null, 2);
      },
    };
    const html = typeof eta.renderStringAsync === "function"
      ? await eta.renderStringAsync(fragmentTemplates[name], context)
      : eta.renderString(fragmentTemplates[name], context);
    requireCurrentUiRender(generation);
    return html;
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
    const goalMinutes = String(settings.chat_goal_timeout_minutes ?? "5").trim();
    if (!/^\d+$/.test(goalMinutes) || Number(goalMinutes) < 1 || Number(goalMinutes) > 1440)
      warnings.chat_goal_timeout_minutes = "Goal timeout must be whole minutes from 1 to 1440.";
    for (const key of ["chat_goals_enabled", "chat_goal_headless", "chat_goal_disable_images", "chat_goal_stop_before_send", "chat_goal_match_on_startup"])
      if (settings[key] != null && typeof settings[key] !== "boolean") warnings[key] = "Goal switches must be enabled or disabled.";
    if (!["auto", "hide", "show"].includes(String(settings.chat_goal_windows_hide ?? "auto")))
      warnings.chat_goal_windows_hide = "Process visibility must follow headless, hide or show.";
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
    try { configuredExecEnvironment(settings.exec_environment || ""); }
    catch (error) { warnings.exec_environment = String(error?.message || error); }
    if (!["sample", "full"].includes(String(settings.text_encoding_detection ?? "sample")))
      warnings.text_encoding_detection = "Text encoding detection must use the initial sample or the complete file.";
    const retentionText = String(settings.tool_call_retention_hours ?? "0").trim();
    const retentionHours = Number(retentionText);
    if (!/^\d+$/.test(retentionText) || !Number.isSafeInteger(retentionHours) || retentionHours < 0)
      warnings.tool_call_retention_hours = "Tool Call retention must be a whole number of hours; 0 keeps logs indefinitely.";
    const storage = String(settings.tool_call_storage || "disk").toLowerCase();
    if (!TOOL_CALL_STORAGES.has(storage)) warnings.tool_call_storage = "Tool Call storage must be Disk or Memory.";
    const payloadMode = String(settings.tool_call_payload_mode || "payload").toLowerCase();
    if (!TOOL_CALL_PAYLOAD_MODES.has(payloadMode)) warnings.tool_call_payload_mode = "Tool Call payload mode must be Payload or Metadata.";
    const memoryRetentionText = String(settings.tool_call_memory_retention_minutes ?? "60").trim(), memoryRetentionMinutes = Number(memoryRetentionText);
    if (!/^\d+$/.test(memoryRetentionText) || !Number.isSafeInteger(memoryRetentionMinutes) || memoryRetentionMinutes < 0)
      warnings.tool_call_memory_retention_minutes = "Memory Tool Call retention must be whole minutes; 0 keeps rows until restart.";
    if (settings.search_configuration != null) { try { const c=searchConfig(String(settings.search_configuration)); if(String(c.default_path||"").trim() && !Deno.statSync(configuredWorkspacePath(c.default_path)).isDirectory) throw new Error("default_path must point to a directory"); } catch (e) { warnings.search_configuration = e.message; } }
    if (settings.proxy_configuration != null) { try { proxyConfig(String(settings.proxy_configuration)); } catch (e) { warnings.proxy_configuration = e.message; } }
    return warnings;
  }
  function telegramTokenWarning(value) {
    const token = String(value || "").trim();
    return token && (token.length > 512 || /\s/.test(token))
      ? "Telegram Bot token must not contain whitespace and must be at most 512 characters." : "";
  }
  function uiTelegramProjection(settings) {
    const telegram_bot_token = uiState.telegramDraft == null
      ? String(settings.telegram_bot_token || "") : String(uiState.telegramDraft || "");
    const field_warning = telegramTokenWarning(telegram_bot_token);
    return { telegram_bot_token, field_warning, save_disabled: !!field_warning };
  }
  function uiSettingsProjection(settings) {
    const draft = uiState.settingsDraft || {};
    const projected = { ...settings, ...draft };
    if (typeof projected.public_ip_urls === "string") projected.public_ip_urls = projected.public_ip_urls.split(/\r?\n/);
    projected.field_warnings = settingsFieldWarnings(projected);
    projected.save_disabled = Object.values(projected.field_warnings).some(Boolean);
    return projected;
  }
  async function buildUiRenderModel(generation) {
    requireCurrentUiRender(generation);
    const section = UI_SECTIONS.has(uiState.currentSection) ? uiState.currentSection : "dashboard";
    const projection = state(section);
    const viewState = {
      currentSection: section,
      settings: uiSettingsProjection(projection.settings),
      maintenance: projection.maintenance,
      trashCount: Number(projection.trash_summary?.items || 0),
      processCount: Number(projection.process_summary?.active || 0),
      contextValues: projection.context_values || [],
      dialog: uiState.dialog,
      settingsTab: uiState.settingsTab,
    };
    if (section === "settings") {
      try { viewState.settings.default_search_path = await currentUiRender(searchDefaultDirectory(searchConfig(viewState.settings.search_configuration)), generation); }
      catch (error) { requireCurrentUiRender(generation); viewState.settings.default_search_path = ""; }
    }
    if (section === "sessions") viewState.sessions = { ...uiState.sessions };
    else if (section === "commands") viewState.commands = { ...uiState.commands };
    else if (section === "prompts") viewState.prompts = { ...uiState.prompts };
    else if (section === "logs") viewState.logs = { ...uiState.logs };
    else if (section === "browser") viewState.browser = { ...uiState.browser };
    else if (section === "automation") viewState.automation = { ...uiState.automation };
    else if (section === "published") viewState.published = { ...uiState.published };
    else if (section === "memory") viewState.memory = { ...uiState.memory };
    else if (section === "debug") viewState.debug = { ...uiState.debug, enabled: !!projection.settings.debug_http_log };
    else if (section === "telegram") viewState.telegram = uiTelegramProjection(projection.settings);
    const model = { section, projection, viewState, commandData: null, promptData: null, processData: null, logData: null, browserData: null, automationData: null, publishedData: null, trashData: null, memoryData: null, debugData: null };
    if (section === "prompt_help") viewState.promptHelp = { yaml: GUIDED_PROMPTS_HELP_YAML, model: GUIDED_PROMPTS_HELP_MODEL };
    if (section === "roots") {
      const rows = projection.root_assignments?.roots || [];
      const warnings = await currentUiRender(Promise.all(rows.map(async root => [Number(root.id), await rootPathWarning(root.path)])), generation);
      const byId = new Map(warnings);
      for (const root of rows) root.path_warning = byId.get(Number(root.id)) || "";
    } else if (section === "sessions") {
      const roots = projection.roots || [];
      const warnings = await currentUiRender(Promise.all(roots.map(async root => [Number(root.id), await rootPathWarning(root.path)])), generation);
      const byId = new Map(warnings);
      for (const context of projection.context_values || [])
        context.workspace_warning = !context.workspace_selected ? "" : (byId.get(Number(context.workspace_id)) || "");
    }
    if (section === "commands") {
      const current = uiState.commands;
      model.commandData = await currentUiRender(commandCatalog({
        query: current.query, page: current.page, page_size: current.pageSize,
        include_missing: true, admin: true, filter: current.filter,
      }), generation);
      current.page = model.commandData.page;
      viewState.commands.page = current.page;
      viewState.commands.discoveryEnabled = model.commandData.discovery_enabled;
    } else if (section === "prompts") {
      const current = uiState.prompts;
      model.promptData = await currentUiRender(guidedPromptCatalog({
        query: current.query, page: current.page, page_size: current.pageSize,
      }), generation);
      current.page = model.promptData.page;
      viewState.prompts.page = current.page;
    } else if (section === "processes") {
      model.processData = activeProcessAdminProjection();
    } else if (section === "logs") {
      const current = uiState.logs;
      const query = new URLSearchParams({
        tool: current.toolQuery, q: current.query, context: current.context, status: current.status,
        page: String(current.page), page_size: String(current.pageSize),
      });
      model.logData = await currentUiRender(uiInternalApi(`/api/logs?${query}`), generation);
      current.page = model.logData.page;
      if (current.openRowId) {
        if ((model.logData.rows || []).some(row => String(row.id) === String(current.openRowId)))
          model.logData.openDetail = await currentUiRender(uiInternalApi(`/api/logs/${encodeURIComponent(current.openRowId)}`), generation);
        else current.openRowId = "";
      }
      model.logData.openRowId = current.openRowId;
      viewState.logs.page = current.page;
      viewState.logs.openRowId = current.openRowId;
    } else if (section === "browser") {
      model.browserData = browserAdminProjection(uiState.browser);
      viewState.browser = { ...uiState.browser, ...Object.fromEntries(["browser", "target", "context", "active"].map(key => [key, model.browserData[key]])) };
    } else if (section === "automation") {
      const current = uiState.automation;
      model.automationData = automationAdminProjection(current);
      current.page = model.automationData.page;
      viewState.automation = { ...current, context: model.automationData.context, sessions: model.automationData.sessions };
    } else if (section === "published") {
      const current = uiState.published;
      model.publishedData = publishedAdminProjection(serverConfig().id, current);
      current.page = model.publishedData.page;
      viewState.published.page = current.page;
    } else if (section === "trash") {
      model.trashData = trashAdminProjection();
    } else if (section === "memory") {
      const current = uiState.memory;
      model.memoryData = memoryAdminProjection(current);
      current.page = model.memoryData.page;
      viewState.memory = { ...current, sessions: model.memoryData.sessions, workspaces: model.memoryData.workspaces };
    } else if (section === "debug") {
      const current = uiState.debug;
      const query = new URLSearchParams({ q: current.query, method: current.method, status: current.status });
      const rows = await currentUiRender(uiInternalApi(`/api/debug?${query}`), generation);
      model.debugData = { enabled: !!projection.settings.debug_http_log, rows, openRowId: current.openRowId };
      if (current.openRowId) {
        if ((rows || []).some(row => String(row.id) === String(current.openRowId)))
          model.debugData.openDetail = await currentUiRender(uiInternalApi(`/api/debug/${encodeURIComponent(current.openRowId)}`), generation);
        else current.openRowId = "";
      }
      model.debugData.openRowId = current.openRowId;
      viewState.debug.openRowId = current.openRowId;
    }
    requireCurrentUiRender(generation);
    return model;
  }
  function fillUiMount(html, id, inner) {
    const pattern = new RegExp(`<([A-Za-z][A-Za-z0-9-]*) id=${id}([^>]*)></\\1>`);
    return html.replace(pattern, (_match, tag, attributes) => `<${tag} id=${id}${attributes}>${inner}</${tag}>`);
  }
  async function renderUiDocument(generation) {
    const model = await buildUiRenderModel(generation);
    const { section, projection, viewState } = model;
    let view = await renderEtaFragment("view", { state: viewState }, generation);
    if (section === "dashboard") {
      view = fillUiMount(view, "cards", await renderEtaFragment("cards", {
        sessions: projection.stats?.context_values || 0,
        roots: projection.stats?.roots || 0,
        tool_calls: projection.stats?.logs || 0,
        tool_calls_in_flight: projection.stats?.in_flight || 0,
        failed_calls: projection.stats?.failures || 0,
        http_requests: projection.stats?.total_requests || 0,
      }, generation));
      view = fillUiMount(view, "endpoints", await renderEtaFragment("endpoints", projection.server || {}, generation));
      view = fillUiMount(view, "tlsStatus", await renderEtaFragment("tls", projection.settings, generation));
    } else if (section === "sessions") {
      view = fillUiMount(view, "contextList", await renderEtaFragment("context", { values: projection.context_values || [] }, generation));
    } else if (section === "roots") {
      view = fillUiMount(view, "rootList", await renderEtaFragment("roots", projection.root_assignments || {}, generation));
    } else if (section === "commands") {
      view = fillUiMount(view, "commandList", await renderEtaFragment("commands", model.commandData || {}, generation));
    } else if (section === "prompts") {
      view = fillUiMount(view, "promptList", await renderEtaFragment("prompts", model.promptData || {}, generation));
    } else if (section === "processes") {
      view = fillUiMount(view, "activeToolCalls", await renderEtaFragment("active_tool_calls", projection.active_tool_calls || [], generation));
      view = fillUiMount(view, "processList", await renderEtaFragment("processes", model.processData || {}, generation));
    } else if (section === "logs") {
      view = fillUiMount(view, "logList", await renderEtaFragment("logs", model.logData || {}, generation));
    } else if (section === "browser") {
      view = fillUiMount(view, "browserList", await renderEtaFragment("browser", model.browserData || {}, generation));
    } else if (section === "automation") {
      view = fillUiMount(view, "automationList", await renderEtaFragment("automation", model.automationData || {}, generation));
    } else if (section === "published") {
      view = fillUiMount(view, "publishedList", await renderEtaFragment("published", model.publishedData || {}, generation));
    } else if (section === "trash") {
      view = fillUiMount(view, "trashList", await renderEtaFragment("trash", { ...(model.trashData || {}), maintenance: projection.maintenance }, generation));
    } else if (section === "memory") {
      view = fillUiMount(view, "memoryList", await renderEtaFragment("memory", model.memoryData || {}, generation));
    } else if (section === "debug") {
      view = fillUiMount(view, "debugList", await renderEtaFragment("debug", model.debugData || {}, generation));
    } else if (section === "oauth") {
      view = fillUiMount(view, "oauthList", await renderEtaFragment("oauth", projection.oauth_clients || [], generation));
    }
    const sidebar = await renderEtaFragment("sidebar", { state: viewState }, generation);
    const status = await renderEtaFragment("status", { settings: projection.settings, activity: projection.header_activity, live: "connected" }, generation);
    const dialogs = await renderEtaFragment("dialogs", { state: viewState }, generation);
    const notice = uiState.notice
      ? `<div id=uiNotice class="notice-balloon ${htmlEscape(uiState.notice.kind || "error")}">${htmlEscape(uiState.notice.message || "")}</div>`
      : "";
    requireCurrentUiRender(generation);
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
    if (id === "logTool") uiState.logs.toolQuery = text;
    else if (id === "logQuery") uiState.logs.query = text;
    else if (id === "publishedContext") uiState.published.context = text;
    else if (id === "publishedSize") uiState.published.size = text;
    else if (id === "memoryQuery") uiState.memory.query = text;
    else if (id === "memoryScope") uiState.memory.scope = text;
    else if (id === "memoryContext") uiState.memory.context = text;
    else if (id === "memoryWorkspace") uiState.memory.workspace = text;
    else if (id === "memoryFrom") uiState.memory.from = text;
    else if (id === "memoryTo") uiState.memory.to = text;
    else if (id === "debugQuery") uiState.debug.query = text;
    else if (id === "commandQuery") uiState.commands.query = text;
    else if (id === "promptQuery") uiState.prompts.query = text;
    else if (uiState.dialog?.kind === "root") {
      const map = { rid: "id", rname: "name", rpath: "path", renabled: "enabled" };
      if (map[id]) uiState.dialog.data[map[id]] = id === "renabled" ? !!checked : text;
    } else if (uiState.dialog?.kind === "command") {
      const map = {
        coldName: "old_name", cname: "name", cpath: "path", cdescription: "description",
        cdownloadUrl: "download_url", cplatforms: "platforms_text", carchivePath: "archive_path", cdocumentationUrl: "documentation_url",
      };
      if (map[id]) uiState.dialog.data[map[id]] = text;
    } else if (uiState.dialog?.kind === "prompt") {
      const map = {
        poldName: "old_name", pname: "name", ptitle: "title", pdescription: "description",
        parguments: "arguments_text", ptemplate: "template",
      };
      if (map[id]) uiState.dialog.data[map[id]] = text;
    } else if (uiState.dialog?.kind === "memory") {
      const d = uiState.dialog.data;
      const map = { mid: "id", mkey: "key", mvalue: "value_text", mttl: "ttl_seconds", mcontext: "context", mworkspace: "workspace" };
      if (map[id]) d[map[id]] = text;
      if (id === "mscope") {
        d.scope = ["global", "session", "workspace"].includes(text) ? text : "global";
        if (d.scope === "session") {
          d.workspace = "";
          if (!d.context) d.context = d.sessions?.[0] || "";
        } else if (d.scope === "workspace") {
          d.context = "";
          if (!d.workspace) d.workspace = d.workspaces?.[0] || "";
        } else {
          d.context = "";
          d.workspace = "";
        }
      }
      if (id === "mjson") d.json = !!checked;
    }
    const settingsMap = {
      externalUrl: "external_url", tlsEmail: "tls_email", publicIpUrls: "public_ip_urls",
      sslipSuffix: "sslip_suffix", acmeDirectoryUrl: "acme_directory_url",
      notifySession: "desktop_notifications_session", notifyWorkspace: "desktop_notifications_workspace",
      notifyToolCall: "desktop_notifications_tool_call", inheritSystemPath: "inherit_system_path",
      gitPreserveLineEndings: "git_preserve_line_endings", execEnvironment: "exec_environment", searchConfiguration: "search_configuration", proxyConfiguration: "proxy_configuration",
      chatGoalsEnabled: "chat_goals_enabled", chatGoalTimeoutMinutes: "chat_goal_timeout_minutes",
      chatGoalHeadless: "chat_goal_headless", chatGoalWindowsHide: "chat_goal_windows_hide",
      chatGoalDisableImages: "chat_goal_disable_images", chatGoalStopBeforeSend: "chat_goal_stop_before_send", chatGoalMatchOnStartup: "chat_goal_match_on_startup",
      textEncodingDetection: "text_encoding_detection",
      toolCallStorage: "tool_call_storage", toolCallPayloadMode: "tool_call_payload_mode",
      toolCallRetentionHours: "tool_call_retention_hours", toolCallMemoryRetentionMinutes: "tool_call_memory_retention_minutes",
    };
    if (settingsMap[id]) {
      uiState.settingsDraft ||= {};
      uiState.settingsDraft[settingsMap[id]] = ["notifySession", "notifyWorkspace", "notifyToolCall", "inheritSystemPath", "gitPreserveLineEndings", "chatGoalsEnabled", "chatGoalHeadless", "chatGoalDisableImages", "chatGoalStopBeforeSend", "chatGoalMatchOnStartup"].includes(id) ? !!checked : text;
    }
    if (id === "telegramBotToken") uiState.telegramDraft = text;
  }
  async function uiCommandRow(name, path = "") {
    const rows = await commandRows({ include_missing: true, admin: true });
    return rows.find(row => row.name === name && (!path || row.path === path));
  }
  async function uiDownloadOne(name, overwrite = false) {
    return await uiInternalApi("/api/commands/download", { method: "POST", body: { name, overwrite } });
  }
  async function uiDownloadAll(overwrite = false) {
    const rows = (await commandRows({ include_missing: true, admin: true })).filter(row => row.registered && row.download_url);
    const failures = [];
    for (const row of rows) {
      try { await uiDownloadOne(row.name, overwrite || !!row.present); }
      catch (error) { failures.push(`${row.name}: ${String(error?.message || error)}`); }
    }
    if (failures.length) uiNotice(`Download errors:\n${failures.join("\n")}`);
  }
  function uiStartMaintenance(promise, label) {
    Promise.resolve(promise).then(result => {
      const value = result?.cleared;
      const count = typeof value === "number" ? ` · ${value} removed` : "";
      uiNotice(`${label} completed${count}.`, "ok");
    }).catch(error => uiNotice(`${label} failed: ${String(error?.message || error)}`));
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
      case "delete-prompt":
        await uiInternalApi("/api/prompts/delete", { method: "POST", body: { name: String(data.name || "") } });
        break;
      case "revoke-client":
        await uiInternalApi("/api/oauth/revoke-client", { method: "POST", body: { client_id: String(data.client_id || "") } });
        break;
      case "delete-published":
        if (!await cleanupPublished(String(data.id || ""), true)) throw new Error("Published item not found");
        uiNotice("Published item deleted.", "ok");
        break;
      case "delete-memory": {
        const result = run("DELETE FROM memories WHERE id=?", Number(data.id));
        if (!Number(result.changes || 0)) throw new Error("Memory not found");
        changed({ ui: ["memory"] }, "memory-delete");
        uiNotice("Memory deleted.", "ok");
        break;
      }
      case "delete-trash":
        await uiInternalApi("/api/trash/delete", { method: "POST", body: { trash_id: String(data.id || "") } });
        uiNotice("Trash transaction permanently deleted.", "ok");
        break;
      case "delete-trash-item":
        await uiInternalApi("/api/trash/delete", { method: "POST", body: { trash_id: String(data.id || ""), payload: String(data.payload || "") } });
        uiNotice("Trash item permanently deleted.", "ok");
        break;
      case "clear-published":
        uiStartMaintenance(clearPublished(data.filters || {}), "Clear Published");
        break;
      case "clear-debug":
        await uiInternalApi("/api/debug/clear", { method: "POST" });
        uiState.debug.openRowId = "";
        break;
      case "clear-tool-calls":
        uiStartMaintenance(uiInternalApi("/api/logs/clear", { method: "POST" }), "Clear Tool Calls");
        break;
      case "clear-sessions":
        uiStartMaintenance(uiInternalApi("/api/context/clear", { method: "POST" }), "Clear Sessions");
        break;
      case "clear-workspaces":
        uiStartMaintenance(uiInternalApi("/api/roots/clear", { method: "POST" }), "Clear Workspaces");
        break;
      case "clear-clients":
        uiStartMaintenance(uiInternalApi("/api/oauth/clear", { method: "POST" }), "Clear Clients");
        break;
      case "clear-database":
        uiStartMaintenance(uiInternalApi("/api/database/clear", { method: "POST" }), "Clear Operational Data");
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
  async function replayAdminAction(logId, expectedTool, callIndex = null) {
    const row = one("SELECT id,tool,mcp_request_json,payload_mode FROM logs WHERE id=?", Math.max(0, Number(logId) || 0));
    if (!row || row.tool !== expectedTool) throw new Error(`Recorded ${expectedTool} Tool Call not found`);
    if (row.payload_mode !== "payload") throw new Error("Replay requires a Tool Call recorded with Payload retention");
    const args = mcpToolArgsFromPacket(row.mcp_request_json);
    if (expectedTool === "desktop_auto") {
      await runDesktopScenario(args.yaml);
      uiNotice("Automation scenario replayed.", "ok");
      return;
    }
    const calls = Array.isArray(args.calls) ? args.calls : [];
    const replayCalls = callIndex == null ? calls : [calls[Math.max(0, Number(callIndex) || 0)]].filter(Boolean);
    if (!replayCalls.length) throw new Error("Recorded CDP operation not found");
    const result = await runCdpBatch({ calls: replayCalls, wait: args.wait !== false });
    if (result.results.some(item => item?.success === false)) {
      const failed = result.results.find(item => item?.success === false);
      throw new Error(String(failed?.error || "CDP replay failed"));
    }
    uiNotice(callIndex == null ? "CDP batch replayed." : "CDP operation replayed.", "ok");
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
      case "stop-chat-goal": {
        const context = contextById(serverConfig(), Number(data.id));
        if (!context) throw new Error("Session not found");
        setChatGoal(context, "", context.goal_timeout_seconds);
        break;
      }
      case "open-chat-goal":
        uiState.currentSection = "settings";
        uiState.settingsTab = "goals";
        break;
      case "open-chat-goal-login": {
        if (!chatGoalLoginBusy) void chatGoalLogin().catch(error => uiNotice(String(error?.message || error)));
        break;
      }
      case "delete-context":
        uiConfirm("Delete Session", "Delete this persistent Session and stop its chat goal? Running processes are not terminated.", "delete-context", { id: data.id });
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
      case "process-tool-call": {
        const id = Math.max(0, Number(data.id) || 0);
        if (!id || !one("SELECT id FROM logs WHERE id=?", id)) {
          uiNotice("Tool Call not found");
          break;
        }
        uiState.currentSection = "logs";
        uiState.logs.context = "";
        uiState.logs.toolQuery = "";
        uiState.logs.query = "";
        uiState.logs.status = "";
        uiState.logs.page = toolCallLogPage(id);
        uiState.logs.openRowId = String(id);
        uiState.logs.selfTest = null;
        uiState.scrollBySection.logs = [0, 0];
        uiState.focus = null;
        break;
      }
      case "header-tool-calls":
        uiState.currentSection = "logs";
        uiState.logs.context = "";
        uiState.logs.toolQuery = "";
        uiState.logs.query = "";
        uiState.logs.status = ["running", "failed", "invalid"].includes(String(data.status || "")) ? String(data.status) : "";
        uiState.logs.page = 1;
        uiState.logs.openRowId = "";
        uiState.logs.selfTest = null;
        break;
      case "session-tool-calls":
        uiState.currentSection = "logs";
        uiState.logs.context = String(Number(data.id) || "");
        uiState.logs.toolQuery = "";
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
          name: "", path: "", description: "", download_url: "", archive_path: "", platforms_text: "{}", documentation_url: "", registered: false,
          name_warning: "Command name is required.", path_warning: "", path_error: false, path_checked: true,
          download_warning: "", documentation_warning: "", form_warning: "",
        } };
        break;
      case "edit-command": {
        const row = await uiCommandRow(String(data.name || ""), String(data.path || ""));
        if (!row) throw new Error("Command not found");
        const pathWarning = await commandPathWarning(row.path);
        uiState.dialog = { kind: "command", data: {
          ...row, old_name: row.name, path: row.catalog_path ?? row.path, download_url: row.catalog_download_url ?? row.download_url, archive_path: row.catalog_archive_path ?? row.archive_path,
          platforms_text: stringifyYaml(row.platforms || {}, { lineWidth: -1 }),
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
        const rows = (await commandRows({ include_missing: true, admin: true })).filter(row => row.registered && row.download_url);
        const existing = rows.filter(row => row.present);
        if (existing.length) {
          uiConfirm("Replace Commands", `Download ${rows.length} commands and replace ${existing.length} existing file${existing.length === 1 ? "" : "s"}?`, "download-all-commands");
          return;
        }
        await uiDownloadAll(false);
        break;
      }
      case "toggle-command-discovery":
        setCfg("command_discovery_enabled", getCfg("command_discovery_enabled", "1") === "1" ? "0" : "1");
        break;
      case "load-commands":
        uiState.commands.page = 1;
        break;
      case "commands-prev":
        uiState.commands.page = Math.max(1, uiState.commands.page - 1);
        break;
      case "commands-next":
        uiState.commands.page += 1;
        break;
      case "new-prompt":
        uiState.dialog = { kind: "prompt", data: {
          name: "", title: "", description: "", arguments_text: "", template: "", old_name: "",
          name_warning: "Prompt name is required.", args_warning: "", template_warning: "Template is required.", form_warning: "",
        } };
        break;
      case "edit-prompt": {
        const row = (await readGuidedPromptConfig()).find(prompt => prompt.name === String(data.name || ""));
        if (!row) throw new Error("Guided prompt not found");
        uiState.dialog = { kind: "prompt", data: {
          ...row, old_name: row.name, arguments_text: guidedPromptArgumentsText(row.arguments),
          name_warning: await guidedPromptNameWarning(row.name, row.name), args_warning: "", template_warning: "", form_warning: "",
        } };
        break;
      }
      case "delete-prompt":
        uiConfirm("Delete Guided Prompt", `Delete ${data.name || "this prompt"} from guided_prompts.yaml?`, "delete-prompt", { name: data.name });
        return;
      case "prompt-help":
        uiState.currentSection = "prompt_help";
        break;
      case "prompts-back":
        uiState.currentSection = "prompts";
        break;
      case "load-prompts":
        uiState.prompts.page = 1;
        break;
      case "prompts-prev":
        uiState.prompts.page = Math.max(1, uiState.prompts.page - 1);
        break;
      case "prompts-next":
        uiState.prompts.page += 1;
        break;
      case "revoke-client":
        uiConfirm("Revoke OAuth Client", "Revoke this client and all of its tokens?", "revoke-client", { client_id: data.id });
        return;
      case "open-published":
        await openPublished(String(data.id || ""));
        return;
      case "delete-published":
        uiConfirm("Delete Published Item", "Delete this publication and its snapshot file? This cannot be undone.", "delete-published", { id: data.id });
        return;
      case "clear-published": {
        const filters = {
          context: uiState.published.context, size: uiState.published.size,
        };
        const filtered = !!(filters.context || filters.size);
        uiConfirm("Clear Published", filtered
          ? "Delete every published item matching the current filters across all pages? This cannot be undone."
          : "Delete every published item across all pages? This cannot be undone.",
          "clear-published", { filters });
        return;
      }
      case "restore-trash": {
        const result = await uiInternalApi("/api/trash/restore", { method: "POST", body: { trash_id: String(data.id || "") } });
        uiNotice(result.failed ? `Restored ${result.succeeded} item(s); ${result.failed} could not be restored.` : `Restored ${result.succeeded} item(s).`, result.failed ? "info" : "ok");
        break;
      }
      case "restore-trash-item": {
        const result = await uiInternalApi("/api/trash/restore", { method: "POST", body: { trash_id: String(data.id || ""), payload: String(data.payload || "") } });
        if (result.failed) throw new Error(result.entries?.[0]?.status || "Trash item could not be restored");
        uiNotice("Trash item restored.", "ok");
        break;
      }
      case "delete-trash":
        uiConfirm("Delete Trash Transaction", "Permanently delete every remaining item in this trash transaction? This cannot be undone.", "delete-trash", { id: data.id });
        return;
      case "delete-trash-item":
        uiConfirm("Delete Trash Item", "Permanently delete this item from Trash? This cannot be undone.", "delete-trash-item", { id: data.id, payload: data.payload });
        return;
      case "clear-published-filters":
        uiState.published.context = "";
        uiState.published.size = "";
        uiState.published.page = 1;
        break;
      case "published-page":
        uiState.published.page = Math.max(1, Number(data.publishedPage) || 1);
        break;
      case "clear-browser-filters":
        Object.assign(uiState.browser, { browser: "", target: "", context: "", active: "" });
        break;
      case "clear-automation-filters":
        Object.assign(uiState.automation, { context: "", page: 1 });
        break;
      case "automation-page":
        uiState.automation.page = Math.max(1, Number(data.automationPage) || 1);
        break;
      case "replay-cdp":
        uiNotice("CDP replay started.", "info");
        void replayAdminAction(data.id, "cdp_call", data.index).catch(error => uiNotice(`CDP replay failed: ${String(error?.message || error)}`));
        return;
      case "replay-automation":
        uiNotice("Automation replay started.", "info");
        void replayAdminAction(data.id, "desktop_auto").catch(error => uiNotice(`Automation replay failed: ${String(error?.message || error)}`));
        return;
      case "new-memory": {
        const p = serverConfig();
        const sessions = all("SELECT id FROM contexts WHERE server_id=? AND handle LIKE 'ctx_%' ORDER BY id DESC", p.id).map(row => Number(row.id));
        const workspaces = all("SELECT name FROM roots WHERE server_id=? ORDER BY name COLLATE NOCASE", p.id).map(row => String(row.name));
        let scope = ["global", "session", "workspace"].includes(uiState.memory.scope)
          ? uiState.memory.scope : (sessions.length ? "session" : (workspaces.length ? "workspace" : "global"));
        if (scope === "session" && !sessions.length) scope = workspaces.length ? "workspace" : "global";
        if (scope === "workspace" && !workspaces.length) scope = sessions.length ? "session" : "global";
        const selectedContext = Number(uiState.memory.context) || 0;
        const selectedWorkspace = String(uiState.memory.workspace || "");
        uiState.dialog = { kind: "memory", data: {
          id: "", scope,
          context: scope === "session" ? (sessions.includes(selectedContext) ? selectedContext : (sessions[0] || "")) : "",
          workspace: scope === "workspace" ? (workspaces.includes(selectedWorkspace) ? selectedWorkspace : (workspaces[0] || "")) : "",
          sessions, workspaces, key: "", value_text: "", json: false, ttl_seconds: 0, form_warning: "",
        } };
        break;
      }
      case "edit-memory": {
        memoryPurgeExpired();
        const row = one("SELECT * FROM memories WHERE id=?", Number(data.id));
        if (!row) throw new Error("Memory not found");
        const scope = memoryPublicScope(row);
        uiState.dialog = { kind: "memory", data: {
          ...row, scope, owner_name: scope === "global" ? GLOBAL_MEMORY_OWNER_NAME : String(row.owner_name), json: Number(row.is_json ?? 1) === 1,
          value_text: Number(row.is_json ?? 1) === 1 ? JSON.stringify(parseJson(row.value_json, null), null, 2) : String(row.value_json || ""), form_warning: "",
        } };
        break;
      }
      case "delete-memory":
        uiConfirm("Delete Memory", "Delete this persistent memory entry?", "delete-memory", { id: data.id });
        return;
      case "load-memory":
        uiState.memory.page = 1;
        break;
      case "clear-memory-filters":
        Object.assign(uiState.memory, { page: 1, query: "", scope: "", context: "", workspace: "", from: "", to: "" });
        break;
      case "memory-page":
        uiState.memory.page = Math.max(1, Number(data.memoryPage) || 1);
        break;
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
        uiState.logs.toolQuery = "";
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
      case "terminate-process":
      case "kill-process":
        await uiInternalApi("/api/processes/kill", {
          method: "POST", body: { id: String(data.id || ""), signal: action === "kill-process" ? "SIGKILL" : "SIGTERM" },
        });
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
      case "clear-tool-calls":
        uiConfirm("Clear Tool Calls", "Delete all Tool Call records, search rows and historical tool descriptors? Process state/history is independent and is not deleted. Tool Call IDs are never reset or reused.", "clear-tool-calls");
        return;
      case "clear-sessions":
        uiConfirm("Clear Sessions", "Delete all Sessions? Running persistent processes belonging to those Sessions will be terminated. Tool Call history is preserved with its recorded Session and Workspace snapshots.", "clear-sessions");
        return;
      case "clear-workspaces":
        uiConfirm("Clear Workspaces", "Delete all configured Workspaces? Existing Sessions will move to the program-folder fallback. Files and running processes are not changed.", "clear-workspaces");
        return;
      case "clear-clients":
        uiConfirm("Clear OAuth Clients", "Delete all registered OAuth clients, authorization codes, access tokens and refresh tokens? Existing Sessions and Basic authentication are preserved.", "clear-clients");
        return;
      case "clear-database":
        uiConfirm("Clear Operational Data", "Delete Tool Calls, process history, HTTP logs, published snapshots and reset request metrics? Authentication, Sessions, Workspaces, settings and registered tools are preserved. Workspace files, certificates, commands and trash are not touched.", "clear-database");
        return;
      case "empty-trash":
        uiConfirm("Empty Trash", "Permanently delete all contents of MrMCP's single .mrmcp/trash store? This cannot be undone.", "empty-trash");
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
      case "settings-tab": {
        const tab = String(data.settingsTab || "");
        if (["network", "security", "process", "files", "goals", "search", "proxies", "notifications", "maintenance"].includes(tab)) uiState.settingsTab = tab;
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
          git_preserve_line_endings: !!values.gitPreserveLineEndings,
          exec_environment: String(values.execEnvironment || ""),
          chat_goals_enabled: values.chatGoalsEnabled == null ? chatGoalsEnabled() : !!values.chatGoalsEnabled,
          chat_goal_timeout_minutes: String(values.chatGoalTimeoutMinutes ?? chatGoalDefaultTimeout() / 60),
          chat_goal_headless: values.chatGoalHeadless == null ? getCfg("chat_goal_headless", "0") === "1" : !!values.chatGoalHeadless,
          chat_goal_disable_images: values.chatGoalDisableImages == null ? getCfg("chat_goal_disable_images", "0") === "1" : !!values.chatGoalDisableImages,
          chat_goal_stop_before_send: values.chatGoalStopBeforeSend == null ? getCfg("chat_goal_stop_before_send", "0") === "1" : !!values.chatGoalStopBeforeSend,
          chat_goal_match_on_startup: values.chatGoalMatchOnStartup == null ? getCfg("chat_goal_match_on_startup", "0") === "1" : !!values.chatGoalMatchOnStartup,
          chat_goal_windows_hide: String(values.chatGoalWindowsHide ?? getCfg("chat_goal_windows_hide", "auto")),
          search_configuration: String(values.searchConfiguration ?? Deno.readTextFileSync(SEARCH_PATH)),
          proxy_configuration: String(values.proxyConfiguration ?? Deno.readTextFileSync(PROXIES_PATH)),
          text_encoding_detection: String(values.textEncodingDetection ?? "sample"),
          tool_call_storage: String(values.toolCallStorage || "disk"),
          tool_call_payload_mode: String(values.toolCallPayloadMode || "payload"),
          tool_call_retention_hours: String(values.toolCallRetentionHours ?? "0"),
          tool_call_memory_retention_minutes: String(values.toolCallMemoryRetentionMinutes ?? "60"),
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
      case "save-telegram": {
        const telegram_bot_token = String(values.telegramBotToken ?? uiState.telegramDraft ?? "").trim();
        const warning = telegramTokenWarning(telegram_bot_token);
        if (warning) {
          uiState.telegramDraft = telegram_bot_token;
          queueUiRender("telegram-invalid", 0);
          return;
        }
        await uiInternalApi("/api/settings", { method: "POST", body: { telegram_bot_token } });
        uiState.telegramDraft = null;
        uiNotice("Telegram settings saved.", "ok");
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
            if (section === "telegram" && uiState.telegramDraft == null)
              uiState.telegramDraft = String(settingsProjection().telegram_bot_token || "");
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
          } else if (id === "parguments" && uiState.dialog?.kind === "prompt") {
            try { parseGuidedPromptArguments(event.value, uiState.dialog.data.name || "prompt"); uiState.dialog.data.args_warning = ""; }
            catch (error) { uiState.dialog.data.args_warning = String(error?.message || error); }
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
            if (uiState.dialog?.kind === "command" && ["cname", "cpath", "cdescription", "cdownloadUrl", "carchivePath", "cplatforms", "cdocumentationUrl"].includes(id)) {
              const d = uiState.dialog.data;
              d.form_warning = "";
              if (id === "cname") d.name_warning = await commandNameWarning(item.value, d.old_name);
              if (id === "cpath") {
                d.path_warning = ""; d.path_error = false; d.path_checked = !String(item.value || "").trim();
              }
              if (id === "cplatforms") d.platforms_warning = await commandPlatformsWarning(item.value);
              if (id === "cdownloadUrl") d.download_warning = httpUrlWarning(item.value, "Download URL");
              if (id === "cdocumentationUrl") d.documentation_warning = httpUrlWarning(item.value, "Documentation URL");
              renderDraft = true;
            }
            if (uiState.dialog?.kind === "prompt" && ["pname", "ptitle", "pdescription", "parguments", "ptemplate"].includes(id)) {
              const d = uiState.dialog.data;
              d.form_warning = "";
              if (id === "pname") d.name_warning = await guidedPromptNameWarning(item.value, d.old_name);
              if (id === "parguments") d.args_warning = "";
              if (id === "ptemplate") d.template_warning = String(item.value || "").trim() ? "" : "Template is required.";
              renderDraft = true;
            }
            if (["externalUrl", "tlsEmail", "publicIpUrls", "sslipSuffix", "acmeDirectoryUrl", "textEncodingDetection", "toolCallStorage", "toolCallPayloadMode", "toolCallRetentionHours", "toolCallMemoryRetentionMinutes"].includes(id)) renderDraft = true;
            if (["logTool", "logQuery"].includes(id)) { uiState.logs.page = 1; filterLogs = true; }
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
          else if (id === "publishedContext") { uiState.published.context = String(event.value || ""); uiState.published.page = 1; }
          else if (id === "publishedSize") { uiState.published.size = String(event.value || ""); uiState.published.page = 1; }
          else if (id === "memoryScope") {
            uiState.memory.scope = String(event.value || ""); uiState.memory.page = 1;
            if (uiState.memory.scope === "session") uiState.memory.workspace = "";
            else if (uiState.memory.scope === "workspace") uiState.memory.context = "";
            else if (uiState.memory.scope === "global") { uiState.memory.context = ""; uiState.memory.workspace = ""; }
          }
          else if (id === "memoryContext") { uiState.memory.context = String(event.value || ""); uiState.memory.workspace = ""; uiState.memory.scope = uiState.memory.context ? "session" : uiState.memory.scope; uiState.memory.page = 1; }
          else if (id === "memoryWorkspace") { uiState.memory.workspace = String(event.value || ""); uiState.memory.context = ""; uiState.memory.scope = uiState.memory.workspace ? "workspace" : uiState.memory.scope; uiState.memory.page = 1; }
          else if (id === "memoryFrom") { uiState.memory.from = String(event.value || ""); uiState.memory.page = 1; }
          else if (id === "memoryTo") { uiState.memory.to = String(event.value || ""); uiState.memory.page = 1; }
          else if (id === "browserName") uiState.browser.browser = String(event.value || "");
          else if (id === "browserTarget") uiState.browser.target = String(event.value || "");
          else if (id === "browserContext") uiState.browser.context = String(event.value || "");
          else if (id === "browserActive") uiState.browser.active = String(event.value || "");
          else if (id === "automationContext") { uiState.automation.context = String(event.value || ""); uiState.automation.page = 1; }
          else if (id === "debugMethod") uiState.debug.method = String(event.value || "");
          else if (id === "debugStatus") uiState.debug.status = String(event.value || "");
          else if (id === "commandPageSize") { uiState.commands.pageSize = Number(event.value) || 5; uiState.commands.page = 1; }
          else if (id === "commandFilter") { uiState.commands.filter = String(event.value || ""); uiState.commands.page = 1; }
          else if (id === "promptPageSize") { uiState.prompts.pageSize = Number(event.value) || 5; uiState.prompts.page = 1; }
          else if (["rpath", "cpath", "parguments"].includes(id)) return;
          queueUiRender(`change:${id}`);
          return;
        }
        case "enter":
          if (["logTool", "logQuery"].includes(event.id)) {
            uiState.logs.page = 1;
            if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
            uiLogFilterTimer = null;
          } else if (event.id === "commandQuery") uiState.commands.page = 1;
          else if (event.id === "promptQuery") uiState.prompts.page = 1;
          else if (event.id === "memoryQuery") uiState.memory.page = 1;
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
            d.platforms_warning = await commandPlatformsWarning(values.cplatforms);
            if (d.name_warning || d.path_error || d.download_warning || d.documentation_warning || d.platforms_warning) {
              queueUiRender("submit:commandForm-invalid", 0);
              return;
            }
            try {
              await uiInternalApi("/api/commands/save", { method: "POST", body: {
                old_name: values.coldName, name: values.cname, path: values.cpath,
                description: values.cdescription, download_url: values.cdownloadUrl,
                archive_path: values.carchivePath, platforms: parseYaml(values.cplatforms || "{}"),
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
          } else if (event.formId === "promptForm") {
            const d = uiState.dialog?.kind === "prompt" ? uiState.dialog.data : null;
            if (!d) return;
            d.name_warning = await guidedPromptNameWarning(values.pname, values.poldName);
            d.template_warning = String(values.ptemplate || "").trim() ? "" : "Template is required.";
            let args = [];
            try { args = parseGuidedPromptArguments(values.parguments, values.pname || "prompt"); d.args_warning = ""; }
            catch (error) { d.args_warning = String(error?.message || error); }
            d.form_warning = "";
            if (d.name_warning || d.args_warning || d.template_warning) {
              queueUiRender("submit:promptForm-invalid", 0);
              return;
            }
            try {
              await uiInternalApi("/api/prompts/save", { method: "POST", body: {
                old_name: values.poldName, name: values.pname, title: values.ptitle,
                description: values.pdescription, arguments: args, template: values.ptemplate,
              } });
              uiState.dialog = null;
              uiState.prompts.page = 1;
              uiNotice(`Guided prompt ${String(values.pname || "").trim()} saved.`, "ok");
            } catch (error) {
              d.form_warning = String(error?.message || error);
              queueUiRender("submit:promptForm-warning", 0);
              return;
            }
          } else if (event.formId === "memoryForm") {
            const d = uiState.dialog?.kind === "memory" ? uiState.dialog.data : null;
            if (!d) return;
            d.form_warning = "";
            try {
              const p = serverConfig();
              const id = Number(values.mid) || 0;
              const key = String(values.mkey || "").trim();
              const value = String(values.mvalue ?? "");
              const isJson = !!values.mjson;
              const ttlSeconds = Number(values.mttl || 0);
              let owner, replaceId = 0;
              if (id) {
                const row = one("SELECT * FROM memories WHERE id=?", id);
                if (!row) throw new Error("Memory not found");
                owner = memoryOwnerFromRow(row);
                replaceId = Number(row.id);
              } else {
                const scope = String(values.mscope || d.scope || "");
                if (scope === "global") {
                  owner = { scope, storage_scope: GLOBAL_MEMORY_STORAGE_SCOPE, owner_id: GLOBAL_MEMORY_OWNER_ID, owner_name: GLOBAL_MEMORY_OWNER_NAME, workspace: null, session_id: null };
                } else if (scope === "session") {
                  const contextId = Number(values.mcontext || d.context) || 0;
                  const context = one("SELECT id FROM contexts WHERE server_id=? AND id=? AND handle LIKE 'ctx_%'", p.id, contextId);
                  if (!context) throw new Error("Select an existing Session");
                  owner = { scope, storage_scope: "session", owner_id: Number(context.id), owner_name: `Session #${context.id}`, workspace: null, session_id: Number(context.id) };
                } else if (scope === "workspace") {
                  const workspace = String(values.mworkspace || d.workspace || "").trim();
                  const root = one("SELECT id,name FROM roots WHERE server_id=? AND name=?", p.id, workspace);
                  if (!root) throw new Error("Select an existing Workspace");
                  owner = { scope, storage_scope: "workspace", owner_id: Number(root.id), owner_name: String(root.name), workspace: String(root.name), session_id: null };
                } else throw new Error("Select Global, Session or Workspace scope");
                if (one("SELECT id FROM memories WHERE scope=? AND owner_id=? AND key=?", owner.storage_scope || memoryStorageScope(owner.scope), owner.owner_id, key))
                  throw new Error("A Memory with this key already exists for the selected owner. Use View / Edit instead.");
              }
              memorySetValue(p, null, {
                scope: owner.scope, key, value, json: isJson, ttl_seconds: ttlSeconds,
              }, { owner, ...(replaceId ? { replace_id: replaceId } : {}) });
              uiState.dialog = null;
              uiState.memory.page = 1;
              uiNotice(`Memory ${key} saved.`, "ok");
            } catch (error) {
              d.form_warning = String(error?.message || error);
              queueUiRender("submit:memoryForm-warning", 0);
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

  async function drainUiInputs() {
    if (uiInputRunning) return;
    uiInputRunning = true;
    try {
      while (uiInputQueue.length) {
        const message = uiInputQueue.shift();
        uiInputDepth += 1;
        uiInputRenderDelay = null;
        try { await handleUiInput(message); }
        finally {
          uiInputDepth -= 1;
          const delay = uiInputRenderDelay ?? 0;
          uiInputRenderDelay = null;
          if (uiRenderQueued) queueUiRender("input-complete", delay);
        }
      }
    } catch (error) {
      uiNotice(String(error?.message || error));
      queueUiRender("input-transport-error", 0);
    } finally {
      uiInputRunning = false;
      if (uiInputQueue.length) void drainUiInputs();
    }
  }
  function enqueueUiInput(message) {
    uiRenderConnected = true;
    uiInputQueue.push(message);
    void drainUiInputs();
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
      if (x.proxy_configuration != null && String(x.proxy_configuration) !== Deno.readTextFileSync(PROXIES_PATH)) {
        const tmp = PROXIES_PATH + ".tmp"; await Deno.writeTextFile(tmp, String(x.proxy_configuration)); await Deno.rename(tmp, PROXIES_PATH); proxySourceCache.clear();
      }
      if (x.search_configuration != null && String(x.search_configuration) !== Deno.readTextFileSync(SEARCH_PATH)) {
        const tmp = SEARCH_PATH + ".tmp"; await Deno.writeTextFile(tmp, String(x.search_configuration)); await Deno.rename(tmp, SEARCH_PATH);
      }
      const changedSettings = new Set();
      const saveSetting = (key, value) => {
        if (getCfg(key, null) === String(value)) return false;
        setCfg(key, value);
        changedSettings.add(key);
        return true;
      };
      for (const key of ["external_url", "tls_email", "sslip_suffix", "acme_directory_url", "telegram_bot_token"])
        if (x[key] != null) saveSetting(key, x[key]);
      for (const key of ["desktop_notifications_session", "desktop_notifications_workspace", "desktop_notifications_tool_call"])
        if (x[key] != null) saveSetting(key, x[key] ? "1" : "0");
      if (x.chat_goals_enabled != null && saveSetting("chat_goals_enabled", x.chat_goals_enabled ? "1" : "0")) {
        run("UPDATE contexts SET goal_revision=goal_revision+1,goal_error=CASE WHEN goal_status='matching' THEN 'Matching was interrupted. Call chat_set_goal again to retry matching.' ELSE goal_error END,goal_status=CASE WHEN goal_status='sending' THEN 'delivery_uncertain' WHEN goal_status='matching' THEN 'error' ELSE goal_status END WHERE goal_text<>''");
      }
      if (x.chat_goal_timeout_minutes != null) saveSetting("chat_goal_timeout_minutes", String(Number(x.chat_goal_timeout_minutes)));
      if (x.chat_goal_headless != null) saveSetting("chat_goal_headless", x.chat_goal_headless ? "1" : "0");
      if (x.chat_goal_disable_images != null) saveSetting("chat_goal_disable_images", x.chat_goal_disable_images ? "1" : "0");
      if (x.chat_goal_stop_before_send != null) saveSetting("chat_goal_stop_before_send", x.chat_goal_stop_before_send ? "1" : "0");
      if (x.chat_goal_match_on_startup != null) saveSetting("chat_goal_match_on_startup", x.chat_goal_match_on_startup ? "1" : "0");
      if (x.chat_goal_windows_hide != null) saveSetting("chat_goal_windows_hide", String(x.chat_goal_windows_hide));
      if (changedSettings.has("chat_goals_enabled") || changedSettings.has("chat_goal_timeout_minutes")) chatGoalConfigure();
      if (x.inherit_system_path != null) saveSetting("inherit_system_path", x.inherit_system_path ? "1" : "0");
      if (x.git_preserve_line_endings != null) saveSetting("git_preserve_line_endings", x.git_preserve_line_endings ? "1" : "0");
      if (x.text_encoding_detection != null) saveSetting("text_encoding_detection", String(x.text_encoding_detection));
      if (x.tool_call_retention_hours != null) {
        if (saveSetting("tool_call_retention_hours", String(Number(x.tool_call_retention_hours)))) requestToolCallRetentionSweep();
      }
      if (x.tool_call_storage != null) saveSetting("tool_call_storage", String(x.tool_call_storage).toLowerCase());
      if (x.tool_call_payload_mode != null) saveSetting("tool_call_payload_mode", String(x.tool_call_payload_mode).toLowerCase());
      if (x.tool_call_memory_retention_minutes != null) {
        if (saveSetting("tool_call_memory_retention_minutes", String(Number(x.tool_call_memory_retention_minutes)))) requestToolCallRetentionSweep();
      }
      if (x.exec_environment != null) {
        try { configuredExecEnvironment(x.exec_environment); }
        catch (error) { return json({ error: String(error?.message || error) }, 400); }
        saveSetting("exec_environment", String(x.exec_environment));
      }
      if (Array.isArray(x.public_ip_urls)) saveSetting("public_ip_urls_json", JSON.stringify(
        x.public_ip_urls.map(String).map(value => value.trim()).filter(value => /^https:\/\//i.test(value)),
      ));
      if (["external_url", "tls_email", "sslip_suffix", "acme_directory_url", "public_ip_urls_json"].some(key => changedSettings.has(key))) {
        await restartMcp();
        automaticRenewal().catch(() => {});
      }
      return json({ ok: true });
    }
    if (u.pathname === "/api/database/clear" && req.method === "POST") {
      try { return json(await clearOperationalDatabase()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
    }
    if (u.pathname === "/api/trash/empty" && req.method === "POST") {
      try { return json(await emptyManagedTrash()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
    }
    if (u.pathname === "/api/trash/restore" && req.method === "POST") {
      try { const x = await bodyJson(req); return json(await restoreManagedTrash(x.trash_id, x.payload)); }
      catch (error) { return json({ error: String(error?.message || error) }, 400); }
    }
    if (u.pathname === "/api/trash/delete" && req.method === "POST") {
      try { const x = await bodyJson(req); return json(await deleteManagedTrash(x.trash_id, x.payload)); }
      catch (error) { return json({ error: String(error?.message || error) }, 400); }
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
      changed({ ui: ["roots", "sessions", "memory", "dashboard"] }, "workspace-save");
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
      changed({ ui: ["roots", "sessions", "memory", "dashboard"] }, "workspace-delete");
      return json({ ok: true });
    }
    if (u.pathname === "/api/roots/clear" && req.method === "POST") {
      try { return json(clearWorkspaces()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
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
      changed({ ui: ["sessions", "roots", "logs", "memory", "dashboard", "oauth"] }, "session-delete");
      for (const key of [...jsKernels.keys()])
        if (key.startsWith(`${p.id}:${context.handle}:`)) destroyJsKernel(key, "context deleted");
      return json({ ok: true });
    }
    if (u.pathname === "/api/context/clear" && req.method === "POST") {
      try { return json(await clearSessions()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
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
      changed({ serverTools: true, ui: ["commands", "dashboard", "endpoints"] }, "custom-tools");
      return json({ ok: true });
    }
    if (u.pathname === "/api/tools/delete" && req.method === "POST") {
      const x = await bodyJson(req);
      run("DELETE FROM custom_tools WHERE id=?", x.id);
      changed({ serverTools: true, ui: ["commands", "dashboard", "endpoints"] }, "custom-tools");
      return json({ ok: true });
    }
    if (u.pathname === "/api/mcp/self-test" && req.method === "GET")
      return json(mcpSelfTest(serverConfig()));
    if (u.pathname === "/api/commands" && req.method === "GET") return json(await commandCatalog({
      query: u.searchParams.get("q") || "",
      page: u.searchParams.get("page") || 1,
      page_size: u.searchParams.get("page_size") || 5,
      include_missing: u.searchParams.get("include_missing") !== "0",
      filter: u.searchParams.get("filter") || "",
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
      let row;
      try { row = normalizeCommandEntry({
        logical_name: name,
        path: target.relative,
        description: x.description,
        download_url: x.download_url,
        archive_path: x.archive_path, platforms: x.platforms,
        documentation_url: x.documentation_url,
      }); await validateCommandEntry(row); } catch (e) { return json({ error: e.message }, 400); }
      const rows = await readCommandConfig(), oldKey = old.toLowerCase(), key = name.toLowerCase();
      if (rows.some(existing => existing.name.toLowerCase() === key && existing.name.toLowerCase() !== oldKey)) return json({ error: "Command name already exists" }, 409);
      const index = rows.findIndex(existing => existing.name.toLowerCase() === oldKey || (!old && existing.name.toLowerCase() === key));
      if (index >= 0) rows[index] = row; else rows.push(row);
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
    if (u.pathname === "/api/prompts" && req.method === "GET") return json(await guidedPromptCatalog({
      query: u.searchParams.get("q") || "",
      page: u.searchParams.get("page") || 1,
      page_size: u.searchParams.get("page_size") || 5,
    }));
    if (u.pathname === "/api/prompts/save" && req.method === "POST") {
      const x = await bodyJson(req), name = String(x.name || "").trim(), old = String(x.old_name || "").trim();
      const nameWarning = await guidedPromptNameWarning(name, old);
      if (nameWarning) return json({ error: nameWarning, field: "name" }, 400);
      let row;
      try { row = normalizeGuidedPromptEntry({ name, title: x.title, description: x.description, arguments: x.arguments, template: x.template }); }
      catch (error) { return json({ error: String(error?.message || error) }, 400); }
      const rows = await readGuidedPromptConfig(), oldKey = old.toLowerCase(), key = name.toLowerCase();
      if (rows.some(existing => existing.name.toLowerCase() === key && existing.name.toLowerCase() !== oldKey)) return json({ error: "Prompt name already exists" }, 409);
      const index = rows.findIndex(existing => existing.name.toLowerCase() === oldKey || (!old && existing.name.toLowerCase() === key));
      if (index >= 0) rows[index] = row; else rows.push(row);
      await writeGuidedPromptConfig(rows);
      emitUiChange(["prompts"], "prompts");
      return json({ ok: true, config_file: GUIDED_PROMPTS_PATH });
    }
    if (u.pathname === "/api/prompts/delete" && req.method === "POST") {
      const x = await bodyJson(req), key = String(x.name || "").toLowerCase();
      await writeGuidedPromptConfig((await readGuidedPromptConfig()).filter(row => row.name.toLowerCase() !== key));
      emitUiChange(["prompts"], "prompts");
      return json({ ok: true });
    }
    if (u.pathname === "/api/commands/download" && req.method === "POST") {
      const x = await bodyJson(req), key = String(x.name || "").toLowerCase();
      const configured = (await readCommandConfig()).find(entry => entry.name.toLowerCase() === key);
      const row = configured ? { ...configured, ...commandPlatform(configured) } : null;
      if (!row) return json({ error: "Command not found" }, 404);
      if (!row.supported) return json({ error: `Command does not support ${Deno.build.os}-${Deno.build.arch}` }, 400);
      if (!row.download_url) return json({ error: "No download URL configured" }, 400);
      let target, temporary;
      try {
        const response = await fetch(row.download_url, { redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
        if (!/^https?:$/.test(new URL(response.url).protocol)) throw new Error("Download redirected to an unsupported URL scheme");
        const filename = responseFilename(response);
        const zipped = filename.toLowerCase().endsWith(".zip") || /(?:^|\b)(?:application|binary)\/(?:x-)?zip(?:\b|$)/i.test(response.headers.get("content-type") || "");
        const tarred = /\.(?:tar\.gz|tgz|tar)$/i.test(filename);
        let archiveEntry = null, content = null;
        if (zipped || tarred) {
          const declared = Number(response.headers.get("content-length") || 0);
          if (declared > 512 * 1024 * 1024) throw new Error("Archive download is too large");
          const archive = await searchReadResponse(response, 512 * 1024 * 1024);
          if (archive.byteLength > 512 * 1024 * 1024) throw new Error("Archive download is too large");
          if (zipped) { archiveEntry = selectZipCommandEntry(archive, row); content = extractZipEntry(archive, archiveEntry); }
          else {
            const tar = /\.(?:tar\.gz|tgz)$/i.test(filename) ? new Uint8Array(gunzipSync(archive, { maxOutputLength: 536870912 })) : archive;
            archiveEntry = selectCommandArchiveEntry(tarCommandEntries(tar), row);
            content = tar.subarray(archiveEntry.offset, archiveEntry.offset + archiveEntry.size);
          }
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
          CASE WHEN json_valid(d.request_body) THEN json_extract(d.request_body,'$.params.arguments.chat_session') END,
          CASE WHEN json_valid(d.response_body) THEN json_extract(d.response_body,'$.result.structuredContent.chat_session') END,
          ''
        ) context_handle
        FROM debug_logs d
      )
      SELECT d.id,d.ts,d.method,d.path,d.status,d.duration_ms,d.remote_addr,
        COALESCE(w.context_id,c.id,0) context_id,c.oauth_client_id client_id,w.root_name workspace_name,
        (SELECT COUNT(*) FROM debug_logs ip WHERE ip.remote_addr=d.remote_addr) remote_count,
        substr(d.request_body,1,180) request_preview,substr(d.error,1,180) error_preview
        FROM enriched d
        LEFT JOIN debug_log_workspaces w ON w.debug_log_id=d.id
        LEFT JOIN contexts c ON c.handle=d.context_handle
        WHERE (?='' OR d.method=?) AND (?='' OR CAST(d.status AS TEXT)=?)
        AND (?='' OR d.method||d.path||d.request_headers||d.request_body||d.response_headers||d.response_body||d.error||COALESCE(c.oauth_client_id,'')||COALESCE(CAST(COALESCE(w.context_id,c.id) AS TEXT),'')||COALESCE(w.root_name,'') LIKE ?)
        ORDER BY d.id DESC LIMIT ?`,
        method, method, status, status, q, like, limit));
    }
    let dm = u.pathname.match(/^\/api\/debug\/(\d+)$/);
    if (dm && req.method === "GET") return json(one(`WITH enriched AS (
      SELECT d.*, COALESCE(
        CASE WHEN json_valid(d.request_body) THEN json_extract(d.request_body,'$.params.arguments.chat_session') END,
        CASE WHEN json_valid(d.response_body) THEN json_extract(d.response_body,'$.result.structuredContent.chat_session') END,
        ''
      ) context_handle
      FROM debug_logs d WHERE d.id=?
    )
    SELECT d.*,COALESCE(w.context_id,c.id,0) context_id,c.oauth_client_id client_id,w.root_name workspace_name,w.root_path workspace_path,
      (SELECT COUNT(*) FROM debug_logs ip WHERE ip.remote_addr=d.remote_addr) remote_count
      FROM enriched d
      LEFT JOIN debug_log_workspaces w ON w.debug_log_id=d.id
      LEFT JOIN contexts c ON c.handle=d.context_handle`, Number(dm[1])) || { error: "Not found" });
    if (u.pathname === "/api/debug/clear" && req.method === "POST") {
      db.exec("BEGIN IMMEDIATE");
      try {
        const cleared = deleteDebugLogRecords();
        db.exec("COMMIT");
        changed({ ui: ["debug"] }, "http-log-clear");
        return json({ ok: true, cleared });
      } catch (error) {
        db.exec("ROLLBACK");
        return json({ error: String(error?.message || error) }, 500);
      }
    }
    if (u.pathname === "/api/logs" && req.method === "GET") {
      const p = serverConfig();
      const toolQuery = (u.searchParams.get("tool") || "").trim();
      const q = (u.searchParams.get("q") || "").trim();
      const contextId = Math.max(0, Number(u.searchParams.get("context")) || 0);
      const status = u.searchParams.get("status") || "";
      const requestedPage = Math.max(1, Math.floor(Number(u.searchParams.get("page")) || 1));
      let page = requestedPage;
      const pageSize = Math.max(10, Math.min(Number(u.searchParams.get("page_size")) || 25, 100));
      let offset;
      let rows, total;
      const toolLike = `%${toolQuery}%`, toolFilter = `(?='' OR l.tool LIKE ? COLLATE NOCASE OR (
        l.tool LIKE 'exec%' AND EXISTS (
          SELECT 1 FROM process_runs pr
          WHERE l.tool IN ('exec','exec_start') AND pr.log_id=l.id
            AND (COALESCE(json_extract(CASE WHEN json_valid(pr.command_json) THEN pr.command_json ELSE '{}' END,'$.catalog_name'),'') LIKE ? COLLATE NOCASE
              OR COALESCE(json_extract(CASE WHEN json_valid(pr.command_json) THEN pr.command_json ELSE '{}' END,'$.program'),'') LIKE ? COLLATE NOCASE)
        )
      ))`;
      if (q && fts) {
        try {
          const hits = `WITH hits(log_id) AS (
            SELECT rowid FROM main.logs_fts WHERE logs_fts MATCH ?
            UNION ALL
            SELECT rowid FROM logs_fts_memory WHERE logs_fts_memory MATCH ?
          )`;
          total = one(`${hits} SELECT COUNT(*) n FROM hits h JOIN logs l ON l.id=h.log_id
            WHERE (?=0 OR l.context_id=?) AND (?='' OR l.status=?) AND ${toolFilter}`,
            q, q, contextId, contextId, status, status, toolQuery, toolLike, toolLike, toolLike)?.n || 0;
          page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
          offset = (page - 1) * pageSize;
          rows = all(`${hits} SELECT l.id,l.started_at,l.completed_at,l.context_id,l.root_id,l.root_name,l.tool,l.status,l.duration_ms,l.mcp_request_json,l.progress_requested,l.payload_mode,l.storage
            FROM hits h JOIN logs l ON l.id=h.log_id
            WHERE (?=0 OR l.context_id=?) AND (?='' OR l.status=?) AND ${toolFilter}
            ORDER BY l.started_at DESC,l.id DESC LIMIT ? OFFSET ?`,
            q, q, contextId, contextId, status, status, toolQuery, toolLike, toolLike, toolLike, pageSize, offset);
        } catch {}
      }
      if (!rows) {
        const like = `%${q}%`;
        total = one(`SELECT COUNT(*) n FROM logs l WHERE (?=0 OR l.context_id=?) AND (?='' OR l.status=?)
          AND ${toolFilter}
          AND (?='' OR COALESCE(CAST(l.context_id AS TEXT),'')||COALESCE(l.context_handle,'')||COALESCE(l.tool,'')||COALESCE(l.payload_mode,'')||COALESCE(l.mcp_request_json,'')||COALESCE(l.mcp_response_json,'')||COALESCE(l.error,'') LIKE ?)`,
          contextId, contextId, status, status, toolQuery, toolLike, toolLike, toolLike, q, like)?.n || 0;
        page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
        offset = (page - 1) * pageSize;
        rows = all(`SELECT l.id,l.started_at,l.completed_at,l.context_id,l.root_id,l.root_name,l.tool,l.status,l.duration_ms,l.mcp_request_json,l.progress_requested,l.payload_mode,l.storage FROM logs l
          WHERE (?=0 OR l.context_id=?) AND (?='' OR l.status=?)
          AND ${toolFilter}
          AND (?='' OR COALESCE(CAST(l.context_id AS TEXT),'')||COALESCE(l.context_handle,'')||COALESCE(l.tool,'')||COALESCE(l.payload_mode,'')||COALESCE(l.mcp_request_json,'')||COALESCE(l.mcp_response_json,'')||COALESCE(l.error,'') LIKE ?)
          ORDER BY l.started_at DESC,l.id DESC LIMIT ? OFFSET ?`,
          contextId, contextId, status, status, toolQuery, toolLike, toolLike, toolLike, q, like, pageSize, offset);
      }
      const processByLog = new Map([...processes.values()]
        .filter(record => record.log_id && ["starting", "running"].includes(record.status))
        .map(record => [record.log_id, record]));
      rows = rows.map(row => {
        const process = processByLog.get(row.id), control = activeCallControls.get(row.id);
        const input = mcpToolArgsFromPacket(row.mcp_request_json), call_preview = toolCallModeKeepsJson(String(row.payload_mode || "payload")) ? compactToolCallPreview(p, row.tool, input) : "";
        const { mcp_request_json: _mcpRequestJson, ...summary } = row;
        return { ...summary, call_preview, progress_requested: !!row.progress_requested,
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
      const detail = one(`SELECT id,started_at,completed_at,server_id,server_name,tool,status,mcp_request_json,mcp_response_json,
        error,duration_ms,context_id,context_handle,progress_requested,payload_mode,storage FROM logs WHERE id=?`, logId);
      if (!detail) return json({ error: "Not found" });
      const descriptor = one("SELECT descriptor_json FROM tool_call_descriptor_records WHERE log_id=?", logId);
      if (descriptor?.descriptor_json) {
        detail.tool_descriptor = parseJson(descriptor.descriptor_json, null);
        const currentDescriptor = serverToolDescriptor(serverConfig(), detail.tool);
        detail.tool_descriptor_current_available = !!currentDescriptor;
        detail.tool_descriptor_matches_current = !!currentDescriptor && descriptorJson(currentDescriptor) === descriptor.descriptor_json;
      }
      let process = [...processes.values()].find(record => record.log_id === logId);
      if (!process && ["exec", "exec_start"].includes(detail.tool)) {
        const historicalProcess = one("SELECT * FROM process_runs WHERE log_id=?", logId);
        if (historicalProcess) process = processHistoryAdminView(historicalProcess);
      }
      detail.progress_requested = !!detail.progress_requested;
      if (process) detail.process = process.output_readers ? processAdminView(process) : process;
      return json(detail);
    }
    if (u.pathname === "/api/logs/delete" && req.method === "POST") {
      const x = await bodyJson(req);
      if (x.id) {
        const id = Number(x.id);
        deleteToolCallRecordById(id);
      }
      return json({ ok: true });
    }
    if (u.pathname === "/api/logs/clear" && req.method === "POST") {
      try { return json(await clearToolCalls()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
    }
    if (u.pathname === "/api/oauth/revoke-client" && req.method === "POST") {
      const x = await bodyJson(req);
      run("DELETE FROM oauth_tokens WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_refresh_tokens WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_codes WHERE client_id=?", x.client_id);
      run("DELETE FROM oauth_clients WHERE client_id=?", x.client_id);
      changed({ ui: ["oauth", "dashboard"] }, "oauth-client-revoked");
      return json({ ok: true });
    }
    if (u.pathname === "/api/oauth/clear" && req.method === "POST") {
      try { return json(clearOAuthClients()); }
      catch (error) { return json({ error: String(error?.message || error) }, 500); }
    }
    return json({ error: "Not found" }, 404);
  }

  // Eta renders server-side only. Tauriless serves the complete local UI through its asset protocol.
  const UI_SCRIPT_NONCE = GUI_RUNTIME ? randomToken() : "";
  const GUI_LOGO_DATA_URL = GUI_RUNTIME
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(Deno.readTextFileSync(join(ASSETS_DIR, "mrmcp-logo.svg")))}`
    : "";
  const GUI_MORPHLEX_JS = GUI_RUNTIME
    ? Deno.readTextFileSync(join(ASSETS_DIR, "morphlex.js")).replace(/\nexport \{\n  morphInner,\n  morphDocument,\n  morph\n\};[\s\S]*$/, "")
    : "";
  const GUI_JSONEDITOR_JS = GUI_RUNTIME ? Deno.readTextFileSync(join(ASSETS_DIR, "jsoneditor", "jsoneditor.min.js")) : "";
  const GUI_JSONEDITOR_ICON_DATA_URL = GUI_RUNTIME
    ? `data:image/svg+xml;base64,${Buffer.from(Deno.readFileSync(join(ASSETS_DIR, "jsoneditor", "img", "jsoneditor-icons.svg"))).toString("base64")}`
    : "";
  const GUI_JSONEDITOR_CSS = GUI_RUNTIME
    ? Deno.readTextFileSync(join(ASSETS_DIR, "jsoneditor", "jsoneditor.min.css")).replaceAll("./img/jsoneditor-icons.svg", GUI_JSONEDITOR_ICON_DATA_URL)
    : "";
  const UI_CSP = `default-src 'self';base-uri 'none';object-src 'none';frame-ancestors 'none';form-action 'self';style-src 'unsafe-inline';script-src 'self' 'nonce-${UI_SCRIPT_NONCE}';connect-src 'self' ipc: http://ipc.localhost;img-src 'self' data:`;
  const UI_TEMPLATE = GUI_RUNTIME ? String.raw`<!doctype html><html><head><meta charset=utf-8>
<meta http-equiv="Content-Security-Policy" content="${UI_CSP}">
<meta name=viewport content="width=device-width,initial-scale=1"><link rel=icon href="${GUI_LOGO_DATA_URL}"><title>MrMCP</title><style>${GUI_JSONEDITOR_CSS}

:root{font:14px system-ui;color:#e8e8e8;background:#101114}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding-top:54px}header{position:fixed;inset:0 0 auto 0;z-index:1000;height:54px;display:flex;align-items:center;padding:0 18px;background:#17191e;border-bottom:1px solid #292c33}header b{font-size:18px}.brand{display:flex;align-items:center;gap:8px}.brand-mark{display:block;width:32px;height:32px;flex:0 0 32px}.status{margin-left:auto;color:#8b949e;display:flex;gap:10px;align-items:center;font-size:12px;white-space:nowrap;min-width:0}.status-group{display:inline-flex;align-items:center;gap:3px}.status-link{cursor:pointer;border-radius:4px;padding:2px 3px;margin:-2px -3px}.status-link:hover{background:#252a33;text-decoration:underline}.status-ports{color:#c5cad3}.status-sessions{color:#9ecbff}.status-total{color:#9ecbff}#app>aside{position:fixed;top:54px;bottom:0;width:170px;background:#15171b;padding:12px;border-right:1px solid #292c33;overflow:auto}#app>aside button{display:flex;align-items:center;gap:4px;width:100%;text-align:left;white-space:nowrap;margin:3px 0;padding-left:6px;padding-right:6px;background:transparent;border:0}#app>aside button.nav-active{background:#252a33;color:#fff;font-weight:650;border-left:3px solid #3984e8;padding-left:6px}main{margin-left:170px;padding:16px;max-width:1500px}.page{display:block}.notice-balloon{position:fixed;top:64px;right:16px;z-index:1900;max-width:min(520px,calc(100vw - 32px));padding:10px 12px;border:1px solid #7d3f47;border-radius:9px;background:#25191b;color:#ffb7bf;box-shadow:0 8px 28px #0008}.notice-balloon.info{border-color:#365a7d;background:#16202b;color:#a9d5ff}.notice-balloon.ok{border-color:#356849;background:#16241b;color:#9ce8b1}button,input,select,textarea{font:inherit;color:#eee;background:#22252b;border:1px solid #3a3e47;border-radius:6px;padding:7px 9px}button{cursor:pointer}button:hover{background:#2d3139}.danger{color:#ff8585}.primary{background:#2459a8}.debug-toggle{font-weight:750;min-width:190px}.debug-toggle.enabled{background:#173f24;border-color:#347a49;color:#9ce8b1}.debug-toggle.disabled{background:#421d21;border-color:#7d3f47;color:#ffb7bf}.debug-toggle.enabled:hover{background:#20512f}.debug-toggle.disabled:hover{background:#53262b}.small{padding:4px 8px;font-size:12px}.spinner{display:inline-block;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.settings-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px;padding-bottom:10px;border-bottom:1px solid #292c33}.settings-tabs button{background:#1b1e24;border-color:#30343d}.settings-tabs button.active{background:#2459a8;border-color:#3984e8;color:#fff;font-weight:650}.settings-layout{display:block}.settings-main,.settings-side{min-width:0}.settings-side{position:static}.settings-layout .card{max-width:980px}.settings-layout .card h3{margin-top:0}.settings-main input:not([type=checkbox]){width:100%}.settings-main textarea{min-height:96px}.card{background:#181a1f;border:1px solid #2c3037;border-radius:10px;padding:14px;margin-bottom:10px}.tls-alert{border:2px solid #b94a4a;background:#241718}.tls-good{border:2px solid #347a49}.tls-error{max-height:180px;background:#160909}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:180px}.urlrow{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #292d34}.urlrow:last-child{border-bottom:0}.urlrow code{overflow-wrap:anywhere}.label,.muted{color:#89909b}.field-warning{color:#ff8585;font-size:12px;font-weight:600}label{display:block;color:#aaa;margin:8px 0 4px}table{width:100%;border-collapse:collapse;background:#181a1f}th,td{padding:8px;border-bottom:1px solid #2b2e35;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#090a0c;padding:12px;border-radius:8px;max-height:58vh;overflow:auto}code{color:#9ecbff}.ok,.completed{color:#75d58b}.failed,.killed,.timed_out{color:#ff8585}.invalid{color:#c084fc}.pending,.running{color:#ffd166}#logStatus.completed,#logStatus option.completed{color:#75d58b}#logStatus.failed,#logStatus option.failed{color:#ff8585}#logStatus.invalid,#logStatus option.invalid{color:#c084fc}#logStatus.running,#logStatus option.running{color:#ffd166}#logStatus option{background:#22252b}.tools{columns:3;min-width:500px}.dialog-overlay{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:24px;background:#0009}.dialog-overlay dialog{position:static;margin:0;color:#eee;background:#17191e;border:1px solid #444;border-radius:10px;width:min(880px,94vw);max-height:calc(100vh - 48px);overflow:auto}textarea{width:100%;min-height:78px}h2{margin-top:0}.nowrap{white-space:nowrap}tr[data-action=select-log],tr[data-action=select-debug]{cursor:pointer}tr[data-action=select-log]:hover,tr[data-action=select-debug]:hover{background:#20242a}.tool-detail-overlay{position:fixed;top:54px;left:170px;right:0;bottom:0;z-index:1750;overflow:auto;overscroll-behavior:contain;padding:16px;background:#101114}.tool-detail-overlay .tool-detail-screen{min-height:calc(100vh - 86px)}.tool-detail-screen-head{position:sticky;top:-14px;z-index:10;margin:-14px -16px 12px;padding:12px 16px;background:#0d0f12;border-bottom:1px solid #292d34}.detail-row td{padding:0 18px 14px 28px;background:#111318}.detail-panel{border:1px solid #343944;border-left:3px solid #3984e8;border-radius:8px;background:#0d0f12;padding:14px 16px}.detail-panel pre{margin:8px 0 0;max-height:46vh}.tool-detail-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,.75fr);gap:14px;align-items:start}.tool-detail-main{min-width:0}.tool-descriptor{min-width:0;position:sticky;top:10px;border:1px solid #343944;border-radius:8px;background:#111318;padding:12px}.tool-descriptor>.muted{margin-top:10px}.tool-descriptor p{margin:5px 0 10px;line-height:1.45}.tool-descriptor pre{margin:5px 0 10px;max-height:28vh}.descriptor-status{font-size:11px;font-weight:800;letter-spacing:.04em;padding:3px 6px;border-radius:5px}.descriptor-status.current{color:#75d58b;background:#16341f}.descriptor-status.outdated{color:#ffd166;background:#3a2f13}.http-detail-head{padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid #292d34}.http-detail-meta{display:flex;gap:7px 16px;flex-wrap:wrap;margin-top:5px;font-size:12px;color:#89909b}.http-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.http-detail-block{min-width:0;border:1px solid #292d34;border-radius:8px;background:#0a0c0f;padding:10px}.http-detail-block h4{margin:0}.http-detail-block pre{max-height:30vh}.http-detail-error{margin-top:12px;border-color:#68353a;background:#1d1012}.http-detail-raw{margin-top:12px}.http-detail-raw summary{cursor:pointer;color:#89909b}@media(max-width:1100px){.tool-detail-grid,.http-detail-grid{grid-template-columns:1fr}.tool-descriptor{position:static}}.terminal-detail{margin-top:12px;border:1px solid #343944;border-radius:8px;background:#080a0d;overflow:hidden}.terminal-title{padding:9px 11px;background:#11151a;border-bottom:1px solid #292d34}.terminal-command{padding:10px 12px;border-bottom:1px solid #20242b;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.terminal-command .prompt{color:#75d58b;margin-right:8px}.tool-command-preview{margin-top:3px;max-width:440px;color:#c5cad3;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.terminal-cwd{padding:7px 12px;color:#89909b;border-bottom:1px solid #20242b}.terminal-stream-label{padding:7px 12px 0;color:#89909b;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.terminal-detail pre{margin:5px 10px 10px;max-height:30vh;border-radius:6px}.json-detail{margin-top:12px}.json-detail+.json-detail{padding-top:12px;border-top:1px solid #292d34}.debug-packet{min-width:0}.debug-payload-tree{min-width:0;overflow:auto;line-height:1.5;margin-top:9px;padding:10px;border:1px solid #292d34;border-radius:8px;background:#080a0d;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.debug-node{min-width:0;margin:3px 0}.debug-node>summary,.debug-decoded>summary{cursor:pointer;color:#9ecbff;overflow-wrap:anywhere}.debug-children{margin:5px 0 5px 6px;padding-left:8px;border-left:1px solid #292d34}.debug-entry{min-width:0;padding:3px 0;overflow-wrap:anywhere}.debug-key{color:#ffd166;margin-right:6px;overflow-wrap:anywhere}.debug-string{color:#9ce8b1;white-space:pre-wrap;overflow-wrap:anywhere}.debug-scalar{color:#c7a0ff}.debug-null{color:#8fd3ff}.debug-multiline{max-width:100%;margin:4px 0;max-height:40vh;white-space:pre-wrap}.debug-decoded{margin:3px 0;padding:5px 7px;border:1px solid #26303b;border-radius:6px;background:#0b0e12}.debug-image{margin:4px 0}.debug-image img{display:block;max-width:min(100%,720px);max-height:60vh;object-fit:contain;border-radius:6px;background:#050607}.debug-image figcaption{margin-top:4px;color:#89909b}.tool-content-detail{margin-top:12px;padding:12px;border:1px solid #343944;border-radius:8px;background:#0a0c0f}.tool-content-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px;margin-top:9px}.tool-content-card{position:relative;min-width:0;padding:9px;border:1px solid #292d34;border-radius:7px;background:#111318}.tool-content-path{margin-top:4px;color:#89909b;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.tool-content-preview{display:block;max-width:180px;max-height:120px;margin-top:8px;border-radius:5px;object-fit:contain;background:#07080a;transition:transform .12s ease;transform-origin:left top;position:relative;z-index:1}.tool-content-preview:hover{transform:scale(1.75);z-index:20;box-shadow:0 8px 30px #000c}.tool-content-placeholder{margin-top:8px;padding:10px;border-radius:5px;background:#090a0c;color:#89909b;font-size:12px}.json-editor-host{height:320px;min-height:180px;margin-top:8px;border-radius:8px;overflow:hidden}.json-editor-host.compact{height:240px;min-height:150px;margin:5px 0 10px}.json-editor-host.memory{height:min(58vh,620px);min-height:320px}.json-editor-host .jsoneditor{border-color:#343944;background:#090a0c}.json-editor-host div.jsoneditor-tree{background:#090a0c;color:#e8e8e8}.json-editor-host div.jsoneditor-field,.json-editor-host div.jsoneditor-value{color:#e8e8e8}.json-editor-host div.jsoneditor-readonly{color:#89909b}.json-editor-host div.jsoneditor-value.jsoneditor-string{color:#9ce8b1}.json-editor-host div.jsoneditor-value.jsoneditor-number{color:#ffd166}.json-editor-host div.jsoneditor-value.jsoneditor-boolean{color:#c7a0ff}.json-editor-host div.jsoneditor-value.jsoneditor-null{color:#8fd3ff}.json-editor-host .jsoneditor-navigation-bar{background:#111318;color:#89909b;border-color:#292d34}.json-editor-host .jsoneditor-frame{background:#111318;border-color:#343944}.json-editor-host .jsoneditor-search input{color:#eee;background:#22252b}.json-editor-host tr.jsoneditor-highlight,.json-editor-host tr.jsoneditor-selected{background:#252a33}.json-editor-host .jsoneditor-menu{background:#2459a8;border-color:#2459a8}
/* Embedded JSONEditor tables must not inherit administration table/detail-row chrome. */
.json-editor-host .jsoneditor table{background:transparent}.json-editor-host .jsoneditor td,.json-editor-host .jsoneditor th{padding:0;border:0;background:transparent}.json-editor-host .jsoneditor button.jsoneditor-button{filter:invert(.85)}.json-editor-host .jsoneditor button.jsoneditor-button:hover{filter:invert(1)}.json-editor-host .jsoneditor tr.jsoneditor-highlight,.json-editor-host .jsoneditor tr.jsoneditor-selected{background:#252a33}.json-editor-host .jsoneditor div.jsoneditor-field[contenteditable=true]:focus,.json-editor-host .jsoneditor div.jsoneditor-value[contenteditable=true]:focus{background:#252a33;border-color:#6088ad}.json-editor-host .jsoneditor .jsoneditor-treepath-element:hover{background:#252a33}
.idcell{font-variant-numeric:tabular-nums;white-space:nowrap}.http-session{white-space:nowrap}.workspace-label{margin-top:3px;color:#89909b;font-size:12px;font-weight:600}.menu-icon{display:inline-block;width:22px;text-align:center}.menu-label{flex:1;min-width:0}.menu-badge{min-width:20px;padding:1px 6px;border-radius:999px;background:#343944;color:#d6e6ff;font-size:11px;font-weight:750;text-align:center}.trash-table td:first-child{max-width:640px;overflow-wrap:anywhere}.trash-table td:first-child code{white-space:normal}.context-id{overflow-wrap:anywhere}.log-pagination{margin:8px 0 10px}.pagination{display:flex;gap:3px;align-items:center}.page-button{min-width:34px;height:34px;padding:4px 8px;border-color:#30343d;background:#1b1e24}.page-button.active{background:#3984e8;border-color:#3984e8;color:white}.page-button:disabled{opacity:.35;cursor:default}.page-ellipsis{min-width:26px;text-align:center;color:#89909b}.active-call-card{padding:0;overflow:hidden;min-height:210px}.active-call-table{margin:0;background:transparent}.active-call-table thead{position:sticky;top:0;z-index:1;background:#181a1f}.active-call-table tr{height:35px}.active-call-table th,.active-call-table td{padding:7px 9px}.active-call-table tr[data-action=process-tool-call]{cursor:pointer}.active-call-table tr[data-action=process-tool-call]:hover{background:#20242a}.active-call-summary{max-width:720px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.active-call-recent{animation:activeCallFade var(--active-call-ttl,5s) linear forwards}@keyframes activeCallFade{from{opacity:1}to{opacity:.18}}.progress-requested{color:#8fd3ff;white-space:nowrap}.dashboard-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(420px,1.25fr);gap:14px}.context-dates{min-width:240px}.context-dates>div{margin-bottom:4px}.oauth-table{table-layout:fixed}.oauth-table th:nth-child(1){width:30%}.oauth-table th:nth-child(2){width:26%}.oauth-table th:nth-child(3){width:30%}.oauth-table th:nth-child(4){width:130px}.oauth-client,.oauth-meta{line-height:1.45}.oauth-client-id{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:2px 0 5px}.oauth-client-id code{font-size:12px}.oauth-meta{font-size:12px}.oauth-meta>div{margin-top:3px}.oauth-count{font-size:13px;margin-bottom:3px}.oauth-tokens{display:grid;grid-template-columns:1fr 1fr;gap:8px}.oauth-token{min-width:0;padding-right:8px;border-right:1px solid #2b2e35}.oauth-token:last-child{padding-right:0;border-right:0}.oauth-actions{width:130px}.oauth-actions button{display:block;width:100%;white-space:nowrap;margin-bottom:5px}.oauth-actions button:last-child{margin-bottom:0}.commands-table .command-description{width:30%;max-width:360px;overflow-wrap:anywhere}.command-action-cell{width:104px}.command-actions{display:flex;flex-direction:column;gap:5px}.command-actions button{width:100%;white-space:nowrap}#publishedList{overflow-x:auto}.published-table{table-layout:fixed;min-width:850px}.published-table th:nth-child(1){width:130px}.published-table th:nth-child(2){width:165px}.published-table th:nth-child(3){width:135px}.published-table th:nth-child(4){width:185px}.published-table th:nth-child(5){width:105px}.published-table th:nth-child(7){width:80px}.published-id{min-width:0}.published-id code,.published-id .published-file-meta{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.published-reference{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0 6px 4px 0}.published-reference .workspace-label{max-width:105px;margin-top:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.published-open{display:block;width:100%;max-width:100%;padding:0;border:0;background:transparent;text-align:left;color:#9ecbff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.published-open code{white-space:nowrap}.published-open:hover{background:transparent;text-decoration:underline}.published-file-meta{margin-top:3px;color:#89909b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.published-activity{white-space:nowrap}.published-source{min-width:0}.published-source code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.roots-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:14px;align-items:start}.root-card h3,.default-root-card h3{margin:0 0 4px}.root-card-header{display:flex;gap:12px;align-items:flex-start}.root-session-list{display:flex;flex-direction:column;gap:6px;min-height:48px;margin-top:10px;padding:8px;border:1px dashed #3a3e47;border-radius:8px}.session-chip{display:block;padding:7px 9px;border:1px solid #343944;border-radius:7px;background:#202329;cursor:grab}.session-chip-main{display:flex;gap:8px;align-items:center}.session-chip .grow{min-width:0;overflow-wrap:anywhere}.session-chip-meta{display:flex;gap:5px 16px;align-items:center;flex-wrap:wrap;margin-top:6px;padding-left:30px;font-size:12px;line-height:1.35}.session-chip-meta>span{white-space:nowrap}.session-chip:active{cursor:grabbing}.root-drop-empty{padding:6px 2px;color:#89909b}.root-disabled .root-session-list{opacity:.65}.default-root-card{position:sticky;top:70px}@media(max-width:1000px){.roots-layout,.settings-layout{grid-template-columns:1fr}.default-root-card,.settings-side{position:static}}@media(max-width:900px){.dashboard-grid{grid-template-columns:1fr}}@media(max-width:800px){#app>aside{width:130px}main{margin-left:130px}.tool-detail-overlay{left:130px}.urlrow{grid-template-columns:1fr}.tools{columns:1;min-width:0}}
</style></head><body>
<div id=app data-section=dashboard><header><div class=brand><img class=brand-mark src="${GUI_LOGO_DATA_URL}" alt=""><b>MrMCP <span class=muted>v${VERSION}</span></b></div><div class=status><span class=pending>starting…</span></div></header><main style="margin-left:0"><div class=card>Starting the local MrMCP UI…</div></main></div>
<script nonce="${UI_SCRIPT_NONCE}">__MRMCP_BROWSER_JS__</script></body></html>` : "";

  function browserAppSource() {/*
import { morphInner } from "/assets/morphlex.js";
const app = document.getElementById("app");
const internals = window.__TAURI_INTERNALS__;
const invoke = (command, payload = {}) => internals.invoke(command, payload);
const UI_INPUT_EVENT = "tauriless://webview-message", UI_RENDER_EVENT = "mrmcp://ui-render";
let scrollTimer = null, inputTimer = null, lastRenderRevision = 0, uiSendRunning = false;
const pendingInputs = new Map(), uiSendQueue = [], SKIPPABLE_UI_SENDS = new Set(["inputs", "focus", "scroll"]);
function focusState(element = document.activeElement) {
  if (!element?.id) return null;
  return {
    id: element.id,
    start: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
    end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
  };
}
function mergeUiSend(previous, next) {
  if (previous.event.type !== "inputs" || next.event.type !== "inputs") return next;
  const items = new Map();
  for (const envelope of [previous, next])
    for (const item of Array.isArray(envelope.event.items) ? envelope.event.items : [])
      if (item?.id) items.set(String(item.id), item);
  return { ...next, event: { ...next.event, items: [...items.values()] } };
}
async function drainUiSends() {
  if (uiSendRunning) return;
  uiSendRunning = true;
  try {
    while (uiSendQueue.length) {
      const entry = uiSendQueue.shift();
      try {
        await invoke("plugin:event|emit", { event: UI_INPUT_EVENT, payload: entry.envelope });
        entry.waiters.forEach(({ resolve }) => resolve());
      } catch (error) {
        console.error("MrMCP input delivery failed", error);
        entry.waiters.forEach(({ reject }) => reject(error));
      }
    }
  } finally {
    uiSendRunning = false;
    if (uiSendQueue.length) void drainUiSends();
  }
}
function sendRaw(event) {
  const envelope = { event: {
    ...event,
    focus: event.focus === undefined ? focusState() : event.focus,
    viewport: { section: app.dataset.section || "dashboard", x: scrollX, y: scrollY },
  } };
  const type = String(event.type || ""), last = uiSendQueue.at(-1);
  return new Promise((resolve, reject) => {
    if (SKIPPABLE_UI_SENDS.has(type) && String(last?.envelope?.event?.type || "") === type) {
      last.envelope = mergeUiSend(last.envelope, envelope);
      last.waiters.push({ resolve, reject });
    } else uiSendQueue.push({ envelope, waiters: [{ resolve, reject }] });
    void drainUiSends();
  });
}
function flushInputs() {
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
  if (!pendingInputs.size) return Promise.resolve();
  const items = [...pendingInputs.values()];
  pendingInputs.clear();
  return sendRaw({ type: "inputs", items });
}
function send(event) {
  if (event.type !== "inputs") void flushInputs();
  return sendRaw(event);
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
const MORPH_OPTIONS = { preserveChanges: true };
const jsonEditors = [];
function destroyJsonEditors() {
  while (jsonEditors.length) {
    const entry = jsonEditors.pop();
    try { entry.editor.destroy(); } catch {}
  }
}
function jsonSourceText(source) {
  return source instanceof HTMLTextAreaElement || source instanceof HTMLInputElement ? source.value : source.textContent || "";
}
function enhanceJsonEditors() {
  if (typeof globalThis.JSONEditor !== "function") return;
  for (const host of app.querySelectorAll("[data-json-source]")) {
    const source = document.getElementById(String(host.dataset.jsonSource || ""));
    if (!source) continue;
    const errorNode = host.dataset.jsonError ? document.getElementById(host.dataset.jsonError) : null;
    let value;
    try {
      value = JSON.parse(jsonSourceText(source));
      source.hidden = true;
      host.hidden = false;
      if (errorNode) { errorNode.hidden = true; errorNode.textContent = ""; }
    } catch (error) {
      source.hidden = false;
      host.hidden = true;
      if (errorNode) { errorNode.hidden = false; errorNode.textContent = `Invalid JSON: ${String(error?.message || error)}`; }
      continue;
    }
    const editable = host.dataset.jsonEdit === "memory";
    let editor;
    const options = editable ? {
      mode: "tree", modes: ["tree"], mainMenuBar: true, navigationBar: true, statusBar: false,
      search: true, history: true,
      onChange: () => {
        try {
          const text = JSON.stringify(editor.get(), null, 2);
          source.value = text;
          if (errorNode) { errorNode.hidden = true; errorNode.textContent = ""; }
          queueInput(source);
        } catch (error) {
          if (errorNode) { errorNode.hidden = false; errorNode.textContent = `Invalid JSON: ${String(error?.message || error)}`; }
        }
      },
    } : {
      mode: "view", modes: ["view"], mainMenuBar: false, navigationBar: true, statusBar: false,
      search: true, onEditable: () => false,
    };
    host.replaceChildren();
    editor = new globalThis.JSONEditor(host, options, value);
    jsonEditors.push({ editor, host, source });
  }
}
function applyRender(payload) {
  destroyJsonEditors();
  morphInner(app, payload.html, MORPH_OPTIONS);
  enhanceJsonEditors();
  app.dataset.section = String(payload.section || "dashboard");
  const scroll = Array.isArray(payload.scroll) ? payload.scroll : [0, 0];
  const revision = Math.max(0, Number(payload.revision) || 0);
  requestAnimationFrame(() => {
    if (revision && revision !== lastRenderRevision) return;
    const scrollTarget = payload.scroll_target ? document.getElementById(String(payload.scroll_target)) : null;
    if (scrollTarget) scrollTarget.scrollIntoView({ block: "start" });
    else scrollTo(Number(scroll[0]) || 0, Number(scroll[1]) || 0);
    const active = document.activeElement;
    if (active?.matches?.("input,select,textarea") && active.isConnected && !active.disabled) return;
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
void listen("tauri://close-requested", () => {}, { kind: "Window", label: "main" })
  .catch(error => console.error("MrMCP close interception failed", error));
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
  if (event.key !== "Enter" || !["logTool", "logQuery", "debugQuery", "commandQuery", "promptQuery"].includes(event.target.id)) return;
  event.preventDefault();
  send({ type: "enter", id: event.target.id, value: event.target.value, focus: focusState(event.target) });
});
addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => send({
    type: "scroll", section: app.dataset.section || "dashboard", x: scrollX, y: scrollY,
  }), 80);
}, { passive: true });
listen(UI_RENDER_EVENT, event => {
  const payload = event.payload || {}, revision = Math.max(0, Number(payload.revision) || 0);
  if (revision && revision <= lastRenderRevision) return;
  try {
    applyRender(payload);
    if (revision) lastRenderRevision = revision;
  } catch (error) { console.error("MrMCP render failed", error); }
}).then(() => send({ type: "bootstrap" })).catch(error => {
  console.error("MrMCP UI bootstrap failed", error);
});
*/}

  const BROWSER_JS = GUI_RUNTIME
    ? browserAppSource.toString().match(/\/\*([\s\S]*)\*\//)[1].replace('import { morphInner } from "/assets/morphlex.js";\n', "")
    : "";
  const GUI_BROWSER_JS = GUI_RUNTIME ? `${GUI_JSONEDITOR_JS}\n${GUI_MORPHLEX_JS}\n${BROWSER_JS}` : "";
  const PAGE_TEMPLATE = UI_TEMPLATE;
  function ui() { return GUI_RUNTIME ? eta.renderString(PAGE_TEMPLATE, {}).replace("__MRMCP_BROWSER_JS__", GUI_BROWSER_JS) : ""; }
  restoreAcmeBackoff();
  await detectPublicIp().catch(error => setCfg("tls_last_error", [
    getCfg("tls_last_error", ""), String(error?.message || error),
  ].filter(Boolean).join("\n")));
  await restartMcp();
  automaticRenewal().catch(() => {});
  renewalTimer = setInterval(automaticRenewal, 60 * 60 * 1000);
  processCleanupTimer = setInterval(maintenance, 60 * 60 * 1000);
  await cleanupPublishedOrphans();
  recoverChatGoals();
  chatGoalConfigure();
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
    if (chatGoalTimer) clearInterval(chatGoalTimer);
    chatGoalLoginStop();
    for (const monitor of [...chatGoalMonitors]) monitor.stop();
    for (const control of activeCallControls.values()) try { await control.cancel?.("SIGTERM", "server"); } catch {}
    activeCallControls.clear();
    if (renewalTimer) clearInterval(renewalTimer);
    if (processCleanupTimer) clearInterval(processCleanupTimer);
    if (uiLogFilterTimer) clearTimeout(uiLogFilterTimer);
    if (uiNoticeTimer) clearTimeout(uiNoticeTimer);
    if (headerActivityTimer) clearTimeout(headerActivityTimer);
    if (activeToolCallTimer) clearTimeout(activeToolCallTimer);
    if (cdpUiTimer) { clearTimeout(cdpUiTimer); cdpUiTimer = null; }
    for (const key of [...jsKernels.keys()]) destroyJsKernel(key, "server shutdown");
    for (const record of cdpBrowsers.values()) {
      try { record.ws.close(1000, "MrMCP shutdown"); } catch {}
      cdpDisconnect(record, "MrMCP shutdown");
    }
    cdpBrowsers.clear(); cdpBrowserOptions.clear(); cdpTargetOptions.clear(); cdpTargetReservations.clear(); cdpConnectPromises.clear(); cdpSubscriptions.clear();
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
    flushRequestMetric();
    flushDeferredLogWork();
    db.close();
  };
  if (IS_BACKEND_WORKER) {
    self.onmessage = event => {
      if (event.data?.type === "ui-visibility") {
        setUiRenderVisible(event.data.visible);
        return;
      }
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
  const { worker: backendWorker, payload: initialPayload, earlyMessages } = await spawnBackendWorker();
  let payload = initialPayload;
  const { Tauriless } = await import("npm:@mefistofelix/tauriless");
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
  let nextId = 1, drainTimer = null, windowVisibilityTimer = null, notificationPermission = null, closed = false, webviewMessagesReady = false, notificationsReady = false, windowRenderVisible = false, resolveClosed, resolveWebviewReady;
  let renderDeliveryRunning = false, pendingRenderPayload = null, quitItemChannelId = null, menuChannelId = null, trayChannelId = null;
  const workerMessageQueue = [], notificationQueue = [];
  const channel = () => {
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    return { id, token: `__CHANNEL__:${id}` };
  };
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
  const deliverLatestRender = async payload => {
    pendingRenderPayload = payload;
    if (renderDeliveryRunning) return;
    renderDeliveryRunning = true;
    try {
      while (pendingRenderPayload && windowRenderVisible) {
        const next = pendingRenderPayload;
        pendingRenderPayload = null;
        await emitToWebview(UI_RENDER_EVENT, next);
      }
    } catch (error) {
      console.error("MrMCP render delivery failed", error);
    } finally {
      renderDeliveryRunning = false;
      if (pendingRenderPayload && windowRenderVisible) void deliverLatestRender(pendingRenderPayload);
    }
  };
  const publishRenderVisibility = visible => {
    const next = !!visible;
    if (windowRenderVisible === next) return;
    windowRenderVisible = next;
    if (!next) pendingRenderPayload = null;
    backendWorker.postMessage({ type: "ui-visibility", visible: next });
  };
  const syncWindowRenderVisibility = async () => {
    const visible = !!await request("plugin:window|is_visible", { label: "main" });
    const minimized = visible && !!await request("plugin:window|is_minimized", { label: "main" });
    publishRenderVisibility(visible && !minimized);
    return visible && !minimized;
  };
  const queueWindowRenderVisibilitySync = (delay = 25) => {
    if (windowVisibilityTimer) clearTimeout(windowVisibilityTimer);
    windowVisibilityTimer = setTimeout(() => {
      windowVisibilityTimer = null;
      void syncWindowRenderVisibility().catch(error => console.error("MrMCP window visibility sync failed", error));
    }, Math.max(0, Number(delay) || 0));
  };
  const showWindow = async () => {
    await request("plugin:window|unminimize", { label: "main" });
    await request("plugin:window|show", { label: "main" });
    await request("plugin:window|set_focus", { label: "main" });
    await syncWindowRenderVisibility();
  };
  const hideWindow = async () => {
    const result = await request("plugin:window|hide", { label: "main" });
    publishRenderVisibility(false);
    return result;
  };
  const toggleWindow = async () => {
    if (await request("plugin:window|is_minimized", { label: "main" })) return showWindow();
    return await request("plugin:window|is_visible", { label: "main" }) ? hideWindow() : showWindow();
  };
  const notificationAllowed = () => notificationPermission ??= Deno.build.os !== "darwin" ? Promise.resolve(true) : (async () =>
    await request("plugin:notification|is_permission_granted") ||
    await request("plugin:notification|request_permission") === "granted")();
  const notify = async message => {
    if (!await notificationAllowed()) return;
    return request("plugin:notification|notify", { options: {
      title: String(message.title || "Notification").slice(0, 160), body: String(message.body || "").slice(0, 500),
    } });
  };
  const handleWorkerMessage = data => {
    if (data?.type === "ready" && data.gui && payload.startup_recovery && !data.startup_recovery) {
      payload = data;
      webviewMessagesReady = false;
      workerMessageQueue.length = 0;
      pendingRenderPayload = null;
      backendWorker.postMessage({ type: "ui-visibility", visible: windowRenderVisible });
      void emitToWebview("mrmcp://startup-ready", {}).catch(error => console.error("MrMCP recovery navigation failed", error));
    } else if (data?.type === "startup-cancelled") resolveClosed();
    else if (data?.type === "ui-render") {
      if (!windowRenderVisible) return;
      void deliverLatestRender(data.payload);
    } else if (data?.type === "os-notification") {
      if (!notificationsReady) notificationQueue.push(data);
      else void notify(data).catch(error => console.error("MrMCP notification failed", error));
    } else if (data?.type === "os-open-url") {
      void request("plugin:opener|open_url", { url: String(data.url || ""), with: null })
        .catch(error => console.error("MrMCP published URL open failed", error));
    }
  };
  const queueOrHandleWorkerMessage = data => {
    if (data?.type === "ui-render" && !webviewMessagesReady) {
      workerMessageQueue.length = 0;
      workerMessageQueue.push(data);
    } else handleWorkerMessage(data);
  };
  const onWorkerMessage = event => queueOrHandleWorkerMessage(event.data);
  backendWorker.addEventListener("message", onWorkerMessage);
  for (const data of earlyMessages) queueOrHandleWorkerMessage(data);
  const pumpTauriless = () => {
    for (const message of tauriless.run(16).messages) {
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
        else if (["tauri://resize", "tauri://focus", "tauri://blur"].includes(message.event)) queueWindowRenderVisibilitySync();
        else if (message.event === UI_INPUT_EVENT) {
          if (message.payload?.event?.type === "bootstrap") {
            resolveWebviewReady(true);
            webviewMessagesReady = true;
            for (const queued of workerMessageQueue.splice(0)) handleWorkerMessage(queued);
          }
          backendWorker.postMessage({ type: "ui-input", payload: message.payload });
        }
        else if (message.event === "tauri://drag-drop") backendWorker.postMessage({
          type: "ui-input", payload: { event: { type: "native-drop", paths: message.payload?.paths || [] } },
        });
      } else if (message.kind === "channel") {
        let event = message.message;
        if (typeof event === "string") try { event = JSON.parse(event); } catch {}
        if (message.id === quitItemChannelId) {
          const menuId = typeof event === "string" ? event : event?.id ?? event?.payload?.id;
          if (menuId === "tray-quit") resolveClosed();
        } else if (message.id === trayChannelId && event?.type === "Click" && event.button === "Left" && event.buttonState === "Up") {
          void toggleWindow().catch(console.error);
        }
      }
    }
  };
  try {
    drainTimer = setInterval(() => {
      if (closed) return;
      try { pumpTauriless(); }
      catch (error) {
        closed = true;
        for (const callback of pending.values()) callback.reject(error);
        pending.clear();
        resolveClosed();
      }
    }, 16);
    await request("tauriless:set-app-user-model-id", {
      appId: "com.mefistofelix.mrmcp", name: "MrMCP",
    });
    for (const event of [
      "tauri://move", "tauri://scale-change", "tauri://theme-changed", "tauri://window-created", "tauri://webview-created",
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
    const quitItemChannel = channel();
    quitItemChannelId = quitItemChannel.id;
    // Tauri's menu plugin keys MenuChannels by the resource's own MenuId. A click
    // emits the selected item id, so Quit must own its channel directly. This exact
    // shape is verified against Tauriless 0.1.18 with a native Windows tray click.
    const [quitRid, quitId] = await request("plugin:menu|new", {
      kind: "MenuItem", options: { id: "tray-quit", text: "Quit", enabled: true },
      handler: quitItemChannel.token,
    });
    if (quitId !== "tray-quit") throw new Error("Tauriless tray Quit MenuItem id mismatch");
    const menuChannel = channel();
    menuChannelId = menuChannel.id;
    const [menuRid] = await request("plugin:menu|new", {
      kind: "Menu", options: { id: "mrmcp-tray-menu", items: [[quitRid, "MenuItem"]] },
      handler: menuChannel.token,
    });
    const quitItem = await request("plugin:menu|get", { rid: menuRid, kind: "Menu", id: "tray-quit" });
    if (!Array.isArray(quitItem) || quitItem[1] !== "tray-quit" || quitItem[2] !== "MenuItem")
      throw new Error("Tauriless tray Quit MenuItem was not retained in the tray menu");
    const trayChannel = channel();
    trayChannelId = trayChannel.id;
    await request("plugin:tray|new", { options: {
      id: "mrmcp-tray", menu: [menuRid, "Menu"], icon: nativeIcon(),
      tooltip: `MrMCP ${VERSION}`, showMenuOnLeftClick: false, iconAsTemplate: Deno.build.os === "darwin",
    }, handler: trayChannel.token });
    await showWindow();
    notificationsReady = true;
    for (const message of notificationQueue.splice(0))
      void notify(message).catch(error => console.error("MrMCP notification failed", error));
    await windowClosed;
  } finally {
    backendWorker.removeEventListener("message", onWorkerMessage);
    closed = true;
    if (drainTimer) clearInterval(drainTimer);
    if (windowVisibilityTimer) clearTimeout(windowVisibilityTimer);
    for (const callback of pending.values()) callback.reject(new Error("Tauriless closing"));
    pending.clear();
    try { tauriless.close(); } finally { await stopBackendWorker(backendWorker); }
  }
}

if (IS_BACKEND_WORKER) await runBackend();
else if (import.meta.main) {
  if (Deno.args[0] === "--add-workspace") {
    if (Deno.args.length !== 3) {
      console.error("Usage: mrmcp --add-workspace <name> <path>");
      Deno.exit(2);
    }
    try { await runBackend({ addWorkspace: { name: Deno.args[1], path: Deno.args[2] } }); }
    catch (error) { console.error(String(error?.message || error)); Deno.exit(1); }
    Deno.exit(0);
  }
  if (Deno.args.includes("--backend")) await runBackend();
  else { await desktop(); Deno.exit(0); }
}
