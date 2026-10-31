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

## Measured example

On a Ryzen AI 9 HX 370 with a Radeon 890M and an RTX 5060 Ti, the official
CPU scorer was faster than either GPU path for the tested inputs. NVIDIA
hardware decoding reduced CPU time and host memory substantially.

The following results use the same 30-second, 1920 × 1080 Big Buck Bunny
input pair, all 720 frames, the `vmaf_v1.0.16_3d0h` model, and a common
10-bit comparison format. Times are medians of three runs. Host memory is
the largest process peak across those runs.

| Processing path | CPU scoring threads | Elapsed time | CPU time | Peak host memory |
| --- | ---: | ---: | ---: | ---: |
| Official CPU scorer | 4 | 6.35 s | 28.22 s | 561 MiB |
| Official CPU scorer | 8 | 6.19 s | 27.56 s | 917 MiB |
| CUDA, software decoding | 1 | 11.43 s | 12.55 s | 223 MiB |
| CUDA, NVDEC decoding | 1 | 8.12 s | 1.45 s | 220 MiB |
| AMD Vulkan, software decoding | 1 | 29.38 s | 14.95 s | 237 MiB |

CPU time sums the time used by all process threads; it can exceed elapsed
time. The NVIDIA paths allocated approximately 127 MiB of tracked GPU
workspace and the AMD path approximately 71 MiB. These counters exclude
driver allocations and decoder surfaces. Host memory excludes discrete GPU
memory; these columns cannot be treated as total machine memory use.

A separate 3840 × 2160 test pair with 128 frames and the
`vmaf_v1.0.16_3d0h_2160` model took 4.12 s on the CPU with four scoring
threads, 6.11 s with NVDEC/CUDA, and 24.08 s with AMD Vulkan. That short
repeated test clip is a separate workload, not a 4K version of the movie.
Increasing CPU scoring threads to 24 did not improve either longer test
and increased memory use.

These are standalone scorer measurements, including process startup,
decoding, result serialization, and shutdown. All GPU feature values,
frame scores, and pooled scores were checked against the CPU result
after timing. The worker's mandatory CPU verification adds work and is
not included in these GPU times. The resident NVDEC/CUDA path remains a
standalone option. These results support choosing CPU scoring for latency
on this machine; they do not establish a general GPU speed advantage.
