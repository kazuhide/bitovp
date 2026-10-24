import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import {
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const parent = "fixedResolutionAndBitrateConfiguration";
const children = [
	"forcedRenditionAboveHighestFixedRepresentation",
	"forcedRenditionAboveHighestFixedRepresentationFactor",
	"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
] as const;
const malformed = [true, false, [], null, 5, "invalid"];
const methods = ["default", "constraints"] as const;

function goalWithChild(
	child: (typeof children)[number],
	method: (typeof methods)[number],
): PerTitleGoal {
	return {
		strategy: "automatic",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 6,
		countPolicy: { kind: "unrestricted" },
		adjustments: {
			global: { [`${parent}.${child}`]: { mode: "auto", method } },
		},
	};
}

const containerFindings = (goal: PerTitleGoal) =>
	analyzePerTitleSettings(goal, "cap").findings.filter(
		({ code, fields }) =>
			code === "invalid-value" && fields?.some(({ key }) => key === parent),
	);

describe("Per-Title container validation before automatic child updates", () => {
	it.each(
		malformed.flatMap((value) =>
			children.flatMap((child) =>
				methods.map((method) => ({ value, child, method })),
			),
		),
	)("retains invalid parent $value with $child/$method", ({
		value,
		child,
		method,
	}) => {
		const goal = goalWithChild(child, method);
		Object.assign(goal, { [parent]: structuredClone(value) });
		const before = structuredClone(goal);
		const resolved = tunePerTitleSettings(goal, goal);
		expect(resolved.goal[parent]).toEqual(value);
		expect(containerFindings(goal)).toContainEqual(
			expect.objectContaining({
				severity: "conflict",
				fields: [{ scope: "global", key: parent }],
			}),
		);
		expect(analyzePerTitleSettings(goal, "cap").advice).toEqual([]);
		expect(goal).toEqual(before);
	});

	it.each(
		[
			undefined,
			{},
			{
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE" as const,
			},
		].flatMap((value) =>
			children.flatMap((child) =>
				methods.map((method) => ({ value, child, method })),
			),
		),
	)("keeps valid parent $value usable with $child/$method", ({
		value,
		child,
		method,
	}) => {
		const goal = goalWithChild(child, method);
		if (value !== undefined) goal[parent] = structuredClone(value);
		const before = structuredClone(goal);
		const resolved = tunePerTitleSettings(goal, goal);
		for (const sibling of children.filter((key) => key !== child))
			expect(resolved.goal[parent]?.[sibling]).toEqual(goal[parent]?.[sibling]);
		expect(containerFindings(goal)).toEqual([]);
		expect(goal).toEqual(before);
	});

	it.each(
		malformed,
	)("allows explicit container replacement to repair invalid parent %j", (value) => {
		const goal = goalWithChild(children[1], "default");
		Object.assign(goal, { [parent]: structuredClone(value) });
		const before = structuredClone(goal);
		const replacement = { ...goal, [parent]: {} };
		const edited = setPerTitleSetting(
			replacement,
			"global",
			`${parent}.${children[1]}`,
			1.25,
		);
		expect(edited[parent]).toEqual({ [children[1]]: 1.25 });
		expect(containerFindings(edited)).toEqual([]);
		expect(tunePerTitleSettings(edited, goal).goal[parent]).toEqual({
			[children[1]]: 1.25,
		});
		expect(goal).toEqual(before);
	});
});
