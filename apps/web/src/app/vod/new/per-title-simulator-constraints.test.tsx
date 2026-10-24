import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleConstraints } from "./per-title-simulator-constraints";

function proposal(): PerTitleProposal {
	return {
		id: "step-adjusted",
		codec: "H264",
		status: "candidate",
		applicable: true,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100000,
				maxBitrate: 2000000,
				minBitrateStepSize: 1.25,
				maxBitrateStepSize: 3,
			},
			streams: [
				{
					rowId: "private-looking-row-id",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				},
			],
		},
		scenarios: [],
		diagnostics: [],
		derivation: {
			method: "joint-constraints",
			requiredRowCount: 1,
			selectedMinStep: 1.25,
			selectedMaxStep: 3,
			targetSatisfied: true,
			rationale: "INTERNAL_RATIONALE",
			constraints: {
				status: "checked",
				scope: "closed-ladder",
				inputRange: { minimum: 100000, maximum: 2000000 },
				floorRange: { minimum: 100000, maximum: 400000 },
				calibration: {
					low: 400000,
					high: 2000000,
					rowIds: ["private-looking-row-id"],
				},
				spacing: {
					minimumExclusive: 1.1,
					maximumInclusive: 1.5,
					checkedSegments: 4,
				},
				forced: {
					count: 1,
					factor: 1.5,
					calculationMode: "LAST_CALCULATED_BITRATE",
					conditional: false,
					maximumFactor: 1.75,
					ranges: [{ minimum: 600000, maximum: 900000 }],
				},
				changes: [
					{ field: "minimumStep", before: 1.5, after: 1.25 },
					{ field: "forcedFactor", before: 2, after: 1.5 },
					{
						field: "forcedMode",
						before: "MAXIMUM",
						after: "LAST_CALCULATED_BITRATE",
					},
				],
				checkpoints: [
					{
						input: 400000,
						rows: [
							{
								rowId: "private-looking-row-id",
								minimum: 100000,
								maximum: 125000,
							},
						],
					},
				],
				conditions: ["INTERNAL_ENGLISH_CONDITION"],
			},
		},
	};
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test analysis");
	return value;
}
const analysis = (value: PerTitleProposal) =>
	required(required(value.derivation).constraints);

function disabledAdditionalRuleGoal(): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 2_400_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "maximum", count: 6 },
		autoRepresentations: false,
		rows: [
			{ id: "lower", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
			{ id: "middle", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
			{
				id: "upper",
				height: 720,
				minBitrate: 1_000_000,
				maxBitrate: 1_200_000,
			},
		],
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.37,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: "MINIMUM",
		},
	};
}

function derivationValues(
	settings: Pick<
		PerTitleGoal,
		| "minBitrateStepSize"
		| "maxBitrateStepSize"
		| "fixedResolutionAndBitrateConfiguration"
	>,
) {
	const rule = settings.fixedResolutionAndBitrateConfiguration;
	return {
		minimumStep: settings.minBitrateStepSize,
		maximumStep: settings.maxBitrateStepSize,
		forcedCount: rule?.forcedRenditionAboveHighestFixedRepresentation,
		forcedFactor: rule?.forcedRenditionAboveHighestFixedRepresentationFactor,
		forcedMode:
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
	};
}

