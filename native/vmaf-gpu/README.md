# Experimental GPU VMAF scorer

This optional executable computes VMAF v1.0 features with owned CUDA or Vulkan
code. It uses the official Netflix libvmaf model predictor and pooling methods.
The regular bitovp installation continues to use CPU scoring by default.

GPU scoring is experimental. The worker checks every measured feature and frame
score against the official CPU implementation during each run. A mismatch fails
the measurement. GPU selection does not silently switch scoring to the CPU.

## Build on Linux

Use Python 3.12 or later, a C/C++ compiler, CMake 3.24 or later, Meson, Ninja,
NASM, pkg-config, and FFmpeg development libraries for `libavformat`, `libavcodec`,
`libavutil`, and `libswscale`. The command downloads a fixed official libvmaf
archive, checks its SHA-256 hash, and builds it without CUDA support as the CPU
reference. It does not patch FFmpeg or install system packages.

```sh
python3 native/vmaf-gpu/build.py \
  --work-dir "$HOME/.cache/bitovp-vmaf-build" \
  --prefix "$HOME/.local/bitovp-vmaf" \
  --test
```

For NVIDIA, add `--cuda` and put the CUDA Toolkit's `bin` directory in `PATH`.
The default targets the visible GPU. For a build host without that device, set
`--cuda-architectures` explicitly to the target's CMake architecture value.
For Vulkan, add `--vulkan`; Vulkan headers, a loader, a hardware driver, and
`glslangValidator` must be available. Both flags can be used in the same build.
GPU tests run on real hardware; a software Vulkan device is rejected.

Build artifacts stay in the selected work directory. Use a different work
directory when changing toolchains or the pinned upstream revision.

## Check a video pair

Use local reference and encoded files with matching frame rates and aligned
content. The executable compares every frame. It rejects missing timestamps,
misaligned timestamps, format changes, and unequal frame counts. It scales both
inputs to the same comparison dimensions and preserves all three color planes.

```sh
VMAF_PREFIX="$HOME/.local/bitovp-vmaf"
"$VMAF_PREFIX/bin/bitovp-vmaf" \
  --reference reference.mp4 \
  --distorted encoded.mp4 \
  --model "vmaf_v1.0.16_3d0h=$VMAF_PREFIX/share/bitovp-vmaf/model/vmaf_v1.0.16_3d0h.json" \
  --backend cuda --bit-depth 10 --threads 4 \
  --verify-cpu --output result.json
```

Use `--backend cpu` without `--verify-cpu` for the official CPU reference.
Use `--backend vulkan --vendor amd` for an AMD GPU. `--device` selects a device
index within the chosen API; CUDA and Vulkan indices can refer to different
physical devices. The result records the actual device name, index, and UUID.

Inspect the selected GPU without opening a video or loading a model:

```sh
"$VMAF_PREFIX/bin/bitovp-vmaf" --device-info --backend cuda
"$VMAF_PREFIX/bin/bitovp-vmaf" --device-info --backend vulkan --vendor amd
```

The JSON identifies the GPU UUID, driver, source, and executable. It also reports
supported frame concurrency and separates `memoryTotalBytes` from
`memoryAvailableBytes`. The latter is a snapshot, not a memory reservation.
Vulkan reports a process-budget hint for the scorer's storage heap only when
`VK_EXT_memory_budget` is available. This is the process budget minus estimated
process use, not whole-device free memory. Otherwise the available value is `null`.
The nullable `pciBusId` uses the same canonical form across CUDA and Vulkan.
An integrated GPU also shares the host's RAM limit. `driverVersionKnown: false`
means that the driver build could not be identified for calibration reuse.
A `null` executable hash also prevents calibration reuse.
The older `memoryBudgetBytes` diagnostic has backend-specific semantics and
must not be interpreted as available memory.

Repeat `--model id=path` to compute multiple models in the same pass. The eight
supported standard/high-frame-rate models are installed under
`share/bitovp-vmaf/model`. HDR models are outside this experimental scope.

The JSON contains full-precision per-frame features and VMAF values, model and
input hashes, a source/CPU-library build fingerprint, selected device, CPU parity, timing, and
memory counters. Existing output files are never overwritten. A failed run does
not publish a partial result. `hostCopiedInputBytes` counts host-buffer copies;
it does not imply that every byte crossed a PCI Express connection.

Vulkan scoring overlaps software decoding with GPU work. It keeps at most one
following reference/encoded frame pair ready, using about 12 MiB of extra active
pixel storage for 1080p, 10-bit comparisons, plus allocation and thread overhead.
Use process wall time to compare performance: decode, conversion, and extraction
times can overlap.

On Linux, the build also installs `bitovp-vmaf-supervisor` beside the scorer.
Its source and protocol must match the scorer. The device query reports
`processSupervisor` and the companion's hash. VMAF workers can use the internal
`--supervise` command mode to tie a direct native or FFmpeg subprocess to its
owner and an absolute boot-time heartbeat deadline that includes host suspend. This mode disables MPS only
in that subprocess's environment. Regular scoring commands retain their original
behavior. The supervisor is not a sandbox for arbitrary process trees.

## Check banding on one video

The additive `--metric cambi` mode extracts no-reference CAMBI without a reference
video or a VMAF model. It preserves original encoded dimensions and 8/10-bit
precision and analyzes every decoded frame through EOF.

