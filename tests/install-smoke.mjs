import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = process.argv[2] ?? process.cwd();
if (process.argv[2] && !/^git:[A-Za-z0-9/._-]+@[0-9a-f]{7,40}$/.test(source)) throw new Error("Pass a pinned Git commit source or omit it for the local checkout");
const temp = await mkdtemp(join(tmpdir(), "pi-install-smoke-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), PI_OFFLINE: "1", PI_HARNESS_CONFIG: join(temp, "config.json"), PI_HARNESS_AUTOMATIC: "1" };
delete env.PI_PACKAGE_DIR;
delete env.PI_HARNESS_SEARCH_ROOT;
delete env.PI_HARNESS_PROJECT_ROOT;
const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), "1.4.0");
execFileSync(process.execPath, [cli, "install", source], { env, stdio: "pipe" });

const failedRoot = join(temp, "failed");
const missingRoot = join(temp, "missing");
await mkdir(join(failedRoot, "scripts"), { recursive: true });
await mkdir(missingRoot);
await writeFile(join(failedRoot, "scripts", "verify"), "#!/usr/bin/env bash\necho 'smoke failure diagnostic' >&2\nexit 3\n", { mode: 0o755 });

for (const { root, status, diagnostic } of [
  { root: resolve("fixtures/react-app"), status: "passed", diagnostic: "" },
  { root: failedRoot, status: "failed", diagnostic: "smoke failure diagnostic" },
  { root: missingRoot, status: "unavailable", diagnostic: "Missing ./scripts/verify" },
]) {
  const evidenceDir = join(temp, `evidence-${status}`);
  await writeFile(env.PI_HARNESS_CONFIG, JSON.stringify({ evidenceDir }));
  const pi = spawn(process.execPath, [cli, "--approve", "--mode", "rpc"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let errors = "";
  let pending = "";
  let done;
  let fail;
  let finished = false;
  const result = new Promise((yes, no) => { done = yes; fail = no; });
  const timer = setTimeout(() => { pi.kill(); fail(new Error(`Pi RPC ${status} smoke timed out: ${errors}`)); }, 45000);
  pi.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  pi.on("error", fail);
  const closed = new Promise((done) => pi.once("close", (code) => {
    if (!finished || code !== 0) fail(new Error(`Pi exited ${code}: ${errors}`));
    done(code);
  }));
  pi.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      try {
        const record = JSON.parse(line);
        events.push(record);
        if (record.id === "commands") {
          assert.ok(record.success && record.data?.commands?.some((command) => command.name === "verify" && command.source === "extension"));
          assert.ok(record.data.commands.some((command) => command.name === "resume-repair" && command.source === "extension"));
          pi.stdin.write(JSON.stringify({ id: "verify", type: "prompt", message: "/verify" }) + "\n");
        } else if (record.id === "verify") {
          assert.ok(record.success && record.data?.disposition === "handled", JSON.stringify(record));
          pi.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
        } else if (record.id === "state") {
          assert.ok(record.success && record.data?.isStreaming === false && record.data?.pendingMessageCount === 0, JSON.stringify(record));
          pi.stdin.write(JSON.stringify({ id: "messages", type: "get_messages" }) + "\n");
        } else if (record.id === "messages") {
          assert.ok(record.success && record.data?.messages?.length === 0, JSON.stringify(record));
          finished = true;
          done();
        }
      } catch (error) { fail(error); return; }
    }
  });
  pi.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
  try {
    await result;
  } finally {
    pi.stdin.end();
    const shutdown = setTimeout(() => pi.kill(), 5000);
    await closed;
    clearTimeout(shutdown);
    clearTimeout(timer);
  }
  assert.equal(pi.exitCode, 0, errors);
  const files = await readdir(evidenceDir);
  const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(evidenceDir, file), "utf8"))));
  assert.equal(records.length, 2, JSON.stringify(records));
  const attempt = records.find((record) => record.kind === "attempt");
  const summary = records.find((record) => record.kind === "summary");
  assert.ok(attempt && summary, JSON.stringify(records));
  assert.equal(attempt.status, status);
  assert.equal(attempt.trigger, "manual");
  assert.equal(attempt.repairContinuations, 0);
  assert.equal(attempt.acceptanceStatus, "not_evaluated");
  assert.equal(summary.finalOutcome, status);
  assert.equal(summary.acceptanceStatus, "not_evaluated");
  assert.equal(summary.attempts, 1);
  assert.equal(summary.repairContinuations, 0);
  assert.equal(summary.executionId, attempt.executionId);
  assert.equal(summary.taskId, attempt.taskId);
  assert.equal(summary.lastEvidencePath, join(evidenceDir, files[records.indexOf(attempt)]));
  if (status === "failed") assert.equal(attempt.exitCode, 3);
  if (status === "unavailable") assert.equal(attempt.exitCode, undefined);
  assert.ok(attempt.diagnostics.includes(diagnostic), JSON.stringify(attempt));
  const notifications = events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
  assert.equal(notifications.length, 1, JSON.stringify(notifications));
  assert.equal(notifications[0].notifyType, status === "passed" ? "info" : "warning");
  assert.ok(notifications[0].message.startsWith(`${status} (`), JSON.stringify(notifications));
  assert.ok(notifications[0].message.includes(attempt.diagnostics), JSON.stringify(notifications));
  assert.ok(notifications[0].message.includes(summary.lastEvidencePath), JSON.stringify(notifications));
  assert.ok(!events.some((event) => event.type === "agent_start" || event.type === "entry_appended" && event.entry?.customType === "pi-engineering-harness-feedback"), JSON.stringify(events));
  console.log(`Real Pi 1.4.0 installed /verify: ${status}, no repair`);
}
console.log(`Source: ${source}; artifacts: ${temp}`);
