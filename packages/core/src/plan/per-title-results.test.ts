import { describe, expect, it, vi } from "vitest";
import { redactSecrets } from "../crypto/redact";
import { compilePlan } from "./compiler";
import {
	attributeResult,
	bitmovinCapturePort,
	CODEC_CONFIG_API_PATH,
	capturePerTitleResults,
	groupPerTitleResults,
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_CAPTURE_STEP,
	PER_TITLE_RESULT_MODE,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleCaptureOutcome,
	type PerTitleCapturePort,
	type PerTitleResultStream,
	type PerTitleResultsSnapshot,
	perTitleCaptureOutcomeSchema,
	perTitleResultsSnapshotSchema,
	perTitleResultsView,
	perTitleTemplates,
	planHasPerTitle,
	type ScannedMuxing,
	type ScannedStream,
	type TemplateStreamRef,
	templateStreamRefSchema,
} from "./per-title-results";
import { encodingPlanSchema, renditionSchema } from "./schema";
import { loadPlan, vodPlanNames } from "./test-support";
import { validatePlan } from "./validate";

const planNames = vodPlanNames();

const CAPTURED_AT = "2026-08-11T00:00:00.000Z";

/** A port whose three reads are declared inline, per test. */
function port(
	overrides: Partial<PerTitleCapturePort> = {},
): PerTitleCapturePort {
	return {
		listStreams: vi.fn(() => Promise.resolve({ items: [], complete: true })),
		listMuxings: vi.fn(() => Promise.resolve({ items: [], complete: true })),
		getCodecConfig: vi.fn(() => Promise.resolve(null)),
		...overrides,
	};
}

function streams(...items: ScannedStream[]) {
	return () => Promise.resolve({ items, complete: true });
}

function muxings(...items: ScannedMuxing[]) {
	return () => Promise.resolve({ items, complete: true });
}

const T = (rendition: string, codec: string): TemplateStreamRef => ({
	rendition,
	codec,
});

const fixedTemplate = (
	rendition: string,
	codec: "H264" | "H265",
	height: number,
	settings: {
		minBitrate: number;
		maxBitrate: number;
		bitrateSelectionMode: "COMPLEXITY_RANGE";
		lowComplexityBoundaryForMaxBitrate: number;
		highComplexityBoundaryForMaxBitrate: number;
	},
): TemplateStreamRef =>
	({
		rendition,
		codec,
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		height,
		perTitleSettings: { fixedResolutionAndBitrateSettings: settings },
	}) as TemplateStreamRef;

describe("fixed-resolution template attribution", () => {
	const template = () =>
		templateStreamRefSchema.parse({
			rendition: "v720",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			height: 720,
			outputPathPatterns: ["output/video/v720/{height}p_{bitrate}_{uuid}/"],
		});
	const result = {
		codecType: "H264",
		appliedSettings: { height: 720 },
		muxings: [
			{
				muxingType: "FMP4",
				outputs: [{ outputPath: "output/video/v720/720p_1500000_result/" }],
			},
		],
	};

	it("attributes by the unique output path, codec and pinned height beside a flexible template", () => {
		expect(
			attributeResult(result, [
				template(),
				{
					rendition: "flexible",
					codec: "H264",
					mode: "PER_TITLE_TEMPLATE",
					outputPathPatterns: [
						"output/video/flexible/{height}p_{bitrate}_{uuid}/",
					],
				},
			]),
		).toBe("v720");
	});

	it("abstains when the path matches but height is missing or differs", () => {
		expect(
			attributeResult({ ...result, appliedSettings: { height: 1080 } }, [
				template(),
			]),
		).toBeUndefined();
		expect(
			attributeResult({ ...result, appliedSettings: undefined }, [template()]),
		).toBeUndefined();
	});

	it("abstains for a codec mismatch or duplicate path witnesses", () => {
		expect(
			attributeResult({ ...result, codecType: "H265" }, [template()]),
		).toBeUndefined();
		expect(
			attributeResult(result, [
				template(),
				{ ...template(), rendition: "other" },
			]),
		).toBeUndefined();
	});

	it("never infers an unmarked fixed-resolution result from height alone", () => {
		expect(
			attributeResult({ ...result, muxings: [] }, [template()]),
		).toBeUndefined();
	});

	it.each([
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	] as const)("abstains for an unmarked result shared by a flexible and %s template", (mode) => {
		for (const flexibleMode of ["PER_TITLE_TEMPLATE", undefined] as const) {
			expect(
				attributeResult({ ...result, muxings: [] }, [
					{ rendition: "flexible", codec: "H264", mode: flexibleMode },
					{ ...template(), mode },
				]),
			).toBeUndefined();
		}
	});
});

describe("per-title capture — the RESULT/TEMPLATE filter", () => {
	it("captures RESULT streams and never TEMPLATE or STANDARD ones", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					{ streamId: "s-tpl", mode: "PER_TITLE_TEMPLATE" },
					{ streamId: "s-res", mode: PER_TITLE_RESULT_MODE },
					{ streamId: "s-std", mode: "STANDARD" },
					{
						streamId: "s-tpl-fixed",
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					},
				),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		// The filter is the whole point: a TEMPLATE row in the capture would show
		// an operator their INTENT under the heading "what the encoder produced".
		expect(snapshot.streams.map((s) => s.streamId)).toEqual(["s-res"]);
		expect(snapshot.scan).toMatchObject({
			streamsListed: 4,
			templatesListed: 2,
			resultsCaptured: 1,
		});
	});

	it("does not list muxings at all when there are no results", async () => {
		// A fixed-ladder encoding that somehow reached the step must not pay for a
		// muxing page it cannot use.
		const listMuxings = vi.fn(() =>
			Promise.resolve({ items: [], complete: true }),
		);
		await capturePerTitleResults(
			port({
				listStreams: streams({ streamId: "s-std", mode: "STANDARD" }),
				listMuxings,
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		expect(listMuxings).not.toHaveBeenCalled();
	});

	it("reports an incomplete scan rather than a short ladder", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: () =>
					Promise.resolve({
						items: [{ streamId: "s-res", mode: PER_TITLE_RESULT_MODE }],
						complete: false,
					}),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		// One rung captured, but we must not let the UI imply the ladder had one
		// rung: `complete` is the difference between "that is all of it" and
		// "that is all we fetched".
		expect(snapshot.scan.complete).toBe(false);
	});

	it("an incomplete MUXING page also makes the scan incomplete", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams({
					streamId: "s-res",
					mode: PER_TITLE_RESULT_MODE,
				}),
				listMuxings: () => Promise.resolve({ items: [], complete: false }),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		expect(snapshot.scan.complete).toBe(false);
	});
});

describe("per-title capture — codec configs", () => {
	it("fetches each distinct config once and joins its params", async () => {
		const getCodecConfig = vi.fn((id: string) =>
			Promise.resolve({
				codecType: "H264",
				params: { bitrate: 4_000_000, id },
			}),
		);
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					{ streamId: "a", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c1" },
					{ streamId: "b", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c1" },
					{ streamId: "c", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c2" },
				),
				getCodecConfig,
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		expect(getCodecConfig).toHaveBeenCalledTimes(2);
		expect(snapshot.streams.map((s) => s.params.bitrate)).toEqual([
			4_000_000, 4_000_000, 4_000_000,
		]);
	});

	it("an unreadable config costs one row's params, not the ladder", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					{ streamId: "a", mode: PER_TITLE_RESULT_MODE, codecConfigId: "boom" },
					{ streamId: "b", mode: PER_TITLE_RESULT_MODE, codecConfigId: "ok" },
				),
				getCodecConfig: (id) =>
					id === "boom"
						? Promise.reject(new Error("500"))
						: Promise.resolve({ codecType: "H264", params: { bitrate: 1 } }),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		expect(snapshot.streams).toHaveLength(2);
		expect(snapshot.streams[0]?.params).toEqual({});
		expect(snapshot.streams[1]?.params).toEqual({ bitrate: 1 });
		// Counted, so `params: {}` is never mistaken for "the encoder set nothing".
		expect(snapshot.scan.codecConfigErrors).toBe(1);
	});

	it("counts every row with no parameters, not every failed config id", async () => {
		// Three blank rungs reported ONE error before: the counter incremented per
		// distinct id and skipped rows with no config id at all, so it could not do
		// the one job it exists for — telling "the read failed" apart from "the
		// encoder set nothing" (review finding).
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					{ streamId: "a", mode: PER_TITLE_RESULT_MODE, codecConfigId: "same" },
					{ streamId: "b", mode: PER_TITLE_RESULT_MODE, codecConfigId: "same" },
					{ streamId: "c", mode: PER_TITLE_RESULT_MODE },
				),
				getCodecConfig: () => Promise.reject(new Error("500")),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		expect(
			snapshot.streams.every((row) => Object.keys(row.params).length === 0),
		).toBe(true);
		expect(snapshot.scan.codecConfigErrors).toBe(3);
	});

	it("every codec the plan schema can emit has a config endpoint mapped", () => {
		// Read OUT OF THE SCHEMA, not written here: a codec added to the plan then
		// has no mapped `get`, and its result rows would silently carry no params.
		const codecs = (
			renditionSchema as unknown as {
				options: Array<{ shape: { codec: { value: string } } }>;
			}
		).options.map((o) => o.shape.codec.value);
		expect(codecs.length).toBeGreaterThanOrEqual(9); // guards the reader itself
		expect(codecs.filter((c) => !(c in CODEC_CONFIG_API_PATH))).toEqual([]);
	});
});

