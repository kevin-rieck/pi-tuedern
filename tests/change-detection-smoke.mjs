// Authenticated Pi 1.4.0 RPC smoke: node tests/change-detection-smoke.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "pi-change-detection-"));
const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const harness = resolve("src/extension.ts");
const env = { ...process.env, PI_OFFLINE: "1" };
delete env.PI_PACKAGE_DIR;
delete env.PI_HARNESS_AUTOMATIC;
delete env.PI_HARNESS_SEARCH_ROOT;
delete env.PI_HARNESS_PROJECT_ROOT;
assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), "1.4.0");
console.log(`Artifacts: ${temp}`);

for (const scenario of ["unchanged", "untracked", "dirty", "after-pass", "changing-check"]) {
  const root = join(temp, scenario, "project");
  const evidenceDir = join(temp, scenario, "evidence");
  const config = join(temp, scenario, "config.json");
  await mkdir(join(root, "scripts"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), ".smoke-runs\n");
  await writeFile(join(root, "source.txt"), "committed\n");
  await writeFile(join(root, "scripts", "verify"), `#!/usr/bin/env bash\necho run >> .smoke-runs\n${scenario === "changing-check" ? "echo verifier >> source.txt\n" : ""}exit 0\n`, { mode: 0o755 });
  execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "add", ".gitignore", "source.txt", "scripts/verify"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
  if (scenario === "dirty") {
    await writeFile(join(root, "source.txt"), "dirty baseline\n");
    assert.match(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), / M source\.txt/);
  }
  await writeFile(config, JSON.stringify({ automaticOnSettle: true, evidenceDir }));
  const before = join(temp, scenario, "before.mjs");
  // Deterministic work during a real Pi turn, after the harness captures its baseline.
  await writeFile(before, `import { execFileSync } from "node:child_process";
let settlements = 0;
export default function (pi) { pi.on("agent_before_settle", () => {
  settlements++;
  const scenario = ${JSON.stringify(scenario)};
  if (scenario === "unchanged") pi.appendEntry("smoke-read", { content: execFileSync("bash", ["-c", "cat source.txt"], { encoding: "utf8" }) });
  if (scenario === "untracked") execFileSync("bash", ["-c", "echo created > shell-created.txt"]);
  if (scenario === "dirty" || scenario === "changing-check") execFileSync("bash", ["-c", "echo agent-edit >> source.txt"]);
  if (scenario === "after-pass") execFileSync("bash", ["-c", settlements === 1 ? "echo first >> source.txt" : "test $(wc -l < .smoke-runs) -eq 1 && echo second >> source.txt"]);
}); }
`);
  const after = join(temp, scenario, "after.mjs");
  await writeFile(after, `let settlements = 0;
export default function (pi) { pi.on("agent_before_settle", (event) => {
  settlements++;
  if (settlements === 1) return { entries: [...event.entries, { type: "custom_message", customType: "smoke-continue", content: "Reply done without tools.", display: true }], continue: true };
}); }
`);
  const pi = spawn(process.execPath, [cli, "--approve", "--no-tools", "--no-extensions", "-e", before, "-e", harness, ...(scenario === "after-pass" ? ["-e", after] : []), "--no-session", "--mode", "rpc"], { cwd: root, env: { ...env, PI_HARNESS_CONFIG: config }, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let pending = "", stderr = "";
  pi.stderr.on("data", (chunk) => { stderr += chunk; });
  pi.stdout.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      try { events.push(JSON.parse(pending.slice(0, index))); } catch { /* timeout reports missing events */ }
      pending = pending.slice(index + 1);
    }
  });
  try {
    pi.stdin.write(JSON.stringify({ id: "task", type: "prompt", message: "Reply done without using tools or editing files." }) + "\n");
    const deadline = Date.now() + 120_000;
    while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline && pi.exitCode === null) await new Promise((done) => setTimeout(done, 100));
    assert.ok(events.some((event) => event.id === "task" && event.success), `Prompt failed: ${stderr.slice(-1000)}`);
    assert.ok(events.some((event) => event.type === "agent_settled" && !event.aborted), `Pi did not settle: ${stderr.slice(-1000)}; ${JSON.stringify(events.slice(-5)).slice(-2000)}`);
    assert.equal(events.filter((event) => event.type === "agent_start").length, scenario === "after-pass" ? 2 : 1);
    const records = existsSync(evidenceDir) ? await Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8")))) : [];
    const attempts = records.filter((record) => record.kind === "attempt");
    const summaries = records.filter((record) => record.kind === "summary");
    const count = scenario === "unchanged" ? 0 : scenario === "after-pass" ? 2 : 1;
    const outcome = scenario === "unchanged" ? "not_applicable" : scenario === "changing-check" ? "error" : "passed";
    assert.equal(attempts.length, count, JSON.stringify(records));
    assert.equal(summaries.length, Math.max(1, count), JSON.stringify(records));
    assert.ok(attempts.every((record) => record.status === outcome && record.trigger === "automatic" && record.exitCode === 0), JSON.stringify(attempts));
    assert.ok(summaries.every((record) => record.finalOutcome === outcome), JSON.stringify(summaries));
    assert.ok(records.every((record) => record.acceptanceStatus === "not_evaluated" && record.executionId === summaries[0].executionId && record.taskId === summaries[0].taskId), JSON.stringify(records));
    assert.deepEqual(summaries.map((record) => record.attempts).sort(), count === 2 ? [1, 2] : [count]);
    assert.equal(existsSync(join(root, ".smoke-runs")) ? (await readFile(join(root, ".smoke-runs"), "utf8")).trim().split("\n").length : 0, count);
    if (scenario === "unchanged") assert.ok(events.some((event) => event.type === "entry_appended" && event.entry?.customType === "smoke-read" && event.entry.data.content === "committed\n"));
    if (scenario === "untracked") assert.match(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), /\?\? shell-created\.txt/);
    if (scenario === "dirty") assert.equal(await readFile(join(root, "source.txt"), "utf8"), "dirty baseline\nagent-edit\n");
    for (const summary of summaries.filter((record) => record.attempts > 0)) {
      const attempt = JSON.parse(await readFile(summary.lastEvidencePath, "utf8"));
      assert.equal(attempt.executionId, summary.executionId);
      assert.equal(attempt.status, summary.finalOutcome);
    }
    if (scenario === "after-pass") {
      assert.equal(await readFile(join(root, "source.txt"), "utf8"), "committed\nfirst\nsecond\n");
      assert.ok(attempts.every((record) => /^[0-9a-f]{64}$/.test(record.changeFingerprint)));
      assert.equal(new Set(attempts.map((record) => record.changeFingerprint)).size, 2);
      assert.equal(new Set(summaries.map((record) => record.lastEvidencePath)).size, 2);
    }
    if (scenario === "changing-check") assert.match(attempts[0].diagnostics, /Repository changed during verification/);
    console.log(`${scenario}: ${count} automatic attempts, ${outcome}`);
  } finally {
    pi.stdin.end();
    const timer = setTimeout(() => pi.kill(), 5000);
    if (pi.exitCode === null) await new Promise((done) => pi.once("close", done));
    clearTimeout(timer);
  }
}
