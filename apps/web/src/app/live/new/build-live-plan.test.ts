import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
	liveBasePath,
	streamKeyManagedByIngestPoint,
	withMslStreamFormat,
} from "./build-live-plan";
import { planToLiveWizardState } from "./live-plan-to-wizard";

const fixturesDir = join(
	__dirname,
	"../../../../../../packages/core/src/live/__fixtures__",
);

function loadFixture(name: string) {
	return JSON.parse(
		readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8"),
	);
}

/** Parse both sides so schema defaults materialize identically. */
function expectGolden(state: LiveWizardState, fixture: string) {
	const built = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	expect(built).toEqual(liveChannelPlanSchema.parse(loadFixture(fixture)));
	// The acceptance bar is a CLEAN reproduction — no validator errors.
	expect(validateLiveChannel(built).filter((i) => i.level === "error")).toEqual(
		[],
	);
}

const S3_CREDENTIAL = "00000000-0000-4000-8000-000000000002";
const SRT_CREDENTIAL = "00000000-0000-4000-8000-000000000003";
const ZIXI_CREDENTIAL = "00000000-0000-4000-8000-000000000004";
const POIS_CREDENTIAL = "00000000-0000-4000-8000-0000000000e5";

function baseState(partial: Partial<LiveWizardState>): LiveWizardState {
	return {
		...DEFAULT_LIVE_WIZARD_STATE,
		// The golden fixtures are pinned to the pre-rev434 defaults; the wizard
		// default itself (AKAMAI_JP_OSA / BETA) is asserted separately below.
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		...partial,
	};
}

