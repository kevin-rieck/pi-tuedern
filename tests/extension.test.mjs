import assert from "node:assert/strict";
import { test } from "node:test";
import engineeringHarness from "../src/extension.ts";

test("/verify cannot claim success before the verifier exists", async () => {
  let command;
  let notification;
  engineeringHarness({ registerCommand: (name, options) => { command = { name, ...options }; } });
  assert.equal(command.name, "verify");
  await command.handler("", { ui: { notify: (message, level) => { notification = { message, level }; } } });
  assert.equal(notification.level, "warning");
  assert.match(notification.message, /not implemented/);
});
