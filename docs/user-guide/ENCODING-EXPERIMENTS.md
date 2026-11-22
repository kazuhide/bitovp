# Local NVIDIA encoding experiments

Encoding experiments run short, repeatable NVENC trials and measure the resulting picture quality. A trial produces VMAF scores, video-packet bytes, display duration, processing time, and runtime identity. Use the campaign export as training input.

The first runtime accepts one progressive BT.709 limited-range 1920×1080, 30 fps, 8-bit 4:2:0 video track in MP4 or Matroska. It accepts frame-aligned windows of 1 to 3,600 frames, one of H.264, HEVC, or AV1, and the versioned VBR parameters shown in the app. The CPU may decode the source before uploading it. NVDEC supplies CUDA frames of the encoded output to the official VMAF-CUDA `vmaf_v0.6.1` scorer. The SDK catalog includes inventory entries for settings without a runner binding.

## Prepare the Linux worker

Build the [pinned private runtime](../../native/nvenc-experiments/build-runtime.sh) on a Linux system with a compatible NVIDIA driver, CUDA Toolkit, and C/C++ build tools. The build needs Meson, Ninja, NASM, pkg-config, make, curl, and Python. Hold the assets and the worker work directory on the same managed Linux host as the web app, or mount the same directory into both deployments. The Web process needs read access to registrations and the worker health file. Only operators and the worker should have write access to its managed directories.

```bash
bash native/nvenc-experiments/build-runtime.sh /srv/bitovp/nvenc-runtime
export BITOVP_EXPERIMENTS_ROOT=/srv/bitovp/experiments
export BITOVP_NVENC_FFMPEG=/srv/bitovp/nvenc-runtime/prefix/bin/ffmpeg
export BITOVP_NVENC_FFPROBE=/srv/bitovp/nvenc-runtime/prefix/bin/ffprobe
export BITOVP_NVENC_VMAF_MODEL=/srv/bitovp/nvenc-runtime/prefix/share/nvenc-experiments/vmaf_v0.6.1.json

python3 native/nvenc-experiments/runner.py probe
pnpm --filter @bitovp/worker experiments:worker
```

Run the worker with Node.js 24 or newer, the BitOVP PostgreSQL runtime connection, and `flock`. Configure `BITOVP_NVENC_GPU_INDEX` to choose the NVIDIA device. A worker runs one trial at a time and binds campaign execution to the reported GPU, driver, model, and runtime binaries. For comparable performance, dedicate the GPU to the campaign for the measurement period. A driver or runtime change requires a new campaign.

To measure VMAF v1.0 alongside v0.6.1, build the [BitOVP native scorer](../../native/vmaf-gpu/README.md#build-on-linux) with `--cuda` and set `VMAF_NATIVE_PATH` and `VMAF_MODEL_DIR` to the absolute paths of the new `bitovp-vmaf` executable and its installed model directory. Restart the experiment worker and create a campaign from the capability that advertises `bitovp-vmaf-cuda-1.0.16-3d0h` in `additionalScoringProfiles`. The capability binds the built scorer, the `vmaf_v1.0.16_3d0h` model, and the CUDA device used for the experiment.

Register a local file for its organization. The command copies it into managed storage and reports the registered source ID.

```bash
pnpm --filter @bitovp/worker experiments:register-source \
  <organization-uuid> /absolute/path/to/source.mkv "Training clip"
```

## Run a campaign

In **Encoding experiments**, create a campaign and choose a source. Set the codec and other settings in the JSON trial request and queue it. Use **Pause** to stop additional claims and **Resume** to admit pending trials. **Seal** closes submissions. **Cancel** cancels unfinished trials, including the active one. Use the CLI to export the result rows.

External clients can use a token from **Settings → API tokens**. Choose the purpose **Encoding experiments · Run** for submissions and control or **Encoding experiments · Read** for retrieval. The token is scoped to the experiment API and its organization. Set `BITOVP_EXPERIMENTS_URL` and `BITOVP_API_TOKEN` in the client environment. The CLI accepts HTTPS and direct loopback HTTP for local development.

```bash
node scripts/encoding-experiments.mjs capabilities
node scripts/encoding-experiments.mjs catalog
node scripts/encoding-experiments.mjs sources
node scripts/encoding-experiments.mjs create --file campaign.json
node scripts/encoding-experiments.mjs enqueue <campaign-id> \
  --file trials.json --idempotency-key <stable-submission-key>
node scripts/encoding-experiments.mjs seal <campaign-id>
node scripts/encoding-experiments.mjs watch <campaign-id>
node scripts/encoding-experiments.mjs export <campaign-id> --format ndjson
```

Create inputs carry `schemaVersion: 1`, `name`, and the current `capabilityId`. The queue accepts `{ "schemaVersion": 1, "trials": [...] }` in batches of at most 128. Each trial uses a registered `sourceId`, a time base and start/end PTS, codec, preset, tuning, and typed config. Use distinct `replicateId` values for intentional repeats. Retrying the same batch with the same idempotency key returns the original receipt. Results paginate against a fixed completion sequence.

Enable **Also measure VMAF v1.0.16** in the app or include `"additionalScoringProfiles": ["bitovp-vmaf-cuda-1.0.16-3d0h"]` in a trial submitted through the CLI or API. The worker encodes once, then both scorers use that file and the same reference window. Each scorer decodes the encoded frames with NVDEC and processes them on CUDA. The reference may be software-decoded. The result and NDJSON export keep the v0.6.1 score in `scoreMilli` and `meanVmaf`. The `additionalScores` entry contains either the v1.0 score, scoring time, and scorer and model hashes or its failure code. A v1.0 scoring failure preserves a successfully measured v0.6.1 result.

**Settings → Reset data** keeps encoding experiment campaigns, trials and their measurement results, and accepted batch receipts. These records are retained even when every available reset category is selected.

## Select a setting with Lean

Build the [Lean selection executable](../../verification/lean/encoding-experiments/README.md) and set `BITOVP_EXPERIMENTS_OPTIMIZER` in the web process to its absolute path. Select the best trial for one source and window in the app or from the CLI.

```bash
cd verification/lean/encoding-experiments
lake build
python3 -B test_cli.py
```

```bash
node scripts/encoding-experiments.mjs select <campaign-id> --file constraints.json
```

The request uses `schemaVersion: 1`, the trial's `sourceId` and `window`, and optional `codec`, `bitrateLimitBps`, `encodeTimeLimitMs`, and `gopFrames` in `constraints`. The top-level `scoringProfileId` defaults to `official-vmaf-cuda-0.6.1`. Set it to `bitovp-vmaf-cuda-1.0.16-3d0h` to select by v1.0 scores. Each selection uses a single model. The result records the candidate digest and counts for eligible, ineligible, and incomplete rows. Lean verifies maximum score among the supplied feasible observations. Measured VMAF and timing come from the GPU worker's receipts. The Lean CLI also accepts predicted values from a separate model pipeline.
