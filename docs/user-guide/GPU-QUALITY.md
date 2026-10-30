# Experimental GPU quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

This branch adds two independent options for **local VOD** measurement:

| Option | GPU work | CPU work |
| --- | --- | --- |
| NVDEC decoding | Decode supported compressed inputs | Scaling, timing, VMAF and PSNR |
| VMAFx CUDA scoring | VMAF v1.0 feature extraction, optional PSNR | Decode unless NVDEC is enabled; scaling and timing |

Both are opt-in. The default remains CPU processing. Cloud jobs and Live
measurements retain their existing execution paths. Experimental generations
are **7** for VMAFx CUDA and **8** for NVDEC with CPU scoring. Neither can decide delivery
quality gates. Create a manual measurement of a completed encoding instead.

GPU numerical parity and performance on the target machine are not yet
qualified. An execution receipt confirms which backend ran; it does not prove
equivalence with the existing Netflix/libvmaf CPU implementation.

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

## Read the result

The rendition table distinguishes **VMAF processing** from decoding of the
reference and encoded video. CPU fallback reasons appear beside the result.
The JSON export includes the validated execution metadata, model hash and
CUDA feature names. Historical reports without this metadata remain readable.

CPU and memory admission limits still apply, including conservative exclusive
admission for VMAF v1.0. These limits are not GPU-memory estimates. Do not
increase concurrency on the assumption that CPU decoding has disappeared.

Before relying on these results, compare the same inputs and all frame scores
using Netflix CPU, VMAFx CPU and VMAFx CUDA. Include SDR/HFR, 8/10-bit inputs,
chroma differences, fractional frame rates and cropping. Measure elapsed time
including qualification, transfers and preprocessing, together with CPU,
system memory and GPU memory. A faster isolated kernel alone is not an
end-to-end speedup.
