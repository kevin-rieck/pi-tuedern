// npm peer-resolution smoke, not a Pi runtime compatibility check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "pi-harness-compat-"));
const npm = (args, cwd = process.cwd()) => spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
const packed = npm(["pack", "--pack-destination", temp, "--json"]);
assert.equal(packed.status, 0, packed.stderr);
const tarball = join(temp, JSON.parse(packed.stdout)[0].filename);
for (const version of ["1.3.0", "1.5.0"]) {
  const root = join(temp, version), host = join(root, "host"), app = join(root, "app");
  mkdirSync(host, { recursive: true });
  mkdirSync(app);
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  writeFileSync(join(app, "package.json"), JSON.stringify({ private: true, dependencies: { "pi-engineering-harness": `file:${tarball}`, "@earendil-works/pi-coding-agent": `file:${host}` } }));
  const result = npm(["install", "--offline", "--strict-peer-deps", "--ignore-scripts"], app);
  assert.notEqual(result.status, 0, `Unexpectedly accepted Pi ${version}`);
  assert.match(result.stderr, /ERESOLVE[\s\S]*peer @earendil-works\/pi-coding-agent@"1\.4\.0"/);
}
console.log("npm strict peer resolution rejects Pi 1.3.0 and 1.5.0; Pi runtime itself does not enforce peers");