describe("per-title capture — muxing statistics", () => {
	it("joins every muxing of a result stream, by stream id", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams({
					streamId: "s-res",
					mode: PER_TITLE_RESULT_MODE,
					appliedSettings: { width: 1280, height: 720 },
				}),
				listMuxings: muxings(
					{
						muxingId: "m-fmp4",
						muxingType: "FMP4",
						streamIds: ["s-res"],
						avgBitrate: 2_500_000,
						segmentsMuxed: 240,
						outputs: [],
						drm: [],
					},
					{
						muxingId: "m-ts",
						muxingType: "TS",
						streamIds: ["s-res"],
						outputs: [],
						drm: [],
					},
					{
						muxingId: "m-other",
						muxingType: "FMP4",
						streamIds: ["s-else"],
						outputs: [],
						drm: [],
					},
				),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: [] },
		);
		const row = snapshot.streams[0];
		expect(row?.muxings.map((m) => m.muxingId)).toEqual(["m-fmp4", "m-ts"]);
		expect(row?.muxings[0]).toEqual({
			muxingId: "m-fmp4",
			muxingType: "FMP4",
			avgBitrate: 2_500_000,
			segmentsMuxed: 240,
			outputs: [],
			drm: [],
		});
		expect(row?.appliedSettings).toEqual({ width: 1280, height: 720 });
	});
});

describe("per-title attribution — abstains rather than guesses", () => {
	it("matches a result to the sole template of its codec", () => {
		expect(attributeResult({ codecType: "H264" }, [T("v1080", "H264")])).toBe(
			"v1080",
		);
	});

	it("abstains when two templates share the codec", () => {
		expect(
			attributeResult({ codecType: "H264" }, [
				T("v720", "H264"),
				T("v1080", "H264"),
			]),
		).toBeUndefined();
	});

	it("abstains when the codec type could not be read", () => {
		// Without a codec type every template is a candidate, so a plan with more
		// than one cannot be resolved — and a plan with exactly one still can.
		expect(
			attributeResult({}, [T("v720", "H264"), T("v-main10", "H265")]),
		).toBeUndefined();
		expect(attributeResult({}, [T("v720", "H264")])).toBe("v720");
	});

	it("never crosses codecs", () => {
		expect(
			attributeResult({ codecType: "H265" }, [
				T("v720", "H264"),
				T("v-main10", "H265"),
			]),
		).toBe("v-main10");
	});

	it("attributes the single-template ladder that real runs actually produce", () => {
		// Measured: encoding 5babb002… has ONE plain H264 template and SIX results,
		// at 360p/432p/576p/900p and 1080p TWICE. Every one of them came from that
		// template, so the sole-candidate rule gets all six right — and the two
		// identical heights are why matching on `appliedSettings.height` instead
		// would have been unsound.
		for (const height of [360, 432, 576, 900, 1080, 1080]) {
			expect(
				attributeResult({ codecType: "H264" }, [T("pt-video", "H264")]),
				`result at ${height}p`,
			).toBe("pt-video");
		}
	});

	it("returns undefined for a corrupt template list, never a non-string", async () => {
		// The failure the executor's `.catch([])` did NOT cover: `[{rendition: 7}]`
		// parses as an array of objects, so the catch never fires, and a
		// single-element list makes it the sole candidate — the old code returned the
		// NUMBER 7 as a `templateRendition`, which then failed the snapshot schema at
		// persistence time, after the capture had run (review finding).
		expect(
			attributeResult({ codecType: "H264" }, [{ rendition: 7 } as never]),
		).toBeUndefined();
	});

	it("counts what it could not attribute", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					{ streamId: "a", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c" },
					{ streamId: "b", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c" },
				),
				getCodecConfig: () =>
					Promise.resolve({ codecType: "H264", params: {} }),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				// No muxings on these streams (listMuxings defaults empty), so there is
				// no mirror filename to bind — two same-codec templates fall to the
				// codec-only rule, which abstains. Fail closed, not a guess.
				templates: [T("v720", "H264"), T("v1080", "H264")],
			},
		);
		expect(snapshot.scan.unattributed).toBe(2);
		expect(
			snapshot.streams.every((s) => s.templateRendition === undefined),
		).toBe(true);
	});
});

