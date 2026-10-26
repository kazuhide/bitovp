import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type {
	PerTitleAdvice,
	PerTitleAdviceField,
} from "./per-title-simulator-advice";
import { PerTitleAdviceChanges } from "./per-title-simulator-advice-changes";

function fixture(): { goal: PerTitleGoal; advice: PerTitleAdvice } {
	const goal: PerTitleGoal = {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 8_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		rows: [
			{ id: "first", height: 360, minBitrate: 200_000, maxBitrate: 1_000_000 },
			{
				id: "second",
				height: 360,
				minBitrate: 1_200_000,
				maxBitrate: 2_000_000,
			},
		],
	};
	return {
		goal,
		advice: {
			id: "evaluation-cap-0",
			reason: "evaluation",
			changes: [
				{
					scope: "global",
					key: "minBitrateStepSize",
					before: 1.5,
					after: 1.5000000000000004,
				},
				{
					scope: "stream",
					rowId: "first",
					key: "maxBitrate",
					before: 1_000_000,
					after: 1_000_001,
				},
				{
					scope: "stream",
					rowId: "second",
					key: "maxBitrate",
					before: 2_000_000,
					after: 2_200_000,
				},
				{
					scope: "global",
					key: "targetQualityCrf",
					before: undefined,
					after: 19,
				},
			],
			goal: structuredClone(goal),
			proposal: {
				id: "step-adjusted",
				codec: "H264",
				status: "candidate",
				applicable: true,
				evidence: "model-only",
				countGuarantee: false,
				api: {
					global: {
						minBitrate: 100_000,
						maxBitrate: 8_000_000,
						minBitrateStepSize: 1.5000000000000004,
						maxBitrateStepSize: 4,
					},
					streams: [],
				},
				scenarios: [],
				diagnostics: [],
			},
			proof: "conditional-settings",
			facts: {},
			inputFingerprint: "current-settings",
		},
	};
}

const reevaluate = (locale: "en" | "ja") =>
	screen.getByRole("button", {
		name:
			locale === "ja"
				? "選択した内容で再評価"
				: "Re-evaluate selected decisions",
	});
const decision = (locale: "en" | "ja", rendition: number) =>
	screen.getByRole("combobox", {
		name:
			locale === "ja"
				? `選択: 最大ビットレート (kbps), 段 ${rendition}`
				: `Decision: Maximum bitrate (kbps), rendition ${rendition}`,
	});

