import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  const unknown = newExecution();
  assert.equal(decide(unknown, result("failed"), undefined), "continue");
  assert.equal(decide(unknown, result("failed"), undefined), "continue");
  assert.equal(decide(unknown, result("failed"), undefined), "stop");
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

test("a check that changes the repository cannot persist a passed attempt", async () => {
  const oldConfig = process.env.PI_HARNESS_CONFIG;
  const oldAutomatic = process.env.PI_HARNESS_AUTOMATIC;
  try {
    const root = await mkdtemp(join(tmpdir(), "pi-changing-check-"));
    const evidenceDir = await mkdtemp(join(tmpdir(), "pi-changing-evidence-"));
    execFileSync("git", ["init", "-q", root]);
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "verify"), "#!/usr/bin/env bash\necho changed > source.txt\n", { mode: 0o755 });
    await writeFile(join(root, "source.txt"), "original");
    const configFile = join(evidenceDir, "harness.json");
    await writeFile(configFile, JSON.stringify({ evidenceDir }));
    process.env.PI_HARNESS_CONFIG = configFile;
    process.env.PI_HARNESS_AUTOMATIC = "1";
    const handlers = {};
    engineeringHarness({ on: (name, fn) => { handlers[name] = fn; }, appendEntry: () => {}, registerCommand: () => {} });
    const ctx = { cwd: root, sessionManager: { getSessionId: () => "session" }, ui: { notify: () => {} } };
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    await writeFile(join(root, "source.txt"), "agent edit");
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined);
    const records = await Promise.all((await readdir(evidenceDir)).filter((name) => name !== "harness.json").map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8"))));
    assert.equal(records.find((record) => record.kind === "attempt").status, "error");
    assert.equal(records.find((record) => record.kind === "summary").finalOutcome, "error");
    assert.ok(records.every((record) => record.acceptanceStatus === "not_evaluated"));
  } finally {
    if (oldConfig === undefined) delete process.env.PI_HARNESS_CONFIG;
    else process.env.PI_HARNESS_CONFIG = oldConfig;
    if (oldAutomatic === undefined) delete process.env.PI_HARNESS_AUTOMATIC;
    else process.env.PI_HARNESS_AUTOMATIC = oldAutomatic;
  }
});

test("resuming an unfinished automatic check records error, never success", async () => {
  const oldConfig = process.env.PI_HARNESS_CONFIG;
  const oldAutomatic = process.env.PI_HARNESS_AUTOMATIC;
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-recovery-"));
    const configFile = join(dir, "config.json");
    await writeFile(configFile, JSON.stringify({ evidenceDir: dir }));
    process.env.PI_HARNESS_CONFIG = configFile;
    process.env.PI_HARNESS_AUTOMATIC = "1";
    const pending = { ...newExecution("before"), verifying: true, attempts: 1 };
    const entries = [{ type: "custom", customType: "pi-engineering-harness-state", data: pending }];
    const handlers = {};
    engineeringHarness({ on: (name, fn) => { handlers[name] = fn; }, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), registerCommand: () => {} });
    const ctx = { cwd: dir, sessionManager: { getBranch: () => entries, getSessionId: () => "session" } };
    await handlers.session_start({}, ctx);
    const records = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "config.json").map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
    assert.equal(records.length, 1);
    assert.equal(records[0].executionId, pending.executionId);
    assert.equal(records[0].finalOutcome, "error");
    assert.equal(records[0].attempts, 1);
    assert.equal(records[0].acceptanceStatus, "not_evaluated");
    assert.equal(entries.at(-1).data.verifying, false);
    await handlers.session_start({}, ctx);
    assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 2); // config plus one summary
  } finally {
    if (oldConfig === undefined) delete process.env.PI_HARNESS_CONFIG;
    else process.env.PI_HARNESS_CONFIG = oldConfig;
    if (oldAutomatic === undefined) delete process.env.PI_HARNESS_AUTOMATIC;
    else process.env.PI_HARNESS_AUTOMATIC = oldAutomatic;
  }
});

test("recovery does not duplicate an error summary when state clearing is interrupted", async () => {
  const oldConfig = process.env.PI_HARNESS_CONFIG;
  const oldAutomatic = process.env.PI_HARNESS_AUTOMATIC;
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-recovery-idempotence-"));
    const configFile = join(dir, "config.json");
    await writeFile(configFile, JSON.stringify({ evidenceDir: dir }));
    process.env.PI_HARNESS_CONFIG = configFile;
    process.env.PI_HARNESS_AUTOMATIC = "1";
    const pending = { ...newExecution("before"), verifying: true, attempts: 1 };
    const entries = [{ type: "custom", customType: "pi-engineering-harness-state", data: pending }];
    const ctx = { cwd: dir, sessionManager: { getBranch: () => structuredClone(entries), getSessionId: () => "session" } };
    const interruptedHandlers = {};
    engineeringHarness({
      on: (name, fn) => { interruptedHandlers[name] = fn; },
      appendEntry: (customType, data) => {
        if (customType === "pi-engineering-harness-state" && !data.verifying && data.lastStatus === "error") throw new Error("simulated crash before marker clear");
        entries.push({ type: "custom", customType, data: structuredClone(data) });
      },
      registerCommand: () => {},
    });
    await assert.rejects(() => interruptedHandlers.session_start({}, ctx), /simulated crash/);
    let records = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "config.json").map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
    assert.equal(records.filter((record) => record.kind === "summary").length, 1);

    const resumedHandlers = {};
    engineeringHarness({ on: (name, fn) => { resumedHandlers[name] = fn; }, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), registerCommand: () => {} });
    await resumedHandlers.session_start({}, { ...ctx, cwd: await mkdtemp(join(tmpdir(), "pi-recovery-moved-cwd-")) });
    records = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "config.json").map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
    const summaries = records.filter((record) => record.kind === "summary");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].executionId, pending.executionId);
    assert.equal(summaries[0].finalOutcome, "error");
    assert.equal(summaries[0].attempts, 1);
    assert.equal(summaries[0].acceptanceStatus, "not_evaluated");
    assert.equal(entries.at(-1).data.verifying, false);
    assert.equal(entries.at(-1).data.lastStatus, "error");
  } finally {
    if (oldConfig === undefined) delete process.env.PI_HARNESS_CONFIG;
    else process.env.PI_HARNESS_CONFIG = oldConfig;
    if (oldAutomatic === undefined) delete process.env.PI_HARNESS_AUTOMATIC;
    else process.env.PI_HARNESS_AUTOMATIC = oldAutomatic;
  }
});

