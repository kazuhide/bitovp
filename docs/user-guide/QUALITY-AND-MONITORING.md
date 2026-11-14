# Quality and monitoring

[Back to the user guide](../USER-GUIDE.md)

## Usage dashboard

The dashboard shows statistics for the selected Bitmovin account, including
encodings created outside this application. VOD and Live usage remain separate.
Select a UTC date range and inspect missing-data indicators before interpreting
totals. Live HD Units and encoded billing minutes are different measurements;
the application does not convert one into the other.

Operators can import historical statistics and retry failed imports. Automatic
refresh updates recent dates; previously reported values can change. A missing
day is not zero. Label filtering combines VOD/Live for one label and does not
provide Live Units or a sum across overlapping labels.

For failures, use the job/channel lists and system queue status rather than
assuming the usage dashboard is an incident monitor.

## Measure quality

For opt-in local GPU work, see [experimental GPU quality measurement](./GPU-QUALITY.md).
For reference-free VOD banding scores, intervals and warning/failure bounds, see
[banding quality measurement](./BANDING-QUALITY.md).

VMAF (Video Multi-Method Assessment Fusion) compares decoded output frames with
a reference video. This application calculates it with ffmpeg/libvmaf; it is
not a Bitmovin Encoding API metric.

An administrator must first enable quality measurement in **Settings → Features**
and reload the application. The feature is disabled by default.

- Enable VMAF in the VOD wizard to measure after encoding.
- Use `/qc` to measure an existing completed job.
- On an eligible VOD job, use remeasure to create a report without changing the
  original automatic quality-gate decision.
- Open `/qc/[id]` for rendition results and `/qc/compare` for compatible reports.

Check reference/output identity, model, measurement generation, frame sampling,
expected rendition count, and errors. Mean alone can hide poor frames; inspect
percentiles, worst frames, and the frame graph too. A partial result is not a
complete ladder measurement.

Full-frame BT709 measurements honor the reference's reported sample aspect
ratio, so anamorphic inputs use a square-pixel display canvas. Missing or
unknown SAR retains the recorded legacy square-pixel assumption; it does not
prove display geometry.
Comparison warns when recorded reference display sizes differ. Confirm the
same measurement size before comparing a historical anamorphic report with a
new one, especially when older size metadata is unavailable.

Cloud requests that specify reference display geometry, including anamorphic
measurements, require an updated worker image. Rebuild the cloud-worker image
and pin its new digest in the compute profile and, for AWS Batch, its job
definition. Updating the application does not update an existing pinned image.
Automatic square-pixel measurements keep the legacy request format.

CSV and JSON downloads include every stored frame, including PSNR when measured.
The graph keeps up to 1,500 points and preserves each bucket's worst frame.
Large downloads arrive progressively; wait for the download to finish. If it is
interrupted, discard the partial file and retry the export.

The comparison preview fixes up to two renditions and seeks both to the selected
measurement time. Browser seeking can show an adjacent frame; use decoded frame
inspection when exact frame identity is required. Missing graph samples are not
interpolated into measured scores.

## Why alignment matters

Video and audio have separate frame grids. For example, AAC commonly contains
1,024 audio samples per frame: at 48 kHz that is about 21.33 ms. A two-second
segment therefore need not contain an integer number of audio frames. Encoder
delay, padding, timestamps, and container boundaries can add further differences.
Equal-looking segment durations do not establish audio/video synchronization.

In the provider-encoded sample recorded on 20 October 2026, the joint MP4 had
10.000 seconds of video and 10.005 seconds of AAC audio. The concatenated
AAC track in the separate fMP4 output contained 471 frames over 10.042667 seconds. Consider AAC frame
boundaries, encoder delay and padding when interpreting these durations;
the differences alone do not establish desynchronization.

