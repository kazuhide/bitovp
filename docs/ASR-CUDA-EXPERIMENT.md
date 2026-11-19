# CUDA transcription experiment

Use the standalone `TRANSCRIBE` task to compare CPU and CUDA on the same prepared audio interval. A request can opt in with `parameters.asrBackend: "cuda"`. Omitting it uses the existing CPU path.

## Prepare the executable

Use an isolated Linux worker with an NVIDIA GPU and a matching CUDA toolkit. Build Whisper 1.9.5 from the same archive and with the same quality patch as the [worker image](../Dockerfile). The toolkit and device can be selected according to the documented [Whisper CUDA build options](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/README.md#nvidia-gpu-support). Run the following from the BitOVP repository root. Set `BITOVP_ASR_CUDA_ARCH` to the CMake architecture for the test device.

```sh
bitovp_asr_source=$(rtk proxy mktemp -d)
rtk proxy curl -fL https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037 -o "$bitovp_asr_source/whisper.tgz"
rtk proxy sha256sum "$bitovp_asr_source/whisper.tgz"
```

Check that the archive SHA-256 is `645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4` before extracting.

```sh
rtk proxy tar -xzf "$bitovp_asr_source/whisper.tgz" -C "$bitovp_asr_source" --strip-components=1
rtk proxy patch --directory="$bitovp_asr_source" -p1 --fuzz=0 < apps/worker/native/whisper-cli-quality.patch
rtk proxy python3 apps/worker/scripts/test-whisper-cli-quality.py "$bitovp_asr_source/examples/cli/cli.cpp"
rtk proxy cmake -S "$bitovp_asr_source" -B "$bitovp_asr_source/build" \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_IS_DEV=OFF -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_COREML=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$BITOVP_ASR_CUDA_ARCH"
rtk proxy cmake --build "$bitovp_asr_source/build" --target whisper-cli -j2
rtk proxy sha256sum "$bitovp_asr_source/build/bin/whisper-cli"
```

Set `WHISPER_CUDA_CLI_SHA256` to the executable's digest on Web and Worker, and set `WHISPER_CUDA_CLI_PATH` to its absolute path on Worker. Install the verified executable at a location writable only by the operator. Submit a fresh request key for each measurement. CUDA trials always run fresh across request keys and are excluded from generation dependencies while quality is evaluated.

The request is tied to the configured executable digest. The worker checks a private executable copy and runs both the version check and recognition from those bytes. Use a build that resolves its CUDA libraries when the executable is copied to a temporary directory. The worker retains the same ASR and VAD model verification and quality admission and requires CUDA initialization during the native ASR call. The result records the binary digest and device. The device is `null` for silent PCM that skips the decoder.

## Compare the same interval without a database

Use the branch workspace with dependencies installed. The harness uses the worker adapter, the same patched executable for both backends and the same authorized prepared media and model file. Set `WHISPER_VAD_MODEL_PATH` as for the worker. Provide a non-silent interval within the media duration.

```sh
rtk proxy pnpm --filter @bitovp/worker exec tsx scripts/benchmark-cuda-asr.ts \
  --cuda-cli /absolute/path/to/whisper-cli --cuda-sha256 "$BITOVP_CUDA_BINARY_SHA" \
  --media /absolute/path/to/prepared.mp4 --media-sha256 "$BITOVP_PREPARED_MEDIA_SHA" \
  --model /absolute/path/to/whisper-model.bin --model-sha256 "$BITOVP_WHISPER_MODEL_SHA" \
  --duration-us 180000000 --language ja --pairs 3
```

The samples include local source and model verification, PCM extraction, native execution and transcript validation. Both backends must produce detected speech intervals and a raw lexical segment overlapping speech before the harness reports a comparison. For the full standalone task time, measure between task creation and saved success as well. The adapter does not include queueing, storage download or database publication. The harness prints hashes and timings. Use `--private-results /new/file.json` to save the actual transcripts locally for comparison against the same reference text and annotated speech boundaries.

The whole-source story path still uses CPU. Extending the experiment there requires binding the CUDA executable and observed backend to the entire transcript recipe, preserving compatibility with existing sealed archives and verifying that resumed windows use the same backend identity.
