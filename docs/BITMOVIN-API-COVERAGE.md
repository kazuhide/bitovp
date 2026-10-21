# Supported features and technical limits

bitovp is a graphical application for Bitmovin video on demand (VOD) and Live
encoding. Complete Encoding API coverage is the goal; the current application
supports a subset of operations and parameters. Available features also depend
on account permissions, encoder version, input, and output capabilities.

Follow the [VOD](user-guide/VOD.md), [Live](user-guide/LIVE.md), and
[Quality and monitoring](user-guide/QUALITY-AND-MONITORING.md) guides for steps;
use the [glossary](user-guide/GLOSSARY.md) for encoding terms.

## What you can configure

| Workflow | Available features |
|---|---|
| VOD | Fixed and Per-Title ladders; H.264, H.265, VP9, and AV1 video; audio, subtitles, filters, input-stream selection, packaging, manifests, encryption, and quality gates |
| Live | RTMP, redundant RTMP, SRT, Zixi, and HLS pull inputs; reusable channels and broadcast history; scheduling, slate insertion, advertising markers, heartbeat monitoring, storage mirrors, Live-to-VOD, and optional H.264/AAC MP4 archives |
| Storage | AWS S3 and compatible providers, Google Cloud Storage, Azure, and other supported input/output credentials; encoding destinations can support more operations than the storage browser or output inspection |
| Quality | Local or configured cloud quality measurement, comparisons, and quality gates; VMAF is calculated with FFmpeg/libvmaf, separately from the Bitmovin Encoding API |
| Administration | Organizations and roles, API tokens, usage statistics, content library, saved settings, watch folders, notifications, and encoding infrastructure |

Input protocols include RTMP (Real-Time Messaging Protocol), SRT (Secure Reliable
Transport), and Zixi. HLS (HTTP Live Streaming) pull reads an existing playlist.
HLS and DASH (Dynamic Adaptive Streaming over HTTP) are also delivery formats.

## Limits of the forms and imported plans

Advanced controls expose supported parameters; an available API operation does
not imply a control for every field.

- H.264 and H.265 expose codec bitrate limits, buffer size, GOP lengths in
  frames, and aspect ratios. The VOD form also exposes `crf` (constant rate
  factor); the Live form retains its fixed target bitrate requirement.
  These codec controls are separate from Per-Title bitrate bounds and from
  keyframe intervals measured in seconds. H.264 `autoLevelSetup` remains
  unsupported in imported plans.
- AV1 exposes selected settings, including presets, automatic level setup,
  and `dynamicRangeFormat`. The SDK also declares `maxLevel`, which current
  plans do not accept. SDK model availability does not add a form control.
- Running Live channels offer **Encoder automatic stop** under **Maximum run
  time**. Each update replaces all three timers; blank fields disable timers.
  Check the accepted settings and the encoder's returned shutdown time before
  relying on a change. This affects the current broadcast; the next start uses
  the channel's saved plan. See the [Live guide](user-guide/LIVE.md#changing-automatic-stop-during-a-broadcast).
- The Live form supports multiple storage mirrors and multiple HLS and DASH
  manifests. Each manifest has its own settings and destination, using the
  channel's shared ladder. Mirror controls support S3, S3-compatible storage,
  Azure, and Google Cloud Storage; MSL and SFTP mirror authoring is unavailable.
  A valid imported plan stays in the JSON editor whenever the form cannot
  preserve all its settings. Review the complete plan there before submitting.
- Standard VOD and Live video renditions can set their HLS child-playlist
  filenames. Live accepts literal flat `.m3u8` names; VOD can expand `{group}`
  for variants per audio group. Per-Title keeps its derived filename options.
- Account-specific features, including HEVCv2, appear only where enabled for the
  selected account. A codec or setting declared by the provider's software
  development kit (SDK) is not proof that your account or encoder accepts it.

## Configuration limits

C1–C37 match configuration messages and related help. Use these checks when a
plan is rejected or a result is unclear.

### Encoding, packaging, and quality

