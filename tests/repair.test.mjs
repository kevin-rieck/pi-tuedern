import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, fingerprint, newExecution } from "../src/repair.ts";
import engineeringHarness from "../src/extension.ts";

const result = (status) => ({ status, acceptanceStatus: "not_evaluated", diagnostics: "broken", command: "./scripts/verify", exitCode: 1, durationMs: 1 });

test("two repair continuations per execution, no-change stops, new task resets", () => {
  const state = newExecution("before");
  assert.equal(decide(state, result("failed"), "change"), "continue");
  assert.equal(decide(state, result("failed"), "change"), "stop");
  assert.equal(state.repairContinuations, 1);
  assert.equal(decide(state, result("failed"), "another"), "continue");
  assert.equal(decide(state, result("failed"), "third"), "stop");
  assert.equal(newExecution("before").repairContinuations, 0);
});

test("snapshot catches dirty tracked edits and shell-created untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repair-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "file.txt"), "preexisting dirty work");
  const before = await fingerprint(root);
  assert.equal(await fingerprint(root), before);
  await writeFile(join(root, "file.txt"), "changed existing dirty file");
  assert.notEqual(await fingerprint(root), before);
  const next = await fingerprint(root);
  execFileSync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", "echo new > new.txt"] : ["-c", "echo new > new.txt"], { cwd: root });
  assert.notEqual(await fingerprint(root), next);
});

test("opt-in settlement checks changed state, continues once, then passes and rechecks further edits", async () => {
  const old = process.env.PI_HARNESS_AUTOMATIC;
  process.env.PI_HARNESS_AUTOMATIC = "1";
  try {
    const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
    execFileSync("git", ["init", "-q", root]);
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "verify"), "#!/usr/bin/env bash\ngrep -q fixed source.txt\n", { mode: 0o755 });
    await writeFile(join(root, "source.txt"), "original");
    const handlers = {};
    const entries = [];
    const notices = [];
    engineeringHarness({ on: (name, fn) => { handlers[name] = name === "agent_before_settle" ? (event, ctx) => fn({ ...event, entries: [{ type: "custom", customType: "another-extension" }], context: { canContinue: true } }, ctx) : fn; }, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), registerCommand: () => {} });
    const ctx = { cwd: root, sessionManager: { getBranch: () => entries, getSessionId: () => "session" }, ui: { notify: (...message) => notices.push(message) } };
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined);
    await writeFile(join(root, "source.txt"), "broken");
    const first = await handlers.agent_before_settle({ outcome: "completed" }, ctx);
    assert.equal(first.continue, true);
    assert.equal(first.entries[0].customType, "another-extension");
    assert.match(first.entries[1].content, /untrusted data/);
    await writeFile(join(root, "source.txt"), "fixed");
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined);
    assert.match(notices.at(-1)[0], /passed/);
    await writeFile(join(root, "source.txt"), "broken again");
    const retry = await handlers.agent_before_settle({ outcome: "completed" }, ctx);
    assert.equal(retry.continue, true);
    assert.equal(entries.at(-1).data.repairContinuations, 2);
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined); // no new edit, no loop
    await writeFile(join(root, "source.txt"), "still broken");
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined); // exhausted
    assert.equal(entries.at(-1).data.repairContinuations, 2);
    await handlers.session_shutdown({}, ctx);
    await handlers.session_start({}, ctx); // restore the same execution from session entries
    assert.equal(entries.at(-1).data.repairContinuations, 2);
    await handlers.before_agent_start({ messageType: "user" }, ctx); // first prompt after resume keeps unfinished execution
    assert.equal(entries.at(-1).data.repairContinuations, 2);
    await handlers.before_agent_start({ messageType: "user" }, ctx); // next prompt is a new task
    assert.equal(entries.at(-1).data.repairContinuations, 0);
  } finally {
    if (old === undefined) delete process.env.PI_HARNESS_AUTOMATIC;
    else process.env.PI_HARNESS_AUTOMATIC = old;
  }
});
