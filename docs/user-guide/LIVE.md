# Live: configure, broadcast, and monitor

[Back to the user guide](../USER-GUIDE.md)

Creating a Live channel immediately starts provisioning and can incur charges.
It is not a draft-only reservation. An `OPERATOR` or `ADMIN` can create and
operate channels; administrators configure shared credentials and Live defaults.

## Configure a channel

Open `/live/new` and configure the existing wizard from top to bottom:

New configurations start with region `AUTO`, which lets Bitmovin select a
region. Review the selected account and any saved or copied region settings.

1. In **Basics**, name the channel and choose its Bitmovin account, region, and encoder version.
2. In **Sources**, choose **RTMP**, **redundant RTMP**, **SRT**, **Zixi**, or **HLS pull** input.
   Pseudo-live is a feeder that sends stored files to an input, not a separate
   encoder input type.
3. In **Ladder**, configure video/audio renditions and their codec settings.
4. In **Output**, choose storage or a delivery service, paths, and optional mirrors.
5. In **Packaging**, choose each track's container, bundled audio, file settings,
   shared segment length, optional encryption, and MP4 archive.
6. In **Encoding**, review automatic restart/stop controls and optional features.
7. In **Manifests**, configure HLS/DASH, DVR, and publication settings.
8. In **Schedule**, configure planned actions. A schedule does not postpone provisioning.
9. In **Review**, read the plan preview and any Custom Live warnings, then create the channel.

New channels normally target Live HD where eligible. Settings outside that shape
are identified as Custom Live before start. Account eligibility and provider
acceptance still apply.

Each rendition's **Ladder → Advanced** section lets you select its input track position
(zero-based; blank keeps video `0` or audio `1`) and protocol input path.
In **Packaging**, each track's **Advanced** section exposes the media output
subdirectory for storage outputs, a segment
filename pattern or naming template, and the fMP4 init filename. A custom
subdirectory replaces the complete generated media folder rather than extending
the Output folder. Blank keeps automatic paths; `/` selects the output root.
Use separate folders or nonoverlapping filenames for independent containers.
Audio needs its own container for separate media files.

Outputs pointing to the same physical bucket share its files, even when their
saved names differ. Mirrors receive the same relative paths. The app checks
these locations together to prevent files from overwriting one another.

`%number%` expands in segment naming patterns. Init and archive filenames keep
that text literally; random naming uses the dedicated template fields.

Turning off **Restart on encoder error** sends an explicit disabled setting.
An untouched control leaves an omitted setting unspecified. Import and duplicate
also preserve explicitly private output permissions (`PRIVATE`).

The HLS live-edge offset delays segment publication; it is not the player's
starting position. Blank uses the provider default, which can add latency.
DASH suggested presentation delay and minimum update period use milliseconds in
the form and are converted to API seconds. DVR retains a playback window; its
manifest-element budget is checked rather than silently clamped.

## Experimental MoQ delivery

Create a **MoQ relay (live delivery)** credential first. In the Live wizard,
select it under **Output** and set the MoQT draft and track namespace.
**Copy settings and edit** opens the saved settings in the wizard when the
form can reproduce the plan. Other valid plans remain editable as JSON.

The credential's encrypted secret holds a
`moqt://host[:port][/path]` relay URL and an optional authorization token/type;
userinfo, query strings, and fragments are rejected. Keep the token out of the
plan. When a token is present, its optional type accepts integers from 0 to
2,147,483,647. To correct an older credential with a larger value, edit the
credential, select **Replace secret material**, and re-enter the publishing URL,
token and assigned token type. Re-enter the subscribe-only **Playback URL** if
the credential is also used for preview. Saving replaces all the secret fields.

Use one `MOQ` output referencing that credential, `trackNamespace` as a tuple of
1–32 nonempty strings, and `draftVersion` as `DRAFT_16` or `DRAFT_18`. Each H264
video or AAC audio rendition needs one FMP4 or CMAF muxing directed to that
output. A CMAF muxing can specify `framesPerCmafChunk`.
The relay publishes a catalog. Set `liveManifests` to an empty array when
authoring expert JSON. Keep storage outputs and mirrors, DRM, SCTE-35, and ad
insertion off in the MoQ plan.