describe("per-title attribution — provider-copied fixed settings (release audit §4.3)", () => {
	const common = {
		bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
		lowComplexityBoundaryForMaxBitrate: 2_160_000,
		highComplexityBoundaryForMaxBitrate: 4_000_000,
	};
	const fixed = [
		fixedTemplate("v360-300", "H264", 360, {
			...common,
			minBitrate: 300_000,
			maxBitrate: 500_000,
		}),
		fixedTemplate("v360-600", "H264", 360, {
			...common,
			minBitrate: 600_000,
			maxBitrate: 900_000,
		}),
	];
	const paidPopulationCases = [
		{
			fixture: "pertitle-h264-fmp4-ts-dash-hls-on-aws",
			codec: "H264",
			results: [
				["v180", 180, undefined],
				["v360-300", 360, [300_000, 500_000, 2_160_000, 4_000_000]],
				["v360-600", 360, [600_000, 900_000, 2_160_000, 4_000_000]],
				["v540", 540, [1_000_000, 1_400_000, 2_160_000, 4_000_000]],
				["v720", 720, [1_800_000, 2_400_000, 2_160_000, 4_000_000]],
				["v1080", 1080, undefined],
			],
		},
		{
			fixture: "pertitle-h265-fmp4-dash-hls-on-aws",
			codec: "H265",
			results: [
				["v180", 180, undefined],
				["v480-210", 480, [210_000, 350_000, 1_500_000, 3_200_000]],
				["v480-420", 480, [420_000, 630_000, 1_500_000, 3_200_000]],
				["v540", 540, [700_000, 980_000, 1_500_000, 3_200_000]],
				["v720", 720, [1_250_000, 1_700_000, 1_500_000, 3_200_000]],
				["v1080", 1080, undefined],
			],
		},
	] as const;

	it("binds the exact fixed template using codec + geometry + every normalized fixed setting", () => {
		const result = {
			codecType: "H264",
			appliedSettings: { width: 640, height: 360 },
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: {
					...common,
					minBitrate: 600_000,
					maxBitrate: 900_000,
				},
			},
			muxings: [{ muxingType: "FMP4" }],
		};
		expect(attributeResult(result as never, fixed)).toBe("v360-600");
	});

	it("does not let the shipped Smooth MP4 delivery filename shadow the exact fixed-settings witness", () => {
		const plan = loadPlan("pertitle-h264-mp4-smooth-drm-on-aws");
		const template = perTitleTemplates(plan).find(
			(candidate) => candidate.rendition === "v360-600",
		);
		expect(template?.perTitleSettings).toBeDefined();
		expect(
			attributeResult(
				{
					codecType: "H264",
					appliedSettings: { height: 360 },
					perTitleSettings: template?.perTitleSettings,
					muxings: [
						{
							muxingType: "MP4",
							filename: "video.ismv",
							drm: [
								{
									outputs: [
										{
											outputPath:
												"output/per-title-h264-aac-mp4-cenc-drm-pr-smooth-aws/video/360p_700000_result/",
										},
									],
								},
							],
						},
					],
				},
				perTitleTemplates(plan),
			),
		).toBe("v360-600");
	});

	it("fails closed when one fixed field differs or two templates are identical", () => {
		const copied = {
			codecType: "H264",
			appliedSettings: { height: 360 },
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: {
					...common,
					minBitrate: 600_000,
					maxBitrate: 900_001,
				},
			},
		};
		expect(attributeResult(copied as never, fixed)).toBeUndefined();

		const exact = {
			...copied,
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: {
					...common,
					minBitrate: 600_000,
					maxBitrate: 900_000,
				},
			},
		};
		expect(
			attributeResult(exact as never, [
				fixed[1] as TemplateStreamRef,
				fixed[1] as TemplateStreamRef,
			]),
		).toBeUndefined();
	});

	it("fails closed when the provider's fixed-settings witness is empty", () => {
		const sparse = {
			rendition: "sparse",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" as const,
			height: 360,
			perTitleSettings: { fixedResolutionAndBitrateSettings: {} },
		};
		expect(
			attributeResult(
				{
					codecType: "H264",
					appliedSettings: { height: 360 },
					perTitleSettings: { fixedResolutionAndBitrateSettings: {} },
				},
				[sparse],
			),
		).toBeUndefined();
	});

	it("never substitutes a path marker for a missing, empty, or mismatched fixed-settings witness", () => {
		const template: TemplateStreamRef = {
			...(fixed[1] as TemplateStreamRef),
			outputPathPatterns: [
				"output/customer/video/v360-600/{height}p_{bitrate}_{uuid}/",
			],
		};
		const marker = {
			codecType: "H264",
			appliedSettings: { height: 360 },
			muxings: [
				{
					muxingType: "FMP4",
					outputs: [
						{
							outputPath:
								"output/customer/video/v360-600/360p_700000_00000000-0000-4000-8000-000000000001/",
						},
					],
				},
			],
		};
		expect(attributeResult(marker, [template])).toBeUndefined();
		expect(
			attributeResult(
				{ codecType: "H264", appliedSettings: { height: 360 }, muxings: [] },
				[template],
			),
		).toBeUndefined();
		expect(
			attributeResult(
				{
					...marker,
					perTitleSettings: { fixedResolutionAndBitrateSettings: {} },
				},
				[template],
			),
		).toBeUndefined();
		expect(
			attributeResult(
				{
					...marker,
					perTitleSettings: {
						fixedResolutionAndBitrateSettings: {
							...common,
							minBitrate: 600_000,
							maxBitrate: 900_001,
						},
					},
				},
				[template],
			),
		).toBeUndefined();
	});

	it.each(
		paidPopulationCases,
	)("attributes all four fixed RESULTs in the paid $codec population and leaves only markerless flexible RESULTs unattributed", async ({
		fixture,
		codec,
		results,
	}) => {
		const resultStreams = results.map(([key, height, settings]) => ({
			streamId: `s-${key}`,
			mode: PER_TITLE_RESULT_MODE,
			codecConfigId: `c-${key}`,
			appliedSettings: { height },
			...(settings
				? {
						perTitleSettings: {
							fixedResolutionAndBitrateSettings: {
								minBitrate: settings[0],
								maxBitrate: settings[1],
								bitrateSelectionMode: "COMPLEXITY_RANGE",
								lowComplexityBoundaryForMaxBitrate: settings[2],
								highComplexityBoundaryForMaxBitrate: settings[3],
							},
						},
					}
				: {}),
		})) as ScannedStream[];
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(...resultStreams),
				listMuxings: muxings(
					...results.map(([key, height]) => ({
						muxingId: `m-${key}`,
						muxingType: "FMP4",
						streamIds: [`s-${key}`],
						outputs: [{ outputPath: `out/${height}p_${key}/video/` }],
						drm: [],
					})),
				),
				getCodecConfig: () => Promise.resolve({ codecType: codec, params: {} }),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates: perTitleTemplates(loadPlan(fixture)),
			},
		);

		const attributed = Object.fromEntries(
			snapshot.streams.map((row) => [row.streamId, row.templateRendition]),
		);
		for (const [key, , settings] of results) {
			expect(attributed[`s-${key}`], key).toBe(settings ? key : undefined);
		}
		expect(snapshot.scan.unattributed).toBe(2);
	});

	it.each(
		paidPopulationCases,
	)("attributes all six non-QC RESULTs in the release $codec population from provider-retained output paths", async ({
		fixture,
		codec,
		results,
	}) => {
		const plan = loadPlan(fixture);
		const templates = perTitleTemplates(plan);
		const patterns = templates.flatMap(
			(template) => template.outputPathPatterns ?? [],
		);
		expect(patterns).toHaveLength(codec === "H264" ? 14 : 7);
		expect(new Set(patterns).size).toBe(patterns.length);
		for (const template of templates) {
			expect(
				template.outputPathPatterns?.every((pattern) =>
					pattern.includes(`/${template.rendition}/`),
				),
			).toBe(true);
		}
		const outputBase =
			codec === "H264"
				? "output/per-title-h264-aac-fmp4-ts-dash-hls-aws/video/dash"
				: "output/per-title-h265-aac-fmp4-dash-hls-aws/video";
		const resultStreams = results.map(([key, height, settings]) => ({
			streamId: `s-${key}`,
			mode: PER_TITLE_RESULT_MODE,
			codecConfigId: `c-${key}`,
			appliedSettings: { height },
			...(settings
				? {
						perTitleSettings: {
							fixedResolutionAndBitrateSettings: {
								minBitrate: settings[0],
								maxBitrate: settings[1],
								bitrateSelectionMode: "COMPLEXITY_RANGE",
								lowComplexityBoundaryForMaxBitrate: settings[2],
								highComplexityBoundaryForMaxBitrate: settings[3],
							},
						},
					}
				: {}),
		})) as ScannedStream[];
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(...resultStreams),
				listMuxings: muxings(
					...results.map(([key, height], index) => ({
						muxingId: `m-${key}`,
						muxingType: "FMP4",
						streamIds: [`s-${key}`],
						outputs: [
							{
								outputPath: `${outputBase}/${key}/${height}p_${250_000 + index * 410_000}_00000000-0000-4000-8000-00000000000${index}/`,
							},
						],
						drm: [],
					})),
				),
				getCodecConfig: () => Promise.resolve({ codecType: codec, params: {} }),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates,
			},
		);

		expect(snapshot.scan.unattributed).toBe(0);
		expect(snapshot.streams.map((row) => row.templateRendition).sort()).toEqual(
			results.map(([key]) => key).sort(),
		);
	});

	it.each(
		paidPopulationCases,
	)("attributes the complete paid $codec RESULT population when VMAF/QC supplies provider-retained filenames", async ({
		fixture,
		codec,
		results,
	}) => {
		const plan = encodingPlanSchema.parse({
			...loadPlan(fixture),
			qc: { vmaf: true },
		});
		const mirrorNames = new Map(
			compilePlan(plan)
				.filter((op) => op.step.startsWith("qc-muxing:"))
				.map((op) => [op.step.slice("qc-muxing:".length), op.payload.filename]),
		);
		expect(mirrorNames.size).toBe(perTitleTemplates(plan).length);

		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					...(results.map(([key, height]) => ({
						streamId: `s-${key}`,
						mode: PER_TITLE_RESULT_MODE,
						codecConfigId: `c-${key}`,
						appliedSettings: { height },
					})) as ScannedStream[]),
				),
				listMuxings: muxings(
					...results.flatMap(([key, height]) => [
						{
							muxingId: `m-${key}`,
							muxingType: "FMP4",
							streamIds: [`s-${key}`],
							outputs: [{ outputPath: `out/${height}p_${key}/video/` }],
							drm: [],
						},
						{
							muxingId: `qc-${key}`,
							muxingType: "MP4",
							filename: mirrorNames.get(key) as string,
							streamIds: [`s-${key}`],
							outputs: [{ outputPath: `out/${height}p_${key}/qc/` }],
							drm: [],
						},
					]),
				),
				getCodecConfig: () => Promise.resolve({ codecType: codec, params: {} }),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates: perTitleTemplates(plan),
			},
		);

		expect(snapshot.scan.unattributed).toBe(0);
		expect(snapshot.streams.map((row) => row.templateRendition).sort()).toEqual(
			results.map(([key]) => key).sort(),
		);
	});
});

/**
 * The fix: a PER_TITLE_RESULT is bound to its
 * template by the QC-mirror FILENAME the compiler stamped with the rendition
 * key (`qcMirrorFilename`), not by codec alone — which abstained on every
 * same-codec ladder and reported a paid run's 6 RESULTs as 0.
 */
