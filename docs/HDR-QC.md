# HDR QC — Dolby Vision, HDR10 and HLG

Status: implemented; integrated verification and review in progress (2026-11-16)

## Objective

Measure an existing, finished Sol Levante AV1 Dolby Vision Profile 10.1 output
in BitOVP and retain its report, preview, full-frame values and execution
provenance. Keep the existing SDR measurements readable and numerically
unchanged. The user requested implementation and the repository workflow is
fully automatic: record this specification before implementation, then test,
open an English PR, obtain both independent reviews and merge only with green CI.

## Measurement contract

- Use Netflix's native HDR VMAF v1.1.8 models, the standard-rate and HFR
  2160p variants. This is not SDR VMAF applied to PQ code values and does not
  use a tone-mapped SDR proxy.
- Initial media support is progressive, square-pixel, 23–30 fps or 50–60 fps,
  up to 4096×2160. A standard-rate model cannot score HFR input, or vice versa.
  Interlaced and higher-rate sources are not silently treated as the same
  calibrated viewing condition.
- Support HDR10/PQ and HLG/BT.2020 as well as Dolby Vision. Limit initial Dolby
  support to a single-layer HDR10-compatible base layer:
  profile 10, compatibility ID 1, PQ/BT.2020, limited-range 10-bit 4:2:0.
  Reject profile 5, profile 10 compatibility ID 0 and unknown color tags.
- For HLG, use zimg's exact display-referred HLG-to-PQ conversion with a fixed
  1000-nit peak, zero black, luma-weighted OOTF gamma 1.2, `npl=1000` and
  `agamma=false`. Preserve the original HLG transfer and these conditions in
  evidence. Label the result as HLG converted to PQ, not as a native HLG model.
  The runtime proof checks grayscale and saturated RGB reference values.
- This evaluates decoded HDR base-layer compression. Dolby RPU-driven display
  mapping, Dolby certification and physical display performance are outside
  this measurement's claim.
- Preserve the P3-D65/PQ RGB reference's precision. Explicitly transform it
  into a common BT.2020/PQ 16-bit YUV format with zimg; do not relabel its
  primaries or silently quantize the reference to eight or ten bits.
- Feed complete color attributes to libvmaf. Its HDR model converts the pair
  to limited-range BT.2020/PQ ICtCp 4:2:0 16-bit at its calibrated display size.
- Record model/hash, implementation/revision, original color attributes,
  normalization and comparison domain, base-layer scope and frame coverage.
  Give this protocol its own scoring generation. Never rank its scores against
  SDR scores as if the two had one measurement context.
- Run standalone no-reference CAMBI with the PQ EOTF explicitly selected and
  record that configuration separately from the HDR model's internal CAMBI
  feature options. HLG CAMBI applies the same recorded HLG-to-PQ conversion
  at 16-bit precision before the PQ detector. Preserve decoded presentation
  intervals and full coverage; distinguish its derived PQ domain from native
  PQ and SDR CAMBI. Existing SDR delivery thresholds are not inherited by
  manual HDR measurements; these reports show scores without a configured gate.
- Initial execution is local CPU with cancellation and existing resource
  admission. Keep the current SDR/native-GPU runtime and its numerical behavior.

## Media and API boundary

Add a manual `OUTPUT_HLS` measurement source for a clear, fixed-ladder,
full-length output with one unambiguous video target and a direct source.
Resolve Dolby VISION's original video MXF without treating its metadata file
as a video source. Reject transformed, encrypted, ambiguous or incomplete
output populations.

Read only storage objects bound to the encoding plan and selected HLS target.
Enforce finite VOD playlists, URI containment, resource limits and immutable
object witnesses. Retain the exact init-plus-fragments measurement object at
a job-owned, content-addressed location:
`<fMP4-prefix>/qc-retained/<qc-job-id>/<rendition>-<assembled-sha256>.mp4`.
Derive the key only after hashing the assembled bytes. Different captures by
stale attempts cannot overwrite one another, even for the same QC job. Reusing
an existing key still requires a pinned readback and full SHA-256 verification.
Bind subsequent QC previews to the plan, job and validated assembly hash;
never accept an arbitrary stored object path. Do not edit the saved encoding plan, rewrite
delivery files or start another paid Dolby encoding for this test.

Automatic new-encode HDR mirror compilation is deferred to a follow-up: this
increment supplies the existing-output QC path needed by the user's actual
AV1 Dolby Vision job. Unsupported automatic QC must remain an explicit refusal.

## Implementation and verification

Core protocol/command helpers and schemas belong in `packages/core/src/vmaf/`;
storage acquisition and measurement execution in `apps/worker/src/vmaf/`;
API/public evidence projection and existing QC views in `apps/web/src/`.
Tests are colocated Vitest tests. Preserve TypeScript types and strict evidence
validation; no disabled assertions, silent fallbacks or unmeasured zero values.

Commands (all invoked through `rtk proxy`):

```sh
pnpm --filter @bitovp/core exec vitest run <focused tests>
pnpm --filter @bitovp/worker exec vitest run <focused tests>
pnpm --filter @bitovp/web exec vitest run <focused tests>
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Use a failing test before each new behavior. Verify real HDR library/model
loading, identity scoring, color conversion, refusal cases and cancellation
with the built binary. Verify the report and preview in the application.
Run the full Sol Levante 6,314-frame QC after runtime readiness, reconcile the
exported frame population and publish the resulting BitOVP URL.

## Primary sources

- https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v1.md
- https://github.com/Netflix/vmaf/commit/a6ed0f18285cab504b779bbccb0bbaddc3bf44c2
- https://github.com/FFmpeg/FFmpeg/commit/58584087cfc34a6b0894886b23e3d912ca4568f2
- https://ott.dolby.com/OnDelKits/Dolby_Vision_Online_Delivery_Kit/v1/Documentation/Specs/Visio_Profiles/help_files/topics/c_dovi_profiles_public.html

The detailed source receipts and operational evidence are retained outside the
repository under `/Users/kazuhide/work/bitovp-hdr-qc-20261116/` and the Japanese
specification/results are persisted in the user's Obsidian vault.
