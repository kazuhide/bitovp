import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import {
	INTERNAL_HEVC_V2_BCF_VERSION,
	isInternalHevcV2Account,
} from "./internal-hevc-v2";
import { encodingPlanSchema } from "./schema";
import { submitEncodingJob } from "./submit";
import { planToEncodingTemplateYaml } from "./template";
import { validatePlan } from "./validate";

const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
function plan() {
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
			),
			"utf8",
		),
	);
	raw.bitmovin.accountId = ACCOUNT;
	raw.internal = { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } };
	raw.renditions = raw.renditions.map((r: Record<string, unknown>) =>
		r.codec === "H264"
			? {
					key: r.key,
					ingestKey: r.ingestKey,
					codec: "H265",
					height: 720,
					bitrate: 2000000,
					mode: "STANDARD",
				}
			: r,
	);
	return raw;
}
describe("internal HEVC v2", () => {
	it("is off without an exact configured account ID", () => {
		expect(isInternalHevcV2Account(ACCOUNT, undefined)).toBe(false);
		expect(isInternalHevcV2Account(ACCOUNT, "main")).toBe(false);
		expect(isInternalHevcV2Account(ACCOUNT, ACCOUNT)).toBe(true);
		expect(
			isInternalHevcV2Account(ACCOUNT, "00000000-0000-4000-8000-0000000000bb"),
		).toBe(false);
	});
	it.each([
		"",
		"v1\r\nX-Api-Key: injected",
		"https://host/build",
		`v${"1".repeat(129)}`,
	])("rejects unsafe BCF tag %j", (tag) => {
		const raw = plan();
		raw.internal.hevcV2.bcfVersion = tag;
		expect(encodingPlanSchema.safeParse(raw).success).toBe(false);
	});
	it("accepts the explicit static H265 experiment without changing ordinary plans", () => {
		const parsed = encodingPlanSchema.parse(plan());
		expect(
			validatePlan(parsed).filter((i) =>
				i.code.startsWith("PLAN_INTERNAL_HEVC_V2"),
			),
		).toEqual([]);
		delete parsed.internal;
		expect(encodingPlanSchema.parse(parsed).internal).toBeUndefined();
	});
	it("refuses a public template that would lose the internal implementation", () => {
		expect(() =>
			planToEncodingTemplateYaml(encodingPlanSchema.parse(plan())),
		).toThrow(/cannot be exported/);
	});
	it("never accepts the internal profile on a Live plan", () => {
		const live = JSON.parse(
			readFileSync(
				join(__dirname, "../live/__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		);
		expect(liveChannelPlanSchema.safeParse(live).success).toBe(true);
		const parsed = liveChannelPlanSchema.safeParse({
			...live,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success)
			expect(
				parsed.error.issues.some(
					(i) => i.code === "unrecognized_keys" && i.keys.includes("internal"),
				),
			).toBe(true);
	});
	it("submits an explicitly allowed account and preserves the exact internal configuration", async () => {
		const createJob = vi.fn(async () => ({ id: "job-1" }));
		const result = await submitEncodingJob(plan(), {
			validationOptions: {},
			internalHevcV2AccountId: ACCOUNT,
			recordEgress: vi.fn(async () => {}),
			loadAccountDefaults: async () => ({ defaults: {} }),
			createJob,
			enqueue: vi.fn(async () => {}),
			markEnqueueFailed: vi.fn(async () => {}),
		});
		expect(result).toMatchObject({ ok: true });
		expect(createJob).toHaveBeenCalledWith(
			expect.objectContaining({
				plan: expect.objectContaining({
					internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
				}),
			}),
		);
	});
	it.each([
		"profile",
		"rcLookahead",
		"minKeyframeInterval",
		"maxKeyframeInterval",
	])("refuses unsupported H265 field %s instead of silently discarding it", (key) => {
		const raw = plan();
		const video = raw.renditions.find(
			(r: { codec: string }) => r.codec === "H265",
		);
		video[key] = key === "profile" ? "MAIN" : 20;
		expect(
			validatePlan(encodingPlanSchema.parse(raw)).some(
				(i) => i.code === "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
			),
		).toBe(true);
	});
	it("refuses fixed bitrate on per-title templates and mixed video codecs", () => {
		const raw = plan();
		const video = raw.renditions.find(
			(r: { codec: string }) => r.codec === "H265",
		);
		video.mode = "PER_TITLE_TEMPLATE";
		expect(
			validatePlan(encodingPlanSchema.parse(raw)).some(
				(i) => i.code === "PLAN_PER_TITLE_BITRATE",
			),
		).toBe(true);
		video.mode = "STANDARD";
		video.codec = "H264";
		expect(
			validatePlan(encodingPlanSchema.parse(raw)).some(
				(i) => i.code === "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
			),
		).toBe(true);
	});
	it.each([
		undefined,
		"00000000-0000-4000-8000-0000000000bb",
	])("rejects unapproved submit before any I/O (%s)", async (configured) => {
		const io = vi.fn();
		const result = await submitEncodingJob(plan(), {
			validationOptions: {},
			internalHevcV2AccountId: configured,
			recordEgress: io,
			loadAccountDefaults: io,
			createJob: io,
			enqueue: io,
			markEnqueueFailed: io,
		});
		expect(result).toMatchObject({
			ok: false,
			code: "INTERNAL_FEATURE_DISABLED",
		});
		expect(io).not.toHaveBeenCalled();
	});
});

function perTitlePlan() {
	const raw = plan();
	raw.generation.timing = "POST_ENCODING";
	raw.perTitle = {
		h265V2Configuration: {
			minBitrate: 100000,
			maxBitrate: 20000000,
			targetQualityQp: 20,
			autoRepresentations: {},
		},
	};
	raw.renditions = raw.renditions.map((r: Record<string, unknown>) =>
		r.codec === "H265"
			? {
					...r,
					height: null,
					bitrate: null,
					mode: "PER_TITLE_TEMPLATE",
					perTitleSettings: { minBitrate: 100000, maxBitrate: 20000000 },
				}
			: r,
	);
	raw.muxings = raw.muxings.map((m: Record<string, unknown>) => ({
		...m,
		destination: {
			...(m.destination as Record<string, unknown>),
			path: "video/{height}_{bitrate}_{uuid}/",
		},
	}));
	return raw;
}
it("accepts native HEVCv2 templates and submits their immutable settings", async () => {
	const raw = perTitlePlan();
	expect(
		validatePlan(encodingPlanSchema.parse(raw)).filter(
			(i) => i.level === "error",
		),
	).toEqual([]);
	const createJob = vi.fn(async () => ({ id: "pte-job" }));
	const result = await submitEncodingJob(raw, {
		validationOptions: {},
		internalHevcV2AccountId: ACCOUNT,
		recordEgress: vi.fn(async () => {}),
		loadAccountDefaults: async () => ({ defaults: {} }),
		createJob,
		enqueue: vi.fn(async () => {}),
		markEnqueueFailed: vi.fn(async () => {}),
	});
	expect(result).toMatchObject({ ok: true });
	expect(createJob).toHaveBeenCalledWith(
		expect.objectContaining({
			plan: expect.objectContaining({ perTitle: raw.perTitle }),
		}),
	);
});
it("rejects native HEVCv2 Per-Title on ordinary H265 and stale legacy START configs", () => {
	const raw = perTitlePlan();
	delete raw.internal;
	expect(
		validatePlan(encodingPlanSchema.parse(raw)).some(
			(i) => i.code === "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
		),
	).toBe(true);
	const internal = perTitlePlan();
	internal.perTitle.h265Configuration = { minBitrate: 100000 };
	expect(
		validatePlan(encodingPlanSchema.parse(internal)).some(
			(i) => i.code === "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
		),
	).toBe(true);
});
it.each([
	"targetQualityCrf",
	"codecBufsizeFactor",
])("rejects legacy %s on native HEVCv2 without silently dropping it", (key) => {
	const raw = perTitlePlan();
	raw.perTitle.h265V2Configuration[key] = 20;
	expect(encodingPlanSchema.safeParse(raw).success).toBe(false);
});
