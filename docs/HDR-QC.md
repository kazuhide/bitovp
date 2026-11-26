# HDR QC — Dolby Vision, HDR10 and HLG

From VMAF Lab, choose **Measure an existing job…** and select a finished job and
an HDR model with the frame-rate range below. This measurement runs on the
local CPU using the [isolated HDR runtime](FFMPEG-BUILD.md#isolated-hdr-qc-runtime)
included in the normal Docker Worker image.

For a machine client, send the finished job ID, `source: "OUTPUT_HLS"`, an
explicit HDR `model`, and `execution: {"backend":"LOCAL","localMode":"CPU"}`.
Set `banding: true` to include PQ CAMBI with VMAF. This protocol does not accept
PSNR, a banding-only request, or an SDR measurement method. See
[VMAF compute selection](API-USAGE.md#vmaf-compute-selection) for the request contract.

## Measurement contract

- Use Netflix's native HDR VMAF v1.1.8 models, the standard-rate and HFR
  2160p variants. This is not SDR VMAF applied to PQ code values and does not
  use a tone-mapped SDR proxy.
- Eligible media is progressive, square-pixel, 23–30 fps or 50–60 fps,
  up to 4096×2160. A standard-rate model cannot score HFR input, or vice versa.
  Interlaced and higher-rate sources are not silently treated as the same
  calibrated viewing condition.
- The protocol accepts HDR10/PQ and HLG/BT.2020. Dolby Vision measurement uses
  a single-layer AV1 HDR10-compatible base layer:
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
- When requested, run no-reference CAMBI with the PQ EOTF explicitly selected and
  record that configuration separately from the HDR model's internal CAMBI
  feature options. HLG CAMBI applies the same recorded HLG-to-PQ conversion
  at 16-bit precision before the PQ detector. Preserve decoded presentation
  intervals and full coverage; distinguish its derived PQ domain from native
  PQ and SDR CAMBI. Existing SDR delivery thresholds are not inherited by
  manual HDR measurements; these reports show scores without a configured gate.
- Local CPU resource admission and cancellation apply. See
  [local quality resources](OPERATIONS.md#local-quality-resources).

## Media and API boundary

The manual `OUTPUT_HLS` source requires a clear, fixed-ladder, full-length
output with an unambiguous video target for each selected rendition and a
direct reference source. For a Dolby Vision plan with separate metadata, the
reference is its original video source. Transformed, encrypted, ambiguous or
incomplete targets are refused.

Read only storage objects bound to the encoding plan and selected HLS target.
Enforce finite VOD playlists, URI containment, resource limits and immutable
object witnesses. Retain the exact init-plus-fragments measurement object at
a job-owned, content-addressed location:
`<fMP4-prefix>/qc-retained/<qc-job-id>/<rendition>-<assembled-sha256>.mp4`.
Derive the key only after hashing the assembled bytes. Different captures by
stale attempts cannot overwrite one another, even for the same QC job. Reusing
an existing key still requires a pinned readback and full SHA-256 verification.
QC previews are bound to the plan, job and validated assembly hash. Measuring
an existing output reads the original delivery files and saves its own
measurement object and report. Run this as a separate post-encode step for HDR
outputs.

## Verification reference

The original [HDR QC integration](https://github.com/kazuhide/bitovp/pull/139)
was exercised on a finished 12 Mbps AV1 Dolby Vision 10.1 Sol Levante output.
The report export contained all 6,314 frames. See the
[HDR proof record](FFMPEG-BUILD.md#hdr-proof-record) for fixture coverage and
the exact FFmpeg and libvmaf runtime.

## Primary sources

- https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v1.md
- https://github.com/Netflix/vmaf/commit/a6ed0f18285cab504b779bbccb0bbaddc3bf44c2
- https://github.com/FFmpeg/FFmpeg/commit/58584087cfc34a6b0894886b23e3d912ca4568f2
- https://ott.dolby.com/OnDelKits/Dolby_Vision_Online_Delivery_Kit/v1/Documentation/Specs/Visio_Profiles/help_files/topics/c_dovi_profiles_public.html