describe("per-title attribution — binds on the QC-mirror filename (§5.4)", () => {
	/** A QC-mirror muxing carrying the provider-copied filename. */
	const mirror = (filename: string, muxingType = "MP4") => ({
		muxingType,
		filename,
		outputs: [{ outputPath: "out/result/qc/" }],
		drm: [],
	});
	/** A segmented delivery leg — no filename (fMP4/TS name their segments). */
	const seg = (muxingType = "FMP4") => ({ muxingType });

	const SEVEN = [
		T("v180", "H264"),
		T("v360-300", "H264"),
		T("v360-600", "H264"),
		T("v540", "H264"),
		T("v720", "H264"),
		T("v900", "H264"),
		T("v1080", "H264"),
	];

	it("attributes on the mirror filename where codec alone abstained (7 same-codec templates)", () => {
		// The exact defect shape: seven H264 templates share a codec, so the old
		// codec-only rule abstained on all. The filename resolves it to ONE.
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [seg(), mirror("v360-600.mp4")] },
				SEVEN,
			),
		).toBe("v360-600");
	});

	it("distinguishes same-height, different-bitrate rungs (filename, never {height})", () => {
		const two = [T("v360-300", "H264"), T("v360-600", "H264")];
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [mirror("v360-300.mp4")] },
				two,
			),
		).toBe("v360-300");
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [mirror("v360-600.mp4")] },
				two,
			),
		).toBe("v360-600");
	});

	it("attributes every RESULT of one template that emitted many, all sharing the filename", () => {
		// 1 template → many results: the provider copies the SAME `pt.mp4` onto each
		// expanded rung's mirror; each attributes to the one template. (One call per
		// result; the population then keys them apart by resolved directory.)
		const one = [T("pt", "H264")];
		expect(
			attributeResult({ codecType: "H264", muxings: [mirror("pt.mp4")] }, one),
		).toBe("pt");
		expect(
			attributeResult({ codecType: "H264", muxings: [mirror("pt.mp4")] }, one),
		).toBe("pt");
	});

	it("VP9 rides a .webm mirror and still attributes", () => {
		expect(
			attributeResult(
				{ codecType: "VP9", muxings: [mirror("vp9.webm", "PROGRESSIVE_WEBM")] },
				[T("vp9", "VP9"), T("h", "H264")],
			),
		).toBe("vp9");
	});

	it("fails closed when a QC filename contradicts the provider codec", () => {
		expect(
			attributeResult({ codecType: "H264", muxings: [mirror("hevc.mp4")] }, [
				T("avc", "H264"),
				T("hevc", "H265"),
			]),
		).toBeUndefined();
	});

	it("requires the provider codec before a QC filename may attribute", () => {
		expect(
			attributeResult({ muxings: [mirror("avc.mp4")] }, [T("avc", "H264")]),
		).toBeUndefined();
	});

	it("FAILS CLOSED on conflicting mirror filenames within one RESULT", () => {
		// Two different mirror filenames on one result → do not guess which template.
		expect(
			attributeResult(
				{
					codecType: "H264",
					muxings: [mirror("v180.mp4"), mirror("v360-300.mp4")],
				},
				[T("v180", "H264"), T("v360-300", "H264")],
			),
		).toBeUndefined();
	});

	it("FAILS CLOSED when one filename matches more than one template", () => {
		// Same key on two codecs both spell `v1.mp4` — ambiguous, so abstain.
		expect(
			attributeResult({ codecType: "H264", muxings: [mirror("v1.mp4")] }, [
				T("v1", "H264"),
				T("v1", "H265"),
			]),
		).toBeUndefined();
	});

	it("FAILS CLOSED on a missing mirror filename in a multi-template ladder", () => {
		// No mirror leg → the codec-only fallback, which abstains on >1 same-codec
		// template. A missing filename is never a guess.
		expect(
			attributeResult({ codecType: "H264", muxings: [seg()] }, [
				T("v720", "H264"),
				T("v1080", "H264"),
			]),
		).toBeUndefined();
	});

	it("keeps the sole-template display when there is no mirror filename to bind", () => {
		// A non-QC per-title plan (or a DRM-only rung) carries no mirror filename;
		// the one-rule-that-cannot-be-wrong still files a single-template ladder.
		expect(
			attributeResult({ codecType: "H264", muxings: [seg()] }, [
				T("v1080", "H264"),
			]),
		).toBe("v1080");
	});

	it("ignores a filename on a NON-mirror muxing type", () => {
		// Only single-file MP4/WebM legs carry a real QC-mirror filename. A filename
		// that somehow rode a segmented (fMP4) leg must not drive attribution.
		expect(
			attributeResult(
				{ muxings: [{ muxingType: "FMP4", filename: "v180.mp4" }] },
				[T("v180", "H264"), T("v720", "H264")],
			),
		).toBeUndefined();
	});

	it("FAILS CLOSED on an unmatched or malformed mirror filename — no sole-codec fallback once a filename is present", () => {
		// The customer copy states the fallback applies only "if no filename is
		// available", and that is what the
		// code does: a mirror filename that matches NO template returns from the
		// filename branch and never reaches the codec rule — even where that rule
		// would have named a sole template. A foreign, placeholder-shaped or
		// case-mangled filename says our assumptions are off, not "guess".
		const one = [T("v1080", "H264")];
		// The single-template ladder is the ONLY arm that tells "fail closed" from
		// "fall through": a fall-through would attribute this one.
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [mirror("stray.mp4")] },
				one,
			),
		).toBeUndefined();
		// Placeholder-shaped (never resolved) and case-mangled, on the 7-ladder.
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [mirror("{height}p.mp4")] },
				SEVEN,
			),
		).toBeUndefined();
		expect(
			attributeResult(
				{ codecType: "H264", muxings: [mirror("V720.MP4")] },
				SEVEN,
			),
		).toBeUndefined();
		// Control: with NO filename the same single-template ladder still attributes,
		// so the abstentions above are the filename's doing, not the ladder's.
		expect(attributeResult({ codecType: "H264", muxings: [seg()] }, one)).toBe(
			"v1080",
		);
	});

	it("end to end: 7 same-codec templates, 6 provider RESULTs, all 6 attributed, 0 unattributed", async () => {
		// The whole path: provider-shaped muxing rows carry the filename → capture
		// binds each RESULT to its template. No `templateRendition` is injected.
		const rendkeys = ["v180", "v360-300", "v360-600", "v540", "v720", "v1080"];
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams(
					...rendkeys.map((k) => ({
						streamId: `s-${k}`,
						mode: PER_TITLE_RESULT_MODE,
						codecConfigId: "c",
					})),
				),
				listMuxings: muxings(
					...rendkeys.flatMap((k) => [
						{
							muxingId: `mux-${k}-fmp4`,
							muxingType: "FMP4",
							streamIds: [`s-${k}`],
							outputs: [{ outputPath: `out/${k}_x/video/` }],
							drm: [],
						},
						{
							muxingId: `mux-${k}-qc`,
							muxingType: "MP4",
							filename: `${k}.mp4`,
							name: `QC VMAF Mirror ${k}`,
							streamIds: [`s-${k}`],
							outputs: [{ outputPath: `out/${k}_x/qc/` }],
							drm: [],
						},
					]),
				),
				getCodecConfig: () =>
					Promise.resolve({ codecType: "H264", params: {} }),
			}),
			{ encodingId: "enc", capturedAt: CAPTURED_AT, templates: SEVEN },
		);
		expect(snapshot.scan.resultsCaptured).toBe(6);
		expect(snapshot.scan.unattributed).toBe(0);
		expect(snapshot.streams.map((s) => s.templateRendition).sort()).toEqual(
			[...rendkeys].sort(),
		);
		// v900 never produced a RESULT — it is simply absent from the population.
		expect(snapshot.streams.some((s) => s.templateRendition === "v900")).toBe(
			false,
		);
	});
});

