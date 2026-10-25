import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../index";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import { compileLiveChannel } from "./compiler";
import { type LiveChannelPlan, liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function plan(): LiveChannelPlan {
	const value = JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
	value.renditions = value.renditions.map((r: Record<string, unknown>) =>
		r.codec === "H264"
			? {
					...r,
					width: r.height === 1080 ? 1920 : r.height === 720 ? 1280 : 640,
					rate: 30,
				}
			: r,
	);
	value.start.encodingOption = "AUTO";
	// Keep the fixture usable before the additive schema exists (RED).
	return value as LiveChannelPlan;
}

function video(p: LiveChannelPlan) {
	const r = p.renditions[0];
	if (r?.codec !== "H264") throw new Error("fixture video missing");
	return r;
}

function codes(p: LiveChannelPlan) {
	return core.resolveLiveEncodingOption(p).reasons.map((r) => r.code);
}

describe("Live HD option resolution", () => {
	it.each([
		"ZIXI",
		"HLS",
	] as const)("requires Custom for unconfirmed HD input protocol %s and blocks explicit HD", (kind) => {
		const p = plan();
		p.liveInput =
			kind === "ZIXI"
				? {
						key: p.liveInput.key,
						kind,
						name: "Test Zixi",
						host: "example.invalid",
						port: 2088,
						stream: "test",
						credentialId: "00000000-0000-4000-8000-000000000001",
					}
				: {
						key: p.liveInput.key,
						kind,
						name: "Test HLS",
						url: "https://example.invalid/master.m3u8",
					};
		const parsed = liveChannelPlanSchema.parse(p);
		expect(core.resolveLiveEncodingOption(parsed)).toEqual({
			encodingOption: "CUSTOM",
			reasons: [{ code: "INPUT_PROTOCOL", actual: kind }],
		});
		expect(
			validateLiveChannel(parsed).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			compileLiveChannel(parsed).find((op) => op.kind === "START_LIVE_ENCODING")
				?.payload.encodingOption,
		).toBe("CUSTOM");
		parsed.start.encodingOption = "HD";
		expect(validateLiveChannel(parsed)).toContainEqual(
			expect.objectContaining({ code: "LIVE_HD_INCOMPATIBLE", level: "error" }),
		);
		expect(() => compileLiveChannel(parsed)).toThrow(/Live HD/);
	});
	it.each([
		"RTMP",
		"REDUNDANT_RTMP",
		"SRT",
	] as const)("retains HD for supported %s input with a compatible ladder", (kind) => {
		const p = plan();
		if (kind === "REDUNDANT_RTMP")
			p.liveInput = {
				key: p.liveInput.key,
				kind,
				name: "Test redundant",
				staticIngestPoints: [{}],
			};
		if (kind === "SRT")
			p.liveInput = {
				key: p.liveInput.key,
				kind,
				name: "Test SRT",
				mode: "LISTENER",
				port: 2088,
			};
		const parsed = liveChannelPlanSchema.parse(p);
		expect(core.resolveLiveEncodingOption(parsed)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
		expect(
			compileLiveChannel(parsed).find((op) => op.kind === "START_LIVE_ENCODING")
				?.payload.encodingOption,
		).toBe("HD");
	});
	it.each([
		"CL_MONO",
		"__proto__",
		"constructor",
		"toString",
	])("rejects non-SDK AAC layout name %s before provisioning and never confirms HD", (channelLayout) => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		a.channelLayout = channelLayout;
		const parsed = liveChannelPlanSchema.safeParse(p);
		expect(parsed.success).toBe(false);
		if (!parsed.success)
			expect(parsed.error.issues[0]?.path).toEqual([
				"renditions",
				3,
				"channelLayout",
			]);
		expect(validateLiveChannel(p)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_AAC_CHANNEL_LAYOUT",
				level: "error",
				path: "renditions[3].channelLayout",
			}),
		);
		expect(core.resolveLiveEncodingOption(p)).toMatchObject({
			encodingOption: "CUSTOM",
		});
		p.start.encodingOption = "HD";
		expect(() => compileLiveChannel(p)).toThrow(/Live HD/);
	});
	it.each([
		["STEREO", "CL_STEREO", "HD"],
		["4.0", "CL_4_0", "CUSTOM"],
	] as const)("normalizes valid AAC wire value %s to %s before HD resolution", (wire, canonical, encodingOption) => {
		const p = plan();
		const audio = p.renditions.find((r) => r.codec === "AAC");
		if (audio?.codec !== "AAC") throw new Error("fixture audio missing");
		audio.channelLayout = wire;
		const parsed = liveChannelPlanSchema.parse(p);
		expect(parsed.renditions[3]).toHaveProperty("channelLayout", canonical);
		expect(
			validateLiveChannel(parsed).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(core.resolveLiveEncodingOption(parsed).encodingOption).toBe(
			encodingOption,
		);
	});
	it.each([
		"MONO",
		"CL_STEREO",
	])("keeps canonical AAC %s eligible for HD", (channelLayout) => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		a.channelLayout = channelLayout;
		expect(
			validateLiveChannel(p).filter(
				(issue) => issue.code === "LIVE_AAC_CHANNEL_LAYOUT",
			),
		).toEqual([]);
		expect(core.resolveLiveEncodingOption(p)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
	});
	it.each([
		"CL_SURROUND",
		"CL_4_0",
		"CL_5_0_BACK",
		"CL_5_1_BACK",
		"CL_7_1",
		"CL_7_1_WIDE_BACK",
	])("accepts canonical AAC %s as a valid Custom-only layout", (channelLayout) => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		a.channelLayout = channelLayout;
		expect(
			validateLiveChannel(p).filter(
				(issue) => issue.code === "LIVE_AAC_CHANNEL_LAYOUT",
			),
		).toEqual([]);
		expect(codes(p)).toContain("AUDIO_CHANNELS");
		expect(codes(p)).not.toContain("INPUT_DEPENDENT");
	});
	it("accepts NONE as input inheritance without confirming its channel count", () => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		a.channelLayout = "NONE";
		expect(
			validateLiveChannel(p).filter(
				(issue) => issue.code === "LIVE_AAC_CHANNEL_LAYOUT",
			),
		).toEqual([]);
		expect(codes(p)).toContain("INPUT_DEPENDENT");
		expect(codes(p)).not.toContain("AUDIO_CHANNELS");
	});
	it("emits explicit H264 width in Live and VOD without altering omitted-width payloads", () => {
		const p = liveChannelPlanSchema.parse(plan());
		expect(
			compileLiveChannel(p).find((op) => op.kind === "CREATE_CODEC_H264")
				?.payload.width,
		).toBe(1920);
		const vodRaw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		);
		const vod = encodingPlanSchema.parse(vodRaw);
		const r = vod.renditions.find((r) => r.codec === "H264");
		if (r?.codec !== "H264") throw new Error("fixture video missing");
		expect(
			compilePlan(vod).find((op) => op.kind === "CREATE_CODEC_H264")?.payload,
		).not.toHaveProperty("width");
		r.width = 1280;
		expect(
			compilePlan(vod).find((op) => op.kind === "CREATE_CODEC_H264")?.payload
				.width,
		).toBe(1280);
	});
	it("keeps absent legacy and explicit Custom plans Custom without migration", () => {
		const p = plan();
		delete p.start.encodingOption;
		expect(core.resolveLiveEncodingOption(p)).toEqual({
			encodingOption: "CUSTOM",
			reasons: [{ code: "LEGACY_CUSTOM" }],
		});
		p.start.encodingOption = "CUSTOM";
		expect(core.resolveLiveEncodingOption(p)).toEqual({
			encodingOption: "CUSTOM",
			reasons: [{ code: "CUSTOM_REQUESTED" }],
		});
	});
	it("uses HD for a fully specified compatible ladder without mutating it", () => {
		const p = plan();
		const before = structuredClone(p);
		expect(core.resolveLiveEncodingOption(p)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
		expect(p).toEqual(before);
	});
	it.each([
		undefined,
		"STANDARD",
		"SINGLE_PASS",
	] as const)("accepts normalized start mode %s", (mode) => {
		const p = plan();
		p.start.liveEncodingMode = mode;
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
	});
	it.each([
		"TWO_PASS",
		"THREE_PASS",
	] as const)("requires Custom for %s", (mode) => {
		const p = plan();
		p.start.liveEncodingMode = mode;
		expect(codes(p)).toContain("ENCODING_MODE");
	});
	it.each([
		"rate",
		"bitrate",
	] as const)("does not treat inherited %s as zero", (field) => {
		const p = plan();
		Object.assign(video(p), {
			[field]: field === "bitrate" ? null : undefined,
		});
		expect(core.resolveLiveEncodingOption(p)).toMatchObject({
			encodingOption: "CUSTOM",
			reasons: expect.arrayContaining([
				{ code: "INPUT_DEPENDENT", renditionKey: "v1080", actual: field },
			]),
		});
	});
	it.each([
		["width", 1080],
		["height", 1920],
	] as const)("completes a lone %s at 16:9 instead of calling it input-dependent (owner, 2026-09-11)", (missing, keptEdge) => {
		const p = plan();
		const v = video(p);
		Object.assign(v, { [missing]: missing === "height" ? null : undefined });
		expect(missing === "width" ? v.height : v.width).toBe(keptEdge);
		expect(core.resolveLiveEncodingOption(p)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
	});
	it("keeps both edges missing input-dependent", () => {
		const p = plan();
		Object.assign(video(p), { width: undefined, height: null });
		expect(codes(p)).toEqual(
			expect.arrayContaining(["INPUT_DEPENDENT", "INPUT_DEPENDENT"]),
		);
		expect(
			core
				.resolveLiveEncodingOption(p)
				.reasons.filter((r) => r.code === "INPUT_DEPENDENT")
				.map((r) => r.actual),
		).toEqual(["width", "height"]);
	});
	it.each([
		["width", 2560, "VIDEO_LONG_EDGE", 2560],
		["height", 1440, "VIDEO_LONG_EDGE", 2560],
		["height", 1201, "VIDEO_SHORT_EDGE", 1201],
	] as const)("judges a lone %s=%s at 16:9 against the Live HD edges", (edge, value, code, actual) => {
		const p = plan();
		Object.assign(video(p), {
			width: undefined,
			height: null,
			[edge]: value,
		});
		expect(core.resolveLiveEncodingOption(p).reasons).toContainEqual({
			code,
			renditionKey: "v1080",
			actual,
			limit: code === "VIDEO_LONG_EDGE" ? 1920 : 1200,
		});
	});
	it("counts a lone 720 height toward the HD rendition limit", () => {
		const p = plan();
		const v = video(p);
		p.renditions = Array.from({ length: 4 }, (_, i) => ({
			...v,
			key: `v${i}`,
			width: undefined,
			height: 720,
			bitrate: 1_000_000,
		}));
		expect(codes(p)).toContain("HD_VIDEO_COUNT");
		p.renditions = p.renditions.slice(0, 3);
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
	});
	it.each([
		["width", 1920, 1921, "VIDEO_LONG_EDGE"],
		["height", 1200, 1201, "VIDEO_SHORT_EDGE"],
		["rate", 30, 30.01, "VIDEO_FRAME_RATE"],
		["bitrate", 7_000_000, 7_000_001, "VIDEO_BITRATE"],
	] as const)("pins %s boundary and beyond", (field, bound, beyond, code) => {
		const p = plan();
		Object.assign(video(p), { [field]: bound });
		expect(codes(p)).not.toContain(code);
		Object.assign(video(p), { [field]: beyond });
		expect(codes(p)).toContain(code);
	});
	it("uses long/short edges for portrait and inclusive OR for HD count", () => {
		const p = plan();
		const v = video(p);
		p.renditions = Array.from({ length: 3 }, (_, i) => ({
			...v,
			key: `v${i}`,
			width: 720,
			height: 1280,
			bitrate: 1_000_000,
		}));
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
		p.renditions.push({ ...v, key: "fourth", width: 1280, height: 400 });
		expect(codes(p)).toContain("HD_VIDEO_COUNT");
	});
	it("allows six SD renditions but not seven", () => {
		const p = plan();
		const v = video(p);
		p.renditions = Array.from({ length: 6 }, (_, i) => ({
			...v,
			key: `v${i}`,
			width: 640,
			height: 360,
			bitrate: 1_000_000,
		}));
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
		p.renditions.push({
			...v,
			key: "seventh",
			width: 640,
			height: 360,
			bitrate: 1_000_000,
		});
		expect(codes(p)).toContain("VIDEO_COUNT");
	});
	it("pins total video pixels and bitrate independently of AAC", () => {
		const p = plan();
		const v = video(p);
		const audio = p.renditions[3];
		if (!audio) throw new Error("fixture audio missing");
		p.renditions = [
			{ ...v, key: "one", width: 1600, height: 1000, bitrate: 6_000_000 },
			{ ...v, key: "two", width: 1600, height: 1000, bitrate: 5_000_000 },
			{ ...v, key: "three", width: 1600, height: 1000, bitrate: 5_000_000 },
			audio,
		];
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
		video(p).width = 1601;
		video(p).bitrate = 6_000_001;
		expect(codes(p)).toEqual(
			expect.arrayContaining(["TOTAL_VIDEO_PIXELS", "TOTAL_VIDEO_BITRATE"]),
		);
	});
	it("pins AAC limits and rejects unknown/inherited layout", () => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		a.bitrate = 192_000;
		a.rate = 48_000;
		a.channelLayout = "CL_STEREO";
		p.renditions.push({ ...a, key: "a2" });
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
		a.bitrate++;
		a.rate++;
		a.channelLayout = "CL_5_1_BACK";
		p.renditions.push({ ...a, key: "a3" });
		expect(codes(p)).toEqual(
			expect.arrayContaining([
				"AUDIO_COUNT",
				"AUDIO_BITRATE",
				"AUDIO_SAMPLE_RATE",
				"AUDIO_CHANNELS",
			]),
		);
		a.channelLayout = "NONE";
		expect(codes(p)).toContain("INPUT_DEPENDENT");
	});
	it("uses maximum two manifests, not outputs", () => {
		const p = plan();
		const output = p.outputs[0],
			manifest = p.liveManifests[0];
		if (!output || !manifest) throw new Error("fixture output missing");
		p.outputs.push(
			{ ...output, key: "mirror2" },
			{ ...output, key: "mirror3" },
		);
		expect(core.resolveLiveEncodingOption(p).encodingOption).toBe("HD");
		p.liveManifests.push({ ...manifest, key: "third" });
		expect(codes(p)).toContain("MANIFEST_COUNT");
	});
	it("uses the parsed AAC stereo default but rejects arbitrary layout strings", () => {
		const p = plan();
		const a = p.renditions.find((r) => r.codec === "AAC");
		if (a?.codec !== "AAC") throw new Error("fixture audio missing");
		Object.assign(a, { channelLayout: undefined });
		expect(
			core.resolveLiveEncodingOption(liveChannelPlanSchema.parse(p))
				.encodingOption,
		).toBe("HD");
		a.channelLayout = "__proto__";
		expect(codes(p)).toContain("INPUT_DEPENDENT");
	});
	it("rejects non-Live presets and cannot infer SDR from inherited/HDR color transfer", () => {
		const p = plan();
		video(p).presetConfiguration = "VOD_HIGH_QUALITY";
		expect(codes(p)).toContain("PRESET_UNSUPPORTED");
		video(p).presetConfiguration = null;
		expect(codes(p)).not.toContain("PRESET_UNSUPPORTED");
		video(p).colorConfig = { copyColorTransferFlag: true };
		expect(codes(p)).toContain("INPUT_DEPENDENT");
		video(p).colorConfig = { colorTransfer: "SMPTE2084" };
		expect(codes(p)).toContain("INPUT_DEPENDENT");
	});
	it("does not label H265 as HD", () => {
		const p = plan();
		Object.assign(video(p), { codec: "H265" });
		expect(codes(p)).toContain("CODEC_UNSUPPORTED");
	});
	it("schema preserves AUTO/HD/CUSTOM and optional positive H264 width", () => {
		for (const encodingOption of ["AUTO", "HD", "CUSTOM"] as const) {
			const p = plan();
			p.start.encodingOption = encodingOption;
			expect(liveChannelPlanSchema.parse(p).start.encodingOption).toBe(
				encodingOption,
			);
		}
		const p = plan();
		video(p).width = 0;
		expect(liveChannelPlanSchema.safeParse(p).success).toBe(false);
	});
	it("compiler records only the resolved option; explicit incompatible HD is rejected", () => {
		const p = liveChannelPlanSchema.parse(plan());
		expect(
			compileLiveChannel(p).find((op) => op.kind === "START_LIVE_ENCODING")
				?.payload.encodingOption,
		).toBe("HD");
		video(p).rate = 60;
		expect(
			compileLiveChannel(p).find((op) => op.kind === "START_LIVE_ENCODING")
				?.payload.encodingOption,
		).toBe("CUSTOM");
		p.start.encodingOption = "HD";
		expect(validateLiveChannel(p)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_HD_INCOMPATIBLE",
				level: "error",
				path: "start.encodingOption",
			}),
		);
		expect(() => compileLiveChannel(p)).toThrow(/Live HD/);
	});
});
