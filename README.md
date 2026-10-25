# Pi Engineering Harness (v0.1)

Standalone verification for trusted Pi projects. `/verify` runs a project's `scripts/verify` and records a result; it does **not** assess product acceptance or initiate repairs. Automatic settlement and repair (PRD v0.2), orchestrator integration and profiles (v0.3) are not implemented.

## Install / run

Node >=22.19, Pi 1.4.0 (the typechecked host version), and a trusted project are required. From this repository:

```sh
npm ci
npm run verify
pi -e .                        # local smoke test; enter /verify in Pi
```

From a trusted project use `pi install --local /absolute/path/to/pi-engineering-harness`, or pin a published source via `pi install --local npm:pi-engineering-harness@0.1.0` when published. This repository is currently private: there is no published pinned source. For a distributable tarball inspect `npm pack --dry-run`; do not treat an unpinned branch as a release. Pi supplies the host SDK at runtime. CI should separately run the exact same `./scripts/verify` without Pi.

## Project contract and trust

Create an executable, noninteractive `scripts/verify` in the trusted project root. It must exit 0 only after all required checks pass and otherwise exit nonzero with diagnostics on stdout/stderr. Run it from the root; document its own dependencies (Python tools, npm installation, Rust target etc.). It must not deploy, publish, or mutate source files. **Review the script before invoking `/verify`**: extensions and scripts run with your OS privileges; this is not a sandbox. Protect the script and CI policy independently.

By default `/verify` only looks in Pi's current working directory (the search boundary), not in arbitrary ancestors. To work from nested directories, set `PI_HARNESS_SEARCH_ROOT` to the trusted repository boundary before starting Pi; the nearest script up to that directory is selected. `PI_HARNESS_PROJECT_ROOT` selects an exact trusted root inside the same boundary (no upward search). Symlinks escaping the root are rejected. In nested repos the nearest contract wins. A missing script is `unavailable`, never `passed`. Duplicate `/verify` calls are refused while one is active. Pi commands are user-invoked, so project trust and choice of root remain the operator's responsibility; do not allow untrusted code to invoke verification.

The verifier is independently importable from `src/verification.ts`: `verify({context, contractPath: "scripts/verify", trigger: "external"})`. Pass an explicit `ExecutionContext` and optionally `signal`, `timeoutSeconds`, `maxFeedbackCharacters`, or `evidenceDir: false`. Default timeout is 300 seconds; feedback retains the last 12000 characters of combined stdout/stderr. On Windows, Bash must be on PATH for the script; on Unix the script must be executable. No arbitrary text is interpolated into a shell command.

Each run writes a restricted-permission JSON record outside the repo at `~/.pi/engineering-harness/evidence/<timestamp>-<uuid>.json` (override `evidenceDir` in library calls). Records include schemaVersion 1.0, command, result, identifiers, duration, attempt, and a hash of the root path; diagnostics are bounded and common token patterns redacted. Raw output and environment variables are not persisted. Regex redaction is **best effort**, not safe for secrets: do not print credentials in verification scripts. Evidence creation failure produces `error`, not a false success. `acceptanceStatus` is always `not_evaluated`.

## Status

PRD milestones M0/M1 are partial: standalone execution, unit tests and manual command are implemented. Lifecycle spike, three real language fixture projects, clean pinned-package install, and v0.2 repair controller remain to be completed before claiming the PRD's release gates. Pi versions other than 1.4.0 are untested.
