# API usage (machine clients) — the external contract

The following workflows describe machine access alongside the GUI. The API is
not versioned; review changes before upgrading automation.

## Dashboard usage

`GET /api/dashboard/usage`, OPERATOR automatic/manual imports and label reads: [contract](user-guide/QUALITY-AND-MONITORING.md).

## Authentication

Mint a token in **Settings → API tokens** (or headless:
`pnpm --filter @bitovp/web auth:create-token -- --name ci-runner`). The
secret is shown **once** and stored only as a hash.

```bash
curl -H "Authorization: Bearer bo_…" https://ovp.example.com/api/encoding-jobs
```

Facts a machine client must know (each is deliberate, most are pinned by
tests):

- **Tokens gate `/api/*` only.** Pages are session-only; a token never opens
  the UI.
- **The token path never falls back to sessions.** A bad token is a
  `401 {"error":"Invalid API token (<reason>)"}` even if a valid session
  cookie rides the same request — mixed fallbacks hide misconfigured clients.
- **Invalid auth configuration fails closed for tokens too.** After token
  identity verification, a failed auth-config parse returns **503** with
  `AUTH_NOT_CONFIGURED` before authorization, including self-revocation.
  Mode spellings are lowercase (`AUTH_MODE=users`, not `USERS`); blank/unset
  defaults to `password` and requires valid password configuration. A token is
  not a recovery path for broken configuration: fix the environment first.
  Token revocation and membership changes are checked fresh on each request.
- **TLS only.** Nothing in the gate refuses plain http; sending a bearer
  secret over http is on the caller. Terminate TLS in front of this app.
- **Set `ALLOWED_ORIGIN_HOSTS`.** Unknown hosts are denied. Resolved public ingress
  can deliver webhooks without being statically listed; a DNS-named hostname not
  explicitly allowed reaches only receivers and `/api/health`, including tunnel
  names. UI/API requests return403: `This host serves only the webhook receiver`.
- **Bitmovin's inbound path is not yours.** `/api/webhooks/bitmovin/<scope>/<token>`
  verifies HMAC over the raw body; unknown token404, bad signature401, no persistence.
  Bearer auth cannot replace this. The old scope-less receiver is gone.
  Registration is automatic per encoding. `GET /api/webhook-registrations` is VIEWER;
  OPERATOR `POST /api/webhook-registrations/reconcile` retries waiting registrations.
  `/api/webhook-registration` lists/deletes account-level hooks, not manual creation.
  Unknown notes show `details withheld`; registrar audit bodies/errors are summarized
  while preserving HTTP status/error presence. Other actors are unchanged.
- A database outage during verification is a
  `503 {"error":"Token verification is unavailable (database)"}` — your
  credential is fine; retry.
- **Pagination is the EXCEPTION.** Exactly nine collection routes use cursor
  pagination — `access-events`, `audit-logs`, `encoding-jobs`, `feeder-sessions` (name-only `liveChannel: {name}`), `live-channels`,
  `live-channels/[id]/runs/[runId]/heartbeats` (the per-run heartbeat log, ≤ 500
  rows a page, `from`/`to`/`cursor`), `live-channels/[id]/runs/[runId]/heartbeat-receipts` (Push, default100/max200), `vmaf-jobs`, `webhook-events` (heartbeat pushes are left out unless `includeHeartbeats=1`) — and they are the ones that
  return an envelope with `nextCursor`. Other collections return a bare array
  (`presets`, `api-tokens`, `watch-rules`, `alert-rules`,
  `storage-presets`, `live-channels/<id>/schedules`) or an ad-hoc object
  (`users` → `{users}`, `live-channels/<id>/runs` → `{runs}`,
  `live-channels/<id>/alerts` → `{open, history}`). These are examples, not
  exhaustive sets. Clip projects separately use offset pagination:
  `GET /api/library/edits?contentId=<uuid>&offset=0` returns
  `{items,offset,total}`, at most25 per page. Stop when `offset + items.length >= total`.
  Non-paginated collections have neither `items` nor `nextCursor`,
  and some are unbounded. **Read each route before looping**: neither pagination
  nor arrays are universal.
- **On the nine that do paginate by cursor, a missing `nextCursor` is the ONLY end-of-list
  signal; a short page does NOT mean the end** (C6). Loop until it is absent.
- **400 is a SHAPE failure; 422 is a SEMANTIC one.** This is the intended
  distinction for new routes: malformed bodies carry zod issues; valid but
  impossible requests carry a reason and sometimes `issues`.
  Older routes differ. Live create returns400 for plan validation and unknown
  account/template; startup-probes returns422 for the same unknown-account message.
  Read the actual status; unchanged invalid bodies are not transient retries.
  Per-Title encoding import also returns 422 when its resource limit is exceeded.
  Live-to-VOD reports supported manifest families; incompatible slate input has
  `details.code = "SLATE_INCOMPATIBLE"` and attribute differences before creation.
  Picked sources may enter normalization instead; see Workflow2.
- **Rate limiting is per token**: bulk ops 5–30/min, storage inspections 20/min,
  playback-cors 30/min. Sessions instead share per-IP/install-wide buckets.