describe("buildLiveChannelPlan goldens (deep-equal against live fixtures)", () => {
	it("reproduces live-rtmp-simple from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live RTMP Channel (live-rtmp-simple)",
				inputKind: "RTMP",
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-rtmp-simple",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 1080,
						bitrate: 4_500_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 360,
						bitrate: 800_000,
						presetConfiguration: "LIVE_STANDARD",
					},
				],
				audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 7200,
						liveEdgeOffset: 18,
						insertProgramDateTime: true,
					},
					dash: {
						enabled: true,
						manifestName: "",
						audioLanguage: "",
						representationType: "TEMPLATE",
						timeshift: 7200,
						suggestedPresentationDelay: 12_000,
						minimumUpdatePeriod: 6_000,
						availabilityStartTimeMode: "ON_FIRST_SEGMENT",
					},
				},
				start: {
					streamKey: "myStreamKey",
					liveEncodingMode: "",
					autoRestart: {
						segmentsWrittenTimeout: 60,
						scheduleExpression: "",
						restartOnEncoderError: true,
					},
					autoShutdown: {
						bytesReadTimeoutSeconds: 3600,
						streamTimeoutMinutes: 720,
					},
					reupload: {},
				},
			}),
			"live-rtmp-simple",
		);
	});

	it("reproduces live-esam-full (P5 PR-3 long tail) from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live ESAM / POIS + Cache-Control Channel (live-esam-full)",
				inputKind: "RTMP",
				//  — the pinned RTMP input id.
				rtmp: { inputId: "00000000-0000-4000-8000-0000000000f6" },
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-esam-full",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 1080,
						bitrate: 4_500_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 360,
						bitrate: 800_000,
						presetConfiguration: "LIVE_STANDARD",
					},
				],
				audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 7200,
						liveEdgeOffset: 18,
						insertProgramDateTime: true,
						// C19: the source MATCHES start.adInsertion.clockSynchronizationMode.
						programDateTimeSettings: {
							source: "SYSTEM_CLOCK",
							placement: { mode: "SECONDS_INTERVAL", interval: 30 },
						},
					},
					dash: {
						enabled: true,
						manifestName: "",
						audioLanguage: "",
						representationType: "TEMPLATE",
						timeshift: 7200,
						suggestedPresentationDelay: 12_000,
						minimumUpdatePeriod: 6_000,
						availabilityStartTimeMode: "ON_FIRST_SEGMENT",
					},
				},
				scte35AdMarkers: true,
				// Every carrier knob at a NON-default value (C14 defaults would be
				// [EXT_X_DATERANGE] / SINGLE_PERIOD / XML_BIN).
				adMarkerOptions: {
					hlsMarkerTypes: ["EXT_X_DATERANGE", "EXT_X_SCTE35"],
					hlsDisablePreannouncing: true,
					dashPeriodOption: "MULTI_PERIOD",
					dashEventStreamSignalling: "XML",
				},
				start: {
					streamKey: "myStreamKey",
					liveEncodingMode: "",
					autoRestart: {
						segmentsWrittenTimeout: 60,
						scheduleExpression: "",
						restartOnEncoderError: true,
					},
					autoShutdown: {
						bytesReadTimeoutSeconds: 3600,
						streamTimeoutMinutes: 720,
					},
					reupload: {},
					esam: {
						poisEndpoint: "https://pois.example.com/esam/signalProcessingEvent",
						acquisitionPointIdentity: "acquisition-point-1",
						zoneIdentity: "zone-east",
						adAvailOffset: -1500,
						poisCredentialId: POIS_CREDENTIAL,
					},
					// All SIX leaves — the golden carries every one, so the DASH
					// family and initSegment are exercised end-to-end (review
					// catch M3: they had no positive assertion anywhere).
					cacheControl: {
						hls: {
							multiVariantPlaylist: { cacheControl: "public, max-age=60" },
							variantPlaylist: { cacheControl: "public, max-age=2" },
						},
						dash: {
							timelineManifest: { cacheControl: "public, max-age=1" },
							templateManifest: { cacheControl: "public, max-age=4" },
						},
						segments: {
							initSegment: {
								cacheControl: "public, max-age=31536000, immutable",
							},
							mediaSegment: {
								cacheControl: "public, max-age=31536000, immutable",
							},
						},
					},
					adInsertion: {
						enableEsamMediaPointInsertion: true,
						clockSynchronizationMode: "SYSTEM_CLOCK",
					},
				},
			}),
			"live-esam-full",
		);
	});

	it("reproduces live-srt-caller from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live SRT Caller Channel (live-srt-caller)",
				inputKind: "SRT",
				srt: {
					name: "SRT Caller Input",
					mode: "CALLER",
					host: "203.0.113.10",
					listenerPort: 2088,
					callerPort: 7000,
					path: "",
					latency: 150,
					credentialId: SRT_CREDENTIAL,
					keyLength: 256,
					backups: [],
				},
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-srt-caller",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
					},
				],
				audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 3600,
						insertProgramDateTime: false,
					},
					dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: false },
				},
				start: {
					streamKey: "srtCallerKey",
					liveEncodingMode: "SINGLE_PASS",
					autoRestart: { scheduleExpression: "", restartOnEncoderError: false },
					autoShutdown: {},
					reupload: { muxingInitFileInterval: 300 },
				},
			}),
			"live-srt-caller",
		);
	});

	it("reproduces live-srt-listener (backup inputs) from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live SRT Listener Channel (live-srt-listener)",
				inputKind: "SRT",
				srt: {
					name: "SRT Listener Input",
					mode: "LISTENER",
					host: "",
					listenerPort: 2088,
					path: "",
					latency: 120,
					credentialId: SRT_CREDENTIAL,
					keyLength: 128,
					backupDelayThreshold: 15,
					backups: [
						{
							mode: "LISTENER",
							host: "",
							port: 2089,
							credentialId: "",
							keyLength: 256,
						},
					],
				},
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-srt-listener",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 360,
						bitrate: 800_000,
						presetConfiguration: "LIVE_STANDARD",
					},
				],
				audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 10_800,
						insertProgramDateTime: false,
					},
					dash: {
						enabled: true,
						manifestName: "",
						audioLanguage: "",
						representationType: "TEMPLATE",
						timeshift: 10_800,
						availabilityStartTimeMode: "",
					},
				},
				start: {
					streamKey: "srtListenerKey",
					liveEncodingMode: "",
					autoRestart: { scheduleExpression: "", restartOnEncoderError: false },
					autoShutdown: { waitingForFirstConnectTimeoutMinutes: 30 },
					reupload: {},
				},
			}),
			"live-srt-listener",
		);
	});

	it("reproduces live-zixi (TS muxings) from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live Zixi Channel (live-zixi)",
				inputKind: "ZIXI",
				zixi: {
					name: "",
					host: "zixi-feeder.example.com",
					port: 2077,
					stream: "channelOne",
					credentialId: ZIXI_CREDENTIAL,
					latency: 4000,
					minBitrate: 800_000,
					decryptionType: "AES_128",
				},
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-zixi",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
						container: "TS",
					},
				],
				audios: [
					{ codec: "AAC", bitrate: 128_000, rate: 48_000, container: "TS" },
				],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 7200,
						insertProgramDateTime: false,
					},
					dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: false },
				},
				start: {
					streamKey: "zixiStreamKey",
					liveEncodingMode: "",
					autoRestart: { scheduleExpression: "", restartOnEncoderError: false },
					autoShutdown: {},
					reupload: {},
				},
			}),
			"live-zixi",
		);
	});

	it("reproduces live-redundant-rtmp (dynamic ingest points) from wizard state", () => {
		expectGolden(
			baseState({
				name: "Live Redundant RTMP Channel (live-redundant-rtmp)",
				inputKind: "REDUNDANT_RTMP",
				redundantRtmp: {
					name: "",
					delayThreshold: 12,
					pointsMode: "DYNAMIC",
					ingestPoints: [
						{ applicationName: "liveA", streamKey: "primaryFeed" },
						{ applicationName: "liveB", streamKey: "backupFeed" },
					],
					staticIngestPoints: [],
				},
				output: {
					publicRead: false,
					credentialId: S3_CREDENTIAL,
					kind: "S3",
					bucket: "sample-output-bucket",
					basePath: "output/live-redundant-rtmp",
					name: "Test S3 Output",
				},
				videos: [
					{
						codec: "H264",
						height: 1080,
						bitrate: 4_500_000,
						presetConfiguration: "LIVE_STANDARD",
					},
					{
						codec: "H264",
						height: 720,
						bitrate: 3_000_000,
						presetConfiguration: "LIVE_STANDARD",
					},
				],
				audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
				manifests: {
					hls: {
						enabled: true,
						manifestName: "",
						audioGroupId: "",
						audioLanguage: "",
						videoMuxingKind: "",
						audioMuxingKind: "",
						timeshift: 3600,
						insertProgramDateTime: false,
					},
					dash: {
						enabled: true,
						manifestName: "",
						audioLanguage: "",
						representationType: "TEMPLATE",
						timeshift: 3600,
						availabilityStartTimeMode: "",
					},
				},
				start: {
					streamKey: "redundantKey",
					liveEncodingMode: "",
					autoRestart: { scheduleExpression: "", restartOnEncoderError: false },
					autoShutdown: {},
					reupload: {},
				},
			}),
			"live-redundant-rtmp",
		);
	});
});

