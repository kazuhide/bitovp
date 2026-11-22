# NVENC experiment runner

This optional Linux runtime produces measurements for training experiments. It encodes with the selected NVENC wrapper, decodes the result into CUDA frames with NVDEC, and scores every decoded frame with Netflix VMAF v0.6.1 on CUDA. The runner uploads software-decoded reference frames and passes CUDA frames directly from NVDEC through the distorted side of the scoring graph. The encoded Matroska file lives in a per-attempt temporary directory.

An experiment can also use the [BitOVP native CUDA scorer](../vmaf-gpu/README.md#build-on-linux) to score that Matroska file against the same reference window with `vmaf_v1.0.16_3d0h`. This second scorer decodes the encoded stream into CUDA frames in its own process. Set `VMAF_NATIVE_PATH` and `VMAF_MODEL_DIR` to absolute paths and run `probe` to confirm that `additionalScoringProfiles` advertises the optional model. The runner checks the scorer's experiment-window support, the pinned model SHA-256, and the GPU UUID and driver before advertising it.

## Build a local runtime

The independent runtime uses FFmpeg 8.0.1, the official Netflix libvmaf v3.2.1 source, CUDA, and Video Codec SDK 13.0 headers. The build script fetches those sources and the dav1d CPU decoder by exact commit and archive hash. Use a Linux NVIDIA host with GCC and G++, Make, NASM, Meson, Ninja, pkg-config, curl, and the CUDA toolkit on the build path. The RTX 5060 Ti verification used CUDA 13.0.88 and driver 580.178.04. [FFmpeg CUDA scoring inputs](https://ffmpeg.org/ffmpeg-filters.html#libvmaf_005fcuda) · [NVIDIA's FFmpeg setup](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html)

```sh
export PATH="/usr/local/cuda/bin:$PATH"
bash native/nvenc-experiments/build-runtime.sh /absolute/new/nvenc-runtime
export BITOVP_NVENC_FFMPEG=/absolute/new/nvenc-runtime/prefix/bin/ffmpeg
export BITOVP_NVENC_FFPROBE=/absolute/new/nvenc-runtime/prefix/bin/ffprobe
python3 native/nvenc-experiments/runner.py probe
```

The command places executables, model data and build sources in the supplied new directory. FFmpeg's build mode is marked by its configure script as not redistributable. This runtime is built for local use. The model defaults to `share/nvenc-experiments/vmaf_v0.6.1.json` in the same prefix, with an optional `BITOVP_NVENC_VMAF_MODEL` path. The runner requires the pinned model SHA either way. `BITOVP_NVENC_GPU_INDEX` defaults to CUDA ordinal 0 and respects the process's CUDA device visibility. The runner obtains the actual driver's maximum NVENC API version and encode GUIDs using `sdk-probe` next to FFmpeg, with an optional `BITOVP_NVENC_SDK_PROBE` path. It matches the two device UUIDs and lists codecs with actual NV12 encoding support and the compiled NVENC and NVDEC components. Encoder initialization checks each requested configuration at execution time. The capability record identifies the selected GPU UUID, driver, NVENC version, executable hashes and model hash.

## Measure one trial

The worker passes an internal JSON file with the source's resolved path. The source must contain one progressive square-pixel 1920 × 1080 video stream, limited-range BT.709 with 8-bit 4:2:0 samples. Frames use a zero-origin 30 fps presentation timeline. MP4/MOV and Matroska/WebM are the allowed demuxers. Windows use explicit rational units and begin and end on frame boundaries. Each window contains 1 to 3,600 frames.

```json
{
  "schemaVersion": 1,
  "sourcePath": "/absolute/registered-source.mkv",
  "trial": {
    "sourceId": "source-id",
    "window": {"timeBase": {"num": 1, "den": 30}, "startPts": "0", "endPtsExclusive": "90"},
    "codec": "H264",
    "preset": "P4",
    "tuning": "HIGH_QUALITY",
    "config": {
      "gopLength": 30,
      "frameIntervalP": 1,
      "rcParams": {
        "rateControlMode": "VBR",
        "averageBitRate": 2000000,
        "enableAQ": false,
        "lookaheadDepth": 0
      }
    }
  }
}
```

```sh
python3 native/nvenc-experiments/runner.py measure --request-file /absolute/trial.json
```

The writable options in this runtime are P1–P7, HQ tuning, GOP length, B-frame count via `frameIntervalP`, VBR target, maximum rate, VBV size, spatial AQ, temporal AQ and lookahead. Optional options are passed only when requested. `frameIntervalP=1` explicitly requests zero B-frames. The runner's implementation uses these FFmpeg bindings. SDK fields without a binding are documented by the catalog's support status.

A successful result includes the runtime ID, mean score and integer thousandths of a point, verified frame count, video payload byte sum, presentation duration and process wall times. The result's time base is 1/30. The encode wall time includes source decoding, upload, encoding and muxing. The GOP interval is present when encoded key-packet timestamps establish a regular interval. The runner verifies frame counts, presentation timestamps, geometry and color metadata on both inputs. The rate counts video packet bytes, including codec data within those packets. The encode and each requested scoring stage are limited to 300 seconds. The intermediate encoded file has a 1 GiB output limit.

Pass `--cpu-audit` to execute an additional software decode and libvmaf calculation on the same encoded artifact and source window. That diagnostic adds `cpuAudit` with the CPU mean, timings and GPU-minus-CPU difference for every frame. It uses the separate CPU filter in the same build. [Netflix VMAF v3.2.1 source](https://github.com/Netflix/vmaf/releases/tag/v3.2.1)

With the optional model advertised, add `"additionalScoringProfiles": ["bitovp-vmaf-cuda-1.0.16-3d0h"]` to `trial`. Its score or failure code appears in `additionalScores`. With `--cpu-audit`, the native scorer also compares against its pinned official CPU implementation before accepting the v1.0 score.

## Test the runner

```sh
python3 -B -m unittest discover -s native/nvenc-experiments -p '*_test.py'
```

The unit tests cover supported trial arguments, exact window arithmetic, the distinction between omitted and explicit options, timestamp and color admission, packet bytes, GOP observation, and full score coverage. Running against an NVIDIA board also requires the separate local runtime above.
