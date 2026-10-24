import {
	type PerTitleGoal,
	type PerTitleGoalRow,
	type PerTitleProposal,
	resolvePerTitleAnalysis,
} from "@bitovp/core";
import type {
	PerTitleSetupInput,
	PerTitleSetupIssue,
	PerTitleSetupResult,
} from "./per-title-guided-setup-model";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const height = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function automaticEdgeCount(input: PerTitleSetupInput): number {
	const edges = input.automaticEdges;
	return record(edges)
		? Number(edges.lowerHeight !== undefined) +
				Number(
					Array.isArray(edges.upperHeights) && edges.upperHeights.length > 0,
				)
		: 0;
}

export function validateAutomaticEdges(
	input: PerTitleSetupInput,
): PerTitleSetupIssue[] {
	const edges = input.automaticEdges;
	if (edges === undefined) return [];
	const issues: PerTitleSetupIssue[] = [];
	const add = (field: string, en: string, ja: string) =>
		issues.push({ code: "invalid-automatic-edge", field, message: { en, ja } });
	if (input.strategy !== "fixed-ranges")
		add(
			"strategy",
			"Use bitrate ranges to combine required renditions with automatic edges.",
			"上下の自動段を加える場合は、解像度とビットレート幅を指定してください。",
		);
	if (!record(edges)) {
		add(
			"rows",
			"Enter automatic edge requirements.",
			"上下の自動段の条件を確認してください。",
		);
		return issues;
	}
	const rows = Array.isArray(input.rows) ? input.rows : [];
	const heights = rows.map((row) => row?.height).filter(height);
	if (
		edges.lowerHeight !== undefined &&
		(!height(edges.lowerHeight) ||
			(heights.length > 0 && edges.lowerHeight >= Math.min(...heights)))
	)
		add(
			"lowerHeight",
			"Set the starting height below every required resolution.",
			"最下段の高さは、固定する解像度より低くしてください。",
		);
	const upper = edges.upperHeights;
	if (
		upper !== undefined &&
		(!Array.isArray(upper) ||
			upper.some((value) => !height(value)) ||
			new Set(upper).size !== upper.length ||
			(heights.length > 0 &&
				upper.some((value) => value <= Math.max(...heights))))
	)
		add(
			"upperHeights",
			"Use distinct candidate heights above every required resolution.",
			"上位段の候補は、固定する解像度より高い値を重複なく指定してください。",
		);
	if (
		height(input.inputHeight) &&
		((height(edges.lowerHeight) && edges.lowerHeight > input.inputHeight) ||
			(Array.isArray(upper) &&
				upper.some(
					(value) => height(value) && value > (input.inputHeight as number),
				)))
	)
		add(
			"inputHeight",
			"Keep automatic heights at or below the source height.",
			"自動段の高さは、入力素材の高さ以下にしてください。",
		);
	if (
		rows.length +
			Number(edges.lowerHeight !== undefined) +
			(Array.isArray(upper) ? upper.length : 0) >
		64
	)
		add(
			"rows",
			"Use no more than 64 templates in total.",
			"テンプレートは合計64行以内にしてください。",
		);
	return issues;
}

