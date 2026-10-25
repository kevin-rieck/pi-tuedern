// Run explicitly: node tests/install-smoke.mjs git:github.com/kevin-rieck/pi-tuedern@<commit>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = process.argv[2];
if (!source || !/^git:[A-Za-z0-9/._-]+@[0-9a-f]{7,40}$/.test(source)) throw new Error("Pass a pinned Git commit source");
const temp = await mkdtemp(join(tmpdir(), "pi-pinned-smoke-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), PI_PACKAGE_DIR: join(temp, "packages"), PI_OFFLINE: "1", PI_HARNESS_CONFIG: join(temp, "config.json") };
const evidenceDir = join(temp, "evidence");
await writeFile(env.PI_HARNESS_CONFIG, JSON.stringify({ evidenceDir }));
const cli = process.platform === "win32" ? "pi.cmd" : "pi";
const install = spawn(cli, ["install", source], { env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
let installError = "";
install.stdout.resume();
install.stderr.on("data", (chunk) => { installError += chunk.toString(); });
assert.equal(await new Promise((done, fail) => { install.on("error", fail); install.on("close", done); }), 0, installError);
const pi = spawn(cli, ["--approve", "--mode", "rpc"], { cwd: resolve("fixtures/react-app"), env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
let errors = "";
let pending = "";
let done;
let fail;
const result = new Promise((yes, no) => { done = yes; fail = no; });
const timer = setTimeout(() => { pi.kill(); fail(new Error("Pi RPC smoke timed out")); }, 45000);
pi.stderr.on("data", (chunk) => { errors += chunk.toString(); });
pi.on("error", fail);
pi.stdout.on("data", (chunk) => {
  pending += chunk.toString();
  let index;
  while ((index = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, index); pending = pending.slice(index + 1);
    let record;
    try { record = JSON.parse(line); } catch (error) { fail(error); return; }
    if (record.id === "commands") {
      try { assert.ok(record.data?.commands?.some((command) => command.name === "verify" && command.source === "extension")); }
      catch (error) { fail(error); return; }
      pi.stdin.write(JSON.stringify({ id: "verify", type: "prompt", message: "/verify" }) + "\n");
    }
    if (record.id === "verify") {
      if (!record.success || record.data?.disposition !== "handled") fail(new Error(JSON.stringify(record)));
      else done();
    }
  }
});
pi.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
try {
  await result;
  const records = await Promise.all((await readdir(evidenceDir)).map(async (file) => JSON.parse(await readFile(join(evidenceDir, file), "utf8"))));
  assert.ok(records.some((record) => record.kind === "attempt" && record.status === "passed" && record.trigger === "manual"));
  assert.ok(records.some((record) => record.kind === "summary" && record.finalOutcome === "passed"));
  console.log(`Pinned install and real Pi /verify passed: ${source}`);
} finally {
  clearTimeout(timer);
  pi.stdin.end();
  await new Promise((done) => pi.once("close", done));
}
if (errors) console.error(errors);
