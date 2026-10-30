# Experimental GPU quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

Two independent options are available for **local VOD** measurement:

| Option | GPU work | CPU work |
| --- | --- | --- |
| NVDEC decoding | Decode supported compressed inputs | Scaling, timing, VMAF and PSNR |
| VMAFx CUDA scoring | VMAF v1.0 feature extraction, optional PSNR | Decode unless NVDEC is enabled; scaling and timing |

Both are opt-in. The default remains CPU processing. Cloud jobs and Live
measurements retain their existing execution paths. Experimental generations
are **7** for VMAFx CUDA and **8** for NVDEC with CPU scoring. Neither can decide delivery
quality gates. Create a manual measurement of a completed encoding instead.

The checks below cover numerical comparisons, decoding and performance for
the tested inputs and settings. An execution receipt confirms which backend
ran; numerical comparisons require the actual scores.

## GPU decoding with the existing CPU scorer

Use an NVIDIA GPU and an FFmpeg build with CUDA/NVDEC support. The NVIDIA
driver must expose both CUDA and video-decoding libraries to the worker.
See NVIDIA's [FFmpeg setup guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html).

Add these values to the worker's environment, then restart the worker using
your normal installation procedure:

```dotenv
VMAF_DECODE_BACKEND=auto
VMAF_GPU_DEVICE=0
```

`auto` checks each input separately using a few decoded frames. The initial
implementation accepts known 8-bit and 10-bit 4:2:0 H.264, HEVC, VP9 and AV1
formats; H.264 10-bit and other formats stay on the CPU. Actual support also
depends on the GPU and FFmpeg build. Frames are downloaded with their chroma
and precision intact before the existing CPU processing.

Presentation metadata needs special care. FFmpeg's software path applies MOV
clean-aperture cropping and display-matrix transforms, while NVDEC can return
the original coded picture. One cropped input produced 608×342 CPU frames but
640×360 NVDEC frames. Scaling those different pictures does not restore parity.

When an input has a nonzero container crop, a display matrix that changes the
picture, or a legacy rotation tag requiring a transform, `auto` keeps that
input on CPU decoding and records the reason. The other input can still use
NVDEC. Strict `cuda` mode rejects the input with an explicit reason instead.
Zero cropping, an exact identity display matrix and HDR metadata alone do
not prevent CUDA decoding.

These checks use the executable selected by `FFPROBE_PATH`, including when
`VMAF_FFMPEG_PATH` selects a separate scoring binary. Use a compatible probe
that reports **Frame Cropping** and **Display Matrix** side data. The ffprobe
from the native FFmpeg 8.1.3 installation was verified for these checks.

When CUDA is unavailable, `auto` uses CPU decoding and records the reason.
A recognized device failure during scoring permits one CPU-decoding retry.
Cancellation, corrupt input, unknown errors and probe timeouts do not trigger
that retry. `cuda` requires both inputs to pass qualification and fails instead
of selecting CPU decoding. `cpu` disables hardware discovery entirely.

## VMAF v1.0 calculation on the GPU

The official `libvmaf_cuda` implementation does not provide all the feature
extractors used by the bundled VMAF v1.0 models. Selecting it or substituting a
v0.6.1 model would not satisfy this mode.