describe("buildLiveChannelPlan shapes", () => {
	it("carries explicit reupload nulls (never re-upload) to the plan", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				start: {
					...DEFAULT_LIVE_WIZARD_STATE.start,
					reupload: { dashManifestInterval: null, muxingInitFileInterval: 60 },
				},
			}),
		);
		expect(plan.start.reupload).toEqual({
			dashManifestInterval: null,
			muxingInitFileInterval: 60,
		});
	});

	it("omits empty option groups so plans stay fixture-minimal", () => {
		const plan = buildLiveChannelPlan(DEFAULT_LIVE_WIZARD_STATE);
		expect(plan.start.autoRestart).toBeUndefined();
		expect(plan.start.autoShutdown).toBeUndefined();
		expect(plan.start.reupload).toBeUndefined();
		expect(plan.bitmovin.accountId).toBeUndefined();
	});

	it("suffixes colliding video keys like the VOD wizard (shared helper)", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				videos: [
					{ codec: "H264", height: 720, bitrate: 3_000_000 },
					{ codec: "H264", height: 720, bitrate: 6_000_000 },
				],
			}),
		);
		expect(plan.renditions.map((r) => r.key)).toEqual([
			"v720_3000k",
			"v720_6000k",
			"a128",
		]);
	});

	it("emits SRT keyLength only alongside a passphrase credential", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				inputKind: "SRT",
				srt: { ...DEFAULT_LIVE_WIZARD_STATE.srt, credentialId: "" },
			}),
		);
		expect(plan.liveInput).not.toHaveProperty("keyLength");
		expect(plan.liveInput).not.toHaveProperty("credentialId");
	});
});

describe("planToLiveWizardState round-trip (live goldens)", () => {
	// The Duplicate-channel inverse: a stored plan rebuilds to an editable
	// wizard state that re-builds byte-for-byte — the acceptance bar for
	// "duplicate a failed channel into the form and retry".
	/**
	 * DERIVED from the fixture directory, not typed out (review-5 I5).
	 *
	 * The comment below the old list said "every live fixture must survive
	 * Duplicate" over a hardcoded SEVEN, while nine exist — so the two fixtures
	 * added after it (`live-static-ingest`, `live-akamai-msl`) were never
	 * round-tripped, and the MSL one is exactly the case where Duplicate was
	 * silently wrong. A list that claims "every" has to be able to count.
	 */
	const names = readdirSync(fixturesDir)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => f.replace(".plan.json", ""))
		.sort();

	it("found the whole live corpus, so this does not pass over a short list", () => {
		// 9→10 : live-pinned-encoder joins the corpus.
		// 10→11 (2026-08-23): live-akamai-msl-storage — storage primary + MSL4
		// as the first live deliveryMirror.
		// 11→12: live-akamai-msl-ts.
		// 13→14 : live-akamai-msl5. This one EARNED its keep
		// on the day it landed — its round-trip failed, and what it proved was
		// that the wizard did not model `mslVersion` at all and emitted MSL4's
		// segment-naming grammar for an MSL5 output. Both were invisible until a
		// fixture asked the form to rebuild an MSL5 plan.
		// 14→15: live-mixed-codec-dash.
		// It earned its keep here too: the first draft named its renditions
		// `v1080-h264`/`v1080-h265` and the round-trip failed, because
		// `videoKeys` disambiguates on HEIGHT and not on codec. The ladder now
		// mirrors the VOD `mixed-codec-dash-hls` shape (H265 1080/720, H264
		// 540/360), which is both wizard-reachable and unique per height — a
		// mixed-codec ladder sharing one height across two codecs would derive
		// the SAME key twice, which no live fixture exercises today.
		expect(names.length).toBe(15);
		expect(names).toContain("live-akamai-msl");
		expect(names).toContain("live-akamai-msl-storage");
	});

	for (const name of names) {
		it(`rebuilds ${name} byte-for-byte`, () => {
			const fixture = liveChannelPlanSchema.parse(loadFixture(name));
			const rebuilt = liveChannelPlanSchema.parse(
				buildLiveChannelPlan(planToLiveWizardState(fixture)),
			);
			expect(rebuilt).toEqual(fixture);
		});
	}

	it("preserves the real account, credential and stream key for editing", () => {
		// Duplicate is edit-and-retry, NOT scrub — real ids must survive so the
		// user can tweak (e.g. fix the account/org) rather than re-enter everything.
		const raw = loadFixture("live-rtmp-simple");
		const withAccount = {
			...raw,
			bitmovin: {
				...raw.bitmovin,
				accountId: "11111111-2222-4333-8444-555555555555",
			},
		};
		const state = planToLiveWizardState(
			liveChannelPlanSchema.parse(withAccount),
		);
		expect(state.accountId).toBe("11111111-2222-4333-8444-555555555555");
		expect(state.output.credentialId).toBe(raw.outputs[0].credentialId);
		expect(state.start.streamKey).toBe(raw.start.streamKey);
		// …and it still round-trips with the injected account.
		expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(state))).toEqual(
			liveChannelPlanSchema.parse(withAccount),
		);
	});
});

