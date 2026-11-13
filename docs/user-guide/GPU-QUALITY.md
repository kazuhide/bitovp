# Experimental GPU quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

Local VOD measurements have separate GPU options:

| Option | GPU work | CPU work |
| --- | --- | --- |
| NVIDIA hardware decoding with the existing scorer | Decode supported compressed inputs | Scaling and official libvmaf scoring |
| Owned CUDA or Vulkan scorer | VMAF v1.0 image features and PSNR | Decode and common pixel conversion, official model prediction, small final statistics, and numerical verification |
| Owned no-reference CAMBI scorer | Banding feature extraction | Decode, official CPU reference extraction, numerical verification and threshold decisions |

GPU options are optional. CPU processing remains the default. Cloud jobs and Live
measurements keep their existing execution paths. Experimental GPU scoring
cannot decide VMAF delivery gates. CPU-verified CAMBI supports its own banding
bounds; see [banding quality measurement](./BANDING-QUALITY.md) for setup and limits.

## Choose local processing

The VOD quality settings and VMAF Lab offer **Local CPU** and
**Local (GPU if available)** alongside configured cloud profiles.

- **Local CPU** uses CPU decoding and scoring, even if the worker's environment
  requests a GPU. This is the default for new measurements created in the GUI.
- **Local (GPU if available)** checks the worker's hardware and matching
  native installation. For a supported VMAF v1.0 model, it tries NVIDIA CUDA,
  then AMD Vulkan. If no supported GPU or native runtime is available, or the
  model is unsupported, it uses the same model on the CPU.

The GPU belongs to the machine running the worker, not the browser. Automatic
selection requires the matching native scorer and supervisor on Linux; selecting
it does not install drivers or native tools. Configure `VMAF_NATIVE_PATH` and
`VMAF_MODEL_DIR` as described below. The worker chooses concurrency automatically;
additional comparisons wait for capacity.

A VMAF measurement that decides a delivery gate uses CPU scoring, including when
automatic GPU selection was requested. Live comparisons also stay on the CPU.
Input validation errors, invalid native builds and failed CPU numerical checks
remain errors; they are not hidden by a CPU retry. GPU scoring still requires
the supported settings described below.

Reports show the requested choice, actual decoding and scoring methods, and
the reason for a CPU selection. The selected backend, native build and device
are pinned for a measurement so that resuming it cannot mix implementations.
Creating a new measurement with **Remeasure** retains the requested choice and
selects again. Historical plans without an explicit choice show **Local (worker
settings)** and retain their original environment-based behavior until changed.

## Hardware decoding with CPU scoring

Use an NVIDIA GPU and an FFmpeg build with CUDA/NVDEC support. NVDEC is the
GPU's video decoder; it is separate from the processors used for VMAF arithmetic.
The worker needs access to both CUDA and NVIDIA's video-decoding libraries.
See NVIDIA's [FFmpeg setup guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html).

For the historical **Local (worker settings)** option, set these values in the
worker's environment, then restart the worker:

```dotenv
VMAF_SCORING_BACKEND=cpu
VMAF_DECODE_BACKEND=auto
VMAF_GPU_DEVICE=0
```

`auto` checks each input with a short decode. Known 8-bit and 10-bit 4:2:0
H.264, HEVC, VP9, and AV1 formats are considered; H.264 10-bit and unsupported
formats stay on the CPU. Actual support depends on the GPU and FFmpeg build.
Decoded frames are downloaded with their color planes and bit depth preserved
before the existing CPU scorer runs.

Container crop and rotation metadata can make software and hardware decoders
return different pictures. A nonzero container crop or a display transform
keeps that input on the CPU in `auto` mode. The other input may still use NVDEC.
Use an `FFPROBE_PATH` executable that reports **Frame Cropping** and **Display
Matrix** side data. The separate `VMAF_FFMPEG_PATH` option affects local VOD
measurement, not the Live feeder or cloud image.

If CUDA is unavailable, `auto` records the reason and uses CPU decoding. A known
device failure permits one CPU-decoding retry after the child process closes.
Corrupt inputs, cancellation, unknown errors, and probe timeouts do not trigger
that retry. `VMAF_DECODE_BACKEND=cuda` requires both inputs to pass and fails
instead of choosing CPU decoding. `cpu` skips hardware discovery.

