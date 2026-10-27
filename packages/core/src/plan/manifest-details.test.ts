import { describe, expect, it } from "vitest";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { manifestConditionSchema } from "./manifest-options";
import { encodingPlanSchema, vp9RenditionSchema } from "./schema";
import {
	encodingTemplateExportUnavailableReason,
	planToEncodingTemplateYaml,
} from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function base() {
	return loadPlan("av1-fmp4-dash-hls");
}
const errors = (plan: ReturnType<typeof base>) =>
	validatePlan(plan).filter((issue) => issue.level === "error");

describe("manifest detailed settings", () => {
	it("does not silently lose advanced manifest values during YAML export", () => {
		const plan = base();
		const hls = plan.manifests.find((m) => m.kind === "HLS");
		if (!hls) throw new Error("missing HLS");
		hls.detailed = { targetDurationRoundingMode: "UPWARD_ROUNDING" };
		expect(encodingTemplateExportUnavailableReason(plan)).toBe(
			"MANIFEST_DETAILS",
		);
		expect(() => planToEncodingTemplateYaml(plan)).toThrow(/Plan JSON/);
	});
	it("carries DASH globals, period, adaptation attributes and ranges into ordered operations", () => {
		const plan = base();
		plan.keyframes = [
			{ key: "start", time: 1 },
			{ key: "end", time: 5 },
		];
		const manifest = plan.manifests.find((m) => m.kind === "DASH");
		if (manifest?.kind !== "DASH") throw new Error("DASH fixture missing");
		const video = plan.muxings.find((m) =>
			plan.renditions.some((r) => r.key === m.streamKey && r.codec === "AV1"),
		);
		if (!video) throw new Error("video fixture missing");
		manifest.detailed = {
			dashEditionCompatibility: "V4",
			iso8601TimestampFormat: "SHORT",
			minBufferTime: 3,
			namespaces: [{ prefix: "example", uri: "urn:example" }],
			utcTimings: [
				{
					schemeIdUri: "urn:mpeg:dash:utc:http-xsdate:2014",
					value: "https://time.example.test/",
				},
			],
			period: {
				start: 0,
				duration: 10,
				customXmlElements: [
					'<SupplementalProperty schemeIdUri="urn:test" value="1"/>',
				],
			},
			videoAdaptationSet: {
				roles: ["MAIN"],
				labels: [{ value: "Main", lang: "en" }],
				accessibilities: [
					{ schemeIdUri: "urn:example:accessibility", value: "1" },
				],
				customAttributes: [{ key: "selectionPriority", value: "10" }],
			},
			representations: [
				{
					muxingKey: video.key,
					mode: "TEMPLATE_ADAPTATION_SET",
					startSegmentNumber: 1,
					endSegmentNumber: 2,
					startKeyframeKey: "start",
					endKeyframeKey: "end",
				},
			],
		};
		expect(errors(plan)).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((op) => op.step === `manifest:${manifest.key}`)?.payload,
		).toMatchObject({
			minBufferTime: 3,
			utcTimings: manifest.detailed.utcTimings,
		});
		expect(ops.find((op) => op.kind === "CREATE_DASH_PERIOD")?.payload).toEqual(
			{ start: 0, duration: 10 },
		);
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_PERIOD_XML")?.payload,
		).toEqual({ data: manifest.detailed.period?.customXmlElements?.[0] });
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_ADAPTATION_SET_VIDEO")?.payload,
		).toMatchObject(manifest.detailed.videoAdaptationSet ?? {});
		expect(
			ops.find((op) => op.step === `manifest:${manifest.key}:rep:${video.key}`),
		).toMatchObject({
			payload: {
				startSegmentNumber: 1,
				endSegmentNumber: 2,
				mode: "TEMPLATE_ADAPTATION_SET",
			},
			refs: {
				startKeyframeId: "keyframe:start",
				endKeyframeId: "keyframe:end",
			},
		});
	});

	it("preserves all detailed settings when a plan is edited in the wizard", () => {
		const plan = base();
		for (const manifest of plan.manifests) {
			if (manifest.kind === "DASH")
				manifest.detailed = {
					minBufferTime: 2.5,
					namespaces: [{ prefix: "test", uri: "urn:test" }],
					period: { start: 3, duration: 20 },
					audioAdaptationSet: {
						roles: ["COMMENTARY"],
						labels: [{ value: "Audio", lang: "ja" }],
					},
				};
			if (manifest.kind === "HLS")
				manifest.detailed = {
					channelsAttributeForAudio: "ALWAYS",
					targetDurationRoundingMode: "UPWARD_ROUNDING",
					streams: {
						forceFrameRateAttribute: false,
						startSegmentNumber: 0,
						endSegmentNumber: 5,
					},
					audioMedia: {
						assocLanguage: "en",
						characteristics: ["public.accessibility.describes-video"],
						forced: false,
					},
				};
		}
		const parsed = encodingPlanSchema.parse(plan);
		const result = planToWizardState(parsed);
		expect(result).not.toBeNull();
		if (!result) throw new Error("wizard import failed");
		expect(encodingPlanSchema.parse(buildPlan(result)).manifests).toEqual(
			parsed.manifests,
		);
	});

	it("compiles additional HLS groups, variant attributes, and correctly positioned tags", () => {
		const plan = base();
		plan.keyframes = [{ key: "cue", time: 2 }];
		const manifest = plan.manifests.find((m) => m.kind === "HLS");
		if (manifest?.kind !== "HLS") throw new Error("HLS fixture missing");
		const video = plan.muxings[0];
		if (!video) throw new Error("missing muxing");
		manifest.detailed = {
			channelsAttributeForAudio: "STANDARD_CONFORM",
			targetDurationRoundingMode: "NORMAL_ROUNDING",
			audioMedia: {
				assocLanguage: "en",
				characteristics: ["public.accessibility.describes-video"],
				startSegmentNumber: 0,
				endSegmentNumber: 8,
			},
			streams: {
				forceFrameRateAttribute: true,
				forceVideoRangeAttribute: false,
				video: "alternate",
				audioGroups: {
					droppingMode: "AUDIO",
					groups: [{ name: "audio", priority: 1 }],
				},
			},
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: video.key,
					uri: "alternate.m3u8",
				},
				{
					type: "CLOSED_CAPTIONS",
					name: "English",
					groupId: "cc",
					muxingKey: video.key,
					instreamId: "CC1",
				},
				{
					type: "VTT",
					name: "Japanese",
					groupId: "subtitles",
					vttUrl: "https://example.test/sub.vtt",
					uri: "subtitles.m3u8",
				},
			],
			mediaCustomTags: [
				{ positionMode: "SEGMENT", segment: 1, data: "#EXT-X-CUSTOM:VALUE=1" },
			],
			streamCustomTags: [
				{
					positionMode: "KEYFRAME",
					keyframeKey: "cue",
					data: "#EXT-X-CUSTOM:VALUE=2",
				},
			],
		};
		expect(errors(plan)).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")?.payload,
		).toMatchObject(manifest.detailed.audioMedia ?? {});
		const variant = ops.find((op) => op.kind === "CREATE_HLS_STREAM_INFO");
		expect(variant?.payload).toMatchObject({
			forceFrameRateAttribute: true,
			forceVideoRangeAttribute: false,
			video: "alternate",
			audioGroups: { droppingMode: "AUDIO" },
		});
		expect(variant?.payload).not.toHaveProperty("audio");
		expect(
			ops.filter((op) =>
				[
					"CREATE_HLS_VIDEO_MEDIA",
					"CREATE_HLS_CLOSED_CAPTIONS_MEDIA",
					"CREATE_HLS_VTT_MEDIA",
				].includes(op.kind),
			),
		).toHaveLength(3);
		expect(
			ops
				.filter((op) => op.kind === "CREATE_HLS_CUSTOM_TAG")
				.some((op) => op.refs.keyframeId === "keyframe:cue"),
		).toBe(true);
	});

	it("uses the default API with typed nested conditions and resolved encoding references", () => {
		const plan = base();
		plan.generation.timing = "POST_ENCODING";
		for (const manifest of plan.manifests)
			if (manifest.kind !== "SMOOTH") manifest.generationMode = "DEFAULT";
		const dash = plan.manifests.find((m) => m.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing");
		dash.audioLanguage = "en";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "AND",
						conditions: [
							{
								type: "CONDITION",
								attribute: "video.codec",
								operator: "==",
								value: "AV1",
							},
							{
								type: "OR",
								conditions: [
									{
										type: "CONDITION",
										attribute: "video.height",
										operator: ">=",
										value: "720",
									},
								],
							},
						],
					},
				],
			},
		];
		expect(errors(plan)).toEqual([]);
		const ops = compilePlan(plan);
		const manifestOps = ops.filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifestOps).toHaveLength(2);
		expect(ops.some((op) => op.kind === "CREATE_DASH_PERIOD")).toBe(false);
		expect(
			manifestOps.find((op) => op.kind === "CREATE_MANIFEST_DASH")?.refs[
				"periodEncodingIds:0"
			],
		).toEqual(["encoding"]);
		expect(
			manifestOps.find((op) => op.kind === "CREATE_MANIFEST_DASH")?.payload
				.periods,
		).toEqual([{ adaptationSets: dash.defaultPeriods[0]?.adaptationSets }]);
	});

	it.each([
		"range",
		"keyframe",
		"dependency",
		"cycle",
		"default",
		"xml",
	])("rejects invalid %s settings before API execution", (kind) => {
		const plan = base();
		const dash = plan.manifests.find((m) => m.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing");
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("missing muxing");
		dash.detailed =
			kind === "range"
				? {
						representations: [
							{
								muxingKey: muxing.key,
								startSegmentNumber: 5,
								endSegmentNumber: 1,
							},
						],
					}
				: kind === "keyframe"
					? {
							representations: [
								{ muxingKey: muxing.key, startKeyframeKey: "missing" },
							],
						}
					: kind === "dependency"
						? {
								representations: [
									{ muxingKey: muxing.key, dependencyMuxingKey: "missing" },
								],
							}
						: kind === "cycle"
							? {
									representations: [
										{ muxingKey: muxing.key, dependencyMuxingKey: muxing.key },
									],
								}
							: kind === "xml"
								? {
										period: {
											customXmlElements: [
												'<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]>',
											],
										},
									}
								: {};
		if (kind === "default") dash.generationMode = "DEFAULT";
		expect(
			errors(plan).some(
				(issue) => issue.code === "PLAN_MANIFEST_DETAIL_INVALID",
			),
		).toBe(true);
	});

	it("rejects keyframe ranges from another encoding, reversed times, and dependencies with no emitted representation", () => {
		const plan = base();
		plan.encodings = [
			{ key: "first", name: "First" },
			{ key: "other", name: "Other" },
		];
		const video = plan.muxings[0];
		if (!video) throw new Error("missing muxing");
		const dash = plan.manifests.find((m) => m.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH");
		plan.keyframes = [
			{ key: "late", time: 10, encodingKey: "first" },
			{ key: "early", time: 1, encodingKey: "other" },
		];
		plan.muxings.push({
			key: "ts-only",
			kind: "TS",
			streamKey: video.streamKey,
			additionalStreamKeys: [],
			segmentLength: 4,
			segmentNaming: "segment_%number%.ts",
			destination: { outputKey: "origin", path: "other/" },
		});
		dash.detailed = {
			representations: [
				{
					muxingKey: video.key,
					startKeyframeKey: "late",
					endKeyframeKey: "early",
					dependencyMuxingKey: "ts-only",
				},
			],
		};
		const messages = errors(plan)
			.filter((issue) => issue.code === "PLAN_MANIFEST_DETAIL_INVALID")
			.map((issue) => issue.message);
		expect(messages).toContain(
			"The keyframe must belong to the same encoding as the selected muxing",
		);
		expect(messages).toContain(
			"The final keyframe must be after the first keyframe",
		);
		expect(
			messages.some((message) =>
				message.includes("No static dependency representation"),
			),
		).toBe(true);
	});

	it("rejects deeply nested or wide Default conditions before recursive parsing", () => {
		let nested: unknown = {
			type: "CONDITION",
			attribute: "video.codec",
			operator: "==",
			value: "H264",
		};
		for (let i = 0; i < 2000; i++)
			nested = { type: "AND", conditions: [nested] };
		expect(() => manifestConditionSchema.safeParse(nested)).not.toThrow();
		expect(manifestConditionSchema.safeParse(nested).success).toBe(false);
		expect(
			manifestConditionSchema.safeParse({
				type: "OR",
				conditions: Array.from({ length: 1000 }, () => ({
					type: "CONDITION",
					attribute: "video.height",
					operator: ">",
					value: "720",
				})),
			}).success,
		).toBe(false);
	});

	it("adds external subtitles, sprites and progressive WebM with their own matching adaptation sets", () => {
		const plan = base();
		const video = plan.renditions.find((r) => r.codec === "AV1");
		if (!video) throw new Error("missing video");
		const dash = plan.manifests.find((m) => m.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH");
		plan.renditions.push(
			vp9RenditionSchema.parse({
				codec: "VP9",
				key: "vp9",
				ingestKey: video.ingestKey,
				width: 1280,
				height: 720,
				bitrate: 1_000_000,
			}),
		);
		plan.muxings.push({
			key: "progressive",
			kind: "WEBM",
			streamKey: "vp9",
			progressive: true,
			filename: "video.webm",
			segmentLength: 6,
			segmentNaming: "seg_%number%.chk",
			initSegmentName: "init.hdr",
			destination: { outputKey: "origin", path: "progressive/" },
		});
		plan.sprites = [
			{
				key: "scrub",
				streamKey: video.key,
				width: 160,
				distance: 10,
				unit: "SECONDS",
				filename: "sprite.jpg",
				destination: { outputKey: "origin", path: "sprites/" },
			},
		];
		dash.detailed = {
			additionalRepresentations: [
				{
					type: "VTT",
					vttUrl: "https://example.test/sub.vtt",
					lang: "ja",
					roles: ["SUBTITLE"],
				},
				{
					type: "SPRITE",
					spriteKey: "scrub",
					labels: [{ value: "Seek", lang: "en" }],
				},
				{ type: "PROGRESSIVE_WEBM", muxingKey: "progressive" },
			],
		};
		const ops = compilePlan(plan);
		expect(ops.find((op) => op.step === "muxing:progressive")?.kind).toBe(
			"CREATE_MUXING_PROGRESSIVE_WEBM",
		);
		expect(
			ops.find(
				(op) => op.kind === "CREATE_DASH_REPRESENTATION_PROGRESSIVE_WEBM",
			)?.payload,
		).toEqual({ filePath: "../../progressive/video.webm" });
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_REPRESENTATION_SPRITE")?.refs,
		).toMatchObject({
			streamId: `stream:${video.key}`,
			spriteId: "sprite:scrub",
		});
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_REPRESENTATION_VTT")?.payload,
		).toEqual({ vttUrl: "https://example.test/sub.vtt" });
		expect(
			ops.some((op) => op.step === `manifest:${dash.key}:rep:progressive`),
		).toBe(false);
	});
});
