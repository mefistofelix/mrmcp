/*
MRMCP 0.10.22 — single-file Deno MCP desktop server.
Runtime data: .mrmcp beside this script.
GUI: jsr:@webview/webview@0.9.0
Run: deno run -A --unstable-ffi --unstable-worker-options mrmcp.js
*/

import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { Eta } from "jsr:@bgub/eta@4.6.0";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.1.2";
import { contentType as mediaContentType, typeByExtension } from "jsr:@std/media-types@1.1.0";

const SELF = new URL(import.meta.url);
const APP_DIR = dirname(fileURLToPath(SELF));
const COMMANDS_PATH = join(APP_DIR, "commands.yaml");
const IS_BACKEND = SELF.searchParams.get("backend") === "1";
const GUI_PORT = 7332;
const ADMIN_TOKEN = SELF.searchParams.get("admin") || "";
const BASE_TOOLS = [
  "workspace", "read_file", "read_files", "write_file", "write_files",
  "edit_file", "edit_files", "replace_files", "list_files", "search_files",
  "file_info", "create_directory", "copy_path", "move_path", "delete_path",
  "publish_file", "list_commands", "exec", "exec_start", "exec_poll", "exec_write", "exec_kill", "exec_list",
  "js", "js_add_node_module_dir", "js_reset",
];
const READ_TOOLS = new Set([
  "read_file", "read_files", "list_files", "search_files",
  "file_info", "list_commands", "exec_poll", "exec_list",
]);
const MCP_MODERN_PROTOCOL = "2026-07-28";
const MCP_PROTOCOLS = [MCP_MODERN_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_DEFAULT_PROTOCOL = "2025-11-25";
const VERSION = "0.10.22";
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";
const FILE_PREVIEW_UI_URI = "ui://mrmcp/image-preview-v3.html";
const enc = new TextEncoder(), dec = new TextDecoder();

const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
});
const text = (x, status = 200, type = "text/plain; charset=utf-8", headers = {}) =>
  new Response(String(x), { status, headers: { "content-type": type, ...headers } });
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
  // Automatic compatibility changes are limited to the logs primary-key upgrade and the additive OAuth refresh-token table.
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS config(
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      root TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      oauth INTEGER NOT NULL DEFAULT 1,
      exec_enabled INTEGER NOT NULL DEFAULT 1,
      confirm_mode TEXT NOT NULL DEFAULT 'allow',
      allow_re TEXT NOT NULL DEFAULT '',
      deny_re TEXT NOT NULL DEFAULT '',
      enabled_tools_json TEXT NOT NULL DEFAULT '[]',
      basic_enabled INTEGER NOT NULL DEFAULT 0,
      basic_username TEXT NOT NULL DEFAULT 'mrmcp',
      basic_secret_enc TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_tools(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      confirm_mode TEXT NOT NULL DEFAULT 'inherit',
      created_at INTEGER NOT NULL,
      UNIQUE(project_id,name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      project_id INTEGER,
      project_slug TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT '',
      matched_rule TEXT NOT NULL DEFAULT '',
      input_json TEXT NOT NULL,
      resolved_json TEXT NOT NULL DEFAULT '',
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS logs_time ON logs(started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_project ON logs(project_slug,started_at DESC);
    CREATE INDEX IF NOT EXISTS logs_tool ON logs(tool,started_at DESC);
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
      project_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens(
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens(
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_tokens(client_id);
    CREATE INDEX IF NOT EXISTS oauth_refresh_project ON oauth_refresh_tokens(project_id);
    CREATE TABLE IF NOT EXISTS project_roots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id,name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS workspace_sessions(
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      owner_key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      pinned_roots_json TEXT NOT NULL DEFAULT '[]',
      default_root TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS workspace_owner ON workspace_sessions(project_id,owner_key,updated_at DESC);
    CREATE TABLE IF NOT EXISTS process_runs(
      id TEXT PRIMARY KEY,
      pid INTEGER,
      project_id INTEGER NOT NULL,
      project_slug TEXT NOT NULL,
      workspace_session TEXT NOT NULL DEFAULT '',
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
      error TEXT NOT NULL DEFAULT '',
      owner_key TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS process_runs_time ON process_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS metrics(
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  let migratedLegacyLogs = false;
  const logsIdColumn = db.prepare("PRAGMA table_info(logs)").all().find(column => column.name === "id");
  if (logsIdColumn && (String(logsIdColumn.type).toUpperCase() !== "INTEGER" || Number(logsIdColumn.pk) !== 1)) {
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS logs_fts;
        ALTER TABLE logs RENAME TO logs_legacy_uuid;
        DROP INDEX IF EXISTS logs_time;
        DROP INDEX IF EXISTS logs_project;
        DROP INDEX IF EXISTS logs_tool;
        CREATE TABLE logs(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          project_id INTEGER,
          project_slug TEXT NOT NULL,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          decision TEXT NOT NULL DEFAULT '',
          matched_rule TEXT NOT NULL DEFAULT '',
          input_json TEXT NOT NULL,
          resolved_json TEXT NOT NULL DEFAULT '',
          stdout TEXT NOT NULL DEFAULT '',
          stderr TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          result_json TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER
        );
        INSERT INTO logs(
          id,started_at,completed_at,project_id,project_slug,tool,status,decision,matched_rule,
          input_json,resolved_json,stdout,stderr,error,result_json,duration_ms
        )
        SELECT
          rowid,started_at,completed_at,project_id,project_slug,tool,status,decision,matched_rule,
          input_json,resolved_json,stdout,stderr,error,result_json,duration_ms
        FROM logs_legacy_uuid ORDER BY rowid;
        DROP TABLE logs_legacy_uuid;
        CREATE INDEX logs_time ON logs(started_at DESC);
        CREATE INDEX logs_project ON logs(project_slug,started_at DESC);
        CREATE INDEX logs_tool ON logs(tool,started_at DESC);
        COMMIT;
      `);
      migratedLegacyLogs = true;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  let fts = true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
      log_id UNINDEXED, project, tool, input, output, stderr, error,
      tokenize='unicode61'
    )`);
    if (migratedLegacyLogs) db.exec(`
      INSERT INTO logs_fts(log_id,project,tool,input,output,stderr,error)
      SELECT id,project_slug,tool,input_json,CASE WHEN result_json<>'' THEN result_json WHEN resolved_json<>'' THEN resolved_json ELSE stdout END,stderr,error FROM logs
    `);
  } catch { fts = false; }

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const getCfg = (key, fallback) => one("SELECT value FROM config WHERE key=?", key)?.value ?? fallback;
  const setCfg = (key, value) => run(
    "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key, String(value),
  );
  const oauthAccessUpgradeExpiry = Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000;
  run("UPDATE oauth_tokens SET expires_at=? WHERE expires_at<?", oauthAccessUpgradeExpiry, oauthAccessUpgradeExpiry);
  const requiredSchema = {
    projects: ["oauth", "basic_enabled", "basic_username", "basic_secret_enc"],
    project_roots: ["project_id", "name", "path", "enabled"],
    workspace_sessions: ["owner_key", "pinned_roots_json", "default_root"],
    process_runs: ["owner_key", "workspace_session", "stdout_tail", "stderr_tail"],
    logs: ["id", "project_slug", "tool", "status", "input_json"],
    oauth_refresh_tokens: ["token_hash", "client_id", "project_id", "resource", "scope", "last_used_at"],
  };
  const schemaErrors = [];
  for (const [table, columns] of Object.entries(requiredSchema)) {
    const present = new Set(all(`PRAGMA table_info(${table})`).map(column => column.name));
    if (!present.size) schemaErrors.push(`missing table ${table}`);
    else for (const column of columns) if (!present.has(column)) schemaErrors.push(`${table}.${column}`);
  }
  if (schemaErrors.length) throw new Error(
    `Incompatible .mrmcp/mrmcp.sqlite (${schemaErrors.join(", ")}). ` +
    "Automatic general database migrations are disabled: stop MRMCP, back up or remove the database, then restart.",
  );
  db.exec("PRAGMA user_version=12");
  if (fts && getCfg("logs_fts_payload_version", "") !== "2") {
    try {
      db.exec(`DELETE FROM logs_fts;
        INSERT INTO logs_fts(log_id,project,tool,input,output,stderr,error)
        SELECT id,project_slug,tool,input_json,
          CASE WHEN result_json<>'' THEN result_json WHEN resolved_json<>'' THEN resolved_json ELSE stdout END,
          stderr,error FROM logs;`);
      setCfg("logs_fts_payload_version", "2");
    } catch {}
  }
  run("INSERT OR IGNORE INTO metrics(name,value) VALUES('requests',0)");
  const startupTime = Date.now();
  run("UPDATE process_runs SET status='orphaned',completed_at=? WHERE status IN ('starting','running')", startupTime);
  run(`UPDATE logs SET status='orphaned',completed_at=? 
    WHERE status IN ('received','awaiting_approval','running')`, startupTime);
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
  ]) if (!one("SELECT 1 FROM config WHERE key=?", k)) setCfg(k, v);
  setCfg("tls_cert_path", CERT_PATH);
  setCfg("tls_key_path", KEY_PATH);
  setCfg("tls_staging", "0");
  setCfg("tls_auto_renew", "1");
  setCfg("tls_mode", "letsencrypt");
  if (!one("SELECT 1 FROM projects")) {
    const created = run(
      `INSERT INTO projects(name,slug,root,enabled,oauth,exec_enabled,confirm_mode,
        allow_re,deny_re,enabled_tools_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      "Default", "default", APP_DIR, 1, 1, 1, "allow", "", "",
      JSON.stringify(BASE_TOOLS), Date.now(),
    );
    run("INSERT INTO project_roots(project_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
      Number(created.lastInsertRowid), "default", APP_DIR, 1, Date.now());
  }
  const baseToolDefaultsRevision = "0.10.10-publish-file";
  if (getCfg("base_tool_defaults_revision", "") !== baseToolDefaultsRevision) {
    for (const project of all("SELECT id,enabled_tools_json FROM projects")) {
      const enabled = parseJson(project.enabled_tools_json, []);
      const normalized = Array.isArray(enabled)
        ? enabled.filter(name => BASE_TOOLS.includes(name)) : [];
      if (!normalized.includes("publish_file")) normalized.push("publish_file");
      run("UPDATE projects SET enabled_tools_json=? WHERE id=?",
        JSON.stringify([...new Set(normalized)]), project.id);
    }
    setCfg("base_tool_defaults_revision", baseToolDefaultsRevision);
  }

  const SESSION = randomToken(), CSRF = randomToken();
  const approvals = new Map(), processes = new Map(), jsKernels = new Map(),
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
  const mcpUrl = p => `${publicBase()}/mcp/${p.slug}`;
  const metadataUrl = p => `${publicBase()}/.well-known/oauth-protected-resource/mcp/${p.slug}`;
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
    title: "MRMCP file preview",
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
<title>MRMCP image preview</title>
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
    const legacyMode = options.inline === true ? "both" : "link";
    const returnMode = String(options.return_mode || legacyMode).trim().toLowerCase();
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
      if (!within(root, realPath)) throw new Error(`Returned file resolves outside the selected workspace root: ${value}`);
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
      name: `CN=${host || ip || "MRMCP"}`,
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
        if (!within(rootReal, real)) throw new Error("Path resolves outside project root");
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
  function globRegex(pattern = "**/*") {
    let s = String(pattern).replaceAll("\\", "/"), out = "^";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "*" && s[i + 1] === "*") { out += ".*"; i++; }
      else if (c === "*") out += "[^/]*";
      else if (c === "?") out += "[^/]";
      else out += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
    }
    return new RegExp(out + "$");
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

  // Each workspace selects one configured directory; tool paths stay relative.
  const projectRoots = p => all(
    "SELECT * FROM project_roots WHERE project_id=? AND enabled=1 ORDER BY id", p.id,
  );
  const validRootName = name => /^[A-Za-z0-9_.-]{1,64}$/.test(String(name || ""));
  function workspaceById(p, ownerKey, id) {
    return id ? one(
      "SELECT * FROM workspace_sessions WHERE id=? AND project_id=? AND owner_key=?",
      id, p.id, ownerKey,
    ) : null;
  }
  function defaultWorkspace(p, ownerKey) {
    let ws = one(
      "SELECT * FROM workspace_sessions WHERE project_id=? AND owner_key=? AND label='_default'",
      p.id, ownerKey,
    );
    if (ws) return ws;
    const root = projectRoots(p)[0];
    if (!root) throw new Error("Project has no enabled root directories");
    const id = `ws_${randomToken(18)}`;
    run(`INSERT INTO workspace_sessions(id,project_id,owner_key,label,pinned_roots_json,
      default_root,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      id, p.id, ownerKey, "_default", JSON.stringify([root.name]), root.name,
      Date.now(), Date.now());
    return one("SELECT * FROM workspace_sessions WHERE id=?", id);
  }
  function getWorkspace(p, ownerKey, id = "") {
    const ws = workspaceById(p, ownerKey, id) || (!id ? defaultWorkspace(p, ownerKey) : null);
    if (!ws) throw new Error("Unknown workspace session or session belongs to another client");
    return ws;
  }
  function workspaceSnapshot(p, ws) {
    const roots = projectRoots(p);
    let root = roots.find(r => r.name === ws.default_root) || roots[0];
    if (!root) throw new Error("Project has no enabled root directories");
    if (root.name !== ws.default_root) run(
      "UPDATE workspace_sessions SET pinned_roots_json=?,default_root=?,updated_at=? WHERE id=?",
      JSON.stringify([root.name]), root.name, Date.now(), ws.id,
    );
    return {
      session_id: ws.id,
      label: ws.label === "_default" ? "default" : ws.label,
      root: { name: root.name, path: root.path },
      available_roots: roots.map(r => ({ name: r.name, path: r.path, selected: r.name === root.name })),
      path_format: "normal path relative to the selected root",
    };
  }
  function selectWorkspaceRoot(p, ws, name) {
    const root = projectRoots(p).find(r => r.name === String(name || ""));
    if (!root) throw new Error(`Unknown or disabled root: ${name}`);
    run("UPDATE workspace_sessions SET pinned_roots_json=?,default_root=?,updated_at=? WHERE id=?",
      JSON.stringify([root.name]), root.name, Date.now(), ws.id);
    return workspaceSnapshot(p, getWorkspace(p, ws.owner_key, ws.id));
  }
  function workspaceAction(p, ownerKey, args) {
    const action = String(args.action || "status"), roots = projectRoots(p);
    if (action === "list_roots") return {
      roots: roots.map(r => ({ name: r.name, path: r.path })),
      path_format: "normal path relative to the selected root",
    };
    if (action === "new") {
      const selected = roots.find(r => r.name === String(args.root || "")) || roots[0];
      if (!selected) throw new Error("Project has no enabled root directories");
      const id = `ws_${randomToken(18)}`;
      run(`INSERT INTO workspace_sessions(id,project_id,owner_key,label,pinned_roots_json,
        default_root,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
        id, p.id, ownerKey, String(args.label || ""), JSON.stringify([selected.name]),
        selected.name, Date.now(), Date.now());
      return workspaceSnapshot(p, getWorkspace(p, ownerKey, id));
    }
    const ws = getWorkspace(p, ownerKey, String(args.session_id || ""));
    if (action === "status") return workspaceSnapshot(p, ws);
    if (action === "select") return selectWorkspaceRoot(p, ws, args.root);
    if (action === "delete") {
      if (ws.label === "_default") throw new Error("The default workspace cannot be deleted");
      run("DELETE FROM workspace_sessions WHERE id=?", ws.id);
      return { deleted: true, session_id: ws.id };
    }
    throw new Error("workspace.action must be list_roots, new, status, select or delete");
  }
  async function resolveWorkspacePath(p, ownerKey, args, input = ".") {
    const ws = workspaceSnapshot(p, getWorkspace(p, ownerKey, String(args.session_id || "")));
    const raw = String(input || ".").replaceAll("\\", "/");
    if (raw.startsWith("@")) throw new Error("@root paths are not supported; select a workspace root and use a normal relative path");
    const root = projectRoots(p).find(r => r.name === ws.root.name);
    const path = await safePath(root.path, raw);
    const display = relative(root.path, path).replaceAll("\\", "/") || ".";
    return { ws, root, path, display };
  }
  function selectedRoot(p, ownerKey, args) {
    const ws = workspaceSnapshot(p, getWorkspace(p, ownerKey, String(args.session_id || "")));
    const root = projectRoots(p).find(r => r.name === ws.root.name);
    if (!root) throw new Error("Selected root is unavailable");
    return { ws, root };
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
      enabled: entry.enabled === false ? 0 : 1,
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
      enabled: row.enabled !== 0,
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
        enabled: 1,
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
      ? rows.filter(row => include_missing || (row.enabled && row.present && row.executable))
      : rows.filter(row => row.enabled && row.present && row.executable);
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
      path_precedence: "MRMCP resolves catalog logical names before normal platform PATH lookup; catalog entries override automatic first-level commands and nested paths require catalog entries",
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
      if (!registered.enabled) throw new Error(`Catalog command "${registered.name}" is disabled`);
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


  // Compact descriptors reduce context while preserving invocation semantics.
  function projectTools(p, fullAccess = true) {
    if (!fullAccess) return [];
    const enabled = new Set(parseJson(p.enabled_tools_json, BASE_TOOLS));
    if (!p.exec_enabled) for (const name of [
      "exec", "exec_start", "exec_poll", "exec_write", "exec_kill", "exec_list",
      "js", "js_add_node_module_dir", "js_reset",
    ]) enabled.delete(name);
    const session = {
      session_id: { type: "string", description: "Optional workspace session. Omit to use the OAuth/Basic client's default workspace." },
    };
    const exec = {
      program: { type: "string", description: "Command to execute. A logical_name returned by list_commands is already directly callable here, even when no same-named executable exists in the operating-system PATH: MRMCP resolves catalog aliases such as handle to handle64.exe before normal PATH lookup. Pass the logical_name exactly, normally without .exe. Never verify catalog commands with where.exe, which, Get-Command, or filesystem searches; if list_commands returned the command, invoke it directly." },
      args: { type: "array", items: { type: "string" }, default: [], description: "Structured argument vector. Pass arguments exactly as separate elements; for uv Python from stdin use [\"run\",\"-\"] and put the source in stdin rather than using shell here-document syntax." },
      shell_command: { type: "string", description: "Shell command only when shell syntax such as a pipeline or redirection is genuinely required. Do not combine with program, and do not use PowerShell/cmd as a workaround before checking list_commands for a suitable extra command." },
      cwd: { type: "string", default: ".", description: "Directory relative to the selected workspace root." },
      env: { type: "object", additionalProperties: { type: "string" } },
      stdin: { type: "string", description: "Text or Base64 input sent directly to the process. For ad-hoc Python, prefer program uv with args [\"run\",\"-\"] and place the complete Python source here. PEP 723 dependency metadata comments at the start of that source let uv resolve and install dependencies automatically in an isolated environment." },
      stdin_encoding: { type: "string", enum: ["text", "base64"], default: "text" },
      timeout_ms: { type: "integer", minimum: 0, maximum: 604800000 },
      ...session,
    };
    const defs = {
      workspace: ["List roots or select exactly one named root for a logical workspace session", {
        properties: {
          action: { type: "string", enum: ["list_roots", "new", "status", "select", "delete"], default: "status" },
          session_id: { type: "string" }, label: { type: "string" }, root: { type: "string" },
        },
      }],
      read_file: ["Read a UTF-8 file, optionally by line range", { properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }, ...session }, required: ["path"] }],
      read_files: ["Read several UTF-8 files in one request", { properties: { paths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } }, max_bytes_per_file: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576 }, ...session }, required: ["paths"] }],
      write_file: ["Create or overwrite one UTF-8 file", { properties: { path: { type: "string" }, content: { type: "string" }, create_parents: { type: "boolean", default: true }, expected_sha256: { type: "string" }, ...session }, required: ["path", "content"] }],
      write_files: ["Validate and write several UTF-8 files with rollback on failure", { properties: { files: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" }, expected_sha256: { type: "string" } }, required: ["path", "content"] } }, create_parents: { type: "boolean", default: true }, ...session }, required: ["files"] }],
      edit_file: ["Replace exact text in one file", { properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, expected_occurrences: { type: "integer", minimum: 1, default: 1 }, ...session }, required: ["path", "old_text", "new_text"] }],
      edit_files: ["Validate and apply exact replacements to several files atomically where possible", { properties: { edits: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, expected_occurrences: { type: "integer", minimum: 1, default: 1 } }, required: ["path", "old_text", "new_text"] } }, ...session }, required: ["edits"] }],
      replace_files: ["Preview or apply a bulk text/regex replacement under the selected root", { properties: { query: { type: "string" }, replacement: { type: "string" }, path: { type: "string", default: "." }, pattern: { type: "string", default: "**/*" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean", default: true }, dry_run: { type: "boolean", default: true }, max_files: { type: "integer", minimum: 1, maximum: 1000, default: 200 }, ...session }, required: ["query", "replacement"] }],
      list_files: ["Glob files recursively under the selected root", { properties: { path: { type: "string", default: "." }, pattern: { type: "string", default: "**/*" }, include_hidden: { type: "boolean" }, include_dependencies: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 10000 }, ...session } }],
      search_files: ["Grep text or a regular expression under the selected root", { properties: { query: { type: "string" }, path: { type: "string", default: "." }, pattern: { type: "string", default: "**/*" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" }, max_results: { type: "integer", minimum: 1, maximum: 2000 }, ...session }, required: ["query"] }],
      file_info: ["Return file or directory metadata", { properties: { path: { type: "string" }, ...session }, required: ["path"] }],
      create_directory: ["Create a directory and its parents", { properties: { path: { type: "string" }, ...session }, required: ["path"] }],
      copy_path: ["Copy a file or directory recursively", { properties: { from: { type: "string" }, to: { type: "string" }, ...session }, required: ["from", "to"] }],
      move_path: ["Move or rename a path", { properties: { from: { type: "string" }, to: { type: "string" }, ...session }, required: ["from", "to"] }],
      delete_path: ["Delete a file or directory", { properties: { path: { type: "string" }, recursive: { type: "boolean" }, ...session }, required: ["path"] }],
      publish_file: ["Publish an existing workspace file. In MCP Apps-capable hosts, the attached minimal preview UI displays images only from the HTTPS resource_link URL; it never embeds, reconstructs, or falls back to Base64. Use this after exec, JavaScript, or another tool creates a screenshot, chart or diagram. The default return_mode is link and is the preferred mode for the preview. inline remains available for clients that specifically need native MCP ImageContent, but it does not provide a URL and therefore cannot drive this preview. both preserves both standard forms when explicitly requested. Temporary links default to 24 hours so the preview can survive ordinary chat navigation, but remain memory-only and are invalidated by an MRMCP restart. Never read binary files as UTF-8 or manually Base64-encode them. No resize, recompression, transcoding or other image optimization is performed.", {
        properties: {
          path: { type: "string", description: "Existing file relative to the selected workspace root. Use publish_file for generated images, PDFs, archives, databases, and other binary outputs instead of read_file or js." },
          filename: { type: "string", description: "Optional filename presented to the user; defaults to the source basename." },
          mime_type: { type: "string", description: "Optional MIME type override. Normally omit it: MRMCP infers the media type from the filename extension using Deno @std/media-types and uses the corresponding HTTP Content-Type. Native MCP inline mode still requires a non-SVG raster image MIME type." },
          expires_in: { type: "integer", minimum: 30, maximum: 604800, default: 86400, description: "Temporary-link lifetime in seconds for link and both modes. Defaults to 24 hours so an MCP App preview can survive normal chat navigation; links remain memory-only and disappear when MRMCP restarts." },
          one_time: { type: "boolean", default: false, description: "Invalidate the temporary link after its first successful GET. Used only by link and both modes." },
          return_mode: { type: "string", enum: ["inline", "link", "both"], default: "link", description: "link: preferred/default; return an HTTPS resource_link used directly by the minimal MCP App image preview. inline: return only native MCP ImageContent Base64 for eligible raster images and no URL, so the preview UI cannot use it. both: explicitly return both forms for eligible raster images, while the preview UI still uses only the resource_link URL." },
          ...session,
        }, required: ["path"],
      }],
      list_commands: ["Discover MRMCP's installed extra commands by name or purpose. Every returned command is already present, executable, and directly invokable by passing commands[].logical_name unchanged to exec.program. MRMCP resolves the logical name before operating-system PATH lookup, including aliases where the physical filename differs, such as handle -> handle64.exe. Do not call where.exe, which, Get-Command, or search the filesystem to verify a returned command. Call this before falling back to PowerShell, cmd, or a platform-specific shell workaround whenever a catalog command may perform the task.", {
        properties: {
          query: { type: "string", description: "Case-insensitive search over logical name, relative path and agent-facing description. Use a task keyword such as screenshot when you do not yet know the command name." },
          page: { type: "integer", minimum: 1, default: 1 },
          page_size: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
      }],
      exec: ["Run a foreground command. Commands returned by list_commands are directly callable: pass the exact logical_name as program without first using where.exe, which, Get-Command, or a filesystem probe. MRMCP resolves catalog logical names and aliases before normal platform PATH lookup, so a logical name may intentionally differ from its physical executable filename. Prefer these extra commands over PowerShell, cmd, or an improvised shell script when the catalog covers the task. For Python, discover and prefer uv: run files with program uv and args [\"run\",\"script.py\"]; run source directly from this tool call with args [\"run\",\"-\"] and stdin containing the Python source. PEP 723 inline dependency comments are supported and dependencies are resolved automatically. For screenshots, search list_commands for screenshot and run screenshot-cmd. Use return_files for standard MCP attachments, or omit return_files and call publish_file afterward when a visible MCP App file preview is desired. When any command creates files the user should see or download, return_files emits native MCP image blocks for eligible raster images and temporary resource_link blocks for every file. Do not read or manually Base64-encode binary outputs with read_file or js.", { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: {
        ...exec,
        timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 },
        return_files: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" }, description: "Output files to attach after successful completion. Relative paths are resolved from the command cwd; absolute paths are accepted only inside the selected workspace root." },
        return_files_expires_in: { type: "integer", minimum: 30, maximum: 604800, default: 86400, description: "Lifetime of generated temporary download links; defaults to 24 hours and remains memory-only." },
        return_files_one_time: { type: "boolean", default: false, description: "Invalidate each generated link after its first successful GET." },
        return_files_inline: { type: "boolean", default: true, description: "Also include raster images inline as native MCP image content, with a combined 8 MiB inline budget." },
      } }],
      exec_start: ["Start an interactive/background command; use exec_poll, exec_write and exec_kill", { oneOf: [{ required: ["program"] }, { required: ["shell_command"] }], properties: { ...exec, keep_stdin_open: { type: "boolean", default: true }, timeout_ms: { type: "integer", minimum: 0, maximum: 604800000, default: 0 } } }],
      exec_poll: ["Read incremental stdout, stderr and status for a managed process", { properties: { process_id: { type: "string" }, stdout_offset: { type: "integer", minimum: 0, default: 0 }, stderr_offset: { type: "integer", minimum: 0, default: 0 }, wait_ms: { type: "integer", minimum: 0, maximum: 30000, default: 0 } }, required: ["process_id"] }],
      exec_write: ["Write text or Base64 to process stdin, or close stdin", { properties: { process_id: { type: "string" }, data: { type: "string", default: "" }, encoding: { type: "string", enum: ["text", "base64"], default: "text" }, close: { type: "boolean", default: false } }, required: ["process_id"] }],
      exec_kill: ["Terminate or force-kill a managed process", { properties: { process_id: { type: "string" }, signal: { type: "string", enum: ["SIGTERM", "SIGKILL"], default: "SIGTERM" } }, required: ["process_id"] }],
      exec_list: ["List active and recent processes owned by this client", { properties: { include_completed: { type: "boolean", default: true }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } } }],
      js: ["Run JavaScript in a persistent Deno worker for this client and workspace", {
        properties: {
          code: { type: "string", description: "JavaScript. State persists; use globalThis assignments when persistence across top-level await matters." },
          cwd: { type: "string", default: ".", description: "Directory relative to the selected workspace root." },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000, default: 30000 },
          ...session,
        }, required: ["code"],
      }],
      js_add_node_module_dir: ["Add a project or node_modules directory to this JavaScript kernel", {
        properties: {
          path: { type: "string", description: "Directory relative to the selected workspace root." },
          ...session,
        }, required: ["path"],
      }],
      js_reset: ["Terminate and reset this client's persistent JavaScript kernel", {
        properties: { ...session },
      }],
    };
    const titles = {
      workspace: "Workspace root", read_file: "Read", read_files: "Read batch",
      write_file: "Write", write_files: "Write batch", edit_file: "Edit",
      edit_files: "Multi edit", replace_files: "Bulk replace", list_files: "Glob",
      search_files: "Grep", publish_file: "Publish file",
      list_commands: "Command catalog", exec: "Bash", exec_start: "Bash background",
      exec_poll: "Bash output", exec_write: "Write stdin", exec_kill: "Kill shell",
      exec_list: "List processes", js: "JavaScript REPL",
      js_add_node_module_dir: "Add module directory", js_reset: "Reset JavaScript REPL",
    };
    const annotations = name => ({
      readOnlyHint: READ_TOOLS.has(name) || ["workspace", "publish_file"].includes(name),
      destructiveHint: ["write_file", "write_files", "edit_file", "edit_files", "replace_files", "move_path", "delete_path", "exec", "exec_start", "exec_write", "exec_kill", "js", "js_add_node_module_dir", "js_reset"].includes(name),
      idempotentHint: (READ_TOOLS.has(name) && name !== "publish_file") ||
        ["write_file", "write_files", "edit_file", "edit_files", "create_directory", "js_reset"].includes(name),
      openWorldHint: name.startsWith("exec") || name === "js" || name === "publish_file",
    });
    const schema = value => ({ "$schema": "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, ...value });
    const tools = [...enabled].filter(name => defs[name]).map(name => ({
      name, title: titles[name] || name.replaceAll("_", " ").replace(/\b\w/g, x => x.toUpperCase()),
      description: defs[name][0], inputSchema: schema(defs[name][1]), annotations: annotations(name),
      ...(name === "publish_file" ? {
        _meta: {
          ui: { resourceUri: FILE_PREVIEW_UI_URI },
          "openai/outputTemplate": FILE_PREVIEW_UI_URI,
          "openai/toolInvocation/invoking": "Preparing file preview…",
          "openai/toolInvocation/invoked": "File preview ready.",
        },
      } : {}),
    }));
    for (const c of all("SELECT * FROM custom_tools WHERE project_id=? AND enabled=1 ORDER BY name", p.id)) tools.push({
      name: c.name,
      title: c.name.replaceAll("_", " ").replace(/\b\w/g, x => x.toUpperCase()),
      description: c.description || `Run configured command: ${c.command}`,
      inputSchema: schema({ properties: {
        args: { type: "array", items: { type: "string" }, default: [] },
        shell_command_suffix: { type: "string" }, cwd: { type: "string", default: "." },
        env: { type: "object", additionalProperties: { type: "string" } }, stdin: { type: "string", description: "Optional text sent directly to the configured command standard input." },
        timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, default: 120000 }, ...session,
      } }),
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
    return errors;
  }
  function mcpSelfTest(p) {
    const tools = projectTools(p);
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
      project: p.slug,
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
            name: "MRMCP",
            version: VERSION,
          },
        },
        ttlMs: 300000,
        cacheScope: "private",
      },
      initialize_result: {
        protocolVersion: MCP_DEFAULT_PROTOCOL,
        capabilities: serverCapabilities(true),
        serverInfo: { name: "MRMCP", version: VERSION },
      },
      modern_tools_list_result: {
        resultType: "complete",
        tools,
        ttlMs: 300000,
        cacheScope: "private",
      },
      legacy_tools_list_result: { tools },
      resources_list_result: { resources: [resource] },
      resources_read_result: {
        contents: [{
          uri: FILE_PREVIEW_UI_URI, mimeType: MCP_UI_MIME_TYPE,
          text: filePreviewAppHtml(), _meta: filePreviewUiMeta(),
        }],
      },
    };
  }

  function beginLog(p, tool, args) {
    const inserted = run(`INSERT INTO logs(started_at,project_id,project_slug,tool,status,input_json)
      VALUES(?,?,?,?,'received',?)`, Date.now(), p.id, p.slug, tool, JSON.stringify(args));
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
      run("INSERT INTO logs_fts(log_id,project,tool,input,output,stderr,error) VALUES(?,?,?,?,?,?,?)",
        id, l.project_slug, l.tool, l.input_json, l.result_json || l.resolved_json || l.stdout || '', l.stderr, l.error);
    } catch {}
  }
  function rejectToolCall(p, tool, args, message, decision = "deny", rule = "request validation") {
    const id = beginLog(p, tool, args), completed = Date.now();
    updateLog(id, {
      completed_at: completed, duration_ms: 0, status: "failed", decision, matched_rule: rule,
      error: message, result_json: JSON.stringify({ error: message }),
    });
    indexLog(id);
    return id;
  }
  async function policy(p, tool, args, custom, logId) {
    const subject = `${tool}\n${JSON.stringify(args)}`;
    if (p.deny_re) {
      let re; try { re = new RegExp(p.deny_re); } catch { throw new Error("Invalid deny regex"); }
      if (re.test(subject)) return { allow: false, decision: "deny", rule: "deny regex" };
    }
    if (p.allow_re) {
      let re; try { re = new RegExp(p.allow_re); } catch { throw new Error("Invalid allow regex"); }
      if (re.test(subject)) return { allow: true, decision: "allow", rule: "allow regex" };
    }
    let mode = custom?.confirm_mode && custom.confirm_mode !== "inherit"
      ? custom.confirm_mode : p.confirm_mode;
    const readOnlyCall = READ_TOOLS.has(tool) ||
      (tool === "workspace" && ["list_roots", "status"].includes(String(args.action || "status")));
    if (readOnlyCall && mode === "ask") mode = "allow";
    if (mode === "allow") return { allow: true, decision: "allow", rule: "project policy" };
    if (mode === "deny") return { allow: false, decision: "deny", rule: "project policy" };
    const id = uid();
    updateLog(logId, { status: "awaiting_approval" });
    const allowed = await new Promise(resolve => {
      approvals.set(id, {
        id, log_id: logId, project: p.slug, tool, input: args, created_at: Date.now(), resolve,
      });
      setTimeout(() => {
        const a = approvals.get(id);
        if (a) { approvals.delete(id); a.resolve(false); }
      }, 300000);
    });
    return { allow: allowed, decision: allowed ? "allow" : "deny", rule: "user confirmation" };
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
    return {
      program: win ? "cmd.exe" : "/bin/sh",
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
      cwd: rec.cwd_display, workspace_session: rec.workspace_session,
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
  async function startManagedProcess(p, ownerKey, args, background) {
    const target = await resolveWorkspacePath(p, ownerKey, args, args.cwd || ".");
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
    const suppliedEnv = Object.fromEntries(Object.entries(args.env || {}).map(([k, v]) => [k, String(v)]));
    const pathKey = Deno.build.os === "windows" ? "Path" : "PATH";
    const inheritedPath = suppliedEnv.PATH || suppliedEnv.Path || Deno.env.get("PATH") || Deno.env.get("Path") || "";
    delete suppliedEnv.PATH; delete suppliedEnv.Path;
    suppliedEnv[pathKey] = BIN_DIR + (Deno.build.os === "windows" ? ";" : ":") + inheritedPath;
    suppliedEnv.MRMCP_BIN = BIN_DIR;
    const child = new Deno.Command(spec.program, {
      args: spec.argv, cwd: target.path, env: suppliedEnv,
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const rec = {
      id: `proc_${randomToken(18)}`, pid: child.pid, child, owner_key: ownerKey,
      project_id: p.id, project_slug: p.slug, workspace_session: target.ws.session_id,
      display: spec.display, command_json: JSON.stringify({
        program: spec.program, args: spec.argv, shell: spec.shell,
        catalog_name: spec.catalog_name || null,
      }),
      root_path: target.root.path, root_name: target.root.name,
      cwd: target.path, cwd_display: target.display, status: "running", started_at: Date.now(), completed_at: null,
      exit_code: null, signal: "", timed_out: false, error: "",
      stdout: "", stderr: "", stdout_base: 0, stderr_base: 0, updated_at: Date.now(),
      stdin_writer: child.stdin.getWriter(), timeout_timer: null, done: null,
    };
    processes.set(rec.id, rec);
    run(`INSERT INTO process_runs(id,pid,project_id,project_slug,workspace_session,owner_key,
      command_json,cwd,status,started_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id, rec.pid, p.id, p.slug, rec.workspace_session, ownerKey, rec.command_json,
      rec.cwd_display, rec.status, rec.started_at, timeout);
    const stdoutPump = pumpProcess(child.stdout, rec, "stdout"), stderrPump = pumpProcess(child.stderr, rec, "stderr");
    rec.done = child.status.then(async status => {
      await Promise.allSettled([stdoutPump, stderrPump]);
      rec.completed_at = Date.now();
      rec.exit_code = status.code;
      rec.signal ||= status.signal || "";
      rec.status = rec.timed_out ? "timed_out" : status.success ? "completed" : rec.signal ? "killed" : "failed";
      if (rec.timeout_timer) clearTimeout(rec.timeout_timer);
      try { await rec.stdin_writer?.close(); } catch {}
      rec.stdin_writer = null;
      run(`UPDATE process_runs SET status=?,completed_at=?,exit_code=?,signal=?,stdout_tail=?,stderr_tail=?,error=? WHERE id=?`,
        rec.status, rec.completed_at, rec.exit_code, rec.signal, processTail(rec.stdout), processTail(rec.stderr), rec.error, rec.id);
      return rec;
    }).catch(e => {
      rec.completed_at = Date.now(); rec.status = "failed"; rec.error = String(e?.stack || e);
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
  function ownedProcess(id, ownerKey) {
    const rec = processes.get(String(id));
    if (!rec || rec.owner_key !== ownerKey)
      throw new Error("Unknown process_id (processes do not survive server restart)");
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
    run("DELETE FROM workspace_sessions WHERE label!='_default' AND updated_at<?",
      now - 90 * 24 * 60 * 60 * 1000);
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
  function recentProcesses(ownerKey, includeCompleted = true, limit = 50) {
    const active = [...processes.values()].filter(r => r.owner_key === ownerKey && (includeCompleted || r.status === "running"));
    const ids = new Set(active.map(r => r.id));
    const historic = includeCompleted ? all(`SELECT * FROM process_runs WHERE owner_key=? ORDER BY started_at DESC LIMIT ?`, ownerKey, limit)
      .filter(r => !ids.has(r.id)).map(r => ({
        process_id: r.id, pid: r.pid, status: r.status, command: parseJson(r.command_json, r.command_json),
        cwd: r.cwd, workspace_session: r.workspace_session, started_at: new Date(r.started_at).toISOString(),
        completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
        exit_code: r.exit_code, signal: r.signal || null, stdout_tail: r.stdout_tail,
        stderr_tail: r.stderr_tail, error: r.error,
      })) : [];
    return [...active.map(r => processView(r)), ...historic].slice(0, limit);
  }

  function jsKernelKey(p, ownerKey, sessionId) {
    return `${p.id}:${ownerKey}:${sessionId}`;
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
    const worker = new Worker(url, { type: "module", deno: { permissions: "inherit" } });
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
  function jsKernelContext(p, ownerKey, args) {
    const selection = selectedRoot(p, ownerKey, args);
    const key = jsKernelKey(p, ownerKey, selection.ws.session_id);
    return { selection, key, kernel: jsKernels.get(key) || createJsKernel(key) };
  }

  async function executeTool(p, name, args, context) {
    const ownerKey = context.ownerKey;
    if (name === "workspace") return workspaceAction(p, ownerKey, args);
    const readOne = async pathArg => {
      const target = await resolveWorkspacePath(p, ownerKey, args, pathArg);
      const lines = (await Deno.readTextFile(target.path)).split(/\r?\n/);
      const start = Math.max(1, Number(args.start_line || 1));
      const end = Math.min(lines.length, Number(args.end_line || lines.length));
      return { path: target.display, start_line: start, end_line: end, content: lines.slice(start - 1, end).join("\n") };
    };
    if (name === "read_file") return await readOne(args.path);
    if (name === "read_files") {
      const max = Math.min(Number(args.max_bytes_per_file || 1048576), 5242880), files = [];
      for (const item of args.paths || []) {
        try {
          const target = await resolveWorkspacePath(p, ownerKey, args, item), st = await Deno.stat(target.path);
          if (st.size > max) files.push({ path: target.display, error: `File exceeds ${max} bytes`, size: st.size });
          else files.push({ path: target.display, content: await Deno.readTextFile(target.path), size: st.size });
        } catch (e) { files.push({ path: String(item), error: String(e?.message || e) }); }
      }
      return { files };
    }
    if (name === "write_file") {
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path);
      if (args.expected_sha256) {
        const current = await fileHash(target.path).catch(() => "");
        if (current !== args.expected_sha256) throw new Error("File hash changed");
      }
      if (args.create_parents !== false) await Deno.mkdir(dirname(target.path), { recursive: true });
      await Deno.writeTextFile(target.path, String(args.content));
      return { path: target.display, bytes: enc.encode(String(args.content)).length, sha256: await fileHash(target.path) };
    }
    if (name === "write_files") {
      const changes = [];
      for (const file of args.files || []) {
        const target = await resolveWorkspacePath(p, ownerKey, args, file.path);
        let before = null;
        try { before = await Deno.readFile(target.path); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
        if (file.expected_sha256) {
          const current = before ? await sha256(before) : "";
          if (current !== file.expected_sha256) throw new Error(`${file.path}: file hash changed`);
        }
        changes.push({ target, before, content: String(file.content) });
      }
      try {
        for (const c of changes) {
          if (args.create_parents !== false) await Deno.mkdir(dirname(c.target.path), { recursive: true });
          await Deno.writeTextFile(c.target.path, c.content);
        }
      } catch (e) {
        for (const c of changes) {
          try { c.before == null ? await Deno.remove(c.target.path) : await Deno.writeFile(c.target.path, c.before); } catch {}
        }
        throw e;
      }
      return { files: await Promise.all(changes.map(async c => ({ path: c.target.display, sha256: await fileHash(c.target.path) }))) };
    }
    if (name === "edit_file" || name === "edit_files") {
      const edits = name === "edit_file" ? [args] : (args.edits || []), changes = [];
      for (const edit of edits) {
        const target = await resolveWorkspacePath(p, ownerKey, args, edit.path), before = await Deno.readTextFile(target.path);
        const count = before.split(String(edit.old_text)).length - 1, expected = Number(edit.expected_occurrences ?? 1);
        if (count !== expected) throw new Error(`${edit.path}: expected ${expected} occurrences, found ${count}`);
        changes.push({ target, before, after: before.split(String(edit.old_text)).join(String(edit.new_text)), count });
      }
      try { for (const c of changes) await Deno.writeTextFile(c.target.path, c.after); }
      catch (e) { for (const c of changes) await Deno.writeTextFile(c.target.path, c.before).catch(() => {}); throw e; }
      return { files: changes.map(c => ({ path: c.target.display, replacements: c.count })) };
    }
    if (name === "replace_files") {
      const dryRun = args.dry_run !== false;
      const flags = args.case_sensitive === false ? "gim" : "gm";
      const source = args.regex ? String(args.query) : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(source, flags), changes = [];
      const selection = selectedRoot(p, ownerKey, args);
      for (const rel of await walk(selection.root.path, args.path || ".", {
        pattern: args.pattern || "**/*", limit: Number(args.max_files || 200),
      })) {
        const path = await safePath(selection.root.path, rel);
        try {
          const before = await Deno.readTextFile(path); regex.lastIndex = 0;
          const matches = [...before.matchAll(regex)].length; regex.lastIndex = 0;
          if (matches) changes.push({ path, before, after: before.replace(regex, String(args.replacement)), matches });
        } catch {}
        if (changes.length >= Number(args.max_files || 200)) break;
      }
      if (!dryRun) {
        try { for (const c of changes) await Deno.writeTextFile(c.path, c.after); }
        catch (e) { for (const c of changes) await Deno.writeTextFile(c.path, c.before).catch(() => {}); throw e; }
      }
      return { workspace_session: selection.ws.session_id, root: selection.root.name, dry_run: dryRun,
        files: changes.map(c => ({ path: relative(selection.root.path, c.path).replaceAll("\\", "/"), replacements: c.matches })) };
    }
    if (name === "list_files") {
      const selection = selectedRoot(p, ownerKey, args);
      return { workspace_session: selection.ws.session_id, root: selection.root.name,
        files: await walk(selection.root.path, args.path || ".", args) };
    }
    if (name === "search_files") {
      const flags = args.case_sensitive ? "g" : "gi";
      const source = args.regex ? String(args.query) : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(source, flags), results = [], max = Math.min(Number(args.max_results || 300), 2000);
      const selection = selectedRoot(p, ownerKey, args);
      for (const file of await walk(selection.root.path, args.path || ".", { pattern: args.pattern || "**/*", limit: 10000 })) {
        try {
          const path = await safePath(selection.root.path, file), st = await Deno.stat(path);
          if (st.size > 5 * 1024 * 1024) continue;
          const lines = (await Deno.readTextFile(path)).split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < max; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) results.push({ path: file, line: i + 1, text: lines[i] });
          }
        } catch {}
        if (results.length >= max) break;
      }
      return { workspace_session: selection.ws.session_id, root: selection.root.name,
        results, truncated: results.length >= max };
    }
    if (name === "file_info") {
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path), st = await Deno.lstat(target.path);
      return { path: target.display, name: basename(target.path), is_file: st.isFile, is_directory: st.isDirectory,
        is_symlink: st.isSymlink, size: st.size, modified_at: st.mtime?.toISOString() || null,
        created_at: st.birthtime?.toISOString() || null };
    }
    if (name === "create_directory") {
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path); await Deno.mkdir(target.path, { recursive: true });
      return { path: target.display, created: true };
    }
    if (name === "copy_path" || name === "move_path") {
      const from = await resolveWorkspacePath(p, ownerKey, args, args.from), to = await resolveWorkspacePath(p, ownerKey, args, args.to);
      await Deno.mkdir(dirname(to.path), { recursive: true });
      if (name === "copy_path") await copyRecursive(from.path, to.path);
      else {
        try { await Deno.rename(from.path, to.path); }
        catch (e) {
          if (!(e instanceof Deno.errors.NotSupported) && e?.code !== "EXDEV") throw e;
          await copyRecursive(from.path, to.path); await Deno.remove(from.path, { recursive: true });
        }
      }
      return { from: from.display, to: to.display };
    }
    if (name === "delete_path") {
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path);
      if (resolve(target.path) === resolve(await Deno.realPath(target.root.path))) throw new Error("Cannot delete a configured root");
      await Deno.remove(target.path, { recursive: !!args.recursive });
      return { path: target.display, deleted: true };
    }
    if (name === "publish_file") {
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path);
      const result = await publishPath(target.path, {
        filename: args.filename || basename(target.path), mime_type: args.mime_type,
        expires_in: args.expires_in, one_time: args.one_time,
        return_mode: args.return_mode || (args.inline === true ? "both" : "link"),
        allowed_root: target.root.path,
      });
      return { workspace_session: target.ws.session_id, root: target.root.name, path: target.display, ...result };
    }
    if (name === "list_commands") return await commandCatalog({ ...args, admin: false, include_missing: false });
    if (name === "js") {
      const { selection, kernel } = jsKernelContext(p, ownerKey, args);
      const cwd = await resolveWorkspacePath(p, ownerKey, args, args.cwd || ".");
      const result = await jsKernelCall(kernel, {
        action: "eval", code: String(args.code), cwd: cwd.path,
      }, Math.min(Number(args.timeout_ms || 30000), 120000));
      kernel.module_dirs = result.module_dirs || kernel.module_dirs;
      return {
        kernel_id: kernel.key, workspace_session: selection.ws.session_id,
        root: selection.root.name, cwd: cwd.display, ...result,
      };
    }
    if (name === "js_add_node_module_dir") {
      const { selection, kernel } = jsKernelContext(p, ownerKey, args);
      const target = await resolveWorkspacePath(p, ownerKey, args, args.path);
      if (!(await Deno.stat(target.path)).isDirectory) throw new Error("Module path is not a directory");
      const result = await jsKernelCall(kernel, { action: "add_dir", path: target.path }, 10000);
      kernel.module_dirs = result.module_dirs;
      return {
        kernel_id: kernel.key, workspace_session: selection.ws.session_id,
        path: target.display, module_dirs: result.module_dirs,
      };
    }
    if (name === "js_reset") {
      const selection = selectedRoot(p, ownerKey, args);
      const key = jsKernelKey(p, ownerKey, selection.ws.session_id);
      return { reset: destroyJsKernel(key), kernel_id: key, workspace_session: selection.ws.session_id };
    }
    if (name === "exec" || name === "exec_start") {
      const rec = await startManagedProcess(p, ownerKey, args, name === "exec_start");
      if (name === "exec_start") return processView(rec);
      await rec.done;
      const view = processView(rec), returned = await processReturnFiles(rec, args);
      return returned ? { ...view, returned_files: returned.returned_files, mcp_content: returned.mcp_content } : view;
    }
    if (name === "exec_poll") return await pollManagedProcess(ownedProcess(args.process_id, ownerKey), args);
    if (name === "exec_write") {
      const rec = ownedProcess(args.process_id, ownerKey);
      if (!rec.stdin_writer) throw new Error("Process stdin is closed");
      if (args.data) await rec.stdin_writer.write(args.encoding === "base64"
        ? new Uint8Array(Buffer.from(String(args.data), "base64")) : enc.encode(String(args.data)));
      if (args.close) { await rec.stdin_writer.close(); rec.stdin_writer = null; }
      return { process_id: rec.id, bytes_written: args.data ? (args.encoding === "base64" ? Buffer.from(String(args.data), "base64").length : enc.encode(String(args.data)).length) : 0, stdin_open: !!rec.stdin_writer };
    }
    if (name === "exec_kill") {
      const rec = ownedProcess(args.process_id, ownerKey);
      return { process_id: rec.id, killed: await terminateProcess(rec, args.signal || "SIGTERM"), signal: args.signal || "SIGTERM" };
    }
    if (name === "exec_list") return { processes: recentProcesses(ownerKey, args.include_completed !== false, Math.min(Number(args.limit || 50), 200)) };
    const custom = one("SELECT * FROM custom_tools WHERE project_id=? AND name=? AND enabled=1", p.id, name);
    if (!custom) throw new Error("Unknown or disabled tool");
    const arrayCommand = parseJson(custom.command, null);
    const customArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const spec = Array.isArray(arrayCommand) && arrayCommand.length
      ? { ...args, program: String(arrayCommand[0]), args: [...arrayCommand.slice(1).map(String), ...customArgs] }
      : { ...args, shell_command: custom.command + (args.shell_command_suffix ? " " + args.shell_command_suffix : "") };
    const rec = await startManagedProcess(p, ownerKey, spec, false); await rec.done; return processView(rec);
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

  async function callTool(p, name, args, context) {
    const id = beginLog(p, name, args), started = Date.now();
    try {
      const custom = one("SELECT * FROM custom_tools WHERE project_id=? AND name=? AND enabled=1", p.id, name);
      const allowedNames = new Set(projectTools(p, true).map(t => t.name));
      if (!allowedNames.has(name)) throw new Error("Tool disabled or unknown");
      const pol = await policy(p, name, args, custom, id);
      updateLog(id, { decision: pol.decision, matched_rule: pol.rule });
      if (!pol.allow) throw new Error("Denied by policy or user");
      updateLog(id, { status: "running" });
      const result = await executeTool(p, name, args, context);
      const { mcp_content: mcpContent, ...publicResult } = result && typeof result === "object" ? result : { value: result };
      const publicLogResult = redactTemporaryDownloadUrls(publicResult);
      const stdout = typeof publicLogResult.stdout === "string" ? publicLogResult.stdout : JSON.stringify(publicLogResult, null, 2);
      const stderr = typeof publicLogResult.stderr === "string" ? publicLogResult.stderr : "";
      const status = publicResult.success === false ? "failed" : "completed";
      const structuredContent = { execution_log_id: id, ...publicResult };
      const full = typeof publicResult.content === "string" ? publicResult.content : JSON.stringify(structuredContent, null, 2);
      const max = 1024 * 1024, rendered = full.length > max ? full.slice(0, max) + `

[truncated; full output in log ${id}]` : full;
      const publicationContentOnly = name === "publish_file" && Array.isArray(mcpContent) && mcpContent.length > 0;
      const inlineOnlyPublication = publicationContentOnly && publicResult.return_mode === "inline";
      const content = Array.isArray(mcpContent)
        ? (publicationContentOnly ? [...mcpContent] : [...mcpContent, { type: "text", text: rendered }])
        : [{ type: "text", text: rendered }];
      const toolResult = inlineOnlyPublication
        ? { content, isError: status !== "completed" }
        : { content, structuredContent, isError: status !== "completed" };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status,
        resolved_json: JSON.stringify(publicLogResult), stdout, stderr,
        result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      return toolResult;
    } catch (e) {
      const message = String(e?.stack || e);
      const toolResult = {
        content: [{ type: "text", text: `${String(e?.message || e)}\nExecution log: ${id}` }],
        isError: true,
      };
      updateLog(id, {
        completed_at: Date.now(), duration_ms: Date.now() - started, status: "failed",
        error: message, result_json: JSON.stringify(toolResultForLog(toolResult)),
      });
      indexLog(id);
      return toolResult;
    }
  }

  // Authentication: OAuth and Basic are project-scoped; localhost is trusted.
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
  async function authenticateRequest(req, p, remoteHost) {
    const remote = !localOrPrivateAddress(remoteHost);
    const authorization = req.headers.get("authorization") || "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer && p.oauth) {
      const hash = await sha256(bearer[1]);
      const token = one(`SELECT token_hash,client_id FROM oauth_tokens
        WHERE token_hash=? AND project_id=? AND expires_at>?`, hash, p.id, Date.now());
      if (token) return { full: true, kind: "oauth", ownerKey: `oauth:${p.id}:${token.client_id}` };
    }
    const basic = /^Basic\s+(.+)$/i.exec(authorization);
    if (basic && p.basic_enabled) {
      try {
        const decoded = Buffer.from(basic[1], "base64").toString("utf8"), colon = decoded.indexOf(":"),
          username = colon < 0 ? decoded : decoded.slice(0, colon), password = colon < 0 ? "" : decoded.slice(colon + 1),
          expected = openSecret(p.basic_secret_enc);
        if (expected && safeEqual(username, p.basic_username) && safeEqual(password, expected))
          return { full: true, kind: "basic", ownerKey: `basic:${p.id}:${await sha256(decoded)}` };
      } catch {}
    }
    if (!remote) return { full: true, kind: "local", ownerKey: `local:${remoteHost || "loopback"}` };
    return { full: false, kind: "anonymous", ownerKey: `anonymous:${remoteHost || "unknown"}` };
  }
  function authChallenge(p) {
    const schemes = [];
    if (p.oauth) schemes.push(`Bearer resource_metadata="${metadataUrl(p)}", scope="project:${p.slug}"`);
    if (p.basic_enabled) schemes.push(`Basic realm="MRMCP ${p.slug}", charset="UTF-8"`);
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
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
    const match = resourceUrl.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
    const p = match && one("SELECT * FROM projects WHERE slug=? AND enabled=1 AND oauth=1", match[1]);
    if (!p || resourceUrl.href !== mcpUrl(p)) return { error: "resource is not an OAuth-enabled project" };
    const scope = q.get("scope") || `project:${p.slug}`;
    if (scope !== `project:${p.slug}`) return { error: "invalid scope" };

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

  // OAuth discovery/authorization and modern + legacy MCP routing.
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
        scopes_supported: all("SELECT slug FROM projects WHERE enabled=1 AND oauth=1")
          .map(x => `project:${x.slug}`),
      });
    }
    let m = u.pathname.match(/^\/\.well-known\/oauth-protected-resource\/mcp\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const p = one("SELECT * FROM projects WHERE slug=? AND enabled=1", m[1]);
      if (!p) return json({ error: "Project not found" }, 404);
      return json({
        resource: mcpUrl(p),
        authorization_servers: p.oauth ? [publicBase()] : [],
        scopes_supported: p.oauth ? [`project:${p.slug}`] : [],
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
      return text(`<!doctype html><meta charset=utf-8><title>Authorize MRMCP</title>
<style>body{font:16px system-ui;max-width:560px;margin:70px auto;background:#111;color:#eee}
.card{background:#1c1c1c;padding:28px;border-radius:12px}button{padding:10px 18px;margin-right:8px}</style>
<div class=card><h2>Authorize ${htmlEscape(auth.client.name)}</h2>
<p>Allow access to project <b>${htmlEscape(auth.p.name)}</b>?</p>
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
        run(`INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,project_id,resource,scope,expires_at)
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
        const tokenProject = c ? one("SELECT enabled,oauth FROM projects WHERE id=?", c.project_id) : null;
        const tokenResource = q.get("resource") || "";
        if (!c || !tokenProject?.enabled || !tokenProject.oauth || c.expires_at < now ||
            c.client_id !== q.get("client_id") || c.redirect_uri !== q.get("redirect_uri") ||
            (tokenResource && tokenResource !== c.resource) ||
            await sha256(q.get("code_verifier") || "") !== c.code_challenge)
          return json({ error: "invalid_grant" }, 400);
        run("DELETE FROM oauth_codes WHERE code_hash=?", codeHash);
        const accessToken = randomToken(32), refreshToken = randomToken(48);
        run("INSERT INTO oauth_tokens(token_hash,client_id,project_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
          await sha256(accessToken), c.client_id, c.project_id, c.scope, now,
          now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
        run(`INSERT INTO oauth_refresh_tokens(token_hash,client_id,project_id,resource,scope,created_at,last_used_at)
          VALUES(?,?,?,?,?,?,?)`, await sha256(refreshToken), c.client_id, c.project_id, c.resource, c.scope, now, now);
        return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer",
          expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scope: c.scope });
      }
      if (grantType === "refresh_token") {
        const suppliedRefreshToken = q.get("refresh_token") || "";
        const refreshHash = await sha256(suppliedRefreshToken);
        const r = one("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?", refreshHash);
        const tokenProject = r ? one("SELECT enabled,oauth FROM projects WHERE id=?", r.project_id) : null;
        const tokenResource = q.get("resource") || "";
        const requestedClientId = q.get("client_id") || r?.client_id || "";
        if (!r || !tokenProject?.enabled || !tokenProject.oauth || r.client_id !== requestedClientId ||
            (tokenResource && tokenResource !== r.resource))
          return json({ error: "invalid_grant" }, 400);
        const accessToken = randomToken(32);
        run("UPDATE oauth_refresh_tokens SET last_used_at=? WHERE token_hash=?", now, refreshHash);
        run("INSERT INTO oauth_tokens(token_hash,client_id,project_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
          await sha256(accessToken), r.client_id, r.project_id, r.scope, now,
          now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
        return json({ access_token: accessToken, refresh_token: suppliedRefreshToken, token_type: "Bearer",
          expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scope: r.scope });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    m = u.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
    if (!m) return json({ error: "Not found" }, 404);
    if (!validOrigin(req)) return json({ error: "Invalid Origin" }, 403);
    const p = one("SELECT * FROM projects WHERE slug=? AND enabled=1", m[1]);
    if (!p) return json({ error: "Project not found" }, 404);
    if (req.method !== "POST") return json({ error: "Streamable HTTP accepts POST here" }, 405, { allow: "POST" });
    const remoteHost = info?.remoteAddr?.hostname || "";
    const remoteRequest = !localOrPrivateAddress(remoteHost);
    if (transport === "http" && remoteRequest && mcpTlsActive)
      return json({ error: "Use HTTPS" }, 426, { location: `${automaticExternalBase()}/mcp/${p.slug}` });
    const auth = await authenticateRequest(req, p, remoteHost);
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
    const bodyProtocol = String(
      requestMeta["io.modelcontextprotocol/protocolVersion"] || "",
    );
    const headerProtocol = String(req.headers.get("mcp-protocol-version") || "");
    const headerMethod = String(req.headers.get("mcp-method") || "");
    const modernRequest =
      headerProtocol === MCP_MODERN_PROTOCOL ||
      bodyProtocol === MCP_MODERN_PROTOCOL ||
      x.method === "server/discover";

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
      return rejectToolCall(p, toolName, x.params?.arguments || x.params || {}, message, "deny", rule);
    };

    if (modernRequest) {
      if (!headerProtocol || !bodyProtocol || headerProtocol !== bodyProtocol) {
        rejectParsedToolCall("MCP header and body metadata do not match");
        return rpcError(400, -32020, "MCP header and body metadata do not match", {
          headerProtocol,
          bodyProtocol,
        });
      }
      if (headerMethod !== x.method) {
        rejectParsedToolCall("Mcp-Method header does not match the JSON-RPC method");
        return rpcError(400, -32020, "Mcp-Method header does not match the JSON-RPC method", {
          headerMethod,
          bodyMethod: x.method,
        });
      }
      if (headerProtocol !== MCP_MODERN_PROTOCOL) {
        rejectParsedToolCall(`Unsupported protocol version: ${headerProtocol || "missing"}`);
        return rpcError(400, -32022, "Unsupported protocol version", {
          supported: MCP_PROTOCOLS,
          requested: headerProtocol,
        });
      }
      if (x.method === "tools/call") {
        const headerName = String(req.headers.get("mcp-name") || "");
        const bodyName = String(x.params?.name || "");
        if (!headerName || headerName !== bodyName) {
          rejectParsedToolCall("Mcp-Name header does not match params.name");
          return rpcError(400, -32020, "Mcp-Name header does not match params.name", {
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
        name: "MRMCP",
        version: VERSION,
      },
    };
    const rootSummary = projectRoots(p).map(r => r.name).join(", ") || "none";
    const instructions = fullAccess
      ? `Tools operate inside project "${p.name}" (${p.slug}). Available named directories: ${rootSummary}. ` +
        "Each workspace session selects exactly one directory; tool paths are normal paths relative to it. " +
        "Call workspace(action='new') only when a separate logical session is needed. " +
        "Before using PowerShell, cmd, or an improvised shell workaround, call list_commands with a task keyword and prefer a suitable MRMCP extra command through exec.program. Every command returned by list_commands is already present and directly callable by its logical_name; do not verify it with where.exe, which, Get-Command, or filesystem searches. MRMCP resolves logical aliases before operating-system PATH lookup, so the physical filename may differ. " +
        "For Python work, discover and prefer uv. Execute a file with exec program uv and args [\"run\",\"script.py\"]; execute source from the tool call with args [\"run\",\"-\"] and stdin containing the Python script. PEP 723 dependency comments are automatically resolved by uv; include generated files such as Matplotlib PNGs in return_files. " +
        "For screenshots, discover screenshot-cmd and run it through exec. Use return_files for standard MCP attachments; to request the sandboxed MCP App preview, create the image and then call publish_file with the default return_mode link. The preview uses only the HTTPS resource_link URL; request inline or both only when native MCP ImageContent is specifically needed. " +
        "Write, delete and command tools may require desktop approval."
      : `Project "${p.name}" is reachable, but anonymous access exposes no tools. Authenticate with OAuth or Basic authentication.`;

    const r = { jsonrpc: "2.0", id: x.id };
    let responseStatus = 200;
    let responseProtocol = modernRequest ? MCP_MODERN_PROTOCOL :
      (headerProtocol || MCP_DEFAULT_PROTOCOL);

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
      } else if (x.method === "initialize") {
        const requested = String(x.params?.protocolVersion || "2025-03-26");
        if (requested === MCP_MODERN_PROTOCOL) {
          r.error = {
            code: -32022,
            message: "Protocol 2026-07-28 uses server/discover instead of initialize",
            data: { supported: MCP_PROTOCOLS, requested },
          };
        } else {
          responseProtocol = MCP_PROTOCOLS.includes(requested) ? requested : MCP_DEFAULT_PROTOCOL;
          r.result = {
            protocolVersion: responseProtocol,
            capabilities: serverCapabilities(fullAccess),
            serverInfo: {
              name: "MRMCP",
              title: "MRMCP Project Tools",
              version: VERSION,
            },
            instructions,
          };
        }
      } else if (x.method === "ping") {
        r.result = modernRequest
          ? { resultType: "complete", _meta: serverInfoMeta }
          : {};
      } else if (x.method === "tools/list") {
        const tools = projectTools(p, fullAccess);
        r.result = modernRequest
          ? {
              resultType: "complete",
              tools,
              ttlMs: 300000,
              cacheScope: "private",
              _meta: serverInfoMeta,
            }
          : { tools };
      } else if (x.method === "resources/list") {
        const resources = fullAccess ? [filePreviewResource()] : [];
        r.result = modernRequest
          ? {
              resultType: "complete", resources, ttlMs: 300000,
              cacheScope: "private", _meta: serverInfoMeta,
            }
          : { resources };
      } else if (x.method === "resources/read") {
        if (!fullAccess) {
          r.error = { code: -32001, message: "Authentication required for resource access" };
          responseStatus = 403;
        } else if (String(x.params?.uri || "") !== FILE_PREVIEW_UI_URI) {
          r.error = { code: -32002, message: `Resource not found: ${String(x.params?.uri || "")}` };
          responseStatus = modernRequest ? 404 : 200;
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
            "Authentication required for tool execution", "deny", "authentication",
          );
          r.error = {
            code: -32001, message: "Authentication required for tool execution",
            data: { execution_log_id: logId },
          };
          responseStatus = 403;
        } else if (!x.params?.name || typeof x.params.name !== "string") {
          const logId = rejectToolCall(
            p, "(invalid tools/call)", x.params || {},
            "tools/call requires params.name", "deny", "request validation",
          );
          r.error = {
            code: -32602, message: "tools/call requires params.name",
            data: { execution_log_id: logId },
          };
        } else {
          const requestSessionId = req.headers.get("mcp-session-id") ||
            requestMeta["io.mrmcp/sessionId"] || "";
          const toolArgs = { ...(x.params?.arguments || {}) };
          if (!toolArgs.session_id && requestSessionId) toolArgs.session_id = requestSessionId;
          const toolResult = await callTool(
            p, x.params.name, toolArgs,
            { ownerKey: auth.ownerKey, authKind: auth.kind, requestSessionId },
          );
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
        if (modernRequest) responseStatus = 404;
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
  function projectBasicUrl(p) {
    if (!p.basic_enabled) return "";
    const password = openSecret(p.basic_secret_enc);
    if (!password) return "";
    try {
      const url = new URL(mcpUrl(p));
      url.username = p.basic_username || "mrmcp";
      url.password = password;
      return url.href;
    } catch { return ""; }
  }
  // Local GUI receives a safe administrative state projection.
  const state = () => {
    const currentIp = getCfg("public_ip", "").trim(), currentSslip = sslipHostname(currentIp),
      directHttps = directIpBase(), automaticSslipHttps = sslipBase();
    const roots = all(`SELECT r.*,p.slug project_slug,p.name project_name FROM project_roots r
      JOIN projects p ON p.id=r.project_id ORDER BY p.name,r.id`);
    const projects = all("SELECT * FROM projects ORDER BY name").map(p => {
      const projectRootRows = roots.filter(r => r.project_id === p.id);
      return {
        ...p,
        enabled_tools: parseJson(p.enabled_tools_json, BASE_TOOLS),
        tool_count: projectTools(p, true).length,
        tool_names: projectTools(p, true).map(t => t.name),
        roots: projectRootRows,
        basic_url: projectBasicUrl(p),
        mcp_url: mcpUrl(p), metadata_url: metadataUrl(p),
        local_mcp_url: mcpTlsActive ? `${localHttpsBase()}/mcp/${p.slug}` : "",
        local_http_mcp_url: "",
        local_https_mcp_url: mcpTlsActive ? `${localHttpsBase()}/mcp/${p.slug}` : "",
        local_metadata_url: mcpTlsActive ? `${localHttpsBase()}/.well-known/oauth-protected-resource/mcp/${p.slug}` : "",
        external_mcp_url: (getCfg("external_url", "").replace(/\/+$/, "") || automaticExternalBase())
          ? `${getCfg("external_url", "").replace(/\/+$/, "") || automaticExternalBase()}/mcp/${p.slug}` : "",
        direct_ip_http_mcp_url: "",
        direct_ip_https_mcp_url: mcpTlsActive && directHttps ? `${directHttps}/mcp/${p.slug}` : "",
        sslip_http_mcp_url: "",
        sslip_https_mcp_url: mcpTlsActive && automaticSslipHttps ? `${automaticSslipHttps}/mcp/${p.slug}` : "",
        sslip_metadata_url: mcpTlsActive && automaticSslipHttps ? `${automaticSslipHttps}/.well-known/oauth-protected-resource/mcp/${p.slug}` : "",
        sslip_oauth_issuer: automaticSslipHttps || "",
        oauth_issuer: publicBase(),
      };
    });
    const activeCalls = all(`SELECT id,started_at,project_slug,tool,status,input_json
      FROM logs WHERE status IN ('received','awaiting_approval','running') ORDER BY started_at DESC`);
    const activeProcesses = [...processes.values()]
      .filter(r => ["starting", "running"].includes(r.status))
      .map(r => processSummary(r))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    return {
      version: VERSION,
      settings: {
        mcp_host: PUBLIC_HOST,
        mcp_port: HTTPS_PORT,
        mcp_http_enabled: true, mcp_http_port: HTTP_PORT, mcp_http_active: mcpHttpActive,
        mcp_http_role: "acme-only",
        mcp_https_enabled: true, mcp_https_port: HTTPS_PORT, mcp_https_active: mcpTlsActive,
        debug_http_log: getCfg("debug_http_log", "0") === "1",
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
      },
      projects, roots,
      custom_tools: all(`SELECT c.*,p.slug project_slug FROM custom_tools c
        JOIN projects p ON p.id=c.project_id ORDER BY p.name,c.name`),
      oauth_clients: all(`SELECT c.*,
        (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id=c.client_id) token_count,
        (SELECT COUNT(*) FROM oauth_refresh_tokens r WHERE r.client_id=c.client_id) refresh_token_count
        FROM oauth_clients c ORDER BY c.created_at DESC`),
      workspace_sessions: all(`SELECT w.id,w.project_id,p.slug project_slug,w.label,
        w.default_root selected_root,w.created_at,w.updated_at FROM workspace_sessions w
        JOIN projects p ON p.id=w.project_id ORDER BY w.updated_at DESC LIMIT 200`),
      approvals: [...approvals.values()].map(({ resolve, ...x }) => x),
      active_calls: activeCalls, active_processes: activeProcesses,
      base_tools: BASE_TOOLS, mcp_protocols: MCP_PROTOCOLS,
      stats: {
        projects: projects.filter(p => p.enabled).length,
        roots: roots.filter(r => r.enabled).length,
        logs: one("SELECT COUNT(*) n FROM logs")?.n || 0,
        failures: one("SELECT COUNT(*) n FROM logs WHERE status='failed'")?.n || 0,
        total_requests: one("SELECT value n FROM metrics WHERE name='requests'")?.n || 0,
        pending: approvals.size,
        active_calls: activeCalls.length,
        active_processes: activeProcesses.filter(x => x.status === "running").length,
      },
    };
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
  }

  const eta = new Eta({ tags: ["<?", "?>"], autoEscape: true, cache: true });
  const fragmentTemplates = {
    cards: `<? Object.entries(it.data || {}).forEach(([key,value]) => { ?><div class=card><div class=muted><?= key.replaceAll("_", " ") ?></div><strong style="font-size:24px"><?= value ?></strong></div><? }) ?>`,
    tls: `<? const t=it.data||{}, problem=!t.tls_active_trusted||!!t.tls_last_error||!!t.mcp_listen_error; ?><div class="card <?= problem ? "tls-alert" : "tls-good" ?>"><div class=row><h3 class=grow>TLS / Let's Encrypt</h3><b class="<?= t.tls_active_trusted ? "ok" : "failed" ?>"><?= t.tls_active_trusted ? "trusted" : (t.tls_active ? "fallback active" : "offline") ?></b></div><div class=grid><div><span class=muted>HTTPS listener</span><br><b><?= t.mcp_https_active ? "0.0.0.0:443 active" : "not listening" ?></b></div><div><span class=muted>Active certificate</span><br><b><?= t.tls_active_kind || "none" ?> · <?= t.tls_active_valid ? "valid" : "invalid" ?></b></div><div><span class=muted>Expires</span><br><b><?= it.dt(t.tls_active_expires) || "unknown" ?></b></div><div><span class=muted>Last ACME request</span><br><b><?= it.dt(t.tls_last_request_at) || "never recorded" ?></b></div><div><span class=muted>Last ACME result</span><br><b class="<?= t.tls_last_request_valid ? "ok" : (t.tls_last_request_status === "error" ? "failed" : "pending") ?>"><? if (t.tls_last_request_status) { ?><?= t.tls_last_request_status ?> · certificate <?= t.tls_last_request_valid ? "valid" : "not valid" ?><? } else { ?>not recorded<? } ?></b></div><div><span class=muted>Last valid certificate</span><br><b><?= it.dt(t.tls_last_issued_at) || "not recorded" ?></b></div><div><span class=muted>Renewal due</span><br><b><?= it.dt(t.tls_renewal_due_at) || "as soon as allowed" ?></b></div><div><span class=muted>Rate-limit reset</span><br><b><?= it.dt(t.tls_rate_limit_reset_at) || "none" ?></b></div><div><span class=muted>Next ACME attempt</span><br><b><?= it.dt(t.tls_next_attempt_at) || "not scheduled" ?></b></div></div><? if (t.tls_last_error || t.mcp_listen_error) { ?><pre class=tls-error><?= t.tls_last_error || t.mcp_listen_error ?></pre><? } ?><? if (!t.tls_active_trusted) { ?><p class=failed><b>Public clients such as ChatGPT will reject the self-signed fallback until Let's Encrypt succeeds.</b></p><? } ?></div>`,
    urls: `<? (it.data || []).forEach(x => { if (!x?.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?><? if (x.note) { ?> <span class=muted><?= x.note ?></span><? } ?></code><button class=small data-copy="<?= x.url ?>">Copy</button></div><? }) ?>`,
    projects: `<? (it.data || []).forEach(p => { ?><div class=card><div class=row><div class=grow><h3><?= p.name ?> <code>/<?= p.slug ?></code></h3><div class=muted><?= p.enabled ? "enabled" : "disabled" ?> · OAuth <?= p.oauth ? "on" : "off" ?> · Basic <?= p.basic_enabled ? "on" : "off" ?> · <?= p.tool_count ?> tools</div><div>Directories: <?= (p.roots || []).map(r => r.name).join(", ") || "none" ?></div></div><button data-action=edit-project data-id="<?= p.id ?>">Edit</button><button data-action=rotate-basic data-id="<?= p.id ?>">Rotate Basic</button><button class=danger data-action=delete-project data-id="<?= p.id ?>">Delete</button></div><? if (p.basic_url) { ?><div class=urlrow><span class=label>Basic URL</span><code><?= p.basic_url ?></code><button class=small data-copy="<?= p.basic_url ?>">Copy</button></div><? } ?></div><? }) ?>`,
    roots: `<table><tr><th>Project</th><th>Name</th><th>Path</th><th>State</th><th></th></tr><? (it.data || []).forEach(r => { ?><tr><td><?= r.project_name ?></td><td><code><?= r.name ?></code></td><td><code><?= r.path ?></code></td><td><?= r.enabled ? "enabled" : "disabled" ?></td><td class=nowrap><button data-action=edit-root data-id="<?= r.id ?>">Edit</button> <button class=danger data-action=delete-root data-id="<?= r.id ?>">Delete</button></td></tr><? }) ?></table>`,
    workspaces: `<? if (!(it.data || []).length) { ?><p class=muted>No workspace sessions yet.</p><? } else { it.data.forEach(w => { ?><div class=card><div class=row><div class=grow><b><?= w.label === "_default" ? "default" : (w.label || "unnamed") ?></b> · <code><?= w.project_slug ?></code><br><code><?= w.id ?></code><div class=muted>selected directory: <?= w.selected_root || "none" ?> · updated <?= it.dt(w.updated_at) ?></div></div><? if (w.label !== "_default") { ?><button class=danger data-action=delete-workspace data-id="<?= w.id ?>">Delete</button><? } ?></div></div><? }) } ?>`,
    tools: `<table><tr><th>Project</th><th>Name</th><th>Command</th><th></th></tr><? (it.data || []).forEach(t => { ?><tr><td><?= t.project_slug ?></td><td><code><?= t.name ?></code></td><td><code><?= t.command ?></code></td><td><button data-action=edit-tool data-id="<?= t.id ?>">Edit</button> <button class=danger data-action=delete-tool data-id="<?= t.id ?>">Delete</button></td></tr><? }) ?></table>`,
    commands: `<? const d=it.data || {}, rows=d.commands || []; ?><div class=muted><?= d.total || 0 ?> command<?= d.total === 1 ? "" : "s" ?> · page <?= d.page || 1 ?>/<?= d.pages || 1 ?> · config <code><?= d.config_file || "" ?></code></div><table><tr><th>Name</th><th>Relative path</th><th>Description</th><th>Links</th><th>Source</th><th>State</th><th></th></tr><? rows.forEach(c => { ?><tr><td><code><?= c.name ?></code></td><td><code><?= c.path ?></code></td><td><?= c.description || "—" ?></td><td><? if (c.documentation_url) { ?><a href="<?= c.documentation_url ?>" target=_blank rel=noopener>Docs</a><? } else { ?>—<? } ?></td><td><?= c.source ?></td><td class="<?= !c.enabled ? "pending" : (c.present && c.executable ? "ok" : "failed") ?>"><?= !c.enabled ? "disabled" : (c.present ? (c.executable ? "available" : "not executable") : "missing") ?></td><td class=nowrap><button data-action=edit-command data-name="<?= c.name ?>" data-path="<?= c.path ?>">Edit</button><? if (c.registered && c.download_url) { ?> <button data-action=download-command data-name="<?= c.name ?>">Download</button><? } ?><? if (c.registered) { ?> <button class=danger data-action=delete-command data-name="<?= c.name ?>">Delete</button><? } ?></td></tr><? }) ?></table><div class=row><button data-action=commands-prev<?= d.page <= 1 ? " disabled" : "" ?>>Previous</button><button data-action=commands-next<?= d.has_more ? "" : " disabled" ?>>Next</button></div>`,
    approvals: `<? if (!(it.data || []).length) { ?><p class=muted>No pending approvals.</p><? } else { it.data.forEach(a => { ?><div class=card><b><?= a.project ?> / <?= a.tool ?></b><pre><?= JSON.stringify(a.input, null, 2) ?></pre><button data-action=approve data-id="<?= a.id ?>">Allow</button> <button class=danger data-action=deny data-id="<?= a.id ?>">Deny</button></div><? }) } ?>`,
    oauth: `<table><tr><th>Client</th><th>ID</th><th>Access</th><th>Refresh</th><th></th></tr><? (it.data || []).forEach(c => { ?><tr><td><?= c.name ?></td><td><code><?= c.client_id ?></code></td><td><?= c.token_count ?></td><td><?= c.refresh_token_count ?></td><td><button class=danger data-action=revoke-client data-id="<?= c.client_id ?>">Revoke</button></td></tr><? }) ?></table>`,
    endpoints: `<? (it.data || []).forEach(p => { ?><div class=card><h3><?= p.name ?></h3><? it.endpointRows(p).forEach(x => { if (!x.url) return; ?><div class=urlrow><span class=label><?= x.label ?></span><code><?= x.url ?></code><button class=small data-copy="<?= x.url ?>">Copy</button></div><? }) ?><div class=row><button data-action=self-test data-slug="<?= p.slug ?>">Self-test</button><span class=muted><?= (p.tool_names || []).join(", ") ?></span></div></div><? }) ?>`,
    calls: `<? if (!(it.data || []).length) { ?><p class=muted>No active calls.</p><? } else { it.data.forEach(c => { ?><div class=card><b><?= c.project_slug ?> / <?= c.tool ?></b> <span class="<?= c.status ?>"><?= c.status ?></span><div class=muted><?= it.dt(c.started_at) ?></div></div><? }) } ?>`,
    processes: `<? if (!(it.data || []).length) { ?><div class="card muted">No active calls or processes.</div><? } else { ?><table><tr><th>Started</th><th>Project</th><th>PID</th><th>Status</th><th>Command</th></tr><? (it.data || []).forEach(p => { ?><tr data-action=select-process data-id="<?= p.process_id || p.id ?>"><td><?= it.dt(p.started_at) ?></td><td><?= p.project_slug || "" ?></td><td><?= p.pid || "" ?></td><td class="<?= p.status ?>"><?= p.status ?></td><td><code><?= typeof p.command === "string" ? p.command : JSON.stringify(p.command_json || p.command || "") ?></code></td></tr><? }) ?></table><? } ?>`,
    logs: `<table><tr><th>ID</th><th>Time</th><th>Project</th><th>Tool</th><th>Status</th><th>Decision</th><th>Duration</th><th>Input JSON</th><th>Output JSON</th></tr><? (it.data || []).forEach(l => { ?><tr data-action=select-log data-id="<?= l.id ?>" title="Click to expand input and output JSON"><td class=idcell>#<?= l.id ?></td><td><?= it.dt(l.started_at) ?></td><td><?= l.project_slug ?></td><td><code><?= l.tool ?></code></td><td class="<?= l.status ?>"><?= l.status ?></td><td><?= l.decision ?></td><td><?= l.duration_ms ?? "" ?><? if (l.duration_ms != null) { ?>ms<? } ?></td><td class=json-preview><?= l.input_preview || "" ?></td><td class=json-preview><?= l.output_preview || "" ?></td></tr><? }) ?></table>`,
    debug: `<? if (!it.data?.enabled) { ?><p class=muted>HTTP debug logging is disabled.</p><? } else { ?><table><tr><th>ID</th><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Remote</th><th>Error</th></tr><? (it.data.rows || []).forEach(r => { ?><tr data-action=select-debug data-id="<?= r.id ?>" title="Click to expand"><td class=idcell>#<?= r.id ?></td><td><?= it.dt(r.ts) ?></td><td><b><?= r.method ?></b></td><td><code><?= r.path ?></code></td><td class="<?= r.status >= 400 ? "failed" : "ok" ?>"><?= r.status ?></td><td><?= r.duration_ms ?>ms</td><td><?= r.remote_addr ?></td><td><?= r.error_preview ?></td></tr><? }) ?></table><? } ?>`,
    tool_checks: `<? (it.data.base_tools || []).forEach(name => { ?><label><input type=checkbox value="<?= name ?>"<? if ((it.data.enabled_tools || []).includes(name)) { ?> checked<? } ?>> <?= name ?></label><? }) ?>`,
  };
  const fragmentDate = value => value ? new Date(value).toLocaleString() : "";
  const endpointRows = p => [
    ["MCP sslip.io", p.sslip_https_mcp_url], ["MCP direct IP", p.direct_ip_https_mcp_url],
    ["OAuth metadata", p.sslip_metadata_url], ["Local HTTPS", p.local_https_mcp_url],
    ["Basic URL", p.basic_url],
  ].map(([label, url]) => ({ label, url }));
  function renderFragment(name, data, id) {
    if (!fragmentTemplates[name] || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(id || "")))
      throw new Error("Invalid UI fragment");
    const inner = eta.renderString(fragmentTemplates[name], { data, dt: fragmentDate, endpointRows });
    return `<div id="${htmlEscape(id)}">${inner}</div>`;
  }

  async function guiApi(req, u) {
    if (!requireApi(req)) return json({ error: "Unauthorized" }, 401);
    if (u.pathname === "/api/render" && req.method === "POST") {
      const x = await bodyJson(req);
      return json({ html: renderFragment(String(x.name || ""), x.data, String(x.id || "")) });
    }
    if (u.pathname === "/api/state") return json(state());
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
    if (u.pathname === "/api/projects/save" && req.method === "POST") {
      const x = await bodyJson(req), tools = Array.isArray(x.enabled_tools)
        ? x.enabled_tools.filter(t => BASE_TOOLS.includes(t)) : BASE_TOOLS;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(x.slug || ""))) return json({ error: "Invalid project slug" }, 400);
      const rootPath = await Deno.realPath(String(x.root || APP_DIR));
      const rootStat = await Deno.stat(rootPath);
      if (!rootStat.isDirectory) return json({ error: "Initial root must be a directory" }, 400);
      const username = String(x.basic_username || "mrmcp").slice(0, 128);
      let id = Number(x.id || 0), generatedSecret = "";
      if (id) {
        const current = one("SELECT * FROM projects WHERE id=?", id);
        if (!current) return json({ error: "Project not found" }, 404);
        let secret = current.basic_secret_enc;
        if (x.basic_enabled && !secret) { generatedSecret = randomToken(24); secret = sealSecret(generatedSecret); }
        run(`UPDATE projects SET name=?,slug=?,root=?,enabled=?,oauth=?,basic_enabled=?,basic_username=?,basic_secret_enc=?,
          exec_enabled=?,confirm_mode=?,allow_re=?,deny_re=?,enabled_tools_json=? WHERE id=?`,
          String(x.name || ""), String(x.slug), rootPath, +!!x.enabled, x.oauth === false ? 0 : 1,
          +!!x.basic_enabled, username, secret, +!!x.exec_enabled, x.confirm_mode || "allow",
          x.allow_re || "", x.deny_re || "", JSON.stringify(tools), id);
        if (x.oauth === false) {
          run("DELETE FROM oauth_tokens WHERE project_id=?", id);
          run("DELETE FROM oauth_refresh_tokens WHERE project_id=?", id);
          run("DELETE FROM oauth_codes WHERE project_id=?", id);
        }
      } else {
        generatedSecret = x.basic_enabled ? randomToken(24) : "";
        const result = run(`INSERT INTO projects(name,slug,root,enabled,oauth,basic_enabled,basic_username,basic_secret_enc,
          exec_enabled,confirm_mode,allow_re,deny_re,enabled_tools_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          String(x.name || ""), String(x.slug), rootPath, +!!x.enabled, x.oauth === false ? 0 : 1,
          +!!x.basic_enabled, username, sealSecret(generatedSecret), +!!x.exec_enabled, x.confirm_mode || "allow",
          x.allow_re || "", x.deny_re || "", JSON.stringify(tools), Date.now());
        id = Number(result.lastInsertRowid);
        run("INSERT INTO project_roots(project_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
          id, "default", rootPath, 1, Date.now());
      }
      const project = one("SELECT * FROM projects WHERE id=?", id);
      return json({ ok: true, project_id: id, generated_basic_password: generatedSecret,
        basic_url: generatedSecret ? projectBasicUrl(project) : "" });
    }
    if (u.pathname === "/api/projects/delete" && req.method === "POST") {
      const x = await bodyJson(req), id = Number(x.id);
      await Promise.allSettled([...processes.values()]
        .filter(rec => rec.project_id === id && ["starting", "running"].includes(rec.status))
        .map(rec => terminateProcess(rec, "SIGTERM")));
      run("DELETE FROM oauth_tokens WHERE project_id=?", id);
      run("DELETE FROM oauth_refresh_tokens WHERE project_id=?", id);
      run("DELETE FROM oauth_codes WHERE project_id=?", id);
      run("DELETE FROM projects WHERE id=?", id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/roots/save" && req.method === "POST") {
      const x = await bodyJson(req), name = String(x.name || ""), path = await Deno.realPath(String(x.path || ""));
      if (!validRootName(name)) return json({ error: "Root name must use letters, numbers, dot, underscore or hyphen" }, 400);
      if (!(await Deno.stat(path)).isDirectory) return json({ error: "Root path is not a directory" }, 400);
      if (x.id) run("UPDATE project_roots SET project_id=?,name=?,path=?,enabled=? WHERE id=?",
        x.project_id, name, path, +!!x.enabled, x.id);
      else run("INSERT INTO project_roots(project_id,name,path,enabled,created_at) VALUES(?,?,?,?,?)",
        x.project_id, name, path, +!!x.enabled, Date.now());
      const first = one("SELECT path FROM project_roots WHERE project_id=? AND enabled=1 ORDER BY id LIMIT 1", x.project_id);
      if (first) run("UPDATE projects SET root=? WHERE id=?", first.path, x.project_id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/roots/delete" && req.method === "POST") {
      const x = await bodyJson(req), root = one("SELECT * FROM project_roots WHERE id=?", x.id);
      if (!root) return json({ error: "Root not found" }, 404);
      if ((one("SELECT COUNT(*) n FROM project_roots WHERE project_id=?", root.project_id)?.n || 0) <= 1)
        return json({ error: "A project must keep at least one root" }, 400);
      run("DELETE FROM project_roots WHERE id=?", x.id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/workspaces/delete" && req.method === "POST") {
      const x = await bodyJson(req);
      const ws = one("SELECT * FROM workspace_sessions WHERE id=?", String(x.id || ""));
      if (!ws) return json({ error: "Workspace not found" }, 404);
      if (ws.label === "_default") return json({ error: "Default workspaces cannot be deleted" }, 400);
      run("DELETE FROM workspace_sessions WHERE id=?", ws.id);
      return json({ ok: true });
    }
    if (u.pathname === "/api/projects/basic/rotate" && req.method === "POST") {
      const x = await bodyJson(req), project = one("SELECT * FROM projects WHERE id=?", x.id);
      if (!project) return json({ error: "Project not found" }, 404);
      const password = randomToken(24);
      run("UPDATE projects SET basic_enabled=1,basic_secret_enc=? WHERE id=?", sealSecret(password), project.id);
      const updated = one("SELECT * FROM projects WHERE id=?", project.id);
      return json({ ok: true, username: updated.basic_username, password, basic_url: projectBasicUrl(updated) });
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
      if (x.id) run("UPDATE custom_tools SET project_id=?,name=?,description=?,command=?,enabled=?,confirm_mode=? WHERE id=?",
        x.project_id, x.name, x.description || "", x.command, +!!x.enabled, x.confirm_mode || "inherit", x.id);
      else run(`INSERT INTO custom_tools(project_id,name,description,command,enabled,confirm_mode,created_at)
        VALUES(?,?,?,?,?,?,?)`, x.project_id, x.name, x.description || "", x.command, +!!x.enabled,
        x.confirm_mode || "inherit", Date.now());
      return json({ ok: true });
    }
    if (u.pathname === "/api/tools/delete" && req.method === "POST") {
      const x = await bodyJson(req); run("DELETE FROM custom_tools WHERE id=?", x.id); return json({ ok: true });
    }
    if (u.pathname === "/api/approvals/decide" && req.method === "POST") {
      const x = await bodyJson(req), a = approvals.get(x.id);
      if (a) { approvals.delete(x.id); a.resolve(!!x.allow); }
      return json({ ok: true });
    }
    if (u.pathname === "/api/mcp/self-test" && req.method === "GET") {
      const slug = u.searchParams.get("project") || "default";
      const p = one("SELECT * FROM projects WHERE slug=?", slug);
      if (!p) return json({ error: "Project not found" }, 404);
      return json(mcpSelfTest(p));
    }
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
        enabled: !!x.enabled,
      });
      const rows = await readCommandConfig(), oldKey = old.toLowerCase(), key = name.toLowerCase();
      if (rows.some(existing => existing.name.toLowerCase() === key && existing.name.toLowerCase() !== oldKey)) return json({ error: "Command name already exists" }, 409);
      const index = rows.findIndex(existing => existing.name.toLowerCase() === oldKey || (!old && existing.name.toLowerCase() === key));
      if (index >= 0) rows[index] = row; else rows.push(row);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      await writeCommandConfig(rows);
      return json({ ok: true, config_file: COMMANDS_PATH });
    }
    if (u.pathname === "/api/commands/delete" && req.method === "POST") {
      const x = await bodyJson(req), key = String(x.name || "").toLowerCase();
      await writeCommandConfig((await readCommandConfig()).filter(row => row.name.toLowerCase() !== key));
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
      const q = (u.searchParams.get("q") || "").trim(), project = u.searchParams.get("project") || "";
      const status = u.searchParams.get("status") || "", limit = Math.min(Number(u.searchParams.get("limit") || 200), 1000);
      let rows;
      if (q && fts) {
        try {
          rows = all(`SELECT l.id,l.started_at,l.completed_at,l.project_slug,l.tool,l.status,l.decision,l.duration_ms,
            substr(l.input_json,1,180) input_preview,
            substr(CASE WHEN l.result_json<>'' THEN l.result_json WHEN l.resolved_json<>'' THEN l.resolved_json ELSE l.stdout END,1,180) output_preview
            FROM logs_fts f JOIN logs l ON l.id=CAST(f.log_id AS INTEGER)
            WHERE logs_fts MATCH ? AND (?='' OR l.project_slug=?) AND (?='' OR l.status=?)
            ORDER BY l.started_at DESC LIMIT ?`, q, project, project, status, status, limit);
        } catch {}
      }
      if (!rows) {
        const like = `%${q}%`;
        rows = all(`SELECT id,started_at,completed_at,project_slug,tool,status,decision,duration_ms,
          substr(input_json,1,180) input_preview,
          substr(CASE WHEN result_json<>'' THEN result_json WHEN resolved_json<>'' THEN resolved_json ELSE stdout END,1,180) output_preview FROM logs
          WHERE (?='' OR project_slug=?) AND (?='' OR status=?)
          AND (?='' OR project_slug||tool||input_json||result_json||resolved_json||stdout||stderr||error LIKE ?)
          ORDER BY started_at DESC LIMIT ?`, project, project, status, status, q, like, limit);
      }
      return json(rows);
    }
    const lm = u.pathname.match(/^\/api\/logs\/(\d+)$/);
    if (lm && req.method === "GET") return json(
      one("SELECT * FROM logs WHERE id=?", Number(lm[1])) || { error: "Not found" }
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
  const UI_CSP = "default-src 'self';base-uri 'none';object-src 'none';frame-ancestors 'none';form-action 'self';style-src 'unsafe-inline';script-src 'self';connect-src 'self';img-src 'self' data:";
  const UI_TEMPLATE = String.raw`<!doctype html><html><head><meta charset=utf-8>
<meta name=mrmcp-csrf content="__MRMCP_CSRF__">
<meta http-equiv="Content-Security-Policy" content="${UI_CSP}">
<meta name=viewport content="width=device-width,initial-scale=1"><title>MRMCP</title><style>
:root{font:14px system-ui;color:#e8e8e8;background:#101114}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding-top:54px}header{position:fixed;inset:0 0 auto 0;z-index:1000;height:54px;display:flex;align-items:center;padding:0 18px;background:#17191e;border-bottom:1px solid #292c33}header b{font-size:18px}.status{margin-left:auto;color:#8b949e;display:flex;gap:8px;align-items:center}aside{position:fixed;top:54px;bottom:0;width:170px;background:#15171b;padding:12px;border-right:1px solid #292c33;overflow:auto}aside button{display:block;width:100%;text-align:left;margin:3px 0;background:transparent;border:0}main{margin-left:170px;padding:16px;max-width:1500px}.page{display:none}.page.on{display:block}.banner{display:none;margin-left:170px;padding:9px 18px;background:#5a2020;color:#ffd7d7}button,input,select,textarea{font:inherit;color:#eee;background:#22252b;border:1px solid #3a3e47;border-radius:6px;padding:7px 9px}button{cursor:pointer}button:hover{background:#2d3139}.danger{color:#ff8585}.primary{background:#2459a8}.small{padding:4px 8px;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.card{background:#181a1f;border:1px solid #2c3037;border-radius:10px;padding:14px;margin-bottom:10px}.tls-alert{border:2px solid #b94a4a;background:#241718}.tls-good{border:2px solid #347a49}.tls-error{max-height:180px;background:#160909}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:180px}.urlrow{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #292d34}.urlrow:last-child{border-bottom:0}.urlrow code{overflow-wrap:anywhere}.label,.muted{color:#89909b}label{display:block;color:#aaa;margin:8px 0 4px}table{width:100%;border-collapse:collapse;background:#181a1f}th,td{padding:8px;border-bottom:1px solid #2b2e35;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#090a0c;padding:12px;border-radius:8px;max-height:58vh;overflow:auto}code{color:#9ecbff}.ok,.completed{color:#75d58b}.failed,.deny,.killed,.timed_out{color:#ff8585}.pending,.running,.awaiting_approval{color:#ffd166}.tools{columns:3;min-width:500px}dialog{color:#eee;background:#17191e;border:1px solid #444;border-radius:10px;width:min(880px,94vw)}dialog::backdrop{background:#0009}textarea{width:100%;min-height:78px}h2{margin-top:0}.nowrap{white-space:nowrap}tr[data-action=select-log],tr[data-action=select-debug]{cursor:pointer}tr[data-action=select-log]:hover,tr[data-action=select-debug]:hover{background:#20242a}.detail-row td{padding:0 8px 10px;background:#111318}.detail-panel{border:1px solid #343944;border-radius:8px;background:#0d0f12;padding:10px}.detail-panel pre{margin:8px 0 0;max-height:46vh}.json-detail{margin-top:12px}.json-detail+.json-detail{padding-top:12px;border-top:1px solid #292d34}.json-preview{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.idcell{font-variant-numeric:tabular-nums;white-space:nowrap}@media(max-width:800px){aside{width:130px}main,.banner{margin-left:130px}.urlrow{grid-template-columns:1fr}.tools{columns:1;min-width:0}}
</style></head><body>
<header><b>MRMCP</b><div class=status><span id=refreshStatus></span><label class=small style="margin:0"><input id=autoRefresh type=checkbox checked> auto</label><button class=small data-action=refresh>Refresh</button><span id=serverStatus>loading…</span></div></header><div id=errorBanner class=banner></div>
<aside><button data-page=dashboard>Dashboard</button><button data-page=projects>Projects</button><button data-page=roots>Roots</button><button data-page=processes>Active calls</button><button data-page=commands>Commands</button><button data-page=tools>Custom tools</button><button data-page=approvals>Approvals <b id=pendingBadge></b></button><button data-page=logs>Tool calls</button><button data-page=debug>HTTP debug</button><button data-page=oauth>OAuth clients</button><button data-page=settings>Settings</button></aside>
<main>
<section id=dashboard class="page on"><h2>Dashboard</h2><div id=tlsStatus></div><div id=cards class=grid></div><h3>Public URLs</h3><div id=publicLinks class=card></div><h3>Projects and MCP endpoints</h3><div id=endpoints></div><h3>Running MCP tool calls</h3><div id=activeCalls></div></section>
<section id=projects class=page><div class=row><h2 class=grow>Projects</h2><button class=primary data-action=new-project>New project</button></div><div id=projectList></div></section>
<section id=roots class=page><div class=row><h2 class=grow>Named directories</h2><button class=primary data-action=new-root>New directory</button></div><p class=muted>Each workspace session selects one named directory. Tool paths are normal relative paths; there is no @root syntax.</p><div id=rootList></div><h3>Workspace sessions</h3><div id=workspaceList></div></section>
<section id=processes class=page><div class=row><h2 class=grow>Active calls and processes</h2><button data-action=load-processes>Refresh</button></div><div id=processList></div><div id=processInteraction class=card hidden><div class=row><h3 class=grow>Selected process</h3><button data-action=clear-process-selection>Close</button></div><pre id=processDetail></pre><label for=processInput>Standard input</label><textarea id=processInput placeholder="Text to write to stdin"></textarea><div class=row><button class=primary data-action=process-write>Write</button><button data-action=process-close>Close stdin</button><button class=danger data-action=process-kill>Terminate</button><button class=danger data-action=process-kill-force>Force kill</button></div></div></section>
<section id=commands class=page><div class=row><h2 class=grow>Extra commands</h2><button data-action=download-all-commands>Download all</button><button class=primary data-action=new-command>Register command</button></div><p class=muted>Metadata is stored in <code>commands.yaml</code> beside <code>mrmcp.js</code> and reloaded whenever needed. Executable files directly in <code>.mrmcp/bin</code> still appear automatically. A configured download URL can install or update the target file; on Linux and other Unix systems it is made executable. On Windows, executable suffixes such as <code>.exe</code>, <code>.com</code>, <code>.cmd</code> and <code>.bat</code> may be omitted from both the logical name and path.</p><div class=row><input id=commandQuery class=grow placeholder="Search name, path or description…"><label class=small><input id=commandIncludeMissing type=checkbox checked> show unavailable</label><select id=commandPageSize><option>10</option><option selected>25</option><option>50</option><option>100</option></select><button data-action=load-commands>Search</button></div><div id=commandList></div></section>
<section id=tools class=page><div class=row><h2 class=grow>Custom tools</h2><button class=primary data-action=new-tool>New tool</button></div><p class=muted>Prefer a JSON argv array such as ["git","status","--short"]. Plain strings run through the platform shell.</p><div id=toolList></div></section>
<section id=approvals class=page><h2>Pending approvals</h2><div id=approvalList></div></section>
<section id=logs class=page><h2>MCP tool calls</h2><p class=muted>One row for every parsed <code>tools/call</code> attempt reaching this project endpoint, including <code>publish_file</code>, disabled tools, malformed calls and authentication failures.</p><div class=row><input id=logQuery class=grow placeholder="Search input, output, stderr, errors…"><select id=logProject></select><select id=logStatus><option value="">All states</option><option>completed</option><option>failed</option><option>awaiting_approval</option><option>running</option></select><button data-action=load-logs>Search</button></div><div id=logSelfTest class=card hidden><div class=row><h3 class=grow>MCP self-test</h3><button class=small data-action=copy-detail data-target=logDetail>Copy JSON</button><button class=small data-action=close-self-test>Close</button></div><pre id=logDetail></pre></div><div id=logList></div></section>
<section id=debug class=page><div class=row><h2 class=grow>HTTP debug log</h2><label class=small style="margin:0"><input id=debugHttpLog type=checkbox> enabled</label><button data-action=save-debug-settings>Apply</button><button class=danger data-action=clear-debug>Clear</button></div><p class=muted>Disabled by default. Authorization, cookies, tokens, codes and secrets are redacted when enabled. Click a row to open or close its JSON directly below it.</p><div class=row><input id=debugQuery class=grow placeholder="Search URL, headers, body or errors…"><select id=debugMethod><option value="">All methods</option><option>GET</option><option>POST</option><option>OPTIONS</option></select><input id=debugStatus type=number placeholder="Status"><button data-action=load-debug>Search</button></div><div id=debugList></div></section>
<section id=oauth class=page><h2>OAuth clients</h2><div id=oauthList></div></section>
<section id=settings class=page><h2>Settings</h2><div class=grid><div class=card><h3>Fixed listeners</h3><p><b>HTTP</b> <code>0.0.0.0:80</code> · ACME HTTP-01 only</p><p><b>HTTPS</b> <code>0.0.0.0:443</code> · MCP, OAuth and metadata</p><p><b>GUI</b> <code>http://127.0.0.1:${GUI_PORT}</code> · local WebView only</p><label>Public IPv4</label><div class=row><input id=publicIp readonly class=grow><button data-action=detect-ip>Detect</button></div><label>Public base URL override</label><input id=externalUrl class=grow placeholder="https://mcp.example.com"><label>Public IPv4 lookup URLs (one per line)</label><textarea id=publicIpUrls></textarea><label>Automatic DNS suffix</label><input id=sslipSuffix placeholder="sslip.io"><label>ACME directory URL</label><input id=acmeDirectoryUrl class=grow></div><div class=card><h3>Certificate</h3><label>Let's Encrypt email</label><input id=tlsEmail type=email><div class=row><button data-action=issue-cert>Check / request certificate</button></div><p class=muted>A valid certificate already present in .mrmcp is reused. Requests occur only when renewal is due and backoff permits them.</p></div></div><p><button class=primary data-action=save-settings>Save settings</button></p><pre id=settingsInfo></pre></section>
</main>
<dialog id=projectDialog><form id=projectForm><input id=pid type=hidden><h2>Project</h2><div class=grid><div><label>Name</label><input id=pname required><label>Slug</label><input id=pslug pattern="[A-Za-z0-9_-]+" required><label>Initial directory</label><input id=proot required class=grow><p class=muted>For existing projects, manage named directories on the Roots page.</p></div><div><label>Confirmation</label><select id=pconfirm><option value=allow>Allow</option><option value=ask>Ask</option><option value=deny>Deny</option></select><label><input id=penabled type=checkbox> Enabled</label><label><input id=poauth type=checkbox> OAuth enabled</label><label><input id=pbasic type=checkbox> Basic authentication enabled</label><label>Basic username</label><input id=pbasicUser value=mrmcp><label><input id=pexec type=checkbox> Process execution enabled</label></div></div><label>Allow regex</label><input id=pallow class=grow><label>Deny regex</label><input id=pdeny class=grow><label>Enabled tools</label><div id=ptools class=tools></div><p class=row><button class=primary type=submit>Save</button><button type=button data-action=close-dialog>Cancel</button></p></form></dialog>
<dialog id=rootDialog><form id=rootForm><input id=rid type=hidden><h2>Named directory</h2><label>Project</label><select id=rproject></select><label>Name</label><input id=rname pattern="[A-Za-z0-9_.-]+" required><label>Directory path</label><input id=rpath required class=grow><label><input id=renabled type=checkbox> Enabled</label><p class=row><button class=primary type=submit>Save</button><button type=button data-action=close-dialog>Cancel</button></p></form></dialog>
<dialog id=toolDialog><form id=toolForm><input id=tid type=hidden><h2>Custom tool</h2><label>Project</label><select id=tproject></select><label>Name</label><input id=tname pattern="[A-Za-z0-9_.-]+" required><label>Description</label><textarea id=tdesc></textarea><label>Command: JSON argv array or shell string</label><textarea id=tcommand required></textarea><label>Confirmation</label><select id=tconfirm><option value=inherit>Inherit</option><option value=ask>Ask</option><option value=allow>Allow</option><option value=deny>Deny</option></select><label><input id=tenabled type=checkbox> Enabled</label><p class=row><button class=primary type=submit>Save</button><button type=button data-action=close-dialog>Cancel</button></p></form></dialog>
<dialog id=commandDialog><form id=commandForm><input id=coldName type=hidden><h2>Command catalog entry</h2><label>Logical name</label><input id=cname pattern="[A-Za-z0-9_.+-]+" required><label>Path below .mrmcp/bin</label><input id=cpath placeholder="Optional; defaults to logical name; Windows suffix optional"><label>Description for the agent</label><textarea id=cdescription placeholder="Optional: what it does and when the agent should use it."></textarea><label>Download URL</label><input id=cdownloadUrl type=url placeholder="https://example.com/tool"><label>Documentation URL</label><input id=cdocumentationUrl type=url placeholder="https://example.com/docs"><label><input id=cenabled type=checkbox checked> Enabled</label><p class=row><button class=primary type=submit>Save</button><button type=button data-action=close-dialog>Cancel</button></p></form></dialog>

<script type=module src=/app.js></script></body></html>`;

  function browserAppSource() {/*
import { morphInner } from "/morphlex.js";
const CSRF=document.querySelector('meta[name="mrmcp-csrf"]').content,$=id=>document.getElementById(id);
let S,dirty=false,refreshing=false,current='dashboard',selectedProcess='',commandPage=1,commandRows=[],selectedToolCall='',selectedHttpLog='';
function showError(e){$('errorBanner').textContent=String(e?.message||e);$('errorBanner').style.display='block'}
async function api(path,opt={}){const headers={'x-mrmcp-csrf':CSRF,...opt.headers};if(opt.body&&typeof opt.body!=='string'){headers['content-type']='application/json';opt.body=JSON.stringify(opt.body)}const r=await fetch(path,{...opt,headers}),raw=await r.text();let data;try{data=raw?JSON.parse(raw):{}}catch{data={error:raw}}if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data}
function scrollSnapshot(root){const state=new Map();for(const el of [root,...root.querySelectorAll('[id]')])if(el.id&&(el.scrollTop||el.scrollLeft))state.set(el.id,[el.scrollLeft,el.scrollTop]);return state}
function restoreScrollSnapshot(root,state){for(const[id,[left,top]]of state){const el=id===root.id?root:$(id);if(el){el.scrollLeft=left;el.scrollTop=top}}}
async function patch(id,name,data){const target=$(id),scrolls=scrollSnapshot(target),{html}=await api('/api/render',{method:'POST',body:{id,name,data}});morphInner(target,html,{preserveChanges:true});restoreScrollSnapshot(target,scrolls)}
function selectionInside(element){const selection=document.getSelection();if(!selection||selection.isCollapsed||!element)return false;return[selection.anchorNode,selection.focusNode].some(node=>!!node&&(node===element||element.contains(node.nodeType===1?node:node.parentElement)))}
function preserveAutoView(){if(current==='logs')return !!selectedToolCall||selectionInside($('logList'))||!!document.activeElement?.closest?.('#logList');if(current==='debug')return !!selectedHttpLog||selectionInside($('debugList'))||!!document.activeElement?.closest?.('#debugList');return false}
function setOptions(select,items,currentValue,emptyLabel=''){const value=currentValue??select.value;select.replaceChildren();if(emptyLabel){const o=document.createElement('option');o.value='';o.textContent=emptyLabel;select.append(o)}for(const [v,label]of items){const o=document.createElement('option');o.value=String(v);o.textContent=String(label);select.append(o)}if([...select.options].some(o=>o.value===String(value)))select.value=String(value)}
async function copy(value,button){try{await navigator.clipboard.writeText(value)}catch{const a=document.createElement('textarea');a.value=value;document.body.append(a);a.select();document.execCommand('copy');a.remove()}const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1000)}
function findDataRow(containerId,id){return [...$(containerId).querySelectorAll('tr[data-id]')].find(row=>row.dataset.id===String(id))}
function closeRowDetails(containerId){$(containerId).querySelectorAll('.detail-row').forEach(row=>row.remove())}
function parseStoredJson(value){if(typeof value!=="string")return value;if(!value.trim())return null;try{return JSON.parse(value)}catch{return value}}
function appendJsonDetail(panel,titleText,value,id){const section=document.createElement('section');section.className='json-detail';const toolbar=document.createElement('div');toolbar.className='row';const title=document.createElement('b');title.className='grow';title.textContent=titleText;const pre=document.createElement('pre');pre.id=id;const parsed=parseStoredJson(value);pre.textContent=typeof parsed==='string'?parsed:JSON.stringify(parsed,null,2);const copyButton=document.createElement('button');copyButton.className='small';copyButton.dataset.action='copy-detail';copyButton.dataset.target=id;copyButton.textContent='Copy JSON';toolbar.append(title,copyButton);section.append(toolbar,pre);panel.append(section)}
function insertRowDetail(row,data,kind){closeRowDetails(kind==='tool'?'logList':'debugList');const detail=document.createElement('tr');detail.className='detail-row';detail.dataset.detailKind=kind;detail.dataset.detailId=row.dataset.id;const cell=document.createElement('td');cell.colSpan=row.cells.length;const panel=document.createElement('div');panel.className='detail-panel';const toolbar=document.createElement('div');toolbar.className='row';const title=document.createElement('b');title.className='grow';title.textContent=(kind==='tool'?'MCP tool call ':'HTTP request ')+'#'+data.id;const fullPre=document.createElement('pre');fullPre.id=`${kind}-detail-${row.dataset.id}`;fullPre.hidden=true;fullPre.textContent=JSON.stringify(data,null,2);const copyButton=document.createElement('button');copyButton.className='small';copyButton.dataset.action='copy-detail';copyButton.dataset.target=fullPre.id;copyButton.textContent='Copy full row';const closeButton=document.createElement('button');closeButton.className='small';closeButton.dataset.action='close-row-detail';closeButton.dataset.kind=kind;closeButton.textContent='Close';toolbar.append(title,copyButton,closeButton);panel.append(toolbar,fullPre);if(kind==='tool'){const metadata={...data};delete metadata.input_json;delete metadata.result_json;delete metadata.resolved_json;delete metadata.stdout;delete metadata.stderr;appendJsonDetail(panel,'Input JSON',data.input_json,`tool-input-${row.dataset.id}`);appendJsonDetail(panel,'MCP result JSON',data.result_json||data.resolved_json||data.stdout||{},`tool-output-${row.dataset.id}`);if(data.stderr)appendJsonDetail(panel,'Standard error',data.stderr,`tool-stderr-${row.dataset.id}`);if(data.error)appendJsonDetail(panel,'Error',data.error,`tool-error-${row.dataset.id}`);appendJsonDetail(panel,'Call metadata',metadata,`tool-meta-${row.dataset.id}`)}else appendJsonDetail(panel,'HTTP log JSON',data,`http-json-${row.dataset.id}`);cell.append(panel);detail.append(cell);row.after(detail)}
async function toggleRowDetail(kind,row,id){const containerId=kind==='tool'?'logList':'debugList',selected=kind==='tool'?selectedToolCall:selectedHttpLog,existing=row.nextElementSibling;if(selected===String(id)&&existing?.classList.contains('detail-row')){existing.remove();if(kind==='tool')selectedToolCall='';else selectedHttpLog='';return}if(kind==='tool')selectedToolCall=String(id);else selectedHttpLog=String(id);const data=await api((kind==='tool'?'/api/logs/':'/api/debug/')+encodeURIComponent(id));insertRowDetail(row,data,kind)}
async function restoreRowDetail(kind){const id=kind==='tool'?selectedToolCall:selectedHttpLog;if(!id)return;const containerId=kind==='tool'?'logList':'debugList',row=findDataRow(containerId,id);if(!row){if(kind==='tool')selectedToolCall='';else selectedHttpLog='';return}const data=await api((kind==='tool'?'/api/logs/':'/api/debug/')+encodeURIComponent(id));insertRowDetail(row,data,kind)}
async function renderState(){await Promise.all([
  patch('tlsStatus','tls',S.settings),
  patch('cards','cards',S.stats),
  patch('publicLinks','urls',[
    {label:'sslip.io HTTPS',url:S.settings.sslip_https_base_url,note:S.settings.tls_active_trusted?'trusted certificate':'self-signed fallback'},
    {label:'Direct IP HTTPS',url:S.settings.direct_ip_https_base_url,note:S.settings.tls_active_trusted?'trusted certificate':'self-signed fallback'}
  ]),
  patch('projectList','projects',S.projects),patch('rootList','roots',S.roots),patch('workspaceList','workspaces',S.workspace_sessions),patch('toolList','tools',S.custom_tools),patch('approvalList','approvals',S.approvals),patch('oauthList','oauth',S.oauth_clients),patch('endpoints','endpoints',S.projects),patch('activeCalls','calls',S.active_calls)
]);$('pendingBadge').textContent=S.stats.pending||'';$('serverStatus').textContent='v'+S.version+' HTTP:80 ACME '+(S.settings.mcp_http_active?'on':'off')+' · HTTPS:443 '+(S.settings.mcp_https_active?S.settings.tls_active_kind:'off');$('refreshStatus').textContent='updated '+new Date().toLocaleTimeString();setOptions($('logProject'),S.projects.map(p=>[p.slug,p.slug]),$('logProject').value,'All projects');const projects=S.projects.map(p=>[p.id,p.name]);if(!$('toolDialog').open)setOptions($('tproject'),projects);if(!$('rootDialog').open)setOptions($('rproject'),projects);if(!dirty&&!document.activeElement?.closest('#settings')){for(const[id,value]of[['externalUrl',S.settings.external_url],['publicIp',S.settings.public_ip],['tlsEmail',S.settings.tls_email],['sslipSuffix',S.settings.sslip_suffix],['acmeDirectoryUrl',S.settings.acme_directory_url]])$(id).value=value;$('publicIpUrls').value=(S.settings.public_ip_urls||[]).join('\n')}if(document.activeElement!==$('debugHttpLog'))$('debugHttpLog').checked=S.settings.debug_http_log;$('settingsInfo').textContent=`GUI: ${S.settings.gui_url}\nHTTP: 0.0.0.0:80 (ACME only) ${S.settings.mcp_http_active?'active':'failed'}\nHTTPS: 0.0.0.0:443 (MCP) ${S.settings.mcp_https_active?'active with '+S.settings.tls_active_kind:'failed'}\nPublic: ${S.settings.external_base_url||'not available'}\nCertificate: ${S.settings.tls_active_valid?'valid':'invalid'} / ${S.settings.tls_active_trusted?'trusted':'not trusted'}\nExpires: ${S.settings.tls_active_expires||'none'}\nNext ACME attempt: ${S.settings.tls_next_attempt_at?new Date(S.settings.tls_next_attempt_at).toLocaleString():'not scheduled'}\nDatabase: ${S.settings.database}\nData: ${S.settings.data_dir}\nExtra command directory: ${S.settings.bin_directory}`}

async function refresh(manual=true){if(refreshing)return;refreshing=true;const viewport=[scrollX,scrollY],holdCurrent=!manual&&preserveAutoView();try{S=await api('/api/state');await renderState();$('errorBanner').style.display='none';if(current==='processes')await loadProcesses();if(current==='commands')await loadCommands();if(current==='logs'&&!holdCurrent)await loadLogs();if(current==='debug'&&!holdCurrent)await loadDebug()}catch(e){showError(e)}finally{refreshing=false;requestAnimationFrame(()=>scrollTo(viewport[0],viewport[1]))}}
function setPage(name){current=name;document.querySelectorAll('.page').forEach(x=>x.classList.toggle('on',x.id===name));if(name==='logs')loadLogs();if(name==='debug')loadDebug();if(name==='processes')loadProcesses();if(name==='commands')loadCommands()}
async function openProject(id){const p=S.projects.find(x=>x.id===id)||{enabled:1,oauth:1,basic_enabled:0,basic_username:'mrmcp',exec_enabled:1,confirm_mode:'allow',enabled_tools:S.base_tools,root:''};$('pid').value=p.id||'';$('pname').value=p.name||'';$('pslug').value=p.slug||'';$('proot').value=p.roots?.[0]?.path||p.root||'';$('proot').readOnly=!!p.id;$('penabled').checked=!!p.enabled;$('poauth').checked=p.oauth!==0;$('pbasic').checked=!!p.basic_enabled;$('pbasicUser').value=p.basic_username||'mrmcp';$('pexec').checked=!!p.exec_enabled;$('pconfirm').value=p.confirm_mode;$('pallow').value=p.allow_re||'';$('pdeny').value=p.deny_re||'';await patch('ptools','tool_checks',{base_tools:S.base_tools,enabled_tools:p.enabled_tools});$('projectDialog').showModal()}
function openRoot(id){const r=S.roots.find(x=>x.id===id)||{project_id:S.projects[0]?.id,enabled:1};$('rid').value=r.id||'';setOptions($('rproject'),S.projects.map(p=>[p.id,p.name]),r.project_id);$('rname').value=r.name||'';$('rpath').value=r.path||'';$('renabled').checked=!!r.enabled;$('rootDialog').showModal()}
function openTool(id){const t=S.custom_tools.find(x=>x.id===id)||{project_id:S.projects[0]?.id,enabled:1,confirm_mode:'inherit'};$('tid').value=t.id||'';setOptions($('tproject'),S.projects.map(p=>[p.id,p.name]),t.project_id);$('tname').value=t.name||'';$('tdesc').value=t.description||'';$('tcommand').value=t.command||'';$('tconfirm').value=t.confirm_mode;$('tenabled').checked=!!t.enabled;$('toolDialog').showModal()}
function openCommand(name='',path=''){const c=commandRows.find(x=>x.name===name&&(!path||x.path===path))||{name,path,description:'',download_url:'',documentation_url:'',enabled:1,registered:false};$('coldName').value=c.registered?c.name:'';$('cname').value=c.name||'';$('cpath').value=c.path||'';$('cdescription').value=c.description||'';$('cdownloadUrl').value=c.download_url||'';$('cdocumentationUrl').value=c.documentation_url||'';$('cenabled').checked=c.enabled!==0;$('commandDialog').showModal()}
async function loadCommands(){const q=new URLSearchParams({q:$('commandQuery').value,page:commandPage,page_size:$('commandPageSize').value,include_missing:$('commandIncludeMissing').checked?'1':'0'}),data=await api('/api/commands?'+q);commandRows=data.commands||[];commandPage=data.page;await patch('commandList','commands',data)}
async function allDownloadableCommands(){const q=new URLSearchParams({page:1,page_size:100,include_missing:'1'}),data=await api('/api/commands?'+q);return(data.commands||[]).filter(x=>x.registered&&x.enabled&&x.download_url)}
async function downloadCommandRow(row,confirmOverwrite=true){if(row.present&&confirmOverwrite&&!confirm(`Replace the existing file for ${row.name}?`))return false;try{await api('/api/commands/download',{method:'POST',body:{name:row.name,overwrite:!!row.present}});return true}catch(e){alert(`Download failed for ${row.name}: ${e?.message||e}`);return false}}
async function downloadAllCommands(button){const rows=await allDownloadableCommands();if(!rows.length)return;const existing=rows.filter(x=>x.present);if(existing.length&&!confirm(`Download all ${rows.length} commands and replace ${existing.length} existing file${existing.length===1?'':'s'}?`))return;const old=button.textContent;button.disabled=true;const failures=[];try{for(let i=0;i<rows.length;i++){button.textContent=`Downloading ${i+1}/${rows.length}`;try{await api('/api/commands/download',{method:'POST',body:{name:rows[i].name,overwrite:!!rows[i].present}})}catch(e){failures.push(`${rows[i].name}: ${e?.message||e}`)}}}finally{button.disabled=false;button.textContent=old;await loadCommands()}if(failures.length)alert(`Download failed for ${failures.length} command${failures.length===1?'':'s'}:
${failures.join('\n')}`)}
async function loadLogs(){const scrolls=scrollSnapshot($('logList')),q=new URLSearchParams({q:$('logQuery').value,project:$('logProject').value,status:$('logStatus').value});await patch('logList','logs',await api('/api/logs?'+q));await restoreRowDetail('tool');restoreScrollSnapshot($('logList'),scrolls)}
async function loadDebug(){const scrolls=scrollSnapshot($('debugList')),q=new URLSearchParams({q:$('debugQuery').value,method:$('debugMethod').value,status:$('debugStatus').value});await patch('debugList','debug',{enabled:S?.settings.debug_http_log,rows:await api('/api/debug?'+q)});await restoreRowDetail('http');restoreScrollSnapshot($('debugList'),scrolls)}
async function loadProcesses(){const data=await api('/api/processes'),rows=data.active||[],ids=new Set(rows.map(x=>x.process_id||x.id));await patch('processList','processes',rows);if(selectedProcess&&ids.has(selectedProcess))await selectProcess(selectedProcess);else clearProcessSelection()}
function clearProcessSelection(){selectedProcess='';$('processInteraction').hidden=true;$('processDetail').textContent='';$('processInput').value=''}
async function selectProcess(id){selectedProcess=id;$('processDetail').textContent=JSON.stringify(await api('/api/processes/'+encodeURIComponent(id)),null,2);$('processInteraction').hidden=false}
async function showSecret(r){if(!r.generated_basic_password&&!r.password)return;const password=r.generated_basic_password||r.password;await navigator.clipboard.writeText(r.basic_url||password);alert(`Basic credentials generated. Copied to clipboard.\nPassword: ${password}\nURL: ${r.basic_url||''}`)}
document.addEventListener('click',async e=>{const copyButton=e.target.closest('[data-copy]');if(copyButton)return copy(copyButton.dataset.copy,copyButton);const page=e.target.closest('[data-page]');if(page)return setPage(page.dataset.page);const b=e.target.closest('[data-action]');if(!b)return;try{const id=b.dataset.id;switch(b.dataset.action){case'refresh':await refresh(true);break;case'new-project':await openProject();break;case'edit-project':await openProject(+id);break;case'delete-project':if(confirm('Delete project?')){await api('/api/projects/delete',{method:'POST',body:{id:+id}});await refresh()}break;case'rotate-basic':await showSecret(await api('/api/projects/basic/rotate',{method:'POST',body:{id:+id}}));await refresh();break;case'new-root':openRoot();break;case'edit-root':openRoot(+id);break;case'delete-root':if(confirm('Delete directory?')){await api('/api/roots/delete',{method:'POST',body:{id:+id}});await refresh()}break;case'delete-workspace':if(confirm('Delete workspace session?')){await api('/api/workspaces/delete',{method:'POST',body:{id}});await refresh()}break;case'new-command':openCommand();break;case'edit-command':openCommand(b.dataset.name,b.dataset.path);break;case'delete-command':if(confirm('Delete command metadata?')){await api('/api/commands/delete',{method:'POST',body:{name:b.dataset.name}});await loadCommands()}break;case'download-command':{const row=commandRows.find(x=>x.name===b.dataset.name);if(row&&await downloadCommandRow(row))await loadCommands();break}case'download-all-commands':await downloadAllCommands(b);break;case'load-commands':commandPage=1;await loadCommands();break;case'commands-prev':if(commandPage>1){commandPage--;await loadCommands()}break;case'commands-next':commandPage++;await loadCommands();break;case'new-tool':openTool();break;case'edit-tool':openTool(+id);break;case'delete-tool':if(confirm('Delete tool?')){await api('/api/tools/delete',{method:'POST',body:{id:+id}});await refresh()}break;case'approve':case'deny':await api('/api/approvals/decide',{method:'POST',body:{id,allow:b.dataset.action==='approve'}});await refresh();break;case'revoke-client':if(confirm('Revoke client?')){await api('/api/oauth/revoke-client',{method:'POST',body:{client_id:id}});await refresh()}break;case'self-test':$('logDetail').textContent=JSON.stringify(await api('/api/mcp/self-test?project='+encodeURIComponent(b.dataset.slug)),null,2);$('logSelfTest').hidden=false;setPage('logs');break;case'close-self-test':$('logSelfTest').hidden=true;$('logDetail').textContent='';break;case'copy-detail':{const target=$(b.dataset.target);if(target)await copy(target.textContent,b);break}case'close-row-detail':{b.closest('.detail-row')?.remove();if(b.dataset.kind==='tool')selectedToolCall='';else selectedHttpLog='';break}case'load-logs':await loadLogs();break;case'select-log':await toggleRowDetail('tool',b.closest('tr'),id);break;case'load-debug':await loadDebug();break;case'save-debug-settings':await api('/api/debug/settings',{method:'POST',body:{enabled:$('debugHttpLog').checked}});await refresh();break;case'select-debug':await toggleRowDetail('http',b.closest('tr'),id);break;case'clear-debug':if(confirm('Clear debug log?')){await api('/api/debug/clear',{method:'POST'});await loadDebug()}break;case'load-processes':await loadProcesses();break;case'select-process':await selectProcess(id);break;case'clear-process-selection':clearProcessSelection();break;case'process-write':await api('/api/processes/write',{method:'POST',body:{id:selectedProcess,data:$('processInput').value}});$('processInput').value='';await selectProcess(selectedProcess);break;case'process-close':await api('/api/processes/write',{method:'POST',body:{id:selectedProcess,close:true}});await selectProcess(selectedProcess);break;case'process-kill':case'process-kill-force':await api('/api/processes/kill',{method:'POST',body:{id:selectedProcess,signal:b.dataset.action==='process-kill-force'?'SIGKILL':'SIGTERM'}});await loadProcesses();break;case'detect-ip':await api('/api/network/detect',{method:'POST'});await refresh();break;case'issue-cert':{const r=await api('/api/tls/issue',{method:'POST'}),c=r.certificate||{};if(!c.requested&&c.reason)alert(c.reason+(c.next_attempt_at?'\nNext attempt: '+new Date(c.next_attempt_at).toLocaleString():''));await refresh();break}case'save-settings':await api('/api/settings',{method:'POST',body:{external_url:$('externalUrl').value,tls_email:$('tlsEmail').value,public_ip_urls:$('publicIpUrls').value.split(/\r?\n/),sslip_suffix:$('sslipSuffix').value,acme_directory_url:$('acmeDirectoryUrl').value}});dirty=false;await refresh();break;case'close-dialog':b.closest('dialog').close();break}}catch(err){showError(err)}});
$('projectForm').addEventListener('submit',async e=>{e.preventDefault();try{const r=await api('/api/projects/save',{method:'POST',body:{id:+$('pid').value||null,name:$('pname').value,slug:$('pslug').value,root:$('proot').value,enabled:$('penabled').checked,oauth:$('poauth').checked,basic_enabled:$('pbasic').checked,basic_username:$('pbasicUser').value,exec_enabled:$('pexec').checked,confirm_mode:$('pconfirm').value,allow_re:$('pallow').value,deny_re:$('pdeny').value,enabled_tools:[...$('ptools').querySelectorAll('input:checked')].map(x=>x.value)}});$('projectDialog').close();dirty=false;await showSecret(r);await refresh()}catch(err){showError(err)}});
$('rootForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/roots/save',{method:'POST',body:{id:+$('rid').value||null,project_id:+$('rproject').value,name:$('rname').value,path:$('rpath').value,enabled:$('renabled').checked}});$('rootDialog').close();dirty=false;await refresh()}catch(err){showError(err)}});
$('toolForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/tools/save',{method:'POST',body:{id:+$('tid').value||null,project_id:+$('tproject').value,name:$('tname').value,description:$('tdesc').value,command:$('tcommand').value,confirm_mode:$('tconfirm').value,enabled:$('tenabled').checked}});$('toolDialog').close();dirty=false;await refresh()}catch(err){showError(err)}});
$('commandForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/commands/save',{method:'POST',body:{old_name:$('coldName').value,name:$('cname').value,path:$('cpath').value,description:$('cdescription').value,download_url:$('cdownloadUrl').value,documentation_url:$('cdocumentationUrl').value,enabled:$('cenabled').checked}});$('commandDialog').close();dirty=false;commandPage=1;await loadCommands()}catch(err){showError(err)}});
document.addEventListener('input',e=>{if(e.target.closest('form,#settings'))dirty=true});for(const id of['logQuery','debugQuery','commandQuery'])$(id).addEventListener('keydown',e=>{if(e.key!=='Enter')return;if(id==='logQuery')loadLogs();else if(id==='debugQuery')loadDebug();else{commandPage=1;loadCommands()}});await refresh(true);setInterval(()=>{if(!document.hidden&&!refreshing&&$('autoRefresh').checked)refresh(false)},2000);
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
      const source = await Deno.readTextFile(join(APP_DIR, "morphlex.js"));
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
  postMessage({ type: "ready", gui: `http://127.0.0.1:${GUI_PORT}/login?token=${encodeURIComponent(ADMIN_TOKEN)}` });

  addEventListener("message", async e => {
    if (e.data?.type !== "shutdown" || shuttingDown) return;
    shuttingDown = true;
    for (const a of approvals.values()) a.resolve(false);
    approvals.clear();
    if (renewalTimer) clearInterval(renewalTimer);
    if (processCleanupTimer) clearInterval(processCleanupTimer);
    if (downloadCleanupTimer) clearInterval(downloadCleanupTimer);
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
    close();
  });
}

// Desktop shell. The backend runs in a Worker because webview.run() is blocking.
async function frontend() {
  const admin = randomToken(), workerUrl = new URL(import.meta.url);
  workerUrl.searchParams.set("backend", "1");
  workerUrl.searchParams.set("admin", admin);
  const worker = new Worker(workerUrl.href, { type: "module", deno: { permissions: "inherit" } });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Backend startup timeout")), 15000);
    worker.addEventListener("message", e => {
      if (e.data?.type === "ready") { clearTimeout(timer); resolveReady(e.data); }
    });
    worker.addEventListener("error", e => { clearTimeout(timer); reject(e.error || new Error(e.message)); });
  });
  const { Webview, SizeHint } = await import("jsr:@webview/webview@0.9.0");
  const webview = new Webview(true, { width: 1040, height: 700, hint: SizeHint.NONE });
  webview.title = "MRMCP";
  webview.navigate(ready.gui);
  try { webview.run(); }
  finally {
    worker.postMessage({ type: "shutdown" });
    await sleep(300);
    worker.terminate();
  }
}

if (IS_BACKEND) await backend();
else await frontend();
