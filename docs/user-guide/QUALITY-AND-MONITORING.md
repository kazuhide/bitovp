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

VMAF (Video Multi-Method Assessment Fusion) compares decoded output frames with
a reference video. This application calculates it with ffmpeg/libvmaf; it is
not a Bitmovin Encoding API metric.

- Enable VMAF in the VOD wizard to measure after encoding.
- Use `/qc` to measure an existing completed job.
- On an eligible VOD job, use remeasure to create a report without changing the
  original automatic quality-gate decision.
- Open `/qc/[id]` for rendition results and `/qc/compare` for compatible reports.

Check reference/output identity, model, measurement generation, frame sampling,
expected rendition count, and errors. Mean alone can hide poor frames; inspect
percentiles, worst frames, and the frame graph too. A partial result is not a
complete ladder measurement.

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

To reuse an already extracted source without copying or changing it:

```sh
pnpm test:media --source /absolute/path/to/BigBuckBunny_320x180.mp4
```

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

A gate applies configured rules to measured results. `PASS` means those rules
were met; `FAIL` means a valid measurement failed them. A missing or failed
measurement is a separate state and cannot establish a pass.

Delivery blocking requires post-encoding manifest generation. A manual decision
to continue delivery is recorded separately. Gate success does not establish
CDN reachability or browser playback.

## Local and cloud execution

Local execution is the default. Cloud execution requires an administrator-enabled
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
