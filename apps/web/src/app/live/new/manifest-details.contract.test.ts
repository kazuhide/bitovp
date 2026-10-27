import {
	compileLiveChannel,
	curlForStep,
	liveChannelPlanSchema,
	type StepLogEntry,
	validateLiveChannel,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "../../../../../worker/src/orchestrator/executor";
import { createBitmovinSdkOps } from "../../../../../worker/src/orchestrator/sdk-ops";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";

afterEach(() => vi.unstubAllGlobals());
describe("Live manifest form-to-SDK contracts", () => {
	it.each([
		false,
		true,
	])("preserves detailed form settings in the installed SDK and cURL (encrypted=%s)", async (encrypted) => {
		const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		state.manifests.dash.enabled = true;
		state.name = "Detailed Live";
		state.accountId = "00000000-0000-4000-8000-000000000001";
		state.output.credentialId = "00000000-0000-4000-8000-000000000002";
		state.output.bucket = "test";
		state.output.basePath = "live/test/";
		const initial = buildLiveChannelPlan(state),
			video = initial.muxings[0];
		if (!video) throw new Error("Missing video");
		state.manifests.hls.detailed = {
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			audioMedia: { assocLanguage: "ja", forced: false, startSegmentNumber: 0 },
			streams: {
				forceFrameRateAttribute: false,
				forceVideoRangeAttribute: true,
			},
			additionalMedia: [
				{
					type: "VIDEO",
					muxingKey: video.key,
					name: "Alternate",
					groupId: "alternate",
					uri: "alternate.m3u8",
				},
			],
			streamCustomTags: [
				{ positionMode: "SEGMENT", segment: 0, data: "#EXT-X-CUSTOM:VALUE=1" },
			],
		};
		state.manifests.dash.detailed = {
			minBufferTime: 0,
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
			},
			representations: [
				{ muxingKey: video.key, startSegmentNumber: 0, endSegmentNumber: 9 },
			],
			additionalRepresentations: [
				{ type: "VTT", lang: "ja", vttUrl: "https://example.test/sub.vtt" },
			],
		};
		if (encrypted) {
			state.drm = initial.muxings.map((muxing) => ({
				key: `${muxing.key}-enc`,
				kind: "CENC",
				muxingKey: muxing.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "a".repeat(32),
				encryptionMode: "CBC",
				ivSize: "IV_16_BYTES",
				fairPlay: { iv: "b".repeat(32), uri: "skd://test" },
				destination: {
					outputKey: "origin",
					path: `live/encrypted/${muxing.key}/`,
				},
			}));
			state.manifests.hls.drmKind = "CENC";
			state.manifests.dash.drmKind = "CENC";
		}
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			plan.liveManifests.some((manifest) => manifest.kind === "DASH"),
		).toBe(true);
		const ops = compileLiveChannel(plan),
			ids = new Map(ops.map((op, index) => [op.step, `resource-${index}`]));
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
			{ apiKey: "not-used", tenantOrgId: null },
			async () => {},
		);
		for (const op of ops.filter((op) =>
			/^CREATE_(?:MANIFEST|HLS|DASH)_/.test(op.kind),
		)) {
			const before = calls.length;
			const result = await executeStep(op, {
				sdk,
				ids,
				resolveCredential: vi.fn(() => {
					throw new Error(
						"Manifest configuration must not retrieve content keys",
					);
				}),
				poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
			});
			expect(calls.length).toBe(before + 1);
			const entry: StepLogEntry = {
					...op,
					status: "DONE",
					request: result.request,
				},
				original = structuredClone(entry);
			const curl = curlForStep(entry);
			expect(curl.ok).toBe(true);
			if (!curl.ok) throw new Error(curl.code);
			const call = calls.at(-1);
			expect(curl.command).toContain(`https://api.bitmovin.com${call?.path}`);
			expect(
				JSON.parse(curl.command.match(/--data '([\s\S]*)'$/)?.[1] ?? "{}"),
			).toEqual(call?.body);
			expect(entry).toEqual(original);
		}
		const additional = ops.find((op) => op.kind === "CREATE_HLS_VIDEO_MEDIA");
		expect(additional?.payload.segmentPath).toContain(
			encrypted ? "encrypted/" : "video/",
		);
		if (encrypted) expect(additional?.refs.drmId).toBe(`drm:${video.key}-enc`);
	});
});
