import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { makeWorkerSdk } from "./make-sdk";

const account = "00000000-0000-4000-8000-000000000001";
const profile = { bcfVersion: "v2.325.0-461-g85df7fd6c6" };
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
function fixture() {
	const calls: {
		url: string;
		headers: Headers;
		body: Record<string, unknown>;
	}[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url, init) => {
			calls.push({
				url: String(url),
				headers: new Headers(init?.headers),
				body: JSON.parse(init?.body ?? "{}"),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: "config-1" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const create = vi.fn(async () => ({}));
	const sdk = makeWorkerSdk({
		auditLog: { create },
	} as unknown as AppPrismaClient);
	return { calls, create, sdk };
}
describe("internal HEVCv2 production SDK boundary", () => {
	it.each([
		"STABLE",
		"BETA",
		"LATEST",
		"2.325.0",
	])("sends encoder %s and independent BCF header together", async (encoderVersion) => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
		const { sdk, calls } = fixture();
		const ops = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
			internalHevcV2: profile,
		});
		await ops.createEncoding({
			name: "versions",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toMatch(/encoding\/encodings$/);
		expect(calls[0]?.body.encoderVersion).toBe(encoderVersion);
		expect(calls[0]?.headers.get("X-BITMOVIN-BCF-VERSION")).toBe(
			profile.bcfVersion,
		);
		expect(calls[0]?.body).not.toHaveProperty("bcfVersion");
	});
	it("fails closed before fetch for unallowed account and forged step flag", async () => {
		const { sdk, calls } = fixture();
		expect(() =>
			sdk({
				apiKey: "test",
				tenantOrgId: null,
				bitmovinAccountId: account,
				internalHevcV2: profile,
			}),
		).toThrow(/internal HEVCv2/i);
		const ordinary = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
		});
		await expect(
			ordinary.createH265Config({
				internalHevcV2: true,
				height: 720,
				bitrate: 1000000,
			}),
		).rejects.toThrow(/internal HEVCv2/i);
		expect(calls).toHaveLength(0);
	});
	it("sends a stamped narrow v2 body and per-job header while ordinary H265 stays ordinary", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
		const { sdk, calls, create } = fixture();
		const internal = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
			internalHevcV2: profile,
			stamp: { jobId: "job", currentStep: () => "codec:v" },
		});
		await internal.createH265Config({
			internalHevcV2: true,
			height: 720,
			bitrate: 1000000,
			rate: 30,
			encodingMode: "SMART_PASS",
			presetConfiguration: "VOD_HIGH_QUALITY",
		});
		expect(calls[0]?.url).toContain("/encoding/configurations/video/h265v2");
		expect(calls[0]?.headers.get("X-BITMOVIN-BCF-VERSION")).toBe(
			profile.bcfVersion,
		);
		expect(calls[0]?.body).toMatchObject({
			height: 720,
			bitrate: 1000000,
			rate: 30,
			encodingMode: "SMART_PASS",
			presetConfiguration: "VOD_HIGH_QUALITY",
			customData: { bitovp: { job: "job", step: "codec:v" } },
		});
		expect(calls[0]?.body).not.toHaveProperty("internalHevcV2");
		expect(calls[0]?.body).not.toHaveProperty(
			"motionCompensatedTemporalFiltering",
		);
		expect(calls[0]?.body).not.toHaveProperty("rateControlModeConfig");
		expect(create).toHaveBeenCalled();
		await sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
		}).createH265Config({ height: 720, bitrate: 1000000 });
		expect(calls[1]?.url).toMatch(/video\/h265$/);
		expect(calls[1]?.headers.has("X-BITMOVIN-BCF-VERSION")).toBe(false);
	});
	it("rejects wrong mode, old tuning fields, and a different account at the SDK boundary", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
		const { sdk, calls } = fixture();
		const internal = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
			internalHevcV2: profile,
		});
		await expect(
			internal.createH265Config({ internalHevcV2: true, rcLookahead: 20 }),
		).rejects.toThrow(/internal HEVCv2/i);
		await expect(
			internal.createH265Config({
				internalHevcV2: true,
				height: 720,
				encodingMode: "SMART_PASS",
				presetConfiguration: "VOD_HIGH_QUALITY",
				minKeyframeInterval: 1,
			}),
		).rejects.toThrow(/internal HEVCv2/i);
		await expect(internal.createH265Config({ height: 720 })).rejects.toThrow(
			/internal HEVCv2/i,
		);
		vi.stubEnv(
			"BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID",
			"00000000-0000-4000-8000-000000000002",
		);
		expect(() =>
			sdk({
				apiKey: "test",
				tenantOrgId: null,
				bitmovinAccountId: account,
				internalHevcV2: profile,
			}),
		).toThrow(/internal HEVCv2/i);
		await expect(internal.createH264Config({ height: 720 })).rejects.toThrow(
			/internal HEVCv2/i,
		);
		await expect(
			internal.createEncoding({
				name: "test",
				cloudRegion: "AWS_AP_NORTHEAST_1",
				encoderVersion: "STABLE",
			}),
		).rejects.toThrow(/internal HEVCv2/i);
		await expect(
			internal.startEncoding("test", { encodingMode: "SMART_PASS" }),
		).rejects.toThrow(/internal HEVCv2/i);
		expect(calls).toHaveLength(0);
	});
	it("preserves allowed shared fields through the real executor and audits the actual endpoint", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
		const { sdk, calls, create } = fixture();
		const ops = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
			internalHevcV2: profile,
		});
		const payload = {
			internalHevcV2: true,
			bcfVersion: profile.bcfVersion,
			height: 720,
			bitrate: 1000000,
			encodingMode: "SMART_PASS",
			presetConfiguration: "VOD_HIGH_QUALITY",
			pixelFormat: "YUV420P",
			levelHighTier: false,
			dynamicRangeFormat: "SDR",
			colorConfig: { colorPrimaries: "BT709" },
		};
		await executeStep(
			{ step: "codec:v", kind: "CREATE_CODEC_H265", payload, refs: {} },
			{
				sdk: ops,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
			},
		);
		expect(calls[0]?.body).toMatchObject({
			pixelFormat: "YUV420P",
			levelHighTier: false,
			dynamicRangeFormat: "SDR",
			colorConfig: { colorPrimaries: "BT709" },
		});
		expect(JSON.stringify(create.mock.calls)).toContain(
			"/encoding/configurations/video/h265v2",
		);
	});
	it("reads H265V2 bitrate and detail via v2 even without the creation allowlist", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url) => {
				const path = String(url);
				calls.push(path);
				return new Response(
					JSON.stringify({
						data: {
							result: path.endsWith("/type")
								? { type: "H265V2" }
								: { id: "cfg", height: 720, bitrate: 1000000 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const ops = makeWorkerSdk({
			auditLog: { create: vi.fn() },
		} as unknown as AppPrismaClient)({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
		});
		expect(await ops.getVideoConfigBitrate("cfg")).toBe(1000000);
		expect(await ops.getCodecConfigDetail("cfg")).toMatchObject({
			codecType: "H265V2",
			params: { bitrate: 1000000 },
		});
		expect(
			calls.filter((url) => url.endsWith("/video/h265v2/cfg")),
		).toHaveLength(2);
	});
});

describe("native HEVCv2 quality controls", () => {
	const native = {
		internalHevcV2: true as const,
		encodingMode: "SMART_PASS",
		presetConfiguration: "VOD_HIGH_QUALITY",
	};
	function setup() {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
		const { sdk, calls } = fixture();
		const ops = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
			internalHevcV2: profile,
		});
		return { ops, calls, sdk };
	}
	it("serializes width and aspect ratio within the eligible HEVCv2 profile", async () => {
		const { ops, calls } = setup();
		const geometry = {
			width: 1280,
			displayAspectRatio: { numerator: 16, denominator: 9 },
		};
		await executeStep(
			{
				step: "codec:v",
				kind: "CREATE_CODEC_H265",
				payload: { ...native, ...geometry },
				refs: {},
			},
			{
				sdk: ops,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toMatch(/video\/h265v2$/);
		expect(calls[0]?.body).toMatchObject(geometry);
		expect(calls[0]?.body).toMatchObject({
			encodingMode: "SMART_PASS",
			presetConfiguration: "VOD_HIGH_QUALITY",
		});
	});
	it("preserves OFF and every perceptual field through executor, subtype mapping and fetch", async () => {
		const { ops, calls, sdk } = setup();
		const quality = {
			motionCompensatedTemporalFiltering: "OFF",
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "OFF",
				perceptualStrength: 0,
				perceptualPenaltyStrength: 1,
				perceptualPenaltyKnee: 0.5,
				perceptualTemporalStrength: 0.25,
				pixelPerDegree: 60,
			},
		};
		await executeStep(
			{
				step: "codec:v",
				kind: "CREATE_CODEC_H265",
				payload: { ...native, ...quality },
				refs: {},
			},
			{
				sdk: ops,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toMatch(/video\/h265v2$/);
		expect(calls[0]?.body).toMatchObject(quality);
		expect(calls[0]?.headers.get("X-BITMOVIN-BCF-VERSION")).toBe(
			profile.bcfVersion,
		);
		await sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
		}).createH265Config({ height: 720, bitrate: 1000000 });
		expect(calls[1]?.url).toMatch(/video\/h265$/);
		expect(calls[1]?.headers.has("X-BITMOVIN-BCF-VERSION")).toBe(false);
		expect(calls[1]?.body).not.toHaveProperty("rateControlModeConfig");
		expect(calls[1]?.body).not.toHaveProperty(
			"motionCompensatedTemporalFiltering",
		);
	});
	it.each([
		"AUTO",
		"OFF",
		"ON",
	])("sends explicit MCTF %s without adding perceptual defaults", async (mode) => {
		const { ops, calls } = setup();
		await ops.createH265Config({
			...native,
			motionCompensatedTemporalFiltering: mode,
		} as never);
		expect(calls[0]?.body.motionCompensatedTemporalFiltering).toBe(mode);
		expect(calls[0]?.body).not.toHaveProperty("rateControlModeConfig");
	});
	it("sends CU_DELTA_QP and leaves unprovided strengths absent", async () => {
		const { ops, calls } = setup();
		await ops.createH265Config({
			...native,
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "CU_DELTA_QP",
			},
		} as never);
		expect(calls[0]?.body.rateControlModeConfig).toEqual({
			type: "PERCEPTUAL_QUALITY_MODE",
			perceptualEncodingMode: "CU_DELTA_QP",
		});
		expect(calls[0]?.body).not.toHaveProperty(
			"motionCompensatedTemporalFiltering",
		);
	});
	it("retains the exact account guard for requests using native quality controls", async () => {
		const { ops, calls } = setup();
		vi.stubEnv(
			"BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID",
			"00000000-0000-4000-8000-000000000002",
		);
		await expect(
			ops.createH265Config({
				...native,
				motionCompensatedTemporalFiltering: "OFF",
			}),
		).rejects.toThrow(/internal HEVCv2/i);
		expect(calls).toHaveLength(0);
	});
	it.each([
		{ motionCompensatedTemporalFiltering: "INVALID" },
		{ motionCompensatedTemporalFiltering: null },
		{ rateControlModeConfig: { type: "UNKNOWN" } },
		{ rateControlModeConfig: { perceptualEncodingMode: "OFF" } },
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "AUTO",
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualStrength: NaN,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualPenaltyStrength: Infinity,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualPenaltyKnee: -0.01,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualTemporalStrength: 1.01,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				pixelPerDegree: 0,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				pixelPerDegree: Infinity,
			},
		},
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				extra: { enabled: true },
			},
		},
		{ rateControlModeConfig: [] },
	])("rejects invalid controls before provider on direct SDK and executor: %j", async (quality) => {
		const { ops, calls } = setup();
		await expect(
			ops.createH265Config({ ...native, ...quality } as never),
		).rejects.toThrow();
		await expect(
			executeStep(
				{
					step: "codec:v",
					kind: "CREATE_CODEC_H265",
					payload: { ...native, ...quality },
					refs: {},
				},
				{
					sdk: ops,
					ids: new Map(),
					resolveCredential: vi.fn(),
					poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
				},
			),
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
	it.each([
		{ motionCompensatedTemporalFiltering: "OFF" },
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "OFF",
			},
		},
	])("rejects native controls for ordinary H265 rather than stripping: %j", async (quality) => {
		const { sdk, calls } = fixture();
		const ops = sdk({
			apiKey: "test",
			tenantOrgId: null,
			bitmovinAccountId: account,
		});
		await expect(
			ops.createH265Config({ height: 720, ...quality } as never),
		).rejects.toThrow(/HEVCv2/i);
		await expect(
			executeStep(
				{
					step: "codec:v",
					kind: "CREATE_CODEC_H265",
					payload: { height: 720, ...quality },
					refs: {},
				},
				{
					sdk: ops,
					ids: new Map(),
					resolveCredential: vi.fn(),
					poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
				},
			),
		).rejects.toThrow(/HEVCv2/i);
		expect(calls).toHaveLength(0);
	});
});

