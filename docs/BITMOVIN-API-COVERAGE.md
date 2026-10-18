# Supported features and technical limits

Bitovp aims to make the Bitmovin Encoding API available through a practical VOD
and Live GUI. Current support is narrower than the whole API. Availability also
depends on provider permissions, encoder version, input, and output capabilities.

## Supported workflows

- VOD: fixed/Per-Title ladders, H.264/H.265/VP9/AV1, audio/subtitles, filters,
  input streams, packaging, manifests, encryption, and quality gates.
- Live: RTMP/redundant RTMP/SRT/Zixi/HLS pull, persistent channels and runs,
  scheduling, slate insertion, SCTE-35, heartbeat monitoring, storage mirrors,
  Live-to-VOD, and optional H.264/AAC MP4 archives.
- Storage: AWS S3, compatible GenericS3 providers, GCS, Azure, and the modeled
  input/output credential families. Encoder output support can be wider than
  storage-browser or read-back support.
- Quality: ffmpeg/libvmaf reports, comparisons, provenance, and quality gates.
  Bitmovin itself does not provide a VMAF API.
- Operations: organizations/roles, API tokens, usage statistics, content library,
  saved settings, watch folders, notifications, and infrastructure management.

## Configuration constraints

These stable identifiers appear in validation messages and tests. C1–C37 cover
restrictions that affect plan configuration and interpretation of results.

