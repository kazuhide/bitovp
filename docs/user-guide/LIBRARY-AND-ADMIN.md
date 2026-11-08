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

### Create highlight and portrait clips

Clip creation and editing require an operator-configured local LLM and fresh
worker verification that its dedicated runtime can use the selected GPU. A valid
configuration or installed model alone does not enable clips. Missing, expired or
unverified evidence disables new clip work in the UI, API and worker. There is no
automatic metadata-only or external Claude/GPT fallback. Original content, AISA
inspection and normal encoding remain available. Existing projects, tasks,
completed exports and media remain readable. Cancellation and recovery of an
already committed artifact remain available while new clip work is disabled.

The library home shows original contents. Open a content to find its **Clip drafts**:
one content can have multiple independent editing projects, including alternatives
with the same duration and format. Each draft row shows a small thumbnail,
its name, duration and format, and links directly to its editor. Generated content links back to its
original and editing project. **Create another clip** preserves existing drafts.

Open a content detail and choose **Edit clips**. The normal flow loads the output
and AISA for that encoding, reuses matching prepared material, and lets you choose
15, 30, 60 or a custom 1–180 seconds. **Create project** opens an edited timeline
with immediate canvas preview. Review and adjust the proposal, then choose
**Generate** to save its current version and start the MP4 export. Creating the
proposal does not queue a render or reserve a derived output.

Manual material and empty-project controls remain under additional tools. An Operator can prepare an
eligible encoded output as an editing material and select an output folder. The
worker saves the source identity, hash and timing information; wait for **Ready**
before creating a landscape or portrait project. Keep generated output outside
watch-folder inputs. FFmpeg and FFprobe must be available to the worker.

Supported preparation inputs are MP4/MOV with H.264 or 8bit HEVC, BT.709 SDR,
progressive constant 24/25/29.97/30fps, square pixels, no rotation and zero-based
timestamps, with optional mono/stereo AAC at 44.1/48kHz. Fully tagged compatible
30fps sources retain their bytes; other supported frame rates are prepared at
30fps with a saved frame map. Otherwise supported 8bit inputs whose three color
description fields are all unrecorded are normalized using a BT.709 limited
assumption. The source evidence records that assumption; it does not establish
the original color interpretation. Explicit HDR, contradictory color metadata
and full range remain unsupported. The video must declare its duration and frame count. Missing frames
or decode errors are refused instead of silently shortening the source. Source
limits are 4GiB and 60 minutes. VFR, HDR, rotation and unsupported formats require
preparation outside this editor.

The default proposal uses a portrait canvas and a local story-led edit: the model
relates subjects and events in AISA and recognized speech, then proposes a connected
structure within the desired length. Choose automatic, story-flow or thematic
editing. Naming subjects or key moments is optional.
Missing context remains uncertain; the proposal does not guarantee story
understanding or continuous recognition. Safe whole-frame presentation with a
background preserves subjects when the available evidence does not support a crop.
Measured tracking and local captions are used when supported by the source.
Dedicated teaser/summary purposes and spoiler controls remain planned; the current
story-led mode does not certify that a clip conceals a culprit or climax.

Advanced settings also offer metadata-based automatic highlights, scene continuity
and closest whole-shot duration. These are explicit selection alternatives, not a
fallback that bypasses the local LLM availability requirement. A folded creation
record shows the selected moments and their evidence; it remains a creation record
after manual edits. Requested length is a maximum: selection preserves source
order and does not repeat footage to fill missing time. Progress, cancellation and
same-request recovery are available while the proposal is prepared. It opens the
same project for review before MP4 encoding.

For an unprepared encoding output, **Create project** resolves its source and
destination automatically. The flow retains your analysis, duration and advanced settings
while the exact selected material is prepared. An unverified association pauses
for review and an explicit continue action. An uncertain preparation response
requires checking the material list; an uncertain generation response offers the
same request for recovery. Stopping the wait may leave accepted generation running;
open its task to inspect or cancel it.

With captions enabled, selection uses measured speech spans from surrounding
audio to avoid starting or ending inside known speech. Captions and tracking use
the refined selection. Missing evidence or uncertain source edges produce a
warning and metadata-based fallback. If no safe whole-shot window fits, a draft
can retain the proposal with a speech-review warning and the observed evidence.
It does not claim safe dialogue cuts. Existing automatic-export requests still
refuse known unsafe cuts. Review the timeline for dialogue and story completeness.

