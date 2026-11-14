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
  model is unsupported, it uses the same model on the CPU. On a worker with a
  usable GPU it also scores a pair of files that GPU scoring does not take on
  the CPU, and the other pairs of the measurement on the GPU:
  [Pairs that GPU scoring does not score](#pairs-that-gpu-scoring-does-not-score).

The GPU belongs to the machine running the worker, not the browser. Automatic
selection requires the matching native scorer and supervisor on Linux; selecting
it does not install drivers or native tools. Configure `VMAF_NATIVE_PATH` and
`VMAF_MODEL_DIR` as described below. The worker chooses concurrency automatically;
additional comparisons wait for capacity.

A VMAF measurement that decides a delivery gate uses CPU scoring, including when
automatic GPU selection was requested. Live comparisons also stay on the CPU.
An unreadable input, an invalid native build, a failed CPU numerical check and
every other failure of a GPU run remain errors; they are not hidden by a CPU
retry. Only a pair that GPU scoring does not take is scored on the CPU in its
place.

Reports show the requested choice, actual decoding and scoring methods, and
the reason for a CPU selection, of the measurement or of one pair. The selected
backend, native build and device
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
rotation, HDR, and stream-selection settings produce an explicit error. With
**Local (GPU if available)**, the worker scores a pair with a rotated, HDR or
non-square-pixel file, or with a file of more than one video stream, on the
CPU instead:
[Pairs that GPU scoring does not score](#pairs-that-gpu-scoring-does-not-score).
The
worker currently requires software decoding with this scorer. A separate
standalone NVDEC-to-CUDA path is available for validation with unchanged
dimensions; it is not silently substituted into worker measurements.

Each GPU worker run also computes the official CPU reference. Every required
feature and every frame score must pass the numerical checks before a result
is accepted. Missing or duplicated values, different model/input hashes, an
unexpected source build, a different device, or a comparison other than the one
that the worker asked for fail the measurement. GPU scoring never retries a
failed GPU calculation with CPU scoring or another model.

The worker asks the scorer for the comparison that libvmaf makes through
FFmpeg, so that the score is that of **Local CPU**:
[GPU scores and Local CPU scores](#gpu-scores-and-local-cpu-scores). Build and
install the scorer again whenever an update of bitovp changes
`native/vmaf-gpu`.

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

### GPU scores and Local CPU scores

GPU scoring gives the score of **Local CPU**, which is that of libvmaf through
FFmpeg. Both scale the encode to the reference's size with the same bicubic
filter. A measurement on the GPU also

- compares pictures of the reference's bit depth, 8 or 10 bits;
- tells CAMBI, the banding feature inside the VMAF v1.0 models, nothing about
  the encode before it was scaled, as the FFmpeg command of **Local CPU** tells
  it nothing;
- is not started for a pair that FFmpeg converts before libvmaf compares it,
  or whose frames FFmpeg repeats or drops, because the GPU scorer does
  neither, but for the last frame of a Matroska file (below):
  [Pairs that GPU scoring does not score](#pairs-that-gpu-scoring-does-not-score).

Every GPU run computes a CPU reference, which is libvmaf itself on the
pictures and with the settings of that run, and a GPU result is taken only when
every frame's score is within 0.0001 of that reference and every feature within
about 0.000001.

On 2026-11-13 this was measured on one worker with an NVIDIA RTX 5060 Ti, for
the CUDA scorer, and an AMD Radeon 890M, for the Vulkan scorer. Each pair went
through the worker's scoring code on both GPUs and through the FFmpeg command
of **Local CPU**. In 148 comparisons the mean score of the CUDA scorer was
within 0.0000015 of the **Local CPU** score, and that of the Vulkan scorer
within 0.0000006. The references were 8-bit and 10-bit 4:2:0 files from 160 ×
216 to 1920 × 1080, in limited and in full range; the encodes were H.264, AV1
and FFV1 files of 8, 10 and 12 bits in 4:2:0, 4:2:2 and 4:4:4, of the
reference's size or scaled up from as little as 128 × 72; and three VMAF v1.0
models were used. 17 of the comparisons used a 10-second 1920 × 1080 clip of
Big Buck Bunny, as an 8-bit and as a 10-bit reference. The
[build record](../FFMPEG-BUILD.md#gpu-scoring-and-libvmaf-through-ffmpeg)
holds the comparisons.

On 2026-11-14 the command of **Local CPU** changed: it gives the reference one
frame for every frame interval of its frame rate, as it has always given the
encode
([Frame rates and frames that are left out](./QUALITY-AND-MONITORING.md#frame-rates-and-frames-that-are-left-out)).
That changed none of the scores above. The 148 comparisons were run again on
the same worker, and 132 were added, of 384 × 216 files with a constant frame
rate of 12 to 60 frames a second: references in Matroska, MP4 and MPEG-TS, and
encodes in H.264, HEVC, AV1, VP9 and MPEG-2, in MP4, fragmented MP4,
QuickTime, Matroska, WebM and MPEG-TS. In the 280 comparisons the mean score
of the CUDA scorer was within 0.0000016 of the **Local CPU** score, and that
of the Vulkan scorer within 0.0000006.

Later on 2026-11-14 the command of **Local CPU** came to count each file's
frame intervals from the file's first frame, and the GPU scorer to refuse a
pair whose frames do not come at the times that the frame rate gives them
([Pairs that GPU scoring does not score](#pairs-that-gpu-scoring-does-not-score)).
Since then a pair whose two files leave out the same frames, a pair whose
frames lie at another rate than the one that FFmpeg names for them, and a file
whose video starts about half a frame interval after its audio no longer
score differently with the two. The comparisons were run again on the same
worker with both changes, with 43 comparisons of new files: references in
HEVC, VP9, AV1 and MPEG-2, at 120 frames a second, of 75 and 90 seconds, of
3840 × 2160, and WebM, FLV, Matroska and MP4 files whose video starts after
their audio. 17 more followed the review of the change: 240 frames a second,
ten minutes at 60000/1001, Matroska files whose track header gives a frame
duration of another frame rate than that of their frames, and files whose last
frame lasts three intervals. In the 346 comparisons that GPU scoring scored
over the frames of **Local CPU**, the mean score of the CUDA scorer was within
0.0000016 of the **Local CPU** score, and that of the Vulkan scorer within
0.0000006. The scorer refused 25 pairs whose frames differ in number or in
time, and the worker scored them on the CPU. Three pairs with a long last
frame were scored over other frames than those of **Local CPU** (the list
below).

What follows:

- Scores of GPU scoring and of **Local CPU** can be compared with each other,
  and the comparison screen does not warn when it shows both.
- **Local (GPU if available)** gives one score for a pair, whether the worker
  scores it on a GPU or on the CPU, but for a Matroska file whose last frame
  lasts longer than one frame interval (below).
- A measurement that decides a delivery gate uses CPU scoring, and a model
  outside the eight VMAF v1.0 models is scored on the CPU with either choice.
- The worker takes a result only when the scorer's receipt shows the bit depth
  that the worker asked for and nothing told to CAMBI about the encode. A
  scorer that was built before this change tells CAMBI about the encode in
  every run, and the measurement then fails with
  `NATIVE_RECEIPT_COMPARISON_MISMATCH` and stores no score. A scorer that was
  built before the later change of 2026-11-14 scores a pair whose two files
  leave out the same frames, or whose frames lie at another rate than the one
  that FFmpeg names for them, and its score is not that of **Local CPU**. Build
  and install the scorer again after an update:
  [native scorer guide](../../native/vmaf-gpu/README.md). Then measure again
  the GPU reports whose reference has a variable frame rate or a frame rate
  that is not that of its frames
  ([Frame rates and frames that are left out](./QUALITY-AND-MONITORING.md#frame-rates-and-frames-that-are-left-out)
  shows how to see such files). Banding measurements work with either scorer.
- The scorer decodes and scales with the FFmpeg libraries of the machine on
  which it is built, not with the worker's FFmpeg. The comparison used those of
  Ubuntu 24.04 (FFmpeg 6.1.1) next to the worker's FFmpeg n8.1.3. A scorer
  that is built against other FFmpeg libraries was not measured.

Where a GPU score and a **Local CPU** score of one pair can still differ:

- **Workers of different processor architectures.** FFmpeg's scale filter
  makes other 8-bit pictures on x86-64 than on arm64. **Local CPU** therefore
  scores an encode that is scaled and compared in 8 bits differently on the
  two: 65.69 and 65.66 for the 640 × 360 encode of the table below, and up to
  0.26 apart with test patterns. An encode of the reference's size in 4:2:0,
  and a comparison in 10 bits, scored the same on both, except at the widths of
  the next point. A 4:2:2 encode of the reference's size that is compared in 8
  bits has its chroma scaled, and scored up to 0.09 apart. A GPU score is the
  **Local CPU** score of a worker of the GPU worker's architecture:
  [the score of one pair on arm64 and on x86-64](../FFMPEG-BUILD.md#the-score-of-one-pair-on-arm64-and-on-x86-64).
- **References of some widths on arm64.** libvmaf's own score depends there on
  the number of threads that it runs with: widths of 168 to 264 that are 8 more
  than a multiple of 16 gave means up to 2.12 apart, and such widths up to 472
  gave smaller differences. On the x86-64 worker of the comparison no width
  did, and its scores for such widths are not those of arm64: a 360 × 640 pair
  scored 56.27 there, and on arm64 47.99 with one thread and 48.58 with four,
  where it can also differ from run to run:
  [libvmaf and its thread count](../FFMPEG-BUILD.md#libvmaf-and-its-thread-count).
- **A Matroska file whose last frame lasts longer than one frame interval.**
  **Local CPU** repeats that frame for each interval that it lasts, and the
  GPU scorer, which reads where each frame starts, scores it once: 86.85 over
  74 frames beside 86.96 over 72, for 72 frames at 24 frames a second whose
  last frame lasts three intervals, whether the reference, the encode or both
  end so. In MP4 such a file has a lower average frame rate, and GPU scoring
  does not take the pair.

Not measured: other GPUs and drivers than the two above, frame rates above
240, and pictures larger than 3840 × 2160.

#### GPU results of scoring generations 9 and 10

Earlier GPU scoring carries the scoring generations 9 (CUDA) and 10 (Vulkan);
the GPU scoring above carries 12 and 13. The earlier scorer compared 10-bit
pictures whatever the reference was, and it told CAMBI the size and the bit
depth that the encode had before it was scaled. It gave the score of **Local
CPU** when the encode had the size of the reference and both files were 8-bit
4:2:0, and a higher score with a VMAF v1.0 model when the encode was scaled up.
The table shows a 10-second 1920 × 1080 reference of Big Buck Bunny (240
frames, 8-bit 4:2:0) and four H.264 encodes of it (x264, `veryfast`, CRF 26),
scored on one worker with an NVIDIA RTX 5060 Ti on 2026-11-12:

| Encode | Model | Local CPU | GPU scoring, generation 9 | Difference |
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
was 0.96 to 1.50 higher. With the two settings applied by hand to the CPU
method, libvmaf gave the GPU score to within 0.000001 in ten comparisons. On
2026-11-13, GPU scoring of generations 12 and 13 gave the **Local CPU** column
of the table for all eight, to within 0.000001.

- A stored result of generation 9 or 10 stays readable. For a scaled encode it
  is not the score that GPU scoring or **Local CPU** gives now, and the
  comparison screen warns when such a report is shown next to another.
- With files that are not 8-bit 4:2:0, a result of these generations can differ
  from **Local CPU** at equal sizes as well.
- A measurement of generation 9 or 10 is not continued by a retry. Create a new
  measurement to compare.

### Pairs that GPU scoring does not score

FFmpeg converts some pairs before libvmaf compares them, and the GPU scorer
makes no such conversion: it turns both files into 4:2:0 pictures of 8 or of 10
bits and changes nothing else. FFmpeg also repeats and drops frames so that
both files have one frame for every frame interval of the reference's frame
rate, and the GPU scorer compares the frames of the two files in their order.
For these pairs its score would not be that of **Local CPU**. In 22 measured
comparisons of the first kind the two differed by 0.00003 to 13.3. GPU scoring
is therefore not started for them:

| Pair | What FFmpeg does for **Local CPU** |
| --- | --- |
| The reference is 4:2:2 or 4:4:4, or has 12 bits or more | libvmaf compares in the reference's pixel format |
| The reference is `yuvj420p`, 8-bit full range as ffprobe names it for H.264, and the encode is not 8-bit 4:2:0 | FFmpeg converts the reference to the encode's format |
| One of the two files is full range and the other is not | FFmpeg converts one of them to the other's range |
| The two files name different colour matrices, or one of them names none | FFmpeg converts the encode to the reference's matrix, and it takes a file that names none for BT.601 |
| One of the two files leaves frames out, by what ffprobe says of it | FFmpeg repeats a frame for each that is left out |
| Both files leave out the same frames, or a file's frames come more than a quarter of a frame interval from where its frame rate puts them, as a screen recording's do or as those of a file whose frame rate is named wrongly, where ffprobe shows none of these (Matroska, WebM, MPEG-TS) | FFmpeg repeats a frame for each that is left out, and repeats or drops frames that come more than half an interval off the frame rate; the GPU scorer itself refuses the pair |
| The two files have different frame rates | FFmpeg repeats or drops frames of the encode |
| The two files have different numbers of frames | FFmpeg compares the rest of the longer file with the last frame of the shorter one |
| FFmpeg names two frame rates for the two files although they have one: 19001/317 for a Matroska or WebM file of 60000/1001 frames a second | FFmpeg changes neither file, and the GPU scorer itself refuses the pair |
| A file with non-square pixels, a rotation, HDR colour or more than one video stream | GPU scoring takes no such file |

So GPU scoring takes a reference in `yuv420p` or `yuv420p10le`, and a
`yuvj420p` reference with an 8-bit 4:2:0 encode. Of the encode's pixel format it
asks only that it is 4:2:0, 4:2:2 or 4:4:4 with 8, 10, 12 or 16 bits: an encode
in 4:2:2 or 4:4:4, or with 10 or 12 bits, is scored against such a reference.
16-bit encodes, `yuv422p12le` and `yuvj444p` encodes, and 4:4:4 encodes of
more than 8 bits, were not among the measured ones.

With **Local (GPU if available)**, the worker scores such a pair on the CPU,
with the command of **Local CPU** and so with its score, and the other pairs of
the measurement on the GPU. The report names the processor of each result and
the reason for the CPU. The worker finds most of these pairs before any
scoring, from what ffprobe says of the two files. The frame rates and frame
count that it reads there do not show a frame that a Matroska, WebM or MPEG-TS
file leaves out. GPU scoring finds such a pair when it reads the frames: it
stops at the first frame whose time is more than a quarter of a frame interval
apart in the two files, or from the time that the file's frame rate gives that
frame, counted from the file's first frame, or where one file ends before the
other. The worker then fetches the encode again and scores the pair on the
CPU. A scorer that was built before the later change of 2026-11-14 does not
stop where both files leave out the same frames or their frames lie at
another rate than the named one, and its score for such a pair is not that
of **Local CPU**: build it again
([GPU scores and Local CPU scores](#gpu-scores-and-local-cpu-scores)). The
scorer reads where each frame starts and not how long the last one lasts: a
Matroska file whose last frame lasts several intervals is scored on the GPU
(the same section).

A file whose frames come up to a quarter of a frame interval from where its
frame rate puts them passes this check: FFmpeg sends each such frame to its
own interval, and both give the same score. Frames that are moved by up to 0.2
of an interval scored the same with both; frames moved by up to 0.4 were
refused by the scorer and scored on the CPU, where FFmpeg also kept every
frame in its interval.

Two kinds of measurement ask for the GPU scorer itself: one with a reference
that is prepared for it
([display-scaled references](#separate-banding-from-a-display-scaled-reference-comparison)),
and one on a worker whose settings name the scorer (`VMAF_SCORING_BACKEND`)
for a plan without a local processing choice. Nothing is scored in the
scorer's place for them, and the measurement ends with an error that names the
reason:

```text
GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference's pixel format is yuv422p10le, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.
```

A failure of a GPU run that is no property of the pair, such as a numerical
check that does not pass, ends the measurement with either choice.

The row on colour matrices changes scores with **Local CPU** too, and it is how
FFmpeg's libvmaf filter works. Three pairs with the same pixel data, a 320 ×
180 encode against a 640 × 360 reference, scored 55.54 with no colour matrix
named in either file, 54.06 with `bt709` named in the reference alone, and
45.43 with `bt709` named in the encode alone.

### Small pictures

The VMAF v1.0 models do not score small pictures, with GPU scoring and with
**Local CPU** alike. The two pictures are compared at the size of the
reference. For GPU scoring, which compares 4:2:0 pictures, that size needs at
least 160, 266 or 318 pixels in width and in height, depending on the model,
and 216 in one of the two. The worker checks this before it starts the scorer,
and the measurement ends with the error that **Local CPU** gives for the same
pictures, which names the limit and what to do. A model of the `vmaf_v0.6.1`
family scores smaller pictures, on the CPU.

The size of the encode does not matter. GPU scoring of generations 9 and 10
refused an encode with a side below 144 pixels, or with both sides below 216,
even when the reference was large, because it told CAMBI the encode's size.

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