This experimental path uses an **external VMAFx-enabled FFmpeg**. It is not
included in bitovp's normal image or release package. The integration targets
[VMAFx commit f69ae15](https://github.com/VMAFx/vmafx/tree/f69ae15fd834c71c366b64b26db5133884674e88)
and its new `vmafx` filter, built against FFmpeg 9.0.2. VMAFx's older public
RC3 was withdrawn and does not contain this filter. Follow the pinned
project's [FFmpeg integration instructions](https://github.com/VMAFx/vmafx/blob/f69ae15fd834c71c366b64b26db5133884674e88/ffmpeg-patches/README.md).
VMAFx and FFmpeg retain their own licenses; they are not covered by bitovp's
MIT license.

Configure a separate executable and the directory containing the bundled
Netflix model files:

```dotenv
VMAF_FFMPEG_PATH=/opt/bitovp-vmafx/bin/ffmpeg
VMAF_MODEL_DIR=/opt/vmaf/model
VMAF_SCORING_BACKEND=vmafx-cuda
VMAF_GPU_DEVICE=0
VMAF_DECODE_BACKEND=cpu
```

Keep CPU decoding for the first comparison. Enable NVDEC afterward to measure
its additional effect. `VMAF_FFMPEG_PATH` applies only to local VOD quality
measurement; the feeder continues to use `FFMPEG_PATH`.

The selected v1.0 model must match the bundled model's SHA-256 digest. Both
comparison inputs use planar 10-bit 4:2:0 after CPU scaling and before feature
extraction. CAMBI's encoded dimensions and bit depth describe the original
distorted video, rather than this comparison canvas. Every frame is scored;
subsampling is rejected in this mode.
Existing timing and end-of-file behavior are retained. This is distinct from
the cloud-validated full-frame BT.709 method, which remains cloud-only.

A short scoring qualification runs before the full comparison. Both logs must
identify the pinned implementation, requested model and all required CUDA
extractors. Missing, mixed CPU/GPU, incomplete or inconsistent receipts fail
the measurement. GPU scoring never silently selects CPU scoring or another
model. The final JSON is parsed once and reused for result pooling.

## Verified hardware scope

The pinned VMAFx source and FFmpeg 9.0.2 were built and tested on Ubuntu 24.04
with an RTX 5060 Ti 16 GB, NVIDIA driver 580.178.04 and CUDA 13.0. Across the
eight SDR/HFR v1.0 model variants for 1080p and 4K, 16 frames per model
produced **2,880 identical values** between VMAFx CPU and CUDA: every feature,
all three PSNR channels, frame scores, pooled metrics and aggregate metrics.

The existing Netflix CPU JSON agreed at its six-decimal printing precision;
the maximum absolute difference was below 0.0000005. This does not establish
numerical equivalence beyond the precision printed by that implementation.

NVDEC and CPU decoding matched in complete Y/Cb/Cr payloads and timestamps
for seven 24-frame cases: H.264 8-bit, plus HEVC, VP9 and AV1 at both 8 and
10 bits. A full-range H.264 8-bit case also matched. These results cover the
tested inputs and builds; presentation transforms still require the input
checks above.

A 1,000-frame H.264 case at 60000/1001 fps with a 4:3 sample aspect ratio
also matched in complete frame payloads, timestamps and aspect ratio.

## Measured performance

On the machine above, testing used 10- and 30-second Big Buck Bunny extracts:
1080p H.264, 8-bit, 24 fps, with 240 and 720 frames respectively. All frames
were measured with `vmaf_v1.0.16_3d0h` and Y/Cb/Cr PSNR. Each input was read
before timing to warm the filesystem cache. All 13 pilot and 30 repeat runs
passed. Both CUDA configurations matched the VMAFx CPU control in every frame
metric and pooled value throughout the repeat runs.

Pilot measurements selected the VMAF thread counts for this benchmark.
Decoder threads were fixed at two per input and filter-graph threads at one. Wall and CPU
times are medians of three repeat runs. Wall time includes process startup,
qualification where required, transfers and preprocessing. CPU time is summed
user and system time. RSS is the observed process-tree peak sampled every
100 ms; sampling does not guarantee the true peak.

| Path | VMAF threads | 10s wall (s) | 30s wall (s) | 30s CPU (s) | 30s RSS peak (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing CPU | 8 | 1.404 | 4.226 | 34.19 | 981.37 |
| Netflix CPU, matched 10-bit | 8 | 1.690 | 5.114 | 39.23 | 1144.70 |
| VMAFx CPU, matched 10-bit | 8 | 1.386 | 4.083 | 33.21 | 1076.26 |
| VMAFx CUDA, CPU decoding | 4 | 2.285 | 5.332 | 11.32 | 378.99 |
| VMAFx CUDA + NVDEC | 1 | 3.838 | 7.051 | 6.20 | 502.11 |

The existing v1.0 planner still defaults to one VMAF thread and exclusive
admission. Its single 30-second pilot run took **10.649 seconds**; this is not
a repeat median. The eight-thread CPU results above require manual tuning.
Matched CPU paths use CUDA's 10-bit preprocessing; the existing CPU path
retains its original method and can produce different scores.

For these short 1080p clips, neither GPU configuration improved wall time over
the tuned CPU paths. Both used less CPU time and system RAM, with transfers,
setup and qualification included in the measured cost. This does not establish
performance for 4K, longer assets or other workloads.

Observed device-wide GPU memory usage was approximately 477.6 MiB at baseline,
781.6 MiB during CUDA scoring and 1212.4 MiB with CUDA scoring plus NVDEC.
These totals include other device allocations and are not job-specific VRAM
measurements. They were sampled every 100 ms and may miss brief peaks.

## Read the result

The rendition table distinguishes **VMAF processing** from decoding of the
reference and encoded video. CPU fallback reasons appear beside the result.
The JSON export includes the validated execution metadata, model hash and
CUDA feature names. Historical reports without this metadata remain readable.

CPU and memory admission limits still apply, including conservative exclusive
admission for VMAF v1.0. These limits are not GPU-memory estimates. Do not
increase concurrency on the assumption that CPU decoding has disappeared.

When validating another machine or build, compare the same inputs and all
frame scores using Netflix CPU, VMAFx CPU and VMAFx CUDA. Include SDR/HFR,
8/10-bit inputs, chroma differences, fractional frame rates and cropping.
Measure total elapsed time and resource use against both the default CPU
settings and manually tuned CPU settings.
