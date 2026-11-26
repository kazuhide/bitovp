# Quality effectiveness

Faster feedback is useful only when defects still stop delivery. Test counts and
green builds alone do not establish stronger detection. This evaluation separates
historical product fixes, newly added detection, and untested behavior.

The [completion contract](./completion-contract.md) connects change-based check
selection, eight fixed fast profiles, mandatory semantic fault controls,
installed-wizard exploration, authenticated cancellation and a real-PostgreSQL
competing write. It records naturally discovered evidence and process-cleanup
defects separately from intentional faults. The controls continuously test
specific detection capabilities; they do not count as newly discovered bugs or
as a general mutation score.

## Generated state sequences

The worker directly pins `fast-check` 3.23.2. Six properties run as part of both
the normal worker suite and `verify:feature run qc-runtime-safety`:

- Admission: two seeds for each reservation-accounting mode. The tests call the
  real `acquire` and `run` interfaces and observe grants, work starts, releases and
  cancellation. They check capacity, available headroom, FIFO, exclusive work,
  abort ordering, idempotent release and eventual permit recovery.
- Deadline: two seeds compose the real deadline wrapper with admission. They
  check already-expired and omitted deadlines, queued and running cancellation,
  work success/failure, retention until work settles, timer cleanup and distant
  deadlines around the timer overflow boundary.

Seeds are `20261118` and `151152`; each property requires 100 traces, zero skips,
and positive counters for its important actions. Admission traces contain at most
30 actions and eight requests; deadline traces contain at most 20 actions.
The oracle uses observed permit/work lifetimes, not the implementation's private
counters or a copy of its drain loop. Fake time and deferred work bound execution.

The initial execution passed all six properties: **600 traces / 2,751 actions**,
including 283 observed grants, 136 explicit exclusive grants, 20 duplicate
releases and 148 ownership-retention checks after abort. Together with the 15
existing admission/deadline cases, all 21 tests passed in a 662-ms Vitest run on
Node 26.13.1. This includes the existing short real-Node-child deadline case;
the generated properties themselves launch no process, media or provider work.
This timing is a local sample, not a latency guarantee.

## Added detection demonstrated by a controlled fault

The production caller in `local-resources.ts` enables
`accountUnmaterializedReservations`. A deliberate one-location mutation removed
reserved bytes from that mode's headroom check while leaving capacity, FIFO and
release logic unchanged.

| Checks against the same mutant | Result |
|---|---|
| Previous admission suite | 10/10 passed; defect missed |
| Added properties with accounting disabled | Both seeds passed, as expected |
| Added properties with accounting enabled | Both seeds failed on headroom overcommit |

The counterexample shrank to three operations with capacity two: acquire one,
change available headroom to one, then acquire another one. Correct code keeps
the second request waiting. The mutant grants two against headroom one.
Seed `20261118` detected it on trace 41 and shrank it 11 times; path
`40:3:1:2:2:6:11:11:14:14:14:14` reproduced the same behavior failure.

The production source was restored byte-for-byte before the final successful
run. No mutation is shipped. Only this one fault class was tested; there is no
claim of an overall mutation score or of newly discovered natural product bugs.
The new properties found no natural product bug in this bounded exploration.
Test-oracle and cleanup mistakes encountered while writing them were corrected
and are not counted as product-quality improvements.

For local counterexample replay, pass `BITOVP_PROPERTY_REPLAY_PATH` to the direct
Vitest command and select the matching seed/property. A selected replay is not a
complete generated run. The bounded feature CLI drops this environment override
and always executes the registered full counts.

## Historical product defects replayed

These fixes are part of the local QC control change in
[PR 152](https://github.com/kazuhide/bitovp/pull/152). Identical selected test bytes
were run against exact old and corrected Git archives with injected synthetic
process/download runners and mock Prisma. A behavior assertion had to fail;
setup, import or timeout failures did not qualify as detection.

| Product behavior | Old revision | Corrected revision | Same-case result |
|---|---|---|---|
| Cancellation immediately before terminal persistence was overwritten by `FINISHED` | `da31b866` | `0cfcd408` | 1 failed / 1 passed |
| Deadline/cancellation during gate-result reads still allowed success or an encoding-gate write | `0cfcd408` | `ec867dbd` | 2 failed / 2 passed |

This establishes **two historical defects / three regression cases**. The two
gate modes share one root cause and are not counted as two defects. The terminal
case applied the same mock `status.in` support on both sides; the gate cases
needed no fixture/import changes. Other registered tests were explicitly filtered
out and are not claimed as exercised by these focused replays. Existing decoder
allocation protection from PR 151 also predates this harness and is not new gain.

The historical fixes and the new controlled-fault detection answer different
questions. Neither replaces full CI, integration tests, native media proofs or
installed-GUI checks. Finite generated sequences do not establish behavior under
real OS memory pressure, detached processes, worker crashes, real PostgreSQL
transactions, GPU scoring or provider activity. Those evidence layers remain
separate. Any newly found product defect must retain its counterexample, gain a
regression test, and pass review and CI before an Unreleased fix is merged.

## Product findings from the full-suite run

The later complete Web run exposed a separate UI defect while inspecting a slow
existing regression case. Two output files with temporarily identical video
settings produced the same React row key in Review, even though their destination
paths differed. This violates React's sibling identity requirement. The same
warning appeared in earlier successful runs; it is not evidence that the key
collision caused the test timeout.

The regression now requires both destination paths, no duplicate-key error, the
existing duplicate-stream validation, disabled submission, and recovery after
editing the bitrate. The original code fails the new assertion; the corrected
stateless rows include their position in the key and pass it. The Unreleased fix
does not change encoding keys or relax plan validation. This is a naturally
observed UI defect, separately counted from the generated properties' controlled
fault and the two historical QC defects. It does not establish that a real user's
output file was omitted or overwritten.

The audio duplicate-key warning exposed a separate behavioral defect in
`RenditionAddControls`: the select value and lookup both used the generated stream
key. During a temporary collision, choosing the second rendition, or accepting
the default last rendition, could copy the first rendition's configuration.
The regression uses distinct configurations under equal keys and checks the
actual copied settings, including a middle-row selection through collision and
recovery. UI choice identity is now separate from the encoding key. Existing
unique-key selection, default settings, and empty choices retain their behavior.
These naturally observed product defects are distinct from test-driver latency
and the deliberate reserved-headroom fault.

Method reference: [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/).
