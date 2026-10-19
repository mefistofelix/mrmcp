// Build-only packaging. Package sources, loaders, binaries and licenses are
// copied unchanged; no dependency is patched or loaded by its private binding.
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative, basename } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "..");
const require = createRequire(join(root, "package.json"));
const os = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const targetOS = os === "windows" ? "win32" : os;
const target = "bun-" + (targetOS === "win32" ? "windows" : targetOS) + "-" + arch;
const outfile = resolve(
  process.argv[4] || join(root, targetOS === "win32" ? "mrmcp.exe" : "mrmcp"),
);
const build = join(root, "build", "bun-" + targetOS + "-" + arch);
const bundle = join(build, "native-runtime");
if (!["win32-x64", "linux-x64", "darwin-arm64"].includes(targetOS + "-" + arch))
  throw Error("Unsupported release target: " + targetOS + "-" + arch);
await fs.mkdir(bundle, { recursive: true });
const assets = join(build, "assets");
await fs.mkdir(assets, { recursive: true });
for (const name of ["mrmcp-logo.svg", "mrmcp-logo.png", "mrmcp.ico"])
  await fs.copyFile(join(root, "assets", name), join(assets, name));
const manifest = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
const files = {};
const seen = new Set();
const packages = [];
const permits = (list, value) =>
  !list ||
  (!list.includes("!" + value) && (list.every((v) => v.startsWith("!")) || list.includes(value)));
const packageDirectory = (name, from = root) => {
  try {
    return dirname(Bun.resolveSync(name + "/package.json", from));
  } catch {}
  let path = dirname(Bun.resolveSync(name, from));
  for (;;) {
    try {
      const p = JSON.parse(require("node:fs").readFileSync(join(path, "package.json"), "utf8"));
      if (p.name === name) return path;
    } catch {}
    const up = dirname(path);
    if (up === path) throw Error("Package root not found: " + name);
    path = up;
  }
};
async function collect(name, from = root, optional = false) {
  if (name === "tesseract.js") return;
  let directory;
  try {
    directory = packageDirectory(name, from);
  } catch (error) {
    if (optional) return;
    throw error;
  }
  const p = JSON.parse(await fs.readFile(join(directory, "package.json"), "utf8"));
  if (!permits(p.os, targetOS) || !permits(p.cpu, arch) || !permits(p.libc, "glibc")) return;
  if (seen.has(directory)) return;
  seen.add(directory);
  packages.push({ name, version: p.version });
  // Each public dependency uses the installed target package graph. Avoid
  // shipping foreign optional native packages.
  const packagePath = relative(root, directory).replaceAll("\\", "/");
  if (!packagePath.startsWith("node_modules/"))
    throw Error("Build dependencies must be installed in this project's node_modules: " + name);
  const prefix = packagePath + "/";
  async function walk(path, tail = "") {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "__tests__", "test", "tests"].includes(entry.name)) continue;
      const next = tail + entry.name;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full, next + "/");
      else if (entry.isFile() && !/\.(?:map|ts|tsx)$/.test(entry.name))
        files[prefix + next] = await fs.readFile(full);
    }
  }
  await walk(directory);
  for (const dep of Object.keys(p.dependencies || {})) await collect(dep, directory);
  for (const dep of Object.keys(p.peerDependencies || {})) await collect(dep, directory, true);
  for (const dep of Object.keys(p.optionalDependencies || {})) {
    // Rag uses the current Auto.js
    // through its public OCR hook, so its old optional Auto.js is unnecessary.
    if (p.name === "@mefistofelix/rag.js" && dep === "@mefistofelix/auto.js") continue;
    await collect(dep, directory, true);
  }
}
for (const name of Object.keys(manifest.dependencies))
  if (!["chardet", "iconv-lite", "eta", "xz-decompress"].includes(name)) await collect(name);
for (const name of Object.keys(manifest.optionalDependencies || {}))
  await collect(name, root, true);
const archive = await new Bun.Archive(files, { compress: "gzip" }).bytes();
await fs.writeFile(join(bundle, "packages.tar.gz"), archive);
const sha256 = createHash("sha256").update(archive).digest("hex");
const identityHash = createHash("sha256");
for (const name of Object.keys(files).sort())
  identityHash.update(name).update("\0").update(createHash("sha256").update(files[name]).digest());
const identity = identityHash.digest("hex");
await fs.writeFile(
  join(bundle, "manifest.json"),
  JSON.stringify({ sha256, identity, os: targetOS, arch, packages }, null, 2),
);
console.log(
  `Runtime: ${packages.length} packages, ${(archive.length / 1048576).toFixed(1)} MiB compressed`,
);
const args = [
  "build",
  "--compile",
  "--compile-autoload-package-json",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--target=" + target,
  "--minify",
  "--asset",
  bundle,
  "--asset",
  assets,
];
for (const name of [
  "commands.yaml",
  "mcp.yaml",
  "guided_prompts.yaml",
  "proxies.yaml",
  "search.yaml",
  "LICENSE",
])
  args.push("--asset", join(root, name));
if (targetOS === "win32")
  args.push("--windows-hide-console", "--windows-icon=" + join(root, "assets", "mrmcp.ico"));
args.push("--outfile", outfile, resolve(process.argv[5] || join(root, "mrmcp.js")));
const child = Bun.spawn([process.execPath, ...args], {
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
if (await child.exited) throw new Error("Bun compilation failed");
console.log(
  "Built " + outfile + " (" + ((await fs.stat(outfile)).size / 1048576).toFixed(1) + " MiB)",
);
