/**
 * THE live golden-fixture registry. A plain module for the reason its VOD
 * sibling is one — see packages/core/src/plan/fixtures.ts.
 */
export const LIVE_FIXTURES = [
	"live-rtmp-simple",
	"live-srt-caller",
	"live-srt-listener",
	"live-redundant-rtmp",
	"live-zixi",
	// P5 PR-2 — Encoding.staticIpId (live-only, consumed at CREATE) + labels
	// + Cloud Connect infrastructure on the live plan (synthetic).
	"live-static-ip",
	// P5 PR-3 — the live start-request long tail on one channel (synthetic):
	// ESAM/POIS (vault-ref auth) + Cache-Control + adInsertion, HLS
	// programDateTimeSettings and every SCTE-35 marker knob at a NON-default
	// value, with the RTMP input id pinned . The PDT source
	// matches clockSynchronizationMode (C19 rail) and the output is S3, so the
	// plan compiles clean.
	"live-esam-full",
	// : the static-RTMPS default's golden — GENERATE key, no
	// dynamic points, URL knowable from creation.
	"live-static-ingest",
	// : an Akamai MSL delivery target instead of object storage —
	// the topology Akamai live customers actually run. CMAF on purpose: it is
	// the most demanding C31 profile (fMP4 muxings AND both manifests), so the
	// golden pins the whole constraint, and the compiled op sequence pins that
	// the output is created with NO credential step ahead of it.
	"live-akamai-msl",
	//  Track 2a: an ARBITRARY encoder-version pin — Track 1's
	// premise made real (all prior fixtures said STABLE, so the pin
	// capability was schema-real but fixture-unproven; the first draft's
	// "fixture-proven" overclaimed and this is the correction). The golden
	// pins that the literal rides into CREATE_ENCODING untouched.
	"live-pinned-encoder",
	// : the first LIVE deliveryMirror — Akamai Object Storage as
	// the primary with an MSL4 mirror. Landed with plan/ops/expected-live and
	// an expected-live consumer, but NOT this registry, so its compiled op
	// sequence had no deep-equal pin at all.
	"live-akamai-msl-storage",
	// : the first MSL5 fixture. Differs from `live-akamai-msl` in
	// exactly three ways, each one a measured fact rather than a choice —
	// mslVersion MSL5, the DASH-style segment naming the vendor's own E2E uses,
	// and encoderVersion 2.283.0, the release that shipped MSL5 support.
	"live-akamai-msl5",
	// Same landing, same gap: the TS-muxing MSL profile. Both are added here
	// rather than argued away — fixture-registry.test.ts derives this list's
	// population from the DIRECTORY, so an unpinned fixture in either watched
	// directory cannot land again. Scope, stated rather than implied
	// (review-299): `readdirSync` is not recursive and the two directory paths
	// are hardcoded, so a nested or third-family fixture would be unwatched.
	// Neither exists today — `git ls-files '*.plan.json'` finds 68 + 12 and
	// nothing elsewhere — but the guard's reach is those two flat directories,
	// not "anywhere".
	"live-akamai-msl-ts",
	//  — the live half of muxed MPEG-TS. Live reuses `tsMuxingSchema`
	// verbatim, so it inherited the one-stream limit AND inherits the fix; this
	// fixture is what makes that inheritance a measured fact rather than an
	// assumption about shared code.
	"live-hls-ts-muxed",
	// The live half of the mixed-codec DASH rule (#204 shipped the VOD half and
	// recorded live as a separate slice). Paid
	// case F — H264+H265 on one live channel — got provider 400 on the FIRST
	// H265 representation added to the single `aset-video`. This is the ONLY
	// live fixture with more than one video codec, so it is the only one whose
	// golden can hold `aset-video-h264` and `aset-video-h265`; the other
	// fourteen prove the single-codec path is byte-identical.
	"live-mixed-codec-dash",
];
