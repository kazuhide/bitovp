# Verification foundation contract

The foundation must preserve defect detection while shortening the normal
development loop. Its unit of completion is the connected workflow: classify a
change, run the relevant contracts, disclose untested boundaries, prove that
critical guards remain detectable, and require complete integration evidence
before merging. A faster command or another passing test alone is insufficient.

## Changes select checks

`pnpm verify:change plan --base <revision>` derives the changed paths from an
explicit local ancestor. Committed, staged, unstaged, deleted and untracked files
all participate. All matching domain rules contribute checks; shared code,
dependencies, configuration, harness changes and unclassified source changes
select the full fixed profile set. An unknown path stays visibly unclassified.
Only explicitly recognized documentation-only changes or an empty change can be
reported as not requiring these fast contracts.

`pnpm verify:change run --base <revision> --output <new-external-directory>`
uses the existing feature runner with at most two concurrent profiles, each with
two Vitest workers. It retains a private, sanitized receipt with the source and
policy identities, selected profiles, actual reports and pending integration
checks. Missing, failed or skipped cases, changed source/policy, an incomplete
receipt, or failed cleanup cannot become a successful fast-check result.

Fast-check success never sets `deliveryReady` to true. The command neither
launches providers nor treats a path-filtered workflow as if it had run. See
[the change workflow](./change-workflow.md) for the exact classifications and
receipt schema.

## Critical paths have explicit evidence layers

The eight registered profiles contain 760 fixed cases. Counts are an inventory
check, not a quality score. Each suite must retain meaningful behavior assertions.

| Path | Fast contracts | Integration evidence still required |
|---|---|---|
| Authentication and tenant isolation | Role refusal and tenant-context propagation, 109 cases | Actual middleware/session boundaries and PostgreSQL runtime-role/RLS isolation |
| VOD/Live submission | Request identity, duplicate/conflicting submission, authorization, 170 cases | Installed authenticated screen → actual API → saved-plan readback; real DB concurrent insertion |
| VOD timeline | Independent audio/video edits, snapping and output preservation, 55 cases | Installed configuration flows; real preparation/preview lifetime and media fixtures |
| Live lifecycle | Stale owner/lease rejection, cancellation wakeup and retained terminal evidence, 52 cases | Registered PostgreSQL, Redis and lifecycle integration cases |
| Library render recovery | Material identity, tenant/lease checks, interrupted adoption and recovery, 23 cases | Real database and storage/media fixtures |
| QC allocation | Resource budgets, reservations and command construction, 268 cases | Native media and host-specific capacity qualification |
| QC measurement validity | HDR compatibility and synthetic alignment, 39 cases | Actual media/scorer evidence and browser grouping/playback |
| QC runtime safety | Admission, cancellation/deadline ordering and process ownership, 44 cases | Real PostgreSQL cancellation race and installed cancellation readback |

The full Web inventory, audited gated skips, PostgreSQL, Redis, real-media checks,
native proofs, installed GUI and database upgrade/restore remain required in
their existing lanes. Fast contracts do not replace these checks or imply every
possible action in a domain has been exercised.

## Detection is itself a required CI contract

`pnpm check` runs Biome and actionlint against every workflow. The mandatory
quality job installs checksum-pinned actionlint 1.7.12 before this check. It
validates workflow syntax, expressions and available contexts; the optional
ShellCheck/Pyflakes integrations are separate from this workflow-specific gate.
An invalid job-level `runner` context found during initial integration is retained
as the reason to require this semantic check before pushing future candidates.

The `semantic-controls` job applies four fixed faults in its own clean hosted
checkout. Every control runs the identical complete selected test files in
three phases: original source, one precisely anchored mutation, and byte-for-byte
restored source. The expected case names, counts and behavioral failures are
fixed in the registry. A missing case, skip, setup error, timeout, unrelated
assertion, surviving mutant or failed restoration fails the job.

| Protection | Deliberate fault | Required observation |
|---|---|---|
| Tenant dispatch ownership | Omit the ownership check before dispatch | Foreign organization/resource identities fail the intended refusal assertions |
| Non-idempotent start | Allow transport retries for START | The same synthetic start request is sent more than once and the single-send assertions fail |
| HDR measurement context | Classify every imported result using the first result | The expected per-result HDR group is missing |
| Child process lifetime | Resolve on abort before the child closes | The lifetime/retention assertions observe premature completion |

The separate mandatory PostgreSQL control removes only the LOCAL QC update's
status predicate. A second connection commits completion after the route's
original read; the mutant overwrites `FINISHED` with `ERROR` and must fail that
specific assertion. The normal full PostgreSQL suite must pass independently.
No control starts a paid provider or performs real media processing. Raw reports
stay private until cleanup; durable summaries contain digests, counts and timing.

These controls prove specific detection capabilities. They are not naturally
discovered product bugs, a general mutation score, or permission to weaken tests
until a mutant has the desired result. When behavior intentionally changes,
review the invariant, test and fixed control together.

## Installed behavior and generated sequences

Installed Bombadil exercises the real VOD wizard's edits, selection, add/copy,
removal and step navigation. An independent model of visible values is checked
against both the screen and serialized plan. Each action class must be reached.
A deliberate action-routing fault must violate the intended property and replay;
the separate historical rendition defect remains a component-level control.

The browser uses one owned, prepared target. Authentication stays private,
mutations and external communication are blocked, and independent tripwires
verify interception. Target identity, action/transition coverage and complete
raw violation sets are acceptance requirements. A trace is not successful merely
because it lacks a violation notification: retained observations must satisfy
the same predicates as the component's actual properties.

The installed QC case uses an inert, synthetic LOCAL report with the Worker
stopped. It exercises authenticated cancellation, actual API/database readback,
reload, repeat cancellation and retained partial results; an unauthenticated
request must be refused. Accepted cancellation is not evidence of real process
termination. Owned rows, temporary feature configuration, browsers and child
processes must be restored or removed on success and failure.

See [the Bombadil evaluation](./bombadil-evaluation.md) for scope, retained
artifacts and the distinction between component and installed evidence.

## Speed and truthful completion

Measure each final profile against direct execution in three alternating pairs
on the same clean revision. The local acceptance budget is a median of at most
ten seconds per profile and at most one second of added median harness overhead.
The change runner has a bounded aggregate deadline and cleans up children before
returning. Expensive checks run in parallel hosted CI lanes; no test is silently
removed to meet a time budget. Integration wall time and runner time are reported
separately from local feedback latency.

Natural findings must retain their reproducer and regression. This work found
trace filtering that hid unrelated violations, symbolic-link entry points that
exited without validating, and detached browser-tool children that escaped the
wrapper's process group. These differ from the deliberate controls above and the
historical product regressions documented in
[quality effectiveness](./quality-effectiveness.md).

Dependency findings remain visible. The supported glob grammar and rejected
custom Next image patterns are explicit compatibility restrictions, not an
upstream security fix; see [the dependency contract](./picomatch-mitigation.md).

Completion requires the integrated candidate's test/build output, two independent
reviews of the final source identity, all required CI, and equality between the
reviewed tree and the actual merged main tree. Production deployment, provider
behavior outside the fixtures and video-quality measurements remain separate
tasks. Finite tests cannot establish that all unknown defects are absent.