describe("per-title attribution — provider-retained output path marker", () => {
	const marked = [
		{
			rendition: "v180",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE" as const,
			height: 180,
			outputPathPatterns: [
				"output/customer/video/v180/{height}p_{bitrate}_{uuid}/",
			],
		},
		{
			rendition: "v1080",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE" as const,
			height: 1080,
			outputPathPatterns: [
				"output/customer/video/v1080/{height}p_{bitrate}_{uuid}/",
			],
		},
	] satisfies [TemplateStreamRef, TemplateStreamRef];

	it("binds a flexible RESULT by the exact full output pattern", () => {
		expect(
			attributeResult(
				{
					codecType: "H264",
					muxings: [
						{
							muxingType: "FMP4",
							outputs: [
								{
									outputPath:
										"output/customer/video/v180/180p_250000_00000000-0000-4000-8000-000000000001/",
								},
							],
							drm: [],
						},
					],
				},
				marked,
			),
		).toBe("v180");
	});

	it("lets an exact path witness bind past an ordinary MP4 delivery filename", () => {
		expect(
			attributeResult(
				{
					codecType: "H264",
					muxings: [
						{
							muxingType: "MP4",
							filename: "video.ismv",
							outputs: [
								{
									outputPath:
										"output/customer/video/v180/180p_250000_00000000-0000-4000-8000-000000000001/",
								},
							],
							drm: [],
						},
					],
				},
				marked,
			),
		).toBe("v180");
	});

	it("requires the provider codec before an output-path marker may attribute", () => {
		expect(
			attributeResult(
				{
					muxings: [
						{
							muxingType: "FMP4",
							outputs: [
								{
									outputPath:
										"output/customer/video/v180/180p_250000_00000000-0000-4000-8000-000000000001/",
								},
							],
							drm: [],
						},
					],
				},
				marked,
			),
		).toBeUndefined();
	});

	it("fails closed for an imported shared pattern, a partial prefix, or two matching markers", () => {
		const shared = marked.map((template) => ({
			...template,
			outputPathPatterns: ["output/customer/video/{height}p_{bitrate}_{uuid}/"],
		}));
		const output = (outputPath: string) => ({
			codecType: "H264",
			muxings: [
				{
					muxingType: "FMP4",
					outputs: [{ outputPath }],
					drm: [],
				},
			],
		});

		expect(
			attributeResult(
				output(
					"output/customer/video/180p_250000_00000000-0000-4000-8000-000000000001/",
				),
				shared,
			),
		).toBeUndefined();
		expect(
			attributeResult(
				output(
					"output/customer/video/v180-extra/180p_250000_00000000-0000-4000-8000-000000000001/",
				),
				marked,
			),
		).toBeUndefined();
		expect(
			attributeResult(
				output(
					"output/customer/video/v180/180p_250000_00000000-0000-4000-8000-000000000001/",
				),
				[marked[0], marked[0]],
			),
		).toBeUndefined();
	});
});

describe("the persisted snapshot survives the step-log redactor", () => {
	/**
	 * THE FIELD NAMES ARE LOAD-BEARING. `redactSecrets` masks any property whose
	 * name looks secret, and "…Key" does — so the first version of this feature,
	 * which called these `renditionKey`/`templateRenditionKey`, persisted every
	 * attribution as "[REDACTED]" and every payload template as the same. The
	 * compiler's own payload test caught the op side; NOTHING covered the response
	 * side, which is where the snapshot lives.
	 */
	it("keeps every field of a captured outcome through redaction", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams({
					streamId: "s-res",
					mode: PER_TITLE_RESULT_MODE,
					codecConfigId: "cfg",
					appliedSettings: { width: 1280, height: 720 },
				}),
				listMuxings: muxings({
					muxingId: "m",
					muxingType: "FMP4",
					streamIds: ["s-res"],
					avgBitrate: 2_000_000,
					// POPULATED. This is the test that exists to catch the `renditionKey`
					// failure mode, and it had been extended with EMPTY outputs/drm — changed
					// only to satisfy the type, exercising the new names not at all (review
					// catch). A masked `outputPath` would be precisely that bug again.
					outputs: [{ outputId: "out-1", outputPath: "video/1080p_4200000/" }],
					drm: [
						{
							drmId: "drm-1",
							drmType: "CENC",
							outputs: [{ outputPath: "dash/enc/" }],
						},
					],
				}),
				getCodecConfig: () =>
					Promise.resolve({
						codecType: "H264",
						params: { bitrate: 2_000_000 },
					}),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates: [T("v720", "H264")],
			},
		);
		expect(snapshot.streams[0]?.templateRendition).toBe("v720");

		const outcome: PerTitleCaptureOutcome = { captured: true, snapshot };
		const redacted = redactSecrets(outcome);
		expect(redacted).toEqual(outcome);
		// And it still parses as the contract the UI reads.
		expect(perTitleCaptureOutcomeSchema.parse(redacted)).toEqual(outcome);
	});

	it("keeps the compiled op payload through redaction", () => {
		const plan = loadPlan("pertitle-h264-openapi");
		const op = compilePlan(plan).find(
			(o) => o.kind === "CAPTURE_PER_TITLE_RESULTS",
		);
		expect(op).toBeDefined();
		expect(redactSecrets(op?.payload)).toEqual(op?.payload);
	});
});

describe("the capture op is emitted for exactly the per-title plans", () => {
	it("emits one trailing capture step for every per-title plan, and none otherwise", () => {
		const withCapture: string[] = [];
		const perTitle: string[] = [];
		for (const name of planNames) {
			const plan = loadPlan(name);
			const ops = compilePlan(plan);
			const captures = ops.filter(
				(o) => o.kind === "CAPTURE_PER_TITLE_RESULTS",
			);
			expect(captures.length, `${name}: at most one capture step`).toBeLessThan(
				2,
			);
			if (captures.length === 1) {
				withCapture.push(name);
			}
			if (planHasPerTitle(plan)) {
				perTitle.push(name);
			}
		}
		// Guards the sweep: a corpus that stopped loading would make this pass over
		// nothing. 14 per-title plans of 66 today.
		expect(perTitle.length).toBeGreaterThanOrEqual(14);
		expect(planNames.length).toBeGreaterThanOrEqual(66);
		expect(withCapture).toEqual(perTitle);
	});

	it("sits immediately after the last AWAIT_ENCODING", () => {
		// Per-title RESULT streams do not exist until the encoding is FINISHED
		// (C1), and manifest generation reads them — so the capture belongs between
		// the awaits and the manifests, not merely "somewhere after the start".
		for (const name of planNames) {
			const ops = compilePlan(loadPlan(name));
			const capture = ops.findIndex(
				(o) => o.kind === "CAPTURE_PER_TITLE_RESULTS",
			);
			if (capture === -1) {
				continue;
			}
			const lastAwait = ops.reduce(
				(acc, op, i) => (op.kind === "AWAIT_ENCODING" ? i : acc),
				-1,
			);
			expect(lastAwait, `${name}: has an await`).toBeGreaterThanOrEqual(0);
			expect(capture, `${name}: capture follows the await`).toBe(lastAwait + 1);
		}
	});

	it("binds to the same encoding the per-title manifest expansions bind to", () => {
		// TAUTOLOGY WARNING, and why this stays anyway. Every per-title fixture is
		// single-encoding, so both sides of the comparison below are the literal
		// "encoding" and forcing `perTitleEncStep` to return `ENCODING_STEP`
		// unconditionally leaves all 294 tests green (review finding). It is kept
		// because it documents the contract and would catch a divergence the day a
		// multi-encoding per-title plan becomes legal — which the test below this one
		// pins as currently impossible. The real protection today is that the gate and
		// the resolver are ONE symbol (`isPerTitle = isPerTitleRendition`), which no
		// test can check because there is nothing to disagree.
		// If the emission gate and `perTitleEncStep` ever disagreed, the capture
		// would list the streams of a DIFFERENT encoding and report an empty
		// ladder — a wrong answer that looks like a right one.
		for (const name of planNames) {
			const ops = compilePlan(loadPlan(name));
			const capture = ops.find((o) => o.kind === "CAPTURE_PER_TITLE_RESULTS");
			if (!capture) {
				continue;
			}
			const expansions = ops.filter(
				(o) =>
					o.kind.includes("PER_TITLE_VARIANTS") ||
					o.kind.includes("PER_TITLE_REPRESENTATIONS") ||
					o.kind.includes("PER_TITLE_ENTRIES"),
			);
			for (const expansion of expansions) {
				expect(expansion.refs.encodingId, `${name}/${expansion.step}`).toBe(
					capture.refs.encodingId,
				);
			}
		}
	});

	it("carries every per-title rendition of the plan in its payload", () => {
		for (const name of planNames) {
			const plan = loadPlan(name);
			const capture = compilePlan(plan).find(
				(o) => o.kind === "CAPTURE_PER_TITLE_RESULTS",
			);
			if (!capture) {
				continue;
			}
			// A payload short of a template is an attribution that can never fire
			// for that rung — and the payload is also what the Resources tab shows.
			// A payload short of a template is an attribution that can never fire for
			// that rung — and the payload is also what the Resources tab shows.
			expect(capture.payload.templates).toEqual(perTitleTemplates(plan));
		}
	});
});

