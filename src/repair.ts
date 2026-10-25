import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import type { VerificationResult } from "./verification.ts";

export interface RepairState {
  executionId: string;
  taskId: string;
  baseline?: string;
  lastFingerprint?: string;
  lastStatus?: VerificationResult["status"];
  repairContinuations: number;
  attempts?: number;
  verifying?: boolean;
  lastEvidencePath?: string;
}

export function newExecution(baseline?: string): RepairState {
  return { executionId: randomUUID(), taskId: randomUUID(), baseline, repairContinuations: 0 };
}

// A dirty tracked file is hashed, not merely listed as modified. Ignored build artifacts stay out.
// ponytail: full-tree hashing is O(repository size); add incremental snapshots only if measured cost warrants it.
export async function fingerprint(root: string): Promise<string> {
  const files = await new Promise<Buffer>((done, fail) => {
    const git = spawn("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    git.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8_000_000) git.kill(); else chunks.push(chunk); });
    git.on("error", fail);
    git.on("close", (code) => code === 0 ? done(Buffer.concat(chunks)) : fail(new Error("Cannot inspect repository state")));
  });
  const hash = createHash("sha256");
  for (const name of files.toString("utf8").split("\0").filter(Boolean).sort()) {
    const path = join(root, name);
    if (relative(root, path).startsWith("..")) throw new Error("File escapes project root");
    hash.update(name).update("\0");
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) { hash.update("symlink").update(await readlink(path)); continue; }
      if (!info.isFile()) { hash.update("non-file"); continue; }
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update("deleted");
      else throw error;
    }
  }
  return hash.digest("hex");
}

export function decide(state: RepairState, result: VerificationResult, fingerprintNow: string | undefined, maxRepairs = 2): "continue" | "stop" {
  const changedSinceFailure = !fingerprintNow || state.lastFingerprint !== fingerprintNow;
  state.lastStatus = result.status;
  state.lastFingerprint = fingerprintNow;
  if (result.status !== "failed" || state.repairContinuations >= maxRepairs || (state.repairContinuations > 0 && !changedSinceFailure)) return "stop";
  state.repairContinuations++;
  return "continue";
}