| ID | What this means for your configuration |
|---|---|
| C1 | Per-Title chooses result bitrates, so template bitrate must be null. Custom manifests wait for result renditions; the wizard selects post-encoding generation. Default manifests may be generated during encoding. For HLS, select the template container: fragmented MP4, MPEG transport stream (TS), or MP4. Blank video selection does not select fragmented MP4. |
| C2 | Start-request trimming cannot be combined with InputStream resources. Use the input-stream trimming controls rather than adding trimming to an imported start request. |
| C3 | Plans use Manifest Generator V2. Live-to-VOD uses `LEGACY` because V2 cannot enumerate live muxings. Choose a supported recording container for Live-to-VOD. |
| C4 | Per-Title creates multiple results, so paths must include `{uuid}` or `{bitrate}` and use a supported output: S3, GenericS3, Google Cloud Storage, Akamai NetStorage, or Azure. `{width}`, `{height}`, or a unique literal path alone is not enough. |
| C5 | High-Efficiency AAC (HE-AAC) v1 is limited to 128 kbps and v2 to 64 kbps. Lower the bitrate or change audio profile. |
| C9 | Common Encryption (CENC) counter mode (CTR) needs an 8-byte initialization vector (IV); cipher block chaining (CBC) needs 16 bytes. Standalone FairPlay uses AES-CBC with an IV and key URI. Match encryption mode and container. |
| C17 | Audio/video synchronization adjustments conflict with Dolby audio. Preview manifests are just-in-time (JIT), generated during encoding; preview-only manifests are not finalized. Smooth has no preview list. Use final manifests for completed delivery. |
| C21 | Kantar watermarking is one encoding-wide setting and requires audio. A new configuration replaces the previous value rather than adding another. |
| C28 | Per-Title results do not reliably inherit template names or parent references. Exact output/settings evidence identifies results; ambiguous ones stay unattributed. Check paths and applied settings rather than matching by count. |
| C29 | Quality-control gates require their metrics: enable VMAF or peak signal-to-noise ratio (PSNR) for the corresponding rules. Delivery blocking requires post-encoding manifests; already published manifests cannot be held back. Review warnings when nothing can be blocked. |
| C33 | An HLS variant with audio already in its segments must not also reference external audio. For separate audio, select the group matching the variant. |
| C34 | Each DASH video adaptation set holds one codec; one video codec per job simplifies delivery. Incompatible VOD H.264/H.265 presets and job-wide start encoding modes are rejected without changing quality settings. AV1 is unaffected by this check. |
| C35 | A default manifest path must be a parent of every included muxing path, not a sibling. Review all output legs, including mirrors. |

### Live input, monitoring, and delivery

| ID | What this means for your configuration |
|---|---|
| C8 | A longer DVR (timeshift) window creates more manifest entries. The application estimates entries across renditions against a budget of about 54,000 and rejects unsafe plans. Reduce the window/rendition count or increase segment length. |
| C12 | Live `inputPath` is `live` for account-default RTMP and `/` for created redundant RTMP, SRT, Zixi, and HLS inputs. Keep the appropriate path when importing plans. |
| C13 | Live streams reference ingest directly: video position 0, audio position 1. Separate `IngestInputStream` resources are not used. Check the incoming track layout against these positions. |
| C14 | SCTE-35 advertising markers require a `RUNNING` channel and enabled carriers. For fragmented MP4, enable `signalScte35AsEmsg`; also select matching HLS/DASH marker settings. Starting a channel alone does not enable markers. |
| C19 | Ad-insertion clock synchronization can conflict with the HLS program-date-time source. Select compatible clocks. Cache-Control response headers require an output provider that supports them. |
| C30 | Terminal Live encodings cannot restart. Broadcast the channel again for a new run/encoding. Restart applies only to a still-active provider encoding. |
| C31 | Akamai Media Services Live (MSL) stream format limits containers/manifests. MSL4 uses account authentication; MSL5 uses saved publishing credentials, not Header-only authentication, and needs separate delivery validation. Manifests publish at the event root; child/segment paths remain relative to manifest `outputPath`. Keep run-specific media paths and inspect playback references. |
| C36 | Insertable video must match ingest: H.264/AAC, resolution/frame rate, one audio stream, sample rate/channels, `yuv420p`, and closed groups of pictures (GOPs). MPEG-TS is required: MP4/MOV can play audio at half speed; MKV does not air. Non-matching movies are converted. Matching TS and JPG/PNG stills register directly; stills are silent, letterboxed, and need a duration. `READY` means registered, not proven playable. |
| C37 | Heartbeat webhooks require a resolved 2.x encoder version of at least 2.285.0. Older versions poll; unresolved versions wait for capability detection. Default interval: 20 seconds; minimum: 1 second; zero disables registration. At most five named hooks per encoding. Check registration and receipt freshness in settings/channel details. |

The application manages heartbeat registration for each run and removes its
registrations when the run ends. It does not create account-wide heartbeat
hooks; older owned registrations remain available for cleanup and history.
Finished, error, transfer-error, and live-manifest-ready notifications have
managed registration and cleanup. The provider's live-input-stream-changed
notification has a create-only API; do not assume it supports the same list and
delete operations.

