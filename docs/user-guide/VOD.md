# VOD: configure and run an encoding

[Back to the user guide](../USER-GUIDE.md)

VOD means video on demand: encoding stored files for later playback. An
`OPERATOR` or `ADMIN` can start, cancel, and rerun jobs. Starting a job incurs
Bitmovin charges and writes to the selected output storage.

## Create a job

Open `/vod/jobs`, choose the create action, and follow `/vod/new`:

New configurations start with region `AUTO`, which lets Bitmovin select a
region. Review the selected account and any saved or copied region settings.
The new VOD wizard defaults to Encoder `2.294.0` (Beta). Saved account defaults,
drafts, and imported plans retain their selected version; use `STABLE` if you
need the current stable encoder instead.

1. **Basics:** name, Bitmovin account, region, and encoder version.
2. **Sources:** choose stored media and identify the video, audio, and subtitle tracks.
3. **Ladder:** configure each output rendition's codec, dimensions, bitrate, and
   filters. A ladder is the collection of these renditions.
4. **Outputs:** choose credentials, bucket/container, and a dedicated output path.
5. **Packaging:** select containers and the streams each container holds.
6. **Encoding:** configure the job-wide encoding mode, Per-Title, quality
   measurement, and other optional encoding features.
7. **Manifests:** configure HLS/DASH and when manifests are generated.
8. **Review:** inspect the plan preview, warnings, generated resources, and paths,
   then start encoding.

These steps package the job for streaming. To write finished files instead — MP4,
MPEG-TS, QuickTime, or WebM files with the audio inside, and no manifests — choose **Export files**
under "What to create" at the top of the page. That flow has six steps: Basics,
Sources, Format, Destination, Encoding, and Review. In Format, each container offers
every codec it can hold (AV1 in MP4 and WebM, VP9 and Opus in WebM, for example), and
each file has its own video codec and its own audio. Files in more than one video
codec need the same encoding mode on every file, other than "(default)". Files are written directly into
the output folder and are named after the job until you type a name. Two files in one
job cannot have the same name, and two made in the six steps cannot have the same
height and codec with the same bitrate in kbps. A file already in the folder under
the same name may be replaced. Public read access is not requested for the files
unless you select it in Destination. Encoding is the step the eight steps have,
with AI Scene Analysis, quality control, and Kantar audio watermarking. It leaves
three settings to the eight steps: the Per-Title configuration, what a QC gate does
when it fails, and the renditions a gate rule is for. A gate set here holds nothing
back: a failed rule is recorded on the job and sends the "QC gate failed"
notification, and each rule is for every file. The AI Scene Analysis result, the
copies measured for quality, and the Kantar report start in a folder named after the
job inside the output folder; the copies are named after the video settings and not
after the job, so keep a folder for each job. Review lists what those settings
write with the files. **Show all settings** opens the eight steps with what you
entered, and **Back to simple view** returns while nothing outside the six steps is
in use. The input timeline in Sources is part of the six steps: the files are then
made from the edited sequence, which also decides whether they have audio, and the
sources selected for a file are not used. Applying a saved image as an output logo
adds a filter, so the form opens the eight steps. The flow you choose is remembered in this browser, and
Settings holds the same choice under "New VOD job flow". Switching "What to create"
opens a new form: what you entered is not carried over. It is saved as the other
flow's draft, unless that form was still offering to restore an earlier draft.

Saved templates, samples, and imported plan JSON populate the same workflow.
Importing or copying settings does not create a job. Settings that the form
cannot represent remain available through the JSON editor instead of being
silently discarded. Resolve validation errors before submission.

In **Sources → Edit on timeline**, arrange or replace clips on V1 and A1. The
CPU preview supports independent video and audio edits. For pairs that differ
in source, trims, positions or padding, use **Prepare encoding input** to create
a single MP4 before submitting the encoding. This preparation supports 8-bit
BT.709 SDR and read/write access to S3-compatible or GCS HMAC storage. It
re-encodes up to one hour and 4 GiB. For other formats, use an aligned sequence
or supply a combined source file.
[Timeline controls and preparation limits (Japanese)](../vod-input-timeline.md)

