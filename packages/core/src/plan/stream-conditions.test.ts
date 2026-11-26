import { describe, expect, it } from "vitest";
import { checkStreamConditions } from "./stream-condition-validation";
import {
	type StreamCondition,
	streamConditionSchema,
} from "./stream-conditions";

const cmp = { attribute: "WIDTH", operator: "EQUAL", value: "1920" } as const;
const group = (conditions: StreamCondition[]): StreamCondition => ({
	type: "AND",
	conditions,
});
describe("stream condition validation", () => {
	it("bounds expert JSON before recursion and accepts the documented boundary", () => {
		let nested: StreamCondition = cmp;
		for (let i = 0; i < 8; i++) nested = group([nested]);
		expect(streamConditionSchema.safeParse(nested).success).toBe(true);
		expect(streamConditionSchema.safeParse(group([nested])).success).toBe(
			false,
		);
		expect(streamConditionSchema.safeParse(group([])).success).toBe(false);
		expect(
			streamConditionSchema.safeParse(group(Array(33).fill(cmp))).success,
		).toBe(false);
		const block = group(Array(32).fill(cmp));
		expect(
			streamConditionSchema.safeParse(group([block, block, block, block]))
				.success,
		).toBe(false);
		expect(
			streamConditionSchema.safeParse({
				...cmp,
				type: "AND",
				conditions: [cmp],
			}).success,
		).toBe(false);
		expect(
			streamConditionSchema.safeParse({ type: "NOT", conditions: [cmp] })
				.success,
		).toBe(false);
	});
	it.each([
		["H264", "FPS", "24000/1001", true, true],
		["H264", "FPS", "10/0", true, false],
		["H264", "BITRATE", "100000", false, true],
		["H264", "BITRATE", "100000", true, false],
		["AAC", "STREAMID", "0x101", true, true],
		["AAC", "STREAMID", "0xz", false, false],
		["AAC", "SAMPLERATE", "48.2", true, false],
		["AAC", "WIDTH", "1080", false, false],
		["WEBVTT", "HEARINGIMPAIRED", "false", false, true],
		["AAC", "HEARINGIMPAIRED", "true", false, false],
		["AAC", "DURATION", "25.5", false, true],
		["H264", "DURATION", "9", true, false],
		["H264", "INPUTSTREAM", "yes", true, false],
		["IMSC", "LANGUAGE", "und", false, true],
	] as const)("checks %s %s %s with live=%s", (codec, attribute, value, live, ok) => {
		const issues = checkStreamConditions(
			[{ codec, conditions: group([{ attribute, value, operator: "EQUAL" }]) }],
			live,
		);
		expect(issues.filter((i) => i.level === "error")).toHaveLength(ok ? 0 : 1);
		if (!ok)
			expect(issues[0]?.path).toBe("renditions[0].conditions.conditions[0]");
	});
	it("retains a legacy custom comparison and identifies unsupported boolean comparisons", () => {
		expect(
			checkStreamConditions(
				[
					{
						codec: "H264",
						conditions: { ...cmp, attribute: "FUTURE_ATTRIBUTE" },
					},
				],
				false,
			)[0]?.level,
		).toBe("warning");
		expect(
			checkStreamConditions(
				[
					{
						codec: "AAC",
						conditions: {
							attribute: "INPUTSTREAM",
							operator: "NOT_EQUAL",
							value: "false",
						},
					},
				],
				false,
			)[0]?.level,
		).toBe("error");
	});
});