## Owned GPU scoring

The optional native scorer uses owned CUDA/Vulkan feature extractors and the
official Netflix libvmaf predictor. It does not require an external FFmpeg fork
or a VMAF filter patch. Build instructions are in the
[native scorer guide](../../native/vmaf-gpu/README.md).

Example worker settings for a Linux native installation:

```dotenv
VMAF_SCORING_BACKEND=cuda
VMAF_DECODE_BACKEND=cpu
VMAF_GPU_DEVICE=0
VMAF_NATIVE_PATH=/opt/bitovp-vmaf/bin/bitovp-vmaf
VMAF_MODEL_DIR=/opt/bitovp-vmaf/share/bitovp-vmaf/model
```

Explicit GUI choices override `VMAF_SCORING_BACKEND`, `VMAF_DECODE_BACKEND` and
`VMAF_GPU_DEVICE`. These three variables continue to control historical plans
without a local processing choice. For those plans, use
`VMAF_SCORING_BACKEND=vulkan` for an AMD GPU. The selected Vulkan device must be
an AMD hardware GPU. CUDA and Vulkan device indices are separate; the measurement
records the actual device name, index, and UUID.

The initial worker integration accepts ordinary SDR, square-pixel VOD inputs
with matching cadence and aligned content. It supports the eight bundled
standard/high-frame-rate VMAF v1.0 models. Unsupported sampling, timing, crop,
rotation, HDR, and stream-selection settings produce an explicit error. The
worker currently requires software decoding with this scorer. A separate
standalone NVDEC-to-CUDA path is available for validation with unchanged
dimensions; it is not silently substituted into worker measurements.

Each GPU worker run also computes the official CPU reference. Every required
feature and every frame score must pass the numerical checks before a result
is accepted. Missing or duplicated values, different model/input hashes, an
unexpected source build, or a different device fail the measurement. GPU
scoring never retries a failed GPU calculation with CPU scoring or another model.

This verification adds CPU work. Benchmarking the qualified GPU extractor
alone and measuring the current worker's end-to-end time answer different
questions. Compare both before choosing a deployment setting.

## Prepare a repeatable BBB codec comparison

Inspect the source metadata and qualify the worker's native installation before
submitting paid jobs. A GPU being present does not establish that the scorer,
model, input format and numerical verification are supported. Keep each codec
in a separate encoding job with a unique output prefix. A fixed comparison
ladder can use these video targets at the source's unchanged frame rate:

| Rendition | Dimensions | Target video bitrate |
| --- | --- | ---: |
| 1080p | 1920 × 1080 | 2,000,000 bps |
| 720p | 1280 × 720 | 1,000,000 bps |
| 540p | 960 × 540 | 600,000 bps |
| 360p | 640 × 360 | 300,000 bps |

Target bitrate and measured video bitrate are separate values; retain both when
comparing results.

### One muxing per native HEVCv2 stream

The internal native HEVCv2 profile uses `SMART_PASS`. Each video stream can feed
only **one muxing resource**. A delivery muxing plus the compiler-generated QC
MP4 are two resources, even when both use MP4. Requesting VMAF, PSNR or Banding
creates that QC mirror; disabling VMAF alone does not remove it when Banding is
still enabled. Validation rejects this combination before job creation.

For a quality-only comparison, use `qc.only:true`. Keep the four video renditions
and their muxing destination entries, but remove audio renditions, manifests,
DRM, thumbnails, sprites, keyframes and AI scene analysis. The destination
entries tell the compiler where to write each QC MP4; their delivery muxings
are not created. This produces one MP4 per video stream. The same quality-only
recipe can be used for H.264, HEVCv1 and AV1. Extra storage destinations on a
single muxing (`deliveryMirrors`) do not create additional muxing resources.

The 2026-11-10 BBB test with the internal HEVCv2 BCF build
`v2.325.0-461-g85df7fd6c6` and encoder `BETA` also encountered a provider error
while creating a DASH fMP4 representation: HTTP 400, code 1001, `codecType` null.
Treat DASH for that profile/build as an outstanding qualification gap and use
the MP4-only comparison recipe. This observation is not a general DASH ban;
requalify that packaging path separately when the provider implementation changes.
Repeating an unchanged rejected plan does not resolve either constraint.

