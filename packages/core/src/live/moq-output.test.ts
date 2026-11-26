import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema, planOutputSchema } from "../plan/schema";
import { validatePlan } from "../plan/validate";
import { compileLiveChannel } from "./compiler";
import { resolveLiveEncodingOption } from "./encoding-option";
import {
	bindMoqPlaybackNamespace,
	MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH,
} from "./moq-run-namespace";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

const credentialId = "00000000-0000-4000-8000-000000000001";

function rawPlan() {
	const raw = JSON.parse(
		readFileSync(
			new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
			"utf8",
		),
	);
	raw.outputs = [
		{
			key: "origin",
			kind: "MOQ",
			credentialId,
			name: "MoQ evaluation",
			trackNamespace: ["bitovp", "evaluation"],
			draftVersion: "DRAFT_18",
		},
	];
	raw.liveManifests = [];
	raw.start.encodingOption = "CUSTOM";
	return raw;
}

function moqPlan() {
	return liveChannelPlanSchema.parse(rawPlan());
}

describe("MoQ Live output", () => {
	it("derives distinct bounded single-field namespaces and keeps retries stable", () => {
		const first = "00000000-0000-4000-8000-000000000001";
		const second = "00000000-0000-4000-8000-000000000002";
		const base = [`a${"🎥".repeat(MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH)}`];
		const bound = bindMoqPlaybackNamespace(base, first);
		expect(bound).toEqual([`a${"🎥".repeat(489)}-bitovp-${first}`]);
		expect(bindMoqPlaybackNamespace(bound, first)).toEqual(bound);
		expect(bindMoqPlaybackNamespace(base, second)).not.toEqual(bound);
		const tuple = ["prefix", "configured"];
		expect(bindMoqPlaybackNamespace(tuple, first)).toEqual(tuple);
	});

	it.each([
		"DRAFT_16",
		"DRAFT_18",
	])("accepts dedicated H264/AAC FMP4 delivery with %s and no manifests", (draftVersion) => {
		const raw = rawPlan();
		raw.outputs[0].draftVersion = draftVersion;
		const plan = liveChannelPlanSchema.parse(raw);
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("accepts manifest-free CMAF delivery to the MoQ relay", () => {
		const raw = rawPlan();
		raw.muxings = raw.muxings.map((muxing: { streamKey: string }) => ({
			...muxing,
			kind: "CMAF",
			segmentLength: 0.5,
			...(muxing.streamKey === "v720" ? { framesPerCmafChunk: 3 } : {}),
		}));
		const plan = liveChannelPlanSchema.parse(raw);
		expect(validateLiveChannel(plan)).toEqual([]);
	});

	it("compiles tuple/draft fields and vault reference without relay secrets", () => {
		const ops = compileLiveChannel(moqPlan());
		expect(ops.find((op) => op.step === "output:origin")).toEqual({
			step: "output:origin",
			kind: "CREATE_OUTPUT_MOQ",
			payload: {
				name: "MoQ evaluation",
				credentialId,
				trackNamespace: ["bitovp", "evaluation"],
				draftVersion: "DRAFT_18",
			},
			refs: {},
		});
		const muxings = ops.filter((op) => op.kind === "CREATE_MUXING_FMP4");
		expect(muxings).toHaveLength(4);
		for (const muxing of muxings)
			expect(muxing.refs.outputId).toBe("output:origin");
		expect(ops.some((op) => op.kind.startsWith("CREATE_MANIFEST_"))).toBe(
			false,
		);
		expect(JSON.stringify(ops)).not.toMatch(/relayUrl|authToken/);
	});

	it("rejects invalid namespace/draft fields and inline relay secrets", () => {
		const output = rawPlan().outputs[0];
		for (const trackNamespace of [[], Array(33).fill("field"), [""]])
			expect(
				planOutputSchema.safeParse({ ...output, trackNamespace }).success,
			).toBe(false);
		for (const patch of [
			{ draftVersion: "DRAFT_23" },
			{ relayUrl: "moqt://relay.example:443" },
			{ authToken: "publish-secret" },
		])
			expect(planOutputSchema.safeParse({ ...output, ...patch }).success).toBe(
				false,
			);
	});

	it("retains the manifest requirement for ordinary storage delivery", () => {
		const raw = rawPlan();
		raw.outputs = [
			{ key: "origin", kind: "S3", credentialId, bucket: "output-bucket" },
		];
		expect(liveChannelPlanSchema.safeParse(raw).success).toBe(false);
	});

	it("requires a tenant-visible MoQ credential when provider facts are supplied", () => {
		const plan = moqPlan();
		for (const credentialProviders of [
			new Map<string, string>(),
			new Map([[credentialId, "AWS_S3"]]),
		])
			expect(
				validateLiveChannel(plan, { credentialProviders }).some(
					(issue) => issue.code === "LIVE_MOQ_CREDENTIAL_PROVIDER",
				),
			).toBe(true);
		expect(
			validateLiveChannel(plan, {
				credentialProviders: new Map([[credentialId, "MOQ"]]),
			}).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each(["TS", "MP4"])("rejects %s muxings", (kind) => {
		const raw = rawPlan();
		raw.muxings[0] = {
			key: "v1080",
			kind,
			streamKey: "v1080",
			destination: { outputKey: "origin", path: "video/" },
			...(kind === "MP4" ? { filename: "archive.mp4" } : {}),
		};
		const plan = liveChannelPlanSchema.parse(raw);
		expect(
			validateLiveChannel(plan).some(
				(issue) => issue.code === "LIVE_MOQ_MUXING_UNSUPPORTED",
			),
		).toBe(true);
	});

	it("rejects storage mixing and delivery mirrors", () => {
		const plan = moqPlan();
		plan.outputs.push({
			key: "storage",
			kind: "S3",
			credentialId,
			bucket: "output-bucket",
			name: "Storage",
		});
		plan.deliveryMirrors = [{ outputKey: "storage" }];
		const codes = validateLiveChannel(plan).map((issue) => issue.code);
		expect(codes).toContain("LIVE_MOQ_EXCLUSIVE_OUTPUT");
		expect(codes).toContain("LIVE_MOQ_MIRRORS_UNSUPPORTED");
	});

	it("rejects non H264/AAC codecs", () => {
		const raw = rawPlan();
		raw.renditions[0].codec = "H265";
		const plan = liveChannelPlanSchema.parse(raw);
		expect(
			validateLiveChannel(plan).some(
				(issue) => issue.code === "LIVE_MOQ_CODEC_UNSUPPORTED",
			),
		).toBe(true);
	});

	it("requires exactly one CMAF or FMP4 muxing for every rendition", () => {
		const plan = moqPlan();
		const first = plan.muxings[0];
		if (first?.kind !== "FMP4") throw new Error("Fixture has no FMP4 muxing");
		plan.muxings.push({ ...first, key: "duplicate", kind: "CMAF" });
		expect(
			validateLiveChannel(plan).some(
				(issue) => issue.code === "LIVE_MOQ_RENDITION_MUXING",
			),
		).toBe(true);
		plan.muxings = plan.muxings.filter((muxing) => muxing.streamKey !== "v720");
		expect(
			validateLiveChannel(plan).filter(
				(issue) => issue.code === "LIVE_MOQ_RENDITION_MUXING",
			),
		).toHaveLength(2);
	});

	it("rejects regular manifests, DRM and ad signalling", () => {
		const plan = moqPlan();
		const original = JSON.parse(
			readFileSync(
				new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
				"utf8",
			),
		);
		plan.liveManifests = original.liveManifests;
		plan.adMarkers = { scte35: true };
		plan.drm = [
			{
				key: "cenc",
				kind: "CENC",
				muxingKey: "v1080",
				credentialId,
				kid: "00000000000000000000000000000001",
				destination: { outputKey: "origin", path: "encrypted/" },
			},
		];
		const codes = validateLiveChannel(plan).map((issue) => issue.code);
		expect(codes).toContain("LIVE_MOQ_MANIFESTS_UNSUPPORTED");
		expect(codes).toContain("LIVE_MOQ_DRM_UNSUPPORTED");
		expect(codes).toContain("LIVE_MOQ_ADS_UNSUPPORTED");
	});

	it("resolves AUTO as Custom and refuses an explicit HD request", () => {
		const plan = moqPlan();
		plan.start.encodingOption = "AUTO";
		expect(resolveLiveEncodingOption(plan)).toMatchObject({
			encodingOption: "CUSTOM",
			reasons: expect.arrayContaining([
				expect.objectContaining({ code: "OUTPUT_PROTOCOL", actual: "MOQ" }),
			]),
		});
		plan.start.encodingOption = "HD";
		expect(
			validateLiveChannel(plan).some(
				(issue) => issue.code === "LIVE_HD_INCOMPATIBLE",
			),
		).toBe(true);
		expect(() => compileLiveChannel(plan)).toThrow("Live HD is incompatible");
	});

	it("rejects MoQ from VOD validation and compilation", () => {
		const raw = JSON.parse(
			readFileSync(
				new URL(
					"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		raw.outputs = rawPlan().outputs;
		const plan = encodingPlanSchema.parse(raw);
		expect(
			validatePlan(plan).some(
				(issue) => issue.code === "PLAN_LIVE_OUTPUT_ONLY",
			),
		).toBe(true);
		expect(() => compilePlan(plan)).toThrow("MoQ output is available for Live");
	});
});
