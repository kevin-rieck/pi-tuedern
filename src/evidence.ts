import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import attemptSchema from "../schemas/evidence.schema.json" with { type: "json" };
import summarySchema from "../schemas/summary.schema.json" with { type: "json" };

const ajv = addFormats.default(new Ajv2020({ allErrors: true }));
const validateAttempt = ajv.compile(attemptSchema);
const validateSummary = ajv.compile(summarySchema);

export async function hasEquivalentEvidence(record: Record<string, unknown>, dir = join(homedir(), ".pi", "engineering-harness", "evidence")): Promise<boolean> {
  const validate = record.kind === "summary" ? validateSummary : validateAttempt;
  if (!validate(record)) throw new Error(`Invalid evidence: ${ajv.errorsText(validate.errors)}`);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Recovery identity comes from persisted execution state; cwd/session metadata may change on resume.
  const fields = ["schemaVersion", "harnessVersion", "executionId", "taskId", "agentId", "finalOutcome", "acceptanceStatus", "attempts", "repairContinuations"];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let existing: unknown;
    try { existing = JSON.parse(await readFile(join(dir, entry.name), "utf8")); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (!validate(existing)) continue;
    const candidate = existing as Record<string, unknown>;
    if (fields.every((key) => candidate[key] === record[key])) return true;
  }
  return false;
}

export async function writeEvidence(record: Record<string, unknown>, dir = join(homedir(), ".pi", "engineering-harness", "evidence")): Promise<string> {
  const validate = record.kind === "summary" ? validateSummary : validateAttempt;
  if (!validate(record)) throw new Error(`Invalid evidence: ${ajv.errorsText(validate.errors)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${Date.now()}-${randomUUID()}.json`);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2)); }
  finally { await file.close(); }
  return path;
}
