import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import {
	applySelectedPerTitleAdvice,
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
function api() {
	return JSON.parse(
		screen.getByTestId("per-title-api-settings").textContent ?? "{}",
	);
}
describe("selected advice simulator flow", () => {
	it.each([
		"en",
		"ja",
	] as const)("applies one change, preserves it, then recalculates and adopts the remainder (%s)", (locale) => {
		const goal = source(),
			onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const input = screen.getByRole("spinbutton", {
			name:
				locale === "ja" ? "最大ビットレート (kbps)" : "Maximum bitrate (kbps)",
		});
		fireEvent.change(input, { target: { value: "8000" } });
		const edited = api();
		const select = screen.getByRole("combobox", {
			name:
				locale === "ja"
					? "選択: 最小ビットレート (kbps), 段 1"
					: "Decision: Minimum bitrate (kbps), rendition 1",
		});
		const button = screen.getByRole("button", {
			name:
				locale === "ja"
					? "選択した内容で再評価"
					: "Re-evaluate selected decisions",
		});
		expect(button).toBeDisabled();
		fireEvent.change(select, { target: { value: "apply" } });
		expect(api()).toEqual(edited);
		expect(button).toBeEnabled();
		const before = { ...goal, maxBitrate: 8_000_000 };
		const first = perTitleAdvice(goal, before, {
			scope: "global",
			key: "maxBitrate",
		})[0];
		if (!first) throw new Error("Expected initial advice.");
		const minimum = {
			scope: "stream",
			rowId: "required",
			key: "minBitrate",
		} as const;
		const expected = applySelectedPerTitleAdvice(before, first, [minimum]);
		if (!expected) throw new Error("Expected selected draft.");
		fireEvent.click(button);
		expect(api()).toEqual(
			tunePerTitleSettings(expected, expected).proposal.api,
		);
		const maintained = screen.getByRole("region", {
			name: locale === "ja" ? "維持する値" : "Maintained values",
		});
		expect(maintained).toHaveTextContent(
			locale === "ja" ? "最小ビットレート" : "Minimum bitrate",
		);
		const remaining = perTitleAdvice(
			goal,
			expected,
			{ scope: "global", key: "maxBitrate" },
			{ protectedFields: [minimum], appliedFields: [minimum] },
		)[0];
		if (!remaining) throw new Error("Expected recomputed remainder.");
		expect(
			screen.queryByRole("combobox", {
				name: select.getAttribute("aria-label") ?? "",
			}),
		).toBeNull();
		expect(
			screen
				.getAllByRole("combobox", { name: /^(?:Decision:|選択:)/ })
				.every((item) => (item as HTMLSelectElement).value === "skip"),
		).toBe(true);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "この調整を採用" : "Use this adjustment",
			}),
		);
		expect(api()).toEqual(remaining.proposal.api);
		expect(
			api().streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.minBitrate,
		).toBe(expected.rows?.[0]?.minBitrate);
		expect(onApply).not.toHaveBeenCalled();
	});
	it("keeps the original expansion through later driver edits and releases an applied anchor", () => {
		const goal = source();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		const input = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps)",
		});
		fireEvent.change(input, { target: { value: "8000" } });
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Decision: Minimum bitrate (kbps), rendition 1",
			}),
			{ target: { value: "apply" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		);
		const accepted = api().streams.find(
			(row: { rowId: string }) => row.rowId === "required",
		).perTitleSettings.minBitrate;
		for (const value of ["9", "90", "900", "9000"])
			fireEvent.change(input, { target: { value } });
		expect(
			api().streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.minBitrate,
		).toBe(accepted);
		expect(
			screen.getByRole("region", { name: "Suggested adjustment" }),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Release: Minimum bitrate (kbps), rendition 1",
			}),
		);
		expect(
			screen.getByRole("combobox", {
				name: "Decision: Minimum bitrate (kbps), rendition 1",
			}),
		).toHaveValue("skip");
		expect(
			api().streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.minBitrate,
		).toBe(accepted);
	});
	it("rechecks final applicability after a temporarily conflicting partial step change", () => {
		const goal: PerTitleGoal = {
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
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Desired count" }),
			{ target: { value: "3" } },
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Decision: Minimum bitrate ratio",
			}),
			{ target: { value: "apply" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		);
		expect(api().global.minBitrateStepSize).toBeGreaterThan(
			api().global.maxBitrateStepSize,
		);
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		expect(
			screen.getByRole("combobox", {
				name: "Decision: Maximum bitrate ratio",
			}),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply).toHaveBeenCalledTimes(1);
		expect(onApply.mock.calls[0]?.[0].applicable).toBe(true);
	});
	it("applies multiple selected changes atomically and clears stale selections after a manual edit", () => {
		const goal = source();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		const input = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps)",
		});
		fireEvent.change(input, { target: { value: "8000" } });
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Decision: Minimum bitrate (kbps), rendition 1",
			}),
			{ target: { value: "apply" } },
		);
		fireEvent.change(input, { target: { value: "9000" } });
		expect(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		).toBeDisabled();
		const edited = api();
		for (const label of ["Minimum bitrate", "Maximum bitrate"])
			fireEvent.change(
				screen.getByRole("combobox", {
					name: `Decision: ${label} (kbps), rendition 1`,
				}),
				{ target: { value: "apply" } },
			);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		);
		const after = api();
		expect(after.global).toEqual(edited.global);
		expect(
			after.streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.minBitrate,
		).toBeGreaterThan(1_000_000);
		expect(
			after.streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings.maxBitrate,
		).toBeGreaterThan(1_600_000);
		expect(
			within(
				screen.getByRole("region", { name: "Maintained values" }),
			).getAllByRole("button", { name: /Release:/ }),
		).toHaveLength(2);
	});
});
