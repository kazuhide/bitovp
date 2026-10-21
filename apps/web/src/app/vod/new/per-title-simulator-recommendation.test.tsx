import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleAutomaticTemplates } from "./per-title-simulator-automatic";
import { PerTitleRecommendation } from "./per-title-simulator-recommendation";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_000_000,
	countPolicy: { kind: "exact", count: 2 },
	rows: [
		{
			id: "lower",
			height: 360,
			width: 640,
			minBitrate: 100_000,
			maxBitrate: 400_000,
		},
		{ id: "upper", height: 720, minBitrate: 500_000, maxBitrate: 2_000_000 },
	],
};

function show(initialGoal = goal, locale: "en" | "ja" = "en") {
	return renderLocalized(
		<PerTitleSimulator
			open
			initialGoal={initialGoal}
			onOpenChange={vi.fn()}
			onApply={vi.fn()}
		/>,
		locale,
	);
}

describe("Per-Title recommendation flow", () => {
	it.each([
		["en", "Model count range at overall maximum"],
		["ja", "全体の上限でのモデル上の本数範囲"],
	] as const)("reads the checked model range rather than echoing the requested six renditions in %s", (locale, label) => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "exact", count: 6 },
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		const upper = proposal.scenarios.find(
			(scenario) => scenario.fraction === 1,
		);
		expect(proposal.derivation?.targetSatisfied).toBe(true);
		expect(upper?.status).toBe("modelled");
		const actualRange = upper?.modelCountRange;
		if (!actualRange) throw new Error("Missing model count range");
		const { rerender } = renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
			locale,
		);
		expect(screen.getByText(label).nextElementSibling).toHaveTextContent(
			actualRange.minimum === actualRange.maximum
				? String(actualRange.minimum)
				: `${actualRange.minimum}–${actualRange.maximum}`,
		);
		rerender(
			<PerTitleRecommendation
				goal={countGoal}
				proposal={{
					...proposal,
					scenarios: proposal.scenarios.map((scenario) =>
						scenario.fraction === 1
							? { ...scenario, modelCountRange: { minimum: 4, maximum: 6 } }
							: scenario,
					),
				}}
			/>,
		);
		expect(screen.getByText(label).nextElementSibling).toHaveTextContent("4–6");
	});

	it("withholds model counts when the upper scenario or the successful check is missing", () => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "exact", count: 6 },
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		const { rerender } = renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
		);
		expect(
			screen.getByText("Model count range at overall maximum"),
		).toBeVisible();
		const derivation = proposal.derivation;
		if (!derivation) throw new Error("Missing derivation");
		for (const unchecked of [
			{ ...proposal, status: "unknown" as const },
			{ ...proposal, applicable: false },
			{ ...proposal, derivation: { ...derivation, targetSatisfied: false } },
			{
				...proposal,
				scenarios: proposal.scenarios.filter(
					(scenario) => scenario.fraction !== 1,
				),
			},
			{
				...proposal,
				scenarios: proposal.scenarios.map((scenario) => ({
					...scenario,
					status: "conflict" as const,
				})),
			},
			{
				...proposal,
				scenarios: proposal.scenarios.map((scenario) => ({
					...scenario,
					modelCountRange: { minimum: NaN, maximum: Infinity },
				})),
			},
		]) {
			rerender(
				<PerTitleRecommendation goal={countGoal} proposal={unchecked} />,
			);
			expect(
				screen.queryByText("Model count range at overall maximum"),
			).toBeNull();
		}
	});

	it("shows a certified adjustment interval without treating older derivation bounds as one", () => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "exact", count: 5 },
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		expect(proposal.derivation?.minimumStepRange).toBeDefined();
		const { rerender } = renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
		);
		expect(
			screen.getByText("Minimum-step adjustment range").nextElementSibling,
		).toHaveTextContent("≈");
		expect(
			screen.getByText(
				/retains the same integer placement example and maximum ratio/,
			),
		).toBeVisible();
		const derivation = proposal.derivation;
		if (!derivation) throw new Error("Missing derivation");
		rerender(
			<PerTitleRecommendation
				goal={countGoal}
				proposal={{
					...proposal,
					derivation: {
						...derivation,
						minimumStepRange: undefined,
						ratioLowerExclusive: 1.1,
						ratioUpperInclusive: 4,
					},
				}}
			/>,
		);
		expect(screen.queryByText("Minimum-step adjustment range")).toBeNull();
		rerender(
			<PerTitleRecommendation
				goal={countGoal}
				proposal={{ ...proposal, status: "unknown", applicable: false }}
			/>,
		);
		expect(screen.queryByText("Minimum-step adjustment range")).toBeNull();
	});

	it.each([
		[
			"en",
			"Recommended settings",
			"Automatic candidates retain their attached bitrate settings as source data.",
		],
		[
			"ja",
			"推奨設定",
			"自動生成の候補に付いたビットレート設定は元データとして保持します。",
		],
	] as const)("keeps inactive automatic settings visible as a warning in %s", (locale, title, warning) => {
		show(
			{
				...goal,
				automaticTemplates: [
					{
						id: "automatic",
						height: 1080,
						minBitrate: 800_000,
						maxBitrate: 4_000_000,
					},
				],
			},
			locale,
		);
		const panel = screen.getByRole("region", { name: title });
		expect(
			within(panel).getByText((text) => text.startsWith(warning)),
		).toBeVisible();
		expect(within(panel).queryByText(/rowIds|PER_TITLE_TEMPLATE/)).toBeNull();
	});

	it("shows one recommendation with requested ranges and read-only spacing values", () => {
		show();
		const panel = screen.getByRole("region", { name: "Recommended settings" });
		expect(
			screen.getAllByRole("region", { name: "Recommended settings" }),
		).toHaveLength(1);
		expect(within(panel).getByText("100–2,000")).toBeVisible();
		const table = within(panel).getByRole("table", {
			name: "Required renditions",
		});
		expect(
			within(table).getByRole("row", { name: "360 100–400" }),
		).toBeVisible();
		expect(
			within(table).getByRole("row", { name: "720 500–2,000" }),
		).toBeVisible();
		expect(within(panel).getByText("Minimum bitrate ratio")).toBeVisible();
		expect(within(panel).getByText("Maximum bitrate ratio")).toBeVisible();
		expect(within(panel).queryByRole("spinbutton")).toBeNull();
		expect(
			within(panel).getByText(/not an optimized bitrate range/),
		).toBeVisible();
		expect(
			screen.getByRole("region", { name: "Illustrative scenarios" }),
		).not.toBeVisible();
		expect(
			screen.getByRole("spinbutton", {
				name: "Width (px, optional), rendition 1",
			}),
		).not.toBeVisible();
		expect(
			screen.getByRole("region", { name: "Automatic templates" }),
		).not.toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeVisible();
	});

	it("keeps the Japanese recommendation visible while technical details start closed", () => {
		show(goal, "ja");
		const panel = screen.getByRole("region", { name: "推奨設定" });
		expect(within(panel).getByText("指定した許容範囲 (kbps)")).toBeVisible();
		expect(within(panel).getByText("最小ビットレート比率")).toBeVisible();
		expect(
			within(panel).getByText(
				/最適なビットレート範囲を算出したものではありません/,
			),
		).toBeVisible();
		expect(screen.getByText("比較・計算の詳細")).toBeVisible();
		expect(
			screen.getByRole("region", { name: "仮定したシナリオ" }),
		).not.toBeVisible();
		expect(
			screen.getByRole("spinbutton", {
				name: "幅 (px、省略可), レンディション 1",
			}),
		).not.toBeVisible();
	});

	it("shows conflicting conditions beside the recommendation without opening details", () => {
		show({ ...goal, minBitrate: 3_000_000 });
		const panel = screen.getByRole("region", { name: "Recommended settings" });
		expect(
			within(panel).getByText(
				"Resolve the conditions below before applying these settings.",
			),
		).toBeVisible();
		expect(
			within(panel).getByText("Enter a positive, ordered bitrate interval."),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
	});

	it("separates candidate templates from the unknown output count with original rules", () => {
		show({
			...goal,
			automaticTemplates: [{ id: "automatic", height: 1080 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
			},
		});
		const panel = screen.getByRole("region", { name: "Recommended settings" });
		expect(
			within(panel).getByText("Automatic candidate count").nextElementSibling,
		).toHaveTextContent("1");
		expect(
			within(panel).getByText(/candidate count is not the output count/),
		).toBeVisible();
		expect(
			within(panel).getByText(/additional-rendition configuration/i),
		).toBeVisible();
		expect(
			within(panel).queryByText("Model count range at overall maximum"),
		).toBeNull();
		expect(
			screen.getByRole("checkbox", {
				name: "Include original additional-rendition rules",
			}),
		).not.toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
	});

	it("offers only dimensions for automatic candidates while retaining inactive source settings", async () => {
		const onChange = vi.fn();
		const automatic = {
			id: "automatic",
			height: 1080,
			width: 1920,
			minBitrate: 1_000_000,
			maxBitrate: 6_000_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 2_000_000,
			highComplexityBoundaryForMaxBitrate: 5_000_000,
		};
		renderLocalized(
			<PerTitleAutomaticTemplates
				goal={{ ...goal, automaticTemplates: [automatic] }}
				onChange={onChange}
			/>,
		);
		expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
		expect(screen.queryByRole("combobox")).toBeNull();
		await userEvent.setup().clear(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
			{ target: { value: "720" } },
		);
		expect(onChange.mock.lastCall?.[0].automaticTemplates).toEqual([
			{ ...automatic, height: 720 },
		]);
	});
});
