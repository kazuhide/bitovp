/**
 * THE VOD golden-fixture registry — the acceptance corpus (REQUIREMENTS §7.1).
 *
 * A plain module, not a test file, on purpose: `fixture-registry.test.ts` needs
 * this list to set-equal it against the fixture DIRECTORY, and importing it
 * from `compiler.test.ts` made vitest re-register that whole suite inside the
 * guard — 4 assertions reported as 346 tests, every compiler golden running
 * twice. A list two test files share is a module, not a test export.
 */
export const VOD_FIXTURES = [
	// P1 — fixed-bitrate core four
	"fixed-bitrate-hls-on-aws",
	"fixed-bitrate-dash-hls-streamcondition-on-aws",
	"dash-hls-sftp-output-just-in-time",
	"dash-hls-sftp-output-post-encoding",
	// P2-PR1 — fixed-bitrate remainder (Azure, MP4 byte-range, thumbnails)
	"mp4-fixed-bitrate-hls-on-aws",
	"mp4-fixed-bitrate-hls-on-azure",
	"fixed-bitrate-hls-on-azure",
	"fixed-bitrate-hls-streamcondition-on-aws",
	"fixed-bitrate-hls-streamcondition-on-azure",
	"fixed-bitrate-dash-hls-streamcondition-on-azure",
	"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws",
	"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-azure",
	// P2-PR1 — webvtt + audio-only
	"fixed-bitrate-hls-vtt-on-aws",
	"fixed-bitrate-hls-vtt-on-azure",
	"mp4-fixed-bitrate-hls-vtt-on-aws",
	"mp4-fixed-bitrate-hls-vtt-on-azure",
	"audio-only-aac-fmp4-hls-dash",
	// P2-PR2 — keyframes, TEMPLATE-vs-TIMELINE, filters
	"keyframes-segment-aligned",
	"keyframes-segment-non-aligned",
	"dash-template-and-timeline-on-aws",
	"deinterlace-filter",
	// P2-PR3 — per-title family + hdr10
	"pertitle-h264-fmp4-ts-dash-hls-on-aws",
	"pertitle-h265-fmp4-dash-hls-on-aws",
	"pertitle-vp9-webm-fmp4-dash-on-aws",
	"pertitle-h264-openapi",
	"pertitle-h264-separate-av-inputs",
	"hdr10-pertitle",
	// P2-PR4 — DRM family + forensic watermark
	"cenc-cbc-drm-on-aws",
	"pertitle-h264-fmp4-ts-drm-on-aws",
	"pertitle-h265-fmp4-drm-on-aws",
	"pertitle-vp9-webm-cenc-drm-on-aws",
	"pertitle-h264-mp4-smooth-drm-on-aws",
	"nexguard-watermarking",
	// P2-PR5 — dolby family (multi-encoding ladders, atmos, DV)
	"dolby-audio-only-atmos-damf",
	"dolby-audio-only-atmos-adm",
	"dolby-atmos-progressive-mp4",
	"dolby-dv-ddp-multi-audio",
	"dolby-dv-embedded-ddp",
	"dolby-dv-hdr10-sdr-2ladder-profile81",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
	"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs",
	"dolby-dv-atmos-damf",
	"dolby-dv-atmos-damf-aac",
	"dolby-dv-atmos-adm",
	"dolby-dv-atmos-damf-https",
	"dolby-dv-atmos-adm-https",
	"dolby-dv-separated-metadata-adm",
	"ai-scene-analysis-passthrough",
	"ai-scene-analysis-pertitle",
	"ai-scene-analysis-passthrough-test",
	"ai-scene-analysis-pertitle-test",
	"ai-scene-analysis-batch-item",
	"dolby-dv-hdr10-sdr-2ladder-profile81-test",
	"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test",
	"dolby-dv-3ladder-profile5-dash-ondemand",
	// Input-stream trimming + concatenation (the modern path) — no
	// encoding examples exists (like Live), so these are hand-built synthetic
	// scenarios. The template exporter does NOT model these input-stream
	// kinds, so they are intentionally excluded from template.test.ts.
	"trimming-time-based",
	"concatenation-two-sources",
	// GenericS3 / GCS encoding I/O  — synthetic (no encoding examples).
	// generic-s3-akamai-io exercises a GENERIC_S3 input + output (Akamai/OCI per
	// C10); gcs-service-account-io exercises GCS_SERVICE_ACCOUNT in/out with a
	// cloudRegion. Excluded from the sample-preset / plan-import suites below.
	"generic-s3-akamai-io",
	"gcs-service-account-io",
	// Trick-play sprites (encodings.streams.sprites) — synthetic (no
	// encoding examples, like Live/trimming). Sprites ARE template-representable,
	// so this one IS pinned in template.test.ts too. Excluded from the
	// sample-preset / plan-import suites below.
	"sprites-trickplay",
	// AV1 codec (Av1VideoConfiguration) — synthetic (no encoding examples, AV1 is a
	// modern-codec gap). AV1 IS template-representable, so both are pinned in
	// template.test.ts too. Excluded from the sample-preset / plan-import suites.
	"av1-fmp4-dash-hls",
	"pertitle-av1-fmp4-dash-on-aws",
	// VMAF-only encode (qc.only) — synthetic (no encoding examples). Proves the
	// qc.only gate compiles to ONLY video qc mirrors: input → output → encoding
	// → {codec, stream, qc-muxing} → start, with NO delivery muxing/manifest ops.
	// Excluded from template.test.ts (no template golden generated) and from the
	// sample-preset / plan-import suites.
	"vmaf-only-h264",
	//  — Akamai NetStorage on BOTH sides. The golden's job is the
	// pair of ops: input and output are one branch in the executor because the
	// SDK models are identical, so a golden that only exercised one direction
	// would leave the other's compilation unpinned.
	"akamai-netstorage-io",
	// P5 PR-2 — Encoding labels + Cloud Connect infrastructure pinning +
	// start-request tweaks/handleVariableInputFps + JIT preview-manifest
	// placement (synthetic; no encoding examples covers these SDK fields).
	"labels-infrastructure-preview",
	// P5 PR-4 — Kantar audio watermarking (encoding-level singleton; the
	// service login rides the KANTAR vault provider, so the plan carries only
	// a credentialId). Synthetic: no encoding examples uses Kantar.
	"kantar-audio-watermark",
	//  — multi-output delivery. Synthetic: encoding examples has no
	// multi-storage scenario; the plan mirrors every destination to a GCS
	// output beside the S3 origin.
	"multi-output-s3-gcs",
	//  — one container, two streams. Synthetic in the sense that no
	// encoding examples builds a multi-stream muxing (all 67 pass a one-element
	// `streams` list), but NOT synthetic as a delivery shape: muxed MPEG-TS is
	// the classic HLS layout and a progressive MP4 that holds only video is
	// not a file anyone can play. These two goldens are what pins the
	// difference between "the plan says two streams" and "two MuxingStream
	// entries reach the wire" — and the compiler's own backward-reference
	// assertion is what proves the muxed container waits for both streams.
	"hls-ts-muxed-av",
	"mp4-muxed-av-progressive",
	// Audit 893eb66 CRITICAL-2 (case 8) — a FIXED VP9 WebM ladder beside AAC
	// fMP4 in one DASH manifest. Synthetic: the vendor's only WebM samples are
	// per-title, which ride the runtime expansion and never touched the static
	// video selection — the path that hard-coded FMP4 and dropped every WebM
	// leg from the MPD. This golden pins CREATE_DASH_REPRESENTATION_WEBM being
	// emitted statically at all.
	"vp9-webm-fixed-dash",
	// Audit 893eb66 HIGH-9 (cases 10/15/17) — H264 and H265 in ONE encoding,
	// implicit HLS+DASH. Synthetic: no encoding examples mixes video codecs in a
	// single encoding (the Dolby ladders use one encoding per codec). Pins the
	// per-codec DASH adaptation sets (case 15 died on the first H265 rep added
	// beside H264; case 17's explicit codec-separated sets succeeded) and, with
	// `encodingMode: TWO_PASS` pinned, the historical START shape. R43 proved
	// preset/START mode conflict: retain construction bytes, but refuse submit.
	"mixed-codec-dash-hls",
];
