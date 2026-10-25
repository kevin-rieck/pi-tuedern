# Pi Engineering Harness

Scaffold for the [engineering harness PRD](pi-engineering-harness-prd.md). **Not a verifier yet.** `/verify` currently reports that verification is unavailable; it never claims a check passed. No automatic hooks or repair are enabled.

## Develop

Requires Node >=22.19, npm, and Pi. The dev dependency pins Pi 1.4.0 for typechecking; Pi provides the runtime API when the package is loaded.

```sh
npm ci
npm run verify
pi -e .                 # local package, then enter /verify in Pi
```

`pi -e .` loads the local package for one invocation. To persist it in a trusted project, run `pi install --local ./path/to/pi-engineering-harness` from that project; for releases use a pinned npm version or Git tag. Do not auto-run untrusted project scripts. `npm pack --dry-run` checks published contents when the package is ready for release (remove `private` only then).

## Next implementation steps

1. Implement the standalone verifier: trusted project-root resolution, bounded process execution, timeout/cancellation, typed result and local evidence. Connect `/verify` only after the service works and tests cover pass/fail/unavailable.
2. Run a separate lifecycle spike against Pi 1.4.0 (`agent_before_settle`, continuation and competing hooks). Do not enable automatic verification or repair before that passes.
3. Keep acceptance (`not_evaluated`) separate from verification; let CI run each project's own `scripts/verify` independently.

Pi docs consulted: [extensions](https://pi.dev/docs/latest/extensions) and [packages](https://pi.dev/docs/latest/packages); check the declarations in the installed Pi version before implementing lifecycle hooks.