HLS WebVTT keeps a boundary-crossing cue's full interval in both segments:
a 1.75–2.25-second cue belongs in the 0–2-second and 2–4-second segments.
A segment with no cues is valid. These rules follow
[RFC 8216 §3.5](https://datatracker.ietf.org/doc/html/rfc8216#section-3.5).
Do not delete repeated cues or rewrite outputs to force the files to match.

VMAF compares video frames, so an offset, frame-rate conversion, loop boundary,
or wrong source can dominate the score even when the codec output looks sound.
The application preserves alignment confidence, offsets, drift warnings, and
unmeasured results. Low-confidence diagnostic scores are not presented as
verified alignment. Read these warnings before comparing scores or applying gates.

Live measurements need a known pseudo-live reference and matching output capture.
The application cannot derive the original reference from an arbitrary live feed.
Readable output storage or an unambiguous declared mirror is required. MP4
archives are not substituted for live segment capture. Unsupported naming or
unavailable segments remain unverified.

### Frame rates and frames that are left out

Before libvmaf compares them, FFmpeg gives the reference and the encode one
frame for every frame interval of the reference's frame rate (its `fps`
filter). It repeats a frame where a file leaves one out, and it repeats or
drops frames of an encode that has another frame rate. The frames of the two
files are then compared in their order, so frame N of the reference and frame
N of the encode are the same moment. This is the standard method of **Local
CPU** and of a pair that **Local (GPU if available)** scores on the CPU. A
cloud measurement uses the command once its worker image is rebuilt from this
version, and it still ends with an error for a reference that leaves frames
out, as before: the cloud worker expects as many scored frames as the
reference holds. A Live measurement scores as before, because its reference
is written with a frame in every interval before it is scored: references
that were written that way passed the filter without a changed frame at
eight frame rates. No whole Live measurement was run with the change. The
“Frame index · BT.709 · 10-bit” method pairs frames by their index instead
and is unchanged.

Until 2026-11-14 only the encode's frames were treated so, and the frames of a
reference that leaves frames out, one with a variable frame rate, were
compared with other moments of the encode:

| Reference of 24 frames a second with every sixth frame left out | Before | Now |
| --- | --- | --- |
| A 320 × 180 encode that leaves out the same frames | 19.31 | 44.01 |
| A 640 × 360 encode that leaves out the same frames | 21.26 | 52.96 |
| A 320 × 180 encode that has every frame | 18.26 | 28.53 |