Drafts are saved in this browser for seven days, separately by user, organization,
and creation source. VOD drafts keep filter settings, including image object paths and audio channel gains.
Secrets, URLs, DRM settings, text-overlay content and imported JSON are excluded. Review omitted settings and output destinations after restoring.

When copying a job with a protected source, supply a replacement path before
opening its draft. Replacing an HDR10+ picture also requires the matching JSON
sidecar. **Launch** from Templates submits with the selected settings and signed-in
operator. If the response is lost, use the offered retry with the same settings
to check or resume that creation.

## Audio-only files

In **Export files**, select one source file. Open **Format → Export audio only** and choose the track you want to deliver. Track 1 is the first audio track in the source.

| Format | Source and output | Minimum Encoder version |
|---|---|---|
| Convert to PCM WAV | Select the track, sample rate, mono or stereo, and 16-, 24- or 32-bit signed little-endian samples. | 2.203.0 |
| Copy original AAC | Progressive MP4/M4A or MOV | 2.200.0 for MP4, 2.201.0 for MOV |
| Copy original PCM | Progressive MOV or WAV, for 16-, 24- or 32-bit signed little-endian PCM | 2.200.0 for MOV, 2.202.0 for WAV |

For copying, choose **Inspect source tracks** and select a verified track. Choose a versioned S3-compatible or GCS object of up to 4 GiB. Changing the input requires a new inspection. The Encoder reads the same inspected version even if another object is uploaded to that key. Copies take a single unedited track. Trimming, concatenation, filters and mixing require re-encoding. **Review** shows the output filename and destination. Plan JSON retains the track selection for this source.

