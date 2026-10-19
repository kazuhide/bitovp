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
- **Pagination is the EXCEPTION.** Exactly nine collection routes
  paginate — `access-events`, `audit-logs`, `encoding-jobs`, `feeder-sessions` (name-only `liveChannel: {name}`), `live-channels`,
  `live-channels/[id]/runs/[runId]/heartbeats` (the per-run heartbeat log, ≤ 500
  rows a page, `from`/`to`/`cursor`), `live-channels/[id]/runs/[runId]/heartbeat-receipts` (Push, default100/max200), `vmaf-jobs`, `webhook-events` (heartbeat pushes are left out unless `includeHeartbeats=1`) — and they are the ones that
  return an envelope with `nextCursor`. Other collections return a bare array
  (`presets`, `api-tokens`, `watch-rules`, `alert-rules`,
  `storage-presets`, `live-channels/<id>/schedules`) or an ad-hoc object
  (`users` → `{users}`, `live-channels/<id>/runs` → `{runs}`,
  `live-channels/<id>/alerts` → `{open, history}`). These are examples, not
  exhaustive sets. Non-paginated collections have neither `items` nor `nextCursor`,
  and some are unbounded. **Read each route before looping**: neither pagination
  nor arrays are universal.
- **On the nine that do paginate, a missing `nextCursor` is the ONLY end-of-list
  signal; a short page does NOT mean the end** (C6). Loop until it is absent.
- **400 is a SHAPE failure; 422 is a SEMANTIC one.** This is the intended
  distinction for new routes: malformed bodies carry zod issues; valid but
  impossible requests carry a reason and sometimes `issues`.
  Older routes differ. Live create returns400 for plan validation and unknown
  account/template; startup-probes returns422 for the same unknown-account message.
  Read the actual status; unchanged invalid bodies are not transient retries.
  Nineteen route files return 422 today (include wrapped `jsonError` calls).
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
  and `/api/live-channels/[id]/runs/[runId]/heartbeats/export`.
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

- `/api/settings/api-coverage` — GET (VIEWER): bundled current source census,
  installed/surveyed SDK and mismatch flag, plus a separately dated historical
  parameter snapshot. No provider/DB calls. Source-confirmed is not runtime proof.

- `/api/admin/reset` (organization ADMIN session, no tokens): GET `?categories=<comma list>` previews selected counts. POST `{confirm:"RESET",categories:[...]}` force-deletes selected organization data and returns `deletedCounts`. Empty/duplicate/unknown/incomplete dependencies fail validation. Global users, memberships, organizations and setup identity are excluded; reset does not reopen setup. Active work and unresolved cleanup do not block selected deletion; organization-owned encrypted receipts retain cleanup ownership.
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

- The first accepted request returns `201`. A repeated request with the same key
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
If queue delivery failed, inspect the existing job or channel and use its normal
retry or start action. Receiving the same ID confirms creation, not successful
encoding or delivery. Keep the key and exact submitted body in your automation's
private records; do not post credentials or plans containing secrets publicly.

## Workflow 1 — VOD submission

AISA `automaticAdPlacement.schedule`: nonempty `{position,maxDeviation,duration?}` rows in seconds, finite ≥0. Zero is preserved; see [contract](user-guide/VOD.md#quality-checks-and-scene-analysis).

`GET /api/library/sources/<id>/media?key=<output-key>`: VIEWER MP4, exact object; private/no-store, Range≤4MiB. Large un-ranged416, canceled408, missing404 (`MEDIA_FILE_NOT_FOUND`), changed409, storage502; upstream401/403→`MEDIA_STORAGE_ACCESS_DENIED` (Library/VMAF). No locators/secrets.
Library: VIEWER read/OPERATOR write; FINISHED auto-capture. `GET/POST /api/encoding-jobs/<id>/analysis`: `{enabled,captureSuppressed,source}` / idempotent `202 {sourceId}`. `GET /api/library/sources/<id>`: snapshot/analyses, no locators; detail `providerAnalysis?:{data,source:PROVIDER|NORMALIZED}`: ≤8MiB JSON, read-time redaction, labeled normalized fallback; search unchanged. `POST /retry`: ERROR→202, else409; no reanalysis. Non-AISA:`und`.

Library search/options: [HTTP contract](user-guide/LIBRARY-AND-ADMIN.md#content-library-and-storage).
Label paging/exact/cache: [contract](user-guide/QUALITY-AND-MONITORING.md).

Library: [catalogue/scene endpoints, query limits and DTOs](user-guide/LIBRARY-AND-ADMIN.md#content-library-and-storage). Reads VIEWER, writes OPERATOR.

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

`qc.execution`: Local default or Cloud profile ID + USD budget. Create/re-run/watch
validation: invalid400, unavailable503. `qc.measurementMethod:"FRAME_INDEX_BT709_10BIT"`:
Cloud generation6. [Eligibility and cancellation](user-guide/QUALITY-AND-MONITORING.md#local-and-cloud-execution).
ADMIN `/api/settings/vmaf-profiles`, `/api/settings/vmaf-credentials`: [CRUD](user-guide/QUALITY-AND-MONITORING.md#local-and-cloud-execution).

- Live RTMP update: OPERATOR `POST /api/live-channels/[id]/actions`; [run-bound request](user-guide/LIVE.md#send-input-and-confirm-delivery).
- Live diagnostics: `GET /api/live-channels/[id]/runs/[runId]/diagnostics` (OPERATOR), including `kind=hd-start`; `GET /api/live-channels/[id]/runs/[runId]/final-heartbeat` (ADMIN). [Parameters and persistence](user-guide/LIVE.md#heartbeat-and-status-history).

Plans accept [CMAF muxings](user-guide/VOD.md#advanced-video-audio-and-subtitles).
