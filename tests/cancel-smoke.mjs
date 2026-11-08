// Authenticated real Pi smoke: node tests/cancel-smoke.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "pi-cancel-smoke-"));
const root = join(temp, "project");
await mkdir(join(root, "scripts"), { recursive: true });
execFileSync("git", ["init", "-q", root]);
const marker = join(temp, "started");
const heartbeat = join(temp, "heartbeat");
const finished = join(temp, "finished");
const signal = join(temp, "signal");
await writeFile(join(root, "scripts", "verify"), '#!/usr/bin/env bash\necho start > "$PI_HARNESS_SMOKE_MARKER"\nsleep 2\necho alive > "$PI_HARNESS_SMOKE_HEARTBEAT"\nsleep 28\necho finished > "$PI_HARNESS_SMOKE_FINISHED"\nexit 1\n', { mode: 0o755 });
await writeFile(join(root, "source.txt"), "original\n");
const before = join(temp, "before.mjs");
await writeFile(before, 'import { appendFileSync, writeFileSync } from "node:fs";\nexport default function (pi) { pi.on("agent_before_settle", (_event, ctx) => { writeFileSync(process.env.PI_HARNESS_SMOKE_SIGNAL, String(!!ctx.signal)); appendFileSync("source.txt", "changed\\n"); }); }\n');
const evidenceDir = join(temp, "evidence");
const config = join(temp, "config.json");
await writeFile(config, JSON.stringify({ automaticOnSettle: true, evidenceDir }));
const env = { ...process.env, PI_HARNESS_CONFIG: config, PI_HARNESS_SMOKE_MARKER: marker, PI_HARNESS_SMOKE_HEARTBEAT: heartbeat, PI_HARNESS_SMOKE_FINISHED: finished, PI_HARNESS_SMOKE_SIGNAL: signal, PI_OFFLINE: "1" };
delete env.PI_PACKAGE_DIR;
const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), "1.4.0");
const pi = spawn(process.execPath, [cli, "--approve", "--no-tools", "--no-extensions", "-e", before, "-e", process.cwd(), "--mode", "rpc"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
let output = "";
let error = "";
const events = [];
pi.stdout.on("data", (chunk) => {
  output += chunk.toString();
  let n;
  while ((n = output.indexOf("\n")) >= 0) {
    try { events.push(JSON.parse(output.slice(0, n))); } catch { /* timeout reports missing response */ }
    output = output.slice(n + 1);
  }
});
pi.stderr.on("data", (chunk) => { error += chunk.toString(); });
pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools." }) + "\n");
const deadline = Date.now() + 45000;
try {
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(existsSync(marker), `Pi did not reach verification: ${error}`);
  assert.equal(await readFile(signal, "utf8"), "false", "Settlement unexpectedly supplied an abort signal");
  assert.ok(!existsSync(heartbeat), "Verifier heartbeat preceded the abort request");
  pi.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
  while (!existsSync(heartbeat) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(existsSync(heartbeat) && !existsSync(finished) && !existsSync(evidenceDir) && !events.some((event) => event.id === "abort"), "RPC abort unexpectedly stopped settlement verification");
  pi.stdin.write(JSON.stringify({ id: "cancel", type: "prompt", message: "/verify-cancel" }) + "\n");
  while (!events.some((event) => event.id === "cancel") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(events.some((event) => event.id === "cancel" && event.success && event.data?.disposition === "handled"), `Cancel command failed: ${error}`);
  while ((!existsSync(evidenceDir) || !(await readdir(evidenceDir)).some(Boolean)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(events.some((event) => event.type === "agent_settled"), `Pi did not settle: ${error}`);
  while (!events.some((event) => event.id === "abort") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(events.some((event) => event.id === "abort" && event.success), `Abort response missing: ${error}`);
  const records = await Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8"))));
  assert.ok(records.some((record) => record.kind === "attempt" && record.status === "cancelled"), JSON.stringify(records));
  assert.ok(records.some((record) => record.kind === "summary" && record.finalOutcome === "cancelled" && record.repairContinuations === 0), JSON.stringify(records));
  assert.equal(events.filter((event) => event.type === "entry_appended" && event.entry?.customType === "pi-engineering-harness-feedback").length, 0);
  console.log(`Real Pi 1.4.0: RPC abort did not stop settlement check; /verify-cancel did, no repair. Artifacts: ${temp}`);
} finally {
  pi.stdin.end();
  await Promise.race([new Promise((done) => pi.once("close", done)), new Promise((done) => setTimeout(() => { pi.kill(); done(); }, 5000))]);
}