| # | Rule and effect |
|---|---|
| C1 | Per-Title template bitrate must be null. Custom manifests require post-encoding (`PER_TITLE_RESULT` absent at start); defaults may be JIT. Wizard selects post-encoding. HLS result expansion uses selected template muxing kinds (FMP4/TS/MP4); an omitted video pin does not imply FMP4. |
| C2 | Start-request trimming and InputStream resources are mutually exclusive. This product models trimming with InputStreams. |
| C3 | Use Manifest Generator V2. Live-to-VOD is the explicit LEGACY exception because V2 cannot enumerate a live encoding's muxings. |
| C4 | Per-Title output paths require a supported placeholder such as `{uuid}` or `{bitrate}`; `{width}` and `{height}` are also supported. Only provider-supported output kinds may be used. |
| C5 | HE-AAC v1 is limited to 128 kbps and HE-AAC v2 to 64 kbps. |
| C6 | List operations use `limit <= 100` and paginate to exhaustion. One page is never treated as a complete provider inventory. |
| C7 | Provider encoding records expire; persist redacted request, response, resource, and result identity while the job runs. |
| C8 | Live DVR settings must remain inside the manifest-element budget (about 54,000 elements); expose the calculation and reject unsafe configurations. |
| C9 | CENC CTR uses an 8-byte IV and CBC uses a 16-byte IV. Standalone FairPlay uses AES-CBC with IV and URI. |
| C10 | Akamai Object Storage and OCI Object Storage use Bitmovin GenericS3 with V4 signing and provider-specific endpoint/addressing rules. They are not Akamai NetStorage. |
| C11 | Segment validation is unavailable for provider/output combinations that Bitmovin cannot read back, including GenericS3, S3 role-based, FTP, and Live. The UI must not promise it. |
| C12 | Live ingest `inputPath` depends on the input kind: account-default RTMP uses `live`; created redundant RTMP, SRT, Zixi, and HLS inputs use `/`. |
| C13 | Live codec streams reference the ingest input directly in `StreamInput`; video uses position 0 and audio position 1. Do not create standalone `IngestInputStream` resources. |
| C14 | SCTE-35 is observable only on a RUNNING channel with carriers enabled. fMP4 uses `signalScte35AsEmsg`; HLS/DASH manifests carry their matching marker settings. |
| C15 | Cloud Connect accounts, region settings, static IPs, and prewarmed pools have no update API; edits are delete-and-recreate. Akamai subnet/firewall identifiers are numeric. |
| C16 | Static IP: bind at create; used IP fails. Prewarmed: specific region (not aggregate/`AUTO`), VOD only, not Live. |
| C17 | Audio/video sync tweaks conflict with Dolby audio. Preview manifests are JIT-only, a preview-only manifest is not finalized, and Smooth has no preview list. |
| C18 | Cloud Connect encodings use `cloudRegion: EXTERNAL`; conversely, `EXTERNAL` requires infrastructure. Live static-IP/infrastructure configurations must also be region-pinned. |
| C19 | Conflicting ad-insertion clock synchronization and HLS program-date-time sources fail validation. Cache-control headers are limited to provider kinds that support them. |
| C20 | Never persist or return a vendor SDK's raw `err.message`. Classify it at the boundary and expose only redacted, stable error data. |
| C21 | Kantar audio watermarking is an encoding-level singleton; create replaces the existing value and requires an audio stream. |
| C22 | Kantar/ESAM credential-egress URLs require HTTPS, no URL userinfo, and an explicit host allowlist. Validate again at worker egress, not only at submit. |
| C23 | Azure listings terminate on the continuation token, not page size; an empty-string token means complete. Preserve delimiter semantics in both recursive and virtual-folder listings. |
| C24 | `GET /encoding/inputs` is the cross-type list and returns polymorphic provider objects. Proxy only an explicit safe projection; never leak provider connection fields. |
| C25 | The transfer-retries endpoint was removed. Do not rebuild retry/resume around a pinned SDK type; `TRANSFER_ERROR` status/webhooks remain, and recovery is a new encoding. |
| C26 | Secret credentials and public Player/Analytics client keys are different classes. Secrets stay encrypted/server-only; public client keys may cross the single browser configuration boundary. |
| C27 | Derive preview URLs from the credential provider and addressing mode, or return a coded non-derivable result. Never guess from a bucket or credential name. Akamai MSL has no object URL and Bitmovin never carries the delivery hostname: the link is the `AKAMAI_MSL` credential's declared `edgeBaseUrl` (https, no query/userinfo/trailing slash, public host) + `/<manifestName>`, else the coded `MSL_EDGE_URL_NOT_CONFIGURED`. It is the viewer's edge, not encoder health. |
| C28 | A `PER_TITLE_RESULT` stream has no reliable parent link or inherited name. Attribute only from exact witnesses (QC filename, applied settings, resolved rendition path, or an unambiguous sole-template fallback); otherwise abstain. |
| C29 | QC gates enforce their prerequisites: VMAF/PSNR rules require those metrics, delivery blocking requires post-encoding manifests, and a gate with nothing to block is surfaced. |
| C30 | A terminal Live encoding cannot restart. Re-airing a channel creates a fresh encoding/run; restart is only for a still-active provider encoding. |
| C31 | Akamai MSL `streamFormat` constrains muxings and manifests. MSL4 uses account authentication; MSL5 publishing credentials are vaulted and derive `enabled`. MSL manifests publish at the event root regardless of the manifest's `outputPath`, and the HLS child/segment URIs Bitmovin writes are RELATIVE to that `outputPath` — so a manifest moved into a run subtree cancels the subtree out of its own URIs; mirror paths are normalized with leading/trailing slashes. |
| C32 | Strip aws-sdk-js `x-id` from custom S3-compatible requests before signing. Do not alter AWS-native requests. |
| C33 | A muxing may contain multiple streams. An HLS variant whose segments already contain audio must not reference an external audio group; separated audio groups must match their variants. |
| C34 | One video codec per DASH set (VOD/Live); prefer one codec/job. Mixed plans need separate evidence. VOD H264/H265 presets conflict with START encodingMode (2025): reject before submit, never alter quality. AV1 unchanged. |
| C35 | A default manifest output path is a parent of every muxing path it enumerates. Do not place it in a sibling subtree or infer scope from only one output leg. |
| C36 | Insertable video must match the live INGEST exactly (position 0, H.264/AAC, resolution, frame rate, one audio stream, sample rate, channels, yuv420p, closed GOP); only MPEG-TS plays audio at the right rate (MP4/MOV: half speed); MKV never airs. The application transcodes non-matching movies to a matching MPEG-TS; matching TS and JPG/PNG stills (silent, letterboxed, duration required) register as they are. READY never proves playback. |
| C37 | Heartbeat: per-encoding only on resolved2.x≥2.285.0 ; create/list/customData GET/delete, max5/encoding, runtime add/delete, first push immediate. No account CREATE; owned legacy cleanup/history only; old versions Poll. Interval≥1s/default20; name required. HMAC, durable intent, owned cleanup. Per-encoding finished/error/transferError/liveManifestReady: create/list/delete; liveInputStreamChanged: create-only. |

## Interpreting coverage

Settings → API coverage distinguishes source-confirmed SDK operations from
unconfirmed ones. This is a source census, not a count of GUI fields, successful
provider calls, or verified delivery scenarios. Historical parameter survey
values have a separate date and must not be treated as current coverage.

Use one video codec per job for the simplest delivery workflow. MSL5 authoring
requires a compatible account/encoder and independent delivery validation; MSL4
success does not prove MSL5. Header-only MSL publishing is not supported.

A successful encode, available manifest, and browser playback are different
checks. Likewise, SDK model availability does not establish provider acceptance.
See [VOD](user-guide/VOD.md), [Live](user-guide/LIVE.md), and
[Quality and monitoring](user-guide/QUALITY-AND-MONITORING.md) for operating steps.