This uses Custom Live and requires Bitmovin's account-level MoQ Beta access.
Relay interoperability and Player Web X playback need independent verification;
the MoQ preview uses a separate Player Web X build. Requested and actual Encoder
versions can be compared in the run's `kind=summary` diagnostics when the
provider returns them. A selected version is never inferred from `BETA` or
`STABLE`.

For MoQ preview, set the credential's optional **Playback URL** to a separate
HTTPS subscribe-only URL before starting the channel. Configure an own Bitmovin
Player license in Player settings. The preview uses that key independently of
the ordinary HLS/DASH engine choice. The current MoQ Player build is separate
from the public npm SDK: an operator supplies a licensed local bundle with
`BITOVP_MOQ_PLAYER_BUNDLE_PATH` and its digest in
`BITOVP_MOQ_PLAYER_BUNDLE_SHA256`. The asset route verifies the file before serving
it; the repository does not include this proprietary bundle.

Before creating an imported MoQ plan or starting another run, check **MoQ preview**
readiness beside the start button. It checks the saved credential, namespace,
organization Player license and verified Web X bundle. Publishing-only plans
can proceed. Relay connectivity and playback are checked once the run starts.

Use **Play** to start MoQ playback and **Stop** to release the player. Playback
starts muted by default. Open **Playback settings** to adjust the target buffer in
milliseconds or the volume. Apply the buffer before or during playback. The
video quality selector appears when the player offers another video track.
The buffer target and volume carry over when restarting playback on the same
page. Frame progress indicates received video; a successful
start request alone does not. Preview supports one namespace component and
draft16/18. Missing configuration, a changed credential, or unavailable video
remains explicit. Publisher tokens are never used as browser playback tokens.

**Open player** opens the same preview at `/live/[id]/runs/[runId]/moq` for an
OPERATOR. Both views show configured namespace/draft/catalog, received quality
metadata, measured video FPS, resolution, frames, startup time and buffer level.
The 2-second target buffer is a setting. **Video latency (barcode)** is the
Player's timestamp-in-image estimate, requiring compatible live timestamp bars
and synchronized source/client clocks; it is not RTT or a guaranteed compositor
display measurement. Missing or stale values remain unmeasured. Configured
Cloudflare Relay ID/expiry/permissions come from unverified subscriber-token
claims, not server telemetry. Relay bytes/objects/RTT counters are not exposed
by the Player API used here.

Both pages retain observations after the run ends. A playback session saves
Player latency, FPS, buffer source and frame counters on a UTC timeline, with
missing measurements left as gaps. The received preview is recorded for up to
90 seconds/16MiB and saved as a seekable WebM. A slightly late browser stop can
be trimmed to the recording limit. Canvas capture records video only. Play or
download it from
**Saved MoQ observations** after stopping. Recording covers the preview's
received interval. The historical client clock estimates UTC from the saved
browser capture time and the current recording position, even if capture
began after the observation window. Recording status shows recording, saving, saved, unsupported or
failure. Each run keeps up to five observation sessions. Saved data remains
available when the live player is inactive. Playback can start while history
and Analytics are preparing. The playback stage timeline shows UTC timestamps
for subscriber requests, observed frames, gaps, recovery, and termination.
After ending, saved video and observations appear before the collapsed live
preview. Historical namespace/draft/catalog come from the original output proof.
Use `#moq-preview` on either page to open this section directly. Browser-native
bundle and recording requests carry the document's organization assertion;
switching organizations requires reloading the page.

Configure the tenant's Analytics key in Player settings to collect the same
barcode latency through Collector 2.62.0's public HTML5 adapter. **Bitmovin
Analytics** reads back `customData1` milliseconds for the saved impression and
run, alongside the browser measurements and persisted Encoder heartbeat
metrics. This is collection of the Player's measurement, rather than an
independent latency clock or the native Analytics `LATENCY` field. Use
**Refresh** after ending if ingestion is still pending. Input bitrate/FPS,
cumulative packet anomalies and segment processing time retain their own units;
segment processing time does not measure end-to-end video delay.

