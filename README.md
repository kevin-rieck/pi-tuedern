# Pi Engineering Harness (v0.1)

Standalone verification for trusted Pi projects. `/verify` runs a project's `scripts/verify` and records a result; it does **not** assess product acceptance or initiate repairs. An experimental, opt-in settlement gate with bounded repair is available; orchestrator integration and profiles (v0.3) are not implemented.

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

By default `/verify` only looks in Pi's current working directory (the search boundary), not in arbitrary ancestors. To work from nested directories, set `PI_HARNESS_SEARCH_ROOT` to the trusted repository boundary before starting Pi; the nearest script up to that directory is selected. `PI_HARNESS_PROJECT_ROOT` selects an exact trusted root inside the same boundary (no upward search). Symlinks escaping the root are rejected. In nested repos the nearest contract wins. A missing script is `unavailable`, never `passed`. Duplicate `/verify` calls are refused while one is active. `/verify-cancel` explicitly cancels a running manual or automatic verification. Pi commands are user-invoked, so project trust and choice of root remain the operator's responsibility; do not allow untrusted code to invoke verification.

The verifier is independently importable from `src/verification.ts`: `verify({context, contractPath: "scripts/verify", trigger: "external"})`. Pass an explicit `ExecutionContext` and optionally `signal`, `timeoutSeconds`, `maxFeedbackCharacters`, or `evidenceDir: false`. Default timeout is 300 seconds; feedback retains the last 12000 characters of combined stdout/stderr. On Windows, Bash must be on PATH for the script; on Unix the script must be executable. No arbitrary text is interpolated into a shell command.

Each run writes a restricted-permission JSON record outside the repo at `~/.pi/engineering-harness/evidence/<timestamp>-<uuid>.json` (override `evidenceDir` in library calls). Attempts follow `schemas/evidence.schema.json` and terminal task summaries follow `schemas/summary.schema.json` (schemaVersion 1.0); both are validated before writing. Summaries include final verification outcome, attempt count and repair continuations, not product acceptance. Records include command, result, identifiers, duration, attempt, and a hash of the root path; diagnostics are bounded and common token patterns redacted. Raw output and environment variables are not persisted. Regex redaction is **best effort**, not safe for secrets: do not print credentials in verification scripts. Evidence creation failure produces `error`, not a false success. `acceptanceStatus` is always `not_evaluated`.

## Configuration

Defaults enable only manual `/verify`. To opt in, set `PI_HARNESS_CONFIG` to an absolute path to a trusted JSON file **before starting Pi**, for example:

```json
{"automaticOnSettle": true, "maxRepairContinuations": 2, "timeoutSeconds": 300}
```

Supported keys: `enabled` (default true), `verifyPath` (`scripts/verify`, relative inside the project), `automaticOnSettle` (false), `maxRepairContinuations` (2), `timeoutSeconds` (300), `maxFeedbackCharacters` (12000), `recordEvidence` (true), `evidenceDir` (default `~/.pi/engineering-harness/evidence`), `searchRoot` (default Pi cwd), and `projectRoot` (optional exact root). `persistRawOutput` must be false, `onMissingContract` must be `report-unavailable`, and `onChangeDetectionError` must be `verify`; other values/policies are not implemented. Unknown keys, wrong types, unsafe contract paths, malformed or missing files fail extension loading rather than silently disabling checks. Only this explicitly selected file is read; no untrusted repo configuration is loaded automatically. Legacy environment overrides `PI_HARNESS_AUTOMATIC=0|1`, `PI_HARNESS_SEARCH_ROOT`, and `PI_HARNESS_PROJECT_ROOT` take precedence over the file, which takes precedence over defaults. `enabled: false` unregisters both command and hook.

## Experimental automatic verification (not enabled by default)

Set `automaticOnSettle: true` or `PI_HARNESS_AUTOMATIC=1` **before starting Pi** in a trusted project, with Git available. A new user prompt snapshots tracked and untracked nonignored files. At `agent_before_settle`, any new/unknown state runs the same verifier; a failed check may ask for at most two repair continuations. With no changes it reports `not_applicable` in session state; a passed result is reused only while the snapshot remains the same. A failed repair with no edits stops. State is persisted as Pi session custom entries for resume. Every ordinary new user prompt starts a new execution, including the first prompt after resuming a session. Use `/resume-repair` to explicitly continue an interrupted failed repair using its remaining budget; do not use it for a new task. Pi 1.4.0 chains settlement handlers in registration order: each sees earlier entries/continuation, but the last handler explicitly returning `continue` can override the decision or replace entries. A competing handler registered after this harness can suppress feedback/repair; this is not a hard completion barrier. Load order is a trust/policy choice; keep CI authoritative. Running without Git yields an unknown state and verifies conservatively. Evidence includes per-attempt records and terminal task summaries; Pi version is optional and currently not available from the adapter. Pi 1.4.0 RPC `abort` does **not** interrupt an already-running settlement verifier (its context signal is absent there); use `/verify-cancel` to terminate the check explicitly. This mode is experimental; keep CI authoritative.

## Status

PRD milestones M0/M1/M2/M3 are partial: a real Pi 1.4.0 print-mode run confirmed fail → feedback continuation → pass with a competing handler registered before this harness. Explicit `/verify-cancel` passed in real Pi RPC, but native RPC abort/Escape cannot yet interrupt a settlement check. Real session resumption and a later handler overriding continuation remain unverified as release gates. Pi versions other than 1.4.0 are untested. See [release evidence, acceptance matrix, and rollback](docs/release-status.md).
