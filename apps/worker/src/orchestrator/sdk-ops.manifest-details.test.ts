import {
	type CompiledOperation,
	curlForStep,
	type StepLogEntry,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (init.method === "GET")
				return new Response(
					JSON.stringify({ data: { result: { items: [] } } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(String(init.body)),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: "created" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null },
		async () => {},
	);
	return { calls, sdk };
}

const pathRefs = {
	manifestId: "manifest",
	periodId: "period",
	adaptationSetId: "aset",
};
const mediaRefs = {
	drmId: "drm",
	manifestId: "manifest",
	encodingId: "enc",
	streamId: "stream",
	muxingId: "muxing",
};
type WireCase = {
	kind: CompiledOperation["kind"];
	suffix: string;
	payload: Record<string, unknown>;
	refs: CompiledOperation["refs"];
	expected: Record<string, unknown>;
};
const cases: WireCase[] = [
	...(["HLS", "DASH"] as const).map((kind) => ({
		kind: `CREATE_MANIFEST_${kind}` as CompiledOperation["kind"],
		suffix: `/${kind.toLowerCase()}`,
		payload: {
			name: kind,
			manifestName: kind === "HLS" ? "stream.m3u8" : "stream.mpd",
			outputPath: "live/test/",
			mirrorOutputPaths: ["/live/test/", "live/test/"],
			acl: "PUBLIC_READ",
			...(kind === "HLS"
				? { channelsAttributeForAudio: "ALWAYS" }
				: { minBufferTime: 0 }),
		},
		refs: { outputId: "origin", mirrorOutputIds: ["msl", "storage"] },
		expected: {
			outputs: [
				{
					outputId: "origin-id",
					outputPath: "live/test/",
					acl: [{ permission: "PUBLIC_READ" }],
				},
				{
					outputId: "msl-id",
					outputPath: "/live/test/",
					acl: [{ permission: "PUBLIC_READ" }],
				},
				{
					outputId: "storage-id",
					outputPath: "live/test/",
					acl: [{ permission: "PUBLIC_READ" }],
				},
			],
		},
	})),

	...(["HLS", "DASH"] as const).map(
		(kind): WireCase => ({
			kind: `CREATE_MANIFEST_${kind}` as CompiledOperation["kind"],
			suffix: `/${kind.toLowerCase()}/default`,
			payload: {
				generationMode: "DEFAULT",
				manifestName: kind === "HLS" ? "stream.m3u8" : "stream.mpd",
				name: kind,
				outputPath: "test/",
				...(kind === "HLS"
					? {
							hlsMasterPlaylistVersion: "HLS_V7",
							hlsMediaPlaylistVersion: "HLS_V7",
						}
					: {
							profile: "LIVE",
							version: "V2",
							periods: [
								{
									adaptationSets: [
										{
											type: "AND",
											conditions: [
												{
													type: "CONDITION",
													attribute: "video.codec",
													operator: "==",
													value: "VP9",
												},
											],
										},
									],
								},
							],
						}),
			},
			refs:
				kind === "HLS"
					? { outputId: "out", encodingId: "enc" }
					: { outputId: "out", "periodEncodingIds:0": ["enc", "enc2"] },
			expected:
				kind === "HLS"
					? { encodingId: "enc-id", hlsMasterPlaylistVersion: "7" }
					: {
							version: "V2",
							periods: [
								{
									encodingIds: ["enc-id", "enc2-id"],
									adaptationSets: [
										{
											type: "AND",
											conditions: [
												{
													type: "CONDITION",
													attribute: "video.codec",
													operator: "==",
													value: "VP9",
												},
											],
										},
									],
								},
							],
						},
		}),
	),

	{
		kind: "CREATE_MANIFEST_DASH",
		suffix: "/dash/default",
		payload: {
			generationMode: "DEFAULT",
			manifestName: "stream.mpd",
			outputPath: "test/",
			minBufferTime: 0,
			namespaces: [],
			utcTimings: [],
			periods: [{ adaptationSets: [] }],
		},
		refs: { outputId: "out", "periodEncodingIds:0": ["enc"] },
		expected: {
			minBufferTime: 0,
			periods: [{ encodingIds: ["enc-id"] }],
		},
	},
	...(["AUDIO", "SUBTITLES"] as const).map((type) => ({
		kind: `CREATE_HLS_${type}_MEDIA` as CompiledOperation["kind"],
		suffix: `/hls/manifest-id/media/${type.toLowerCase()}`,
		payload: {
			name: "English",
			groupId: "audio",
			language: "en",
			assocLanguage: "ja",
			characteristics: ["public.accessibility.describes-video"],
			forced: false,
			autoselect: false,
			isDefault: false,
			uri: "media.m3u8",
			segmentPath: "audio/",
			startSegmentNumber: 0,
			endSegmentNumber: 8,
		},
		refs: mediaRefs,
		expected: {
			assocLanguage: "ja",
			characteristics: ["public.accessibility.describes-video"],
			forced: false,
			autoselect: false,
			isDefault: false,
			startSegmentNumber: 0,
			endSegmentNumber: 8,
		},
	})),
	...(["MEDIA", "STREAM"] as const).flatMap((target) =>
		(["TIME", "SEGMENT"] as const).map((positionMode) => ({
			kind: "CREATE_HLS_CUSTOM_TAG" as const,
			suffix: `/hls/manifest-id/${target === "MEDIA" ? "media/media-id" : "streams/stream-info-id"}/custom-tags`,
			payload: {
				target,
				positionMode,
				data: "#EXT-X-CUSTOM:VALUE=1",
				...(positionMode === "TIME" ? { time: 0 } : { segment: 0 }),
			},
			refs: {
				manifestId: "manifest",
				mediaId: "media",
				streamInfoId: "stream-info",
			},
			expected: {
				positionMode,
				...(positionMode === "TIME" ? { time: 0 } : { segment: 0 }),
			},
		})),
	),

	{
		kind: "CREATE_MANIFEST_HLS",
		suffix: "/hls",
		payload: {
			manifestName: "stream.m3u8",
			name: "HLS",
			outputPath: "test/",
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			hlsMasterPlaylistVersion: "HLS_V7",
			hlsMediaPlaylistVersion: "HLS_V7",
		},
		refs: { outputId: "out" },
		expected: {
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			hlsMasterPlaylistVersion: "7",
		},
	},
	{
		kind: "CREATE_MANIFEST_DASH",
		suffix: "/dash",
		payload: {
			manifestName: "stream.mpd",
			name: "DASH",
			outputPath: "test/",
			dashEditionCompatibility: "V4",
			iso8601TimestampFormat: "SHORT",
			minBufferTime: 3,
			namespaces: [{ prefix: "test", uri: "urn:test" }],
			utcTimings: [
				{
					schemeIdUri: "urn:mpeg:dash:utc:http-xsdate:2014",
					value: "https://time.example.test/",
				},
			],
		},
		refs: { outputId: "out" },
		expected: {
			minBufferTime: 3,
			dashEditionCompatibility: "V4",
			iso8601TimestampFormat: "SHORT",
			namespaces: [{ prefix: "test", uri: "urn:test" }],
		},
	},
	{
		kind: "CREATE_DASH_PERIOD",
		suffix: "/dash/manifest-id/periods",
		payload: { start: 0, duration: 10 },
		refs: { manifestId: "manifest" },
		expected: { start: 0, duration: 10 },
	},
	{
		kind: "CREATE_DASH_PERIOD_XML",
		suffix: "/dash/manifest-id/periods/period-id/custom-xml-elements",
		payload: {
			data: '<SupplementalProperty schemeIdUri="urn:test" value="1"/>',
		},
		refs: pathRefs,
		expected: {
			data: '<SupplementalProperty schemeIdUri="urn:test" value="1"/>',
		},
	},
	...(["VIDEO", "AUDIO", "SUBTITLE", "IMAGE"] as const).map((type) => ({
		kind: `CREATE_DASH_ADAPTATION_SET_${type}` as CompiledOperation["kind"],
		suffix: `/dash/manifest-id/periods/period-id/adaptationsets/${type.toLowerCase()}`,
		payload: {
			lang: "en",
			roles: ["MAIN"],
			labels: [{ value: "Main", lang: "en" }],
			accessibilities: [{ schemeIdUri: "urn:test", value: "1" }],
			customAttributes: [{ key: "selectionPriority", value: "1" }],
		},
		refs: pathRefs,
		expected: {
			roles: ["MAIN"],
			labels: [{ value: "Main", lang: "en" }],
			accessibilities: [{ schemeIdUri: "urn:test", value: "1" }],
		},
	})),
	...(["FMP4", "CMAF", "WEBM", "CHUNKED_TEXT"] as const).map((type) => ({
		kind: `CREATE_DASH_REPRESENTATION_${type}` as CompiledOperation["kind"],
		suffix: `/dash/manifest-id/periods/period-id/adaptationsets/aset-id/representations/${type === "CHUNKED_TEXT" ? "chunked-text" : type.toLowerCase()}`,
		payload: {
			type: "TIMELINE",
			mode: "TEMPLATE_REPRESENTATION",
			segmentPath: "video/",
			startSegmentNumber: 0,
			endSegmentNumber: 5,
		},
		refs: {
			...pathRefs,
			encodingId: "enc",
			muxingId: "muxing",
			dependencyId: "dependency",
			startKeyframeId: "cue",
		},
		expected: {
			type: "TIMELINE",
			mode: "TEMPLATE_REPRESENTATION",
			startSegmentNumber: 0,
			endSegmentNumber: 5,
			dependencyId: "dependency-id",
			startKeyframeId: "cue-id",
		},
	})),
	{
		kind: "CREATE_DASH_REPRESENTATION_FMP4",
		suffix:
			"/dash/manifest-id/periods/period-id/adaptationsets/aset-id/representations/fmp4/drm",
		payload: { type: "TEMPLATE", segmentPath: "video/", startSegmentNumber: 0 },
		refs: { ...pathRefs, encodingId: "enc", muxingId: "muxing", drmId: "drm" },
		expected: { type: "TEMPLATE", drmId: "drm-id", startSegmentNumber: 0 },
	},
	{
		kind: "CREATE_DASH_REPRESENTATION_PROGRESSIVE_WEBM",
		suffix:
			"/dash/manifest-id/periods/period-id/adaptationsets/aset-id/representations/progressive-webm",
		payload: { filePath: "video/file.webm" },
		refs: {
			...pathRefs,
			encodingId: "enc",
			muxingId: "muxing",
			dependencyId: "dependency",
		},
		expected: { filePath: "video/file.webm", dependencyId: "dependency-id" },
	},
	{
		kind: "CREATE_DASH_REPRESENTATION_VTT",
		suffix:
			"/dash/manifest-id/periods/period-id/adaptationsets/aset-id/representations/vtt",
		payload: { vttUrl: "https://example.test/sub.vtt" },
		refs: pathRefs,
		expected: { vttUrl: "https://example.test/sub.vtt" },
	},
	{
		kind: "CREATE_DASH_REPRESENTATION_SPRITE",
		suffix:
			"/dash/manifest-id/periods/period-id/adaptationsets/aset-id/representations/sprite",
		payload: { segmentPath: "sprites/" },
		refs: {
			...pathRefs,
			encodingId: "enc",
			streamId: "stream",
			spriteId: "sprite",
		},
		expected: {
			segmentPath: "sprites/",
			spriteId: "sprite-id",
			streamId: "stream-id",
		},
	},
	...(["FMP4", "WEBM", "CMAF", "FMP4_DRM", "ADAPTATION_SET"] as const).map(
		(type) => ({
			kind: "CREATE_DASH_CONTENT_PROTECTION" as const,
			suffix: `/dash/manifest-id/periods/period-id/adaptationsets/aset-id/${type === "ADAPTATION_SET" ? "" : `representations/${type === "FMP4_DRM" ? "fmp4/drm" : type.toLowerCase()}/rep-id/`}contentprotection`,
			payload: { representationKind: type },
			refs: {
				...pathRefs,
				...(type === "ADAPTATION_SET" ? {} : { representationId: "rep" }),
				encodingId: "enc",
				muxingId: "muxing",
				drmId: "drm",
				dependencyId: "dependency",
			},
			expected: { drmId: "drm-id", dependencyId: "dependency-id" },
		}),
	),
	...(["VIDEO", "CLOSED_CAPTIONS", "VTT"] as const).map((type) => ({
		kind: `CREATE_HLS_${type}_MEDIA` as CompiledOperation["kind"],
		suffix: `/hls/manifest-id/media/${type === "CLOSED_CAPTIONS" ? "closed-captions" : type.toLowerCase()}`,
		payload: {
			name: "English",
			groupId: "group",
			language: "en",
			assocLanguage: "ja",
			characteristics: ["public.accessibility.describes-video"],
			isDefault: false,
			autoselect: true,
			uri: "media.m3u8",
			vttUrl: "https://example.test/sub.vtt",
			segmentPath: "video/",
			instreamId: "CC1",
		},
		refs: mediaRefs,
		expected: {
			assocLanguage: "ja",
			characteristics: ["public.accessibility.describes-video"],
			isDefault: false,
		},
	})),
	{
		kind: "CREATE_HLS_STREAM_INFO",
		suffix: "/hls/manifest-id/streams",
		payload: {
			audioGroups: {
				droppingMode: "AUDIO",
				groups: [{ name: "audio", priority: 1 }],
			},
			video: "video",
			closedCaptions: "NONE",
			segmentPath: "video/",
			uri: "video.m3u8",
			forceFrameRateAttribute: false,
			forceVideoRangeAttribute: true,
			startSegmentNumber: 0,
			endSegmentNumber: 5,
		},
		refs: mediaRefs,
		expected: {
			audioGroups: {
				droppingMode: "AUDIO",
				groups: [{ name: "audio", priority: 1 }],
			},
			forceFrameRateAttribute: false,
			forceVideoRangeAttribute: true,
			startSegmentNumber: 0,
		},
	},
	...(["MEDIA", "STREAM"] as const).map((target) => ({
		kind: "CREATE_HLS_CUSTOM_TAG" as const,
		suffix: `/hls/manifest-id/${target === "MEDIA" ? "media/media-id" : "streams/stream-info-id"}/custom-tags`,
		payload: {
			target,
			positionMode: "KEYFRAME",
			data: "#EXT-X-CUSTOM:VALUE=1",
		},
		refs: {
			manifestId: "manifest",
			mediaId: "media",
			streamInfoId: "stream-info",
			keyframeId: "cue",
		},
		expected: {
			positionMode: "KEYFRAME",
			keyframeId: "cue-id",
			data: "#EXT-X-CUSTOM:VALUE=1",
		},
	})),
];

describe("manifest detail installed SDK wire paths", () => {
	it.each(cases)("$kind $suffix preserves API fields", async (test) => {
		const { calls, sdk } = setup();
		const op: CompiledOperation = {
			step: "test",
			kind: test.kind,
			payload: test.payload,
			refs: test.refs,
		};
		const ids = new Map(
			Object.values(test.refs)
				.flat()
				.map((key) => [key, `${key}-id`]),
		);
		const result = await executeStep(op, {
			sdk,
			ids,
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe(`/v1/encoding/manifests${test.suffix}`);
		expect(calls[0]?.body).toMatchObject(test.expected);
		const snapshot = structuredClone(result.request);
		const entry: StepLogEntry = {
			...op,
			status: "DONE",
			request: result.request,
		};
		const curl = curlForStep(entry);
		expect(curl.ok).toBe(true);
		if (!curl.ok) throw new Error(curl.code);
		expect(curl.command).toContain(`https://api.bitmovin.com${calls[0]?.path}`);
		const body = curl.command.match(/--data '([\s\S]*)'$/)?.[1];
		expect(body).toBeDefined();
		expect(JSON.parse(body ?? "{}")).toEqual(calls[0]?.body);
		expect(result.request).toEqual(snapshot);
	});

	it("serializes Default DASH condition discriminators and encoding IDs", async () => {
		const { calls, sdk } = setup();
		await sdk.createDefaultDashManifest({
			manifestName: "stream.mpd",
			name: "DASH",
			destination: { outputId: "out", outputPath: "test/" },
			version: "V2",
			profile: "LIVE",
			minBufferTime: 3,
			periods: [
				{
					encodingIds: ["encoding-id"],
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
			],
		});
		expect(calls[0]?.path).toBe("/v1/encoding/manifests/dash/default");
		expect(calls[0]?.body).toMatchObject({
			profile: "LIVE",
			version: "V2",
			minBufferTime: 3,
			periods: [
				{
					encodingIds: ["encoding-id"],
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
			],
		});
		expect(calls[0]?.body).not.toHaveProperty("encodingId");
	});
});
