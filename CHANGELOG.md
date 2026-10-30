# Changelog

Notable changes are recorded here for people installing and using bitovp.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with versions based on [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
