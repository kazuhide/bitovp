# bitovp

A self-hosted graphical application for configuring and operating Bitmovin VOD
(video on demand) and Live encodings. Build encoding ladders, configure advanced
codec parameters, package HLS/DASH outputs, and inspect each job or live broadcast
from one interface.

The goal is broad coverage of the Bitmovin Encoding API through an approachable
GUI. Complete API coverage is a goal, not a claim about the current release.
The application also includes storage browsing, reusable presets, pseudo-live
file playback, scheduling, slate insertion, and VMAF video-quality measurement.

[Explore the features and screenshots](https://kazuhide.github.io/bitovp/)
([Japanese](https://kazuhide.github.io/bitovp/ja/)),
or [try the interactive demo](https://kazuhide.github.io/bitovp/#/demo)
without an account. The demo uses sample data and simulates job creation in your
browser; it does not run cloud encodings.

## Install and open bitovp

Start with **Installation and first run**:
[English](https://kazuhide.github.io/bitovp/guide/getting-started/) ·
[日本語](https://kazuhide.github.io/bitovp/ja/guide/getting-started/).
Follow Docker installation, first administrator creation, Bitmovin API key,
storage access, and the first VOD or Live encoding in order.
If your administrator already installed the app, continue with sign-in and
connection settings in that guide.

The default local application address is **http://localhost:3100**.

- [Installation details and alternative local ports](./docs/user-guide/INSTALLATION.md)
- User guide: [English](https://kazuhide.github.io/bitovp/guide/) · [日本語](https://kazuhide.github.io/bitovp/ja/guide/)
- [Japanese user guide (PDF)](./docs/user-guide/bitovp-user-guide-ja.pdf)
- [Configure a VOD encoding](./docs/user-guide/VOD.md)
- [Configure and monitor Live](./docs/user-guide/LIVE.md)

You configure Bitmovin accounts and storage credentials in the application.
They are not required to open the application or check its health.

## What you can configure

- VOD: fixed and Per-Title ladders, video/audio/subtitles, filters, trimming,
  packaging, HLS/DASH manifests, encryption, and quality checks.
- Live: RTMP, redundant RTMP, SRT, Zixi, and HLS pull inputs; output storage and
  delivery; heartbeat monitoring; schedules; slate insertion; Live-to-VOD;
  and optional MP4 archives.
- Operations: multiple organizations and roles, API tokens, storage browsing,
  content library, presets, watch folders, infrastructure, and notifications.
- Quality: local or configured cloud VMAF computation, reports, comparisons,
  and quality gates.

The UI supports English and Japanese. See [supported features and technical
limits](./docs/BITMOVIN-API-COVERAGE.md) for restrictions that affect your plans.
Availability also depends on your Bitmovin account and encoder version.

## Installation requirements

Use Docker and **Docker Compose 2.30.0** or newer. Initial database setup also
requires Node.js 24 or newer and pnpm 11. The [installation guide](./docs/user-guide/INSTALLATION.md)
explains configuration, authentication, database roles, and startup.

Authentication is required by default. There are no default sign-in credentials.
Starting an encoding or creating a live channel can incur provider charges.

For service administration, read [Operations](./docs/OPERATIONS.md).
For automation alongside the GUI, read [API usage](./docs/API-USAGE.md).

## License

[MIT](./LICENSE).
