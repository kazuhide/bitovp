import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { perTitleAdvice } from "./per-title-simulator-advice";

const goal: PerTitleGoal = {
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
};
function api() {
	return JSON.parse(
		screen.getByTestId("per-title-api-settings").textContent ?? "{}",
	);
}

describe("Fixed simulator advice integration", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps the API unchanged except the driver until explicit adoption (%s)", (locale) => {
		const onApply = vi.fn();
		const original = structuredClone(goal);
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const before = api();
		const policies = screen
			.getAllByRole("combobox")
			.filter((item) =>
				/adjustment|の調整/.test(item.getAttribute("aria-label") ?? ""),
			);
		expect(policies.length).toBeGreaterThan(10);
		for (const policy of policies) expect(policy).toHaveValue("fixed");
		expect(
			screen.queryByRole("region", {
				name: locale === "en" ? "Suggested adjustment" : "調整案",
			}),
		).toBeNull();
		const input = screen.getByRole("spinbutton", {
			name:
				locale === "en" ? "Maximum bitrate (kbps)" : "最大ビットレート (kbps)",
		});
		for (const value of ["8", "80", "800", "8000"])
			fireEvent.change(input, { target: { value } });
		const edited = api();
		expect(edited).toEqual({
			...before,
			global: { ...before.global, maxBitrate: 8_000_000 },
		});
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		);
		const after = api();
		const advice = perTitleAdvice(
			goal,
			{ ...goal, maxBitrate: 8_000_000 },
			{ scope: "global", key: "maxBitrate" },
		)[0];
		expect(advice?.reason).toBe("joint-range");
		expect(after).toEqual(advice?.proposal.api);
		expect(after.global.minBitrate).toBe(before.global.minBitrate);
		expect(after.global.minBitrateStepSize).toBeGreaterThan(
			before.global.minBitrateStepSize,
		);
		expect(
			after.streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.minBitrate,
		).toBeGreaterThan(1_000_000);
		for (const policy of policies) expect(policy).toHaveValue("fixed");
		expect(
			screen.queryByRole("region", {
				name: locale === "en" ? "Suggested adjustment" : "調整案",
			}),
		).toBeNull();
		expect(goal).toEqual(original);
		expect(onApply).not.toHaveBeenCalled();
	});
	it("keeps current step settings while pinning and unpinning advice, without applying a job", () => {
		const initial: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 5 },
		};
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={initial}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Desired count" }),
			{ target: { value: "3" } },
		);
		const edited = api();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Maximum bitrate ratio",
			}),
		);
		expect(api()).toEqual(edited);
		expect(onApply).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Release: Maximum bitrate ratio" }),
		);
		expect(api()).toEqual(edited);
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		expect(api().global.minBitrateStepSize).not.toBe(
			edited.global.minBitrateStepSize,
		);
		expect(api().global.minBitrate).toBe(edited.global.minBitrate);
		expect(api().global.maxBitrate).toBe(edited.global.maxBitrate);
		expect(
			screen.getByRole("spinbutton", { name: "Desired count" }),
		).toHaveValue(3);
		expect(onApply).not.toHaveBeenCalled();
	});
});