function expectApiConsistentChanges(
	goal: PerTitleGoal,
	value: PerTitleProposal,
	locale: "en" | "ja",
) {
	const source = derivationValues(goal);
	const emitted = derivationValues(
		JSON.parse(JSON.stringify(value.api.global)),
	);
	const report = analysis(value);
	const changes = screen.getByRole("table", {
		name: locale === "en" ? "Parameter changes" : "パラメータの変更",
	});
	const rows = within(changes).getAllByRole("row").slice(1);
	const actual = report.changes;
	const expected = (Object.keys(source) as (keyof typeof source)[])
		.filter((field) => source[field] !== emitted[field])
		.map((field) => ({ field, before: source[field], after: emitted[field] }));
	expect(actual).toEqual(expected);
	expect(rows).toHaveLength(expected.length);
	const labels = {
		minimumStep: locale === "en" ? "Minimum ratio" : "最小比率",
		maximumStep: locale === "en" ? "Maximum ratio" : "最大比率",
		forcedCount:
			locale === "en" ? "Additional-rendition count" : "追加レンディション数",
		forcedFactor:
			locale === "en"
				? "Additional-rendition factor"
				: "追加レンディションの倍率",
		forcedMode:
			locale === "en"
				? "Additional-rendition calculation"
				: "追加レンディションの計算方法",
	};
	const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 });
	for (const change of expected) {
		const row = within(changes).getByRole("row", {
			name: new RegExp(labels[change.field]),
		});
		const cells = within(row).getAllByRole("cell");
		for (const [index, value] of [change.before, change.after].entries()) {
			expect(typeof value).toBe("number");
			if (typeof value !== "number") throw new Error("Expected a ratio change");
			expect(cells[index]).toHaveTextContent(`≈ ${number.format(value)}`);
		}
	}
	expect(changes).not.toHaveTextContent(locale === "en" ? "Removed" : "削除");
}