describe("the snapshot schema is the persisted contract", () => {
	it("rejects a mode other than PER_TITLE_RESULT", () => {
		const parsed = perTitleResultsSnapshotSchema.safeParse({
			capturedAt: CAPTURED_AT,
			streams: [
				{
					streamId: "s",
					mode: "PER_TITLE_TEMPLATE",
					params: {},
					muxings: [],
				},
			],
			scan: {
				streamsListed: 1,
				templatesListed: 1,
				resultsCaptured: 1,
				muxingsListed: 0,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		});
		expect(parsed.success).toBe(false);
	});
});

describe("one capture op is enough — the plan cannot be multi-encoding AND per-title", () => {
	/**
	 * The capture compiles ONE op bound to ONE encoding
	 * (`perTitleEncStep`). That is only correct because a valid plan cannot have
	 * both a per-title rendition and multiple encodings, and it is the VALIDATOR
	 * that makes it so, in two rules that have nothing to do with this feature:
	 *
	 *   - a per-title rendition of any video codec requires the matching
	 *     `plan.perTitle.<codec>Configuration` (PLAN_PER_TITLE_CONFIG_MISSING);
	 *   - `plan.perTitle` with multiple encodings is an error
	 *     (PLAN_MULTI_ENCODING_PER_TITLE).
	 *
	 * So this test does not restate the compiler's behaviour — it pins the
	 * IMPLICATION the compiler depends on. Relax either rule and this fails, which
	 * is the moment someone would need to emit one capture op per encoding.
	 */
	it("rejects a per-title plan that declares two encodings", () => {
		const plan = loadPlan("pertitle-h264-openapi");
		expect(planHasPerTitle(plan)).toBe(true);
		expect(plan.perTitle).toBeDefined(); // the config the validator demands
		const multi = {
			...plan,
			encodings: [
				{ key: "a", name: "A" },
				{ key: "b", name: "B" },
			],
		};
		const codes = validatePlan(encodingPlanSchema.parse(multi))
			.filter((i) => i.level === "error")
			.map((i) => i.code);
		expect(codes).toContain("PLAN_MULTI_ENCODING_PER_TITLE");
	});

	it("no corpus plan has both, so one capture op per plan is exhaustive", () => {
		let multiEncodingPlans = 0;
		for (const name of planNames) {
			const plan = loadPlan(name);
			const encodings = plan.encodings?.length ?? 1;
			if (encodings > 1) {
				multiEncodingPlans += 1;
				expect(planHasPerTitle(plan), `${name} is multi-encoding`).toBe(false);
			}
		}
		// Guards the sweep: the Dolby multi-format fixtures are the multi-encoding
		// ones, and a corpus that stopped loading would make this vacuous.
		expect(multiEncodingPlans).toBeGreaterThanOrEqual(6);
	});
});

describe("perTitleResultsView — precedence, and the difference between empty and failed", () => {
	const snapshot = (streamId: string): PerTitleResultsSnapshot => ({
		capturedAt: CAPTURED_AT,
		streams: [
			{ streamId, mode: PER_TITLE_RESULT_MODE, params: {}, muxings: [] },
		],
		scan: {
			streamsListed: 1,
			templatesListed: 1,
			templatesDeclared: 0,
			resultsCaptured: 1,
			muxingsListed: 0,
			complete: true,
			codecConfigErrors: 0,
			unattributed: 0,
		},
	});
	const stepEntry = (response: unknown) => [
		{ step: "start", response: { started: true } },
		{ step: PER_TITLE_CAPTURE_STEP, response },
	];

	/**
	 * THE PRECEDENCE TABLE design §8 asks for. The three easy cells were pinned and
	 * the discriminator had ZERO coverage: removing the quality guard entirely
	 * survived the whole core suite plus the web job-detail suite, because the
	 * helper above hardcodes `complete: true, codecConfigErrors: 0` and no test ever
	 * built a degraded snapshot (review finding).
	 *
	 * `q(complete, errors, rungs)` builds a snapshot of a given quality so each cell
	 * says what it means. The rule under test: best evidence wins, scored the same
	 * way on both sides — tier first (reached the end of the list, then read every
	 * rung's parameters), then rung count among equals.
	 */
	function q(complete: boolean, errors: number, rungs: number) {
		return {
			capturedAt: CAPTURED_AT,
			streams: Array.from({ length: rungs }, (_, i) => ({
				streamId: `s-${i}`,
				mode: PER_TITLE_RESULT_MODE as typeof PER_TITLE_RESULT_MODE,
				params: {},
				muxings: [],
			})),
			scan: {
				streamsListed: rungs,
				templatesListed: 1,
				templatesDeclared: 1,
				resultsCaptured: rungs,
				muxingsListed: 0,
				complete,
				codecConfigErrors: errors,
				unattributed: 0,
			},
		};
	}

	it.each([
		// step quality            backfill quality        winner    why
		["perfect vs perfect", q(true, 0, 3), q(true, 0, 3), "step"],
		["perfect vs degraded", q(true, 0, 3), q(false, 0, 9), "step"],
		["degraded vs perfect", q(false, 0, 9), q(true, 0, 3), "snapshot"],
		// The High finding: a 12-rung run capture with ONE failed config read must not
		// be shadowed by a 2-rung truncated backfill. Both imperfect; the count decides.
		[
			"12 rungs w/ 1 error vs 2 rungs truncated",
			q(true, 1, 12),
			q(false, 0, 2),
			"step",
		],
		// …and the case that made the guard necessary in the first place.
		[
			"truncated step vs complete backfill",
			q(false, 0, 2),
			q(true, 0, 12),
			"snapshot",
		],
		[
			"equal tier, more rungs in the backfill",
			q(true, 1, 3),
			q(true, 1, 9),
			"snapshot",
		],
		[
			"equal tier, more rungs in the step",
			q(true, 1, 9),
			q(true, 1, 3),
			"step",
		],
		// The cells where codecConfigErrors is the ONLY difference. Without these,
		// dropping that clause from the tier survives the whole suite — it did, on my
		// first version of this table (reviewer's second mutation, reproduced).
		[
			"clean step vs same-size backfill with an error",
			q(true, 0, 3),
			q(true, 1, 3),
			"step",
		],
		[
			"step with an error vs same-size clean backfill",
			q(true, 1, 3),
			q(true, 0, 3),
			"snapshot",
		],
	])("%s → %s wins", (_label, step, backfill, winner) => {
		const view = perTitleResultsView({
			stepLog: [
				{
					step: PER_TITLE_CAPTURE_STEP,
					response: { captured: true, snapshot: step },
				},
			],
			snapshots: { perTitleResults: backfill },
		});
		expect(view.origin).toBe(winner);
		const chosen = winner === "step" ? step : backfill;
		expect(
			view.origin === "step" || view.origin === "snapshot"
				? view.snapshot.scan.resultsCaptured
				: null,
		).toBe(chosen.scan.resultsCaptured);
	});

	it("a backfill still beats a FAILED step, whatever its quality", () => {
		const view = perTitleResultsView({
			stepLog: [
				{
					step: PER_TITLE_CAPTURE_STEP,
					response: { captured: false, error: "502" },
				},
			],
			snapshots: { perTitleResults: q(false, 3, 1) },
		});
		expect(view.origin).toBe("snapshot");
	});

	it("prefers the capture step's own response", () => {
		const view = perTitleResultsView({
			stepLog: stepEntry({ captured: true, snapshot: snapshot("from-step") }),
			snapshots: { perTitleResults: snapshot("from-column") },
		});
		expect(view).toMatchObject({ origin: "step" });
		expect(
			view.origin === "step" ? view.snapshot.streams[0]?.streamId : null,
		).toBe("from-step");
	});

	it("falls back to the backfilled column", () => {
		const view = perTitleResultsView({
			stepLog: [{ step: "start", response: {} }],
			snapshots: { perTitleResults: snapshot("from-column") },
		});
		expect(view).toMatchObject({ origin: "snapshot" });
	});

	it("lets a backfill BEAT a failed capture step", () => {
		// The route exists to fix a capture that could not read, and it writes only
		// on success — so if both are present, the column is the better answer.
		const view = perTitleResultsView({
			stepLog: stepEntry({ captured: false, error: "502" }),
			snapshots: { perTitleResults: snapshot("backfilled") },
		});
		expect(view).toMatchObject({ origin: "snapshot" });
	});

	it("reports a FAILED capture as failed, never as no results", () => {
		// The distinction the UI depends on: an empty table here would tell an
		// operator their per-title encode produced nothing.
		const view = perTitleResultsView({
			stepLog: stepEntry({ captured: false, error: "502 Bad Gateway" }),
		});
		expect(view).toEqual({ origin: "failed", error: "502 Bad Gateway" });
	});

	it("reads the FIRST capture entry, not the last", () => {
		// `find` → `findLast` survived (review finding). A step log holding two
		// `per-title-results` entries is only possible through a hand edit or a replay
		// bug, but which one wins must be a decision rather than an accident.
		const view = perTitleResultsView({
			stepLog: [
				{
					step: PER_TITLE_CAPTURE_STEP,
					response: { captured: true, snapshot: snapshot("first") },
				},
				{
					step: PER_TITLE_CAPTURE_STEP,
					response: { captured: true, snapshot: snapshot("second") },
				},
			],
		});
		expect(
			view.origin === "step" ? view.snapshot.streams[0]?.streamId : null,
		).toBe("first");
	});

	it("survives a null entry in the step log", () => {
		// Dropping `e !== null` from the find predicate survived; a null then throws
		// inside a render, the failure the neighbouring cases guard for a non-array.
		expect(perTitleResultsView({ stepLog: [null, { step: "start" }] })).toEqual(
			{ origin: "absent" },
		);
	});

	it("is absent when no capture has happened", () => {
		expect(perTitleResultsView({})).toEqual({ origin: "absent" });
		expect(perTitleResultsView({ stepLog: [], snapshots: {} })).toEqual({
			origin: "absent",
		});
	});

	it.each([
		["a step log that is not an array", { stepLog: { nope: true } }],
		["a response of the wrong shape", { stepLog: stepEntry({ captured: 1 }) }],
		[
			"a snapshot column of the wrong shape",
			{ snapshots: { perTitleResults: 7 } },
		],
		["a null snapshots column", { snapshots: null }],
	])("degrades to absent on %s rather than throwing in a render", (_l, input) => {
		// Both inputs are JSON columns that an older version of this code may have
		// written. A parse failure must not take the page down.
		expect(perTitleResultsView(input)).toEqual({ origin: "absent" });
	});
});

/**
 * Best-evidence, extended for the fix: a NEW,
 * filename-attributed 6 must beat an OLD, codec-abstained 6 it used to TIE (and
 * lose to as the incumbent step) — WITHOUT letting a truncated fresh capture win
 * on attribution or version alone.
 */
describe("perTitleResultsView — attribution completeness and evidence version", () => {
	const qv = (
		rungs: number,
		unattributed: number,
		attributionVersion?: number,
	): PerTitleResultsSnapshot => ({
		capturedAt: CAPTURED_AT,
		...(attributionVersion !== undefined ? { attributionVersion } : {}),
		streams: Array.from({ length: rungs }, (_, i) => ({
			streamId: `s-${i}`,
			mode: PER_TITLE_RESULT_MODE,
			params: {},
			muxings: [],
		})),
		scan: {
			streamsListed: rungs,
			templatesListed: 1,
			templatesDeclared: 1,
			resultsCaptured: rungs,
			muxingsListed: 0,
			complete: true,
			codecConfigErrors: 0,
			unattributed,
		},
	});
	const view = (
		step: PerTitleResultsSnapshot,
		backfill: PerTitleResultsSnapshot,
	) =>
		perTitleResultsView({
			stepLog: [
				{
					step: PER_TITLE_CAPTURE_STEP,
					response: { captured: true, snapshot: step },
				},
			],
			snapshots: { perTitleResults: backfill },
		});

	it("a NEW 6-attributed backfill beats an OLD 6-unattributed step (the shadow §5.4 names)", () => {
		// The audit scenario: codec-era 6-unattributed vs filename-era 6-attributed.
		expect(view(qv(6, 6, 0), qv(6, 0, 1)).origin).toBe("snapshot");
	});

	it("attribution completeness alone breaks a same-version, same-count tie", () => {
		// Both version 1, both 6 rungs — ONLY the count of ATTRIBUTED rungs differs,
		// so this isolates the completeness clause the tie used to lose to the step.
		expect(view(qv(6, 6, 1), qv(6, 0, 1)).origin).toBe("snapshot");
	});

	it("a 2-rung-truncated NEW backfill does NOT beat the good OLD 6", () => {
		// Rung count dominates attribution and version, so a fresher-but-shorter
		// capture cannot shadow a fuller one — the truncation guard still holds.
		expect(view(qv(6, 6, 0), qv(2, 0, 1)).origin).toBe("step");
	});

	it("among two fully-attributed 6s, the newer attribution version wins", () => {
		// Tier, rungs and attribution all tie → the version breaks it, so a
		// re-capture under a newer rule supersedes an equal older one.
		expect(view(qv(6, 0, 0), qv(6, 0, 1)).origin).toBe("snapshot");
	});
});

describe("groupPerTitleResults", () => {
	const result = (
		streamId: string,
		templateRendition?: string,
	): PerTitleResultStream => ({
		streamId,
		mode: PER_TITLE_RESULT_MODE,
		...(templateRendition !== undefined ? { templateRendition } : {}),
		params: {},
		muxings: [],
	});
	const snap = (streams: PerTitleResultStream[]): PerTitleResultsSnapshot => ({
		capturedAt: CAPTURED_AT,
		streams,
		scan: {
			streamsListed: streams.length,
			templatesListed: 0,
			templatesDeclared: 0,
			resultsCaptured: streams.length,
			muxingsListed: 0,
			complete: true,
			codecConfigErrors: 0,
			unattributed: streams.filter((s) => !s.templateRendition).length,
		},
	});

	it("groups in PLAN order, not in result order", () => {
		const groups = groupPerTitleResults(
			snap([result("b", "v1080"), result("a", "v720")]),
			["v720", "v1080"],
		);
		expect(groups.map((g) => g.rendition)).toEqual(["v720", "v1080"]);
	});

	it("omits templates that produced nothing", () => {
		// With attribution abstaining as often as it does, an empty group per rung
		// would imply the encoder produced nothing for it.
		const groups = groupPerTitleResults(snap([result("a", "v720")]), [
			"v360",
			"v720",
			"v1080",
		]);
		expect(groups.map((g) => g.rendition)).toEqual(["v720"]);
	});

	it("puts unattributed results in a final group, never drops them", () => {
		const groups = groupPerTitleResults(
			snap([result("x"), result("a", "v720"), result("y")]),
			["v720"],
		);
		expect(groups.map((g) => g.rendition)).toEqual(["v720", null]);
		expect(groups[1]?.results.map((r) => r.streamId)).toEqual(["x", "y"]);
	});

	it("keeps a result attributed to a rendition the caller did not list", () => {
		// A plan edited after the run. The row exists; dropping it would lose data
		// the snapshot actually holds.
		const groups = groupPerTitleResults(snap([result("a", "gone")]), ["v720"]);
		expect(groups).toEqual([
			{ rendition: "gone", results: [result("a", "gone")] },
		]);
	});

	it("keeps within-group order as captured", () => {
		// `push` → `unshift` survived: the only ordered assertion sorted first
		// (review finding). Order here is the API's list order, which is the closest
		// thing to "what the encoder produced" that we have.
		const groups = groupPerTitleResults(
			snap([result("a", "v720"), result("b", "v720"), result("c", "v720")]),
			["v720"],
		);
		expect(groups[0]?.results.map((r) => r.streamId)).toEqual(["a", "b", "c"]);
	});

	it("puts unattributed LAST even when a leftover group is present", () => {
		// No test built a snapshot with both, so moving the unattributed block above
		// the leftover loop survived (review finding).
		const groups = groupPerTitleResults(
			snap([result("x"), result("a", "gone"), result("b", "v720")]),
			["v720"],
		);
		expect(groups.map((g) => g.rendition)).toEqual(["v720", "gone", null]);
	});

	it("accounts for every result exactly once", () => {
		const streams = [
			result("a", "v720"),
			result("b", "v720"),
			result("c", "v1080"),
			result("d"),
		];
		const groups = groupPerTitleResults(snap(streams), ["v1080", "v720"]);
		const flat = groups.flatMap((g) => g.results.map((r) => r.streamId)).sort();
		expect(flat).toEqual(["a", "b", "c", "d"]);
	});
});

describe("bitmovinCapturePort — the row guards", () => {
	/**
	 * These exist because the port replaced a hand-written copy in the worker, and
	 * the replacement was subtly WEAKER: the original guarded with `!stream.id`,
	 * which rejects an empty string, and the rewrite used `typeof id === "string"`,
	 * which accepts one. Found by diffing the two implementations — no test
	 * covered it, on the orchestrator's primary path.
	 */
	function api(streams: unknown[], muxings: unknown[] = []) {
		return {
			encoding: {
				encodings: {
					streams: { list: async () => ({ items: streams }) },
					muxings: { list: async () => ({ items: muxings }) },
				},
				configurations: { type: { get: async () => ({ type: "H264" }) } },
			},
		};
	}

	it("treats an EMPTY id as unusable, not as a usable row", async () => {
		const port = bitmovinCapturePort(
			api([{ id: "", mode: "PER_TITLE_RESULT" }]) as never,
		);
		const page = await port.listStreams("enc");
		expect(page.items).toEqual([]);
		expect(page.complete).toBe(false);
	});

	it('drops an empty codecConfigId rather than fetching config ""', async () => {
		const port = bitmovinCapturePort(
			api([
				{ id: "s-1", mode: "PER_TITLE_RESULT", codecConfigId: "" },
			]) as never,
		);
		const page = await port.listStreams("enc");
		expect(page.items[0]).toEqual({
			streamId: "s-1",
			mode: "PER_TITLE_RESULT",
		});
	});

	it("ignores a non-numeric appliedSettings rather than passing it through", async () => {
		const port = bitmovinCapturePort(
			api([
				{
					id: "s-1",
					mode: "PER_TITLE_RESULT",
					appliedSettings: { width: "1920", height: 1080 },
				},
			]) as never,
		);
		const page = await port.listStreams("enc");
		expect(page.items[0]?.appliedSettings).toEqual({ height: 1080 });
	});

	it("normalizes and keeps provider-copied fixedResolutionAndBitrateSettings", async () => {
		const port = bitmovinCapturePort(
			api([
				{
					id: "s-1",
					mode: "PER_TITLE_RESULT",
					perTitleSettings: {
						fixedResolutionAndBitrateSettings: {
							minBitrate: 600_000,
							maxBitrate: 900_000,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
							lowComplexityBoundaryForMaxBitrate: 2_160_000,
							highComplexityBoundaryForMaxBitrate: 4_000_000,
						},
					},
				},
			]) as never,
		);
		const page = await port.listStreams("enc");
		expect(page.items[0]).toMatchObject({
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: {
					minBitrate: 600_000,
					maxBitrate: 900_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 2_160_000,
					highComplexityBoundaryForMaxBitrate: 4_000_000,
				},
			},
		});
	});

	it("keeps only usable stream ids on a muxing", async () => {
		const port = bitmovinCapturePort(
			api(
				[],
				[
					{
						id: "m-1",
						type: "FMP4",
						streams: [{ streamId: "s-1" }, { streamId: "" }, {}],
					},
				],
			) as never,
		);
		const page = await port.listMuxings("enc");
		expect(page.items[0]?.streamIds).toEqual(["s-1"]);
	});

	it("keeps the muxing filename AND name off the SDK row (§5.4 correlation key)", async () => {
		// `Mp4Muxing.filename` / base `Muxing.name` come back on the real readback
		// Dropping `filename` here is what starved
		// attribution — this pins that the row parser preserves both.
		const port = bitmovinCapturePort(
			api(
				[],
				[
					{
						id: "m-qc",
						type: "MP4",
						filename: "v180.mp4",
						name: "QC VMAF Mirror v180",
						streams: [{ streamId: "s-1" }],
						outputs: [{ outputId: "o", outputPath: "out/180p_x/qc/" }],
					},
				],
			) as never,
		);
		const page = await port.listMuxings("enc");
		expect(page.items[0]).toMatchObject({
			muxingId: "m-qc",
			muxingType: "MP4",
			filename: "v180.mp4",
			name: "QC VMAF Mirror v180",
			outputs: [{ outputId: "o", outputPath: "out/180p_x/qc/" }],
		});
	});

	it("omits an empty-string filename rather than binding on it", async () => {
		const port = bitmovinCapturePort(
			api([], [{ id: "m-1", type: "MP4", filename: "", name: "" }]) as never,
		);
		const page = await port.listMuxings("enc");
		expect(page.items[0]).not.toHaveProperty("filename");
		expect(page.items[0]).not.toHaveProperty("name");
	});
});

