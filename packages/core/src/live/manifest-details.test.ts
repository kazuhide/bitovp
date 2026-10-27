import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
				"utf8",
			),
		),
	);
}
const errors = (p: ReturnType<typeof fixture>) =>
	validateLiveChannel(p).filter((issue) => issue.level === "error");

describe("Live manifest details", () => {
	it("carries globals, initial Period metadata, track descriptors, ranges and dependencies without changing start settings", () => {
		const p = fixture();
		const before = compileLiveChannel(p).find(
			(op) => op.kind === "START_LIVE_ENCODING",
		);
		const hls = p.liveManifests.find((m) => m.kind === "HLS"),
			dash = p.liveManifests.find((m) => m.kind === "DASH");
		if (!hls || !dash || dash.kind !== "DASH" || hls.kind !== "HLS")
			throw new Error("missing manifests");
		const [video, audio] = p.muxings;
		if (!video || !audio) throw new Error("missing muxings");
		hls.masterVersion = "HLS_V7";
		hls.mediaVersion = "HLS_V7";
		hls.detailed = {
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			audioMedia: {
				assocLanguage: "ja",
				isDefault: false,
				startSegmentNumber: 0,
			},
			streams: {
				forceFrameRateAttribute: false,
				forceVideoRangeAttribute: true,
				startSegmentNumber: 0,
			},
			streamCustomTags: [
				{ positionMode: "TIME", time: 0, data: "#EXT-X-CUSTOM:VALUE=1" },
			],
			additionalMedia: [
				{
					type: "VTT",
					groupId: "subtitles",
					name: "Japanese",
					language: "ja",
					vttUrl: "https://example.test/sub.vtt",
					uri: "subs.m3u8",
					forced: false,
				},
			],
		};
		dash.detailed = {
			minBufferTime: 0,
			iso8601TimestampFormat: "SHORT",
			dashEditionCompatibility: "V4",
			namespaces: [{ prefix: "test", uri: "urn:test" }],
			utcTimings: [
				{
					schemeIdUri: "urn:mpeg:dash:utc:http-xsdate:2014",
					value: "https://time.example.test",
				},
			],
			period: {
				start: 0,
				duration: 100,
				customXmlElements: [
					'<SupplementalProperty schemeIdUri="urn:test" value="1"/>',
				],
			},
			videoAdaptationSet: {
				roles: ["MAIN"],
				labels: [{ value: "Video", lang: "en" }],
			},
			audioAdaptationSet: {
				roles: ["COMMENTARY"],
				accessibilities: [{ schemeIdUri: "urn:test", value: "1" }],
			},
			representations: [
				{
					muxingKey: video.key,
					startSegmentNumber: 0,
					endSegmentNumber: 8,
					dependencyMuxingKey: audio.key,
				},
			],
			additionalRepresentations: [
				{
					type: "VTT",
					vttUrl: "https://example.test/sub.vtt",
					lang: "ja",
					roles: ["SUBTITLE"],
				},
			],
		};
		expect(errors(p)).toEqual([]);
		const ops = compileLiveChannel(p);
		expect(ops.find((op) => op.kind === "START_LIVE_ENCODING")).toEqual(before);
		expect(
			ops.find((op) => op.kind === "CREATE_MANIFEST_HLS")?.payload,
		).toMatchObject({
			channelsAttributeForAudio: "ALWAYS",
			hlsMasterPlaylistVersion: "HLS_V7",
		});
		expect(
			ops.find((op) => op.kind === "CREATE_MANIFEST_DASH")?.payload,
		).toMatchObject({ minBufferTime: 0, utcTimings: dash.detailed.utcTimings });
		expect(ops.find((op) => op.kind === "CREATE_DASH_PERIOD")?.payload).toEqual(
			{ start: 0, duration: 100 },
		);
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO")?.payload,
		).toMatchObject({ roles: ["COMMENTARY"] });
		const dependent = ops.findIndex(
			(op) => op.step === `manifest:${dash.key}:rep:${video.key}`,
		);
		const dependency = ops.findIndex(
			(op) => op.step === `manifest:${dash.key}:rep:${audio.key}`,
		);
		expect(dependency).toBeLessThan(dependent);
		expect(ops[dependent]?.refs.dependencyId).toBe(
			`manifest:${dash.key}:rep:${audio.key}`,
		);
		expect(
			ops.find((op) => op.kind === "CREATE_HLS_STREAM_INFO")?.payload,
		).toMatchObject({ subtitles: "subtitles", forceFrameRateAttribute: false });
		expect(ops.some((op) => op.kind === "CREATE_HLS_CUSTOM_TAG")).toBe(true);
		expect(ops.some((op) => op.kind === "CREATE_DASH_PERIOD_XML")).toBe(true);
		expect(ops.some((op) => op.kind === "CREATE_DASH_REPRESENTATION_VTT")).toBe(
			true,
		);
	});

	it("rejects VOD keyframe IDs and non-Live representation types at the schema boundary", () => {
		const p = fixture(),
			dash = p.liveManifests.find((m) => m.kind === "DASH");
		if (!dash) throw new Error("missing DASH");
		for (const detailed of [
			{
				representations: [
					{ muxingKey: "video", startKeyframeKey: "vod-keyframe" },
				],
			},
			{ additionalRepresentations: [{ type: "SPRITE", spriteKey: "sprite" }] },
			{
				additionalRepresentations: [
					{ type: "PROGRESSIVE_WEBM", muxingKey: "webm" },
				],
			},
		])
			expect(
				liveChannelPlanSchema.safeParse({
					...p,
					liveManifests: [{ ...dash, detailed }],
				}).success,
			).toBe(false);
		const hls = p.liveManifests.find((m) => m.kind === "HLS");
		expect(
			liveChannelPlanSchema.safeParse({
				...p,
				liveManifests: [
					{
						...hls,
						detailed: {
							streamCustomTags: [
								{
									positionMode: "KEYFRAME",
									keyframeKey: "vod-keyframe",
									data: "#EXT-X-CUSTOM:1",
								},
							],
						},
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects invalid ranges, non-selected dependencies, cycles and duplicate child writers", () => {
		for (const invalid of [
			"range",
			"dependency",
			"cycle",
			"master",
			"duplicate",
		] as const) {
			const p = fixture();
			const hls = p.liveManifests.find((m) => m.kind === "HLS"),
				dash = p.liveManifests.find((m) => m.kind === "DASH"),
				muxing = p.muxings[0];
			if (
				!hls ||
				!dash ||
				!muxing ||
				hls.kind !== "HLS" ||
				dash.kind !== "DASH"
			)
				throw new Error("missing fixture");
			if (invalid === "range")
				dash.detailed = {
					representations: [
						{
							muxingKey: muxing.key,
							startSegmentNumber: 9,
							endSegmentNumber: 1,
						},
					],
				};
			if (invalid === "dependency")
				dash.detailed = {
					representations: [
						{ muxingKey: muxing.key, dependencyMuxingKey: "missing" },
					],
				};
			if (invalid === "cycle")
				dash.detailed = {
					representations: [
						{ muxingKey: muxing.key, dependencyMuxingKey: muxing.key },
					],
				};
			if (invalid === "master" || invalid === "duplicate")
				hls.detailed = {
					additionalMedia: [
						{
							type: "VTT",
							groupId: "subtitles",
							name: "Subtitles",
							vttUrl: "https://example.test/sub.vtt",
							uri: invalid === "master" ? hls.manifestName : "subtitles.m3u8",
						},
						...(invalid === "duplicate"
							? [
									{
										type: "VTT" as const,
										groupId: "subtitles",
										name: "Other",
										vttUrl: "https://example.test/other.vtt",
										uri: "subtitles.m3u8",
									},
								]
							: []),
					],
				};
			expect(errors(p).length, invalid).toBeGreaterThan(0);
		}
	});
	it("rejects duplicate representation rows and physically unreachable media outputs", () => {
		const p = fixture();
		const hls = p.liveManifests.find((m) => m.kind === "HLS"),
			dash = p.liveManifests.find((m) => m.kind === "DASH"),
			muxing = p.muxings[0],
			output = p.outputs[0];
		if (
			hls?.kind !== "HLS" ||
			dash?.kind !== "DASH" ||
			!muxing ||
			output?.kind !== "S3"
		)
			throw new Error("fixture missing");
		dash.detailed = {
			representations: [
				{ muxingKey: muxing.key },
				{ muxingKey: muxing.key, startSegmentNumber: 2 },
			],
		};
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: muxing.key,
					uri: "alternate.m3u8",
				},
			],
		};
		p.outputs.push({ ...output, key: "elsewhere", bucket: "unrelated-bucket" });
		muxing.destination = {
			outputKey: "elsewhere",
			path: muxing.destination?.path ?? "video/",
		};
		const messages = errors(p).map((issue) => issue.message);
		expect(messages.some((message) => /only one override/.test(message))).toBe(
			true,
		);
		expect(messages.some((message) => /reachable/.test(message))).toBe(true);
	});
	it("rejects segmented subtitle ranges where Live only has external VTT media", () => {
		const p = fixture();
		const hls = p.liveManifests.find((m) => m.kind === "HLS");
		if (!hls) throw new Error("HLS missing");
		expect(
			liveChannelPlanSchema.safeParse({
				...p,
				liveManifests: [
					{ ...hls, detailed: { subtitleMedia: { startSegmentNumber: 0 } } },
				],
			}).success,
		).toBe(false);
	});
});
