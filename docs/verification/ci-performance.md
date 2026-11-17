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
source inventory before running one quarter with two Vitest workers. The current
Vitest version, configuration policy and full-suite command are explicit. A
configuration change requires reviewing that policy rather than silently losing
new test paths.

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