describe("planToLiveWizardState inverse — branches beyond the goldens", () => {
	// state → plan → inverse → plan must stay stable for branches the 5 goldens
	// don't exercise (all probed as round-tripping; these pin them vs regression).
	const startKey = {
		...DEFAULT_LIVE_WIZARD_STATE.start,
		streamKey: "branchKey",
	};
	const s3 = (basePath: string): LiveWizardState["output"] => ({
		credentialId: S3_CREDENTIAL,
		publicRead: false,
		kind: "S3",
		bucket: "sample-output-bucket",
		basePath,
		name: "Test S3 Output",
	});
	function roundTripsViaInverse(state: LiveWizardState) {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
	}

	it("REDUNDANT_RTMP static ingest points (GENERATE + ASSIGN)", () => {
		roundTripsViaInverse(
			baseState({
				name: "static",
				inputKind: "REDUNDANT_RTMP",
				redundantRtmp: {
					name: "",
					pointsMode: "STATIC",
					ingestPoints: [],
					staticIngestPoints: [
						{ name: "pointA", streamKeyType: "GENERATE", streamKeyId: "" },
						{
							name: "pointB",
							streamKeyType: "ASSIGN",
							streamKeyId: "00000000-0000-4000-8000-000000000099",
						},
					],
				},
				output: s3("output/static"),
				start: startKey,
			}),
		);
	});

	it("HLS input kind with ad markers", () => {
		roundTripsViaInverse(
			baseState({
				name: "hls-in",
				inputKind: "HLS",
				hlsIn: {
					name: "HLS In",
					url: "https://example.com/live.m3u8",
					adMarkersSource: "MANIFEST",
				},
				output: s3("output/hls-in"),
				start: startKey,
			}),
		);
	});

	it("AZURE output (container) and SFTP output (no bucket)", () => {
		roundTripsViaInverse(
			baseState({
				name: "az",
				output: {
					publicRead: false,
					credentialId: "00000000-0000-4000-8000-000000000005",
					kind: "AZURE",
					bucket: "my-container",
					basePath: "output/az",
					name: "Azure Out",
				},
				start: startKey,
			}),
		);
		roundTripsViaInverse(
			baseState({
				name: "sftp",
				output: {
					publicRead: false,
					credentialId: "00000000-0000-4000-8000-000000000006",
					kind: "SFTP",
					bucket: "",
					basePath: "output/sftp",
					name: "SFTP Out",
				},
				start: startKey,
			}),
		);
	});

	it("DASH representationType TIMELINE", () => {
		roundTripsViaInverse(
			baseState({
				name: "timeline",
				output: s3("output/timeline"),
				manifests: {
					hls: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.hls, enabled: true },
					dash: {
						...DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
						enabled: true,
						representationType: "TIMELINE",
						timeshift: 3600,
					},
				},
				start: startKey,
			}),
		);
	});

	it("SCTE-35 ad markers on (C14) round-trips and emits adMarkers.scte35", () => {
		const state = baseState({
			name: "scte35",
			output: s3("output/scte35"),
			scte35AdMarkers: true,
			start: startKey,
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		// The flag surfaces as the plan-root toggle…
		expect(plan.adMarkers).toEqual({ scte35: true });
		// …and the inverse recovers it so the duplicate stays checked.
		expect(planToLiveWizardState(plan).scte35AdMarkers).toBe(true);
		roundTripsViaInverse(state);
	});

	it("SCTE-35 off prunes adMarkers entirely (default plans stay minimal)", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				name: "no-scte",
				output: s3("output/no-scte"),
				start: startKey,
			}),
		);
		expect(plan.adMarkers).toBeUndefined();
		expect("adMarkers" in plan).toBe(false);
	});

	it("explicit-null reupload (never re-upload) via the inverse", () => {
		roundTripsViaInverse(
			baseState({
				name: "nulls",
				output: s3("output/nulls"),
				start: {
					...startKey,
					reupload: { dashManifestInterval: null, muxingInitFileInterval: 60 },
				},
			}),
		);
	});

	it("recovers an explicit manifest name into editable STATE", () => {
		// Default "" and an explicit name BUILD alike, so the plan round-trip is
		// blind here — only a STATE assertion catches a blanked-name regression.
		const built = buildLiveChannelPlan(
			baseState({ name: "named", output: s3("output/named"), start: startKey }),
		);
		const withName = liveChannelPlanSchema.parse({
			...built,
			liveManifests: built.liveManifests.map((m) =>
				m.kind === "HLS" ? { ...m, manifestName: "stream.m3u8" } : m,
			),
		});
		expect(planToLiveWizardState(withName).manifests.hls.manifestName).toBe(
			"stream.m3u8",
		);
	});

	it("staticIpId + labels + infrastructure emit into bitmovin and round-trip", () => {
		const state = baseState({
			name: "infra-ops",
			output: s3("output/infra-ops"),
			start: startKey,
			staticIpId: "00000000-0000-4000-8000-0000000000ee",
			labels: ["campaign-a", "uhd"],
			infrastructure: {
				infrastructureId: "00000000-0000-4000-8000-0000000000aa",
				cloudRegion: "EU_WEST_1",
			},
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.bitmovin.staticIpId).toBe(
			"00000000-0000-4000-8000-0000000000ee",
		);
		expect(plan.bitmovin.labels).toEqual(["campaign-a", "uhd"]);
		expect(plan.bitmovin.infrastructure).toEqual({
			infrastructureId: "00000000-0000-4000-8000-0000000000aa",
			cloudRegion: "EU_WEST_1",
		});
		// The inverse reads them back into editable state…
		const reread = planToLiveWizardState(plan);
		expect(reread.staticIpId).toBe("00000000-0000-4000-8000-0000000000ee");
		expect(reread.labels).toEqual(["campaign-a", "uhd"]);
		expect(reread.infrastructure).toEqual({
			infrastructureId: "00000000-0000-4000-8000-0000000000aa",
			cloudRegion: "EU_WEST_1",
		});
		// …and the rebuild is byte-identical.
		roundTripsViaInverse(state);
	});

	it("absent P5 PR-3 long-tail fields emit NO plan keys", () => {
		// The byte-identity guarantee for the pre-P5 goldens: an untouched wizard
		// must not grow a single new key.
		const plan = buildLiveChannelPlan(
			baseState({
				name: "no-long-tail",
				output: s3("output/no-long-tail"),
				start: startKey,
			}),
		);
		expect("esam" in plan.start).toBe(false);
		expect("cacheControl" in plan.start).toBe(false);
		expect("adInsertion" in plan.start).toBe(false);
		expect("inputId" in plan.liveInput).toBe(false);
		expect("adMarkers" in plan).toBe(false);
		const hls = plan.liveManifests.find((m) => m.kind === "HLS");
		expect(hls && "programDateTimeSettings" in hls).toBe(false);
	});

	it("clears each signaling group back to NO key when its fields are emptied", () => {
		// The forms collapse a group to undefined, but a leaf blanked to "" (or a
		// group left as {}) must prune too — otherwise a strict-schema parse fails.
		const plan = buildLiveChannelPlan(
			baseState({
				name: "cleared",
				output: s3("output/cleared"),
				start: {
					...startKey,
					esam: { poisEndpoint: "", zoneIdentity: "" },
					cacheControl: {
						hls: { multiVariantPlaylist: { cacheControl: "" } },
						segments: {},
					},
					adInsertion: {},
				},
				manifests: {
					hls: {
						...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
						enabled: true,
						programDateTimeSettings: {},
					},
					dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: false },
				},
				scte35AdMarkers: true,
				adMarkerOptions: { hlsMarkerTypes: [] },
			}),
		);
		expect("esam" in plan.start).toBe(false);
		expect("cacheControl" in plan.start).toBe(false);
		expect("adInsertion" in plan.start).toBe(false);
		const hls = plan.liveManifests.find((m) => m.kind === "HLS");
		expect(hls && "programDateTimeSettings" in hls).toBe(false);
		// The gate stays on, but an emptied marker list means "C14 defaults".
		expect(plan.adMarkers).toEqual({ scte35: true });
		// …and it still parses (strict schemas reject "" / empty arrays).
		expect(() => liveChannelPlanSchema.parse(plan)).not.toThrow();
	});

	it("keeps a partially-filled cache-control tree and prunes only the blank leaves", () => {
		const state = baseState({
			name: "cc-partial",
			output: s3("output/cc-partial"),
			start: {
				...startKey,
				cacheControl: {
					hls: {
						multiVariantPlaylist: { cacheControl: "public, max-age=60" },
						variantPlaylist: { cacheControl: "" },
					},
					dash: { timelineManifest: { cacheControl: "" } },
					segments: {
						initSegment: { cacheControl: "public, max-age=31536000" },
					},
				},
			},
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.start.cacheControl).toEqual({
			hls: { multiVariantPlaylist: { cacheControl: "public, max-age=60" } },
			segments: { initSegment: { cacheControl: "public, max-age=31536000" } },
		});
		roundTripsViaInverse(state);
	});

	it("emits a pinned RTMP inputId and round-trips it (ledger #6)", () => {
		const state = baseState({
			name: "rtmp-pinned",
			output: s3("output/rtmp-pinned"),
			start: startKey,
			//  flipped the DEFAULT to static REDUNDANT_RTMP — this
			// test pins the plain-RTMP branch, so it now says so explicitly.
			inputKind: "RTMP",
			rtmp: { inputId: "00000000-0000-4000-8000-0000000000f6" },
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.liveInput).toEqual({
			key: "main",
			kind: "RTMP",
			inputId: "00000000-0000-4000-8000-0000000000f6",
		});
		expect(planToLiveWizardState(plan).rtmp.inputId).toBe(
			"00000000-0000-4000-8000-0000000000f6",
		);
		roundTripsViaInverse(state);
		// The inverse of an unpinned plan leaves the field blank (no key on rebuild).
		const unpinned = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(
				baseState({
					name: "rtmp-unpinned",
					output: s3("output/rtmp-unpinned"),
					start: startKey,
				}),
			),
		);
		expect(planToLiveWizardState(unpinned).rtmp.inputId).toBe("");
	});

	it("keeps marker knobs INSIDE the gate — options alone never reach a plan", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				name: "knobs-gated",
				output: s3("output/knobs-gated"),
				start: startKey,
				scte35AdMarkers: false,
				adMarkerOptions: {
					hlsMarkerTypes: ["EXT_X_SCTE35"],
					dashPeriodOption: "MULTI_PERIOD",
				},
			}),
		);
		expect("adMarkers" in plan).toBe(false);
	});

	it("reads a scte35-only plan back with NO marker options (old plans unchanged)", () => {
		const plan = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(
				baseState({
					name: "scte-only",
					output: s3("output/scte-only"),
					start: startKey,
					scte35AdMarkers: true,
				}),
			),
		);
		expect(plan.adMarkers).toEqual({ scte35: true });
		const reread = planToLiveWizardState(plan);
		expect(reread.scte35AdMarkers).toBe(true);
		expect(reread.adMarkerOptions).toBeUndefined();
	});

	it("round-trips PDT placement modes (incl. the interval the refine requires)", () => {
		for (const placement of [
			{ mode: "ONCE_PER_PLAYLIST" as const },
			{ mode: "SEGMENTS_INTERVAL" as const, interval: 5 },
			{ mode: "SECONDS_INTERVAL" as const, interval: 30 },
		]) {
			const state = baseState({
				name: "pdt",
				output: s3("output/pdt"),
				start: startKey,
				manifests: {
					hls: {
						...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
						enabled: true,
						insertProgramDateTime: true,
						programDateTimeSettings: { source: "EMBEDDED", placement },
					},
					dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: false },
				},
			});
			const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
			const hls = plan.liveManifests.find((m) => m.kind === "HLS");
			expect(hls?.kind === "HLS" && hls.programDateTimeSettings).toEqual({
				source: "EMBEDDED",
				placement,
			});
			roundTripsViaInverse(state);
		}
	});

	it("absent staticIp/labels/infrastructure emit NO bitmovin keys", () => {
		const plan = buildLiveChannelPlan(
			baseState({
				name: "no-infra",
				output: s3("output/no-infra"),
				start: startKey,
			}),
		);
		expect("staticIpId" in plan.bitmovin).toBe(false);
		expect("labels" in plan.bitmovin).toBe(false);
		expect("infrastructure" in plan.bitmovin).toBe(false);
		// Empty labels are pruned too (only non-empty arrays emit).
		const empty = buildLiveChannelPlan(
			baseState({
				name: "no-infra",
				output: s3("output/no-infra"),
				start: startKey,
				labels: [],
			}),
		);
		expect("labels" in empty.bitmovin).toBe(false);
		// The inverse of a plain plan leaves the optional state fields unset.
		const reread = planToLiveWizardState(liveChannelPlanSchema.parse(plan));
		expect(reread.staticIpId).toBeUndefined();
		expect(reread.labels).toBeUndefined();
		expect(reread.infrastructure).toBeUndefined();
	});
});

