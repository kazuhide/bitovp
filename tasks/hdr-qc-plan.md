# HDR QC implementation

1. [x] Verify upstream HDR models, PQ CAMBI and Dolby base-layer limits.
2. [x] Trace current input, fMP4/HLS, worker and preview boundaries.
3. [x] Record specification before implementation.
4. [x] Add pinned, isolated HDR measurement runtime and executable proof.
5. [x] Add bounded existing-HLS targets/acquisition and retained previews.
6. [x] Add strict HDR protocol, CPU execution, PQ CAMBI and persisted evidence.
7. [x] Expose model/source and HDR scope in existing QC UI and exports.
8. [x] Run focused regressions, real media tests, full tests, typecheck and build.
9. [x] Push English PR; parallel foreground codex-rescue and agent review.
10. [x] Fix findings; merge only with green CI and no critical/blocker findings.
11. [x] Qualify/deploy the reviewed runtime; run Sol Levante HDR QC and retain URL.

The implementation merged in [PR #139](https://github.com/kazuhide/bitovp/pull/139) after the 16 required checks and both independent reviews passed. After deployment, the Sol Levante 12 Mbps application job finished and its full export was verified across all 6,314 frames. The recorded measurement covers the HDR base layer. Physical Dolby Vision rendering remains unverified.

The separately requested AV1 SDR THREE_PASS rerun is complete and retained in
BitOVP. Its 6,314-frame measurements reuse the previous SDR protocol; the
previous encodes and measurement records were preserved.