it.each([
	"H264",
	"H265",
	"VP9",
	"AV1",
] as const)("serializes ordinary %s encodingMode through executor and real SDK", async (codec) => {
	const { sdk, calls } = fixture();
	const ops = sdk({
		apiKey: "test",
		tenantOrgId: null,
		bitmovinAccountId: account,
	});
	await executeStep(
		{
			step: "codec:v",
			kind: `CREATE_CODEC_${codec}`,
			payload: { height: 720, bitrate: 1000000, encodingMode: "TWO_PASS" },
			refs: {},
		},
		{
			sdk: ops,
			ids: new Map(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
		},
	);
	expect(calls[0]?.url).toMatch(new RegExp(`/video/${codec.toLowerCase()}$`));
	expect(calls[0]?.body.encodingMode).toBe("TWO_PASS");
	expect(calls[0]?.headers.has("X-BITMOVIN-BCF-VERSION")).toBe(false);
});

it("sends SMART_PASS only on the HEVCv2 codec and omits mode from START", async () => {
	vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
	const { sdk, calls } = fixture();
	const ops = sdk({
		apiKey: "test",
		tenantOrgId: null,
		bitmovinAccountId: account,
		internalHevcV2: profile,
	});
	await ops.createH265Config({
		internalHevcV2: true,
		height: 720,
		bitrate: 1000000,
		encodingMode: "SMART_PASS",
		presetConfiguration: "VOD_HIGH_QUALITY",
	});
	await ops.startEncoding("encoding-1", {});
	expect(calls[0]?.body.encodingMode).toBe("SMART_PASS");
	expect(calls[1]?.url).toMatch(/encoding\/encodings\/encoding-1\/start$/);
	expect(calls[1]?.body).not.toHaveProperty("encodingMode");
});

it.each([
	"createH264Config",
	"createH265Config",
	"createVp9Config",
	"createAv1Config",
] as const)("rejects SMART_PASS on ordinary %s before fetch", async (method) => {
	const { sdk, calls } = fixture();
	const ops = sdk({
		apiKey: "test",
		tenantOrgId: null,
		bitmovinAccountId: account,
	});
	await expect(ops[method]({ encodingMode: "SMART_PASS" })).rejects.toThrow(
		/internal HEVCv2/i,
	);
	expect(calls).toHaveLength(0);
});

it.each([
	"SMART_PASS",
	"TWO_PASS",
])("rejects explicit %s on HEVCv2 START", async (encodingMode) => {
	vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
	const { sdk, calls } = fixture();
	const ops = sdk({
		apiKey: "test",
		tenantOrgId: null,
		bitmovinAccountId: account,
		internalHevcV2: profile,
	});
	await expect(
		ops.startEncoding("encoding-1", { encodingMode }),
	).rejects.toThrow(/codec, not START/);
	expect(calls).toHaveLength(0);
});

it("serializes native HEVCv2 Per-Title START and fixed template bounds with the job BCF header", async () => {
	vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", account);
	const { sdk, calls } = fixture();
	const ops = sdk({
		apiKey: "test",
		tenantOrgId: null,
		bitmovinAccountId: account,
		internalHevcV2: profile,
	});
	await ops.createH265Config({
		internalHevcV2: true,
		encodingMode: "SMART_PASS",
		presetConfiguration: "VOD_HIGH_QUALITY",
	});
	await ops.createStream("encoding-1", {
		codecConfigId: "config-1",
		inputStreamId: "input-1",
		name: "fixed",
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		perTitleSettings: {
			fixedResolutionAndBitrateSettings: {
				minBitrate: 5000000,
				maxBitrate: 5000000,
			},
		},
	});
	const configuration = {
		minBitrate: 100000,
		maxBitrate: 20000000,
		minBitrateStepSize: 1.25,
		targetQualityQp: 20,
		autoRepresentations: {},
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 0,
		},
	};
	await ops.startEncoding("encoding-1", {
		perTitle: { h265V2Configuration: configuration },
	});
	expect(calls).toHaveLength(3);
	expect(calls[0]?.url).toMatch(/video\/h265v2$/);
	expect(calls[0]?.body).not.toHaveProperty("bitrate");
	expect(calls[1]?.body).toMatchObject({
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		perTitleSettings: {
			fixedResolutionAndBitrateSettings: {
				minBitrate: 5000000,
				maxBitrate: 5000000,
			},
		},
	});
	expect(calls[2]?.body.perTitle).toEqual({
		h265V2Configuration: configuration,
	});
	expect(calls[2]?.body).not.toHaveProperty("encodingMode");
	for (const call of calls)
		expect(call.headers.get("X-BITMOVIN-BCF-VERSION")).toBe(profile.bcfVersion);
});
