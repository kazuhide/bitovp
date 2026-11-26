# NVENC SDK 13.0 catalog

`sdk-13.0.json` inventories the public C structs, unions, enums, typedef aliases, and GUID constants in NVIDIA's `nvEncodeAPI.h` as shipped by FFmpeg's `nv-codec-headers` tag `n13.0.19.0`. The pin contains 778 fields across 56 structs and 3 unions, 350 values across 38 enums, 24 GUIDs, and 48 additional typedefs. Source line numbers refer to the pinned header. The generator reads the POSIX declarations in Clang's JSON AST and verifies the header's SHA-256 before compilation. [Pinned header](https://github.com/FFmpeg/nv-codec-headers/blob/e844e5b26f46bb77479f063029595293aa8f812d/include/ffnvcodec/nvEncodeAPI.h) · [NVIDIA Video Codec SDK 13.0 guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)

The original record classifications describe the initial FFmpeg option surface.

| Classification | Meaning |
| --- | --- |
| `ffmpeg_vbr_binding` | The current VBR recipe accepts the trial field and sends the recorded FFmpeg option. The annotation describes the argument mapping. Actual support and application depend on the GPU, driver, codec, and preset. |
| `inventoried_unbound` | The initial FFmpeg recipe has no option mapping for the SDK field. |
| `per_frame` | The field carries picture-level control or metadata. Its inventory entry describes the SDK declaration. |
| `runner_managed` | The field represents ABI bookkeeping, resources, media metadata, or an SDK output. |
| `pointer` | The field needs process-local addressing or an opaque handle. A typed adapter can separately expose the data behind it. |
| `reserved` | The pinned header reserves the field or says it must be ignored. |

`direction` reflects the header annotations. `unspecified` records the absence of an annotation. `lifecycle` describes the declaring aggregate's role. An aggregate can also be used through other SDK inputs. The inventory includes resource and status declarations in the denominator. The 12 FFmpeg bindings describe the initial experiment recipe's configurable and fixed inputs. [Runner argument construction](../runner.py)

## SDK settings

The generated `sdkBindings` list describes numeric and boolean writes to the SDK session and picture structures. Each entry gives the exact field path, phase, codecs, C representation bounds and, for enums, the accepted numeric values. `NV_ENC_CONFIG.profileGUID` uses named choices from the pinned header and checks the selected codec. Individual array items have indexed paths such as `NV_ENC_RC_PARAMS.temporalLayerQP[7]`.

`sdk-settings.h` applies those settings to the live SDK structures. The runner owns media geometry, the CUDA transport and output buffers. Bitstream metadata and other device-specific controls still depend on the GPU, driver, codec and co-configured fields. `sdkLimitations` records settings handled by the runtime or a typed adapter and settings that require separate SDK operations. The measurements remain subject to the experiment's source and output requirements.

Rows with phase `reconfigure` describe timed rate changes and reset or IDR flags. Rate fields appear in both `session` and `reconfigure` phases. QP maps are typed frame payloads. The session selects `qpMapMode`, while the runtime owns the supplied map bytes and its size. AV1 custom tile widths and heights use indexed settings, and the transport checks their counts and geometry before submitting them to the driver.

Each item in `sdk.pictures[].metadata` supplies a `type` and lowercase hexadecimal `payload`. H.264 and HEVC use the SEI payload type. AV1 uses metadata type 1 to 5 inside `OBU_METADATA`. Each item counts as one TSV row. The runtime owns the codec-specific payload array and its count.

Check both generated files, the native setter test and the independent denominator fixture from the repository root with Python 3.9 or later and Clang.

```sh
python3 -B native/nvenc-experiments/catalog/generate_catalog.py --check
python3 -B native/nvenc-experiments/catalog/test_catalog.py
```

The generator fetches the header at the pinned commit into a temporary directory. Use `--header /path/to/nvEncodeAPI.h` to verify against a local copy. Running the same command without `--check` generates `sdk-13.0.json` and `sdk-settings.h`. Use `--clang` for a non-default compiler location.