Set `BITOVP_MOQ_ARCHIVE_DIR` to persistent local storage. The Web image includes
FFprobe/FFmpeg for bounded validation and stream-copy remuxing; the Compose
deployments attach a dedicated persistent archive volume. Channel deletion or
reset removes only the corresponding owned recordings after the database
commit and required provider-stop checks succeed.

The same API accepts `kind=task` for fresh provider task status and metadata
from at most 100 messages. It reports truncation and positive message counts.
The SDK maps an absent list to an empty array, so missing or empty mapped lists
have `totalMessageCount: null` (unknown). Free-form text is withheld by default.
Administrators may request `kind=task&download=task` as a bounded private
attachment; its text is never saved in audits. Fixed
protocol mentions describe task messages, not negotiated ALPN or successful
Relay delivery.

## Encrypted outputs and fallback regions

In **Packaging → Encryption**, add CENC, FairPlay, or SPEKE to an fMP4 track,
or FairPlay to an MPEG-TS track. These methods do not target CMAF containers or
the progressive MP4 archive. Select an existing content-key or SPEKE-provider
credential; the content key is never part of a channel plan. **Copy encryption
settings to all compatible tracks** shares the public metadata and credential
reference while retaining each track's own folder.

DRM creation requests cannot be copied as cURL from the resource history because
the saved requests omit vault keys and key-server credentials. Configure and
run encryption through the application.

Select the matching encryption kind in each HLS or DASH manifest. Its media
references then use the encrypted destination; DASH also receives encryption
metadata. HLS CENC intended for FairPlay playback requires CBC and the FairPlay
IV and URI. Provisioning encrypted output does not configure a playback license
service; verify the license configuration and target player's DRM support.

Clear output is omitted for an encrypted track unless **Also write unencrypted
output** is selected. Clear and encrypted copies need different folders. Import
and duplicate preserve encryption settings and destinations. Browser drafts keep
vault references and public non-URL metadata; re-enter omitted license/FairPlay
URLs after restoring a draft.

The API client library (SDK) exposes `fallbackCloudRegions` on its shared
encoding model, but the Live Encoding API rejects nonempty fallback lists at
startup. Leave this setting unset for Live; VOD fallback regions remain
available. Imported plans and restored drafts retain saved regions. **Basics**
shows those values and **Clear fallback regions** so they can be removed before
creating the channel.

## Send input and confirm delivery

Open `/live/[id]`, then configure your contribution encoder with the displayed
endpoint, stream key, and protocol parameters. Treat stream keys as secrets.

Check these observations separately:

1. The provider encoding reaches `RUNNING`.
2. The delivery-status input card reports `CONNECTED`, with a fresh last-check
   time. Open input details for receive rates and events.
3. Output manifests and media segments continue to progress.
4. The preview plays the expected video/audio and rendition changes.

`RUNNING` does not establish input connection or viewer playback. Signed Push
heartbeat information is preferred when fresh; otherwise fresh provider polling
is used. Missing Push alone is not an input-loss diagnosis. Direct output
observations remain separate and can expose stalled output even when the input
report looks healthy. DASH-only output does not use the HLS output-observation lamp.

To preview `PRIVATE` S3 output in Live, you need a delivery URL the browser can
play. In the storage credential's **Public base URLs (optional)**, an administrator
maps each bucket to an existing delivery service's base URL (for example, a CDN),
one `bucket = base URL` entry per line, and configures delivery authentication and
CORS for browser access. Open **Show every manifest URL** to check each link or
the reason a URL is unavailable. HLS output monitoring uses saved storage
credentials, while the preview loads the delivery URL directly; verify output
updates and actual playback separately.

## Changing automatic stop during a broadcast

