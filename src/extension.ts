import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function engineeringHarness(pi: ExtensionAPI): void {
  pi.registerCommand("verify", {
    description: "Verify the current project (not implemented yet)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Verification is not implemented yet; run your project's scripts/verify directly.", "warning");
    },
  });
}
