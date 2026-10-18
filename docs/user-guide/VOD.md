# VOD: configure and run an encoding

[Back to the user guide](../USER-GUIDE.md)

VOD means video on demand: encoding stored files for later playback. An
`OPERATOR` or `ADMIN` can start, cancel, and rerun jobs. Starting a job incurs
Bitmovin charges and writes to the selected output storage.

## Create a job

Open `/vod/jobs`, choose the create action, and follow `/vod/new`:

1. **Basics:** name, Bitmovin account, region, encoder version, and encoding mode.
2. **Sources:** choose stored media and identify the video, audio, and subtitle tracks.
3. **Ladder:** configure each output rendition's codec, dimensions, bitrate, and
   advanced codec settings. A ladder is the collection of these renditions.
4. **Outputs:** choose credentials, bucket/container, and a dedicated output path.
5. **Packaging:** select containers and the streams each container holds.
6. **Encoding:** configure Per-Title, filters, quality measurement, and other
   optional encoding features.
7. **Manifests:** configure HLS/DASH and when manifests are generated.
8. **Review:** inspect the plan preview, warnings, generated resources, and paths,
   then start encoding.

Saved templates, samples, and imported plan JSON populate the same workflow.
Importing or copying settings does not create a job. Settings that the form
cannot represent remain available through the JSON editor instead of being
silently discarded. Resolve validation errors before submission.

Drafts are saved in this browser for seven days, separately by user, organization,
and creation source. Secret values, URLs, DRM settings, filters, and imported JSON
are excluded. Review omitted settings and output destinations after restoring.

## Fixed ladders and Per-Title

A fixed ladder uses your chosen resolutions and bitrates. Per-Title analyzes the
source and produces content-dependent renditions. Template bitrates are null;
use supported path placeholders such as `{uuid}`, `{height}`, `{width}`, and
`{bitrate}` to keep results separate. Custom manifests are generated after the
result renditions exist.

Per-Title controls are under Encoding, with stream modes in Ladder:

- `PER_TITLE_TEMPLATE_FIXED_RESOLUTION` keeps a chosen resolution.
- `PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE` uses the specified bitrate
  constraints; additional forcing settings are under the codec's Per-Title controls.
- `minBitrateStepSize` is a ratio: `1.5` requires at least a 1.5-fold bitrate step
  between neighboring renditions. Blank means unspecified.

Result attribution uses output identity and unambiguous settings. An ambiguous
result stays unattributed; the application does not guess by rendition count.

Use one video codec per job as the simplest delivery workflow. A DASH video
adaptation set contains only one codec. H.264/H.265 presets can conflict with a
job-wide encoding mode; the form explains when per-rendition settings apply.

## Advanced video, audio, and subtitles

Expandable controls beside each rendition expose the supported codec parameters.
Blank values generally leave the provider default; use field help for units and
valid ranges.

Where enabled for the account, HEVCv2 uses its own codec controls and Per-Title
QP targets. The BCF override is separate from encoder version. Motion-compensated
temporal filtering (MCTF) supports `AUTO`, `OFF`, and `ON`; perceptual quality
controls apply to the final codec. Legacy CRF/x265 settings are not automatically
translated. Switching codecs preserves conflicting settings until you explicitly
remove them and pass validation.

- **IMSC subtitles:** select a TTML source, IMSC codec, and `.ttml` output. Use
  WebVTT for HLS subtitles.
- **Opus audio:** package as WebM for compatible DASH playback. Use a separate
  compatible audio rendition when also producing HLS.
- **Filters:** add a filter and assign it to the intended stream's filter chain.
  HQDN3D removes noise; Unsharp sharpens or blurs.
- **CMAF muxing:** the dedicated muxing supports H.264/AAC with DASH
  TEMPLATE/TIMELINE. Choose fMP4 for HLS and the supported DRM paths.

## Packaging and playback

HLS/DASH manifests describe available renditions and their segments. Packaging
defines how those streams are stored, for example MPEG-TS, fragmented MP4
(fMP4), or progressive MP4.

For HLS, decide whether video and audio share a container or use separate audio
groups. A variant that already contains audio must not also reference an external
audio group. Keep child-playlist paths unique when producing multiple masters;
changing only the master filename does not prevent child overwrites.

After submission, open `/vod/jobs/[id]`. Check the last successful or failed step,
provider resources, input/output identity, and manifest URLs. After `FINISHED`,
play the output and check the expected video and audio renditions. A terminal
encoding status alone does not prove CDN delivery or browser playback.

## Quality checks and scene analysis

Optional VMAF compares the output with a reference source. Select local execution
or an administrator-configured cloud profile and a per-run USD budget. Quality
gates can hold delivery when post-encoding manifest generation is used.
See [Quality and monitoring](./QUALITY-AND-MONITORING.md).

AI Scene Analysis can be configured under Encoding. Timed ad cue points accept
positions and permitted deviation in seconds, including zero and fractional
values. A zero tolerance does not guarantee physical frame alignment. Completed
analysis and playback references are available in the content library.

## Copy, retry, and cancel

Copy settings opens an editable wizard; rerun as a new job creates new work.
Review output paths before either action. A failed job may reuse its resources
during a two-hour recovery window. Once automatic recovery records a stop request,
retrying the same resources is refused; use a new job instead. A stop request is
not confirmation that the provider has stopped.

See [supported features and limits](../BITMOVIN-API-COVERAGE.md) for more restrictions.
