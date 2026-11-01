# Experimental GPU quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

Local VOD measurements have two separate GPU options:

| Option | GPU work | CPU work |
| --- | --- | --- |
| NVIDIA hardware decoding with the existing scorer | Decode supported compressed inputs | Scaling and official libvmaf scoring |
| Owned CUDA or Vulkan scorer | VMAF v1.0 image features and PSNR | Decode and common pixel conversion, official model prediction, small final statistics, and numerical verification |

Both are optional. CPU processing remains the default. Cloud jobs and Live
measurements keep their existing execution paths. Experimental GPU scoring
cannot decide delivery gates.

## Choose local processing

The VOD quality settings and VMAF Lab offer **Local CPU** and **Local (automatic
GPU selection)** alongside configured cloud profiles.

- **Local CPU** uses CPU decoding and scoring, even if the worker's environment
  requests a GPU. This is the default for new measurements created in the GUI.
- **Local (automatic GPU selection)** checks the worker's hardware and matching
  native installation. For a supported VMAF v1.0 model, it tries NVIDIA CUDA,
  then AMD Vulkan. If no supported GPU or native runtime is available, or the
  model is unsupported, it uses the same model on the CPU.

The GPU belongs to the machine running the worker, not the browser. Automatic
selection requires the matching native scorer and supervisor on Linux; selecting
it does not install drivers or native tools. Configure `VMAF_NATIVE_PATH` and
`VMAF_MODEL_DIR` as described below. The worker chooses concurrency automatically;
additional comparisons wait for capacity.

A measurement that decides a delivery gate uses CPU scoring, including when
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