### Separate Banding from a display-scaled reference comparison

Some BBB MOV sources carry a nonidentity display-scale matrix despite a zero
rotation angle. The native VMAF guard rejects that reference. Inspect the actual
source; do not infer eligibility from the filename or `rotation:0` alone.

For a source with this known display-scale metadata, start with automatic
**Banding-only** QC so that the encode produces its QC MP4s without scheduling
an already unsupported reference-based VMAF run:

```json
{
  "qc": {
    "vmaf": false,
    "psnr": false,
    "banding": true,
    "only": true,
    "execution": { "backend": "LOCAL", "localMode": "AUTO" }
  }
}
```

After the encoding is `FINISHED` and its automatic measurement has settled,
submit a manual VMAF measurement through the application's normal API. For a
supported H.264, 8-bit 4:2:0 SDR reference with positive axis-aligned display
scaling, square pixels and no crop, rotation or reflection, the explicit request
is:

```http
POST /api/vmaf-jobs
Content-Type: application/json

{
  "encodingJobId": "<finished-encoding-job-id>",
  "model": "vmaf_v1.0.16_3d0h",
  "banding": false,
  "source": "QC_MIRROR",
  "execution": { "backend": "LOCAL", "localMode": "AUTO" },
  "referencePreparation": "LOSSLESS_DISPLAY_SCALE_REMUX"
}
```

Preparation stream-copies a temporary reference and verifies every encoded
packet, decoded frame, codec setting and timestamp before scoring. It compares
the **coded raster**, explicitly ignoring display scaling; it does not validate
the displayed presentation. Unsupported transforms remain errors. This explicit
preparation requires a qualified native GPU and fails instead of selecting CPU.
The source object and completed encoding plan stay unchanged. The report and
JSON export retain both file hashes, the original display matrix and complete
equivalence evidence.

Ordinary eligible references with no presentation transform can continue to use
automatic VMAF and Banding together; they do not need this preparation option.
Before accepting a comparison, check all four rungs per codec, complete expected
frame coverage, the VMAF v1 model, actual `localExecution.scoring.backend` and
`bandingExecution.backend`, and CPU verification. A queued job, selected AUTO
mode or GPU utilization by itself does not establish a completed GPU result.

## Automatic local scheduling

On Linux, a matching native scorer and supervisor enable automatic resource
planning. Leave `VMAF_THREADS` and `VMAF_CONCURRENCY` blank. The worker selects
calculation threads, decoder threads, simultaneous comparisons, and the number
of GPU frames in flight from the available CPU, RAM, GPU memory and video settings.
An explicit thread value stays fixed; an explicit concurrency value is an upper
bound shared across local jobs.

For a new hardware, driver, model and video-format combination, the worker times
a short sample with the same CPU verification used by complete measurements.
It chooses a resource-efficient plan within five percent of the fastest measured
throughput. This is a bounded search of measured candidates. Source length and
available memory are checked again for each complete comparison.

The first search has a 30-second budget for starting trials; an active trial
finishes or stops before its resources are released. Subsequent comparisons use
the saved measurements. A worker that later has room for a higher concurrency
limit can make one additional bounded search for that limit. Inputs without
exact video frame counts keep a conservative serial plan. The private cache contains
timing and memory metadata. Temporary video samples are removed after analysis.
Unknown device memory or an unrecognized driver retains a conservative serial
plan. Worker logs describe the selected plan and its reason.

When more work is submitted than the selected capacity, excess jobs wait in the
queue. Comparisons inside admitted jobs also share one resource pool. Input
preparation waits for a permit before opening or downloading media. Completing
or cancelling a comparison releases its capacity for the next waiting item.
Several workers on the same host coordinate execution through their shared
Redis connection. Memory pressure can reduce overlap while existing calculations
finish. Cloud jobs retain their separate limit; Live comparisons retain their
sequential order and CPU scoring. A Live capture reserves the host's shared
CPU and memory capacity through preparation, scoring and cleanup. Other local
measurements wait for that reservation to finish.

Keep the matching native executable and supervisor together. Their Linux
heartbeat and parent-death guards stop owned calculations after worker failure.
The worker retains the reservation until its child processes close. Installs
without the native pair retain the existing local execution policy.

