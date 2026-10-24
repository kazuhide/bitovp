import {
	boundComplexityRange,
	certifyComplexityIntervals,
	evaluateComplexityRange,
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleProposal,
} from "@bitovp/core";
import { perTitleAnalysisCurve } from "./per-title-simulator-analysis-ladder";

type Interval = { minimum: number; maximum: number };
type Stream = PerTitleProposal["api"]["streams"][number];
export type PerTitleUpperLimitAssessment = {
	status: "not-applicable" | "satisfied" | "conflict" | "unknown";
	limit: 1 | null;
	highestFixedRowId?: string;
	finding: {
		code: string;
		severity: "conflict";
		message: { en: string; ja: string };
	} | null;
	domain?: Interval;
	witness?: {
		input: number;
		fixed: Interval;
		ordinary: readonly number[];
		branch: "ordinary" | "forced";
	};
};
const FIXED = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
const ORDINARY = "PER_TITLE_TEMPLATE";
const rate = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const kbps = (value: number) =>
	new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
		value / 1000,
	);
const bits = new DataView(new ArrayBuffer(8));
function nextUp(value: number): number {
	if (!Number.isFinite(value) || value < 0) return Infinity;
	bits.setFloat64(0, value);
	bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
	return bits.getFloat64(0);
}
function nextRate(value: number, step: number): number | null {
	let next = Math.ceil(value * step);
	if (!rate(next) || next <= value) return null;
	if (next / value < step) next++;
	if ((next - 1) / value >= step) next--;
	return rate(next) && next > value && next / value >= step ? next : null;
}
const inTolerance = (ratio: number, minimum: number, maximum: number) =>
	ratio - minimum > -0.01 && ratio - maximum < 0.01;

/**
 * A sufficient conditional settings check for an explicitly declared single upper
 * role. It does not certify native output count, analysis input, or media quality.
 * Upper templates are reusable; forced additions are an alternative branch.
 */
