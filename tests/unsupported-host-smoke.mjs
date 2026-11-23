import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [cliArg, version] = process.argv.slice(2);
assert.ok(cliArg && version, "Pass the real Pi CLI path and expected unsupported version");
const cli = resolve(cliArg);
const temp = mkdtempSync(join(tmpdir(), "pi-unsupported-host-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), PI_OFFLINE: "1" };
delete env.PI_PACKAGE_DIR;
assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), version);
execFileSync(process.execPath, [cli, "install", process.cwd()], { env, stdio: "pipe" });
const result = spawnSync(process.execPath, [cli, "--approve", "--mode", "rpc"], {
  cwd: resolve("fixtures/react-app"), env, encoding: "utf8", timeout: 45000,
  input: JSON.stringify({ id: "commands", type: "get_commands" }) + "\n",
});
assert.ifError(result.error);
assert.notEqual(result.status, 0, `Pi ${version} unexpectedly loaded the harness: ${result.stdout}`);
assert.ok(result.stderr.includes(`Unsupported Pi host ${version}; pi-engineering-harness requires Pi 1.4.0`), result.stderr);
assert.ok(!result.stdout.includes('"name":"verify"'), result.stdout);
console.log(`Real Pi ${version} rejects the installed harness; artifacts: ${temp}`);