test("opt-in settlement checks changed state, continues once, then passes and rechecks further edits", async () => {
  const old = process.env.PI_HARNESS_AUTOMATIC;
  const oldConfig = process.env.PI_HARNESS_CONFIG;
  process.env.PI_HARNESS_AUTOMATIC = "1";
  try {
    const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
    execFileSync("git", ["init", "-q", root]);
    const evidenceDir = await mkdtemp(join(tmpdir(), "pi-summary-"));
    const configFile = join(evidenceDir, "harness.json");
    await writeFile(configFile, JSON.stringify({ evidenceDir }));
    process.env.PI_HARNESS_CONFIG = configFile;
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "verify"), "#!/usr/bin/env bash\ngrep -q fixed source.txt\n", { mode: 0o755 });
    await writeFile(join(root, "source.txt"), "original");
    const handlers = {};
    const commands = {};
    const entries = [];
    const notices = [];
    const messages = [];
    engineeringHarness({ on: (name, fn) => { handlers[name] = name === "agent_before_settle" ? (event, ctx) => fn({ ...event, entries: [{ type: "custom", customType: "another-extension" }], context: { canContinue: true } }, ctx) : fn; }, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), registerCommand: (name, command) => { commands[name] = command.handler; }, sendUserMessage: (message) => messages.push(message) });
    const ctx = { cwd: root, sessionManager: { getBranch: () => entries, getSessionId: () => "session" }, ui: { notify: (...message) => notices.push(message) } };
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    assert.equal(await handlers.agent_before_settle({ outcome: "completed" }, ctx), undefined);
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    await writeFile(join(root, "source.txt"), "broken");
    const first = await handlers.agent_before_settle({ outcome: "completed" }, ctx);
    assert.equal(first.continue, true);
    assert.equal(first.entries[0].customType, "another-extension");
    assert.match(first.entries[1].content, /untrusted data/);
    await handlers.agent_settled({ aborted: false }, ctx); // Later handler suppressed continuation.
    assert.ok((await Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8")))))
      .some((record) => record.kind === "summary" && record.finalOutcome === "failed" && record.repairContinuations === 1));
    await handlers.session_shutdown({}, ctx);
    await handlers.session_start({ reason: "resume" }, ctx);
    await commands["resume-repair"]("", ctx);
    assert.match(messages.at(-1), /Continue the previous/);
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    assert.equal(entries.at(-1).data.repairContinuations, 1);
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
    await commands["resume-repair"]("", ctx);
    assert.match(messages.at(-1), /Continue the previous/);
    await handlers.before_agent_start({ messageType: "user" }, ctx); // explicitly resumed repair keeps its budget
    assert.equal(entries.at(-1).data.repairContinuations, 2);
    await handlers.before_agent_start({ messageType: "user" }, ctx); // genuinely new task resets it
    assert.equal(entries.at(-1).data.repairContinuations, 0);
    await handlers.session_shutdown({}, ctx);
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ messageType: "user" }, ctx); // resumed session, new task by default
    assert.equal(entries.at(-1).data.repairContinuations, 0);
    await handlers.agent_settled({ aborted: true }, ctx); // interrupted before settlement
    await handlers.agent_settled({ aborted: true }, ctx); // no duplicate summary
    const summaries = await Promise.all((await readdir(evidenceDir)).map(async (name) => JSON.parse(await readFile(join(evidenceDir, name), "utf8"))));
    assert.ok(summaries.some((record) => record.kind === "summary" && record.finalOutcome === "failed" && record.repairContinuations === 2));
    assert.ok(summaries.some((record) => record.kind === "summary" && record.finalOutcome === "passed"));
    assert.equal(summaries.filter((record) => record.kind === "summary" && record.finalOutcome === "cancelled" && record.attempts === 0).length, 1);
  } finally {
    if (oldConfig === undefined) delete process.env.PI_HARNESS_CONFIG;
    else process.env.PI_HARNESS_CONFIG = oldConfig;
    if (old === undefined) delete process.env.PI_HARNESS_AUTOMATIC;
    else process.env.PI_HARNESS_AUTOMATIC = old;
  }
});
