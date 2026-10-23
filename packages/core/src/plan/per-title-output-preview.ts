import {
	evaluateComplexityRange,
	evaluateForcedRenditions,
} from "./per-title-constraints";
import type {
	PerTitleApiSettings,
	PerTitleProposal,
} from "./per-title-simulator.js";

export type PerTitleOutputPreview = {
	/** Effective hypothetical top, capped at the emitted global maximum. */
	analysisInput: number | null;
	/** Requested hypothetical top before the cap; null means invalid input. */
	requestedAnalysisInput: number | null;
	status: "example" | "partial" | "unavailable";
	rows: Array<{
		id: string;
		rowId?: string;
		height?: number;
		width?: number;
		mode?: PerTitleApiSettings["streams"][number]["mode"];
		kind: "fixed" | "automatic" | "additional" | "unassigned";
		status: "example" | "conditional" | "unknown";
		basis?: "minimum" | "forced" | "analysis";
		candidateRowIds?: string[];
		bitrate?: number;
		minimumBitrate?: number;
		maximumBitrate?: number;
	}>;
	unresolvedAdditional: boolean;
	/** Alternative only: applies when normal calculation ends on a fixed output. */
	forcedFallback?: {
		baseMinimumBitrate: number;
		baseMaximumBitrate: number;
		minimumBitrate: number;
		maximumBitrate: number;
		count: number;
		factor: number;
	};
};