describe("parameter review table", () => {
	it.each([
		"en",
		"ja",
	] as const)("renders a live staged preview before the comparison without committing decisions (%s)", (locale) => {
		const { advice, goal } = fixture();
		const before = structuredClone({ advice, goal });
		const onReview = vi.fn();
		const renderPreview = vi.fn(
			(selection: {
				selected: readonly PerTitleAdviceField[];
				kept: readonly PerTitleAdviceField[];
			}) => (
				<output aria-label="Ladder preview">{JSON.stringify(selection)}</output>
			),
		);
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onReview={onReview}
				renderPreview={renderPreview}
			/>,
			locale,
		);
		const preview = screen.getByLabelText("Ladder preview");
		expect(preview).toBeVisible();
		expect(renderPreview).toHaveBeenLastCalledWith({ selected: [], kept: [] });
		expect(
			preview.compareDocumentPosition(screen.getByRole("table")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.change(decision(locale, 1), { target: { value: "apply" } });
		const selected = [{ scope: "stream", rowId: "first", key: "maxBitrate" }];
		expect(renderPreview).toHaveBeenLastCalledWith({ selected, kept: [] });
		fireEvent.change(decision(locale, 2), { target: { value: "keep" } });
		const kept = [{ scope: "stream", rowId: "second", key: "maxBitrate" }];
		expect(renderPreview).toHaveBeenLastCalledWith({ selected, kept });
		expect(JSON.parse(preview.textContent ?? "{}")).toEqual({ selected, kept });
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "選択をクリア" : "Clear decisions",
			}),
		);
		expect(renderPreview).toHaveBeenLastCalledWith({ selected: [], kept: [] });
		expect(onReview).not.toHaveBeenCalled();
		expect({ advice, goal }).toEqual(before);
	});

	it.each([
		"advice",
		"goal",
	] as const)("resets preview decisions when a fresh %s arrives", (snapshot) => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		const renderPreview = vi.fn(
			(selection: {
				selected: readonly PerTitleAdviceField[];
				kept: readonly PerTitleAdviceField[];
			}) => (
				<output aria-label="Ladder preview">{JSON.stringify(selection)}</output>
			),
		);
		const view = renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
				renderPreview={renderPreview}
			/>,
		);
		fireEvent.change(decision("en", 1), { target: { value: "apply" } });
		fireEvent.change(decision("en", 2), { target: { value: "keep" } });
		expect(renderPreview).toHaveBeenLastCalledWith({
			selected: [{ scope: "stream", rowId: "first", key: "maxBitrate" }],
			kept: [{ scope: "stream", rowId: "second", key: "maxBitrate" }],
		});
		view.rerender(
			<PerTitleAdviceChanges
				advice={snapshot === "advice" ? { ...advice } : advice}
				goal={snapshot === "goal" ? { ...goal, maxBitrate: 9_000_000 } : goal}
				locale="en"
				onReview={onReview}
				renderPreview={renderPreview}
			/>,
		);
		expect(renderPreview).toHaveBeenLastCalledWith({ selected: [], kept: [] });
		expect(
			JSON.parse(screen.getByLabelText("Ladder preview").textContent ?? "{}"),
		).toEqual({ selected: [], kept: [] });
		expect(onReview).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("stages disjoint keep/apply choices and commits them once (%s)", (locale) => {
		const { advice, goal } = fixture();
		const before = structuredClone({ advice, goal });
		const onReview = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onReview={onReview}
			/>,
			locale,
		);
		const table = screen.getByRole("table", {
			name: locale === "ja" ? "項目ごとの変更" : "Review parameter changes",
		});
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(
			locale === "ja"
				? ["対象", "項目", "現在値", "提案値", "選択"]
				: ["Target", "Parameter", "Current", "Proposed", "Decision"],
		);
		expect(table).toHaveTextContent(locale === "ja" ? "全体" : "Global");
		expect(table).toHaveTextContent(locale === "ja" ? "段 1" : "Rendition 1");
		expect(table).toHaveTextContent(locale === "ja" ? "段 2" : "Rendition 2");
		expect(within(table).getAllByText("360p")).toHaveLength(2);
		for (const select of within(table).getAllByRole("combobox"))
			expect(select).toHaveValue("skip");
		expect(reevaluate(locale)).toBeDisabled();
		fireEvent.change(decision(locale, 2), { target: { value: "apply" } });
		fireEvent.change(decision(locale, 1), { target: { value: "apply" } });
		fireEvent.change(decision(locale, 1), { target: { value: "keep" } });
		expect(onReview).not.toHaveBeenCalled();
		expect({ advice, goal }).toEqual(before);
		expect(
			screen.getByText(
				locale === "ja" ? "反映 1 · 維持 1" : "Apply 1 · Keep 1",
			),
		).toBeInTheDocument();
		fireEvent.click(reevaluate(locale));
		expect(onReview).toHaveBeenCalledExactlyOnceWith(
			advice,
			[{ scope: "stream", rowId: "second", key: "maxBitrate" }],
			[{ scope: "stream", rowId: "first", key: "maxBitrate" }],
		);
		expect({ advice, goal }).toEqual(before);
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps precise current and proposed values visibly distinct (%s)", (locale) => {
		const { advice, goal } = fixture();
		const changed = advice.changes[1];
		if (!changed) throw new Error("Expected the first rendition change.");
		advice.changes[1] = {
			...changed,
			before: 1_000_000.1,
			after: 1_000_000.2,
		};
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onReview={vi.fn()}
			/>,
			locale,
		);
		expect(screen.getByText("1.5")).toBeInTheDocument();
		expect(screen.getByText("1.5000000000000004")).toBeInTheDocument();
		expect(screen.getByText("1000000.1 bps")).toBeInTheDocument();
		expect(screen.getByText("1000000.2 bps")).toBeInTheDocument();
		expect(
			screen.getByText(locale === "ja" ? "未設定" : "Unset"),
		).toBeInTheDocument();
	});

	it("supports keep-only review and bulk selection without publishing choices", () => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Select all proposed" }),
		);
		for (const select of screen.getAllByRole("combobox"))
			expect(select).toHaveValue("apply");
		expect(onReview).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Clear decisions" }));
		for (const select of screen.getAllByRole("combobox"))
			expect(select).toHaveValue("skip");
		expect(reevaluate("en")).toBeDisabled();
		fireEvent.change(decision("en", 1), { target: { value: "keep" } });
		expect(reevaluate("en")).toBeEnabled();
		fireEvent.click(reevaluate("en"));
		expect(onReview).toHaveBeenCalledExactlyOnceWith(
			advice,
			[],
			[{ scope: "stream", rowId: "first", key: "maxBitrate" }],
		);
	});

	it("retains staged decisions when only the locale changes", () => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		const view = renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
			/>,
		);
		fireEvent.change(decision("en", 1), { target: { value: "keep" } });
		view.rerender(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="ja"
				onReview={onReview}
			/>,
		);
		expect(decision("ja", 1)).toHaveValue("keep");
		expect(onReview).not.toHaveBeenCalled();
	});

	it("retains rejected decisions and clears accepted ones before allowing whole adoption", () => {
		const { advice, goal } = fixture();
		const onReview = vi
			.fn()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		const onAdoptAll = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
				onAdoptAll={onAdoptAll}
			/>,
		);
		const adopt = screen.getByRole("button", { name: "Use this adjustment" });
		expect(adopt).toBeEnabled();
		fireEvent.change(decision("en", 1), { target: { value: "keep" } });
		expect(adopt).toBeDisabled();
		fireEvent.click(reevaluate("en"));
		expect(decision("en", 1)).toHaveValue("keep");
		fireEvent.click(reevaluate("en"));
		expect(decision("en", 1)).toHaveValue("skip");
		expect(adopt).toBeEnabled();
		expect(onAdoptAll).not.toHaveBeenCalled();
		fireEvent.click(adopt);
		expect(onAdoptAll).toHaveBeenCalledExactlyOnceWith(advice);
	});

	it("allows keep-only review while application is pending and disables further adoption", () => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		const onAdoptAll = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
				onAdoptAll={onAdoptAll}
				applying
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeDisabled();
		fireEvent.change(decision("en", 1), { target: { value: "apply" } });
		expect(reevaluate("en")).toBeDisabled();
		fireEvent.change(decision("en", 1), { target: { value: "keep" } });
		expect(reevaluate("en")).toBeEnabled();
		fireEvent.click(reevaluate("en"));
		expect(onReview).toHaveBeenCalledExactlyOnceWith(
			advice,
			[],
			[{ scope: "stream", rowId: "first", key: "maxBitrate" }],
		);
		expect(onAdoptAll).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("blocks keeping a changing pending field while allowing an unrelated keep (%s)", (locale) => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale={locale}
				onReview={onReview}
				applying
				pendingFields={[{ scope: "stream", rowId: "first", key: "maxBitrate" }]}
			/>,
			locale,
		);
		const keep = locale === "ja" ? "現在値を維持" : "Keep current";
		expect(
			within(decision(locale, 1)).getByRole("option", { name: keep }),
		).toBeDisabled();
		expect(
			within(decision(locale, 2)).getByRole("option", { name: keep }),
		).toBeEnabled();
		fireEvent.change(decision(locale, 1), { target: { value: "keep" } });
		expect(decision(locale, 1)).toHaveValue("skip");
		expect(reevaluate(locale)).toBeDisabled();
		fireEvent.change(decision(locale, 2), { target: { value: "keep" } });
		expect(reevaluate(locale)).toBeEnabled();
		expect(onReview).not.toHaveBeenCalled();
		fireEvent.click(reevaluate(locale));
		expect(onReview).toHaveBeenCalledExactlyOnceWith(
			advice,
			[],
			[{ scope: "stream", rowId: "second", key: "maxBitrate" }],
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			locale === "ja"
				? "設定の反映を待っています。"
				: "Waiting for settings to update.",
		);
	});

	it.each([
		"identity",
		"fingerprint",
		"values",
		"goal",
	] as const)("resets staged decisions after the %s snapshot changes", (change) => {
		const { advice, goal } = fixture();
		const onReview = vi.fn();
		const view = renderLocalized(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
			/>,
		);
		fireEvent.change(decision("en", 1), { target: { value: "apply" } });
		const nextAdvice =
			change === "goal"
				? advice
				: {
						...advice,
						...(change === "fingerprint"
							? { inputFingerprint: "new-input" }
							: {}),
						...(change === "values"
							? {
									changes: advice.changes.map((field, index) =>
										index === 1 ? { ...field, after: 1_000_002 } : field,
									),
								}
							: {}),
					};
		const nextGoal =
			change === "goal" ? { ...goal, maxBitrate: 9_000_000 } : goal;
		view.rerender(
			<PerTitleAdviceChanges
				advice={nextAdvice}
				goal={nextGoal}
				locale="en"
				onReview={onReview}
			/>,
		);
		for (const select of screen.getAllByRole("combobox"))
			expect(select).toHaveValue("skip");
		expect(reevaluate("en")).toBeDisabled();
		view.rerender(
			<PerTitleAdviceChanges
				advice={advice}
				goal={goal}
				locale="en"
				onReview={onReview}
			/>,
		);
		expect(decision("en", 1)).toHaveValue("skip");
		expect(onReview).not.toHaveBeenCalled();
	});
});
