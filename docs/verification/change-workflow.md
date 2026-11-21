# Change-based daily verification

`verify:change` selects reviewed, fixed local test profiles from the current Git
changes. It reuses the feature runner, its prerequisite doctor, exact report
validation and process cleanup. It does not replace full CI, installed behavior
checks or the final reviews.

```sh
pnpm verify:change plan --base origin/main
pnpm verify:change run --base origin/main --output /absolute/path/to/new-receipt
```

The base must already exist locally and resolve to an ancestor commit of `HEAD`.
`HEAD^` is also supported. Nothing fetches, installs dependencies or runs arbitrary
commands. The output directory must be new, outside the source tree, and have an
existing parent. Symlink aliases into the source tree are rejected.

The plan unions working-tree and staged diffs against the resolved base with
nonignored untracked files. Thus it includes committed, staged, unstaged, deleted
and both renamed paths, including a staged edit whose working bytes were restored
to the base version. It records the base SHA/tree, current SHA/tree, working-source
identity, index digest and both selection/feature registry digests. These identities
must remain stable through planning and execution.

## Selection contract

All matching rules contribute profiles; the first match never hides another risk.
The executable policy is
[`change-verification-registry.mjs`](../../scripts/change-verification-registry.mjs).

| Changed area | Selected contracts |
| --- | --- |
| Authentication, tenancy, credentials, proxy and ingress | Access isolation |
| Encoding/live submission API and worker orchestration | Submission idempotency, plus applicable access/live rules |
| VOD input, wizard and rendition paths | VOD timeline and submission idempotency |
| Live and AISA Live paths | Live lifecycle |
| Operation analytics intake, report and expiry | Access isolation and Live lifecycle |
| Library, content editing and local semantic paths | Library render/recovery |
| QC, VMAF, banding, CAMBI and worker feeder | Three QC profiles; Web QC also includes access isolation |
| Shared core/database/storage packages, package/lock/config, harness/scripts/tests, workflows, native/deployment and shared UI primitives | All eight profiles |
| Any unclassified path, including a new API business area with only an access rule | All eight profiles, explicit `unclassified`, full CI pending |
| Only known Markdown documentation, or no changes | `not-required` with `DOCUMENTATION_ONLY` or `NO_CHANGES` |

The rules describe reviewed impact groups, not a complete dependency graph. New
files inherit a matching group; new or ambiguous areas fall back to all profiles.
Selecting all eight does not prove an unclassified feature is covered. Extend the
mapping and its independent path examples when adding a new domain. Update the
fixed feature registry only after verifying actual test cases; test counts are
never generated from source syntax.

The contract tests use real temporary Git repositories and require exact mapping
classifications, rule reasons and profile sets. They cover future files, overlapping
domains, staged-only differences, missing registry files, invalid revisions and
symlink outputs. Negative receipts, source/index/policy drift, cancellation and
deadline expiry cannot produce a passing result. Every referenced profile file
and workflow must be tracked and present; expected test counts must be positive.

## Execution and receipts

Execution runs at most two fixed profiles concurrently, each through the existing
feature runner with at most two Vitest workers. The aggregate execution deadline
is 120 seconds; cancellation stops scheduling and waits for active runner cleanup.
An individual failure does not suppress the other selected profiles. Prerequisite
failures remain `blocked`. No arbitrary test selection, test skipping or command
injection interface is exposed.

The private output starts with an atomic `incomplete` receipt. The final receipt
records expected/actual profile IDs, sanitized outcomes and hashes of the child
receipts. A successful profile must have the exact file/test counts, all tests
passed, complete cleanup and matching source/registry identity. Missing, skipped,
unexpected or failed reports cannot produce `fast-checks-passed`. Raw test logs
are not copied into the aggregate receipt.

`fast-checks-passed` means only the selected local contracts passed. `not-required`
does not mean tests ran. `deliveryReady` is always `false` here, and these workflows
remain explicitly `pending`:

- `.github/workflows/ci.yml` (including semantic controls)
- `.github/workflows/installed-gui.yml`
- `.github/workflows/offline-media.yml`
- `.github/workflows/upgrade-rehearsal.yml`
- `.github/workflows/hierarchical-flow.yml`
- `.github/workflows/pages.yml`
- `.github/workflows/bombadil.yml`

Path-filtered workflows, including hierarchical flow, may require explicit
scheduling. Their absence is not a successful run. Completion requires the
applicable exact-source delivery evidence and final reviews under the
[completion contract](completion-contract.md).

CI quality executes the selection contract tests and prints a plan against
`HEAD^`; it does not infer delivery success from that plan. For daily speed, the
target is a median below ten seconds per fixed profile and below one second of
wrapper overhead, measured on the same source, file list and two-worker setting.
The 120-second deadline is a failure bound, not a latency target or a measured
performance claim.

## Compare the same task across screens

Start a UI review with operator tasks and identify other screens that support
each task. Exercise both screens with the same role and equivalent data states.
For lists, check the default sort with a fresh browser profile, saved
preferences, and ties across pages. For actions, check the visible label and
placement, count the interactions to reach confirmation or the result, and
check when the action is disabled or hidden.

For example, compare finding the newest entry and opening deletion confirmation
in **VOD Jobs** and **Live Channels**. Use a newer active row and older terminal
rows, with equal creation times split across pages. Each list should show the
newest row first and open confirmation for a terminal row in one click from
Actions. Cancel the dialog when reviewing real data.

Record the task, screens, role, data state, observed steps and evidence. Give
each unexplained difference a priority and note the reason for any intentional
difference. Identify source-only checks when a browser run is unavailable.
The [paired component tests](../../apps/web/src/app/live/list-operations.test.tsx)
exercise this example with synthetic data in Web CI.