describe("public-read ACL", () => {
	/**
	 * Until this field existed, derivation rule 2 could never fire for a live
	 * channel: the plan schema has always supported `destination.acl` but the
	 * live wizard had no control for it, so every channel was PRIVATE and the
	 * only route to a playable URL was `publicBaseUrls` on the credential.
	 */
	function planFrom(publicRead: boolean) {
		const state: LiveWizardState = {
			...DEFAULT_LIVE_WIZARD_STATE,
			name: "acl-check",
			// A parseable plan needs a valid stream key; the default is blank.
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "aclCheckKey" },
			output: {
				credentialId: S3_CREDENTIAL,
				publicRead,
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath: "output/acl-check",
				name: "",
			},
		};
		return buildLiveChannelPlan(state);
	}

	it("marks BOTH the manifests and the segments public", () => {
		// A public manifest over private segments fails after the manifest loads,
		// which is the confusing half of this class of misconfiguration.
		const plan = planFrom(true);
		for (const manifest of plan.liveManifests ?? []) {
			expect(manifest.destination?.acl, `manifest ${manifest.key}`).toBe(
				"PUBLIC_READ",
			);
		}
		expect((plan.muxings ?? []).length).toBeGreaterThan(0);
		for (const muxing of plan.muxings ?? []) {
			expect(muxing.destination?.acl, `muxing ${muxing.key}`).toBe(
				"PUBLIC_READ",
			);
		}
	});

	it("emits no acl key at all when the box is unchecked", () => {
		const plan = planFrom(false);
		for (const manifest of plan.liveManifests ?? []) {
			expect(manifest.destination).not.toHaveProperty("acl");
		}
		for (const muxing of plan.muxings ?? []) {
			expect(muxing.destination).not.toHaveProperty("acl");
		}
	});

	it("round-trips through the importer", () => {
		// The live wizard has a round-trip gate like VOD's; a field the importer
		// drops would push every public channel down the imported-plan path.
		const plan = planFrom(true);
		const state = planToLiveWizardState(liveChannelPlanSchema.parse(plan));
		expect(state.output.publicRead).toBe(true);
		const off = planToLiveWizardState(
			liveChannelPlanSchema.parse(planFrom(false)),
		);
		expect(off.output.publicRead).toBe(false);
	});
});