- Token ROLE is enforced in every `AUTH_MODE`, including `none`. Default:
  OPERATOR; VIEWER reads only. ADMIN is required for `/api/audit-logs`,
  `/api/api-tokens`, `/api/users`, `/api/admin/reset`, writes under
  `/api/credentials`, `/api/bitmovin-accounts`, `/api/infrastructure/prewarmed-pools`,
  `/api/live/standby-pools`, settings (including `/api/settings/startup-probes/run`),
  `/api/live-channels/[id]/runs/[runId]/heartbeats/export`,
  and `POST /api/per-title-simulator/encodings/import`.
  Refusal: `403 {"error":"This action requires the ADMIN role","minRole":"ADMIN"}`.
  OPERATOR is also required for credential-bearing reads at
  `/api/live/stream-keys/<id>`, `/api/credentials/<id>/storage/buckets`,
  and run diagnostic reads documented below.
- Tokens cannot mint tokens (`403` on `POST /api/api-tokens`), and
  **only an ADMIN token can revoke SOMEONE ELSE'S — in every mode**. The
  inventory `GET /api/api-tokens` is ADMIN too. **But a token may always revoke ITSELF**:
  `DELETE /api/api-tokens/<id>` with its OWN token id works for any
  role, in any mode, without ADMIN (`SELF_REVOCATION_EXCEPTION` in
  `apps/web/src/lib/auth/roles.ts`). Revocation is checked on the next request.

- `/api/settings/clip-editing` — GET/POST (ADMIN): GET reports local clip configuration without connectivity checks. POST `{}` requests a bounded metadata-only diagnosis through the editing service and returns independent configuration/service/model states. It does not load models or run inference. Responses are `no-store` and omit connection secrets.
- `/api/settings/api-coverage` — GET (VIEWER): bundled current source census,
  installed/surveyed SDK and mismatch flag, current top-level SDK body-model
  properties with conservative direct property-key evidence, plus a separately
  dated historical parameter snapshot. No provider/DB calls. Source evidence
  is not proof of GUI reachability, API writeability, or runtime success.

- `/api/per-title-simulator/encodings/import` — POST (organization ADMIN, no view-as):
  read the original Per-Title settings of an Encoding ID. Send either
  `{encodingId, bitmovinAccountId}` for an account in the current organization,
  or `{encodingId, apiKey, tenantOrgId?}` for temporary credentials; the two forms
  cannot be mixed. IDs must be UUIDs. The temporary key is not saved.
  Returns `{configurations:[{codec,goal,reference}],issues:[{codec?,code,fields?}]}`.
  Each codec has separate encoding-level and source-template Stream settings.
  Generated result streams, audio, storage bindings and credentials are excluded.
  Output-count intent is unspecified. Missing overall bitrate limits or unsupported
  settings are reported without silently discarding them. Omitted spacing parameters
  remain absent in the reference; the UI identifies the simulator's starting values
  before loading them. Only provider GETs run,
  with a shared 20-second deadline and bounded pagination. Responses are
  private/no-store. In the simulator, imported settings are for comparison and
  analysis only: Apply to draft is disabled, and the original job is unchanged.
  Adjusted values can be saved as a requirements file. Importing never creates
  or starts an encoding.

- `/api/admin/reset` (organization ADMIN session, no tokens): GET `?categories=<comma list>` previews selected counts. POST `{confirm:"RESET",categories:[...]}` force-deletes selected organization data and returns `deletedCounts`. Empty/duplicate/unknown/incomplete dependencies fail validation. Global users, memberships, organizations and setup identity are excluded; reset does not reopen setup. Active work and unresolved cleanup do not block selected deletion; organization-owned encrypted receipts retain cleanup ownership. Library editing records are protected: dependent category selection returns409 `RESET_LIBRARY_EDITING_REFERENCES` before deletion. The preview reports their count; this release does not delete an editing graph through Reset.
- `/api/admin/reset/reconcile`: POST ADMIN, audited, no tokens. Stamps terminal,
  never-started or absent pointers. Absence: status/entity404+1001, authenticated
  list, account unchanged since row/parent creation, locked account/pointer CAS.
  Generic404/auth/network failures or active work block. No lifecycle/stop/delete.
  Returns `{confirmed[],running[] (+providerStatus),unverified[] (+message)}`.
- `/api/settings/live-heartbeat` (C37): GET `{effective, source: gui|env|default,
  stored, envDefault, bounds}`; audited ADMIN PUT `{intervalS:0|1..3600,
  idleMinutes:1..10080, mode?:PER_ENCODING|AUTO|LEGACY_ACCOUNT}` / DELETE resets defaults.
  Mode aliases normalize to PER_ENCODING; idleMinutes is compatibility-only.
  New runs freeze interval; 0 retires hooks. Unsupported versions Poll.
- Channel detail `heartbeatReception`: verified exact-run `latest`/`previous`
  samples deduplicated by provider time, receipt/sample clocks and frozen cadence.
  Safe `registration`: mode/requested/resolved version/status. `timeline`: newest50
  receipts with coverage/truncation. Null latest=no usable sample; Poll unchanged. [Usage](user-guide/LIVE.md).