describe("Per-Title parameter derivation", () => {
	it.each([
		{ locale: "en", locked: false },
		{ locale: "ja", locked: false },
		{ locale: "en", locked: true },
		{ locale: "ja", locked: true },
	] as const)("explains a retained compatible factor independently of its upper limit ($locale, locked=$locked)", ({
		locale,
		locked,
	}) => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 2 },
			autoRepresentations: false,
			rows: [
				{ id: "point", height: 720, minBitrate: 200_000, maxBitrate: 200_000 },
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			...(locked
				? {
						settingLocks: {
							global: [
								"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
							],
						},
					}
				: {}),
		};
		const before = structuredClone(goal);
		const value = recommendPerTitleSettings(goal);
		const report = analysis(value);
		expect(value.applicable).toBe(true);
		expect(
			value.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(2);
		expect(report.forced.factor).toBe(2);
		expect(report.forced.maximumFactor).toBeGreaterThan(4.9);
		expect(
			report.changes.some((change) => change.field === "forcedFactor"),
		).toBe(false);
		renderLocalized(<PerTitleConstraints proposal={value} />, locale);
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Parameter derivation" : "パラメータの導出",
			),
		);
		const factor = screen.getByText(
			locale === "en"
				? "Additional-rendition factor"
				: "追加レンディションの倍率",
		);
		expect(factor.nextElementSibling).toHaveTextContent("≈ 2");
		const limit = screen.getByText(
			locale === "en" ? "Calculated factor upper bound" : "計算上の倍率の上限",
		);
		expect(limit.nextElementSibling).not.toHaveTextContent(/^≈ 2$/);
		expect(
			screen.getByText(
				locale === "en"
					? /Compatible saved factors within the limit are kept/
					: /条件に合う上限内の既存倍率は維持/,
			),
		).toBeVisible();
		expect(
			screen.queryByText(
				locale === "en"
					? /The proposal uses this calculated limit/
					: /倍率の上限を求めて採用します/,
			),
		).toBeNull();
		expect(goal).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("matches all five change fields to the emitted API with saved disabled-rule metadata (%s)", (locale) => {
		const goal = disabledAdditionalRuleGoal();
		const before = structuredClone(goal);
		const value = recommendPerTitleSettings(goal);
		expect(value.applicable).toBe(true);
		expect(value.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			goal.fixedResolutionAndBitrateConfiguration,
		);
		renderLocalized(<PerTitleConstraints proposal={value} />, locale);
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Parameter derivation" : "パラメータの導出",
			),
		);
		expect(
			screen.queryAllByText(locale === "en" ? "Removed" : "削除"),
		).toHaveLength(0);
		expectApiConsistentChanges(goal, value, locale);
		expect(analysis(value).changes.map((change) => change.field)).toEqual([
			"minimumStep",
			"maximumStep",
		]);
		expect(goal).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("recomputes the change table after adopting one ratio and keeping metadata (%s)", (locale) => {
		const goal = disabledAdditionalRuleGoal();
		const first = recommendPerTitleSettings(goal);
		const selected: PerTitleGoal = {
			...goal,
			minBitrateStepSize: first.api.global.minBitrateStepSize,
			settingLocks: {
				global: [
					"minBitrateStepSize",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationCalculationMode",
				],
			},
		};
		const before = structuredClone(selected);
		const reevaluated = recommendPerTitleSettings(selected);
		expect(reevaluated.api.global.minBitrateStepSize).toBe(
			selected.minBitrateStepSize,
		);
		expect(
			reevaluated.api.global.fixedResolutionAndBitrateConfiguration,
		).toEqual(goal.fixedResolutionAndBitrateConfiguration);
		const { rerender } = renderLocalized(
			<PerTitleConstraints proposal={first} />,
			locale,
		);
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Parameter derivation" : "パラメータの導出",
			),
		);
		rerender(<PerTitleConstraints proposal={reevaluated} />);
		expectApiConsistentChanges(selected, reevaluated, locale);
		expect(analysis(reevaluated).changes.map((change) => change.field)).toEqual(
			["maximumStep"],
		);
		expect(selected).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("explains the mixed-template calibration independently of the lower limit (%s)", (locale) => {
		const value = proposal();
		analysis(value).calibration = {
			low: 1_250_000,
			high: 2_000_000,
			rowIds: ["private-looking-row-id"],
			origin: {
				kind: "fixed-minimum-step",
				minimumBitrate: 1_000_000,
				minimumStep: 1.25,
			},
		};
		renderLocalized(<PerTitleConstraints proposal={value} />, locale);
		const explanation = screen.getByText(/1,000 × 1.25 = 1,250 kbps/);
		expect(explanation).not.toBeVisible();
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Parameter derivation" : "パラメータの導出",
			),
		);
		expect(explanation).toBeVisible();
		expect(explanation).toHaveTextContent(
			locale === "en"
				? /not the additional-rendition factor/
				: /追加段の倍率とは別/,
		);
		expect(
			screen.queryByText(
				locale === "en"
					? /F is the upper end/
					: /Fは、計算に使う下限範囲の上端/,
			),
		).not.toBeInTheDocument();
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps numeric derivation closed and localizes its scope (%s)", (locale) => {
		const value = proposal();
		const before = structuredClone(value);
		const { container } = renderLocalized(
			<PerTitleConstraints proposal={value} />,
			locale,
		);
		const summary = screen.getByText(
			locale === "en" ? "Parameter derivation" : "パラメータの導出",
		);
		expect(summary.closest("details")).not.toHaveAttribute("open");
		const calibration = screen.getByText(
			locale === "en"
				? "Recommended complexity boundaries (kbps)"
				: "推奨する複雑度境界 (kbps)",
		);
		expect(calibration).not.toBeVisible();
		const forcedHint = screen.queryByText(
			locale === "en"
				? /Ordinary minimum and maximum bitrate steps do not apply to additional renditions/
				: /通常の最小・最大ビットレート間隔は追加段には適用しません/,
		);
		expect(forcedHint).not.toBeNull();
		expect(forcedHint).not.toBeVisible();
		const calibrationRule = screen.queryByText(
			locale === "en"
				? /calculated floor F and overall maximum U/
				: /計算した下限Fと全体の上限U/,
		);
		const spacingRule = screen.queryByText(
			locale === "en"
				? /integer rounding and the model's safety margin/
				: /整数への丸めとモデルの安全余裕/,
		);
		const additionalRule = screen.queryByText(
			locale === "en" ? /N minus the required rows/ : /Nから必須行数を引いた数/,
		);
		for (const explanation of [calibrationRule, spacingRule, additionalRule]) {
			expect(explanation).not.toBeNull();
			expect(explanation).not.toBeVisible();
		}
		fireEvent.click(summary);
		expect(calibration).toBeVisible();
		expect(forcedHint).toBeVisible();
		for (const explanation of [calibrationRule, spacingRule, additionalRule])
			expect(explanation).toBeVisible();
		expect(calibration.nextElementSibling).toHaveTextContent("400–2,000");
		expect(
			screen.getByText(
				locale === "en"
					? /tool recommendations, not provider defaults/
					: /ツールが提案する値で、APIの既定値ではありません/,
			),
		).toBeVisible();
		expect(
			screen.getByText(
				locale === "en"
					? /Changing the minimum ratio requires another check/
					: /最小比率を変えたら再計算が必要です/,
			),
		).toBeVisible();
		const changes = screen.getByRole("table", {
			name: locale === "en" ? "Parameter changes" : "パラメータの変更",
		});
		expect(
			within(changes).getByRole("row", {
				name:
					locale === "en" ? /Minimum ratio.*1.5.*1.25/ : /最小比率.*1.5.*1.25/,
			}),
		).toBeVisible();
		const checkpoints = screen.getByRole("table", {
			name:
				locale === "en"
					? "Effective ranges at checkpoints"
					: "確認点ごとの有効範囲",
		});
		expect(checkpoints).toHaveTextContent("400");
		expect(checkpoints).toHaveTextContent("360 px");
		expect(checkpoints).toHaveTextContent("100–125");
		expect(container).not.toHaveTextContent(
			/private-looking-row-id|INTERNAL_|joint-constraints/,
		);
		expect(value).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("distinguishes conditional unknown results and explicit removals (%s)", (locale) => {
		const value = proposal();
		value.status = "unknown";
		value.applicable = false;
		required(value.derivation).targetSatisfied = false;
		const report = analysis(value);
		report.status = "unknown";
		report.scope = "conditional";
		report.forced.conditional = true;
		report.changes = [{ field: "forcedFactor", before: 1.5, after: undefined }];
		renderLocalized(<PerTitleConstraints proposal={value} />, locale);
		fireEvent.click(
			screen.getByText(
				locale === "en" ? "Parameter derivation" : "パラメータの導出",
			),
		);
		expect(
			screen.getByText(
				locale === "en"
					? "Joint conditions not established"
					: "組み合わせた条件は未確認",
			),
		).toBeVisible();
		expect(
			screen.queryByText(
				locale === "en"
					? "Interval and count conditions checked"
					: "区間・本数の条件を確認",
			),
		).toBeNull();
		expect(
			screen.getByText(
				locale === "en"
					? /Automatic templates or unresolved branches make this a conditional calculation/
					: /自動テンプレートや未確定の分岐を含む条件付きの計算です/,
			),
		).toBeVisible();
		expect(
			screen.getByText(locale === "en" ? "Removed" : "削除"),
		).toBeVisible();
	});
	it("does not display invalid numbers or invent an absent analysis", () => {
		const value = proposal();
		const { container, rerender } = renderLocalized(
			<PerTitleConstraints proposal={{ ...value, derivation: undefined }} />,
		);
		expect(container).toBeEmptyDOMElement();
		const report = analysis(value);
		report.calibration = undefined;
		report.inputRange = { minimum: NaN, maximum: Infinity };
		report.floorRange = null;
		report.spacing = undefined;
		report.forced = {
			count: null,
			factor: null,
			conditional: true,
			ranges: [],
		};
		report.changes = [];
		report.checkpoints = [];
		rerender(<PerTitleConstraints proposal={value} />);
		fireEvent.click(screen.getByText("Parameter derivation"));
		expect(container).not.toHaveTextContent(/NaN|Infinity/);
		expect(
			screen.queryByText("Recommended complexity boundaries (kbps)"),
		).toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getAllByText("Not established").length).toBeGreaterThan(0);
	});
});