/**
 * static RTMPS ingest is the RECOMMENDED DEFAULT — the pushable
 * URL exists from creation. This pins the flip so it cannot silently revert;
 * per-IP RTMP and SRT stay one select away (their tests say inputKind
 * explicitly since this landed).
 */
describe("the default input is static RTMPS (ledger #114)", () => {
	it("DEFAULT state builds a REDUNDANT_RTMP plan with one GENERATE static point", () => {
		const state = baseState({
			name: "default-static",
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				publicRead: false,
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath: "output/default-static",
				name: "Test S3 Output",
			},
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "skdefault" },
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.liveInput.kind).toBe("REDUNDANT_RTMP");
		if (plan.liveInput.kind !== "REDUNDANT_RTMP") {
			throw new Error("narrowed above");
		}
		expect(plan.liveInput.ingestPoints).toBeUndefined();
		/*
		 * NAMED, and that is  (owner decision (b), 2026-08-21).
		 * This assertion used to pin the nameless shape — which our schema
		 * accepts and Bitmovin refuses with "One or more fields are not
		 * present or invalid (code 1000)", measured on the real API. The
		 * default state is born with "primary" so the plan a fresh operator
		 * submits can actually provision.
		 */
		expect(plan.liveInput.staticIngestPoints).toEqual([
			{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
		]);
	});

	it("the DEFAULT STATE itself carries the name — not only the builder", () => {
		// The builder fallback makes a cleared default invisible at the plan
		// level (clearing it still emits "primary"), so this pins the STATE:
		// the form input an operator first sees must show the name, or the
		// field reads as something they are being asked to invent.
		expect(
			DEFAULT_LIVE_WIZARD_STATE.redundantRtmp.staticIngestPoints[0]?.name,
		).toBe("primary");
	});

	it("a CLEARED static-point name still emits a named point (ledger #150)", () => {
		// The form defaults are the ordinary shield; imported state, presets
		// and hand-cleared fields all reach the builder too. A nameless point
		// is a measured code-1000 refusal reported against no field the
		// operator can see — so the builder itself is the last line.
		const state = baseState({
			name: "cleared-name",
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				publicRead: false,
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath: "output/cleared-name",
				name: "Test S3 Output",
			},
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "skcleared" },
			redundantRtmp: {
				...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
				staticIngestPoints: [
					{ name: "", streamKeyType: "GENERATE", streamKeyId: "" },
					{ name: "  ", streamKeyType: "GENERATE", streamKeyId: "" },
					{ name: "mine", streamKeyType: "GENERATE", streamKeyId: "" },
				],
			},
		});
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		if (plan.liveInput.kind !== "REDUNDANT_RTMP") {
			throw new Error("narrowed above");
		}
		expect(
			plan.liveInput.staticIngestPoints?.map((point) => point.name),
		).toEqual(["primary", "backup", "mine"]);
	});
});

