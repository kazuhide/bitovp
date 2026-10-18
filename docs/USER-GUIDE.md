# User guide

Bitovp is a GUI for Bitmovin VOD and Live encoding. Use the browser to configure
encodings, review the complete plan, start work, and inspect the output.

| Task | Guide | Main screens |
|---|---|---|
| Install and sign in | [Installation](./user-guide/INSTALLATION.md) | `/setup`, `/login` |
| Connect accounts and storage | [Getting started](./user-guide/GETTING-STARTED.md) | `/settings`, `/storage` |
| Encode a file | [VOD](./user-guide/VOD.md) | `/vod/new`, `/vod/jobs` |
| Broadcast and monitor a live stream | [Live](./user-guide/LIVE.md) | `/live/new`, `/live`, `/live/feeders` |
| Review usage and video quality | [Quality and monitoring](./user-guide/QUALITY-AND-MONITORING.md) | `/`, `/qc` |
| Manage content, presets, and settings | [Library and administration](./user-guide/LIBRARY-AND-ADMIN.md) | `/library`, `/presets`, `/settings` |
| Investigate failures | [Troubleshooting](./user-guide/TROUBLESHOOTING.md) | Job, channel, and report details |
| Understand encoding terms | [Glossary](./user-guide/GLOSSARY.md) | All screens |

## Before starting work

- `VIEWER` can inspect jobs, channels, and reports.
- `OPERATOR` can create and operate encodings and browse storage.
- `ADMIN` also manages account configuration, credentials, users, tokens, and reset.
- Opening a wizard, importing a plan, or copying settings does not start encoding.
- Starting VOD or creating Live can incur charges and write to your output storage.
  Creating Live starts provisioning immediately; it is not a draft-only operation.
- Review input, renditions, output paths, and the plan preview before submission.

Field help is available from the information buttons beside settings. Advanced
parameters use their Bitmovin names so they can be compared with API requests.
See the [glossary](./user-guide/GLOSSARY.md) when a term is unfamiliar.

After submission, check the step history, provider state, actual output, and
playback. A successful HTTP request or a `RUNNING` label alone does not establish
that viewers can watch the stream.
