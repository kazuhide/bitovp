# Banding quality control for v1.2.0

## Objective and scope

Implement the roadmap's banding detection for automatic VOD quality control,
QC-only encodes and manual quality measurements. Report CAMBI scores and affected
time ranges, with configurable warning and failure thresholds. CPU and the owned
CUDA/Vulkan backends must perform real CAMBI computation. This work does not cut
the v1.2.0 release or update an installed server.

Use the no-reference CAMBI metric independently of a VMAF model. Banding-only
measurements need the encoded/target video, without a source/reference video or
a VMAF model file. Existing VMAF/PSNR behavior and historical reports remain valid.
Initial support is local-worker VOD; cloud banding, Live capture, heatmaps and
full-reference subtraction are outside this change. Unsupported combinations
must be rejected explicitly rather than silently omitting banding.

## Metric and decisions

- CAMBI starts at zero; higher values indicate more banding. The observed score
  24 in Netflix's documentation is not a schema limit.
- Use official extractor defaults, including `max_val=1000`, without the CAMBI
  clipping/options embedded in a VMAF prediction model.
- Preserve encoded geometry/precision and actual relative presentation times.
  Do not resize to a VMAF reference or infer VFR ranges from an average FPS.
- Analyze all frames. Build ranges from full results before chart downsampling;
  the chart preserves CAMBI maxima. Range ends are exclusive and gaps are not
  joined across unmeasured intervals.
- CPU is the default. GPU AUTO selects supported CUDA, then AMD Vulkan, and may
  use CPU when a supported native implementation/device is unavailable before
  scoring. Invalid input, identity changes and failed parity remain errors.
- Every GPU frame is independently checked by the official CPU extractor. Store
  actual GPU scores/backend and CPU reference scores. Threshold decisions and
  affected ranges use canonical CPU values (`CPU_REFERENCE`), normalized to the
  pinned official JSON logger's adaptive 6/16-place nearest-even precision,
  while retaining unrounded native CPU reference values. This keeps rounding near
  a threshold cannot flip the CPU/GPU verdict. This does not claim that every
  GPU-assisted job is faster end to end.
- Preserve the existing CPU-only VMAF delivery-gate policy.
- GPU input preflight preserves the owned CAMBI effective-window limit, including
  its default-option geometry boundary (even dimensions with width + height at
  most 6,092). Larger valid CPU inputs require an explicit Local CPU request;
  reject them before GPU admission/scoring with that actionable instruction.

## Shared contracts

`plan.qc.banding?: boolean` is opt-in and absent/off leaves old plans unchanged.
`qc.execution` retains existing local CPU/AUTO choices; banding plus CLOUD is an
explicit validation error. Banding-only uses `{vmaf:false, banding:true}` and
skips VMAF model/reference preflight. QC mirrors/readability/QC-only rails activate
when any requested metric is enabled, and require only the inputs actually used.

Extend the existing gate rule as a discriminated union:

```ts
// Existing rules keep their shape and implicit FAIL severity.
{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 85 }
// Banding upper bound; initial CAMBI scope is per rendition/rung.
{ metric: "CAMBI_MAX", scope: "PER_RENDITION", lte: 5, severity: "WARN" }
{ metric: "CAMBI_MAX", scope: "PER_RENDITION", lte: 10, severity: "FAIL" }
```

CAMBI thresholds are finite, nonnegative upper bounds. Equality passes. WARN
breaches are visible but do not fail the gate; FAIL breaches use the existing
MARK_ONLY/BLOCK_MANIFESTS policy. Missing/nonfinite/partial measurements fail
closed even for WARN rules. The UI may suggest 5 when creating a CAMBI warning
rule, explaining its viewing-condition dependence; it must not add an implicit
failure threshold. With no gate, banding remains a score/diagnostic measurement.

Use one result row per rendition/rung, including combined VMAF and banding runs.
Banding summary/assessment and execution provenance are distinct from VMAF's.
Keep the VMAF scoring generation intact in combined CPU-VMAF/GPU-banding runs.
The frame blob uses an explicit versioned envelope for separate VMAF and banding
arrays; readers continue accepting historical plain/gzipped VMAF arrays. Never
fill VMAF values with zero for a banding-only result.

Reuse existing JSON job/result storage and organization permissions. A banding-
only job may reserve internal detector id `CAMBI` in the legacy model column,
with an explicit params discriminator; public views expose the detector and no
VMAF model claim. Keep this interpretation explicit at every serializer/reader.

The new native single-input CAMBI mode has its own strict versioned receipt,
complete frame/timestamp coverage, input/options/source/build/device identity,
actual backend and CPU parity. Keep the existing VMAF receipt verification
intact. Reuse supervised child ownership/heartbeat/abort and local resource
admission; leases remain held through child reap and private-file cleanup.
Resource/profile identities include the metric and CAMBI options.

## Implementation order and ownership

1. Core contracts: banding frames/summary/ranges, gate rules and schema/plan
   activation rails; focused tests first.
2. In parallel: native model-free CAMBI mode/oracle/receipt; worker CPU/GPU
   execution, persistence and continuation; web wizard/manual/report/export UI.
   Native and worker owners agree exact receipt keys before integration.
3. Integrate real CPU and CUDA/Vulkan measurements, compatibility, cancellation
   and failure paths; verify the rendered UI and exports.
4. Refresh user/API/GPU documentation, Unreleased changelog and roadmap state;
   regenerate API census evidence if the source fingerprint changes.
5. PR, two independent frozen-head reviews, all required CI, then squash merge.

## Commands and quality bar

Use Node >=24, pinned pnpm 11.28.8 and repository scripts. Shell tool commands
are prefixed with `rtk`/`rtk proxy`. Focused Vitest tests live beside the changed
core/worker/web modules; native tests use CMake/CTest and the actual backends.
Keep existing Biome style (tabs, named types, strict Zod boundaries).

- Install: `pnpm install --frozen-lockfile`
- Focused core: `pnpm --filter @bitovp/core exec vitest run <changed-tests>`
- Focused worker/web: equivalent package Vitest commands.
- Complete gates: `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm build`,
  `pnpm --filter @bitovp/worker smoke`.
- Native: CPU tests plus actual CUDA and AMD Vulkan CAMBI parity/identity tests
  on available hardware, with fixed binaries/input hashes and unchanged bounds.

Acceptance includes banding-only with no reference/model, combined measurements,
default-off byte compatibility, warning/failure boundary cases, unmeasured
fail-closed cases, per-title population, real PTS/VFR/gap handling, chart peak
preservation, CPU/GPU parity, owned cancellation/cleanup and truthful exports.
Run red/green focused tests for behavior changes. No skipped tests, weakened
numerical tolerances, fake GPU results, paid provider jobs, production/service
changes or automatic release creation.

## Primary references

- [Pinned CAMBI documentation](https://github.com/Netflix/vmaf/blob/74f930d17de8c58e7c2ce55e2b897b0030ebd8ef/resource/doc/cambi.md)
- [CAMBI paper](https://arxiv.org/abs/2102.00079)
- [FFmpeg libvmaf implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_libvmaf.c)
- Existing `native/vmaf-gpu` CAMBI backends, `packages/core/src/plan/qc-gate.ts`
  and local execution/supervisor/resource admission contracts.