describe("an MSL channel built from FORM state (ledger #137)", () => {
	/**
	 * Remodelled 2026-08-19 on the owner's call: the stream id and event name
	 * are a CREDENTIAL, because neither can be obtained without an Akamai
	 * account. What that bought is visible here — there is no destination
	 * selector, no state union and no bespoke fields component left to test.
	 * An MSL channel is "pick a credential" like every other output, plus the
	 * delivery format, which is a plan choice because it constrains the ladder.
	 */
	const CRED = "00000000-0000-4000-8000-000000000003";

	function mslState(
		streamFormat: "DASH" | "HLS" | "CMAF" = "HLS",
	): LiveWizardState {
		const base = withMslStreamFormat(DEFAULT_LIVE_WIZARD_STATE, streamFormat);
		return {
			...base,
			name: "akamai channel",
			start: { ...base.start, streamKey: "myStreamKey" },
			output: {
				...base.output,
				kind: "AKAMAI_MSL" as const,
				credentialId: CRED,
				mslStreamFormat: streamFormat,
			},
		};
	}

	it("publishes the manifest at the EVENT ROOT and keeps the channel folder as the segments' prefix (re-audit BLOCKER-5, ledger #220)", () => {
		// The normal wizard used to send `output/<name>` as the MSL manifest
		// path; the MSL4 contract wants "" or `/…/`, and the edge served 404
		// for every segment the master referenced. Segments still carry the
		// run-specific folder, which is what keeps two airings apart.
		const initial = mslState();
		const state = {
			...initial,
			output: { ...initial.output, basePath: "output/akamai-channel" },
		};
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.liveManifests.length).toBeGreaterThan(0);
		for (const m of plan.liveManifests) {
			expect(m.destination.path).toBe("");
		}
		const base = liveBasePath(state);
		expect(base).not.toBe("");
		for (const m of plan.muxings) {
			expect(m.destination?.path.startsWith(`${base}/`)).toBe(true);
		}
		expect(
			validateLiveChannel(plan).filter(
				(i) => i.code === "LIVE_MSL_MANIFEST_PATH",
			),
		).toEqual([]);
	});

	it("emits a credential reference and the format, and NO identity", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(mslState()));
		expect(plan.outputs).toHaveLength(1);
		expect(plan.outputs[0]).toMatchObject({
			key: "origin",
			kind: "AKAMAI_MSL",
			credentialId: CRED,
			streamFormat: "HLS",
			mslVersion: "MSL4",
		});
		// The identity is vault material now. A plan carrying it would be the
		// old model, and would put one customer's provisioned stream into
		// anything that copies plans around (templates, presets, snapshots).
		expect(plan.outputs[0]).not.toHaveProperty("streamId");
		expect(plan.outputs[0]).not.toHaveProperty("eventName");
		// And no bucket: MSL addresses a stream, not a container.
		expect(plan.outputs[0]).not.toHaveProperty("bucket");
	});

	it("is C31-clean for every format the operator can pick", () => {
		// "Selectable" has to mean usable: each format must build a plan the
		// validator accepts, or the option is present and broken.
		for (const streamFormat of ["HLS", "DASH", "CMAF"] as const) {
			const plan = liveChannelPlanSchema.parse(
				buildLiveChannelPlan(mslState(streamFormat)),
			);
			expect(
				validateLiveChannel(plan).filter((i) => i.code === "C31"),
				`${streamFormat} must be C31-clean`,
			).toEqual([]);
		}
	});

	it("reports a format that disagrees with the ladder, naming the output", () => {
		// The safety net behind the automation: a format changed WITHOUT the
		// ladder following — a pasted plan, or a later hand-edit.
		const state = mslState("HLS");
		const plan = liveChannelPlanSchema.parse(
			buildLiveChannelPlan({
				...state,
				output: { ...state.output, mslStreamFormat: "DASH" as const },
			}),
		);
		const issues = validateLiveChannel(plan).filter((i) => i.code === "C31");
		expect(issues.length).toBeGreaterThan(0);
		expect(issues.map((i) => i.message).join(" ")).toMatch(
			/needs FMP4 or CMAF muxings/,
		);
		expect(issues[0]?.message).toMatch(/"origin"/);
	});

	it("a rendition added after the format still reaches a playlist", () => {
		// review-7 Critical 1, carried across the remodel: the wizard sets no
		// muxing-kind pin, so a rung added later is selected rather than
		// silently dropped from the playlist while still being encoded.
		const state = mslState("HLS");
		expect(state.manifests.hls.videoMuxingKind).toBe("");
		const plan = liveChannelPlanSchema.parse(
			buildLiveChannelPlan({
				...state,
				// Exactly what ladder-section's "Add video" pushes: no container.
				videos: [
					...state.videos,
					{ codec: "H264", height: 1080, bitrate: 1_500_000 },
				],
			}),
		);
		const issues = validateLiveChannel(plan);
		expect(issues.map((i) => i.code)).not.toContain("LIVE_MUXING_UNREFERENCED");
		const c31 = issues.filter((i) => i.code === "C31");
		expect(c31.length).toBeGreaterThan(0);
		expect(c31[0]?.message).toMatch(/"origin"/);
	});
});

