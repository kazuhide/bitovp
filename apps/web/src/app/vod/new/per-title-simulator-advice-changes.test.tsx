import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { createPerTitleEvaluationAdvice } from "./per-title-simulator-advice";
import { PerTitleAdviceChanges } from "./per-title-simulator-advice-changes";

function fixture() {
	const goal: PerTitleGoal = {
		strategy: "automatic",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 8_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "unrestricted" },
	};
	const advice = createPerTitleEvaluationAdvice(goal, {
		...goal,
		minBitrateStepSize: 1.6,
	});
	if (!advice) throw new Error("Expected a rendering fixture.");
	// Exercise the display contract independently of candidate generation.
	advice.changes = advice.changes.map((change) => ({
		...change,
		beforeAdjustment: { mode: "auto" as const, method: "constraints" as const },
		afterAdjustment: { mode: "fixed" as const },
	}));
	return { goal, advice };
}

describe("parameter adjustment mode changes", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps exact mobile values with the parameter while preserving the existing accessible cells (%s)", (locale) => {
		const { goal, advice } = fixture();
		const change = advice.changes[0];
		if (!change) throw new Error("Expected a parameter change.");
		change.after = 1.8795574353431477;
		renderLocalized(
			<PerTitleAdviceChanges
				goal={goal}
				advice={advice}
				locale={locale}
				onReview={vi.fn()}
			/>,
			locale,
		);
		const ja = locale === "ja";
		const heading = screen.getByRole("rowheader", {
			name: ja ? /ビットレート間隔の下限/ : /Minimum bitrate ratio/,
		});
		const values = within(heading).getByTestId(
			"per-title-advice-mobile-values",
		);
		expect(values).toHaveTextContent(
			ja
				? "現在 → 提案: 1.5 → 1.8795574353431477"
				: "Current → Proposed: 1.5 → 1.8795574353431477",
		);
		expect(values).toHaveAttribute("aria-hidden", "true");
		expect(values).toHaveClass("sm:hidden");
		expect(heading).not.toHaveAccessibleName(/1\.5|1\.879/);
		const row = heading.closest("tr");
		if (!row) throw new Error("Expected the parameter row.");
		const cells = within(row).getAllByRole("cell");
		expect(cells[1]).toHaveTextContent(/^1\.5$/);
		expect(cells[2]).toHaveTextContent(/^1\.8795574353431477$/);
	});

	it.each([
		"en",
		"ja",
	] as const)("makes an Auto-to-Fixed change explicit on its parameter row (%s)", (locale) => {
		const { goal, advice } = fixture();
		const onReview = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				goal={goal}
				advice={advice}
				locale={locale}
				onReview={onReview}
			/>,
			locale,
		);
		const ja = locale === "ja";
		const row = screen
			.getByRole("rowheader", {
				name: ja ? /ビットレート間隔の下限/ : /Minimum bitrate ratio/,
			})
			.closest("tr");
		if (!row) throw new Error("Expected the changed parameter row.");
		expect(
			within(row).getByText(
				ja ? "自動（要件から計算） → 固定" : "Auto (From requirements) → Fixed",
			),
		).toBeVisible();
		expect(row).toHaveTextContent("1.5");
		expect(row).toHaveTextContent("1.6");
		expect(screen.queryByRole("region")).toBeNull();
		expect(onReview).not.toHaveBeenCalled();
	});

	it("clears staged decisions when adjustment metadata changes without a numeric change", () => {
		const { goal, advice } = fixture();
		const onReview = vi.fn();
		const { rerender } = renderLocalized(
			<PerTitleAdviceChanges
				goal={goal}
				advice={advice}
				locale="en"
				onReview={onReview}
			/>,
		);
		const decision = () =>
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" });
		fireEvent.change(decision(), { target: { value: "apply" } });
		expect(decision()).toHaveValue("apply");
		const change = advice.changes[0];
		if (!change) throw new Error("Expected one parameter change.");
		change.beforeAdjustment = { mode: "auto", method: "default" };
		rerender(
			<PerTitleAdviceChanges
				goal={goal}
				advice={advice}
				locale="en"
				onReview={onReview}
			/>,
		);
		expect(decision()).toHaveValue("skip");
		expect(
			screen.getByRole("button", { name: "Re-evaluate selected decisions" }),
		).toBeDisabled();
		expect(onReview).not.toHaveBeenCalled();
	});
});
