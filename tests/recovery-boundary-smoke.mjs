// Authenticated Pi 1.4.0 RPC: hard-kill at the recovery summary/marker boundary.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import summarySchema from "../schemas/summary.schema.json" with { type: "json" };

const temp = await mkdtemp(join(tmpdir(), "pi-recovery-boundary-"));
const root = join(temp, "project");
const evidenceDir = join(temp, "evidence");
const sessionDir = join(temp, "sessions");
const started = join(temp, "check-started");
const boundary = join(temp, "summary-written");
const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const harness = resolve("src/extension.ts");
const sessionId = "55555555-5555-4555-8555-555555555555";
const env = { ...process.env, PI_OFFLINE: "1", PI_HARNESS_CONFIG: join(temp, "config.json"), PI_HARNESS_SMOKE_MARKER: started };
for (const key of ["PI_PACKAGE_DIR", "PI_HARNESS_AUTOMATIC", "PI_HARNESS_SEARCH_ROOT", "PI_HARNESS_PROJECT_ROOT"]) delete env[key];
assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), "1.4.0");
console.log(`Artifacts: ${temp}`);
await mkdir(join(root, "scripts"), { recursive: true });
execFileSync("git", ["init", "-q", root]);
await writeFile(join(root, "source.txt"), "original\n");
await writeFile(join(root, "scripts", "verify"), '#!/usr/bin/env bash\necho started > "$PI_HARNESS_SMOKE_MARKER"\nsleep 120\nexit 1\n', { mode: 0o755 });
await writeFile(env.PI_HARNESS_CONFIG, JSON.stringify({ automaticOnSettle: true, recordEvidence: true, evidenceDir }));
const edit = join(temp, "edit.mjs");
await writeFile(edit, 'import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("agent_before_settle", () => { appendFileSync("source.txt", "changed\\n"); }); }\n');
const pausedHarness = join(temp, "paused-harness.mjs");
// Wrap only the test process: block the actual marker append after the real summary call returns.
await writeFile(pausedHarness, `import { writeFileSync } from "node:fs";
import harness from ${JSON.stringify(pathToFileURL(harness).href)};
export default function (pi) {
  harness(new Proxy(pi, { get(target, key) {
    if (key !== "appendEntry") return target[key];
    return (type, data) => {
      if (type === "pi-engineering-harness-state" && data.verifying === false && data.lastStatus === "error") {
        writeFileSync(${JSON.stringify(boundary)}, "summary persisted; marker append blocked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return target.appendEntry(type, data);
    };
  } }));
}
`);

const launch = (extensions) => {
  const pi = spawn(process.execPath, [cli, "--approve", "--no-tools", "--no-extensions", ...extensions.flatMap((path) => ["-e", path]), "--session-dir", sessionDir, "--session-id", sessionId, "--mode", "rpc"], { cwd: root, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let pending = "", stderr = "";
  pi.stdout.on("data", (chunk) => {
    pending += chunk;
    let n;
    while ((n = pending.indexOf("\n")) >= 0) {
      try { events.push(JSON.parse(pending.slice(0, n))); } catch { /* timeout reports missing events */ }
      pending = pending.slice(n + 1);
    }
  });
  pi.stderr.on("data", (chunk) => { stderr += chunk; });
  const wait = async (predicate) => {
    const deadline = Date.now() + 120_000;
    while (!predicate() && Date.now() < deadline && pi.exitCode === null && pi.signalCode === null) await new Promise((done) => setTimeout(done, 100));
    assert.ok(predicate(), `Pi timed out/exited: ${stderr.slice(-1000)}; ${JSON.stringify(events.slice(-3)).slice(-2000)}`);
  };
  return { pi, events, wait };
};
const kill = async (pi) => {
  const closed = new Promise((done) => pi.once("close", done));
  if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pi.pid), "/t", "/f"], { stdio: "ignore" });
  else process.kill(-pi.pid, "SIGKILL");
  await closed;
};
const stop = async (pi) => {
  if (pi.exitCode !== null || pi.signalCode !== null) return;
  pi.stdin.end();
  const timer = setTimeout(() => pi.kill(), 5000);
  await new Promise((done) => pi.once("close", done));
  clearTimeout(timer);
};
const entries = async (sessionFile) => (await readFile(sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
const states = (all) => all.filter((entry) => entry.type === "custom" && entry.customType === "pi-engineering-harness-state");
const evidence = async () => existsSync(evidenceDir) ? Promise.all((await readdir(evidenceDir)).sort().map(async (name) => ({ name, content: await readFile(join(evidenceDir, name), "utf8") }))) : [];

const first = launch([edit, harness]);
let sessionFile, pending;
try {
  first.pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools." }) + "\n");
  await first.wait(() => existsSync(started));
  const files = await readdir(sessionDir);
  assert.equal(files.length, 1);
  sessionFile = join(sessionDir, files[0]);
  const all = await entries(sessionFile);
  assert.equal(all[0].id, sessionId);
  pending = states(all).at(-1).data;
  assert.equal(pending.verifying, true);
  assert.equal(pending.attempts, 1);
  await kill(first.pi);
  assert.deepEqual(await evidence(), []);
} finally { if (first.pi.exitCode === null && first.pi.signalCode === null) await kill(first.pi); }

const interrupted = launch([pausedHarness]);
let before, sessionBefore;
try {
  await interrupted.wait(() => existsSync(boundary));
  before = await evidence();
  assert.equal(before.length, 1);
  const summary = JSON.parse(before[0].content);
  const validate = addFormats.default(new Ajv2020()).compile(summarySchema);
  assert.ok(validate(summary), JSON.stringify(validate.errors));
  assert.equal(summary.executionId, pending.executionId);
  assert.equal(summary.taskId, pending.taskId);
  assert.equal(summary.sessionId, sessionId);
  assert.equal(summary.finalOutcome, "error");
  assert.equal(summary.attempts, 1);
  assert.equal(summary.repairContinuations, pending.repairContinuations);
  assert.equal(summary.acceptanceStatus, "not_evaluated");
  sessionBefore = await entries(sessionFile);
  assert.equal(states(sessionBefore).at(-1).data.verifying, true);
  assert.equal(states(sessionBefore).at(-1).data.executionId, pending.executionId);
  await kill(interrupted.pi);
  assert.deepEqual(await evidence(), before);
  assert.deepEqual(await entries(sessionFile), sessionBefore);
} finally { if (interrupted.pi.exitCode === null && interrupted.pi.signalCode === null) await kill(interrupted.pi); }

const resumed = launch([harness]);
try {
  resumed.pi.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
  await resumed.wait(() => resumed.events.some((event) => event.id === "state"));
  const response = resumed.events.find((event) => event.id === "state");
  assert.ok(response.success);
  assert.equal(response.data.sessionId, sessionId);
  assert.equal(resolve(response.data.sessionFile), resolve(sessionFile));
  assert.deepEqual(await evidence(), before, "the original summary file must be reused unchanged");
  const sessionAfter = await entries(sessionFile);
  assert.deepEqual(sessionAfter.slice(0, sessionBefore.length), sessionBefore);
  const recovered = states(sessionAfter).at(-1).data;
  assert.equal(recovered.executionId, pending.executionId);
  assert.equal(recovered.verifying, false);
  assert.equal(recovered.lastStatus, "error");
  assert.equal(recovered.attempts, 1);
  console.log("Real Pi: hard-killed after error summary persistence and before marker clear; same session reused the summary and cleared the marker as error");
} finally { await stop(resumed.pi); }