/** Read-only arithmetic examples and unresolved candidates from the emitted API settings. */
export function previewPerTitleOutput(
	proposal: PerTitleProposal,
	options: { analysisInput?: number } = {},
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
	const requested =
		options.analysisInput === undefined
			? global.maxBitrate
			: options.analysisInput;
	const requestedAnalysisInput = positive(requested) ? requested : null;
	const analysisInput =
		validGlobal && requestedAnalysisInput !== null
			? Math.min(requestedAnalysisInput, global.maxBitrate)
			: null;
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
		validGlobal &&
		analysisInput !== null &&
		validSteps &&
		uniqueIds &&
		streams.length <= 64;
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
			input: analysisInput as number,
			minStep: global.minBitrateStepSize,
		});
	};
	const upper = proposal.scenarios.filter(
		(scenario) => scenario.fraction === 1,
	);
	const scenario = upper.length === 1 ? upper[0] : undefined;
	const examples = new Map<string, number>();
	let forcedFallback: PerTitleOutputPreview["forcedFallback"];
	const extra: PerTitleOutputPreview["rows"] = [];
	let justified =
		eligible &&
		analysisInput === global.maxBitrate &&
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
	// These examples assume the listed templates share an aspect ratio when only
	// heights are known. Automatic resolution generation makes that set incomplete.
	const basis = streams.every((stream) => positive(stream.width))
		? "width"
		: streams.every(
					(stream) => stream.width === undefined && positive(stream.height),
				)
			? "height"
			: null;
	const explicitMixed =
		eligible &&
		automatic &&
		global.autoRepresentations === undefined &&
		basis !== null &&
		fixed.length > 0 &&
		fixed.every(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				rangeFor(stream) !== null,
		);
	if (explicitMixed && basis) {
		const ordered = [...streams].sort(
			(a, b) => (a[basis] as number) - (b[basis] as number),
		);
		const firstFixed = ordered.find(
			(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
		);
		const firstRanges = fixed
			.filter((stream) => stream[basis] === firstFixed?.[basis])
			.map(rangeFor);
		const lowerCandidates = ordered.filter(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE" &&
				(stream[basis] as number) <= (firstFixed?.[basis] as number),
		);
		const minimumRow = rows.find(
			(row) => row.rowId === lowerCandidates[0]?.rowId,
		);
		if (
			lowerCandidates.length === 1 &&
			minimumRow &&
			firstRanges.length > 0 &&
			firstRanges.every(
				(range) =>
					range !== null &&
					Math.floor(range.minimum / global.minBitrateStepSize) >=
						global.minBitrate,
			)
		) {
			Object.assign(minimumRow, {
				basis: "minimum",
				status: "conditional",
				bitrate: global.minBitrate,
				minimumBitrate: global.minBitrate,
				maximumBitrate: global.minBitrate,
			});
		}
		const fixedExamples = rows.filter((row) => row.kind === "fixed");
		const highestFixed = [...fixedExamples].sort(
			(a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0),
		)[0];
		const highestFixedDimension = Math.max(
			...fixed.map((stream) => stream[basis] as number),
		);
		const topCandidates = ordered.filter(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE" &&
				(stream[basis] as number) > highestFixedDimension,
		);
		const candidateDimensions = topCandidates.map((stream) => stream[basis]);
		const ratio =
			highestFixed && positive(highestFixed.bitrate) && analysisInput !== null
				? analysisInput / highestFixed.bitrate
				: null;
		const analysisSelected =
			analysisInput !== null &&
			analysisInput >= global.minBitrate &&
			topCandidates.length > 0 &&
			new Set(candidateDimensions).size === topCandidates.length &&
			fixedExamples.every((row) => positive(row.bitrate)) &&
			ratio !== null &&
			ratio >= global.minBitrateStepSize &&
			ratio <= global.maxBitrateStepSize;
		if (analysisSelected) {
			const candidateRowIds = topCandidates.map((stream) => stream.rowId);
			// The analysis selects a template; dimensions cannot be inferred from its target bitrate.
			for (let index = rows.length - 1; index >= 0; index--) {
				if (candidateRowIds.includes(rows[index]?.rowId ?? ""))
					rows.splice(index, 1);
			}
			rows.push({
				id: "analysis:top",
				kind: "automatic",
				basis: "analysis",
				mode: "PER_TITLE_TEMPLATE",
				status: "conditional",
				candidateRowIds,
				bitrate: analysisInput,
				minimumBitrate: analysisInput,
				maximumBitrate: analysisInput,
			});
		}
		const last = ordered.at(-1);
		const destinations = ordered.filter(
			(stream) => stream[basis] === last?.[basis],
		);
		const destination = destinations.length === 1 ? destinations[0] : undefined;
		const destinationRow = rows.find((row) => row.rowId === destination?.rowId);
		if (
			highestFixed &&
			positive(highestFixed.minimumBitrate) &&
			positive(highestFixed.maximumBitrate) &&
			fixedExamples.every(
				(row) =>
					row === highestFixed ||
					(positive(row.maximumBitrate) &&
						row.maximumBitrate < (highestFixed.minimumBitrate as number)),
			) &&
			count !== undefined &&
			Number.isSafeInteger(count) &&
			count > 0 &&
			count <= 256 &&
			factor !== undefined &&
			Number.isFinite(factor) &&
			factor > 1 &&
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
				"LAST_CALCULATED_BITRATE" &&
			destination
		) {
			const last = evaluateForcedRenditions({
				base: {
					minimum: highestFixed.minimumBitrate,
					maximum: highestFixed.maximumBitrate,
				},
				count,
				factor,
			})?.at(-1);
			if (last)
				forcedFallback = {
					baseMinimumBitrate: highestFixed.minimumBitrate,
					baseMaximumBitrate: highestFixed.maximumBitrate,
					minimumBitrate: last.minimum,
					maximumBitrate: last.maximum,
					count,
					factor,
				};
		}
		if (
			!analysisSelected &&
			count !== undefined &&
			Number.isSafeInteger(count) &&
			count > 0 &&
			count <= 256 &&
			factor !== undefined &&
			Number.isFinite(factor) &&
			factor > 1 &&
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
				"LAST_CALCULATED_BITRATE" &&
			fixedExamples.every((row) => positive(row.bitrate)) &&
			highestFixed &&
			positive(highestFixed.bitrate) &&
			destinationRow
		) {
			let rate = highestFixed.bitrate;
			const points: number[] = [];
			for (let index = 0; index < count; index++) {
				const next = Math.round(rate * factor);
				if (!positive(next) || next <= rate) break;
				points.push(next);
				rate = next;
			}
			if (points.length === count) {
				for (const [index, bitrate] of points.entries()) {
					const value = {
						...destinationRow,
						basis: "forced" as const,
						status: "conditional" as const,
						bitrate,
						minimumBitrate: bitrate,
						maximumBitrate: bitrate,
					};
					if (index === 0 && destinationRow.bitrate === undefined)
						Object.assign(destinationRow, value);
					else
						rows.push({
							...value,
							id: `forced:${index}:${destinationRow.id}`,
							kind: "additional",
						});
				}
			}
		}
	}
	const unresolvedAdditional =
		rows.some((row) => row.basis === "analysis") ||
		(rule !== undefined &&
			count !== 0 &&
			!(justified && checkedAdditional && additional === count));
	return {
		analysisInput,
		requestedAnalysisInput,
		status: !rows.some((row) => row.bitrate !== undefined)
			? "unavailable"
			: rows.every((row) => row.status === "example") && !unresolvedAdditional
				? "example"
				: "partial",
		rows,
		unresolvedAdditional,
		...(forcedFallback ? { forcedFallback } : {}),
	};
}
