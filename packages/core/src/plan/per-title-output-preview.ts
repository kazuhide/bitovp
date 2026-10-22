import { evaluateComplexityRange } from "./per-title-constraints";
import type {
	PerTitleApiSettings,
	PerTitleProposal,
} from "./per-title-simulator.js";

export type PerTitleOutputPreview = {
	analysisInput: number | null;
	status: "example" | "partial" | "unavailable";
	rows: Array<{
		id: string;
		rowId?: string;
		height?: number;
		width?: number;
		mode?: PerTitleApiSettings["streams"][number]["mode"];
		kind: "fixed" | "automatic" | "additional" | "unassigned";
		status: "example" | "conditional" | "unknown";
		bitrate?: number;
		minimumBitrate?: number;
		maximumBitrate?: number;
	}>;
	unresolvedAdditional: boolean;
};

/** Read-only arithmetic examples and unresolved candidates from the emitted API settings. */
export function previewPerTitleOutput(
	proposal: PerTitleProposal,
): PerTitleOutputPreview {
	const global = proposal.api.global;
	const streams = proposal.api.streams;
	const positive = (value: number | undefined): value is number =>
		value !== undefined &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= 2_147_483_647;
	const validGlobal =
		positive(global.minBitrate) &&
		positive(global.maxBitrate) &&
		global.minBitrate <= global.maxBitrate;
	const analysisInput = validGlobal ? global.maxBitrate : null;
	const validSteps =
		Number.isFinite(global.minBitrateStepSize) &&
		global.minBitrateStepSize > 1 &&
		Number.isFinite(global.maxBitrateStepSize) &&
		global.maxBitrateStepSize >= global.minBitrateStepSize;
	const uniqueIds =
		new Set(streams.map((stream) => stream.rowId)).size === streams.length &&
		streams.every(
			(stream) => typeof stream.rowId === "string" && stream.rowId.length > 0,
		);
	const eligible =
		validGlobal && validSteps && uniqueIds && streams.length <= 64;
	const automatic = streams.some(
		(stream) => stream.mode === "PER_TITLE_TEMPLATE",
	);
	const fixed = streams.filter(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	const rule = global.fixedResolutionAndBitrateConfiguration;
	const count = rule?.forcedRenditionAboveHighestFixedRepresentation;
	const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
	const report = proposal.derivation?.constraints;
	const checkedAdditional =
		!automatic &&
		proposal.status === "candidate" &&
		proposal.applicable &&
		proposal.derivation?.targetSatisfied === true &&
		report?.status === "checked" &&
		report.scope === "closed-ladder" &&
		count !== undefined &&
		Number.isSafeInteger(count) &&
		count > 0 &&
		count <= 256 &&
		factor !== undefined &&
		Number.isFinite(factor) &&
		factor > 1 &&
		rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
			"LAST_CALCULATED_BITRATE" &&
		report.forced.count === count &&
		report.forced.factor === factor &&
		report.forced.calculationMode === "LAST_CALCULATED_BITRATE";
	const rangeFor = (stream: PerTitleApiSettings["streams"][number]) => {
		if (
			!eligible ||
			!positive(stream.height) ||
			(stream.width !== undefined && !positive(stream.width))
		)
			return null;
		if (stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION")
			return { minimum: global.minBitrate, maximum: global.maxBitrate };
		const settings = stream.perTitleSettings;
		if (
			stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
			!positive(settings?.minBitrate) ||
			!positive(settings.maxBitrate) ||
			settings.minBitrate > settings.maxBitrate ||
			settings.minBitrate < global.minBitrate ||
			settings.maxBitrate > global.maxBitrate
		)
			return null;
		if (settings.bitrateSelectionMode !== "COMPLEXITY_RANGE")
			return { minimum: settings.minBitrate, maximum: settings.maxBitrate };
		if (
			!positive(settings.lowComplexityBoundaryForMaxBitrate) ||
			!positive(settings.highComplexityBoundaryForMaxBitrate)
		)
			return null;
		return evaluateComplexityRange({
			minimum: settings.minBitrate,
			maximum: settings.maxBitrate,
			low: settings.lowComplexityBoundaryForMaxBitrate,
			high: settings.highComplexityBoundaryForMaxBitrate,
			input: global.maxBitrate,
			minStep: global.minBitrateStepSize,
		});
	};
	const upper = proposal.scenarios.filter(
		(scenario) => scenario.fraction === 1,
	);
	const scenario = upper.length === 1 ? upper[0] : undefined;
	const examples = new Map<string, number>();
	const extra: PerTitleOutputPreview["rows"] = [];
	let justified =
		eligible &&
		scenario?.status === "modelled" &&
		scenario.modelRungs.length > 0 &&
		scenario.modelRungs.length <= 256 &&
		proposal.status !== "conflict" &&
		!proposal.diagnostics.some(
			(item) =>
				item.severity === "conflict" || item.code === "row-order-unknown",
		) &&
		!scenario.diagnostics.some((item) => item.severity === "conflict");
	let previous: number | undefined;
	let additional = 0;
	for (const [index, rung] of (justified
		? (scenario?.modelRungs ?? [])
		: []
	).entries()) {
		if (
			!positive(rung.bitrate) ||
			rung.bitrate < global.minBitrate ||
			rung.bitrate > global.maxBitrate ||
			(previous !== undefined && rung.bitrate <= previous)
		) {
			justified = false;
			break;
		}
		if (rung.rowId !== undefined) {
			const stream = fixed.find((item) => item.rowId === rung.rowId);
			const range = stream ? rangeFor(stream) : null;
			if (
				!stream ||
				!range ||
				examples.has(rung.rowId) ||
				additional ||
				rung.height !== stream.height ||
				rung.bitrate < range.minimum ||
				rung.bitrate > range.maximum
			) {
				justified = false;
				break;
			}
			examples.set(rung.rowId, rung.bitrate);
		} else if (
			checkedAdditional &&
			examples.size === fixed.length &&
			rung.kind === "illustrative"
		) {
			const last = fixed.at(-1);
			if (
				previous === undefined ||
				rung.height !== last?.height ||
				rung.bitrate !== Math.round(previous * (factor as number))
			) {
				justified = false;
				break;
			}
			additional++;
			extra.push({
				id: `additional:${index}`,
				kind: "additional",
				status: "example",
				height: rung.height,
				bitrate: rung.bitrate,
				minimumBitrate: rung.bitrate,
				maximumBitrate: rung.bitrate,
			});
		} else if (
			automatic &&
			!fixed.length &&
			!rule &&
			rung.kind === "illustrative" &&
			rung.height === undefined
		) {
			extra.push({
				id: `unassigned:${index}`,
				kind: "unassigned",
				status: "example",
				bitrate: rung.bitrate,
				minimumBitrate: rung.bitrate,
				maximumBitrate: rung.bitrate,
			});
		} else {
			justified = false;
			break;
		}
		if (previous !== undefined && !additional) {
			const ratio = rung.bitrate / previous;
			if (
				ratio < global.minBitrateStepSize ||
				ratio > global.maxBitrateStepSize
			) {
				justified = false;
				break;
			}
		}
		previous = rung.bitrate;
	}
	justified =
		justified &&
		examples.size === fixed.length &&
		(!rule ||
			(count === 0
				? additional === 0
				: checkedAdditional && additional === count));
	const rows: PerTitleOutputPreview["rows"] = streams.map((stream, index) => {
		const row: PerTitleOutputPreview["rows"][number] = {
			id: `stream:${index}:${stream.rowId}`,
			rowId: stream.rowId,
			...(positive(stream.height) ? { height: stream.height } : {}),
			...(positive(stream.width) ? { width: stream.width } : {}),
			mode: stream.mode,
			kind: stream.mode === "PER_TITLE_TEMPLATE" ? "automatic" : "fixed",
			status: "unknown",
		};
		if (row.kind === "automatic") return row;
		const example = justified ? examples.get(stream.rowId) : undefined;
		if (example !== undefined)
			return {
				...row,
				status: "example",
				bitrate: example,
				minimumBitrate: example,
				maximumBitrate: example,
			};
		const range =
			stream.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE"
				? rangeFor(stream)
				: null;
		return range
			? {
					...row,
					status: "conditional",
					bitrate: range.maximum,
					minimumBitrate: range.minimum,
					maximumBitrate: range.maximum,
				}
			: row;
	});
	if (justified) rows.push(...extra);
	const unresolvedAdditional =
		rule !== undefined &&
		count !== 0 &&
		!(justified && checkedAdditional && additional === count);
	return {
		analysisInput,
		status: !rows.some((row) => row.bitrate !== undefined)
			? "unavailable"
			: rows.every((row) => row.status === "example") && !unresolvedAdditional
				? "example"
				: "partial",
		rows,
		unresolvedAdditional,
	};
}
