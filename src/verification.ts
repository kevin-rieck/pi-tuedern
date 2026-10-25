import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeEvidence } from "./evidence.ts";
import { performance } from "node:perf_hooks";
import pkg from "../package.json" with { type: "json" }; 

export type VerificationStatus = "passed" | "failed" | "error" | "unavailable" | "cancelled" | "not_applicable";
export type AcceptanceStatus = "accepted" | "rejected" | "not_evaluated";
export interface ExecutionContext {
  executionId: string;
  taskId: string;
  parentTaskId?: string;
  agentId: string;
  projectRoot: string;
  worktree?: string;
  harnessVersion: string;
  sessionId?: string;
}
export interface VerificationRequest {
  context: ExecutionContext;
  contractPath: string;
  trigger: "manual" | "automatic" | "external";
  level?: "full";
  signal?: AbortSignal;
  timeoutSeconds?: number;
  maxFeedbackCharacters?: number;
  evidenceDir?: string | false;
  attempt?: number;
  repairContinuations?: number;
  changeFingerprint?: string;
}
export interface VerificationResult {
  status: VerificationStatus;
  acceptanceStatus: "not_evaluated";
  exitCode?: number;
  durationMs: number;
  evidencePath?: string;
  diagnostics: string;
  command: string;
}

// Only scan beneath a caller-chosen boundary. An explicit root does not search ancestors.
export async function discoverProject(start: string, boundary: string, contractPath = "scripts/verify", explicitRoot?: string): Promise<string | undefined> {
  if (isAbsolute(contractPath) || contractPath.split(/[\\/]/).includes("..")) throw new Error("Contract path must remain inside the project");
  const limit = await realpath(boundary);
  let current = await realpath(explicitRoot ?? start);
  if (relative(limit, current).startsWith("..") || isAbsolute(relative(limit, current))) throw new Error("Project lies outside search boundary");
  while (true) {
    try {
      const path = await realpath(join(current, contractPath));
      if (relative(current, path).startsWith("..") || isAbsolute(relative(current, path))) throw new Error("Contract escapes project root");
      if ((await stat(path)).isFile()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (explicitRoot || current === limit) return undefined;
    current = dirname(current);
  }
}

const redact = (text: string) => text.replace(/(authorization:\s*bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s"']+)/gi, "$1[REDACTED]");

export async function verify(request: VerificationRequest): Promise<VerificationResult> {
  const { context, contractPath } = request;
  const started = performance.now();
  const cap = request.maxFeedbackCharacters ?? 12000;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid feedback limit");
  if (isAbsolute(contractPath) || contractPath.split(/[\\/]/).includes("..")) throw new Error("Contract path must remain inside the project");
  const command = `./${contractPath.replaceAll("\\", "/")}`;
  let status: VerificationStatus = "error";
  let exitCode: number | undefined;
  let output = "";
  let truncated = false;
  const append = (chunk: Buffer) => {
    const text = redact(chunk.toString("utf8"));
    output += text;
    if (output.length > cap) { output = output.slice(-cap); truncated = true; }
  };
  try {
    const root = await realpath(context.projectRoot);
    const target = join(root, contractPath);
    let script: string;
    try { script = await realpath(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      status = "unavailable";
      output = `Missing ${command}. Add a noninteractive executable script at the project root.`;
      script = "";
    }
    if (script) {
      const rel = relative(root, script);
      if (rel.startsWith("..") || isAbsolute(rel) || !(await stat(script)).isFile()) throw new Error("Contract escapes project root or is not a file");
      if (request.signal?.aborted) status = "cancelled";
      else {
        const timeout = request.timeoutSeconds ?? 300;
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout");
        const child = process.platform === "win32"
          ? spawn("bash", [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
          : spawn(script, [], { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
        let timedOut = false;
        const kill = () => {
          if (process.platform === "win32" && child.pid) {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
            killer.on("error", () => child.kill());
            killer.on("close", (code) => { if (code !== 0) child.kill(); });
          } else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
        }; 
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
        const abort = () => kill();
        request.signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        try {
          const outcome = await new Promise<{ code: number | null; error?: Error }>((done) => {
            child.once("error", (error) => done({ code: null, error }));
            child.once("close", (code) => done({ code }));
          });
          exitCode = outcome.code ?? undefined;
          status = request.signal?.aborted ? "cancelled" : timedOut ? "error" : outcome.error ? "error" : exitCode === 0 ? "passed" : "failed";
          if (outcome.error) output += `\nProcess error: ${outcome.error.message}`;
          if (timedOut) output += "\nVerification timed out";
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", abort);
        }
      }
    }
  } catch (error) {
    output += `\nVerification error: ${(error as Error).message}`;
  }
  const marker = "[output truncated; showing tail]\n";
  const diagnostics = truncated ? (marker + output).slice(0, marker.length) + output.slice(-Math.max(0, cap - marker.length)) : output;
  const result: VerificationResult = {
    status, acceptanceStatus: "not_evaluated", exitCode,
    durationMs: Math.round(performance.now() - started),
    diagnostics: redact(diagnostics).slice(0, cap),
    command,
  };
  if (request.evidenceDir !== false) {
    try {
      result.evidencePath = await writeEvidence({
        kind: "attempt", schemaVersion: "1.0", harnessVersion: pkg.version, executionId: context.executionId,
        taskId: context.taskId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), agentId: context.agentId,
        projectRootId: createHash("sha256").update(resolve(context.projectRoot)).digest("hex"),
        timestamp: new Date().toISOString(), trigger: request.trigger, scriptPath: contractPath,
        attempt: request.attempt ?? 1, repairContinuations: request.repairContinuations ?? 0,
        ...(request.changeFingerprint ? { changeFingerprint: request.changeFingerprint } : {}),
        status: result.status, acceptanceStatus: result.acceptanceStatus,
        ...(exitCode !== undefined ? { exitCode } : {}), durationMs: result.durationMs,
        diagnostics: result.diagnostics, command: result.command,
      }, request.evidenceDir || undefined);
    } catch (error) {
      result.status = "error";
      result.diagnostics += `\nEvidence error: ${(error as Error).message}`;
    }
  }
  return result;
}