Administrators must configure the same `BITOVP_CAPTURE_INPUT_SECRET` of at least 32 characters and an Encoder-reachable `BITOVP_CAPTURE_INPUT_BASE_URL` on Web and Worker for audio copying. [Encoder release history](https://developer.bitmovin.com/encoding/docs/encoder-22000-22490)

## HDR10+ input for HEVC

HDR10+ is a VOD HEVC (H.265) feature introduced in Encoder `2.294.0` (Beta) and
[REST API `1.289.0`](https://developer.bitmovin.com/encoding/docs/rest-api-services-12500-12990#12890).
Execution requires Encoder `2.294.0` or later and public API SDK `1.289.0` or
later, which exposes the HDR10+ input-stream API.

1. In **Sources**, select the HDR10 video file and choose **Add HDR10+ video**.
2. Set **HDR10+ metadata JSON path** to the matching JSON file on the video's
   same input storage and bucket. Use the metadata field or its browser; do not
   add the JSON as another video input file.
3. In **Ladder**, select the resulting HDR10+ stream as the source of an H.265
   rendition. Keep `AUTO` for automatic video-track selection, or choose an
   explicit supported selection mode and position.

Select the HDR10+ resource directly on the HEVC rendition. The trimming and concatenation input APIs accept other input-stream types.

When you change the video file or its storage, select the matching JSON again. Watch folders discover one object at a time. Submit paired HDR10+ assets through the VOD wizard.

The input timeline cannot currently be combined with HDR10+ in this application;
use the video source directly. This is an application limitation, not a general
Bitmovin restriction. HDR10+ is not a Live input option or an H.265 dynamic-range
dropdown value. See the [input-stream reference](https://developer.bitmovin.com/encoding/reference/postencodingencodingsinputstreamshdr10plusbyencodingid)
and [Encoder release notes](https://developer.bitmovin.com/encoding/docs/encoder-22500-22990#22940-beta).

## Fixed ladders and Per-Title

A fixed ladder uses your chosen resolutions and bitrates. Per-Title analyzes the
source and produces content-dependent renditions. Template bitrates are null;
include `{uuid}` or `{bitrate}` in output paths to keep results separate.
`{height}` and `{width}` can also be used, but do not satisfy that requirement
on their own. Custom manifests are generated after the result renditions exist.

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

For media with embedded captions, open **Sources → Streams → Add embedded captions** and select the media file. CEA-608 offers CC1 and CC3. CEA-708 accepts service numbers 1–63 and uses service 1 when left blank. For DVB, choose automatic selection or a zero-based position among all tracks or subtitle tracks. Under **Ladder → Subtitle tracks**, assign that source to a WebVTT rendition. Choose the text file output for a sidecar or segmented WebVTT for HLS. Each selection extracts one track at its original timestamps.

- **IMSC subtitles:** select a TTML source, IMSC codec, and `.ttml` output. Use
  WebVTT for HLS subtitles.
- **HE-AAC audio** is available for segmented fMP4 with HLS or DASH. Select HE-AAC v1 for up to 128,000 bps or v2 for up to 64,000 bps. A blank sample rate, layout, or signaling uses the encoder default. Only v2 offers explicit parametric-stereo signaling (`EXPLICIT_PS`). [Bitmovin codec configuration](https://developer.bitmovin.com/encoding/reference/postencodingconfigurationsaudioheaacv2)
- **Opus audio:** package as WebM for compatible DASH playback. Use a separate
  compatible audio rendition when also producing HLS.
- **Filters:** add a filter and assign it to the intended stream's filter chain.
  Enhanced Deinterlace and Interlace control field processing. Conform requires the same target frame rate on every audio and video stream in an encoding, with any explicit video frame rate matching. Use Conform on encodings with ordinary audio and video inputs. Captions, subtitle streams and Dolby Atmos file inputs, including trimmed Atmos files, are incompatible.
  Enhanced Watermark takes an image from input storage. Set one horizontal and one vertical offset. Optional dimensions are at least one pixel or 0.1–100 percent.
  On audio renditions, Audio Mix maps input channels and gains to numbered outputs. Place Audio Mix before volume and loudness filters. Use ordinary audio inputs, including when trimming or concatenating files. Dolby Atmos files bypass the mix. Select a matching codec layout. The layout selector disables speaker mappings the encoder changes.
  Dolby Loudness requires Encoder 2.282.0 or newer and a supported audio codec. Leave audio/video sync unset and Kantar off. Use Dolby Loudness separately from Audio Volume and EBU R128 single-pass. Use Plan JSON to export a plan with Dolby Loudness.
  HQDN3D removes noise and Unsharp sharpens or blurs.
- **CMAF muxing:** the dedicated muxing supports H.264/AAC with DASH
  TEMPLATE/TIMELINE. Choose fMP4 for HLS and the supported DRM paths.

## Packaging and playback

HLS/DASH manifests describe available renditions and their segments. Packaging
defines how those streams are stored, for example MPEG-TS, fragmented MP4
(fMP4), or progressive MP4. Progressive TS, MOV, and WebM write one whole file for
each video rendition, with the audio inside: H.264 or H.265 video in TS and MOV, and
VP9 or AV1 video with Opus audio in WebM. No manifest lists them and DRM is not
offered. MOV and WebM have not been verified on a real encode, so check the first
output.

For HLS, decide whether video and audio share a container or use separate audio
groups. A variant that already contains audio must not also reference an external
audio group. Keep child-playlist paths unique when producing multiple masters;
changing only the master filename does not prevent child overwrites.

After submission, open `/vod/jobs/[id]`. Check the last successful or failed step,
provider resources, input/output identity, and manifest URLs. After `FINISHED`,
play the output and check the expected video and audio renditions. A terminal
encoding status alone does not prove CDN delivery or browser playback.

To play delivery outputs together, select two or three finished jobs in
**VOD Jobs** and choose **Compare outputs**. Pick playable HLS or DASH outputs
with the same content and start point. Use the shared play, pause and seek
controls and choose one audio source. This view is available without QC reports.
The original two-output comparison exercised these controls with synthetic HLS
in [Installed GUI](https://github.com/kazuhide/bitovp/actions/runs/43829369516/job/133170822700).
Verify Dolby Vision display on the intended playback hardware.

### AWS S3 with an IAM role

In **Credentials**, save an **AWS S3 (role-based)** connection with the role
ARN and bucket region. In the VOD wizard select it in **Sources**, **Outputs**,
or both, then enter the bucket and object path or output folder. Plans and
presets reference the saved credential as `S3_ROLE_BASED`. New role-based
destinations default to private access. Delivery mirrors inherit the primary
destination's ACL.

Configure the IAM trust policy using Bitmovin's GLOBAL External ID for the
organization or sub-organization that runs the job. Bitmovin supplies this
value when it assumes the role. Grant the role read access for sources and the
required write permissions for destinations. [Bitmovin's role-based setup guide](https://developer.bitmovin.com/encoding/docs/creating-an-s3-role-based-encoding-input-or-output-with-the-bitmovin-api)

Bitmovin uses the role during encoding. The storage browser, local media
inspection and QC need independently readable storage and cannot use this
role. To preview results, configure a playable HTTPS delivery URL for the
bucket through the credential's public base URLs. Use a fixed ladder for
role-based output. Bitmovin requires Encoder 2.29.0 or later for segmented
role-based output.

## Quality checks and scene analysis

Optional VMAF compares the output with a reference source. Select local execution
or an administrator-configured cloud profile and a per-run USD budget. Quality
gates can hold delivery when post-encoding manifest generation is used.
See [Quality and monitoring](./QUALITY-AND-MONITORING.md).

AI Scene Analysis can be configured under Encoding. Analysis always includes
English; add `ja` for Japanese, or leave additional languages blank for English
only. Timed ad cue points accept
positions and permitted deviation in seconds, including zero and fractional
values. A zero tolerance does not guarantee physical frame alignment. Completed
analysis and playback references are available in the content library.

## Copy, retry, and cancel

Copy settings opens an editable wizard; rerun as a new job creates new work.
Review output paths before either action. A failed job may reuse its resources
during a two-hour recovery window. Once automatic recovery records a stop request,
retrying the same resources is refused; use a new job instead. A stop request is
not confirmation that the provider has stopped.

A START error can leave the provider state uncertain. Cancellation prevents
further START retries once the worker observes it; an in-flight request must
settle first. `CANCELED` records local cancellation. The worker checks the exact
encoding and requests a stop if it is queued or running, but only terminal
provider readback confirms termination. A created or unknown provider state, or
a failed stop or readback, leaves that confirmation pending.

See [supported features and limits](../BITMOVIN-API-COVERAGE.md) for more restrictions.


## Inspect or remove a provider resource

Open a job’s **Resources** tab, expand **Inspect provider resources** and select a recorded step. Details are read from the provider using the job’s original account. Where available, the collection view lists resources under the selected parent. If the account binding or resource history cannot be verified, the saved job history is still available.

For a recorded HDR10+ input, the detail and collection views show the track
selection when available. They omit the video and JSON paths and the metadata
contents. HEVC and HEVC v2, PCM and audio passthrough configurations, and
Progressive WAV muxings can also be inspected from their recorded steps.

For a recorded fMP4, MP4, Progressive MOV, Progressive TS, Progressive WAV, or
Progressive WebM muxing, open **Output information** to see the size, container
bitrate, and duration when the provider returns those measurements.

Select a recorded fMP4, MP4, TS, Progressive TS, WebM or Progressive WebM muxing to see its DRM systems. Progressive TS also exposes ID3 tags. Choose a type, then open a row to see its public details or check whether its metadata identifies this job. The general DRM list shows the entries the provider returned. Choose a specific DRM system to browse further pages.

For protected DASH or Smooth manifests, select the representation or content-protection creation step to inspect the recorded provider resource and its collection. BitOVP checks the manifest hierarchy and the encoding, muxing and DRM references saved by that step.

For DRM configurations created by this job, select the individual CENC, FairPlay or SPEKE creation step to inspect its ownership stamp.

An operator can choose **Remove from provider** for a resource created by a finished job. For a failed or canceled job, bitovp also requires confirmation that its encoding stopped. Type the displayed resource ID to confirm. A resource used by another recorded execution cannot be removed through this control. A job cannot resume its old graph after a confirmed removal. To encode again, create a new job.

If the provider response is lost, open the same resource and choose **Check removal**. A confirmed absence finishes the pending removal. If the resource still exists, the operator can review it and explicitly retry. The original job is retained while an outcome is pending.