/** A conservative authoring guard; it does not certify a native output count. */
function leavesOneUpperRole(
	top: PerTitleGoalRow | undefined,
	proposal: PerTitleProposal,
): boolean {
	const setting = proposal.api.streams.find(
		(stream) => stream.rowId === top?.id,
	)?.perTitleSettings;
	const global = proposal.api.global;
	const start = resolvePerTitleAnalysis(
		proposal.api,
		global.minBitrate,
	).complexityInput;
	const minimum = setting?.minBitrate;
	const maximum = setting?.maxBitrate;
	const low = setting?.lowComplexityBoundaryForMaxBitrate;
	const high = setting?.highComplexityBoundaryForMaxBitrate;
	if (
		start === null ||
		start > global.maxBitrate ||
		minimum === undefined ||
		maximum === undefined ||
		low === undefined ||
		high === undefined ||
		high <= low
	)
		return false;
	const step = global.minBitrateStepSize;
	const ratio = step - 0.01;
	if (ratio <= 1) return false;
	const span = maximum - minimum;
	// Effective minima are bounded by the smaller of the floored target and
	// rounded C/step. Two and one bits respectively cover rounding conservatively.
	const cuts = [
		start,
		global.maxBitrate,
		low,
		...(span > 0 ? [low + (2 * (high - low)) / span] : []),
		step * (minimum + 1),
	];
	// On each piece both lower bounds are affine. C/bound is monotone, so its
	// extrema are at a clamp boundary or an endpoint, including real-valued cuts.
	return cuts
		.filter((value) => value >= start && value <= global.maxBitrate)
		.every((value) => {
			const fraction = Math.max(0, Math.min(1, (value - low) / (high - low)));
			const targetFloor = Math.max(minimum, minimum + fraction * span - 2);
			const roundedFloor = Math.max(minimum, value / step - 1);
			return (
				value / Math.min(targetFloor, roundedFloor) <
				ratio ** 2 * (1 - 16 * Number.EPSILON)
			);
		});
}

