# NVENC SDK 13.0 catalog

`sdk-13.0.json` inventories the public C structs, unions, enums, typedef aliases, and GUID constants in NVIDIA's `nvEncodeAPI.h` as shipped by FFmpeg's `nv-codec-headers` tag `n13.0.19.0`. The pin contains 778 fields across 56 structs and 3 unions, 350 values across 38 enums, 24 GUIDs, and 48 additional typedefs. Source line numbers refer to the pinned header. The generator reads the POSIX declarations in Clang's JSON AST and verifies the header's SHA-256 before compilation. [Pinned header](https://github.com/FFmpeg/nv-codec-headers/blob/e844e5b26f46bb77479f063029595293aa8f812d/include/ffnvcodec/nvEncodeAPI.h) · [NVIDIA Video Codec SDK 13.0 guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)

Each record field has one classification.

| Classification | Meaning |
| --- | --- |
| `ffmpeg_vbr_binding` | The current VBR recipe accepts the trial field and sends the recorded FFmpeg option. The annotation describes the argument mapping. Actual support and application depend on the GPU, driver, codec, and preset. |
| `inventoried_unbound` | The SDK declares the field. The current experiment recipe has no binding for it. |
| `per_frame` | The field carries picture-level control or metadata. Its inventory entry describes the SDK declaration. |
| `runner_managed` | The field represents ABI bookkeeping, resources, media metadata, or an SDK output. |
| `pointer` | The field needs process-local addressing or an opaque handle. A typed adapter can separately expose the data behind it. |
| `reserved` | The pinned header reserves the field or says it must be ignored. |

`direction` reflects the header annotations. `unspecified` records the absence of an annotation. `lifecycle` describes the declaring aggregate's role. An aggregate can also be used through other SDK inputs. The inventory includes resource and status declarations in the denominator. The 12 FFmpeg bindings describe the initial experiment recipe's configurable and fixed inputs. [Runner argument construction](../runner.py)

Check the tracked bytes and the independent denominator fixture from the repository root with Python 3.9 or later and Clang.

```sh
python3 -B native/nvenc-experiments/catalog/generate_catalog.py --check
python3 -B native/nvenc-experiments/catalog/test_catalog.py
```

The generator fetches the header at the pinned commit into a temporary directory. Use `--header /path/to/nvEncodeAPI.h` to verify against a local copy. Running the same command without `--check` generates `sdk-13.0.json`. Use `--clang` for a non-default compiler location.