- `GET /api/live-channels/<id>/runs/<runId>/heartbeat-receipts`: OPERATOR;
  exact channel→run→encoding, signed Bitmovin HB only. `{run,rows,nextCursor?}`;
  each receipt has `id,receivedAt,sampledAt,value` (allowed numeric/enum/time
  fields only; no URL/signature/free text). Retries remain distinct. Newest first,
  `limit=1..200` (default100), URL-encoded `cursor=receivedAt|id` from prior page;
  strict descending keyset, including same-time ties. Invalid input400, foreign
  run404, read failure5xx (not empty success). No provider call or mutation.

## Public request body limits

`POST /api/auth/login` accepts up to **4 KiB**, `POST /api/auth/setup` up to
**8 KiB**, and `POST /api/webhooks/bitmovin/<scope>/<token>` up to
**1,000,000 bytes**. These are received UTF-8 byte limits, including streamed
bodies; non-ASCII characters can occupy several bytes. An oversized request
returns **413**. Reduce the payload before retrying. Webhook signatures cover
the exact received bytes, including whitespace and newlines: do not reformat
or re-serialize JSON before signing it.

The standard ingress can return 413 before authentication, configuration or
webhook-token checks. A route response already sent before a size violation
keeps its status. Within the webhook handler, unknown tokens are still rejected
before reading the body.
These three paths also receive the same ingress limits through
`/_next/data/<build-id>/...json` aliases, including stale or unknown build IDs.
Indexed aliases for these paths receive the size check even when the framework
would otherwise reject their dynamic or interception-route syntax.

## Organization and identity

