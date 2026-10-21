import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleReasoning } from "./per-title-simulator-reasoning";

const goal: PerTitleGoal = {
	strategy: "count",
	codec: "H264",
	minBitrate: 16_000,
	maxBitrate: 256_000,
	countPolicy: { kind: "exact", count: 5 },
	rows: [],
};

function value(label: string) {
	return screen.getByText(label, { selector: "dt" }).nextElementSibling;
}

describe("Per-Title calculation explanation", () => {
	it.each([
		"en",
		"ja",
	] as const)("explains joint constraints without the independent-spacing formula (%s)", (locale) => {
		const original = recommendPerTitleSettings(goal);
		if (!original.derivation) throw new Error("Missing test derivation");
		const proposal: PerTitleProposal = {
			...original,
			derivation: {
				...original.derivation,
				method: "joint-constraints",
				requiredRowCount: 2,
			},
		};
		renderLocalized(
			<PerTitleReasoning goal={goal} proposal={proposal} onChange={vi.fn()} />,
			locale,
		);
		const explanation = screen.queryByText(
			locale === "en"
				? /Required ranges, complexity boundaries and additional-rendition rules are checked together/
				: /各段の範囲・複雑度境界・追加レンディションのルールを組み合わせ/,
		);
		expect(explanation).not.toBeNull();
		expect(explanation).not.toBeVisible();
		fireEvent.click(
			screen.getByText(locale === "en" ? "Why these settings" : "提案の根拠"),
		);
		expect(explanation).toBeVisible();
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Calculation and assumptions" : "計算手順と前提",
			),
		);
		expect(screen.queryByText(/s\^N > U\/L/)).toBeNull();
		expect(screen.queryByText(/p\[i\] = max/)).toBeNull();
	});
	it.each([
		"en",
		"ja",
	] as const)("names the actual corrected bitrate limits before applying them (%s)", (locale) => {
		const original: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 150000,
			maxBitrate: 180000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "low", height: 240, minBitrate: 100000, maxBitrate: 100000 },
				{ id: "high", height: 480, minBitrate: 200000, maxBitrate: 200000 },
			],
		};
		const onChange = vi.fn();
		renderLocalized(
			<PerTitleReasoning
				goal={original}
				proposal={recommendPerTitleSettings(original)}
				onChange={onChange}
			/>,
			locale,
		);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Use 100–200 kbps" : "全体を100–200 kbpsに変更",
			}),
		);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			minBitrate: 100000,
			maxBitrate: 200000,
			rows: original.rows,
		});
	});
	it.each([
		"en",
		"ja",
	] as const)("names a rule-removal comparison explicitly without changing the goal before selection (%s)", (locale) => {
		const original: PerTitleGoal = {
			...goal,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
			},
		};
		const before = structuredClone(original);
		const onChange = vi.fn();
		renderLocalized(
			<PerTitleReasoning
				goal={original}
				proposal={recommendPerTitleSettings(original)}
				onChange={onChange}
			/>,
			locale,
		);
		const action = screen.getByRole("button", {
			name:
				locale === "en"
					? "Compare without additional rules"
					: "追加ルールを外して比較",
		});
		expect(action).toBeVisible();
		expect(onChange).not.toHaveBeenCalled();
		const reason = screen.getByText(
			locale === "en"
				? /Compare the template conditions with the additional-rendition rules excluded/
				: /追加レンディションのルールを外し、残りのテンプレート条件で比較する案/,
		);
		expect(reason).not.toBeVisible();
		fireEvent.click(
			screen.getByText(locale === "en" ? "Why these settings" : "提案の根拠"),
		);
		expect(reason).toBeVisible();
		fireEvent.click(action);
		expect(onChange).toHaveBeenCalledOnce();
		const next = onChange.mock.calls[0]?.[0] as PerTitleGoal;
		expect(next.fixedResolutionAndBitrateConfiguration).toBeUndefined();
		expect(next.rows).toEqual(original.rows);
		expect(original).toEqual(before);
		expect(recommendPerTitleSettings(next).derivation?.targetSatisfied).toBe(
			true,
		);
	});
	it("explains the numeric inputs, chosen interior ratio and integer example", () => {
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.derivation?.method).toBe("geometric-count");
		expect(proposal.derivation?.targetSatisfied).toBe(true);
		const { container } = renderLocalized(
			<PerTitleReasoning goal={goal} proposal={proposal} onChange={vi.fn()} />,
		);
		expect(
			screen.getByText(/The bitrate range and desired count define/),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("Why these settings"));
		expect(
			screen.getByText(/The bitrate range and desired count define/),
		).toBeVisible();
		fireEvent.click(screen.getByText("Calculation and assumptions"));
		expect(value("Overall minimum L (kbps)")).toHaveTextContent("16");
		expect(value("Overall maximum U (kbps)")).toHaveTextContent("256");
		expect(value("Bitrate span U/L")).toHaveTextContent("16");
		expect(value("Requested rendition count")).toHaveTextContent("Exactly 5");
		expect(value("Required rows")).toHaveTextContent("0");
		expect(value("Selected minimum ratio s")).toHaveTextContent("≈");
		expect(value("Selected maximum ratio")).toHaveTextContent("≈");
		expect(screen.getByText(/geometric midpoint/)).toBeVisible();
		expect(
			screen.getByText(/not a prediction of encoder output/),
		).toBeVisible();
		const example = proposal.derivation?.integerWitness;
		expect(example?.length).toBe(5);
		expect(value("Integer placement example (kbps)")).toHaveTextContent(
			(example ?? []).map((point) => String(point / 1000)).join(" → "),
		);
		expect(container).not.toHaveTextContent("geometric-count");
		expect(container).not.toHaveTextContent(
			proposal.derivation?.rationale ?? "",
		);
	});

	it("does not invent absent bounds, witnesses or a successful count check", () => {
		const original = recommendPerTitleSettings(goal);
		const proposal: PerTitleProposal = {
			...original,
			status: "unknown",
			applicable: false,
			derivation: {
				method: "required-intervals",
				requiredRowCount: 0,
				selectedMinStep: 1.5,
				selectedMaxStep: 1.9,
				targetSatisfied: false,
				rationale: "INTERNAL_ONLY",
			},
		};
		const { container } = renderLocalized(
			<PerTitleReasoning goal={goal} proposal={proposal} onChange={vi.fn()} />,
		);
		fireEvent.click(screen.getByText("Why these settings"));
		fireEvent.click(screen.getByText("Calculation and assumptions"));
		expect(
			screen.getByText(/count goal has not been established/),
		).toBeVisible();
		expect(screen.queryByText("Model count boundary (excluded)")).toBeNull();
		expect(
			screen.queryByText("Checked spacing upper bound (included)"),
		).toBeNull();
		expect(screen.queryByText("Integer placement example (kbps)")).toBeNull();
		expect(screen.queryByText(/geometric midpoint/)).toBeNull();
		expect(container).not.toHaveTextContent("INTERNAL_ONLY");
		expect(container).not.toHaveTextContent("required-intervals");
	});

	it("distinguishes retained settings from a newly selected interior value", () => {
		const preservedGoal: PerTitleGoal = {
			...goal,
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		};
		const proposal = recommendPerTitleSettings(preservedGoal);
		expect(proposal.derivation?.method).toBe("preserved-existing");
		renderLocalized(
			<PerTitleReasoning
				goal={preservedGoal}
				proposal={proposal}
				onChange={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByText("Why these settings"));
		fireEvent.click(screen.getByText("Calculation and assumptions"));
		expect(screen.getByText(/existing bitrate steps satisfy/)).toBeVisible();
		expect(value("Selected minimum ratio s")).toHaveTextContent("≈ 1.5");
		expect(value("Selected maximum ratio")).toHaveTextContent("≈ 1.9");
		expect(value("Requested rendition count")).toHaveTextContent(
			"Unrestricted",
		);
		expect(screen.queryByText(/geometric midpoint/)).toBeNull();
	});

	it("localizes the explanation and withholds invalid or nonfinite numeric evidence", () => {
		const proposal = recommendPerTitleSettings(goal);
		const { container, rerender } = renderLocalized(
			<PerTitleReasoning goal={goal} proposal={proposal} onChange={vi.fn()} />,
			"ja",
		);
		fireEvent.click(screen.getByText("提案の根拠"));
		fireEvent.click(screen.getByText("計算手順と前提"));
		expect(value("全体の下限 L (kbps)")).toHaveTextContent("16");
		expect(value("希望する本数")).toHaveTextContent("5本ちょうど");
		expect(screen.getByText(/幾何平均/)).toBeVisible();
		expect(container).not.toHaveTextContent("geometric-count");
		expect(container).not.toHaveTextContent(
			proposal.derivation?.rationale ?? "",
		);
		const invalidGoal = { ...goal, minBitrate: NaN, maxBitrate: Infinity };
		const invalid: PerTitleProposal = {
			...proposal,
			status: "unknown",
			applicable: false,
			derivation: {
				method: "required-intervals",
				requiredRowCount: 2,
				selectedMinStep: NaN,
				selectedMaxStep: Infinity,
				ratioLowerExclusive: Infinity,
				ratioUpperInclusive: NaN,
				maximumFeasibleStep: Infinity,
				integerWitness: [NaN, Infinity],
				fixedOrderRowIds: ["INTERNAL_ROW"],
				targetSatisfied: false,
				rationale: "INTERNAL_ONLY",
			},
		};
		rerender(
			<PerTitleReasoning
				goal={invalidGoal}
				proposal={invalid}
				onChange={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/本数の要件を満たすことを確認できていません/),
		).toBeVisible();
		expect(value("全体の下限 L (kbps)")).toHaveTextContent("未確定");
		expect(screen.queryByText(/幾何平均/)).toBeNull();
		expect(container).not.toHaveTextContent(
			/NaN|Infinity|INTERNAL_|required-intervals/,
		);
	});
});
