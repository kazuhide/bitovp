# Encoding functionality gaps

Audit date: 2026-11-16. Baseline: `32910bd11f0221ad09288c0051ec8810bf7bd3b7`;
Bitmovin JavaScript SDK: **1.288.0**. This is a bounded source audit of encoding
creation and configuration, following the Error Definitions integration.
No paid encoding was started for this audit.

The November 25 follow-up uses the published JavaScript SDK 1.289.0.
Its Encoding surface has 1,098 operations. The four additions are the HDR10+
input-stream create, get, list and delete operations. The VOD wizard
and Worker now use HDR10+ create. The HDR10+ get, list and delete operations
lack a confirmed application call. Across all families, the current census confirms
656 of 1,098 operations in application source, including 157 of 219 create
operations. The remaining 442 operations lack a confirmed application call.
The separate cross-service inventory includes 84 notification operations
(76 Encoding-specific and eight shared) for a total of 1,182. Notification
operations are outside the application's Encoding-only census.

## How to read the results

The audit follows **form → validated plan → compiled operation → Worker → SDK**.
A missing direct SDK reference alone does not establish a missing feature.
Wrappers, alternate APIs and automatically generated settings can serve the same
purpose. GUI controls, valid expert JSON, generated settings and provider-tested
execution are different kinds of evidence.

The preceding operation census reported 1,094 Encoding operations, with 283
source-confirmed and 811 unconfirmed. Those 811 are **not** a missing-feature
count. Error Definitions adds a read operation; it does not change the creation
families below. Neither table is a full-field GUI coverage percentage.

## Creation families checked

The following counts describe the November 16 baseline. The individual entries below record subsequent implementations.

| SDK create family | SDK types | Existing creation paths | Gaps checked against the plan and Worker |
|---|---:|---:|---|
| Video configurations | 8 | 5 | H.262, MJPEG, VP8 |
| Audio configurations | 17 | 9 | PCM, passthrough, MP2, MP3, Vorbis, DTS, DTS passthrough, DTS:X |
| Subtitle configurations | 3 | 2 | DVB subtitle |
| Input streams | 13 | 10 | CEA608, CEA708 and DVB subtitle extraction |
| Filters | 17 | 10 | AudioMix, AzureSpeechToCaptions, Conform, DolbyLoudness, EnhancedDeinterlace, EnhancedWatermark, Interlace |
| Direct muxing types, excluding DRM/ID3 children | 16 | 10 | Broadcast TS, MP3, MXF, Packed Audio, Progressive WAV, Segmented Raw |

The five video paths include account-restricted HEVCv2. Existing audio paths
are AAC, AC3, EAC3, Opus, Dolby Atmos, Dolby Digital Plus and Dolby Digital.
An absent AudioMix **filter** API is not a missing mixing capability: the app
already uses AudioMixInputStream. Adding a second mixing mechanism is not a
priority.