## Inspect hardware and control standalone concurrency

The native scorer can inspect a GPU without opening a video or loading a model:

```sh
/opt/bitovp-vmaf/bin/bitovp-vmaf --device-info --backend cuda
/opt/bitovp-vmaf/bin/bitovp-vmaf --device-info --backend vulkan --vendor amd
```

The JSON identifies the selected GPU, driver, native build, and supported frame
concurrency. It reports total memory separately from currently available memory.
A missing available-memory value is `null`; it is not permission to queue
unlimited work. Vulkan's value, when available, is a process-budget hint rather
than a measurement of all free device memory. An integrated GPU also consumes
shared host RAM. These values describe the moment of the query and do not
reserve resources.

For standalone GPU measurements, `--inflight-frames` accepts `1`, `2`, or `4`.
The default is `1`. A value of `2` or `4` keeps several frame slots ready so that
GPU work can overlap. It preserves frame order and temporal feature checks,
but requires more memory for active pictures and feature buffers. A larger
value does not guarantee better performance. Compare complete-process time and
memory on the same files before increasing it, especially when other
measurements share the GPU. CPU scoring accepts only `1`.

The Linux build installs `bitovp-vmaf-supervisor` beside the scorer. Keep the
matching pair together when copying or updating an installation. The
`--device-info` result reports whether the matching companion is available and
includes its binary hash. The scorer's internal `--supervise` mode lets a VMAF
runner bind a direct native or FFmpeg process to its owner and a continuously
renewed deadline. If the owner exits, stops renewing, or loses the heartbeat
channel, the supervised calculation stops. The deadline includes host suspend.
This requires Linux kernel timer support; failure prevents the calculation from
starting. NVIDIA Multi-Process Service (MPS) is bypassed only for the supervised
command. Ordinary standalone commands keep their existing behavior.

## Read and compare results

The quality report separates decoding from VMAF calculation and labels GPU
scoring as experimental. CUDA and Vulkan use separate measurement generations;
the existing hardware-decode/CPU-score path retains its own generation. A retry
cannot relabel a measurement made with a different experimental configuration.
Create a new manual measurement after changing the scorer.

Historical measurements retain their original provenance. The retired
`vmafx-cuda` environment value is rejected with a migration message.

