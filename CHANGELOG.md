# Changelog

Notable changes are recorded here for people installing and using bitovp.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with versions based on [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- An optional pinned `large-v3-turbo-q5_0` speech-recognition model for caption
  evaluation. Only its registered ASR weights may exceed the ordinary 512MiB
  analysis-file limit; model digests continue to separate cached results.
- Automatic highlight ranking for new editing drafts from existing AISA
  descriptions, characters, objects and event cues. Content and desired length are
  sufficient; folded creation-time rationale records the selection and bounded
  fallbacks. Existing policies and source-preserving framing remain compatible.
- Configured one-shot generation from a Library source, associated AISA metadata,
  desired length and optional content query. Whole-shot selection creates editable
  portrait, landscape and square projects. The normal flow creates a draft proposal
  with immediate timeline preview; exports begin only on explicit Generate.
  Existing automatic-export requests retain their original behavior. Dedicated
  tasks support progress, cancellation, retry and exact-input analysis reuse.
- Encoding-bound output and AISA selection, with prepared-media reuse and bounded
  VOD HLS materialization. Prepared frame ownership joins verified shared shot
  boundaries without dropping video frames or audio.
- A prepare-and-generate flow retains the selected source, analysis and generation
  settings. Unverified associations pause for review; uncertain generation
  responses retain same-request recovery. Caption-enabled selection checks
  observed speech boundaries and records its selection evidence and fallbacks.
- Composition editing with multiple sources and video layers, measured crop
  keyframes, crossfades, music gain/fades and caption-linked ducking, timed word
  highlighting, titles and bounded PNG overlays. Existing single-source versions
  and exported files remain readable.
- Local whisper.cpp speech recognition with pinned model verification and a
  licensed Sintel dialogue fixture. Missing or unverified word timing falls back
  to sentence captions; lost subject tracking falls back to FIT.
- Prepared 30fps editing sources from supported fixed 24/25/29.97fps SDR
  H.264/8bit HEVC MP4/MOV inputs, with explicit frame mapping. Immutable input,
  analysis and normalization receipts distinguish captured, editor-confirmed
  and fixture-authored associations. Referenced job history is retained.

- Shot framing based on available AISA subject boxes, with per-shot crop zoom
  and position controls. Center-only analysis remains supported.
- An optional licensed Caminandes 2 animation demo for the local editor preview,
  with explicit authored metadata, source attribution, and a verified download.
- A local Docker preview for the Content Library editor, with synthetic MP4
  footage and authored AISA metadata. The dedicated project preserves edits
  across restarts and exposes only a localhost Web port.
- A visual single-track timeline with zoom, source seeking, and frame-based
  pointer/keyboard trimming. Numeric range controls remain available.

- A Content Library clip editor for landscape highlights and portrait videos,
  with saved ranges, fixed crop/fit, per-range audio, optional AISA scene and shot
  suggestions, preview and MP4 export. Source and edit versions are preserved;
  successful exports return to the Library. Inputs follow the documented SDR
  preparation profile, with20 ranges/180 seconds per edit.
  Apply the Library editing migration and replace all source readers/workers
  before enabling derived outputs. Editing records are protected from Reset.

### Fixed

- Japanese caption wrapping avoids leading small kana, punctuation and closing
  brackets, and trailing opening brackets in the shared Canvas/MP4 layout.
  Existing thumbnails use a new cache identity for the changed line breaks.
- Result players retain the output video's aspect ratio within the viewport
  height limit, avoiding player-added side bars on portrait exports.
- Library editing preparation accepts otherwise supported 8bit outputs with
  unrecorded color metadata, normalizing them with an explicit BT.709 limited
  assumption retained in the source evidence. Explicit HDR, contradictory color
  metadata and full-range inputs remain unsupported.

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

Planned work belongs in the [roadmap](./ROADMAP.md); it is added to this
changelog when delivered.

[1.0.0-rc.1]: https://github.com/kazuhide/bitovp/releases/tag/v1.0.0-rc.1
