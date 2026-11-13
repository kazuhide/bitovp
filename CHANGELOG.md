# Changelog

Notable changes are recorded here for people installing and using bitovp.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with versions based on [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Reusable organization-scoped VOD sources, with video/audio references and PNG/JPEG images retained across new edits. Images can be applied as output logos or prepared on CPU as 1–60-second V1 clips, appended with silence or used to replace video while retaining the existing audio. Prepared clips are saved to the selected storage for previews and final encoding.
- Boundary snapping for independent VOD video/audio clip movement, trim edges and ruler positioning, with a visible time guide, zoom-aware tolerance, an on/off control and temporary Alt/Option bypass.
- Manual VOD input timeline editing for linked or independent video/audio: browse storage files, trim, split, reorder and concatenate clips with a stable time scale, seek, zoom and undo/redo. Append to a selected track or replace a selected interval while preserving the opposite track and program duration; audio-only WAV/MP3 sources are supported. Edited-track gaps use black video or silence, with up to twenty seconds between clips and ten seconds at either end. Input editing preserves the normal VOD output settings, including HLS/DASH and progressive files. CPU-only FFmpeg previews use version-pinned range reads and do not require a GPU or Local LLM or start a cloud encoding job.
- Progressive single-file TS output alongside MP4, independently of HLS/DASH. Existing segmented TS output remains available.

### Fixed

- Independent VOD clips can be dragged into empty timeline space without changing their source range or duration. Trim handles can be grabbed on hover and explain source limits; canceled or returned drags do not accidentally seek.
- A VMAF measurement with a VMAF v1.0 model on pictures that are too small for the model ends with an error that names the limit and what to do: use a model of the `vmaf_v0.6.1` family, or a larger reference. These models need 216 pixels in width or in height and, with 4:2:0 pictures, 160, 266 or 318 pixels in both, depending on the model; the frame-index method also needs an encode of 144 to 7680 pixels on each side, and of 216 on one. Before, such a measurement ended with an error that did not name the cause or with a crash, and a cloud measurement reported only that it did not finish. The size is checked before FFmpeg starts and before a cloud resource is created for the comparison. A reference in a pixel format that libvmaf does not take (full-range `yuvj420p`, for one) is converted by FFmpeg to the encode's format, and such a measurement is checked with the encode's chroma layout. Two cases cannot be checked in full beforehand, because the chroma layout of the comparison is not known then: a live measurement, and a measurement without the frame-index method in which neither the reference's pixel format nor the encode's settles the layout (an `nv12` encode of a full-range reference, for one). Pictures pass there that only a 4:4:4 comparison scores. A local run that then fails at the limit is named after the run; a cloud run still reports only that it did not finish. Measurements that worked before give the same scores.
- GPU scoring names the same limits. The worker checks the size of the pictures before it starts the GPU scorer, and a measurement with pictures that are too small for a VMAF v1.0 model ends with the error that **Local CPU** gives, which names the limit and what to do. Before, it ended with `NATIVE_SCORING_FAILED` and a line of the scorer that named no limit. GPU scoring also no longer refuses a small encode of a larger reference: it refused an encode with a side below 144 pixels, or with both sides below 216, because it told CAMBI the encode's own size ([GPU quality guide](./docs/user-guide/GPU-QUALITY.md#small-pictures)).
- The worker image build fails when its FFmpeg cannot score with a bundled VMAF v1.0 model. The earlier build check passed although the scoring failed, because its 64×64 test pictures are too small for these models. The FFmpeg build that the image pins passes the corrected check.
- The Noto Emoji licence in the worker and web images can be read by the user that the containers run as. Its directory was created without search permission.
- Local release checks run packages one at a time and isolate transaction-test setup and delayed fixture work, retaining all assertions and time limits.
- Web startup locates the packaged Prisma query engine after source relocation; deployment health checks perform an identity database read before reporting readiness.
- Clear HLS editing preparation accepts supported paired CUE-OUT/CUE-IN annotations while retaining segment, source identity and timing validation.
- Clip settings diagnose configured services on open and expire stale results; creation and recovery explain failures, including story plans that cannot fit the requested length.
- Manual clip creation prevents duplicate submissions and ignores late responses after leaving the page or losing permission.
- Encoding status probes keep failed, missing and unknown observations unverified instead of suggesting deletion.
- Bound FFmpeg decoder and scaler thread pools so media preparation and multi-clip rendering remain within process limits.

### Changed

- The worker image compiles FFmpeg 8.1.3 from source, at the same revision as before, instead of downloading a third-party build that its publisher removes after about two weeks. Every source is pinned by commit or release and by SHA-256 and compiled without network access. Building the image takes longer: this part took about 3 minutes on a 10-core machine and 8 to 12 minutes on a 4-core one. On the files compared, VMAF and CAMBI values, decoded pictures, rendered captions and H.264, AV1 and AAC encodes are identical to the earlier build. FFmpeg no longer includes the external libraries that bitovp does not use: among them the x265, libvpx, libaom, libopus and LAME encoders, VAAPI, Vulkan, OpenCL and AMF support, the CUDA filters, and the ARIB caption, teletext, JPEG XL and SVG decoders. FFmpeg's own decoders, such as those for HEVC, VP9 and Opus, and NVIDIA decoding and encoding remain. The `FFMPEG_URL` and `FFMPEG_SHA256` build arguments are removed; `--build-context ffmpeg=<directory>` builds the image with another FFmpeg.
- CI no longer compiles FFmpeg three times in every run: a run reuses a build that an earlier run kept for the same `Dockerfile`, VMAF model list and build script, after checking it against the checksums kept with it and proving that it scores with a pinned VMAF model, and compiles when no such build is kept where it may read. Once a week CI compiles the pinned sources and builds the whole worker image from `Dockerfile` alone. `pnpm test:media --ffmpeg <directory>` runs the media check with an FFmpeg that is already built instead of compiling it.
- `docs/FFMPEG-BUILD.md` records how the worker image's FFmpeg is built: every pinned source with its checksum, every command, what the build logs showed on x86-64 and arm64, the programs that came out, what the build leaves out compared with the earlier prebuilt build, the checks that were run on it, including one on a real NVIDIA GPU, and its known limits. A test fails when the FFmpeg stages of the `Dockerfile` change and the record's stages, sources and commands do not follow.
- GPU scoring gives the score of **Local CPU**, which is that of libvmaf through FFmpeg. Before, the two differed with VMAF v1.0 models for an encode that is scaled up to the reference: GPU scoring was 0.96 to 1.50 higher in fifteen measured comparisons, because it compared 10-bit pictures whatever the reference was and told CAMBI, the banding feature of these models, the size and bit depth that the encode had before it was scaled. It now compares at the reference's bit depth and tells CAMBI nothing of the encode. The scorer's CPU reference, with which every GPU result has to agree, gave the mean of the worker's FFmpeg command to the sixth decimal in 81 comparisons; the changed scorer has not been run on a GPU yet. **Local CPU** scores do not change. For GPU workers, three things change. The scorer has to be built and installed again: with an earlier scorer, a VMAF measurement on the GPU fails with `NATIVE_RECEIPT_COMPARISON_MISMATCH`. GPU results from before (scoring generations 9 and 10) stay readable, but they are not the scores that are given now: they are not continued by a retry, and the comparison screen warns when one is shown next to another report, while new GPU results (generations 12 and 13) and **Local CPU** results are compared without a warning. And GPU scoring no longer scores the pairs that FFmpeg converts before libvmaf compares them, for which its score differed from that of **Local CPU** by up to 13.2 in twenty measured comparisons: a reference in 4:2:2 or 4:4:4 or with 12 bits or more, a full-range `yuvj420p` reference with an encode in another format, a pair in which one file is full range and the other is not, and a pair whose files do not name the same colour matrix. Such a measurement ends before any scoring with an error that names the reason and says to use **Local CPU**; no CPU scoring is started in its place, with **Local (GPU if available)** as well. The [GPU quality guide](./docs/user-guide/GPU-QUALITY.md#gpu-scores-and-local-cpu-scores) describes this, and `docs/FFMPEG-BUILD.md` records the measurements.
- The media check (`pnpm test:media`) prints, after its VMAF means, the processor capabilities that x264 reported for the two encodes that it scores. x264 does not produce the same encode on every processor, so those two means can differ between machines; the log of a run now shows what x264 used for those two encodes.
- Offline media CI now requires real HLS preparation, normalization, rendering and reference-preservation fixtures; preview and font checks are also required in CI.
- Remove an unused legacy subtitle translation prompt and obsolete completed implementation plans; align editing and gateway guides with current behavior.
- Document the deployment setting for capability-checked, feasible Local LLM clip plans.
- The web and worker processes no longer load the hierarchical story-flow modules that no feature uses yet. Their tests run in a dedicated CI job.
- The API census check compares the SDK version, reached operations, body fields and evidence files on every change, and lists what differs. Unrelated source or dependency changes no longer require regenerating the bundled census; release gates still require an exact refresh of its source fingerprint and line numbers.
- The offline media and PostgreSQL integration checks explain a failure: the step that failed, each PostgreSQL test that failed or was skipped or each media fixture's test totals, and the end of the failed command's output with credentials removed. The media check also requires every fixture to run once and pass its required number of tests, and no longer accepts a fixture file that declares no test.
- CI runs 106 tests that no job ran before: 12 against PostgreSQL (tenant reset, scene search and the newest run of each live channel), 62 that drive real FFmpeg with the FFmpeg build and VMAF models that the worker image pins, and 32 against the Redis server of the image that `docker-compose.yml` pins (VMAF resource leases and BullMQ queues). Each package's test run now fails when it skips a test that no other job runs.
- Browser qualification uses a pinned Ubuntu runner and a signed archive mirror fallback when the default Ubuntu mirror DNS lookups all fail. Playwright dependency installation and real browser tests remain required.

### Security

- Updated fast-xml-parser to 5.12.0 for subtitle validation and the Azure and Google Cloud storage clients. Earlier versions could use excessive CPU time on XML with unterminated stop-node tags (GHSA-474x-hrwr-fgx4, low severity). bitovp does not enable stop nodes, so it was not affected.

## [1.2.1] - 2026-11-10

### Fixed

- GPU VMAF can measure H.264 MOV references with a positive display-scale matrix using an explicit manual, verified lossless reference preparation. Every packet, timestamp and decoded frame must match; unsupported transforms still fail closed.
- Reference preparation reserves shared CPU and memory before decoding, preserves its intent on retry, and records original/prepared identities and equivalence evidence in reports and JSON exports.
- Native HEVCv2 plans detect SMART_PASS multi-muxing conflicts before encoding starts. GPU QC guidance describes the MP4-only workflow and reference preflight requirements.

## [1.2.0] - 2026-11-09

### Added

- Editable clips under each Library content, with source/output/AISA loading,
  desired duration and editing approach, Local LLM story proposals, source/result
  previews and a visual timeline. A proposal remains editable before explicit MP4 export.
- Multiple projects per content, clip thumbnails, saved revisions, framing
  keyframes, captions, titles, audio controls and optional local Japanese translation.
- Source-time forced alignment for measured caption timing, shared preview/export
  wrapping and highlighting, bounded speech-boundary selection, and safe whole-frame
  presentation when subject evidence does not support cropping.
- Pinned local speech models and preparation of supported SDR inputs, with
  immutable source/analysis/normalization evidence and exact-input reuse.

- Affected CAMBI intervals can open the measured rendition for bounded playback
  and replay, including banding-only reports without a VMAF reference or FPS.
  Preview reads retain the measured object's version and organization binding.

- Local VOD banding detection using no-reference CAMBI, independently or alongside
  VMAF. Reports include scores, presentation-time graphs and affected intervals
  when warning or failure bounds are configured. CAMBI maximum rules support
  the existing quality-gate policy; a warning breach remains visible without
  failing delivery, while missing measurements fail closed.
- CPU and optional owned CUDA/Vulkan CAMBI extraction, separate execution metadata,
  and full-frame JSON/CSV exports. GPU runs verify every frame against the official
  CPU extractor.
  Banding-only measurements do not require a reference video or VMAF model.
  See [banding setup and limits](./docs/user-guide/BANDING-QUALITY.md).

### Changed

- Clip creation and inference require a configured, verified GPU-backed Local LLM.
  Existing source playback, editing history and completed exports remain accessible.
- Library editing adds database migrations. Back up the database, configuration
  and media, stop older readers/workers, migrate, then restart the updated services.
  See [database upgrade guidance](./docs/DATABASE-UPGRADES.md).

- Grouped settings into purpose-based panels with concise descriptions, keeping
  personal display preferences at the top. Quality control now brings its
  enablement and administrator-only execution profiles into one settings page.
- Updated the Bitmovin REST API SDK to 1.287.0 and the new VOD wizard default to
  Encoder 2.292.0 (Beta). Saved account defaults, drafts and imported plans retain
  their selected encoder versions.
- Refreshed the pinned FFmpeg 8.1.3 worker build to include the CAMBI fixes for
  small encode dimensions and 10-bit input strides.

### Fixed

- Captions use measured source-time word boundaries instead of spreading scene
  text across a shot. Short verified interjections and bounded local realignment
  retain their evidence; unavailable timing does not become invented word timing.
- Japanese line wrapping and portrait result-player sizing are shared consistently
  between the timeline preview and rendered MP4.

## [1.1.0] - 2026-11-04

Local VMAF processing now offers CPU and automatic GPU selection with shared
resource management. CPU remains the default and is used for delivery gates.
GPU acceleration is optional and experimental; supported hardware and native
runner setup are described in the [GPU quality guide](./docs/user-guide/GPU-QUALITY.md).

### Added

- Experimental local VOD hardware decoding and owned CUDA/Vulkan VMAF v1.0
  feature extraction, with the official Netflix predictor, full-frame CPU
  verification, and separate decode/scoring metadata in reports and exports.
  CPU remains the default. See [setup and limits](./docs/user-guide/GPU-QUALITY.md).
- A standalone native scorer with resident NVDEC input, hash-verified builds,
  real hardware qualification tests, and complete-process performance and
  memory comparisons.
- Optional native GPU frame concurrency, a read-only hardware and memory query,
  and a matching Linux process supervisor for VMAF runners that must stop work
  when their owner or heartbeat disappears.
- Automatic native VMAF resource planning and shared local admission. Excess
  jobs wait in the queue; short CPU-verified trials select comparison and frame
  concurrency, with reusable private resource measurements.
- Local CPU and automatic GPU choices in VOD quality settings and VMAF Lab,
  with per-measurement selection, same-model CPU fallback, and actual processing
  details in reports. Delivery-gate decisions continue to use the CPU.

### Changed

- Updated pinned CI actions and Docker runtime/service images. Routine dependency
  updates stay in small reviewable groups; runtime major upgrades require a
  separate migration, while security updates remain enabled.
- Refreshed the PostgreSQL 17.11 image digest in both deployment configurations
  and the isolated database validation runner, keeping their images consistent.
- GPU scoring uses the owned native executable. The retired experimental
  configuration is rejected rather than silently changed. Existing measurement
  history remains readable; changing scorers requires a new measurement.

## [1.0.0] - 2026-11-01

First stable release, retaining the release candidate's feature baseline.
Distributions contain source archives and SHA-256 checksums; the application
is built locally using the installation guide.

### Added

- Editable default cloud region and encoder version for each Bitmovin account.
  VOD and Live wizards apply them when the account is selected, while retaining
  later manual edits and saved draft or imported-plan settings.

### Changed

- New VOD audio defaults to AAC, 128 kbps, 48 kHz and stereo. Existing audio
  configurations are retained.

### Fixed

- Fresh-source installation and upgrade instructions generate the database client
  before running host-side database setup commands.
- Switching a Standard video row to flexible Per-Title clears its height while
  retaining sibling rendition references, output destinations and audio settings.
- Scene overlays in VOD previews and the content library use matching theme
  foreground and background colours, including light themes.
- Integration secret inputs consistently request that browsers avoid saving or
  autofilling credentials, while keeping native password masking. Browsers and
  extensions may override these hints.

The database schema is unchanged from v1.0.0-rc.1. Back up configuration,
encryption keys, database and media before upgrading an existing installation.
Feature availability remains dependent on the Bitmovin account, encoder and
configured services; this release does not certify every provider configuration.

## [1.0.0-rc.1] - 2026-10-30

First release candidate. This is a preview for installation and workflow
testing before v1.0.0. The entries below describe the initial feature baseline,
rather than a history of earlier unversioned development.

### Added

- A graphical interface for configuring and monitoring Bitmovin VOD and Live
  encodings, with English and Japanese interfaces.
- Fixed and Per-Title encoding ladders, codec settings, audio and subtitles,
  filters, trimming, HLS/DASH packaging, manifests, and encryption settings.
- A Per-Title simulator with a setup wizard, configuration import from an
  encoding, and advice for reviewing ladder constraints. Its estimates do not
  replace the encoder's content analysis or guarantee an output ladder.
- Live input and delivery settings, heartbeat monitoring, scheduling,
  pseudo-live file playback, slate insertion, and Live-to-VOD workflows.
- A content library with playback, search, and supported AI scene-analysis
  results, alongside storage browsing and reusable presets.
- Local and configured cloud VMAF video-quality measurement, comparison
  reports, and quality gates.
- Individual users, organizations, roles, API tokens, and encrypted storage
  of provider credentials.
- Installation and user guides, plus an interactive demo that runs without
  provider credentials or cloud encoding charges.

Feature availability depends on the application, Bitmovin account, encoder
version, and configured services. See [supported features and limits](./docs/BITMOVIN-API-COVERAGE.md).
Complete Encoding API coverage is a goal, not a claim about this candidate.
Local VMAF computation uses the CPU; GPU processing and the Library clip editor
are planned improvements.

## Reading future releases

Unreleased contains changes awaiting publication. Dated releases appear newest
first, grouped into Added, Changed, Fixed, Deprecated, Removed, and Security
where applicable. Entries include required upgrade steps and compatibility
changes.

Release candidates use `v1.0.0-rc.1`, `v1.0.0-rc.2`, and so on. A published
version identifies fixed source and artifacts; corrections receive a new
version. After v1.0.0, compatible fixes use patch versions, compatible features
use minor versions, and breaking changes use major versions with migration
instructions.

Record implemented changes under **Unreleased** until their tagged release is
published.

[1.2.0]: https://github.com/kazuhide/bitovp/releases/tag/v1.2.0
[1.1.0]: https://github.com/kazuhide/bitovp/releases/tag/v1.1.0
[1.0.0]: https://github.com/kazuhide/bitovp/releases/tag/v1.0.0
[1.0.0-rc.1]: https://github.com/kazuhide/bitovp/releases/tag/v1.0.0-rc.1
