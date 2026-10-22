import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	roundedPerTitleJointGoal,
	sharedPerTitleJointHigh,
} from "./per-title-simulator-joint-numbers";

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	countPolicy: { kind: "unrestricted" },
	minBitrateStepSize: 1.25,
	maxBitrateStepSize: 4,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
	},
	rows: [
		{
			id: "a",
			height: 240,
			minBitrate: 200_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_000_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
		{
			id: "b",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 1_600_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 3_500_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
});

describe("joint numeric candidates", () => {
	it("does not repeatedly shrink a decimal factor because of binary multiplication", () => {
		const before = source();
		const current = { ...before, maxBitrate: 8_000_000 };
		const candidate: PerTitleGoal = {
			...current,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.15,
			},
		};
		const first = roundedPerTitleJointGoal(
			before,
			current,
			candidate,
			2,
			new Set(),
		);
		expect(
			first?.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.15);
		if (!first) throw new Error("Expected an in-range numeric candidate.");
		expect(
			roundedPerTitleJointGoal(before, current, first, 2, new Set()),
		).toEqual(first);
	});

	it("rejects a common H below another eligible row's lower boundary", () => {
		const before = source();
		const candidate: PerTitleGoal = {
			...before,
			maxBitrate: 8_000_000,
			rows: before.rows?.map((row) => ({
				...row,
				lowComplexityBoundaryForMaxBitrate:
					row.id === "a" ? 1_000_000 : 6_000_000,
				highComplexityBoundaryForMaxBitrate:
					row.id === "a" ? 5_000_000 : 8_000_000,
			})),
		};
		expect(sharedPerTitleJointHigh(before, candidate, new Set())).toBeNull();
	});

	it("rejects a rounded endpoint outside an exact manually chosen overall cap", () => {
		const before = source();
		const current = { ...before, maxBitrate: 8_000_123 };
		const candidate: PerTitleGoal = {
			...current,
			rows: current.rows?.map((row) => ({
				...row,
				maxBitrate: row.id === "b" ? 8_000_120 : row.maxBitrate,
			})),
		};
		expect(
			roundedPerTitleJointGoal(before, current, candidate, 2, new Set()),
		).toBeNull();
		expect(current.maxBitrate).toBe(8_000_123);
	});
});
