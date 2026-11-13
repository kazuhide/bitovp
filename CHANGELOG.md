# Changelog

Notable changes are recorded here for people installing and using bitovp.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with versions based on [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Remove Library entries from the grid, list or detail page and restore them from Archived content. Removal keeps cloud media, encoding jobs, clip drafts and render history, and uses revision checks and operator permissions.
- Compare retained VOD QC videos from different VMAF reports in an on-demand two-video preview, with report/rendition labels, synchronized playback and chart seeking when the reports share their measured FPS. Reports without eligible media remain available for score comparison.
- Violin plots on individual VMAF reports and report comparisons show the distribution of every stored measured score rather than the line chart's bucket-minimum sample. The bounded histogram retains exact counts, mean and extrema, identifies subsampled runs and missing data, and uses a disclosed smoothed outline without clipping scores at 100.
- A read-only administrator preflight identifies saved templates and watch folders affected by changed delivery presets. A mandatory upgrade rehearsal preserves representative v1.2.1 data, credentials, passwords, tenant isolation and edit history through current migrations, then restores the original dump and reads it with the original code and keys.
- Reusable organization-scoped VOD sources, with video/audio references and PNG/JPEG images retained across new edits. Images can be applied as output logos or prepared on CPU as 1–60-second V1 clips, appended with silence or used to replace video while retaining the existing audio. Prepared clips are saved to the selected storage for previews and final encoding.
- Boundary snapping for independent VOD video/audio clip movement, trim edges and ruler positioning, with a visible time guide, zoom-aware tolerance, an on/off control and temporary Alt/Option bypass.
- Manual VOD input timeline editing for linked or independent video/audio: browse storage files, trim, split, reorder and concatenate clips with a stable time scale, seek, zoom and undo/redo. Append to a selected track or replace a selected interval while preserving the opposite track and program duration; audio-only WAV/MP3 sources are supported. Edited-track gaps use black video or silence, with up to twenty seconds between clips and ten seconds at either end. Input editing preserves the normal VOD output settings, including HLS/DASH and progressive files. CPU-only FFmpeg previews use version-pinned range reads and do not require a GPU or Local LLM or start a cloud encoding job.
- Progressive single-file TS output alongside MP4, independently of HLS/DASH. Existing segmented TS output remains available.
- Progressive MOV container for VOD (`PROGRESSIVE_MOV`), and a wider Progressive TS: one whole `.ts` or `.mov` file for each video rendition, with the audio in the same file. Progressive TS holds H.264 or H.265 video with `AAC`, `AC3`, `EAC3`, `DDPLUS` or `DD` audio, and takes `segmentLength` beside `startOffset`, which is a whole number of seconds; Progressive MOV holds H.264 or H.265 video with `AAC`, `AC3` or `DD` audio. A Progressive TS without a file name is written as `output.ts`. The Packaging step offers each to the video renditions it holds, as "TS (single file)" and "MOV (single file)", and the single TS file to an audio rendition in a codec the file holds as well; the file-export flow offers them as "MPEG-TS (.ts)" and "QuickTime (.mov)" beside MP4. No manifest lists these files and DRM is not offered for them. Qualification verified H.264/AAC output in a short AWS Tokyo encode. Other codec combinations remain unmeasured, so the conservative `PLAN_MUXING_UNMEASURED_KIND` warning is retained and the file-export flow identifies the remaining qualification limit.
- Progressive WebM container for VOD (`PROGRESSIVE_WEBM`): one whole `.webm` file for each VP9 or AV1 video rendition, with Opus audio in the same file. The Packaging step offers it to VP9 and AV1 renditions as "WebM (single file)", and the file-export flow offers it as "WebM (.webm)". No manifest lists the file and DRM is not offered. Qualification verified VP9/Opus output in a short AWS Tokyo encode; other combinations remain unmeasured and the conservative `PLAN_MUXING_UNMEASURED_KIND` warning is retained. Bitmovin's API release notes say that a progressive WebM muxing with AV1 video takes no other stream: a plan that puts audio beside AV1 in one carries the warning `PLAN_MUXING_AV1_NOT_ALONE`, and the encoding may be refused.
- An MP4 container accepts AV1 video and `OPUS`, `DDPLUS` and `DD` audio, beside the codecs it had. A fragmented MP4 takes AV1 for DASH on-demand only: with `fragmentDuration` set and a `manifestType` other than `DASH_ON_DEMAND`, the plan is refused with `PLAN_MP4_AV1_FRAGMENTED_MANIFEST_TYPE`. An MP4 that an HLS manifest lists is refused when it carries Opus audio (`PLAN_HLS_OPUS_WEBM_UNSUPPORTED`), as an Opus audio leg already was. A codec that the container's format defines, and that no Bitmovin document read for this lists for the container, is accepted with the warning `PLAN_MUXING_UNVERIFIED_CODEC`, which names the rendition: `OPUS` in MP4, `EAC3` in Progressive TS and `AC3` in Progressive MOV. A Dolby Vision rendition in a Progressive TS or Progressive MOV file carries the same warning: Bitmovin's documents name Dolby Vision for fMP4 and MP4. The encoding may be refused, so check the first output.
- Validation warns of audio other than `AAC` or `DOLBY_ATMOS` in one container with Dolby Vision video (`PLAN_MUXING_DOLBY_VISION_AUDIO`). Bitmovin's rules for a muxing that carries Dolby Vision video name those two codecs only, so the encoding may be refused. The warning names the rendition, and the file-export flow shows it on the audio codec.
- The file-export flow offers every codec its containers hold. In Format, each file has its own video codec with that codec's advanced options: H.264, H.265 or AV1 in MP4, H.264 or H.265 in MPEG-TS and QuickTime, and VP9 or AV1 in WebM. HEVCv2 is offered beside H.265 to an account that may use it, and "BCF override" is shown in Basics for it. Each file also has its own audio: "Include audio", then the audio codec, channel layout, bitrate, sample rate and source, with a cutoff frequency for AAC, AC3 and EAC3 and loudness control for Dolby Atmos. Files with the same audio settings share one audio track, which is encoded once. Changing a file's container keeps a codec that the new container holds and that Bitmovin lists for it, and otherwise moves the file to the first codec of the new container. A track that leaves Dolby Atmos goes back to the input's own audio, a file that changes to HEVCv2 keeps only the H.265 settings HEVCv2 takes, and a file that leaves HEVCv2 drops the settings only HEVCv2 has. The screen says on the field when a container has not been verified on a live encode, when no Bitmovin document lists a codec or Dolby Vision for the container, when audio is set beside AV1 in a WebM file, when the container cannot hold a codec that a draft, a loaded plan or the Ladder step brought, when a Dolby Atmos track reads no Dolby Atmos stream, when a source is a stream that the file's video or audio cannot be made from (a Dolby Atmos or Dolby Vision stream read by the wrong track, a Dolby Vision metadata stream, a subtitle file), when AV1 is set with Dolby Vision, which is written as fMP4 only, when audio other than AAC or Dolby Atmos is set beside Dolby Vision video, when the input sequence has no audio and the file is set to include it, when an audio bitrate or sample rate is empty, when files in more than one video codec do not all have the same encoding mode other than "(default)", when HEVCv2 is not the codec of every file or lacks a height or a bitrate, and, in Basics, when "BCF override" is on with no file in HEVCv2. While an input sequence is on, the source fields say that they are not used. Applying an output logo from the input sequence editor opens all settings, because the logo is a filter of the Ladder step.
- A new VOD job can be created to export files as well as to package for streaming. "What to create" at the top of the New VOD job page switches between "Package for streaming", the eight steps as before, and "Export files": six steps (Basics, Sources, Format, Destination, Encoding, Review) that write files with the audio inside and no manifests. The file flow starts with one H.264 1080p MP4 at 8 Mbps with AAC audio, names the files after the job until a name is typed, and writes them directly into the chosen folder. It does not request public read access for the files unless that is selected in Destination. Its Encoding step is the one the eight steps have: the encoding mode, labels and infrastructure, AI Scene Analysis, quality control and Kantar audio watermarking. Three of its settings are left to "Show all settings": the Per-Title configuration, what a QC gate does when it fails, and the renditions a gate rule is for. A QC gate set in the six steps holds nothing back: a failed rule is recorded on the job and sends the "QC gate failed" notification, the files are written either way, and each rule is for every file. The AI Scene Analysis result, the copies measured for quality and the Kantar report start in a folder named after the job inside the destination folder, and that folder follows the job name until another one is typed. The copies are named after the video settings (`v1080.mp4`) and not after the job, so jobs that share a destination folder would otherwise replace each other's copies. Review lists what these settings write with the files: the AI Scene Analysis result, the folder of the copies measured for quality, and the folder of the Kantar report. For a job with additional destinations it also says that the files and the measured copies are written to them, and that the AI Scene Analysis result and the Kantar report are not. The multi-encoding partition of the Sources step is left to "Show all settings" as well. "Show all settings" opens the eight steps with the same job, and "Back to simple view" returns while no setting outside the six steps is in use. The choice is remembered in the browser, and Settings holds the same choice under "New VOD job flow". Switching between the two opens a new form, and each flow keeps its own draft. `/vod/new?flow=file` and `/vod/new?flow=streaming` open a flow directly. A preset, a saved template or a copied job opens the eight steps as before.
- A plan can name the folder its QC copies are written to (`qc.mirrorPath`). The copies go to `qc/` inside that folder; without it they go to `qc/` beside each rendition, as before. Quality control in the Encoding step has "Write the measured copies to one folder" and "Folder for the measured copies" for it, and the job detail and the measurement read the copies from the same folder.
- Validation warns when quality control is asked to score a video rendition that reads a stream made from a source, such as a trimmed one, and not a source file (`PLAN_QC_NO_REFERENCE`). There is no file to compare such an encode with, so VMAF and PSNR are not measured for it, and a QC gate rule that covers it fails for the missing score. The warning names the rendition and says when a gate rule covers it.
- Quality control shows the measurement method that a loaded plan carries (`qc.measurementMethod`) and lets it be taken out. No step sets it, so it was in the plan without being shown.

### Fixed

- CPU VOD input previews accept valid QuickTime display matrices with positive axis scaling and quarter-turn rotation, including the original Big Buck Bunny MOV. Invalid shear, reflection, perspective and contradictory rotation metadata remain rejected; preview geometry follows the worker's pinned FFmpeg autorotation and sample aspect ratio.
- Progressive WebM outputs are registered as playable Library media. An older empty capture can be projected read-only from the identical retained job plan and same-organization credentials, without rewriting source history or borrowing a changed or deleted job's authority.
- Independent VOD clips can be dragged into empty timeline space without changing their source range or duration. Trim handles can be grabbed on hover and explain source limits; canceled or returned drags do not accidentally seek.
- A job with "VMAF only" selected is no longer refused when a video container carries the audio track, or when Kantar audio watermarking is set. Such a job leaves the audio rendition out. The container went on naming it, so validation reported a stream the plan did not have (`PLAN_UNRESOLVED_REF`), and the watermark was left with no audio to mark (`PLAN_KANTAR_NEEDS_AUDIO`). The plan now leaves out the watermark and the audio track of the source, which nothing in it reads. The Kantar panel says that it is skipped while the option is on, and keeps its settings.
- Changing the bitrate of an audio track that a video container carries keeps the track in that container. The container went on naming the track by its earlier key, so the audio was written as a separate file. The track also stays when its bitrate is typed through a value that another track has, such as 64000 on the way to 640000, and when two tracks are left with the same bitrate and sample rate for a while: the job is refused for the key the two share, and each container carries its own track again once they differ.
- A VMAF measurement with a VMAF v1.0 model on pictures that are too small for the model ends with an error that names the limit and what to do: use a model of the `vmaf_v0.6.1` family, or a larger reference. These models need 216 pixels in width or in height and, with 4:2:0 pictures, 160, 266 or 318 pixels in both, depending on the model; the frame-index method also needs an encode of 144 to 7680 pixels on each side, and of 216 on one. Before, such a measurement ended with an error that did not name the cause or with a crash, and a cloud measurement reported only that it did not finish. The size is checked before FFmpeg starts and before a cloud resource is created for the comparison. A reference in a pixel format that libvmaf does not take (full-range `yuvj420p`, for one) is converted by FFmpeg to the encode's format, and such a measurement is checked with the encode's chroma layout. Two cases cannot be checked in full beforehand, because the chroma layout of the comparison is not known then: a live measurement, and a measurement without the frame-index method in which neither the reference's pixel format nor the encode's settles the layout (an `nv12` encode of a full-range reference, for one). Pictures pass there that only a 4:4:4 comparison scores. A local run that then fails at the limit is named after the run; a cloud run still reports only that it did not finish. Measurements that worked before give the same scores.
- GPU scoring names the same limits. When the GPU scorer refuses pictures or an encode that are too small for a VMAF v1.0 model, the measurement ends with the error that names the limit and what to do. Before, it ended with `NATIVE_SCORING_FAILED` and a line of the scorer that named no limit. GPU scoring compares every pair in 4:2:0 and tells CAMBI the encode's own size in every measurement, so it refuses some small encodes and some small 4:4:4 or 4:2:2 references that **Local CPU** scores; the [GPU quality guide](./docs/user-guide/GPU-QUALITY.md#small-encodes-and-small-references) lists them. For such a pair the error also says that the limit is that of GPU scoring and does not hold with **Local CPU**, where the reference is in a pixel format that libvmaf takes as it is. Nothing is refused that GPU scoring scored before.
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

- A plan in which two outputs write the same file is refused before the job starts. `PLAN_OUTPUT_FILE_COLLISION` names the file and the muxings that write it. The check covers what a muxing writes under one fixed file name into a fixed folder, through its own output and through its DRM configurations, and compares where the bytes land: an output listed under two keys is one bucket, and a delivery mirror receives every file. Manifests, sprites and thumbnails are not compared. Two paths spelled the same way are refused. Two that differ only in spelling, such as `./out` and `out`, are reported as a warning, because whether the storage reads them as one path has not been measured. A name or folder with a placeholder is left alone, and so is an output that holds a stream with a condition. Such a plan was accepted before, although both outputs go to one object in storage. In the file-export flow the "File name" fields report a shared or empty name as well.
- An HLS manifest that lists video but no audio, in a plan that has audio renditions, is refused with `PLAN_HLS_AUDIO_UNSELECTED`. This happens when the audio is held only by a container that no playlist lists, such as a Progressive TS or MOV file added beside the ladder: every variant would name an audio group that nothing creates, and play silent. DASH already had this check.
- A job that finished before these two checks existed can still be re-run. The re-run reports `PLAN_OUTPUT_FILE_COLLISION` and `PLAN_HLS_AUDIO_UNSELECTED` as warnings; new jobs, watch folders included, are refused.
- A plan without manifests whose files all go to one folder opens in the form with that folder as the output folder, when the plan writes the folder with its closing slash (`exports/`), as the file-export flow does. Before, the output folder was empty and each file carried its whole path, so a folder typed in the Output step was added in front of that path. A job copied from a file-export job is such a plan. A folder written without the closing slash, as in the two mezzanine presets, opens as before. The name that the plan format supplies for an H.264 codec configuration is no longer shown as a typed name when a plan is loaded.
- The two mezzanine delivery presets, `mezz-h264-1080p-50m` and `mezz-h265-2160p`, write the video and its audio into one MP4 instead of one MP4 for each. Each preset now requires this, so a plan that separates them again is reported as a deviation. A saved template or a watch folder that holds the earlier shape of a preset and refuses deviations is refused when it next submits a job: load the preset again and save it. Re-running a finished job is not affected. The audio rendition of both presets is keyed `aac` instead of `a320`, so raising its bitrate in the form stays within the preset.
- The worker image compiles FFmpeg 8.1.3 from source, at the same revision as before, instead of downloading a third-party build that its publisher removes after about two weeks. Every source is pinned by commit or release and by SHA-256 and compiled without network access. Building the image takes longer: this part took about 3 minutes on a 10-core machine and 8 to 12 minutes on a 4-core one. On the files compared, VMAF and CAMBI values, decoded pictures, rendered captions and H.264, AV1 and AAC encodes are identical to the earlier build. FFmpeg no longer includes the external libraries that bitovp does not use: among them the x265, libvpx, libaom, libopus and LAME encoders, VAAPI, Vulkan, OpenCL and AMF support, the CUDA filters, and the ARIB caption, teletext, JPEG XL and SVG decoders. FFmpeg's own decoders, such as those for HEVC, VP9 and Opus, and NVIDIA decoding and encoding remain. The `FFMPEG_URL` and `FFMPEG_SHA256` build arguments are removed; `--build-context ffmpeg=<directory>` builds the image with another FFmpeg.
- CI no longer compiles FFmpeg three times in every run: a run reuses a build that an earlier run kept for the same `Dockerfile`, VMAF model list and build script, after checking it against the checksums kept with it and proving that it scores with a pinned VMAF model, and compiles when no such build is kept where it may read. Once a week CI compiles the pinned sources and builds the whole worker image from `Dockerfile` alone. `pnpm test:media --ffmpeg <directory>` runs the media check with an FFmpeg that is already built instead of compiling it.
- `docs/FFMPEG-BUILD.md` records how the worker image's FFmpeg is built: every pinned source with its checksum, every command, what the build logs showed on x86-64 and arm64, the programs that came out, what the build leaves out compared with the earlier prebuilt build, the checks that were run on it, including one on a real NVIDIA GPU, and its known limits. A test fails when the FFmpeg stages of the `Dockerfile` change and the record's stages, sources and commands do not follow.
- The [GPU quality guide](./docs/user-guide/GPU-QUALITY.md#gpu-and-cpu-scores-of-an-encode-that-is-scaled-up) says when GPU scoring and **Local CPU** give different scores, and why. They agreed in seven comparisons of 8-bit 4:2:0 files in which the encode had the size of the reference. For an encode that is scaled up to the reference, GPU scoring was 0.96 to 1.50 higher with VMAF v1.0 models in fifteen measured comparisons. Files that are not 8-bit 4:2:0 were not measured. The two feed CAMBI, the banding feature of these models, differently: GPU scoring compares 10-bit pictures and tells CAMBI the size and bit depth that the encode had before it was scaled. No score changes.
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
