import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";

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
		expect(after).toEqual({
			...edited,
			streams: edited.streams.map(
				(stream: {
					rowId: string;
					perTitleSettings?: Record<string, unknown>;
				}) =>
					stream.rowId === "required"
						? {
								...stream,
								perTitleSettings: {
									...stream.perTitleSettings,
									highComplexityBoundaryForMaxBitrate: 8_000_000,
								},
							}
						: stream,
			),
		});
		for (const policy of policies) expect(policy).toHaveValue("fixed");
		expect(
			screen.queryByRole("region", {
				name: locale === "en" ? "Suggested adjustment" : "調整案",
			}),
		).toBeNull();
		expect(goal).toEqual(original);
		expect(onApply).not.toHaveBeenCalled();
	});
});