```sh
"$VMAF_PREFIX/bin/bitovp-vmaf" --capabilities
"$VMAF_PREFIX/bin/bitovp-vmaf" --metric cambi \
  --distorted encoded.mp4 --backend cuda --verify-cpu \
  --threads 4 --decode-threads 2 --output banding.json
"$VMAF_PREFIX/bin/bitovp-vmaf" --metric cambi \
  --distorted encoded.mp4 --backend vulkan --vendor amd --verify-cpu \
  --threads 4 --decode-threads 2 --output banding-amd.json
```

Use `--backend cpu` without `--verify-cpu` for the official standalone CPU
oracle. The production worker's CPU route uses FFmpeg's feature-only libvmaf
filter; it does not require installing this optional native executable.

This mode uses official extractor defaults, including `cambi_max_val=1000`,
rather than a prediction model's clipped CAMBI feature. Higher CAMBI scores mean
more banding; the often cited observed score 24 is not a schema maximum.
Every GPU frame is checked against an independent official CPU context using
the unchanged bound `1e-6 + 1e-7 * abs(cpu)`. The receipt retains actual GPU
values and CPU reference values; quality decisions use the CPU reference.

Only SDR, square-pixel inputs with one video stream are supported. Pixel formats
must be limited-range (or range-unspecified) `yuv420p` or `yuv420p10le`; RGB,
full-range and implicit format conversion are rejected. Dimensions
must be even, each between 144 and 7680, with at least one dimension >=216.
Presentation transforms, source precision changes and corrupt frames fail.
Only software decoding and one in-flight frame are supported in this mode.
Reference/model, resize, forced bit-depth and partial-frame options are rejected.

Frame times come from relative presentation timestamps and positive decoded
frame durations, including the last frame. VFR durations and gaps are retained;
no average frame rate is used to invent coverage. Missing/duplicate/backward or
overlapping timing fails instead of publishing a partial result.

The separate `CAMBI_NR` receipt records complete frame coverage, raw and CPU
scores, resolved options, input/build/device identities, CPU parity, timing and
resource counters. The existing VMAF receipt and version/device-info protocols
are unchanged. `--capabilities` reports compiled modes/backends without claiming
an available GPU. See [the standalone receipt contract](BANDING.md) for exact
keys and failure behavior. Existing output files are never replaced.

## Use from the bitovp worker

Set `VMAF_NATIVE_PATH` to the built executable, `VMAF_MODEL_DIR` to the installed
model directory, and `VMAF_SCORING_BACKEND` to `cuda` or `vulkan`. Restart the
worker after changing its environment. CPU scoring remains the default.

This first integration supports ordinary SDR, square-pixel VOD inputs. Unsupported
timing, crop, color, or sampling settings produce an explicit error. Hardware
decoding with CPU scoring remains a separate option. The worker uses software
decoding with the owned scorer. Standalone validation can use `--decode cuda`
with CUDA scoring: supported NV12/P010 input surfaces remain on the GPU while
being converted to planar samples. This path requires unchanged dimensions;
GPU resizing and precision reduction are rejected. With `--verify-cpu`, an
independent software decode is compared as well.
The worker passes file paths and settings to a child process, then reads its
result JSON. Decoded video frames stay inside the native process; they do not
cross the TypeScript boundary for each frame. The worker currently also runs
the CPU comparison for every frame, so its total cost includes that verification.
Measurements made with a previous experimental scorer keep their original
provenance and require a new measurement to use this implementation.

## Compare performance

`benchmark.py` runs CPU worker-count trials and the selected GPU backends on the
same files, dimensions, bit depth, models, and frames. It checks every result
against the CPU feature and score series before including it in the summary.
The default includes CUDA with software decoding, resident NVDEC-to-CUDA, and
AMD Vulkan. Use `--backends cpu,cuda,vulkan` when the input codec or dimensions
are outside the resident decoder's scope.

```sh
python3 native/vmaf-gpu/benchmark.py \
  --binary "$VMAF_PREFIX/bin/bitovp-vmaf" \
  --reference reference.mp4 --distorted encoded.mp4 \
  --model "vmaf_v1.0.16_3d0h=$VMAF_PREFIX/share/bitovp-vmaf/model/vmaf_v1.0.16_3d0h.json" \
  --output-dir ./vmaf-benchmark
```

The default is three trials per setting. Results include process wall time
(including startup and file hashing), scoring time, frames per second, CPU time,
peak process memory, and GPU workspace/copy counters. Trials run sequentially to
avoid competition between devices. For a representative comparison, stop other
CPU/GPU work and use a clip long enough to separate startup from sustained work.
GPU acceleration is not guaranteed to be faster than the CPU implementation.
These standalone timings do not include the worker's input preparation or its
mandatory in-process CPU verification. The benchmark checks GPU results against
separate CPU runs instead; measure the complete worker path before estimating
application throughput.

The benchmark requires GNU `time` and collects CPU time and peak resident memory
after each complete process exits, including JSON generation and cleanup.
Native JSON resource counters are an earlier diagnostic snapshot, explicitly
labelled `before-result-serialization`; they are not used as the benchmark's
completed-process CPU or memory measurements.

See [NOTICE](NOTICE) and [the upstream license](licenses/Netflix-vmaf.txt) for
source and binary redistribution notices. FFmpeg build options and external GPU
toolkit licenses also apply to the resulting binary.
