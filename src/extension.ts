import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverProject, verify } from "./verification.ts";
import pkg from "../package.json" with { type: "json" };

export default function engineeringHarness(pi: ExtensionAPI): void {
  let running = false;
  let active: AbortController | undefined;
  pi.on("session_shutdown", () => { active?.abort(); });
  pi.registerCommand("verify", {
    description: "Run the trusted project's scripts/verify (no automatic repair)",
    handler: async (_args, ctx) => {
      if (running) { ctx.ui.notify("Verification already running", "warning"); return; }
      running = true;
      active = new AbortController();
      const abort = () => active?.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      try {
        const cwd = ctx.cwd;
        const root = await discoverProject(cwd, process.env.PI_HARNESS_SEARCH_ROOT ?? cwd, "scripts/verify", process.env.PI_HARNESS_PROJECT_ROOT);
        const result = await verify({
          context: { executionId: randomUUID(), taskId: randomUUID(), agentId: "main", projectRoot: root ?? cwd, harnessVersion: pkg.version, sessionId: ctx.sessionManager?.getSessionId() },
          contractPath: "scripts/verify", trigger: "manual", signal: active.signal,
        });
        ctx.ui.notify(`${result.status} (${result.durationMs}ms) ${result.command}\n${result.diagnostics}\nEvidence: ${result.evidencePath ?? "unavailable"}`, result.status === "passed" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Verification error: ${(error as Error).message}`, "error");
      } finally { ctx.signal?.removeEventListener("abort", abort); active = undefined; running = false; }
    },
  });
}