`AUTH_MODE=users` requests are bound to a verified organization. Tokens cannot
switch organization; effective role is the lower of token cap and membership.
Password/none compatibility is Main-only. Foreign IDs are inaccessible; a token
or caller-supplied organization header cannot change ownership. Read-only view-as
rejects writes, including queue operations. [Full contract](user-guide/LIBRARY-AND-ADMIN.md#organizations-and-access).

- Human sessions: `GET /api/account/organizations`; `POST /api/account/organization`
  `{organizationId}` preserves the original session deadline and rechecks membership/IP.
  `x-bitovp-expected-org` mismatch returns409 for stale tabs.
- `GET /api/organizations` returns permitted organization metadata. Organization ADMIN
  `PATCH /api/organizations/[id]` manages its IP policy. Owner-only organization creation
  and `PATCH /api/platform/organizations/<id>`/membership management require a human
  platform-owner session; an ADMIN token is insufficient.
- Owner-only `POST /api/account/impersonation` `{organizationId,targetUserId,currentPassword}`
  starts read-only view-as for at most15min; DELETE exits without extending login expiry.
- ADMIN `GET /api/access-events?limit=50` returns `{events,nextCursor}` for the current
  organization. Cursor is an event UUID, limit1..100; foreign cursor404. These are
  non-admin access-gate decisions, not downstream provider/completion statuses.
  Query/body/secrets and background GETs are excluded.

## Retry a creation safely

For `POST /api/encoding-jobs` and `POST /api/live-channels`, send an
`Idempotency-Key` header to identify one intended creation. Generate the key once
and reuse it with the same body after a timeout or lost response. Use a new key
for a deliberately new job or channel, even when its settings are identical.
Keys accept 1–200 letters, digits, periods, underscores, colons, or hyphens.
Requests without this header retain the existing behavior: each accepted request
creates new work.

In the examples below, set `CREATE_KEY` to a key generated once for that intended
creation. Preserve it for retries; replace it before creating new work.

- A successful new creation returns `201`. A repeated request with the same key
  and content returns `200`, the same resource ID, and `replayed: true`.
- Reusing a key with different content returns `409`, with
  `details.code: "CREATE_REQUEST_CONFLICT"`.
- If the original job or channel has been deleted, the key returns `410`, with
  `details.code: "CREATE_REQUEST_GONE"`. It never creates a replacement.
- Keys are separate for each organization and creation endpoint. Creation
  receipts survive job/channel deletion and administrative reset.
- Do not combine this header with the verification-only `verificationKey`,
  `requestSha256`, or `verificationDispatch` fields; that returns `400`.

A replay returns the resource's current state and does not queue it again.
If it reports an enqueue error, use its normal retry or start action. A process
interruption between saving a job and queueing it can leave VOD work `QUEUED`
without a queue entry; replay does not repair that dispatch. Check worker and
queue state before starting over. Receiving the same ID confirms creation, not
successful encoding or delivery. Keep the key and exact submitted body in your
automation's private records; do not post credentials or plans containing secrets
publicly.

## Workflow 1 — VOD submission

AISA `automaticAdPlacement.schedule`: nonempty `{position,maxDeviation,duration?}` rows in seconds, finite ≥0. Zero is preserved; see [contract](user-guide/VOD.md#quality-checks-and-scene-analysis).

`GET /api/library/sources/<id>/media?key=<output-key>`: VIEWER MP4, exact object; private/no-store, Range≤4MiB. Large un-ranged416, canceled408, missing404 (`MEDIA_FILE_NOT_FOUND`), changed409, storage502; upstream401/403→`MEDIA_STORAGE_ACCESS_DENIED` (Library/VMAF). No locators/secrets.
Library: VIEWER read/OPERATOR write; FINISHED auto-capture. `GET/POST /api/encoding-jobs/<id>/analysis`: `{enabled,captureSuppressed,source}` / idempotent `202 {sourceId}`. `GET /api/library/sources/<id>`: snapshot/analyses, no locators; detail `providerAnalysis?:{data,source:PROVIDER|NORMALIZED}`: ≤8MiB JSON, read-time redaction, labeled normalized fallback; search unchanged. `POST /retry`: ERROR→202, else409; no reanalysis. Non-AISA:`und`.

Library search/options: [HTTP contract](user-guide/LIBRARY-AND-ADMIN.md#content-library-and-storage).
Label paging/exact/cache: [contract](user-guide/QUALITY-AND-MONITORING.md).

Library: [catalogue/scene endpoints, query limits and DTOs](user-guide/LIBRARY-AND-ADMIN.md#content-library-and-storage). Reads VIEWER, writes OPERATOR.

### Library clip editing

Reads require VIEWER; writes (including suggestions) require OPERATOR. UUIDs and
strict JSON bodies are validated; mutation bodies are limited to512KiB. Source
storage locations remain private; clients choose a server-listed `fileKey`.

| Route | Contract |
|---|---|
| `GET /api/library/sources/<id>/editing-eligibility` | `{sourceId,files:[{key,label}],mediaVersions,analyses}` |
| `POST /api/library/sources/<id>/media-versions` | `{fileKey,output:{credentialId,bucket,prefix}}` →202 media version; pins the selected object's identity |
| `GET /api/library/media-versions/<id>` | Preparation state, safe error, time map, dimensions and authenticated media URL |
| `POST /api/library/edits` | `{contentId,mediaVersionId,title,variant:LANDSCAPE|PORTRAIT,analysisRevisionId?}` →201 project; requires READY material |
| `GET /api/library/edits?contentId=<id>&offset=0` | `{items,offset,total}`, page size25 |
| `GET /api/library/edits/<id>` | Draft, `draftRevision`, current immutable revision, `currentRevisionMatchesDraft`, pinned analysis and recent runs |
| `PUT /api/library/edits/<id>/draft` | `{expectedRevision,document}` →200 project; stale revision409 `EDIT_CONFLICT` |
| `POST /api/library/edits/<id>/revisions` | `{expectedRevision,confirmSuggestions:boolean}` →201 project; unconfirmed AISA framing cannot render |
| `POST /api/library/edits/<id>/suggestions` | `{query,sceneIds?,targetDurationFrames?}` → candidates; leaves the draft unchanged |
| `POST /api/library/edits/<id>/renders` | `{revisionId,kind:PREVIEW|EXPORT,requestKey:<uuid>}` →202 run; replay the same key/body after an uncertain response; a changed body with the same key returns409 |
| `GET /api/library/renders/<id>` | State and artifact URL; active exports also expose `artifact.derivedContentId` |
| `POST /api/library/renders/<id>/cancel` | →202; queued work cancels immediately, running work remains cancellation-requested until its process stops |

### Composition and production tasks

`document.schemaVersion:2` adds up to 8 pinned media sources, 4 video layers,
8 audio tracks, 128 animated crop points, 32 text/PNG overlays, 300 caption cues
and 2,000 timed words. Output remains 30fps and at most 180 seconds,
with 20 video clips. Presets produce editable fields. V1 documents and render
hashes retain their original contract. Additional source/image references are
retained for historical revisions even after removal from the draft.

Optional `presentation:{version:"portrait-layout-v1",videoFit?:AUTO|FILL|FIT,
captionPlacement:OVERLAY|BANDS,fallbackFraming?:"AISA_STATIC_V1",
centerCropConfirmed?:boolean}` controls the main video and caption area.
FILL retains a portrait crop; FIT shows the whole source. AUTO retains measured
or manual crops and puts the whole source over a blurred background elsewhere.
BANDS reserves the top/bottom 18% independently of caption presence. Custom
layouts, picture-in-picture and upper video tracks retain their own geometry.
Missing fields do not migrate existing documents or alter their render hashes.

With `fallbackFraming:"AISA_STATIC_V1"`, new drafts may have an optional
`clips[].fallbackCrop:{x,y,w,h}`. This fixed, normalized crop applies only to
untracked FIT intervals in the main FILL video. It leaves raw framing intervals
and measured crop keyframes intact; it does not constitute a measured track.
Candidate selection changes this rectangle through the normal draft/revision
flow. Generating requires review of unconfirmed framing.

`audioTracks[].ducking.source:"CAPTIONS"` derives gain intervals from the current
caption cues at compile time, with at most 64 captions. Store `intervals:[]` for
that mode. Omitting `source` preserves explicit fixed `intervals` (up to 64),
including existing saved documents. Compilation does not mutate the input JSON;
the browser and FFmpeg consume the same compiled automation.

| Route | Contract |
|---|---|
| `GET /api/library/editing-media` | Up to100 READY tenant media versions with safe URLs and composition facts |
| `GET /api/library/analysis-associations?mediaVersionId=<id>&analysisRevisionId=<id>` | Fixed media, normalized scene analysis and association kind |
| `POST /api/library/analysis-associations` | Same tuple, UUID `requestKey`, `confirmation:{time:true,geometry:true,content:true}`; records server-owned `EDITOR_ATTESTED` evidence |
| `POST /api/library/media-tasks` | `{kind:TRANSCRIBE|TRACK|GENERATE,mediaVersionId,analysisRevisionId?,requestKey,parameters}` →202 `{taskId,state,cached}` |
| `GET /api/library/media-tasks?mediaVersionId=<id>&offset=0` | `{tasks,hasMore}`,25 rows per page |
| `GET /api/library/media-tasks/<id>` | State, phase, progress, bounded result and safe error |
| `POST /api/library/media-tasks/<id>/cancel` | Cancels pending work or requests running cancellation |
| `POST /api/library/media-tasks/<id>/retry` | `{requestKey:<uuid>}` creates a new child task; terminal history is preserved |
| `POST /api/library/edits/<id>/images` | `{pngBase64}`;8-bit nonanimated RGB/RGBA/grayscale PNG ≤8MiB and2048²; strips ancillary metadata, stores pinned identity |
| `GET/HEAD /api/library/image-assets/<id>/media` | Bound organization assertion, authenticated immutable PNG bytes |
| `GET /api/library/editing-font` | Managed Japanese font shared with the renderer; private cache |

GENERATE parameters are `{contentId,targetDurationFrames,renderMode?:DRAFT|EXPORT,
draftPolicyVersion?:"duration-review-v2",presentation?,policy:AUTO|COHESION|DURATION|LOCAL_STORY,
storyMode?:AUTO|FLOW|THEME,
query?,templateId?,variants:1|2|3,captions:OFF|AUTO,tracking:boolean,language:auto|ja|en,
transcriptionTaskId?,trackingTaskId?}`.
Defaults and exact bounds are in the core `mediaTaskCreateSchema`. The historical
default remains COHESION. AUTO requires explicit DRAFT and is the new-project UI
default when the local semantic service is not configured: bounded English/Japanese metadata cues rank events and preserve whole-shot
context without a required query. This is a deterministic metadata heuristic,
not learned scene understanding. Only COHESION accepts a nonempty query; DURATION
prioritizes length. Every selected shot remains in source order. AUTO stores
versioned `semanticEvidence` as immutable creation provenance; it is rebuilt after
speech refinement and does not describe subsequent manual edits. Missing useful
cues falls back to cohesion; exhausted optional ranking falls back to a validated
window. Prepared AUTO uses `aisa-prepared-content-highlight-v4` with the existing
v3 frame clock and immutable normalization receipt. Missing or unreliable
ASR/tracking produces explicit warnings
and FIT/segment-only evidence, never invented word times or motion. An explicit
DRAFT intent creates editable projects and immutable revisions without render
runs or derivative reservations. Only explicit editor generation encodes them.
An EXPORT task atomically queues projects and EXPORT runs; inspect the render
state before claiming an MP4 is ready. `presentation` and the draft duration
policy require explicit DRAFT intent. Generation presentation omits
`centerCropConfirmed`, includes the framing policy in request/cache/result
identity, and cannot preconfirm a proposal.

LOCAL_STORY requires explicit DRAFT and a configured authenticated local semantic
Gateway; otherwise intake returns `LOCAL_STORY_ENGINE_UNAVAILABLE`. Configured
new-project forms default to this policy with `storyMode:AUTO`; FLOW follows the
observed narrative and THEME groups related observations. Only LOCAL_STORY accepts
storyMode. The server pins a distinct LOCAL_OLLAMA model/runtime/schema/config
identity in the task envelope. It does not reactivate the withdrawn STORY/Codex
provider. There is no client-supplied model, endpoint, schema or shell command.

LOCAL_STORY prepares a full-source transcript when available, including when
captions are OFF, and analyzes all eligible shots in coverage-preserving chunks.
Immutable transcript/ledger/blueprint receipts bind source, clock, analysis and
model identities. The planner uses real shot or observed utterance spans, retains
source order and required beats, and rejects an infeasible duration rather than
inventing cuts. Local story evidence is separate from AUTO heuristic provenance.
These DRAFT tasks create no render runs; export remains a separate editor action.
Existing tracking and preserve-source framing are reused; this policy does not
add visual object recognition or establish semantic accuracy. An externally
supplied transcriptionTaskId is rejected for LOCAL_STORY.

New caption-enabled non-LOCAL_STORY GENERATE tasks pin the speech-selection policy version in
their server-owned envelope. They transcribe a bounded context around the anchor,
refine whole-shot selection against observed speech spans, and then derive captions
and tracking from that final selection. The immutable result records the context,
boundary decisions, model identity and transcript fingerprint. Known unsafe ends
are rejected; missing ASR or unknown physical source edges are explicitly labeled
fallbacks. Internal context limits are not treated as source edges. An unsupported
unfinished legacy policy fails with `SPEECH_SELECTION_POLICY_CHANGED`; completed
history and same-key receipts remain readable. `NO_SPEECH_SAFE_WINDOW` asks for a
different desired length rather than silently cutting known speech.

AUTO DRAFT proposals share one 200,000-expansion budget across initial ranking
and speech refinement. If additional speech search reaches that limit, the
validated initial timeline is retained with observed speech evidence and
`SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED`; it is not described as speech-safe.
The worker does not reset the budget or start an export. Other policy failures
remain unchanged.

The prepare-and-generate UI composes the existing preparation and task endpoints;
it does not add preparation idempotency or cancellation to the API. It polls only
the returned material ID, pauses for unverified associations, and uses the same
GENERATE key/body to recover an uncertain task response.

Completed TRANSCRIBE/TRACK prerequisites must match the immutable source, analysis,
time map, language, model, algorithm and tracking frame clock, and must cover the
selected window. Invalid, unverified or incomplete prerequisites are refused.
New tracking uses `cfr30-frame-clock-v1`; unfinished legacy tracking tasks fail
before cache adoption, while completed legacy history remains readable. Distinct
GENERATE request keys always create fresh projects rather than returning mutable
projects from an earlier request. Same-key idempotent replay is preserved.

Future trusted input capture is disabled unless both
`BITOVP_CAPTURE_INPUT_BASE_URL` (HTTPS origin) and
`BITOVP_CAPTURE_INPUT_SECRET` (at least32characters) are configured.
`GET/HEAD /api/encoding-input-captures/<id>/content` authenticates its own
receipt-bound expiring Basic HMAC capability; it does not accept UI cookies
as capability proof. The provider input uses a pinned object version or
generation. Only single-input, zero-start, transform-free ingest is admitted.
Authoritative account/encoding/locale-bound analysis retrieval plus verified
normalization receipts can produce `CAPTURED_INPUT`. Legacy snapshots never
acquire that provenance retroactively. Capture credentials are not logged.

`GET /api/library/media-versions/<id>/media` and
`GET /api/library/artifacts/<id>/media` use the saved object identity and size,
private/no-store responses and bounded Range reads. Native media URLs carry
`expectedOrganizationId`; a different active organization is refused. Library
playback and re-editing of derived sources use the artifact's saved identity too.

`GET /api/library/artifacts/<id>/download` streams the complete MP4 as an
attachment, using bounded reads of the same saved object version. Use the
artifact's organization-bound `downloadUrl` for files larger than4MiB. If the
object changes or a transfer becomes incomplete, the download fails; it does not
concatenate bytes from a new version. Preview range limits stay unchanged.

Preparation supports MP4/MOV H.264 or 8bit HEVC, yuv420p, BT.709 SDR,
progressive fixed 24/25/29.97/30fps, square pixels, no rotation and zero-based
video/audio timestamps; optional audio is mono/stereo AAC at 44.1/48kHz.
The video stream must declare its duration
and integer frame count; fragmented MP4 with unknown frame count is unsupported.
Decoded frames must match those declarations, and decoding errors or truncated
media are refused before READY. Supported frame rates are mapped to 30fps;
fully tagged compatible 30fps bytes are preserved. Otherwise supported 8bit
inputs with all three color description fields unrecorded use the explicit
`BT709_8BIT_LIMITED_ASSUMED` source profile and always take the `NORMALIZE` path.
This records an editing default, not proof of the original color interpretation;
`IDENTITY_COPY` is invalid for that profile. Explicit HDR, contradictory color
metadata, full range, VFR and other unsupported inputs are rejected.
Source download is limited to 4GiB and 60 minutes. Edits contain at
most 20 clips and 180 seconds; V1 retains its 128 framing-segment limit.
Preview and master use the same immutable recipe. Master canvases include
1920×1080, 1080×1920, 1080×1080 and 1080×1350 MP4. Only successful EXPORT runs publish to a stable derived Library
entry; previews do not. Original content and analysis are preserved. AISA center
points support per-shot proposals with explicit timeline/orientation review;
continuous tracking uses additional frame measurements through production tasks.
Manual framing changes set `manualOverride:true` so repeated suggestions preserve
an explicitly chosen fit as well as crop. Save and confirmation responses describe
the document committed by that CAS; a later editor's save is never substituted.
Both input and output storage credentials remain protected by tenant-scoped
references while an editing material uses them. Pending artifact adoption and
Library registration retry after a30-second wait, without occupying the next
eligible render's turn. The pending artifact identity survives those retries.

The `bitovp-editing` path segment, including case variants, is reserved for managed
editing output. Watch-folder scans and submission retries exclude that namespace
independently of credential aliases and rule creation time. Re-encoding such an
output requires an explicit manual submission.

### Submit an encoding job

Send `{"plan": <EncodingPlan>}`; a bare plan returns 400.
[Native HEVCv2 contract](user-guide/VOD.md#advanced-video-audio-and-subtitles): account-gated MCTF/perceptual controls, strict fields/ranges; ordinary H265 rejects them. Unset/OFF/zero remain distinct.
Per-Title numeric template bitrate returns `PLAN_PER_TITLE_BITRATE`; use null and `perTitleSettings` bounds.
For presets or `packages/core/src/plan/__fixtures__/*.plan.json`, replace
`<INSERT …>` / `{YOUR …}` placeholders and `credentialId`s first.

```bash
# submit
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  --data "{\"plan\": $(cat plan.json)}" https://ovp.example.com/api/encoding-jobs
# → 201 { "id": "<jobId>", ..., "issues": [...] }   (`issues` carries
#   non-fatal warnings; 400 lists validation issues — the same
#                              validator the wizard runs, C1–C37 rails included)

# poll
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/encoding-jobs/<jobId>
# → { "status": "QUEUED|RUNNING|FINISHED|ERROR|CANCELED", "doneSteps": …, "stepLog": […] }
```

Terminal: `FINISHED`, `ERROR`, `CANCELED`. Poll ≥5s (UI default), not enforced.
STOP intent: Retry409; [re-run/rollout](user-guide/VOD.md#copy-retry-and-cancel).

## Workflow 2 — live channel lifecycle

Queued/provisioning `cancel-start`: [durable generation-bound contract](user-guide/LIVE.md#stop-and-broadcast-again).

`GET /api/live/orphan-inventory?bitmovinAccountId=<uuid>`: VIEWER/manual/read-only,
`no-store`; returns account ID, ISO `checkedAt`, counts: `running` (non-terminal),
`unexplained` (untracked), `contradicted` (terminal-channel mismatch), `inFlight`
(CREATED/PROVISIONING). Needs-review=unexplained+contradicted, not orphan/ownership
proof (may be other tools). No STOP/enqueue/polling. Account-scoped; ≤10×100 LIVE
records/1,000 channels. UUID400/account404; failed/malformed/unstable/incomplete
or over-limit502: **no counts**, not0.

DASH delay/update: plan/log ms → SDK request/audit seconds (once).
`plan.start.encodingOption`: GUI `AUTO` selects HD/Custom; omitted=Custom,
incompatible `HD` blocks. Worker/cURL use `/live/hd/start` or `/live/start`,
strip the selector, never retry another mode. Re-air creates a new encoding.

```bash
# CREATION PROVISIONS IMMEDIATELY and bills, even with a schedule.
# CREATED is the initial state, NOT a register-now/start-later mode.
# The {"plan": …} wrapper is required; a bare wizard plan returns 400.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  --data '{"plan": <LiveChannelPlan>}' https://ovp.example.com/api/live-channels
# → { "id": "<channelId>", "status": "CREATED" }

# Queued start/stop. Start accepts CREATED/ERROR/STOPPED → PROVISIONING;
# not needed after a normal create, but recovers an ERROR enqueue failure.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data '{"action":"start"}' https://ovp.example.com/api/live-channels/<id>/actions
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data '{"action":"stop"}'      https://ovp.example.com/api/live-channels/<id>/actions

# status (includes streamKey/encoderIp once RUNNING)
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/live-channels/<id>
```

Stop also stops attached feeders. `DELETE /api/live-channels/<id>` removes a stopped channel.

The status body's `playbackLinks[]` carries one entry per manifest with `url`
(or `null` plus a coded `reason`) and `via`. For an Akamai MSL output the URL
is derived from the `AKAMAI_MSL` credential's optional `config.edgeBaseUrl`
(`POST/PATCH /api/credentials`, ADMIN: an https event root with no query,
userinfo or trailing slash, on a public host, ≤ 512 chars) plus
`/<manifestName>`, reported as `via: "credential-edge"`; without it the reason
is `MSL_EDGE_URL_NOT_CONFIGURED` with the `credentialId` to configure. The
link is the viewer's edge, not proof that the encoder is publishing.

```bash
# slate content on a RUNNING channel (C36). READY means REGISTERED, not
# playable: a clip whose frame rate / audio sample rate differ from the live
# ingest registers READY and the insertion fails at air time. So the clip is PREFLIGHTED against the ingest first, from the
# storage inspection the worker runs on it.
#
# 1. preflight — 202 {status:"PENDING", inspectionId} while the inspection runs
#    (poll the same call); 200 {status:"DONE", verdict, differences, probe, ...}
#    once it lands. verdict ∈ OK | INCOMPATIBLE | UNVERIFIED; UNVERIFIED carries
#    `standDown` (NO_INGEST_REFERENCE, NO_PROBE, NO_CREDENTIAL, INPUT_UNRESOLVED,
#    INSPECTION_FAILED) and a `note`. Nothing is created at Bitmovin.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data '{"bitmovinAccountId":"<accountId>","source":{"credentialId":"<credId>","bucket":"in","key":"slates/brb.mp4"}}' \
  https://ovp.example.com/api/live-channels/<id>/insertable-content/preflight
# 2. register — `content.source` (the server mints the Bitmovin input from the
#    vaulted credential) OR the raw `content.inputs:[{inputId,inputPath}]`,
#    exactly one of the two. A leading "/" on the path is stripped and echoed
#    back in `preflight.inputPath`. 409 details.code SLATE_UNINSPECTED while the
#    inspection runs. A DONE preflight carries `preparation`: a still or
#    an ingest-matching MPEG-TS registers inline (201 + `preflight`: verdict,
#    standDown, `summary`, stamped on the content's `description` unless you
#    supplied one); anything else answers 202 {normalization, preflight} — the
#    worker converts the file to an ingest-matching MPEG-TS in the channel's
#    S3 output (`preflight.conversionDestination`, else next to the source)
#    and registers that; poll
#    GET …/insertable-content/normalizations (status; `insertableContentId`
#    once READY; caller `description` dropped). An unreadable or unprobed
#    file, or a raw `inputs` mismatch (an MKV blocks), is 422
#    SLATE_INCOMPATIBLE.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data '{"bitmovinAccountId":"<accountId>","content":{"name":"brb","source":{"credentialId":"<credId>","bucket":"in","key":"slates/brb.mp4"}}}' \
  https://ovp.example.com/api/live-channels/<id>/insertable-content
```

## Workflow 3 — VMAF results and exports

```bash
# list VMAF jobs (filter by encoding job)
curl -H "Authorization: Bearer $TOKEN" \
  "https://ovp.example.com/api/vmaf-jobs?encodingJobId=<jobId>"

# per-job results + pooled metrics
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/vmaf-jobs/<vmafJobId>

# export (CSV/JSON)
curl -H "Authorization: Bearer $TOKEN" \
  "https://ovp.example.com/api/vmaf-jobs/<vmafJobId>/export?format=csv" -o vmaf.csv
```

Exports include all stored frames; `result=<resultId>` selects one rendition.
JSON retains its two-space formatting. CSV keeps the `rendition,frameNum,vmaf,psnr`
header and leaves PSNR empty when it was not measured. Downloads are streamed:
check that the client completed successfully and discard partial files on error.
The detail endpoint returns at most 1,500 chart points per result, with bucket
minima and the first worst frame preserved; `frameCount` reports the full count.

`qc.vmaf` enables automatic measurement. List rows expose `localRetryAvailable`. OPERATOR `POST /api/vmaf-jobs/<id>/retry` (no body) retries eligible ERROR/local/VOD reports:201 `{id,encodingJobId,status}`; active/ineligible409. Existing outputs and scoring settings are reused; encoding is not restarted.

Detail results add optional `preview: {url} | {unavailableReason}` for fixed QC
videos. `GET /api/vmaf-jobs/<id>/preview?resultId=<uuid>` is authenticated,
feature-gated and version-pinned; no arbitrary URL/key input. Single byte ranges
are capped at4MiB (206); invalid ranges return416, unavailable/changed media fails
closed. Missing provenance/FPS and unretained Live captures have no preview.

## Workflow 4 — presets as job templates

```bash
# sample presets (name + opCount; plan bodies fetched per preset)
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/sample-presets/<name>
# → an EncodingPlan with placeholder tokens — substitute and submit via Workflow 1

# your saved presets
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/presets
curl -H "Authorization: Bearer $TOKEN" https://ovp.example.com/api/presets/<id>   # body included
```

## App name and icon

`GET /api/settings/branding` (VIEWER): `{displayName,iconDataUrl}`, default Bitmovin OVP/null for absent/invalid rows; DB failure500. `PATCH` (ADMIN) merges supplied fields, rejects unknown keys; send defaults to reset. Name: trimmed1–64 Unicode characters, no controls/bidi overrides. Icon: null or canonical static PNG/JPEG/WebP data URL, ≤256KiB, ≤1024px/axis; no URL/SVG. Body≤352000 bytes (413); invalid400. Tenant-scoped/no-store; view-as GET only. Audit: name/icon presence/byte count, no image data.

## Stability promise, spelled out

Additive-only on: `POST/GET /api/encoding-jobs[/id]`,
`POST/GET/DELETE /api/live-channels[/id]` + `/actions`,
`GET /api/vmaf-jobs[/id]` + `/export`, `GET /api/presets[/id]`,
`GET /api/sample-presets/<name>`, `POST/GET /api/api-tokens` +
`DELETE /api/api-tokens/<id>`. Fields may be added; existing fields keep
their meaning; removals or renames are breaking changes.

### VMAF compute selection

`qc.execution` and manual `POST /api/vmaf-jobs` use the same execution object:

- `{"backend":"LOCAL","localMode":"CPU"}` forces CPU decoding and scoring.
- `{"backend":"LOCAL","localMode":"AUTO"}` selects an eligible local GPU,
  otherwise the same-model CPU path. Reports include the actual method and
  selection reason. Delivery gates retain CPU scoring.
- `{"backend":"LOCAL"}` retains the historical worker-environment policy.
- `{"backend":"CLOUD","profileId":"<id>","budgetUsd":5}` selects a configured
  cloud profile; `localMode` is not accepted for cloud execution.

No binary path or GPU index is accepted from these requests. Remeasure retains
the requested local mode and selects a new backend snapshot for the new report.
See [local GPU setup and limits](user-guide/GPU-QUALITY.md#choose-local-processing).

Create/re-run/watch
validation: invalid400, unavailable503. `qc.measurementMethod:"FRAME_INDEX_BT709_10BIT"`:
Cloud generation6. [Eligibility and cancellation](user-guide/QUALITY-AND-MONITORING.md#local-and-cloud-execution).
ADMIN `/api/settings/vmaf-profiles`, `/api/settings/vmaf-credentials`: [CRUD](user-guide/QUALITY-AND-MONITORING.md#local-and-cloud-execution).

- Live RTMP update: OPERATOR `POST /api/live-channels/[id]/actions`; [run-bound request](user-guide/LIVE.md#send-input-and-confirm-delivery).
- Live diagnostics: `GET /api/live-channels/[id]/runs/[runId]/diagnostics` (OPERATOR), including `kind=hd-start`; `GET /api/live-channels/[id]/runs/[runId]/final-heartbeat` (ADMIN). [Parameters and persistence](user-guide/LIVE.md#heartbeat-and-status-history).

Plans accept [CMAF muxings](user-guide/VOD.md#advanced-video-audio-and-subtitles).
