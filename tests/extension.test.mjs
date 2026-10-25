import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import engineeringHarness from "../src/extension.ts";
import { discoverProject, verify } from "../src/verification.ts";
import { writeEvidence } from "../src/evidence.ts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

async function fixture(script) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-"));
  const evidenceDir = join(root, "evidence");
  await mkdir(join(root, "scripts"));
  if (script) { await writeFile(join(root, "scripts", "verify"), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 }); }
  return { root, evidenceDir };
}

async function run(script, extras = {}) {
  const { root, evidenceDir } = await fixture(script);
  const result = await verify({ context: { executionId: "task-1", taskId: "task-1", agentId: "main", projectRoot: root, harnessVersion: "0.1.0" }, contractPath: "scripts/verify", trigger: "manual", evidenceDir, ...extras });
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
  assert.equal(evidence.status, result.status);
  assert.equal(evidence.acceptanceStatus, "not_evaluated");
  const schema = JSON.parse(await readFile(new URL("../schemas/evidence.schema.json", import.meta.url), "utf8"));
  const validate = addFormats(new Ajv2020()).compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(evidence.schemaVersion, schema.properties.schemaVersion.const);
  return { result, evidence };
}

test("evidence rejects invalid records before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invalid-evidence-"));
  await assert.rejects(() => writeEvidence({ kind: "attempt", status: "passed" }, dir), /Invalid evidence/);
});

test("three project-owned language contracts share the same verifier", async () => {
  for (const name of ["python-monolith", "react-app", "rust-wasm"]) {
    const root = resolve("fixtures", name);
    const result = await verify({ context: { executionId: name, taskId: name, agentId: "main", projectRoot: root, harnessVersion: "0.1.0" }, contractPath: "scripts/verify", trigger: "external", evidenceDir: false });
    assert.equal(result.status, "passed", `${name}: ${result.diagnostics}`);
  }
});

test("pass, fail, unavailable all produce evidence without acceptance", async () => {
  assert.equal((await run("echo ok")).result.exitCode, 0);
  assert.equal((await run("echo broken >&2; exit 3")).result.status, "failed");
  assert.equal((await run("echo broken >&2; exit 3")).result.exitCode, 3);
  assert.equal((await run()).result.status, "unavailable");
});

test("timeout, abort, truncated output and redaction", async () => {
  assert.equal((await run("sleep 2", { timeoutSeconds: 0.05 })).result.status, "error");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  assert.equal((await run("sleep 2", { signal: controller.signal })).result.status, "cancelled");
  const { result } = await run("echo token=supersecret; printf '%0500d' 1", { maxFeedbackCharacters: 80 });
  assert.equal(result.status, "passed");
  assert.match(result.diagnostics, /truncated/);
  const { evidence } = await run("echo token=supersecret");
  assert.doesNotMatch(JSON.stringify(evidence), /supersecret/);
});

test("nearest contract within boundary; never execute symlink outside project", async () => {
  const { root } = await fixture("exit 0");
  const nested = join(root, "src", "nested");
  await mkdir(nested, { recursive: true });
  assert.equal(await discoverProject(nested, root), root);
  assert.equal(await discoverProject(nested, nested), undefined);
  await assert.rejects(() => discoverProject(nested, root, "../verify"));
});

test("/verify reports a standalone result, rejects concurrent calls", async () => {
  const { root } = await fixture("sleep 0.1; echo ok");
  let handler;
  const notifications = [];
  engineeringHarness({ on: () => {}, registerCommand: (_name, command) => { handler = command.handler; } });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session" }, ui: { notify: (...args) => notifications.push(args) } };
  const pending = handler("", ctx);
  await handler("", ctx);
  await pending;
  assert.match(notifications[0][0], /already running/);
  assert.match(notifications[1][0], /passed/);
});
