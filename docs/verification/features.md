# Feature verification

For an ordinary change, start with the [change workflow](./change-workflow.md),
which selects and combines these profiles from an explicit Git base. Direct
profile commands remain useful while working on a known behavior.

Use `pnpm verify:feature list` to discover eight fixed checks. The registry in
`scripts/feature-verification-registry.mjs` is the executable source of truth.

```sh
pnpm verify:feature doctor qc-resource-allocation
pnpm verify:feature run qc-resource-allocation --output /absolute/new/evidence-directory
```

The output directory must be new and outside the checkout. Prepare dependencies
with the repository's normal installation instructions first. Web and worker profiles
require `pnpm --filter @bitovp/db build`. Doctor is read-only and reports missing
prerequisites; it does not install, start an app, or call worker verify operations.
Existing `worker verify preflight` is a capability report and its exit code is not
used as readiness. Feature runs inherit an environment allowlist without provider
credentials and use a fixed test list, two Vitest workers, and a 120-second limit.

| Feature | User path represented | Contract checked | Not established |
|---|---|---|---|
| `access-isolation` | Submit a protected request as a user or token | Role admission and authenticated tenant context | Live cookies, PostgreSQL row-level security |
| `submission-idempotency` | Submit or repeat a VOD or Live creation request | Request identity, route validation and persistence-adapter behavior | Concurrent database writes, actual encoding |
| `vod-timeline` | Overwrite an audio or video track, snap an edit and retain packaging | Independent tracks, snapping and HLS/DASH plan compilation | Browser pointer fidelity, actual media playback |
| `live-lifecycle` | Start, cancel, poll or re-air a Live channel | Run ownership, stale provider observations and cancellation recovery | Actual provider state or billing, PostgreSQL locking |
| `library-render-recovery` | Resume a composition or derivative after cancellation or lease loss | Source identity, render ownership and adoption of recovered output | Real storage, render fidelity, PostgreSQL locking |
| `qc-resource-allocation` | Choose LOCAL QC and its CPU/banding options, then submit | Resource planning, detector reservations, and processor command composition | Actual throughput, GPU capacity, completion ETA |
| `qc-measurement-validity` | Select reference/distorted content and inspect the QC comparison | HDR compatibility and synthetic frame alignment | Measured video quality, display fidelity, real-media coverage |
| `qc-runtime-safety` | QC waits for capacity, reaches an absolute deadline, or its running process is interrupted | Admission cancellation, generated reservation/deadline action sequences, and process/supervisor adapter contracts | HTTP cancel acceptance, physical stop of a production job, UI behavior |

All eight have `scope: unit-contract`. Their fixtures include synthetic/mocked
inputs. The receipt never converts them into UI, real GPU, provider, or deployment
proof. Real UI navigation and screenshots belong to the existing **Installed GUI**
workflow (`.github/workflows/installed-gui.yml`), which uses its isolated installation
and `tests/browser/playwright.config.ts` on GitHub-hosted Linux. Do not disable that
environment check to make a local command appear to validate the same surface.

The runner writes `receipt.json` as incomplete before checking prerequisites. A
passing receipt requires the exact registered files and test counts, all passing,
no skip/todo, a successful command, unchanged source/registry identity, and confirmed
cleanup within its stated scope. Each receipt records the source SHA and dirty-tree
digest, registry digest, argv, times, expected/actual counts and report digest.
Raw Vitest diagnostics are private scratch and removed; the retained receipt holds
only counts/statuses and source-relative file paths. Inspect failures locally with
the listed targeted command when more diagnostic detail is needed.

SIGINT/SIGTERM and timeout abort the owned command group using the existing media
runner. Finalization waits for its direct child to close and checks that the original
process group no longer exists; otherwise `CLEANUP_UNCONFIRMED` fails the run.
Cleanup removes only this run's scratch and retains its receipt. It neither stops
existing services nor calls worker `run`, `recover`, or `clean`. A descendant that
creates a separate process group, a forced kill of this runner, or a machine crash
is outside this cleanup guarantee; an incomplete receipt is not success.

The time limit is a cancellation budget, not a promised return time: the shared
runner allows a five-second termination grace and OS process termination may fail.
No retries silently extend the budget. Unknown IDs, extra arguments, old output
directories, missing tests, source changes, failed prerequisites, malformed reports,
and cancellation are non-success. Changing the expected counts requires review;
they are never copied automatically from the latest result.

For a bug fix, preserve a failing baseline and compare the same input/assertion with
the patch where relevant. Low-impact edits do not require two complete application
runs. The inexpensive harness contract suite covers report faults, CLI rejection,
real child timeout/cancellation, and residual-group rejection. These checks cannot
prove that a feature map or assertion describes the right product behavior.

The runtime profile contains 44 tests, including six generated properties. Each
property requires 100 traces with no skips and asserts that its important actions
were reached. Two pinned seeds exercise both reservation accounting modes and
deadline/settlement order. The usual feature command does not inherit the local
replay override. See [quality effectiveness](./quality-effectiveness.md) for the
old/new defect replays, the fault missed by the previous tests, and the limits of
the measured detection gain. Faster execution alone is not a quality result.

## Development feedback acceptance

Judge the harness by useful feedback time while preserving defect detection. On
the dependency-ready development machine, measure three alternating pairs of the
same fixed Vitest command and the harness CLI for each feature. Use the same
source, environment allowlist, files, counts and two-worker limit; retain each
sample and compare medians. The initial local targets are at most ten seconds per
feature and at most one second of added median harness overhead. These are local
acceptance targets, not guarantees for every host or a cold installation.

Speed passes only when all registered assertions still pass, failure/skip/missing
coverage remains non-success, and a semantic negative control is detected by the
existing regression assertions. Keep the required whole-application CI checks.
Measure their critical path separately: short contract feedback alone does not
establish a shorter PR-to-merge cycle. Changes to CI parallelism or build reuse
must preserve complete test coverage, skip audits, source identity and fresh
validation, and show a measured improvement over the recorded baseline.