The [benchmark command](../../native/vmaf-gpu/README.md#compare-performance)
compares the same files, models, dimensions, bit depth, and complete frame
interval. It tests a range of CPU worker counts and checks all GPU values
against the CPU result. It records wall time, CPU time, process memory, GPU
workspace, and explicit host/device copy counters. Shared-memory buffer copies
do not necessarily represent PCI Express traffic. GPU utilization alone does
not establish a speed improvement.

### GPU and CPU scores of an encode that is scaled up

GPU scoring and **Local CPU** gave the same score when the encode had the size
of the reference and both files were 8-bit 4:2:0. When the encode was smaller
and was scaled up for the comparison, GPU scoring gave a higher score with a
VMAF v1.0 model in every measured comparison. The table shows a 10-second
1920 × 1080 reference of Big Buck Bunny (240 frames, 8-bit 4:2:0) and four
H.264 encodes of it (x264, `veryfast`, CRF 26), scored on one worker with an
NVIDIA RTX 5060 Ti:

| Encode | Model | Local CPU | GPU scoring (CUDA) | Difference |
| --- | --- | --- | --- | --- |
| 1920 × 1080 | `vmaf_v1.0.16_3d0h` | 89.3967 | 89.3967 | 0 |
| 1280 × 720 | `vmaf_v1.0.16_3d0h` | 83.0392 | 83.9955 | +0.96 |
| 960 × 540 | `vmaf_v1.0.16_3d0h` | 76.5315 | 77.8302 | +1.30 |
| 640 × 360 | `vmaf_v1.0.16_3d0h` | 65.6920 | 66.8866 | +1.19 |
| 1920 × 1080 | `vmaf_v1.0.16_5d0h` | 91.7224 | 91.7224 | 0 |
| 1280 × 720 | `vmaf_v1.0.16_5d0h` | 86.9876 | 87.9444 | +0.96 |
| 960 × 540 | `vmaf_v1.0.16_5d0h` | 82.2540 | 83.5575 | +1.30 |
| 640 × 360 | `vmaf_v1.0.16_5d0h` | 73.1233 | 74.3396 | +1.22 |

In all, seven comparisons at equal sizes from 216 × 160 to 1920 × 1080 agreed
to within 0.000001, and in fifteen comparisons of a scaled encode the GPU score
was 0.96 to 1.50 higher. The other nine had a 640 × 360 reference, encodes of
320 × 180, 256 × 144 and 216 × 144, and three models. Every file of these 22
comparisons was 8-bit 4:2:0.

Both methods scale the encode with the same bicubic filter. The difference
comes from CAMBI, the banding feature inside the VMAF v1.0 models, which the
two methods feed differently:

- GPU scoring always compares 10-bit pictures, so it writes the scaled picture
  with 10 bits. **Local CPU** compares in the reference's pixel format: with an
  8-bit reference the scaled picture has 8 bits.
- GPU scoring tells CAMBI the size and the bit depth that the encode had
  before it was scaled, with libvmaf's options `enc_width`, `enc_height` and
  `enc_bitdepth`. **Local CPU** does not. libvmaf's CAMBI documentation
  describes these options for an encode that was scaled before the
  measurement.

With both applied by hand to the CPU method, libvmaf gave the GPU score to
within 0.000001 in ten comparisons: the scaled encodes of the table, the
320 × 180 encode with three models, and the first row. Applied in this order,
the first raised the scores of the scaled encodes by 0.28 to 1.12 and the
second by a further 0.23 to 0.67.

Files that are not 8-bit 4:2:0 were not measured, and the two methods can
differ there at equal sizes as well:

- With a 10-bit reference and an 8-bit encode, both methods compare 10-bit
  pictures, and only GPU scoring tells CAMBI that the encode had 8 bits. For
  the first row of the table, with both files converted to 10 bits by hand,
  libvmaf gave 88.1395 without the encode's bit depth and 89.3967 with it.
- With an 8-bit reference and a 10-bit encode, **Local CPU** compares in the
  reference's 8 bits, and GPU scoring compares 10-bit pictures and tells CAMBI
  that the encode had 10.
- With a 4:2:2 or 4:4:4 reference, GPU scoring compares in 4:2:0 and **Local
  CPU** in the reference's layout.

What follows:

- Compare a score only with scores from the same scoring method. The quality
  report shows the method that each measurement used.
- **Local (GPU if available)** scores on the GPU where the worker has one and
  on the CPU where it has not, so one choice can give either score.
- The CPU reference that every GPU run computes uses the GPU method's pictures
  and CAMBI settings. It checks the GPU arithmetic. It is not the **Local
  CPU** score.
- A measurement that decides a delivery gate uses CPU scoring, and a model
  outside the eight VMAF v1.0 models is scored on the CPU with either choice.
  The `vmaf_v0.6.1` family has no CAMBI feature.
- bitovp does not convert one score into the other. The Vulkan scorer, other
  content, 10-bit files and 4:2:2 or 4:4:4 references were not measured for
  this note.

### Small encodes and small references

The VMAF v1.0 models do not score small pictures. GPU scoring refuses some
small comparisons that **Local CPU** scores, because it compares every pair in
4:2:0 and always tells CAMBI the encode's size:

- An encode with a side below 144 pixels, or with both sides below 216, is
  refused even when the reference is large. With a 640 × 360 reference, GPU
  scoring scored encodes of 256 × 144 and 216 × 144 and refused 214 × 144,
  200 × 200, 144 × 144, 240 × 134 and 142 × 256. **Local CPU** scored all
  seven.
- A small 4:4:4 or 4:2:2 reference is held to the limits of 4:2:0 pictures: at
  least 160, 266 or 318 pixels in width and in height, depending on the model,
  and 216 in one of the two.

The measurement ends with an error that names the limit and what to do. Where
the limit is that of GPU scoring alone, and the reference is in a pixel format
that libvmaf takes as it is, the error says that it does not hold with **Local
CPU**. A model of the `vmaf_v0.6.1` family scores smaller pictures.

## Measured examples

The following standalone results compare the implementation before GPU kernel
optimization (`668ee7c`) with the optimized implementation (`c4d4af8`). They use
an AMD Ryzen AI 9 HX 370, Radeon 890M, and NVIDIA RTX 5060 Ti.

Each input pair contains 30 seconds of 1920 × 1080 H.264 video: 720 frames for
Big Buck Bunny and 750 for Valkaama. A high-quality H.264 reference and a
4 Mbps H.264 encode were prepared from each source. These are performance
fixtures, not lossless reference masters for judging absolute picture quality.
Both implementations use the same files, the `vmaf_v1.0.16_3d0h` model, a common
10-bit comparison format, and two decoder threads per input. Values are medians
of three complete runs, in seconds.

| Content | Implementation | CPU scoring threads | CPU | NVDEC + CUDA | AMD Vulkan |
| --- | --- | ---: | ---: | ---: | ---: |
| Big Buck Bunny | Before optimization | 4 | 6.46 | 8.72 | 29.24 |
| Big Buck Bunny | Optimized | 4 | 6.47 | 5.94 | 20.50 |
| Valkaama | Before optimization | 8 | 9.61 | 9.04 | 28.64 |
| Valkaama | Optimized | 4 | 9.90 | 6.04 | 20.26 |

CPU scoring threads were selected from four- and eight-thread trials for each
content and implementation; the candidates were close enough that the selected
count changed for Valkaama. GPU runs use one host scoring thread. The Vulkan
path uses software decoding; the NVIDIA path keeps decoded pictures on the GPU.

The optimization distributes integer row reductions across more GPU threads
and keeps small matrix intermediates in shared memory, the GPU's on-chip working
storage. Per-pixel arithmetic, row rounding, models, and parity tolerances are
preserved. The NVIDIA path became faster than the CPU in these examples. The
AMD GPU also improved, but remained slower than the CPU. GPU residency alone
does not ensure a speed advantage: small dependent stages and synchronization
can still limit useful parallel work. Measure the files and models used in your
own workload before choosing a backend.

Times include process startup, input hashing, decoding, result serialization,
and shutdown. All GPU feature values, frame scores, and pooled scores were
checked against separate CPU results after timing. The worker's input
preparation and mandatory CPU verification are not included in these GPU times.
The resident NVDEC/CUDA path remains standalone-only, so these figures do not
represent current GUI job throughput.

The NVIDIA path used about 127 MiB of tracked GPU workspace and the AMD path
about 71 MiB. These counters exclude driver allocations and decoder surfaces.
Host process memory, discrete GPU memory, and shared APU memory are different
measurements and must not be added together without accounting for shared pages.
The AMD hardware qualification here covers the Radeon 890M APU; AMD discrete
GPUs require separate qualification.

### Batched extractor comparison

A later comparison starts from `db35fc2`, which already includes the dedicated
Vulkan row pipeline. SpEED now batches the independent matrices for both color
planes and both pictures before collecting their small statistics on the CPU.
CAMBI sums its mask in two integer passes, using the existing mask buffers.
The image scratch buffers are reused; no full-frame copy is added.

The same 30-second fixtures, hardware, model, 10-bit comparison format, and two
decoder threads are used here. Each value is the median of three alternating
before/after pairs, following one warmup per build and content. All pairs were
faster and the observed before/after ranges did not overlap. Times are seconds.
The final native source fingerprint starts with `6620732d61c7`.

| Content | GPU path | Before | After | Time reduction |
| --- | --- | ---: | ---: | ---: |
| Big Buck Bunny | NVDEC + CUDA | 5.89 | 4.17 | 29.2% |
| Big Buck Bunny | AMD Vulkan | 19.63 | 14.52 | 26.0% |
| Valkaama | NVDEC + CUDA | 6.05 | 4.56 | 24.7% |
| Valkaama | AMD Vulkan | 19.43 | 15.15 | 22.0% |

The extra tracked NVIDIA workspace was 110,900 bytes for this model; the AMD
workspace peak stayed unchanged. Separate component trials found about a 4%
CUDA CAMBI improvement for Big Buck Bunny, while Valkaama's process time stayed
within measurement noise. An attempt to enqueue multiple model configurations
before CPU aggregation also stayed within noise and was not retained.

Every timed result passed full CPU feature, frame-score, and pooled-score
checks. Integer masks were also checked exactly in 350 cases per GPU backend.
These are standalone timings with the scope described above; current GUI jobs
also perform input preparation and additional CPU verification.
