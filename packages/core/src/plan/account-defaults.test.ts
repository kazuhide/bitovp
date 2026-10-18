import { describe, expect, it } from "vitest";
import { applyAccountDefaultsToPlan } from "./account-defaults";
import { compilePlan } from "./compiler";
import { loadPlan } from "./test-support";

/**
 * The account-default injection (fix for the "dead config" audit finding): the
 * BitmovinAccount's fallbackRegions / schedulingPriority / prewarmedPoolIds were
 * collected in Settings but never reached a create/start payload. These tests
 * prove the injection wires them through to the CREATE_ENCODING and
 * START_ENCODING op payloads, and that the absent case stays byte-identical
 * (the 56 compiler goldens already prove the unset path globally).
 */

describe("applyAccountDefaultsToPlan", () => {
	it("injects fallback regions, scheduling priority, and prewarmed pools", () => {
		const out = applyAccountDefaultsToPlan(
			loadPlan("fixed-bitrate-hls-on-aws"),
			{
				fallbackRegions: ["EUROPE", "ASIA"],
				schedulingPriority: 80,
				prewarmedPoolIds: ["pool-1"],
			},
		);
		expect(out.bitmovin.fallbackCloudRegions).toEqual(["EUROPE", "ASIA"]);
		expect(out.bitmovin.schedulingPriority).toBe(80);
		expect(out.bitmovin.prewarmedEncoderPoolIds).toEqual(["pool-1"]);
	});

	it("leaves fields undefined when the account carries no defaults", () => {
		const out = applyAccountDefaultsToPlan(
			loadPlan("fixed-bitrate-hls-on-aws"),
			{},
		);
		expect(out.bitmovin.fallbackCloudRegions).toBeUndefined();
		expect(out.bitmovin.schedulingPriority).toBeUndefined();
		expect(out.bitmovin.prewarmedEncoderPoolIds).toBeUndefined();
	});

	it("treats empty default arrays as no-injection (stays undefined)", () => {
		const out = applyAccountDefaultsToPlan(
			loadPlan("fixed-bitrate-hls-on-aws"),
			{
				fallbackRegions: [],
				prewarmedPoolIds: [],
			},
		);
		expect(out.bitmovin.fallbackCloudRegions).toBeUndefined();
		expect(out.bitmovin.prewarmedEncoderPoolIds).toBeUndefined();
	});

	it("lets a value already on the plan win over the account default", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const withValue = {
			...plan,
			bitmovin: { ...plan.bitmovin, fallbackCloudRegions: ["NORTH_AMERICA"] },
		};
		const out = applyAccountDefaultsToPlan(withValue, {
			fallbackRegions: ["EUROPE"],
		});
		expect(out.bitmovin.fallbackCloudRegions).toEqual(["NORTH_AMERICA"]);
	});
});

describe("compilePlan threads the injected defaults into op payloads", () => {
	it("emits fallbackCloudRegions on CREATE_ENCODING and scheduling on START_ENCODING", () => {
		const plan = applyAccountDefaultsToPlan(
			loadPlan("fixed-bitrate-hls-on-aws"),
			{
				fallbackRegions: ["EUROPE"],
				schedulingPriority: 80,
				prewarmedPoolIds: ["pool-1"],
			},
		);
		const ops = compilePlan(plan);

		const create = ops.find((op) => op.kind === "CREATE_ENCODING");
		expect(create?.payload).toMatchObject({
			fallbackCloudRegions: ["EUROPE"],
		});

		const start = ops.find((op) => op.kind === "START_ENCODING");
		expect(start?.payload).toMatchObject({
			scheduling: { priority: 80, prewarmedEncoderPoolIds: ["pool-1"] },
		});
	});

	it("emits neither key when the account carries no defaults (byte-stable)", () => {
		const ops = compilePlan(loadPlan("fixed-bitrate-hls-on-aws"));
		const create = ops.find((op) => op.kind === "CREATE_ENCODING");
		const start = ops.find((op) => op.kind === "START_ENCODING");
		expect(create?.payload).not.toHaveProperty("fallbackCloudRegions");
		expect(start?.payload).not.toHaveProperty("scheduling");
	});

	it("emits only priority when no prewarmed pools are set", () => {
		const plan = applyAccountDefaultsToPlan(
			loadPlan("fixed-bitrate-hls-on-aws"),
			{
				schedulingPriority: 10,
			},
		);
		const start = compilePlan(plan).find((op) => op.kind === "START_ENCODING");
		expect(start?.payload.scheduling).toEqual({ priority: 10 });
	});
});
