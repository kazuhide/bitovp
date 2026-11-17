# CI feedback time and coverage

The acceptance criterion is faster feedback with the same required verification.
Short feature checks and the complete PR gate are measured separately. See
[feature verification](./features.md) for the local feedback contract.

## Measured starting point

On main `da31b866`, Web tests took 907 seconds and the Installed GUI job took
1,292 seconds. Of the latter, image builds took 1,085 seconds and the 12 browser
cases took 63 seconds. The later prechange QC control PR had 872 Web test files,
13,167 cases (13,057 passed and 110 audited environment-gated skips), a 927-second
Web job, and a 1,602-second GUI job. Build timing varies substantially between
GitHub runners; a small single-run improvement is insufficient evidence.

## Complete Web suite in four parts

Each shard runs the full configured discovery and checks it against the tracked
source inventory before running its assigned portion. Within the same allocated runner,
one available CPU uses one Vitest worker, two or three available CPUs use two,
and four or more use four. This caps workers at four within the same allocated
runner capacity, without adding shard jobs. The budget uses `os.availableParallelism()`;
logical CPU count and sanitized CPU models are logged only as diagnostic context.
The current Vitest version, configuration policy and full-suite command are
explicit. A configuration change requires reviewing that policy rather than
silently losing new test paths.

Vitest's default file hashes put the 64-case `file-flow.mount.test.tsx` on shard
3, which already had the largest measured workload. That file alone took
151–161 seconds in the three-worker samples. For four shards, a small subclass
of Vitest's `BaseSequencer` assigns only that exact file to shard 1. Every other
file keeps its default assignment, including future additions; sorting is
inherited unchanged. Other shard counts keep the default behavior, and removing
the named file leaves no stale selection. Full discovery and the aggregate
inventory check still cover every test file.

Only sanitized file/status/count receipts are uploaded. The required `tests (web)`
check always runs, requires every shard job to succeed, and checks exactly four
receipts from the same source SHA/tree, workflow run and attempt. Their disjoint
union must equal the entire source inventory. It then applies the existing full
skip audit. Missing, duplicate, failed, canceled or stale parts cannot pass.
When retrying, rerun the whole CI workflow so successful parts from an older
attempt cannot be mixed with the new attempt.

The initial measured target is at most 420 seconds from the first shard starting
through the aggregator finishing, and at most 1,251 runner-seconds in total for
those jobs. Record queue delay separately. These targets are acceptance criteria;
the workflow still reports actual test success independently of a noisy timing
sample.

The first four-shard, two-worker sample
([44094835403](https://github.com/kazuhide/bitovp/actions/runs/44094835403)) measured
447 seconds and 1,477 runner-seconds and failed an outdated HDR source-contract
expectation. After correcting that expectation, the same worker limits
([44098516198](https://github.com/kazuhide/bitovp/actions/runs/44098516198)) measured
497 seconds and 1,403 runner-seconds; all 872 files, 13,167 cases and the complete
110-skip audit passed. Both samples exceed the performance criteria and remain
part of the evidence. With three workers, later runs measured
[419 seconds / 1,192 runner-seconds](https://github.com/kazuhide/bitovp/actions/runs/44101340969)
and [436 seconds / 1,179 runner-seconds](https://github.com/kazuhide/bitovp/actions/runs/44106606835).
The first passed with only one second of elapsed margin; the second missed that
limit. Both passed the complete inventory and skip audit.

After the single-file redistribution, the same source `2ca1bdd9` measured
[381 seconds / 1,259 runner-seconds](https://github.com/kazuhide/bitovp/actions/runs/44110924255/attempts/1)
and, on one complete confirmation rerun,
[369 seconds / 1,260 runner-seconds](https://github.com/kazuhide/bitovp/actions/runs/44110924255/attempts/2).
Both passed all 872 files, 13,167 cases and the full 110-skip audit, with only the
intended file moved. Both meet the elapsed limit and miss the runner budget by
eight and nine seconds. Per-shard host speeds varied substantially, while total
Vitest wall time was nearly unchanged. These failed cost measurements remain
part of the evidence; no further unchanged rerun is used to seek a passing sample.

The current four-worker cap uses the fourth CPU already allocated to each runner.
Its performance is unmeasured until the next complete CI run. The acceptance
criteria remain 420 seconds and 1,251 runner-seconds; prior samples do not
establish a stable latency or cost guarantee.

## Verified native HDR build reuse

HDR FFmpeg previously inherited a completed SDR compilation, discarded it and
compiled again. Both now derive from common pinned source preparation. Installed
GUI and Offline media use the narrow HDR output cache described in
[the FFmpeg build guide](../FFMPEG-BUILD.md). The cache is bound to its exact
source/patch/model/proof/helper inputs and architecture. Every hit validates the
complete file census and checksums and reruns the current HDR proof. Application
images still build from the current checkout or distributed source archive.
The cache-free weekly source build remains in place.

For both workflows, require two warm runs of the same source to complete within
600 seconds, with their image builds within 420 seconds. Include restore, fresh
proof, setup, browser/media verification and cleanup in whole-job timing. Keep all
browser cases, no-skip/no-retry checks, submission isolation and restore proofs.

Report the initial cold seed separately: Dockerfile changes also invalidate the
SDR cache, and compilation time must not be hidden as a warm-cache result. Retain
before/after timings and complete coverage evidence in the PR validation record.
Do not claim these targets have been met from source inspection or unit fixtures.

## Verified official media input

Offline attempt 2 of
[44101341010](https://github.com/kazuhide/bitovp/actions/runs/44101341010/attempts/2)
failed before its image build when the official Blender download returned HTTP
403. Its 41-second failed job is retained as a failed sample and provides no
media coverage or successful warm-run evidence.

Offline CI now caches only the complete original MP4, named and keyed by its
existing SHA-256
`f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508`,
under `RUNNER_TEMP/bitovp-media-source`. Every hit checks a regular file, the
90-MiB size limit and the pinned byte digest before use. Corrupt entries fail
without replacement. The media runner still performs its existing verification
before and after all unchanged fixtures and proofs.

A cache miss still needs one successful download from the original official
URL. It extracts privately, verifies before atomic publication, verifies any
concurrent winner, and removes only its own partial files. Preparation runs
before native and image builds. There is no alternate origin, redirect, retry
or bypass for HTTP 403. A verified cache hit avoids that origin dependency;
the first successful seed remains an external dependency and must be reported
separately from warm reuse.