/**
 * Persistence: the mirror `filename`/`name`
 * and the version stamps survive capture → JSON column → re-read, and a snapshot
 * written before versioning still parses.
 */
describe("per-title snapshot persistence keeps the correlation key and versions", () => {
	it("round-trips filename/name and stamps schema + attribution versions", async () => {
		const snapshot = await capturePerTitleResults(
			port({
				listStreams: streams({
					streamId: "s-1",
					mode: PER_TITLE_RESULT_MODE,
					codecConfigId: "c",
					perTitleSettings: {
						fixedResolutionAndBitrateSettings: {
							minBitrate: 300_000,
							maxBitrate: 500_000,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
						},
					},
				}),
				listMuxings: muxings({
					muxingId: "m-qc",
					muxingType: "MP4",
					filename: "v180.mp4",
					name: "QC VMAF Mirror v180",
					streamIds: ["s-1"],
					outputs: [{ outputPath: "out/180p_x/qc/" }],
					drm: [],
				}),
				getCodecConfig: () =>
					Promise.resolve({ codecType: "H264", params: {} }),
			}),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates: [T("v180", "H264")],
			},
		);
		expect(snapshot.schemaVersion).toBe(PER_TITLE_SCHEMA_VERSION);
		expect(snapshot.attributionVersion).toBe(PER_TITLE_ATTRIBUTION_VERSION);
		// Through a real JSON column round-trip.
		const reread = perTitleResultsSnapshotSchema.parse(
			JSON.parse(JSON.stringify(snapshot)),
		);
		expect(reread.streams[0]?.muxings[0]).toMatchObject({
			filename: "v180.mp4",
			name: "QC VMAF Mirror v180",
		});
		expect(reread.streams[0]?.templateRendition).toBe("v180");
		expect(reread.streams[0]?.perTitleSettings).toEqual({
			fixedResolutionAndBitrateSettings: {
				minBitrate: 300_000,
				maxBitrate: 500_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
			},
		});
		expect(reread.attributionVersion).toBe(PER_TITLE_ATTRIBUTION_VERSION);
	});

	it("still parses a pre-versioning snapshot (versions read as absent → 0)", () => {
		const legacy = {
			capturedAt: CAPTURED_AT,
			streams: [
				{ streamId: "s", mode: PER_TITLE_RESULT_MODE, params: {}, muxings: [] },
			],
			scan: {
				streamsListed: 1,
				templatesListed: 1,
				templatesDeclared: 1,
				resultsCaptured: 1,
				muxingsListed: 0,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		};
		const parsed = perTitleResultsSnapshotSchema.parse(legacy);
		expect(parsed.attributionVersion).toBeUndefined();
		expect(parsed.schemaVersion).toBeUndefined();
	});
});

