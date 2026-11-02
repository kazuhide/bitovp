# Changelog

Notable changes are recorded here for people installing and using bitovp.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with versions based on [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

### Changed

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

Planned work belongs in the [roadmap](./ROADMAP.md); it is added to this
changelog when delivered.

[1.0.0]: https://github.com/kazuhide/bitovp/releases/tag/v1.0.0
[1.0.0-rc.1]: https://github.com/kazuhide/bitovp/releases/tag/v1.0.0-rc.1