The November 16 operation counts use the baseline revision's
`apps/web/src/data/api-coverage/current.json`, selecting each family's direct
resource-type `create` methods. For muxings, use
`encoding.encodings.muxings.<type>.create`; nested DRM and ID3 frame creation
methods are excluded. Closed discriminated unions in `packages/core/src/plan/schema.ts`,
`packages/core/src/plan/media-filters.ts` and Worker dispatch in
`apps/worker/src/orchestrator/ops/{configs,media,media-filters}.ts` establish the
application paths. SDK model declarations are available in the
[fixed official SDK tag](https://github.com/bitmovin/bitmovin-api-sdk-javascript/tree/v1.288.0/src).

## Existing capabilities to retain

- H.264/H.265/VP9/AV1, account-gated HEVCv2, codec detail controls including
  H.264 `autoLevelSetup`, AV1 `maxLevel` and `detailPreservationMode`.
- Four-codec VOD Per-Title, result capture and manifests; no Live Per-Title claim.
- Trimming, concatenation, audio mixing and independent video/audio timeline
  editing. Provider qualification guards still apply to independent programmes.
- WebVTT/TTML/IMSC sidecars, SRT burn-in and CEA subtitle passthrough. Extraction
  into a separate subtitle track is a different capability.
- HDR/Dolby configuration, fMP4/CMAF/TS/MP4/WebM/text and progressive file outputs,
  HLS/DASH/Smooth, CENC/FairPlay/SPEKE under their existing restrictions.
- Live RTMP/redundant RTMP/SRT/Zixi/HLS ingest, pools, stream keys, DNS, stop
  timers, slate, ad markers/insertion, Live-to-VOD, archives and AISA for Live.

These are source paths, not a claim that every setting, account, encoder version
or delivery combination has been exercised. Existing warnings for unmeasured
containers and unsupported combinations continue to matter.

## Recommended implementation order

### E01 · P1 · HE-AAC v1 and v2

HE-AAC v1/v2 are available in the VOD and ordinary Live audio ladders. Saved presets and channel duplication preserve optional sampling rate, layout and signaling. VOD uses segmented fMP4; Live also supports HLS with TS. Each profile calls its dedicated configuration endpoint and streams use that configuration’s ID. Offline SDK tests verify the request; a provider encode and device playback remain unmeasured.


### E02 · Stream Conditions authoring and AND/OR

VOD streaming and file wizards expose input conditions on their available
renditions. Live exposes them on video and audio renditions. The editors and
Expert JSON preserve single comparisons and nested AND/OR groups. Plan
validation checks stream type, Live availability and value format. The Worker
and YAML export serialize the same comparisons and groups. The global VOD audio
guard combines with any condition already present on the audio rendition.
See the [official Stream Conditions guide](https://developer.bitmovin.com/encoding/docs/stream-conditions).

### E03 · P1 · PCM/WAV, then bounded audio passthrough

The VOD file wizard can now convert a selected audio track to PCM/WAV. It can also copy one inspected AAC track to MP4 or MOV, or one signed-integer PCM track to MOV or WAV. The Worker binds the selected track and immutable object version before creating its input stream. Editing, mixing, filtering and streaming manifests are outside the copy workflow.

Tests cover the installed SDK's request bodies, plan round trips, tenant-scoped evidence and output-file verification. The local media fixture produced all five combinations and preserved the selected audio payload in the four copy cases. Provider execution remains unverified. [VOD file workflow](user-guide/VOD.md#audio-only-files) · [Encoder release history](https://developer.bitmovin.com/encoding/docs/encoder-22000-22490)

### E04 · P1 · Embedded caption extraction

VOD operators can select a CEA-608 channel, CEA-708 service or DVB subtitle
track and extract it to WebVTT for a sidecar file or HLS. The Live wizard
extracts DVB bitmap subtitles from supported transport-stream inputs and
packages WebVTT for HLS or DASH. Drafts and templates retain the selections.
These workflows are covered by local compiler and SDK transport tests.
Provider OCR quality, source-specific timing and receiver playback still need
validation on representative media. [VOD guide](user-guide/VOD.md) · [Live guide](user-guide/LIVE.md)

### E05–E07 · P2 · Purpose-specific extensions

- **Filters:** The VOD wizard supports EnhancedWatermark, EnhancedDeinterlace,
  and Interlace for video, Conform across the encoding’s video and audio streams, plus AudioMix and DolbyLoudness on compatible
  audio renditions. Audio Mix runs before volume and loudness processing. The VOD plan checks that order and rejects Audio Mix or Conform on Dolby Atmos file inputs.
  Provider output and visual or loudness measurements require a matching source
  and an encoding run. Live speech-to-captions remains a separate workflow.
- **Broadcast delivery:** Broadcast TS/MXF with H.262/MP2/PCM, driven by a
  specific delivery specification. Progressive TS does not expose the same
  PCR/PID/PAT/PMT controls. MJPEG, VP8, MP3, Vorbis and DTS need an identified
  use case, entitlement and playback target.
- **Encryption/delivery:** AES-128/ClearKey are absent choices; CENC already
  serves Widevine/PlayReady use cases. The VOD wizard supports SPEKE on fMP4, MP4, TS, progressive TS, WebM
  and progressive WebM. Standalone progressive TS and WebM files also support
  FairPlay and CENC respectively. Live MSL/SFTP mirrors are valid expert-JSON paths with a
  missing GUI authoring path; primary MSL is already supported.

### E08 · P3 · Other inputs and management

VOD input plans currently support S3, HTTPS, Akamai NetStorage, Azure,
GenericS3 and the two GCS credential variants. FTP/SFTP/Aspera/direct-upload/
local/S3-role-based inputs need their own end-to-end audit, including stored
credentials, browser access and output inspection. Output support for a
protocol does not imply input support. MoQ output still requires account-level Beta access. The Live wizard
can now author compatible Custom Live plans using a stored MoQ relay credential.
A documented Cloudflare draft 16 trial with Encoder 2.294.0 observed moving
640×360 video in Player Web X. Draft 18 interoperability and other relays require
their own verification. See the [Live wizard guide](user-guide/LIVE.md#experimental-moq-delivery)
and [trial conditions and results](MOQ-LIVE-ENCODER-TEST-RESULTS.md).

VOD job details and Live run details now support inspecting provider resources
recorded by their execution steps. Available actions depend on the resource
family and include scoped collection browsing, metadata checks and operator-
confirmed removal on a finished execution. See the [VOD guide](user-guide/VOD.md#inspect-or-remove-a-provider-resource)
and the [Live guide](user-guide/LIVE.md#inspect-a-runs-provider-resources) for the
supported actions and safeguards.
Account-wide inventory and native Templates and Watch Folders remain separate
from these job- and run-scoped controls. App presets and watch rules use their
own storage.

## Evidence limits and future verification

No current claim is made about all SDK fields' server writeability,
conditionally required fields, full GUI coverage, all Live/VOD support
conditions, new output quality or processing time. Those require additional
documentation and authorized executions.

Live subtitle translation has a documented Syncwords integration; its exact
current entitlement/API conditions remain unqualified here. Do not generalize
the app's missing Live subtitle path into a claim that the provider lacks it,
or introduce an external translation service as a replacement for the local
model policy. See the
[official Live translation article](https://bitmovin.com/blog/live-translation-live-encoder/).

For each addition, keep form/JSON → plan → compiled operation → actual SDK wire
tests. When paid verification is authorized, separately record provider
resource readback, output stream structure, manifest references and playback
under the tracked job. Source confirmation, provider acceptance and verified
deliverables must remain distinct evidence states.