describe("rev433: the start request's stream key on a static-ingest channel", () => {
	it("is filled with a deterministic, schema-valid placeholder when the wizard left it empty", () => {
		const state: LiveWizardState = {
			...DEFAULT_LIVE_WIZARD_STATE,
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "" },
		};
		expect(streamKeyManagedByIngestPoint(state)).toBe(true);
		const plan = buildLiveChannelPlan(state);
		expect(plan.start?.streamKey).toBe("autoprimary");
		expect(plan.start?.streamKey).toMatch(/^[a-zA-Z]{3,20}$/);
	});

	it("keeps an explicit key, and asks for one on DYNAMIC ingest points", () => {
		const explicit = buildLiveChannelPlan({
			...DEFAULT_LIVE_WIZARD_STATE,
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "mine" },
		});
		expect(explicit.start?.streamKey).toBe("mine");
		const dynamic: LiveWizardState = {
			...DEFAULT_LIVE_WIZARD_STATE,
			redundantRtmp: {
				...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
				pointsMode: "DYNAMIC",
			},
		};
		expect(streamKeyManagedByIngestPoint(dynamic)).toBe(false);
	});
});

describe("rev434: the live wizard's defaults", () => {
	it("start a new channel on Akamai Osaka with the BETA encoder line", () => {
		expect(DEFAULT_LIVE_WIZARD_STATE.cloudRegion).toBe("AKAMAI_JP_OSA");
		expect(DEFAULT_LIVE_WIZARD_STATE.encoderVersion).toBe("BETA");
		const plan = buildLiveChannelPlan(DEFAULT_LIVE_WIZARD_STATE);
		expect(plan.bitmovin).toMatchObject({
			cloudRegion: "AKAMAI_JP_OSA",
			encoderVersion: "BETA",
		});
	});
});
