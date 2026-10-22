import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	type PerTitleAdviceField,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.25,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: false,
	rows: [
		{
			id: "required",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 1_600_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [
		{ id: "base", height: 120 },
		{ id: "top", height: 1080 },
	],
});
const driver = { scope: "global", key: "maxBitrate" } as const;
const minimum: PerTitleAdviceField = {
	scope: "stream",
	rowId: "required",
	key: "minBitrate",
};
function required<T>(value: T | null | undefined): T {
	if (value == null)
		throw new Error("Expected checked advice or selected draft.");
	return value;
}

describe("selected Per-Title advice", () => {
	it.each([
		1, 2,
	])("patches only %i selected fields and leaves the source untouched", (count) => {
		const before = source(),
			current = { ...before, maxBitrate: 8_000_000 };
		const original = structuredClone(current);
		const advice = required(perTitleAdvice(before, current, driver)[0]);
		const fields = [
			minimum,
			{ scope: "global", key: "minBitrateStepSize" } as const,
		].slice(0, count);
		const next = required(applySelectedPerTitleAdvice(current, advice, fields));
		const expected = structuredClone(
			tunePerTitleSettings(current, current).proposal.api,
		);
		for (const field of fields) {
			if (field.scope === "stream") {
				const target = required(
					expected.streams.find((row) => row.rowId === field.rowId),
				);
				const proposed = required(
					advice.proposal.api.streams.find((row) => row.rowId === field.rowId),
				);
				target.perTitleSettings = {
					...target.perTitleSettings,
					minBitrate: proposed.perTitleSettings?.minBitrate,
				};
			} else
				expected.global.minBitrateStepSize =
					advice.proposal.api.global.minBitrateStepSize;
		}
		expect(tunePerTitleSettings(next, next).proposal.api).toEqual(expected);
		expect(next.maxBitrate).toBe(8_000_000);
		expect(current).toEqual(original);
	});
	it("continues the original expansion around accepted current-value anchors", () => {
		const before = source(),
			current = { ...before, maxBitrate: 8_000_000 };
		const first = required(perTitleAdvice(before, current, driver)[0]);
		const next = required(
			applySelectedPerTitleAdvice(current, first, [minimum]),
		);
		const options = { protectedFields: [minimum], appliedFields: [minimum] };
		const remaining = required(
			perTitleAdvice(before, next, driver, options)[0],
		);
		expect(remaining.goal.rows?.[0]?.minBitrate).toBe(
			next.rows?.[0]?.minBitrate,
		);
		expect(
			remaining.changes.some(
				(change) =>
					change.rowId === minimum.rowId && change.key === minimum.key,
			),
		).toBe(false);
		expect(remaining.changes.length).toBeGreaterThan(0);
		expect(applyPerTitleAdvice(next, remaining, options)).toEqual(
			remaining.goal,
		);
		expect(perTitleAdvice(before, next, driver)).toEqual([]);
		expect(
			perTitleAdvice(
				before,
				{ ...next, targetQualityCrf: 19 },
				driver,
				options,
			),
		).toEqual([]);
		expect(
			perTitleAdvice(before, next, driver, { appliedFields: [driver] }),
		).toEqual([]);
		expect(
			perTitleAdvice(before, next, driver, { appliedFields: [minimum] }).length,
		).toBeGreaterThan(0);
	});
	it("permits an intermediate conflict without copying the full proposal's proof", () => {
		const before = source(),
			current = { ...before, maxBitrate: 16_000_000 };
		const advice = required(perTitleAdvice(before, current, driver)[0]);
		const next = required(
			applySelectedPerTitleAdvice(current, advice, [minimum]),
		);
		expect(next.rows?.[0]?.minBitrate).toBeGreaterThan(
			next.rows?.[0]?.maxBitrate ?? Infinity,
		);
		expect(tunePerTitleSettings(next, next).proposal.applicable).toBe(false);
		const remaining = required(
			perTitleAdvice(before, next, driver, {
				protectedFields: [minimum],
				appliedFields: [minimum],
			})[0],
		);
		expect(
			remaining.proposal.diagnostics.some(
				(item) => item.severity === "conflict",
			),
		).toBe(false);
		expect(remaining.goal.rows?.[0]?.minBitrate).toBeLessThanOrEqual(
			remaining.goal.rows?.[0]?.maxBitrate ?? 0,
		);
	});
	it("rejects stale, unknown, empty, changed-protection and forged-value selections", () => {
		const before = source(),
			current = { ...before, maxBitrate: 8_000_000 };
		const advice = required(perTitleAdvice(before, current, driver)[0]);
		expect(applySelectedPerTitleAdvice(current, advice, [])).toBeNull();
		expect(
			applySelectedPerTitleAdvice(current, advice, [
				{ scope: "global", key: "maxBitrate" },
			]),
		).toBeNull();
		expect(
			applySelectedPerTitleAdvice(
				{ ...current, maxBitrate: 9_000_000 },
				advice,
				[minimum],
			),
		).toBeNull();
		expect(
			applySelectedPerTitleAdvice(current, advice, [minimum], {
				protectedFields: [minimum],
			}),
		).toBeNull();
		const forged = structuredClone(advice);
		const change = required(
			forged.changes.find(
				(item) => item.rowId === minimum.rowId && item.key === minimum.key,
			),
		);
		change.after = 123_456;
		expect(applySelectedPerTitleAdvice(current, forged, [minimum])).toBeNull();
	});
	it("deduplicates fields and matches full adoption when every change is selected", () => {
		const before = source(),
			current = { ...before, maxBitrate: 8_000_000 };
		const advice = required(perTitleAdvice(before, current, driver)[0]);
		const fields = advice.changes.map(({ scope, key, rowId }) => ({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
		}));
		const next = required(
			applySelectedPerTitleAdvice(current, advice, [...fields, minimum]),
		);
		expect(tunePerTitleSettings(next, next).proposal.api).toEqual(
			advice.proposal.api,
		);
	});
});
