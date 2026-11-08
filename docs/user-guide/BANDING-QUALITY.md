# Banding quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

CAMBI measures visible banding in the encoded video without a reference video.
Zero means no detected banding; larger scores mean more banding. The detector
does not use a VMAF prediction model or its clipped CAMBI feature. Banding and
VMAF measure different aspects of the picture, so compare their values separately.

## Request a measurement

Enable quality measurement in **Settings → Features** and reload the application.
In the VOD wizard, select banding on its own or together with VMAF/PSNR. QC-only
encodes can produce just the video mirrors used for measurement. In the quality
lab, select an eligible completed VOD job to measure its existing clear MP4
outputs or QC mirrors. Banding-only measurements need readable encoded outputs;
they do not need a readable source video or a VMAF model file.

Existing QC mirrors can be measured later with another metric. VMAF requires a
readable reference video for the selected outputs. Combined measurements reject
outputs whose references cannot be resolved, rather than omitting their banding
results; use banding-only measurement for those outputs.

Choose **Local CPU** or **Local (GPU if available)**. Banding is local VOD only:
cloud execution and Live capture are not supported. Requesting cloud banding
fails validation, including when VMAF is requested alongside it.

The initial detector accepts supported SDR, square-pixel, 8-bit or 10-bit video.
Each dimension must be at least 144 pixels, at least one must be 216 or greater,
and neither may exceed 7,680. Unsupported precision, HDR, display transforms or
ambiguous frame timing fail explicitly. The measurement preserves encoded
dimensions and precision; it does not resize to a VMAF reference.

With the official default extractor options, both CPU and GPU also require width
plus height to be at most 6,092 pixels. UHD 4K (3,840 × 2,160) fits; DCI 4K
(4,096 × 2,160) and 8K are outside this initial scope. Unsupported sizes are
reported before scoring; the application does not resize them or change the
detector options to make them fit.

## Interpret scores and affected intervals

Reports show CAMBI mean, minimum, maximum and measured frame count. The graph
uses presentation time, with up to 1,500 points preserving CAMBI peaks. Full-frame
CSV/JSON exports retain all stored scores, presentation times and durations.

Banding alone records scores without setting a pass/fail threshold. Add a
**CAMBI maximum** rule to configure a warning or failure upper bound for each
rendition and Per-Title rung. Equality passes. A warning breach is shown without
failing delivery; a failure breach follows the selected quality-gate policy.
Missing, invalid or incomplete measurements fail closed even for warning rules.

The editor's suggested warning value of 5 is a starting point for visual review,
not a universal quality requirement. Viewing distance, screen size and content
affect visibility. Review representative content before choosing bounds.
See the [official CAMBI documentation](https://github.com/Netflix/vmaf/blob/74f930d17de8c58e7c2ce55e2b897b0030ebd8ef/resource/doc/cambi.md).

Affected intervals are derived from every measured frame before graph reduction.
Their ends are exclusive. Warning and failure intervals are separate, and timing
gaps are not counted as detected banding. Variable frame rates use actual decoded
timestamps and frame durations, rather than an assumed average frame rate.
An unconfigured threshold is not a quality pass.

### Inspect an affected interval

Select **Play … s** in an affected-interval row to open the measured rendition at
that interval. Playback stops at its exclusive end. Use **Replay interval** to
repeat it, or select another row to replace the active video. Closing the preview
stops playback and returns keyboard focus to the selected row. Only one interval
preview runs at a time, including when switching renditions.

This works for banding-only and combined reports without a VMAF reference or a
reference frame rate. It uses the saved presentation-time interval and the
browser's first video presentation time, preserving variable frame timing and
measurement gaps. Browser seeking can display an adjacent frame; this is visual
inspection rather than proof of exact frame identity, and it does not change
scores or gate decisions.

Playback requires the retained MP4/WebM QC output with the same pinned object
version and readable storage credentials. It uses the report's authenticated,
organization-bound media URL. Unsupported media, changed/deleted objects, missing
provenance or a browser that cannot establish video presentation time remain
unavailable. Scores, graphs and intervals remain readable. No new clip or cloud
encoding is created.

## CPU and GPU setup

CPU measurement uses FFmpeg with the libvmaf CAMBI feature enabled. This worker
image pins an updated FFmpeg 8.1.3 build with the CAMBI fixes for 144-pixel encode
dimensions and 10-bit input strides. External FFmpeg builds need libvmaf 3.2.0
or a compatible revision with those fixes, and features-only CAMBI extraction.
The reported library identity can be a release or a Git revision; it is retained
as reported. Banding-only processing does not load a VMAF model.

Optional GPU processing uses the matching owned native scorer and supervisor
from this source revision. Follow the [native build instructions](../../native/vmaf-gpu/README.md)
and configure `VMAF_NATIVE_PATH`. Existing older native binaries do not expose
the new CAMBI capability; AUTO can select CPU when the capability is unavailable.
No driver or native tool is installed by selecting GPU in the GUI.

AUTO tries supported NVIDIA CUDA, then AMD Vulkan. Decoding stays on the CPU.
Every GPU frame is checked against the official CPU extractor using the existing
absolute tolerance of 0.000001 plus relative tolerance of 0.0000001. Invalid
inputs, changed identities, malformed receipts and parity failures remain errors.

Stored execution provenance retains the actual backend, build and input identities,
extractor options and verification results; reports identify the actual backend
and CPU-reference decisions. GPU values and canonical CPU reference values are
stored separately; thresholds and intervals use the CPU reference at the same
adaptive decimal precision as the official libvmaf JSON logger. Unrounded
native CPU reference values are retained too. This makes
small accepted GPU rounding differences irrelevant to threshold decisions.
Verification adds CPU work, so GPU extraction does not imply faster total jobs.

VMAF delivery gates retain their existing CPU-only rule. A combined measurement
can therefore use CPU VMAF and CPU-verified GPU CAMBI, with separate execution
metadata. Historical VMAF reports and downloads remain readable.