it("uses the exact provider codec type for internal HEVCv2 template attribution", () => {
	const plan = loadPlan("pertitle-h264-separate-av-inputs");
	plan.internal = { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } };
	plan.renditions = plan.renditions.map((r) =>
		r.codec === "H264"
			? renditionSchema.parse({
					key: r.key,
					ingestKey: r.ingestKey,
					codec: "H265",
					height: r.height,
					bitrate: r.bitrate,
					mode: r.mode,
				})
			: r,
	);
	const templates = perTitleTemplates(plan);
	expect(templates.length).toBeGreaterThan(0);
	expect(templates.every((t) => t.codec === "H265V2")).toBe(true);
	const first = templates[0];
	if (!first) throw new Error("expected HEVCv2 template");
	const witness = {
		...first,
		outputPathPatterns: ["video/native/{height}_{bitrate}_{uuid}/"],
	};
	const result = {
		codecType: "H265V2",
		appliedSettings: { height: 1080 },
		muxings: [
			{
				muxingType: "MP4",
				outputs: [{ outputPath: "video/native/1080_5000000_result/" }],
			},
		],
	};
	expect(attributeResult(result, [witness])).toBe(witness.rendition);
	expect(
		attributeResult({ ...result, codecType: "H265" }, [witness]),
	).toBeUndefined();
	// Multiple same-codec candidates remain ambiguous without an exact witness.
	const flexible = {
		rendition: "flex",
		codec: "H265V2",
		mode: "PER_TITLE_TEMPLATE" as const,
	};
	const fixed = {
		rendition: "fixed",
		codec: "H265V2",
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" as const,
		height: 1080,
	};
	expect(
		attributeResult({ codecType: "H265V2" }, [flexible, fixed]),
	).toBeUndefined();
});