### Storage, credentials, and infrastructure

| ID | What this means for your configuration |
|---|---|
| C10 | Akamai Object Storage and Oracle Cloud Infrastructure (OCI) Object Storage use GenericS3 credentials, V4 signing, and provider-specific endpoints/addressing. They are not Akamai NetStorage; choose the matching credential kind. |
| C11 | Provider segment validation cannot read back GenericS3, S3 role-based outputs, FTP, or Live. Use available output inspection and independent playback checks. An unavailable validation option is not a successful check. |
| C15 | Cloud Connect accounts, region settings, static IPs, and prewarmed pools require deletion/recreation to change; the provider has no update API. Check dependent encodings first. Akamai subnet/firewall identifiers are numeric. |
| C16 | Assign a static IP (fixed public address) at creation; an IP in use fails. Prewarmed pools require a specific region, not `AUTO` or an aggregate region, and support VOD only. |
| C18 | Cloud Connect requires infrastructure settings and `cloudRegion: EXTERNAL`; `EXTERNAL` without infrastructure is invalid. Live static-IP/infrastructure settings also need a specific region. Keep these selections consistent. |
| C22 | Kantar watermarking and ad-insertion URLs can receive credentials: use HTTPS, no embedded username/password, and an administrator-approved host. Ask the administrator to allow the intended host. |
| C23 | Azure can return short, incomplete pages. The storage browser follows continuation tokens to completion and preserves folder boundaries. Check folder/prefix selections when comparing recursive and folder views. |
| C24 | Input lists cover several provider types and expose selected fields, not secret connection values. Select stored credentials rather than expecting lists to reveal saved secrets. |
| C26 | Encoding API keys and storage/integration credentials stay encrypted on the server; saved secrets cannot be revealed. Player/Analytics client keys are public browser configuration. Never use an Encoding API key there. |
| C27 | Playback URLs depend on provider/addressing mode; unavailable derivation is reported rather than guessed. Akamai MSL needs its public HTTPS edge base URL without query, embedded credentials, or trailing slash, else `MSL_EDGE_URL_NOT_CONFIGURED`. A viewer URL does not prove encoder health. |
| C32 | Some S3-compatible providers reject the AWS-specific `x-id` query parameter. The application omits it before signing custom requests; AWS-native requests are unchanged. Select the correct credential type/endpoint. |

### History and errors

| ID | What this means when operating a job |
|---|---|
| C6 | Provider inventories span pages. The application requests at most 100 records per page and continues through the listing. One displayed page need not contain every resource. |
| C7 | Provider encoding records eventually expire. The application records redacted step details and resource/result identities while work runs. Retain its database and required output files for later history. |
| C20 | Errors are classified and redacted because raw provider messages may contain secrets. Use the error code and failed step to investigate; withheld text does not mean success. |
| C25 | The transfer-retries endpoint was removed; `TRANSFER_ERROR` status and notifications remain. That endpoint cannot resume a transfer. Recovery through a new encoding creates new work: review paths and charges. |

## Reading the API coverage screen

Settings → API coverage lists operations under `/encoding/` in the installed
provider SDK and marks calls found in application source code as source-confirmed.
Account, notification, and other product APIs are outside this inventory. This is not a
percentage of GUI fields, successful provider calls, or verified playback
scenarios. An unconfirmed operation can still be used through a wrapper that
the analysis cannot resolve.

The current SDK body-model inventory lists top-level properties for each
operation that sends a body. Search by property, model, operation, or source
reference. Inherited public properties are included; nested properties are not
expanded. SDK models can share request and response properties, so this list
does not establish that every property can be written to the API. Bodies whose
types cannot be expanded are listed separately with a reason.

"Direct property evidence" means an explicit property key was found in an
object or SDK-model constructor passed directly to a resolved SDK call. The
value can be optional or undefined. Variables, helper results, spreads, and
ambiguous calls are not followed. This evidence does not establish that the
property is configurable in the GUI or sent successfully. "Unconfirmed" does
not mean "not implemented."

The separately dated historical parameter survey uses a different scope and
method. Its GUI/JSON reachability figures have not been refreshed and must not
be compared with the current body-model inventory. The CSV export uses the same
operation census as this screen, including separate methods sharing one path.

A successful encode, an available manifest, and browser playback are separate
checks. Verify the expected renditions and actual delivery after encoding;
provider status and SDK model availability do not establish playback success.