On a `RUNNING` channel, open **Diagnostics & history → Maximum run time → Encoder automatic stop**. Review the three recorded timer values, edit the required fields, then choose **Review settings** and **Apply to this broadcast**. A blank field disables that timer; disabling all three requires a separate confirmation. A queued update is not an accepted update. Check the acceptance message and the encoder's returned shutdown time.

The API replaces the complete configuration. The runtime timer starts again when the encoder accepts the update, while the input-loss timer still counts from the last received data. The first-input timer no longer matters once input connects. These settings apply to the current broadcast; they do not change the next broadcast's start settings or remove bitovp's separate maximum run time. Values shown are the last settings recorded by bitovp and may differ from changes made elsewhere.

The organization's maximum live runtime still applies, and the encoder can reject changes within ten seconds of an armed shutdown. If a response is lost, bitovp does not resend the update automatically: another send could move the shutdown again. Reload the status and resolve an uncertain result before trying again. If no delivery record is found, **Review and retry** lets you check the proposed settings and retry the same update. **Stop** remains available. See the [Bitmovin API reference](https://developer.bitmovin.com/encoding/reference/livepostencodingencodingsliveupdateautoshutdownconfigbyencodingid).

## Heartbeat and status history

Per-encoding heartbeat registration is automatic on supported encoder versions.
The application signs registrations, associates receipts with the exact run,
and removes owned hooks after the run ends. Older encoders continue polling.

Administrators can set the heartbeat interval in `/settings/live`. The default
is 20 seconds; zero disables registration. Environment values provide deployment
defaults. The interval is frozen for each new run.

