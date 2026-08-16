import { Tauriless } from "npm:@mefistofelix/tauriless@0.1.12";

const probeUrl = Deno.env.get("TAURILESS_PROBE_URL") ?? "index.html";
const t = new Tauriless();
const pending = new Map();
let nextId = 1;
let indexPath;
let timer;
let finished = false;

function request(cmd, payload = {}) {
  const id = nextId++;
  console.log("SEND", JSON.stringify({ id, cmd, payload }));
  return new Promise((resolve, reject) => {
    pending.set(id, { cmd, resolve, reject });
    t.send({ id, cmd, payload });
  });
}

async function finish(code, reason) {
  if (finished) return;
  finished = true;
  console.log("FINISH", code, reason);
  clearInterval(timer);
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
  try { t.close(); } catch {}
  if (indexPath) try { Deno.removeSync(indexPath); } catch {}
  setTimeout(() => Deno.exit(code), 0);
}

function drain() {
  for (const message of t.drain().messages) {
    console.log("DRAIN", JSON.stringify(message));
    if (message.kind === "asset-request") {
      request("tauriless:asset-response", {
        requestId: message.requestId,
        path: indexPath,
      }).catch(error => finish(3, `asset response failed: ${error}`));
    } else if (message.kind === "result") {
      const callback = pending.get(message.id);
      if (!callback) continue;
      pending.delete(message.id);
      if (message.ok) callback.resolve(message.value);
      else callback.reject(new Error(`${callback.cmd}: ${JSON.stringify(message.error)}`));
    } else if (
      message.kind === "event" &&
      message.event === "tauriless://webview-message" &&
      message.payload?.type === "ready"
    ) {
      finish(0, "webview ready");
    }
  }
}

indexPath = await Deno.makeTempFile({ suffix: ".html" });
await Deno.writeTextFile(indexPath, `<!doctype html><meta charset="utf-8"><script>
  const i = window.__TAURI_INTERNALS__;
  i.invoke("plugin:event|emit", {
    event: "tauriless://webview-message",
    payload: { type: "ready" }
  }).catch(error => console.error(error));
</script>`);

timer = setInterval(drain, 16);
request("plugin:webview|create_webview_window", {
  options: { label: "main", title: "Tauriless Probe", url: probeUrl, visible: true },
}).catch(error => finish(4, `create failed: ${error}`));
setTimeout(() => finish(2, "10s bootstrap timeout"), 10_000);