function assessUpperLimit(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleUpperLimitAssessment {
	const result: PerTitleUpperLimitAssessment = {
		status: "not-applicable",
		limit: null,
		finding: null,
	};
	try {
		if (
			goal?.strategy !== "fixed-ranges" ||
			goal.countPolicy?.kind !== "exact" ||
			!Array.isArray(goal.rows) ||
			!goal.rows.length ||
			goal.countPolicy.count !== goal.rows.length + 2 ||
			!Array.isArray(goal.automaticTemplates) ||
			goal.automaticTemplates.length < 2
		)
			return result;
		result.status = "unknown";
		result.limit = 1;
		if (
			!record(proposal?.api) ||
			!record(proposal.api.global) ||
			!Array.isArray(proposal.api.streams)
		)
			return result;
		const { global, streams } = proposal.api;
		const sourceRows = goal.rows,
			sourceTemplates = goal.automaticTemplates;
		const s = global.minBitrateStepSize,
			maximumStep = global.maxBitrateStepSize;
		if (
			!rate(global.minBitrate) ||
			!rate(global.maxBitrate) ||
			global.minBitrate > global.maxBitrate ||
			global.minBitrate !== goal.minBitrate ||
			global.maxBitrate !== goal.maxBitrate ||
			proposal.codec !== goal.codec ||
			!Number.isFinite(s) ||
			s <= 1 ||
			!Number.isFinite(maximumStep) ||
			maximumStep < s ||
			(goal.minBitrateStepSize !== undefined &&
				goal.minBitrateStepSize !== s) ||
			(goal.maxBitrateStepSize !== undefined &&
				goal.maxBitrateStepSize !== maximumStep) ||
			global.autoRepresentations !== undefined ||
			streams.length > 64 ||
			streams.some(
				(stream) =>
					!record(stream) ||
					typeof stream.rowId !== "string" ||
					!stream.rowId ||
					(stream.width !== undefined && !rate(stream.width)) ||
					(stream.height !== undefined && !rate(stream.height)),
			) ||
			new Set(streams.map((stream) => stream.rowId)).size !== streams.length
		)
			return result;
		const fixed = streams.filter((stream) => stream.mode === FIXED);
		const ordinary = streams.filter((stream) => stream.mode === ORDINARY);
		if (
			fixed.length !== goal.rows.length ||
			ordinary.length !== goal.automaticTemplates.length ||
			fixed.length + ordinary.length !== streams.length
		)
			return result;
		const sourceMatches = (
			stream: Stream,
			source: { id: string; height?: number; width?: number } | undefined,
		) =>
			source !== undefined &&
			source.height === stream.height &&
			source.width === stream.width;
		if (
			fixed.some((stream) => {
				const source = sourceRows.find((row) => row.id === stream.rowId),
					settings = stream.perTitleSettings;
				return (
					!sourceMatches(stream, source) ||
					!source ||
					!settings ||
					settings.minBitrate !== source.minBitrate ||
					settings.maxBitrate !== source.maxBitrate ||
					(settings.bitrateSelectionMode ?? "OPTIMIZED") !==
						(source.bitrateSelectionMode ?? "OPTIMIZED") ||
					settings.lowComplexityBoundaryForMaxBitrate !==
						source.lowComplexityBoundaryForMaxBitrate ||
					settings.highComplexityBoundaryForMaxBitrate !==
						source.highComplexityBoundaryForMaxBitrate ||
					!rate(settings.minBitrate) ||
					!rate(settings.maxBitrate) ||
					settings.minBitrate > settings.maxBitrate ||
					settings.minBitrate < global.minBitrate ||
					settings.maxBitrate > global.maxBitrate
				);
			}) ||
			ordinary.some(
				(stream) =>
					!sourceMatches(
						stream,
						sourceTemplates.find((row) => row.id === stream.rowId),
					),
			)
		)
			return result;
		const basis = streams.every(
			(stream) => stream.width === undefined && rate(stream.height),
		)
			? "height"
			: streams.every((stream) => rate(stream.width))
				? "width"
				: null;
		if (
			!basis ||
			streams.some((a) =>
				streams.some(
					(b) =>
						rate(a.width) &&
						rate(b.width) &&
						rate(a.height) &&
						rate(b.height) &&
						(a.width - b.width) * (a.height - b.height) < 0,
				),
			)
		)
			return result;
		const ordered = [...fixed].sort(
			(a, b) => (a[basis] as number) - (b[basis] as number),
		);
		const first = ordered[0],
			top = ordered.at(-1);
		if (!first || !top) return result;
		if (fixed.filter((stream) => stream[basis] === top[basis]).length !== 1)
			return result;
		const lower = ordinary.filter(
			(stream) => (stream[basis] as number) < (first[basis] as number),
		);
		const upper = ordinary.filter(
			(stream) => (stream[basis] as number) > (top[basis] as number),
		);
		if (
			lower.length !== 1 ||
			!upper.length ||
			lower.length + upper.length !== ordinary.length ||
			new Set(upper.map((stream) => stream[basis])).size !== upper.length
		)
			return result;
		result.highestFixedRowId = top.rowId;
		const settings = top.perTitleSettings;
		if (!rate(settings?.minBitrate) || !rate(settings?.maxBitrate))
			return result;
		const configured = {
			minimum: settings.minBitrate,
			maximum: settings.maxBitrate,
		};
		const curve = perTitleAnalysisCurve(top);
		const mode = top.perTitleSettings?.bitrateSelectionMode;
		if (!curve && mode !== undefined && mode !== "OPTIMIZED") return result;
		const rule = global.fixedResolutionAndBitrateConfiguration;
		const count =
			rule?.forcedRenditionAboveHighestFixedRepresentation ?? (rule ? NaN : 0);
		const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > 256 ||
			(count > 0 &&
				(typeof factor !== "number" ||
					!Number.isFinite(factor) ||
					factor <= 1 ||
					rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
						"LAST_CALCULATED_BITRATE"))
		)
			return result;
		const originalRule = goal.fixedResolutionAndBitrateConfiguration;
		if (
			rule?.forcedRenditionAboveHighestFixedRepresentation !==
				originalRule?.forcedRenditionAboveHighestFixedRepresentation ||
			rule?.forcedRenditionAboveHighestFixedRepresentationFactor !==
				originalRule?.forcedRenditionAboveHighestFixedRepresentationFactor ||
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
				originalRule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode
		)
			return result;
		// Raw analysis may be below the global minimum. The configured highest fixed
		// minimum establishes the driver floor; this truncation differs from additions.
		const floor = Math.trunc(
			configured.minimum * (count ? (factor as number) ** count : 1),
		);
		if (!rate(floor)) return result;
		const domain = {
			minimum: floor,
			maximum: Math.max(floor, global.maxBitrate),
		};
		result.domain = domain;
		// Configured ranges may overlap while their effective same-input rates do
		// not. Require the highest fixed row to dominate every other fixed row over
		// the entire driver domain, including the interior q relaxation.
		for (const stream of fixed) {
			if (
				stream === top ||
				(stream.perTitleSettings?.maxBitrate ?? Infinity) < configured.minimum
			)
				continue;
			const other = perTitleAnalysisCurve(stream);
			if (!other || !curve) return result;
			const ordering = certifyComplexityIntervals([other, curve], domain, s);
			if (!ordering?.minimumAdjacentRatio || ordering.minimumAdjacentRatio <= 1)
				return result;
		}
		const at = (input: number): Interval | null =>
			curve
				? evaluateComplexityRange({ ...curve, input, minStep: s })
				: configured;
		const bounds = (input: Interval): Interval | null =>
			curve ? boundComplexityRange(curve, input, s) : configured;
		const conflict = (
			input: number,
			range: Interval,
			points: number[],
			branch: "ordinary" | "forced",
		) => ({
			...result,
			status: "conflict" as const,
			finding: {
				code: "upper-output-limit",
				severity: "conflict" as const,
				message: {
					en: `The upper role allows at most one output. At an analysis bitrate of ${kbps(input)} kbps, the highest fixed rate of ${kbps(range.minimum)} kbps permits upper rates of ${points.map(kbps).join(" / ")} kbps. Adjust the settings and re-evaluate; this is a conditional placement check.`,
					ja: `最高固定段より上は最大1出力という要件に対し、解析値が${kbps(input)} kbps、最高固定段が${kbps(range.minimum)} kbpsの場合、上位に${points.map(kbps).join(" / ")} kbpsの2本を置けます。設定を調整して再評価してください。これは解析値を仮定した配置検証です。`,
				},
			},
			witness: { input, fixed: range, ordinary: points, branch },
		});
		const witness = (input: number): PerTitleUpperLimitAssessment | null => {
			const range = at(input);
			if (!range) return null;
			const cap = Math.min(input, global.maxBitrate),
				q = range.minimum;
			if (count > 1 && cap / q - s <= -0.01) {
				const points = evaluateForcedRenditions({
					base: { minimum: q, maximum: q },
					count,
					factor: factor as number,
				});
				if (
					points &&
					points.length > 1 &&
					points.every(
						(point, index) => point.minimum > (points[index - 1]?.minimum ?? q),
					)
				)
					return conflict(
						input,
						range,
						points.slice(0, 2).map((point) => point.minimum),
						"forced",
					);
			}
			const one = nextRate(q, s),
				two = one === null ? null : nextRate(one, s);
			if (
				one !== null &&
				two !== null &&
				two <= cap &&
				one / q <= maximumStep &&
				two / one <= maximumStep
			)
				return conflict(input, range, [one, two], "ordinary");
			// Check the tolerated, truncated root branch as a same-input witness too.
			const root = (cap / q) ** 0.5,
				first = Math.trunc(q * root);
			if (
				Math.trunc(q * maximumStep ** 2) > cap &&
				inTolerance(root, s, maximumStep) &&
				rate(first) &&
				first > q &&
				first < cap &&
				inTolerance(first / q, s, maximumStep) &&
				inTolerance(cap / first, s, maximumStep)
			)
				return conflict(input, range, [first, cap], "ordinary");
			return null;
		};
		const queue: Interval[] = [domain];
		let checked = 0;
		let unresolved = false;
		while (queue.length && checked++ < 2048) {
			const part = queue.pop();
			if (!part) return result;
			const range = bounds(part);
			if (!range) return result;
			const end = Math.min(part.maximum, global.maxBitrate),
				q = range.minimum;
			for (const input of new Set([
				part.minimum,
				part.maximum,
				part.minimum + Math.floor((part.maximum - part.minimum) / 2),
			])) {
				const found = witness(input);
				if (found) return found;
			}
			// Upward division and root margins prevent squared-double equality from
			// admitting an accepted root branch. Native-count proof remains separate.
			const rootBound = nextUp(nextUp(Math.sqrt(nextUp(end / q))));
			const maximumNext = Math.trunc(q * maximumStep);
			const safe =
				rootBound - s <= -0.01 &&
				Number.isSafeInteger(maximumNext) &&
				end <= maximumNext;
			if (safe && count <= 1) continue;
			if (part.minimum === part.maximum) {
				unresolved = true;
				continue;
			}
			const middle =
				part.minimum + Math.floor((part.maximum - part.minimum) / 2);
			queue.push(
				{ minimum: middle + 1, maximum: part.maximum },
				{ minimum: part.minimum, maximum: middle },
			);
		}
		return !queue.length && !unresolved
			? { ...result, status: "satisfied" }
			: result;
	} catch {
		return result;
	}
}

/** Unknown hard requirements also block adoption; they are not evidence of compliance. */
export function assessPerTitleUpperLimit(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleUpperLimitAssessment {
	const result = assessUpperLimit(goal, proposal);
	return result.status === "unknown"
		? {
				...result,
				finding: {
					code: "upper-output-limit-unverified",
					severity: "conflict",
					message: {
						en: "The declared maximum of one output above the highest fixed rendition could not be verified for every permitted input. Adjust the settings and re-evaluate before applying.",
						ja: "最高固定段より上は最大1出力という要件を、許容される入力全体で検証できませんでした。適用前に設定を調整して再評価してください。",
					},
				},
			}
		: result;
}