Automatic adoption requires a recorded source association. Captured input
identity, an editor's explicit time/geometry/content checks and authored demo
metadata have separate labels. A matching title or duration is insufficient.
Review an unverified source against its scene descriptions before confirming it.
The local Docker preview distinguishes authored samples from actual AISA/output
data. Fixture validation does not establish quality across all content.
See the [Japanese preview guide](../EDITING-PREVIEW.ja.md) for dialogue and model setup.

The local preview also supports the optional, pinned `large-v3-turbo-q5_0` ASR
model with `node scripts/editing-preview.mjs asr --model large-v3-turbo-q5_0`.
This command provisions the model and updates that preview's Web and worker.
Wait for active work to finish before switching models. Existing small weights
and projects remain available, and the new digest separates analysis caches.
Compare recognition quality, processing time and peak memory on your content;
model availability alone does not establish accuracy or operation within a
particular worker's memory limit. ASR runs on the worker, independently of the
configured local caption-translation GPU.

#### Legacy and manual range editor

The following range controls belong to existing legacy projects and projects
created with the manual tools. New automatic proposals open the composition
timeline described below, with an immediate preview.

Choose ranges by entering in/out seconds and pressing **Apply range**. Boundaries
snap down to30fps; changing a range resets its framing to fit. Reorder ranges,
mute individual ranges, or select fixed crop and adjust its horizontal/vertical
center. A project supports20 ranges,180 seconds and128 framing segments. Landscape and portrait use
separate projects. Undo/redo affects the local draft; **Save draft** persists it.
If another editor saved first, keep a copy before reloading the saved version.

Scene analysis is optional. Search its scene descriptions or choose a scene to
propose ranges. Check that the analysis matches the material timeline and displayed
orientation before proposing shot framing. AISA centers are points; available
boxes help propose crop size. Continuous motion requires measurements from video
frames, and lost tracking uses FIT. Review the ranges and framing against the
source, then explicitly confirm them when saving a revision. Repeated suggestions
preserve manually chosen fit/crop and confirmed framing. Too many shot segments
are refused before changing the draft; set fewer ranges or frame them manually.

**Save confirmed revision**, then **Generate preview**. The output preview uses
the same recipe as **Export MP4**; the source viewer and crop guide help inspect
the selected segment. Master outputs are1920×1080 or1080×1920. A successful export
creates or updates one derived Library entry for that project/format, preserving
the original and existing content metadata. **Open derived content** links to the
active result. Generated-file links download the complete MP4; source and preview
players use bounded range reads. A late older export cannot replace a newer requested generation.
Cancellation may remain requested until the worker confirms its process stopped.
An unavailable or replaced object requires investigation or a new material version;
the editor does not silently switch to the new bytes.

#### Composition timeline and immediate preview

New automatic proposals open this timeline directly. Save legacy edits before
opening **Open composition tools**. Composition projects
support up to 8 prepared sources, 4 video layers, 8 music tracks and 20 clips within
180 seconds at 30fps. Add a picture in picture, crop keyframes, opacity, crossfades,
music gain/fades, captions, titles and PNG images. Images must be non-animated
8bit RGB/RGBA/grayscale PNG, at most 8MiB and 2048×2048. The canvas presets include
portrait, landscape and square output.

Word highlighting uses measured timings. Changing caption text clears its word
times and displays the complete sentence. Caption-linked music ducking follows
caption edits and supports 64 captions; explicitly saved fixed ducking regions
remain fixed. The current draft previews immediately. **Generate** saves and pins
the visible draft before export; pending input or a save conflict stops the action.
If a newer remote draft appears, **Load saved draft** keeps the current local
document in Undo. Pending numeric input must be applied before switching tools.

Canvas previews and MP4 exports share caption rows, including basic Japanese
line-break rules for small kana, punctuation and brackets. Stored caption text,
timings and word offsets are unchanged. Extremely narrow text boxes retain the
width-first fallback when a complete character group cannot fit. Existing MP4
files remain unchanged; generate another export to apply the updated wrapping.

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

Storage connections used as either the input or output of an editing material
cannot be removed while those references remain. Generated editing files are
excluded from watch-folder input, including when a rule uses another connection
to the same storage or is created later. Submit them manually if they need a new
encoding. Failed output adoption or Library registration waits before retrying
so other queued work can proceed.

This release protects editing materials, projects, revisions, runs, artifacts and
derivations from Reset. If the selected categories depend on them, the preview
shows the protected count and execution is blocked before any deletion. A complete
editing-graph deletion workflow is not available yet.
