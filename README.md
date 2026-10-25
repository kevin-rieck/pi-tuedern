# Pi Engineering Harness

A Pi extension that runs a trusted project's `scripts/verify` and records the result. Verification is **not** product acceptance or a substitute for protected CI. Manual `/verify` is the default; automatic verification and bounded repair are experimental and opt-in.

## Run

Requires Node >=22.19 and Pi 1.4.0 (the only tested host version). This package is private, not published to npm.

```sh
npm ci
npm run verify               # typecheck and tests
pi -e .                      # try locally; enter /verify in Pi
```

To use it in a trusted project, install the reviewed checkout with `pi install --local /absolute/path/to/pi-engineering-harness`, then start Pi from that project. Create an executable, noninteractive `scripts/verify` that exits 0 only when all required checks pass. Run the same script in CI independently of Pi. Review it first: scripts and extensions run with your OS privileges, not in a sandbox. On Windows, Bash must be on PATH.

`/verify` checks the current working directory by default; a missing script reports `unavailable`, never `passed`. `/verify-cancel` cancels a running check. From a nested directory, set `PI_HARNESS_SEARCH_ROOT` to a trusted repository boundary before starting Pi; optionally set `PI_HARNESS_PROJECT_ROOT` to an exact root within it.

## Optional automatic mode

Set `PI_HARNESS_AUTOMATIC=1` before starting Pi, or point `PI_HARNESS_CONFIG` to a trusted JSON file:

```json
{"automaticOnSettle": true, "maxRepairContinuations": 2, "timeoutSeconds": 300}
```

After a user prompt, changed or unknown repository state triggers verification at settlement. A failed script can prompt up to two repair continuations; `/resume-repair` resumes an interrupted repair. Default timeout is 300 seconds. Automatic mode requires Git for change detection (without it, verification runs conservatively). It is **not a hard gate**: later settlement handlers can override continuation, and Pi 1.4.0 abort does not interrupt a running settlement check; use `/verify-cancel`. Keep CI authoritative. See [release status and known gaps](docs/release-status.md).

## Evidence

Attempts and terminal summaries are written as JSON to `~/.pi/engineering-harness/evidence/` by default, outside the project. They record status, bounded diagnostics, and `acceptanceStatus: "not_evaluated"`. Redaction is best-effort: never print secrets from verification scripts. A crash can leave a run without a terminal summary; missing evidence is not success. Configuration supports `recordEvidence`, `evidenceDir`, `verifyPath`, `maxFeedbackCharacters`, and root selection; see [`src/config.ts`](src/config.ts) for defaults and supported keys. The standalone verifier is exported from [`src/verification.ts`](src/verification.ts).
