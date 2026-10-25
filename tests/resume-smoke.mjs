// Authenticated Pi 1.4.0 smoke: node tests/resume-smoke.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "pi-resume-smoke-"));
const root = join(temp, "project");
await mkdir(join(root, "scripts"), { recursive: true });
execFileSync("git", ["init", "-q", root]);
await writeFile(join(root, "scripts", "verify"), "#!/usr/bin/env bash\necho deliberate failure >&2\nexit 1\n", { mode: 0o755 });
await writeFile(join(root, "source.txt"), "original\n");
const evidenceDir = join(temp, "evidence");
const config = join(temp, "config.json");
await writeFile(config, JSON.stringify({ automaticOnSettle: true, evidenceDir }));
const before = join(temp, "before.mjs");
// Only for the smoke: force an actual worktree edit before each settlement so both repairs reverify.
await writeFile(before, `import { appendFileSync } from "node:fs";
export default function (pi) { pi.on("agent_before_settle", () => { appendFileSync("source.txt", "repair attempt\\n"); }); }
`);
const after = join(temp, "after.mjs");
await writeFile(after, `export default function (pi) { pi.on("agent_before_settle", () => ({ entries: [], continue: false })); }
`);
const sessionId = "11111111-1111-4111-8111-111111111111";
const env = { ...process.env, PI_HARNESS_CONFIG: config, PI_OFFLINE: "1" };
const cli = process.platform === "win32" ? "pi.cmd" : "pi";
const harness = resolve("src/extension.ts");
const records = async () => Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8"))));

async function run(resume, suppress, messages) {
  const args = ["--approve", "--no-tools", "--no-extensions", "-e", before, "-e", harness, ...(suppress ? ["-e", after] : []), "--session-dir", join(temp, "sessions"), "--session-id", sessionId, "--mode", "rpc"];
  const pi = spawn(cli, args, { cwd: root, env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  let pending = "";
  let stderr = "";
  const events = [];
  pi.stderr.on("data", (chunk) => { stderr += chunk; });
  pi.stdout.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      try { events.push(JSON.parse(pending.slice(0, index))); } catch { /* ignore malformed output */ }
      pending = pending.slice(index + 1);
    }
  });
  const deadline = Date.now() + 120_000;
  const send = (id, message) => pi.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
  const wait = async (predicate) => {
    while (!predicate() && Date.now() < deadline && pi.exitCode === null) await new Promise((done) => setTimeout(done, 100));
    assert.ok(predicate(), `Pi RPC timed out/exited: ${stderr.slice(-1500)}; recent events: ${JSON.stringify(events.slice(-5)).slice(-1500)}`);
  };
  try {
    if (resume) {
      send("resume", "/resume-repair");
      await wait(() => events.some((e) => e.id === "resume"));
      assert.ok(events.some((e) => e.id === "resume" && e.success && e.data?.disposition === "handled"));
      await wait(() => events.some((e) => e.type === "agent_settled"));
      assert.equal(events.filter((e) => e.type === "entry_appended" && e.entry?.customType === "pi-engineering-harness-feedback").length, 1, "only one remaining repair continuation");
    }
    for (const [index, message] of messages.entries()) {
      const settled = events.filter((e) => e.type === "agent_settled").length;
      send(`task-${index}`, message);
      await wait(() => events.some((e) => e.id === `task-${index}`));
      await wait(() => events.filter((e) => e.type === "agent_settled").length > settled);
    }
    return events;
  } finally {
    pi.stdin.end();
    await Promise.race([new Promise((done) => pi.once("close", done)), new Promise((done) => setTimeout(() => { pi.kill(); done(); }, 5000))]);
  }
}

const prompt = "Reply done. Do not use tools or edit files.";
const first = await run(false, true, [prompt]);
let attempts = (await records()).filter((r) => r.kind === "attempt");
assert.equal(attempts.length, 1, JSON.stringify(attempts));
assert.equal(attempts[0].status, "failed");
assert.equal(attempts[0].repairContinuations, 0);
assert.equal(first.filter((e) => e.type === "entry_appended" && e.entry?.customType === "pi-engineering-harness-feedback").length, 0, "later handler discarded feedback");
const second = await run(true, false, ["This is a genuinely new task. Reply done without tools."]);
attempts = (await records()).filter((r) => r.kind === "attempt");
const resumed = attempts.filter((r) => r.executionId === attempts[0].executionId);
assert.equal(resumed.length, 3, JSON.stringify(attempts));
assert.deepEqual(resumed.map((r) => r.repairContinuations).sort(), [0, 1, 2]);
assert.ok((await records()).some((r) => r.kind === "summary" && r.executionId === resumed[0].executionId && r.finalOutcome === "failed" && r.repairContinuations === 2));
assert.ok(attempts.some((r) => r.executionId !== resumed[0].executionId && r.repairContinuations === 0), "new user task must reset the budget");
assert.ok(second.some((e) => e.type === "agent_settled"));
console.log("Real Pi resume retained one repair; exhausted after two, new task reset; later handler suppressed initial feedback");