These are the scores of an arm64 worker. An x86-64 worker gave 19.32 and 44.02
for the first pair and 18.35 and 28.62 for the third
([the score of one pair on arm64 and on x86-64](../FFMPEG-BUILD.md#the-score-of-one-pair-on-arm64-and-on-x86-64)).

A measurement of a reference with a constant frame rate gives the score that
it gave before: 530 comparisons of such files, of 12 to 60 frames a second in
MP4, fragmented MP4, QuickTime, Matroska, WebM and MPEG-TS, scored the same
before and after. The measurement generation is therefore still 3, and a
report from before the change is not marked as outdated. Measure again where
the reference of an earlier report has a variable frame rate. The measured
references leave frames out of an even grid; a reference whose frames come at
irregular times, as a screen recording has them, was not measured. The end of
this section shows how to see such a file.

One kind of file with a constant frame rate is not compared frame for frame.
Matroska and WebM keep times in milliseconds. When the video of such a file
starts later than the file does, for example because its audio starts first,
and the delay is about half a frame interval, or that plus a whole number of
intervals (one and a half, two and a half), FFmpeg sends some frames to the
interval before and some to the one after, so it drops some frames and
repeats others. A copy of the file in another container keeps those times.
With a reference of 24 frames a second:

| Pair | Score |
| --- | --- |
| Neither file's video starts late | 90.51 |
| The reference's video starts 21 milliseconds late | 67.84 |
| The encode's video starts 21 milliseconds late | 69.01 |
| Both start 21 milliseconds late | 89.30 |

An encode of this kind has always scored so; a reference does since the
change, and scored 90.51 before it. The delay has to be within about half a
millisecond of half an interval, one and a half, two and a half and so on. At
24000/1001 frames a second, where an interval is 41.71 milliseconds and those
points are 20.85, 62.56 and 104.27 milliseconds, delays of 21, 63 and 104
milliseconds lowered the score, and delays of 10, 20, 22 and 62 did not. At
30000/1001 frames a second, a delay of 50 milliseconds, one and a half
intervals, lowered a reference's score from 89.10 to 62.55. At 25 frames a
second, where an interval is a whole number of milliseconds, a delay of half
an interval did not lower it.

To see whether a file is of this kind, compare the start of its video stream
with the start of the file:

```sh
ffprobe -v error -show_entries stream=codec_type,start_time:format=start_time reference.mkv
```

The delay is the video's `start_time` minus the file's. A file that FFmpeg
9.0.2 wrote with AAC audio in Matroska or MP4, or with Opus audio in WebM, was
not of this kind: its video and the file both started at zero.

A copy that holds the video stream alone scored 90.51 in each of the three
cases of the table:

```sh
ffmpeg -i reference.mkv -map 0:v -c copy reference-video.mkv
```

GPU scoring reads each file's times from its first frame and gave 90.51 for
all four pairs. The
[build record](../FFMPEG-BUILD.md#the-references-frame-times) holds the
measurements.

To see what the standard method does with the frames of a reference, run its
`fps` filter alone. Read the file's frame rate (`r_frame_rate`; an MPEG-TS
file prints it twice) and put it into the filter:

```sh
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 reference.mkv
ffmpeg -v verbose -i reference.mkv -vf fps=24/1 -an -f null - 2>&1 | grep "frames duplicated" | tail -n 1
```

The line names the frames that went into the filter and out of it, and those
that it dropped and repeated (duplicated). With the worker's FFmpeg, on 588
test files, it dropped and repeated nothing in each file with a frame in every
interval whose video starts with the file. It repeated one frame for each
frame left out, and dropped none, in each of the 41 files that leave frames
out, and it dropped or repeated frames in 30 of the 63 files whose video
starts later than the file. Where it repeats or drops frames of a reference,
a GPU score and a **Local CPU** score of a pair can differ:
[GPU scores and Local CPU scores](./GPU-QUALITY.md#gpu-scores-and-local-cpu-scores).

### Provider-encoded samples: October 27, 2026

Ten-second Big Buck Bunny inputs were encoded through Bitmovin with JavaScript API SDK 1.285.0 and 2-second segments. All initialization files and segments listed in each DASH manifest were downloaded from public S3 URLs, assembled without changing their bytes, and decoded to the end locally with FFmpeg. All 4 video tracks and 7 audio tracks completed decoding with `-xerror` enabled. FFmpeg 8.1.3 in the worker container also read each public DASH manifest directly and decoded 240 video frames and all audio streams to the end. The original job checks retain their HLS version warnings and one skipped VP9 bitrate check.

| Video codec | Decoded frames | Video duration (seconds) | Target bitrate (kbps) | Measured video bitrate (kbps) |
|---|---:|---:|---:|---:|
| H.264 | 240 | 10.000 | 800.0 | 813.1 |
| HEVC | 240 | 10.000 | 800.0 | 800.7 |
| VP9 | 240 | 9.999 | 800.0 | 799.6 |
| AV1 | 240 | 10.000 | 800.0 | 477.6 |

Target bitrate is the encoder setting. Measured video bitrate is the encoded video packet data divided by its presentation time, excluding container overhead; 1 kbps means 1,000 bits per second. In the local assembled-track check, the 7 audio tracks (AAC, AC3 and EAC3) each decoded to 479,232 samples at 48 kHz, or 9.984 seconds. See [audio boundaries in Chapter 11](./USER-GUIDE.en.md#frame-boundaries-and-alignment) for interpreting audio duration. These checks cover complete-track FFmpeg decoding. Browser/device compatibility and DRM license delivery require separate checks, as do audio/video synchronization, cutoff-frequency response and quality improvement.

### Measured provider samples: 20 October 2026

The following results use ten-second Big Buck Bunny inputs encoded through
Bitmovin with the JavaScript API SDK 1.284.0. They cover the stated outputs and
measurement conditions. The local checks below have separate conditions.

| Output sample | Measured result |
|---|---|
| H.264 and HEVC with AAC in fMP4 HLS/DASH; H.264/AAC joint MP4 | Each segmented video track contained 240 frames over 10 seconds, with five 2-second video segments. Every concatenated fMP4 track decoded completely. |
| VP9 / Opus, WebM DASH | Complete concatenated-track decoding passed; video contained 240 frames over 10 seconds. |
| English WebVTT in H.264 / AAC HLS | Five subtitle segments preserved all four source cues, including a cue crossing a segment boundary and an empty segment. Chrome displayed all four cues during complete playback. The HLS tracks and joint MP4 decoded completely. |
| Local quality measurement of the provider-encoded H.264 / AAC joint MP4 | All 240 consecutive frames had finite VMAF and PSNR scores. Model `vmaf_v0.6.1`; mean VMAF **98.018**, mean PSNR **50.763 dB**. |

Chrome played the HLS presentation with hls.js 1.6.16 and both DASH
presentations with Shaka Player 5.2.8. Each reached the end after decoding
240 video frames. These playback checks used unchanged downloaded files
served locally. For the H.264/HEVC sample, direct FFmpeg reading of the DASH
manifest was not qualified; complete concatenated-track decoding and browser
playback were confirmed with the unchanged files.

The quality scores apply to this reference/output pair and measurement method;
they are not quality targets for other content or an audio/video synchronization
measurement. The October 20 checks did not qualify AV1 output.

### Small local media check

A ten-second excerpt of [Big Buck Bunny](https://peach.blender.org/about/)
was checked with the worker's FFmpeg 8.1.3 build. The excerpt starts at 30 seconds
and contains 320 × 180 H.264 video at 24 frames per second, with stereo AAC at
48,000 samples per second. These are local encoding, packaging, and complete
decode results; they do not establish Bitmovin API execution or browser playback.

| Check | Result |
|---|---|
| Video frames | 240 |
| HLS video segments | Five segments of 2 seconds / 48 frames |
| DASH video segments | Five segments of 2 seconds / 48 frames |
| Complete HLS audio/video decode | Passed, exit 0 |
| Complete DASH audio/video decode | Passed, exit 0 |
| VMAF frames per comparison | 240, ordered and complete |
| VMAF mean: identical / encoded / degraded | 98.282 / 93.123 / 4.778 |

A [Linux CI run on 19 October 2026](https://github.com/kazuhide/bitovp/actions/runs/39211595682)
also passed: 240 video frames, five 2-second / 48-frame video segments in both
HLS and DASH, complete MP4/HLS/DASH audio/video decoding, and 240 VMAF frames
per comparison. Its identical / encoded / degraded means were
**98.282 / 93.142 / 5.088**.

These VMAF results use model `vmaf_v0.6.1` and score every frame. They
are fixture sanity checks; platforms and encoder builds can produce different
scores. They do not establish provider execution, browser playback, or quality
targets for other content.

Here, two seconds is 93.75 AAC frames. Audio therefore crosses the requested
video boundaries rather than being forced into an impossible integer frame
count. Encoder priming (startup delay) gives the excerpt’s first AAC packet a
timestamp of −21.33 ms.
Inspect presentation timestamps and decoded media together; packet counts alone
cannot establish playback duration or synchronization.

On Linux or macOS, install Docker, Node.js 24 or later, Python 3, and
the repository's pnpm version to run the automated check:

```sh
pnpm test:media
```

This downloads and verifies the source below, builds the worker image, and runs
the media checks without network access inside the container. It checks complete
video and audio decoding, each video segment's frame timestamps, and all 240
VMAF scores using the application's command builder and result parser. An
audio timestamp check rejects gaps and large start/end offsets while allowing
millisecond rounding, codec startup delay, and padding. These fixture bounds
do not establish audio/video synchronization. An
identical-video comparison and an intentionally degraded control check that the
model responds to visible damage; their thresholds are test sanity checks,
not quality targets for your content. No account or storage credentials are used.
Only the check's own temporary files, image, and container are removed afterward.
A failed check names the step that failed, lists each fixture's test totals,
and prints the end of the failed command's output.

To reuse an already extracted source without copying or changing it:

```sh
pnpm test:media --source /absolute/path/to/BigBuckBunny_320x180.mp4
```

To build the worker image for this check without compiling FFmpeg, add
`--ffmpeg /absolute/path/to/directory`: a directory outside the repository that
holds `bin/ffmpeg`, `bin/ffprobe` and `share/licenses/`, as
`sh scripts/native-media-tools.sh <new directory>` leaves it on Linux.

To reproduce, extract the MP4 from the [official Blender ZIP](https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip)
as `source.mp4` in a scratch directory, then run with the worker's FFmpeg:

```sh
mkdir -p hls dash
ffmpeg -v error -nostdin -y -ss 30 -i source.mp4 -t 10 \
  -map 0:v:0 -map 0:a:0 -c:v libx264 -threads 1 -crf 23 \
  -r 24 -g 48 -keyint_min 48 -sc_threshold 0 \
  -force_key_frames 'expr:gte(t,n_forced*2)' \
  -c:a aac -b:a 128k -ar 48000 -movflags +faststart bbb-10s.mp4
ffmpeg -v error -nostdin -y -i bbb-10s.mp4 -map 0 -c copy \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_flags independent_segments \
  -hls_segment_filename hls/segment-%03d.m4s hls/index.m3u8
ffmpeg -v error -nostdin -y -i bbb-10s.mp4 -map 0 -c copy \
  -f dash -seg_duration 2 -use_template 1 -use_timeline 1 \
  -avoid_negative_ts make_non_negative \
  -format_options use_editlist=0 \
  -adaptation_sets 'id=0,streams=v id=1,streams=a' dash/manifest.mpd
ffmpeg -v error -nostdin -i "$PWD/hls/index.m3u8" -map 0:v:0 -map 0:a:0 -f null -
ffmpeg -v error -nostdin -i "$PWD/dash/manifest.mpd" -map 0:v:0 -map 0:a:0 -f null -
```

Use absolute manifest paths so FFmpeg can resolve local fragments reliably.
The DASH example passes `use_editlist=0` through FFmpeg’s
[container format options](https://ffmpeg.org/ffmpeg-formats.html#dash-2).
An edit list adjusts the media presentation start. In this check, the default
DASH initialization edits caused the reader to omit AAC frames at fragment
boundaries. Disabling those edits preserved complete audio decoding; the check
retains its decoded-frame bounds instead of accepting the shorter result.
The [common non-negative timestamp origin](https://ffmpeg.org/ffmpeg-formats.html#Format-Options)
preserves relative track timing and prevents an initial AAC timestamp gap
observed with this worker build. Decoded audio timestamps and frame counts are
therefore checked together.

The source MP4 SHA-256 is
`f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508`.
The measured excerpt SHA-256 is
`a9a79a2afb8a04379bbbc363db4b8db92541f55ef6e11197af4391f5ae8de628`.
Different encoder builds can produce different bytes. Big Buck Bunny is licensed
under Creative Commons Attribution 3.0; excerpt credit:
“(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org”.

## Quality gates

A gate applies configured rules to measured results. `PASS` means all configured
rules were met. `FAIL` includes both below-threshold scores and missing required
measurements. Inspect each rule's values and unmeasured reasons separately from
a failed measurement run. Missing data cannot establish a pass.

Delivery blocking requires post-encoding manifest generation. A manual decision
to continue delivery is recorded separately. Gate success does not establish
CDN reachability or browser playback.

## Local and cloud execution

**Local CPU** is the default for new GUI measurements. Choose
**Local (GPU if available)** to use a supported GPU on the worker when available, with the
same-model CPU path otherwise. The report records the actual method and the
reason for CPU selection. See [GPU setup and limits](./GPU-QUALITY.md#choose-local-processing).

The worker automatically selects calculation
threads and simultaneous VOD comparisons to fit its CPU and available memory.
A large reference still requires decoding at that reference's dimensions even
when the output is small. More calculation threads can also increase memory
use. Resource selection preserves the model, comparison resolution and every
scored frame; it does not trade measurement accuracy for speed. Live captures
keep their sequential rendition order. See [local resource settings](../OPERATIONS.md#local-quality-resources)
for manual limits and memory diagnostics.

Two local ten-second pipeline checks used the same Big Buck Bunny source, starting
at 60 seconds, resized to each geometry below. Each comparison used one H.264
reference/output pair, the `vmaf_v0.6.1` model and every frame. At four allocated
CPUs and 4 GiB memory, all frame indices, feature values and pooled metrics
matched the earlier complete-frame measurements exactly.

| Reference / frames per second | Scored frames | Selected threads | Elapsed seconds | Peak memory (MiB) |
|---|---:|---:|---:|---:|
| 1280 × 720 / 24 | 240 | 4 | 2.54–5.23 | 560–668 |
| 1280 × 720 / 60 | 600 | 4 | 6.64–9.14 | 560–564 |
| 1920 × 1080 / 24 | 240 | 4 | 5.72–12.37 | 877–901 |
| 1920 × 1080 / 60 | 600 | 4 | 13.71–19.10 | 921–964 |
| 3840 × 2160 / 24 | 240 | 2 | 39.45–46.85 | 1,680–1,793 |
| 3840 × 2160 / 60 | 600 | 2 | 96.51–137.60 | 1,864–1,977 |

The ranges show two observations per case with fixture storage and persistence.
They establish quality equivalence for these inputs, without establishing a
speed improvement or cloud execution. Peak container memory includes the
measurement process and cached file pages. Resizing this small source exercises
the processing geometry; it does not represent native high-resolution content
or establish memory requirements for every codec/model.

A separate control check exercised the actual Web API, queue, database and
worker on one host. Each 120-second comparison completed all 2,880 frames;
a second comparison was reset while scoring. Worker CPU and memory limits
were applied for each row. All sampled API responses, Live stop confirmations
and reset-to-process-close timings in this final run stayed below one second.

| Worker limits | Reference / frames per second | Maximum API response (ms) | Live stop confirmed (ms) | Reset to FFmpeg close (ms) |
|---|---|---:|---:|---:|
| 2 CPUs / 2 GiB | 1280 × 720 / 24 | 296.6 | 139.3 | 310.3 |
| 4 CPUs / 2 GiB | 1920 × 1080 / 24 | 56.2 | 288.3 | 347.6 |
| 2 CPUs / 4 GiB | 1280 × 720 / 24 | 11.1 | 101.7 | 341.6 |
| 4 CPUs / 4 GiB | 1920 × 1080 / 24 | 33.7 | 189.4 | 327.6 |

Live provider responses were supplied by a local test fixture; this checks
application control handling without external encoding jobs or provider latency.
No worker container was killed for exceeding its memory limit. Earlier checks observed reset-to-close
latency up to 1.55 seconds and one startup health response of 1.19 seconds.
The final reset path uses the documented 100-millisecond deletion check and
250-millisecond termination grace. These single-host results and resource
estimates do not guarantee response times or memory use for other workloads.

Cloud execution requires an administrator-enabled
profile under `/settings/vmaf` and a positive per-run USD budget. Saving a profile
does not launch compute. Profiles identify region, pinned worker image, workspace
storage, permissions, timeout, and cost limits.

The profile's compute credentials and workspace-storage credentials can differ.
Use narrowly scoped roles or encrypted cloud credentials. AWS, GCP, Azure, and
Akamai execution need provider-specific infrastructure; the application does not
create every prerequisite automatically.

Budgets restrict new work, but are not a guarantee of the final provider invoice.
Transfer, startup, and interrupted compute can still cost money. Keep profile
ownership and cleanup credentials until resources are confirmed removed. See
[Operations](../OPERATIONS.md#cloud-quality-workers).

## Check the outcome

Compare reports only when source, time range, model, sampling, and rendition
identity match. Combine metrics with visual review and output completeness.
Ordinary VOD/Live operation does not require the separate release Verification
harness; a harness result applies to its own tested configuration and execution.
