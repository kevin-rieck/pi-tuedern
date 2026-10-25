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
await writeFile(join(root, "scripts", "verify"), '#!/usr/bin/env bash\necho start > "$PI_HARNESS_SMOKE_MARKER"\nsleep 30\nexit 1\n', { mode: 0o755 });
await writeFile(join(root, "source.txt"), "original\n");
const before = join(temp, "before.mjs");
await writeFile(before, 'import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("agent_before_settle", () => { appendFileSync("source.txt", "changed\\n"); }); }\n');
const evidenceDir = join(temp, "evidence");
const config = join(temp, "config.json");
await writeFile(config, JSON.stringify({ automaticOnSettle: true, evidenceDir }));
const env = { ...process.env, PI_HARNESS_CONFIG: config, PI_HARNESS_SMOKE_MARKER: marker, PI_OFFLINE: "1" };
const pi = spawn(process.platform === "win32" ? "pi.cmd" : "pi", ["--approve", "--no-tools", "--no-extensions", "-e", before, "-e", process.cwd(), "--mode", "rpc"], { cwd: root, env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
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
  pi.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
  await new Promise((done) => setTimeout(done, 1200));
  assert.ok(existsSync(marker) && !existsSync(evidenceDir), "Native RPC abort unexpectedly terminated settlement verifier");
  pi.stdin.write(JSON.stringify({ id: "cancel", type: "prompt", message: "/verify-cancel" }) + "\n");
  while (!events.some((event) => event.id === "cancel") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(events.some((event) => event.id === "cancel" && event.success && event.data?.disposition === "handled"), `Cancel command failed: ${error}`);
  while ((!existsSync(evidenceDir) || !(await readdir(evidenceDir)).some(Boolean)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  const attempts = await Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8"))));
  assert.ok(attempts.some((record) => record.kind === "attempt" && record.status === "cancelled"), JSON.stringify(attempts));
  while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(events.some((event) => event.type === "agent_settled"), `Pi did not settle: ${error}`);
  assert.equal(events.filter((event) => event.type === "entry_appended" && event.entry?.customType === "pi-engineering-harness-feedback").length, 0);
  console.log("Real Pi: RPC abort did not stop settlement check; /verify-cancel did, no repair");
} finally {
  pi.stdin.end();
  await Promise.race([new Promise((done) => pi.once("close", done)), new Promise((done) => setTimeout(() => { pi.kill(); done(); }, 5000))]);
}
