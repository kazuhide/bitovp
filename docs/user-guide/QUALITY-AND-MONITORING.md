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
