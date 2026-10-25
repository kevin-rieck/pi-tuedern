// Authenticated Pi 1.4.0 RPC: abort before settlement, then crash during verification.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "pi-interruption-"));
const root = join(temp, "project");
const evidenceDir = join(temp, "evidence");
const marker = join(temp, "started");
await mkdir(join(root, "scripts"), { recursive: true });
execFileSync("git", ["init", "-q", root]);
await writeFile(join(root, "scripts", "verify"), '#!/usr/bin/env bash\necho started > "$PI_HARNESS_SMOKE_MARKER"\nsleep 30\nexit 1\n', { mode: 0o755 });
await writeFile(join(root, "source.txt"), "original\n");
const config = join(temp, "config.json");
await writeFile(config, JSON.stringify({ automaticOnSettle: true, evidenceDir }));
const edit = join(temp, "edit.mjs");
await writeFile(edit, 'import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("agent_before_settle", () => { appendFileSync("source.txt", "changed\\n"); }); }\n');
const env = { ...process.env, PI_HARNESS_CONFIG: config, PI_HARNESS_SMOKE_MARKER: marker, PI_OFFLINE: "1" };
const sessionId = "22222222-2222-4222-8222-222222222222";
const records = async () => existsSync(evidenceDir) ? Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8")))) : [];
const launch = (withEdit) => {
  const pi = spawn(process.platform === "win32" ? "pi.cmd" : "pi", ["--approve", "--no-tools", "--no-extensions", ...(withEdit ? ["-e", edit] : []), "-e", resolve("src/extension.ts"), "--session-dir", join(temp, "sessions"), "--session-id", sessionId, "--mode", "rpc"], { cwd: root, env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let pending = "", stderr = "";
  pi.stdout.on("data", (chunk) => {
    pending += chunk;
    let n;
    while ((n = pending.indexOf("\n")) >= 0) {
      try { events.push(JSON.parse(pending.slice(0, n))); } catch { /* ignore partial output */ }
      pending = pending.slice(n + 1);
    }
  });
  pi.stderr.on("data", (chunk) => { stderr += chunk; });
  const wait = async (predicate) => {
    const deadline = Date.now() + 60000;
    while (!predicate() && Date.now() < deadline && pi.exitCode === null) await new Promise((done) => setTimeout(done, 100));
    assert.ok(predicate(), `Pi timed out/exited: ${stderr.slice(-1000)}; ${JSON.stringify(events.slice(-3))}`);
  };
  return { pi, events, wait };
};
const stop = async (pi) => {
  pi.stdin.end();
  await Promise.race([new Promise((done) => pi.once("close", done)), new Promise((done) => setTimeout(() => { pi.kill(); done(); }, 5000))]);
};

const first = launch(false);
try {
  first.pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools." }) + "\n");
  await first.wait(() => first.events.some((e) => e.type === "agent_start"));
  first.pi.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
  await first.wait(() => first.events.some((e) => e.type === "agent_settled"));
  assert.ok(first.events.some((e) => e.type === "agent_settled" && e.aborted));
  assert.ok((await records()).some((r) => r.kind === "summary" && r.finalOutcome === "cancelled" && r.attempts === 0));
} finally { await stop(first.pi); }

const second = launch(true);
let crashedExecution;
try {
  second.pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools." }) + "\n");
  await second.wait(() => existsSync(marker));
  crashedExecution = second.events.find((e) => e.type === "entry_appended" && e.entry?.customType === "pi-engineering-harness-state")?.entry?.data?.executionId;
  assert.ok(crashedExecution, "must identify interrupted execution");
  // Kill the Pi process tree: graceful shutdown would create an outcome and isn't a crash test.
  if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(second.pi.pid), "/t", "/f"], { stdio: "ignore" });
  else second.pi.kill("SIGKILL");
  await new Promise((done) => second.pi.once("close", done));
  const after = await records();
  assert.equal(after.filter((r) => r.kind === "summary" && r.finalOutcome === "passed").length, 0);
  assert.equal(after.filter((r) => r.kind === "summary" && r.attempts > 0).length, 0, "crashed attempt is not settled");
} finally { if (second.pi.exitCode === null) second.pi.kill(); }

const resumed = launch(false);
try {
  resumed.pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools." }) + "\n");
  await resumed.wait(() => resumed.events.some((e) => e.type === "agent_settled"));
  const after = await records();
  const recovered = after.filter((r) => r.kind === "summary" && r.executionId === crashedExecution);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].finalOutcome, "error");
  assert.equal(recovered[0].attempts, 1);
  assert.equal(recovered[0].acceptanceStatus, "not_evaluated");
  assert.ok(after.some((r) => r.kind === "summary" && r.finalOutcome === "not_applicable" && r.executionId !== crashedExecution));
  console.log("Real Pi: pre-settlement abort cancelled; crash mid-check reconciled as error on session resume");
} finally { await stop(resumed.pi); }
