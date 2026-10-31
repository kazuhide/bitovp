# Experimental GPU quality measurement

[Back to quality and monitoring](./QUALITY-AND-MONITORING.md)

Local VOD measurements have two separate GPU options:

| Option | GPU work | CPU work |
| --- | --- | --- |
| NVIDIA hardware decoding with the existing scorer | Decode supported compressed inputs | Scaling and official libvmaf scoring |
| Owned CUDA or Vulkan scorer | VMAF v1.0 image features and PSNR | Decode and common pixel conversion, official model prediction, small final statistics, and numerical verification |

Both are optional. CPU processing remains the default. Cloud jobs and Live
measurements keep their existing execution paths. GPU experiments require a
manual measurement of a completed encoding and cannot decide delivery gates.

## Hardware decoding with CPU scoring

Use an NVIDIA GPU and an FFmpeg build with CUDA/NVDEC support. NVDEC is the
GPU's video decoder; it is separate from the processors used for VMAF arithmetic.
The worker needs access to both CUDA and NVIDIA's video-decoding libraries.
See NVIDIA's [FFmpeg setup guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html).

Set these values in the worker's environment, then restart the worker:

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

Example worker settings for NVIDIA:

```dotenv
VMAF_SCORING_BACKEND=cuda
VMAF_DECODE_BACKEND=cpu
VMAF_GPU_DEVICE=0
VMAF_NATIVE_PATH=/opt/bitovp-vmaf/bin/bitovp-vmaf
VMAF_MODEL_DIR=/opt/bitovp-vmaf/share/bitovp-vmaf/model
```

For an AMD GPU, use `VMAF_SCORING_BACKEND=vulkan`. The selected Vulkan device
must be an AMD hardware GPU. CUDA and Vulkan device indices are separate;
the measurement records the actual device name, index, and UUID.

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
scoring never silently selects CPU scoring or another model.

This verification adds CPU work. Benchmarking the qualified GPU extractor
alone and measuring the current worker's end-to-end time answer different
questions. Compare both before choosing a deployment setting.

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
