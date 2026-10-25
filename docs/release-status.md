# Release evidence (Pi 1.4.0, 2026-10-25)

This is a development smoke report, **not** a v0.1/v0.2 release approval. Supported/tested host: Pi **1.4.0 only**, Node >=22.19. No claim for later or earlier Pi versions. Automatic repair stays off by default. Requirements/product acceptance remains `not_evaluated` even when verification passes; protected CI checks remain authoritative.

## Clean pinned-source smoke and rollback

A fresh `PI_CODING_AGENT_DIR` and `PI_PACKAGE_DIR` were used to run `pi install git:github.com/kevin-rieck/pi-tuedern@77ae94a`. `pi list` displayed that ref and checkout HEAD was `77ae94a`. The isolated directory has no provider credentials, so a print-mode model run there failed with “No API key found”; an RPC run in that isolated environment then discovered the installed `/verify` command, invoked it against the React fixture, and produced a passing attempt and task summary without requiring a model. Repeat using `node tests/install-smoke.mjs git:github.com/kevin-rieck/pi-tuedern@7e7a23d` (the command installs the pinned source in fresh directories). The same checkout also loaded in an authenticated print-mode run with no extension errors. The package is private and no immutable npm release exists. This is a pinned Git commit, not a release with provenance.

For a trusted project, install with `pi install --local git:github.com/kevin-rieck/pi-tuedern@77ae94a` only after reviewing the commit. Upgrade by replacing the pinned commit explicitly and rerunning `npm run verify`, fixture scripts, and CI. Roll back via `pi remove --local git:github.com/kevin-rieck/pi-tuedern@<new-ref>` then `pi install --local git:github.com/kevin-rieck/pi-tuedern@77ae94a` (or your previous known-good commit). Disable automatic repair immediately by removing the config opt-in or setting `PI_HARNESS_AUTOMATIC=0` before restarting Pi. Git refs must be reachable and Pi package installation may require network; retain a local archive for offline rollback. Test the rollback in the target repository before relying on it.

## Acceptance matrix (verification ≠ product acceptance)

| ID | Evidence / remaining gap |
|---|---|
| AT-01, 02, 06, 07 | Verifier pass/fail/missing/process behavior covered by unit tests; real installed `/verify` RPC invocation passed on React. Real command failure/missing UI not yet tested. |
| AT-03, 04 | Real Pi 1.4.0 `--print --mode json` disposable Git project: failing script produced feedback continuation and second successful check after a model edit. A competing handler registered **before** the harness appended an entry. |
| AT-05 | Unit test confirms two-repair budget; real Pi exhausted-run scenario not yet demonstrated. |
| AT-08, 09, 10, 11 | Mock hook and Git fingerprint tests cover no-change, shell-created file, dirty baseline and changed-after-pass; real Pi coverage incomplete. |
| AT-12, 13, 14, 15 | Verifier timeout, AbortSignal, truncated output, redaction unit tests; real Pi 1.4.0 RPC `abort` was tested and **failed** to interrupt a running settlement verifier (the 30-second check completed as failed). Pi's `ctx.signal` is absent at settlement; the new `/verify-cancel` command is tested against real Pi RPC and records `cancelled` without continuation. A Windows/MSYS `timeout -s INT` attempt also did not cleanly terminate Pi and left child processes (removed). Native Escape/RPC abort remains an open gap. Redaction is best-effort, not a secrecy boundary. |
| AT-16 | `npm run verify` runs Python, React and Rust fixture contracts. |
| AT-17 | Clean pinned Git install, real Pi RPC `/verify` discovery/invocation and passing attempt/summary smoke passed; no npm/provenance release yet. |
| AT-18 | Only Pi 1.4.0 tested; outside-range compatibility failure not implemented, do not claim a compatibility gate. |
| AT-19 | Duplicate manual invocation refused in mock test. Other-extension composition tested before the harness in real Pi; a later handler may override its continuation (Pi last explicit override wins). |
| AT-20 | Unit test covers explicit `/resume-repair` retaining the budget and a distinct user task resetting it; real Pi session-resumption test still required. |

Additional gaps: no CI matrix across Pi versions, no published npm package, no protected-policy guarantee, no pilot in the three real repositories. Verification records and terminal task summaries are JSON-schema validated, but summaries after process crashes/interruption are not guaranteed. Do not announce a release gate until the missing real-runtime cases and independent CI are exercised.
