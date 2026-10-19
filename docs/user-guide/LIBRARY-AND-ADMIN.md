# Library and administration

[Back to the user guide](../USER-GUIDE.md)

## Content library and storage

Use `/library` to search content, inspect metadata and AI scene analysis, and
open available HLS/DASH/MP4 playback references. The playback filter indicates
that references exist, not that the remote files are still available. A missing
thumbnail does not mean the media cannot play.

Use `/storage` to browse supported storage credentials, buckets/containers, and
objects. A successful list does not establish write permission. Input and output
paths have different purposes; inspect each before starting work.

## Reusable settings

`/presets` collects saved templates, delivery presets, and samples. Loading or
editing a template opens the VOD/Live wizard; starting work is a separate action.
Review the current account, input, output, and complete plan before execution.
The application reports conflicting edits instead of overwriting a newer saved
revision. Keep your draft before reloading after a conflict.

Delivery presets describe output requirements, not provider credentials. See
[Delivery preset authoring](../DELIVERY-PRESET-AUTHORING.md) for imported files.

## Settings

| Screen | Purpose |
|---|---|
| `/settings` | Language, theme, and entry points to account and service settings |
| `/settings/bitmovin` | Bitmovin accounts and connection testing |
| `/settings/credentials` | Storage, DRM, Live ingest, and integration credentials |
| `/settings/player` | Preview player and optional browser Analytics keys |
| `/settings/features` | Optional application features |
| `/settings/infrastructure` | Cloud Connect, static IPs, regions, and prewarmed pools |
| `/settings/live` | Live defaults, heartbeat interval, alerts, and related resources |
| `/settings/vmaf` | Quality-worker profiles and cloud credentials |
| `/settings/watch-folders` | Automatically submit files found under an input prefix |
| `/settings/webhooks` | Public receiver, automatic registrations, and receipt status |
| `/settings/notifications` | Outbound notifications, event filters, and delivery history |
| `/settings/tokens` | API tokens; secret shown only once at creation |
| `/settings/users` | Organization membership roles and active state |
| `/settings/organizations` | Organization settings, allowed IP ranges, and owner controls |
| `/settings/access-audit` | Non-administrator access decisions for the current organization |
| `/settings/branding` | Organization display name and icon |
| `/settings/api-coverage` | Encoding SDK operation census and source-confirmed calls |
| `/settings/reset` | Selectively delete application data |

Viewing settings and changing them require different roles. Account/credential
changes require `ADMIN`; infrastructure actions can create billable resources.
Saved secrets cannot be revealed. Encoding API keys are different from public
Player/Analytics client keys.

## Organizations and access

Per-user authentication supports membership in multiple organizations. Check the
selected organization before making changes. The last active organization
administrator cannot be removed without a replacement.

Organization administrators can configure allowed IPv4/IPv6 ranges. Check the
displayed source IP and trusted-proxy configuration before restricting access.
An empty allowlist means no organization IP restriction.

Platform owners manage global identities and organizations. Read-only view-as
requires password reauthentication and lasts at most 15 minutes. It cannot save,
start, stop, or otherwise change data. Access audit records gate decisions, not
proof that a provider operation completed.

## Watch folders

Create a rule in `/settings/watch-folders` that links an input prefix to a
complete `FULL_PLAN` VOD preset with one input placeholder. Keep output outside
the watched input prefix to avoid processing generated output.

The worker polls object listings; no storage-event notification setup is needed.
The GUI default interval is 120 seconds. Matching key, size, and modification
time in two observations is treated as stable; it is not a content hash or an
absolute upload-completion guarantee. Each pass lists at most 500 objects and
continues later. Backlogs and failures can delay submission beyond the interval.

The application only lists/reads input storage. It never moves, writes, or marks
input objects; processed state lives in its database. Re-arm or re-encode an
object explicitly when needed. If submission became uncertain after a worker
interruption, check existing jobs before requesting another encoding.

## Webhooks and coverage

Webhook registration is automatic per encoding and is removed when work ends.
VOD uses finished/error/transfer-error hooks; Live also uses live-manifest-ready
and eligible heartbeat hooks. Check registration state and receipt freshness in
settings. A withheld error body protects receiver secrets; it does not mean
registration succeeded. Manual provider hooks lack the application's signature
and are not a substitute for managed registrations.

The API coverage screen lists SDK operations and source references. Source-confirmed
means a call exists in code, not that its GUI path or provider execution passed.
The current body-model inventory lists top-level SDK properties by operation,
with direct property-key evidence where available. Search it to inspect a
particular field. Shared response properties can appear; nested fields,
variables, and helper-generated arguments are not expanded. Neither a model
property nor a direct key proves GUI availability or successful transmission.
Historical parameter survey values are separately dated and are not current
coverage percentages. The settings footer identifies the web build, not the
worker or Bitmovin encoder version.

## Reset data

An organization administrator selects categories and dependencies in
`/settings/reset`, reviews counts, and types `RESET`. This permanently deletes
selected application data. Global users, memberships, organizations, and setup
identity remain. Cloud output files and `.env` are not deleted.

Active work is stopped and cleanup is retried through retained private receipts;
the selected rows can disappear before remote cleanup finishes. Keep the worker
and required credentials available and investigate cleanup failures. Clearing
watch history disables affected watch rules to avoid accidental resubmission.
Deleting library entries does not automatically recreate them from retained jobs.