Channel details show reception freshness, recent samples, status history, and
input diagnostics. Open the detailed history to distinguish receipt time from
provider sample time; delayed or duplicate delivery is not a new input sample.
Polling history is kept for seven days while a channel is polled; ended runs
retain a summary. See [Operations](../OPERATIONS.md#heartbeat-history).

If provider monitoring stops responding, a configured `HEARTBEAT_STALE` rule
opens once after its freshness grace and resolves when fresh polling recovers.
This indicates missing monitoring data; it does not confirm an input disconnect
or a stopped encoder. Other channels continue to be monitored.

## Pseudo-live, schedules, and slate insertion

Use `/live/feeders` to send stored media at real-time speed to a channel's RTMP
or SRT input. `PUSHING` describes the local sender; verify `CONNECTED` and output
at the destination too. Stop both feeder and channel when finished.

Channel schedules support start, stop, and slate insertion. A fired schedule
means the action was dispatched; check the resulting media separately.

Slates are insertable still images or video. Video must match the live ingest's
frame rate, resolution, audio sample rate/channels, and codec requirements.
The application checks compatibility and can normalize suitable source files to
matching MPEG-TS. MP4 registration alone does not prove correct insertion or
audio timing. A `READY` slate means registered, not proven playable. Review the
compatibility result and conversion destination before inserting it.

## Additional outputs and recording

An optional storage mirror receives the same segment/manifest paths as the main
output. It is not an independently configured ladder. Check storage permissions
and prevent duplicate destinations.

Choose a manifest destination that also receives its media segments, such as the
main delivery output or a storage mirror. Relative segment paths refer to files
on that same storage. An output used only for an MP4 archive has no segments for
the stream, so the editor excludes it from the destination choices. To deliver
the stream there, add a storage mirror that writes the segments there too.
An output alias pointing to storage that already receives the media remains usable.

The optional MP4 archive combines an existing H.264 video stream with AAC audio
in storage; it is separate from segmented delivery and Live-to-VOD manifests.
After stopping, wait for provider completion, then inspect the file for that
specific run and play it. The ordinary bounded inspection does not establish
whole-file playback or audio/video synchronization.

Live-to-VOD manifest generation depends on the recording container: TS supports
HLS; fMP4 supports HLS/DASH. A progressive MP4 archive is not added to those manifests.

## Akamai delivery

For MSL output, configure the stream ID, event name, version, and stream format
in the relevant credential and output controls. MSL5 requires a compatible
numeric encoder version (at least 2.283.0); HTTP Digest or unauthenticated
publishing is supported, not Header-only authentication.

Set the credential's public edge base URL to build viewer playback links.
The encoder does not supply that hostname. A configured link is not delivery
proof: verify master/child manifests, all expected media renditions, progression,
and real playback. Validate MSL5 independently of MSL4. Use a distinct path for
each broadcast and confirm that no previous publisher is active.

## Stop and broadcast again

Stop the feeder, stop the channel, and confirm provider termination and output
progression ending. Deleting a local row does not by itself establish cloud cleanup.

During the original stop request, a transport failure can cause up to three
send attempts. After an uncertain response or rate limit, the periodic check
reads encoder status for every previously attempted STOP. If the worker died before sending to an encoder, a positive send journal and an active provider readback allow the replacement to finish that original request. Each worker starts a pass about once a minute and
examines up to four stop records per organization per pass, rotating through longer lists.

For ordinary Live, automatic confirmation requires terminal provider evidence
for the broadcast's encoder and an end to all feeder activity on the channel.
Several pending stops for the same encoder can be confirmed together when
their recorded targets and broadcast history agree. If the worker exited
during shutdown, its replacement can read the encoder after the old worker's
claim expires. If the stopped broadcast already has a terminal provider
receipt, the replacement can finish recording the outcome from that receipt.
An older broadcast without a stored encoder ID needs its own encoder-creation
receipt. A change to the account's RTMP input can replace the encoder within
one broadcast. The worker retains the current encoder until its account reports termination or reports CREATED while its startup record proves START was never attempted. A running encoder with a completed start stays on its original input. If startup is uncertain, use Stop on the retained encoder before rebuilding. Older recorded encoders with a missing primary ID can also be stopped from the channel actions. If a rebuild predates this recording and the original ID is
missing, automatic confirmation stays pending. Check the account's active
encodings with the operator before re-air.

After an upgrade, a broadcast can show STOPPED or ERROR while a replaced RTMP encoder still needs confirmation. Start and scheduled Start check earlier broadcasts on this channel as well as the current one. Use **Stop** to recover an encoder on the current broadcast. If an older broadcast is missing retirement evidence, a signed-in administrator can request a provider check with `POST /api/admin/reset/reconcile`. Retry Start after the affected encoder appears in the `confirmed` results. A scheduled start waits within its grace window.

If an encoder still reports `RUNNING` or `QUEUED`, check its ID in the
provider dashboard. Pressing **Stop** again cannot force another send for the
same ambiguous manual stop. The periodic check also reads any additional encoders recorded for this broadcast.
It can reuse a terminal receipt recorded on the same provider account. On an older broadcast with a confirmed stop, the worker can stop a still-active archived encoder when it can establish that the earlier stop excluded that encoder. A missing or inconsistent record keeps the broadcast unconfirmed. For managed AISA, the Analysis and Encoding each have their own stop record. After a feeder
stop could not be queued, check that the feeder has actually exited. For AISA,
retry finalization from the console to refresh the Analysis status and final
result for that broadcast.

A scheduled Start records the selected broadcast and its admission generation before dispatch. Retries use that same broadcast. A later manual Start or a revival has its own generation and leaves the earlier schedule's delivery result intact. If a pre-upgrade Start cannot be tied to its original broadcast, its schedule shows an unknown outcome. Check the channel before scheduling another start.

If an upgraded worker cannot identify the broadcast for a pending legacy Stop, it saves the missed-stop alert with the schedule outcome. A restarted worker can deliver that alert to the configured destinations. If several old Stop schedules refer to the same broadcast, the worker preserves a queued Stop even when an older schedule has an unknown outcome. If every delivery is lost and the encoder or feeder is still active, check the broadcast and choose **Stop channel**.

If an upgrade finds a scheduled Stop that fired immediately before the old worker exited, it can finish admitting the Stop when the broadcast still owns its original encoder and no other admission has advanced its generation. Heartbeat polls do not affect that decision. If the old worker did not save a generation and another admission was possible, the schedule records an unknown outcome and raises a missed-schedule alert. Open the linked broadcast, confirm it is the one you intend to end, and choose Stop.

An upgraded worker can reconcile an exhausted scheduled Stop from an older version by checking the recorded broadcast and encoder. If a job expires from the queue, the worker checks each recorded encoder. It can requeue the Stop under a new queue job ID when its exact handoff survives and the worker had yet to claim it. If an older handoff lacks that evidence and a stop cannot be confirmed, the channel can show **ERROR**. Open the affected airing and choose **Stop channel** to retry.

If Bitmovin rejects creation of a stream, muxing or DRM resource with HTTP 401 or 403, correct the account credentials or permissions and retry Start for the same broadcast. For an explicit HTTP 429 on the create request, wait at least one minute before retrying. If DNS lookup for the original Bitmovin host failed before connecting, retry after name resolution recovers. If a request may already have reached Bitmovin, the worker looks for the resource under its original encoder or muxing before resuming. An empty lookup leaves that step unresolved.

Clearing schedules keeps startup and shutdown records that the Worker still needs. If a current scheduled Stop exhausts delivery before the Worker claims it, the channel shows **ERROR** and the schedule shows **Unknown**. Use **Stop** again on that broadcast. The Worker also checks the database for startup admissions whose queue entry has disappeared, including a newly created channel. It resumes the same broadcast and generation. After an upgrade, an ambiguous earlier schedule keeps an unknown result. An AISA broadcast whose original startup cannot be attributed requires an operator to check the channel. If an old scheduled Start has no provable airing, check the channel before scheduling another start. An expired queue entry alone cannot confirm whether startup succeeded.

A scheduled Stop keeps its admitted broadcast and encoder through queue retries. Its schedule-fired notification records queue handoff. A terminal status check confirms the broadcast ended. The schedule shows **Delivered** when the worker also has an acknowledgment for that schedule's own Stop request. Without that acknowledgment, observed termination leaves delivery **Unknown**.
For new stops, confirmation records one notification per broadcast. The worker
can finish delivery after the channel is deleted. A network or HTTP failure is
retried up to five attempts. A refused host or invalid destination configuration
ends delivery with a failure. If no rule matched, delivery history has no entry. A destination can receive the event again after a retry or worker restart.
For stops already in progress during upgrade, prior delivery can be unknown.
In that case recovery records the uncertainty and skips a replacement notification.

If a managed AISA channel stays in **Stopping** after the worker that accepted a manual stop exits, reopen the channel. **Stop channel** becomes available to its preview owner when the 20-minute dispatch lease expires and the current airing has a per-target stop record. Confirming it retries that airing. The worker checks the Analysis and encoder IDs and reads back any previously reserved send. If a legacy stop has no per-target record, check both resources in the provider account before attempting further action.

If managed AISA already has a final result and a terminal encoder, the worker can finish stop confirmation after the last feeder exits. A RESTART that loses its worker returns an error after its ownership period expires. Check the provider or use Stop on the same encoder.

A START error can leave the provider state uncertain. Startup cancellation
prevents further START retries once the worker observes it. If a request is
already in flight, the worker waits for its outcome, then checks and stops that
exact encoding before confirming termination. Provider or network failures can
leave that confirmation pending.

The worker reserves one Live processing slot for stop commands and startup
cancellation, so other channels waiting to start cannot occupy every slot.
`LIVE_CHANNEL_CONCURRENCY` sets the action slots per worker (default `8`, minimum
`2`). Ordinary Live actions use at most one fewer slot. Scheduled encoder
status and heartbeat reads have a dedicated slot and can use spare ordinary
slots when a previous read is still running. Blank uses the default.
Invalid values prevent the worker from starting. This reservation lets a stop
begin during a busy startup period; provider or network failures can still
prevent confirmed termination.

A terminal provider encoding cannot restart. Broadcasting the channel again
creates a new run and encoding; insertable content is registered for that run.
Copy settings opens the wizard without starting work. See
[Troubleshooting](./TROUBLESHOOTING.md) if state or cleanup remains uncertain.