/** Add declared edge roles without equating probe templates with output count. */
export function buildPerTitleEdgeSetup(
	input: PerTitleSetupInput,
	initialRows: readonly PerTitleGoalRow[],
): PerTitleSetupResult {
	const edges = input.automaticEdges;
	const upper = edges?.upperHeights ?? [];
	const hasUpper = upper.length > 0;
	const ids = new Set(initialRows.map((row) => row.id));
	const identity = (base: string) => {
		let id = base;
		for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
		ids.add(id);
		return id;
	};
	const automaticTemplates = [
		...(edges?.lowerHeight === undefined
			? []
			: [{ id: identity("setup-lower"), height: edges.lowerHeight }]),
		...upper.map((value, index) => ({
			id: identity(`setup-upper-${index + 1}`),
			height: value,
		})),
	];
	const highestHeight = Math.max(...initialRows.map((row) => row.height));
	const top = [...initialRows]
		.filter((row) => row.height === highestHeight)
		.sort((a, b) => (b.minBitrate ?? 0) - (a.minBitrate ?? 0))[0];
	const topMin = top?.minBitrate ?? NaN;
	const topMax = top?.maxBitrate ?? NaN;
	// Prefer the usual minimum ratio. Other candidates are simple editing values,
	// each certified again against the complete complexity interval below.
	const steps = Array.from(
		{ length: 59 },
		(_, index) => (index + 22) / 20,
	).sort((a, b) => Math.abs(a - 1.5) - Math.abs(b - 1.5) || a - b);
	for (const minimumStep of steps) {
		// The logarithmic midpoint leaves a fallback below a normal ratio step.
		// This is an authoring policy, not an Encoding API default.
		const root = Math.sqrt(minimumStep);
		const factor =
			Math.floor(root * (root >= 1.1 ? 10 : 100)) / (root >= 1.1 ? 10 : 100);
		const low = hasUpper ? Math.round(topMin * factor) : topMin;
		if (
			!Number.isSafeInteger(low) ||
			low < 1 ||
			low >= input.maxBitrate ||
			(hasUpper &&
				(factor <= 1 ||
					factor >= minimumStep ||
					low <= topMin ||
					Math.round(topMax * factor) > input.maxBitrate))
		)
			continue;
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: input.codec,
			minBitrate: input.minBitrate,
			maxBitrate: input.maxBitrate,
			minBitrateStepSize: minimumStep,
			// A wide fixed-range starting ceiling also connects a lower template.
			// Four is a documented example, not the provider's default ceiling.
			maxBitrateStepSize: Math.max(4, minimumStep),
			countPolicy: {
				kind: "exact",
				count: initialRows.length + automaticEdgeCount(input),
			},
			autoRepresentations: false,
			automaticTemplates,
			rows: initialRows.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: low,
				highComplexityBoundaryForMaxBitrate: input.maxBitrate,
			})),
			...(hasUpper
				? {
						fixedResolutionAndBitrateConfiguration: {
							forcedRenditionAboveHighestFixedRepresentation: 1,
							forcedRenditionAboveHighestFixedRepresentationFactor: factor,
							forcedRenditionAboveHighestFixedRepresentationCalculationMode:
								"LAST_CALCULATED_BITRATE",
						},
					}
				: {}),
			...(input.inputHeight === undefined
				? {}
				: { inputHeight: input.inputHeight }),
		};
		let tuned = tunePerTitleSettings(goal, goal);
		let ladder = assessPerTitleLadder(goal, tuned.proposal);
		const proof = ladder.intervals;
		if (
			!proof ||
			proof.maximumWithinRowRatio + 0.01 >= minimumStep ||
			(proof.minimumAdjacentRatio ?? Infinity) < minimumStep ||
			(edges?.lowerHeight !== undefined &&
				(ladder.lowerSlots === null || ladder.lowerSlots.minimum < 1)) ||
			(hasUpper &&
				(ladder.upperSlots === null ||
					ladder.upperSlots.maximum > 1 ||
					!leavesOneUpperRole(top, tuned.proposal)))
		)
			continue;
		const neededMaximum = Math.max(
			4,
			minimumStep,
			proof.maximumAdjacentRatio ?? minimumStep,
			ladder.lowerConnection?.maximumRatio ?? minimumStep,
		);
		goal.maxBitrateStepSize = Math.ceil(neededMaximum * 10) / 10;
		tuned = tunePerTitleSettings(goal, goal);
		ladder = assessPerTitleLadder(goal, tuned.proposal);
		if (
			tuned.proposal.diagnostics.some((item) => item.severity === "conflict") ||
			(hasUpper &&
				(ladder.upperSlots === null ||
					ladder.upperSlots.maximum > 1 ||
					!leavesOneUpperRole(top, tuned.proposal)))
		)
			continue;
		// A fresh setup must not silently change user bands or its explicit seeds.
		const again = tunePerTitleSettings(tuned.goal, tuned.goal);
		if (
			JSON.stringify(again.proposal.api) !== JSON.stringify(tuned.proposal.api)
		)
			continue;
		const fixed = tuned.proposal.api.streams.filter(
			(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
		);
		if (
			fixed.length !== initialRows.length ||
			initialRows.some((row) => {
				const actual = fixed.find((stream) => stream.rowId === row.id);
				return (
					actual?.height !== row.height ||
					actual?.perTitleSettings?.minBitrate !== row.minBitrate ||
					actual?.perTitleSettings?.maxBitrate !== row.maxBitrate
				);
			})
		)
			continue;
		return {
			status: "unverified",
			goal: tuned.goal,
			proposal: tuned.proposal,
			issues: [
				{
					code: "mixed-count-conditional",
					field: "count",
					message: {
						en: "The count describes required roles. Ordinary templates can be reused; confirm the actual count by encoding your source.",
						ja: "本数は必要な段の構成を表します。自動段から複数本が生成される可能性があるため、実際の本数はエンコードで確認してください。",
					},
				},
			],
			reasoning: [
				{
					en: "Fixed bitrate bands are retained. A shared complexity scale follows the highest fixed band's fallback floor and the overall ceiling. Spacing is checked across that scale; the fallback is below a normal ratio step. These settings do not predict the source's quality or analysis result.",
					ja: "固定段のビットレート幅を維持し、最高固定段の強制追加で生じる下限から全体上限までを共通の複雑度境界にしています。その区間で段間隔を確認し、強制追加の間隔は通常の段間隔より小さくしています。素材の画質や解析結果を予測した値ではありません。",
				},
			],
		};
	}
	return {
		status: "conflict",
		goal: null,
		proposal: null,
		issues: [
			{
				code: "mixed-spacing-conflict",
				field: "rows",
				message: {
					en: "No checked spacing candidate retains these bands and the automatic edge requirements. Narrow overlapping bands or leave more room above the highest fixed band.",
					ja: "この範囲と上下の自動段を保てる段間隔を確認できません。重なる幅を狭めるか、最高固定段より上の帯域を広げてください。",
				},
			},
		],
		reasoning: [],
	};
}
