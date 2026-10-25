import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("config defaults off, explicit precedence, rejects unknown and invalid policies", async () => {
  assert.equal(loadConfig({}).automaticOnSettle, false);
  const dir = await mkdtemp(join(tmpdir(), "harness-config-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ automaticOnSettle: true, maxRepairContinuations: 1, verifyPath: "scripts/check" }));
  assert.equal(loadConfig({ PI_HARNESS_CONFIG: file }).maxRepairContinuations, 1);
  assert.equal(loadConfig({ PI_HARNESS_CONFIG: file, PI_HARNESS_AUTOMATIC: "0" }).automaticOnSettle, false);
  for (const invalid of [{ surprise: true }, { automaticOnSettle: "yes" }, { verifyPath: "../outside" }, { maxRepairContinuations: -1 }, { persistRawOutput: true }]) {
    await writeFile(file, JSON.stringify(invalid));
    assert.throws(() => loadConfig({ PI_HARNESS_CONFIG: file }));
  }
  assert.throws(() => loadConfig({ PI_HARNESS_AUTOMATIC: "yes" }));
});
