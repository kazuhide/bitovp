# Live: configure, broadcast, and monitor

[Back to the user guide](../USER-GUIDE.md)

Creating a Live channel immediately starts provisioning and can incur charges.
It is not a draft-only reservation. An `OPERATOR` or `ADMIN` can create and
operate channels; administrators configure shared credentials and Live defaults.

## Configure a channel

Open `/live/new` and configure the existing wizard from top to bottom:

New configurations start with region `AUTO`, which lets Bitmovin select a
region. Review the selected account and any saved or copied region settings.

1. Name the channel and choose its Bitmovin account, region, and encoder version.
2. Choose **RTMP**, **redundant RTMP**, **SRT**, **Zixi**, or **HLS pull** input.
   Pseudo-live is a feeder that sends stored files to an input, not a separate
   encoder input type.
3. Configure video/audio renditions and their codec settings.
4. Choose output storage or delivery service, paths, optional mirror, and archive.
5. Configure output groups, HLS/DASH manifests, and DVR.
6. Review automatic restart/stop controls and optional features.
7. Configure scheduled actions. A schedule does not postpone provisioning.
8. Read the plan preview and any Custom Live warnings, then create the channel.

New channels normally target Live HD where eligible. Settings outside that shape
are identified as Custom Live before start. Account eligibility and provider
acceptance still apply.

Turning off **Restart on encoder error** sends an explicit disabled setting.
An untouched control leaves an omitted setting unspecified. Import and duplicate
also preserve explicitly private output permissions (`PRIVATE`); preview playback
still needs authorized access to those files.

The HLS live-edge offset delays segment publication; it is not the player's
starting position. Blank uses the provider default, which can add latency.
DASH suggested presentation delay and minimum update period use milliseconds in
the form and are converted to API seconds. DVR retains a playback window; its
manifest-element budget is checked rather than silently clamped.

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

A START error can leave the provider state uncertain. Startup cancellation
prevents further START retries once the worker observes it. If a request is
already in flight, the worker waits for its outcome, then checks and stops that
exact encoding before confirming termination. Provider or network failures can
leave that confirmation pending.

The worker reserves one Live processing slot for stop commands and startup
cancellation, so other channels waiting to start cannot occupy every slot.
`LIVE_CHANNEL_CONCURRENCY` sets the total per worker (default `8`, minimum `2`);
ordinary Live actions use at most one fewer slot. Blank uses the default.
Invalid values prevent the worker from starting. This reservation lets a stop
begin during a busy startup period; provider or network failures can still
prevent confirmed termination.

A terminal provider encoding cannot restart. Broadcasting the channel again
creates a new run and encoding; insertable content is registered for that run.
Copy settings opens the wizard without starting work. See
[Troubleshooting](./TROUBLESHOOTING.md) if state or cleanup remains uncertain.
