import {
	type PerTitleGoal,
	type PerTitleProposal,
	resolvePerTitleFixedMode,
} from "@bitovp/core";
import type { PerTitleStreamChoice } from "./per-title-stream-mode";

type FixedRow = NonNullable<PerTitleGoal["rows"]>[number];
type OrdinaryRow = NonNullable<PerTitleGoal["automaticTemplates"]>[number];
type EditableRow = Omit<FixedRow, "height"> & { height?: number };

export function editablePerTitleStreams(
	goal: PerTitleGoal,
	proposal?: PerTitleProposal,
) {
	const fixed =
		goal.strategy === "automatic" || goal.strategy === "count"
			? []
			: [...(goal.rows ?? [])];
	let ordinary = [...(goal.automaticTemplates ?? [])];
	if (
		!ordinary.length &&
		!["fixed-resolutions", "fixed-ranges"].includes(goal.strategy)
	) {
		const emitted = proposal?.api.streams.filter(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		);
		if (emitted?.length)
			ordinary = emitted.map((stream) => ({
				id: stream.rowId,
				...(stream.height === undefined ? {} : { height: stream.height }),
				...(stream.width === undefined ? {} : { width: stream.width }),
				...stream.perTitleSettings,
			}));
		else {
			const ids = new Set(fixed.map((row) => row.id));
			let id = "automatic-template";
			for (let suffix = 1; ids.has(id); suffix++)
				id = `automatic-template-${suffix}`;
			ordinary = [
				{
					id,
					...(goal.inputHeight === undefined
						? {}
						: { height: goal.inputHeight }),
					...(goal.inputWidth === undefined ? {} : { width: goal.inputWidth }),
				},
			];
		}
	}
	return { fixed, ordinary };
}

function clearInactivePolicies(
	goal: PerTitleGoal,
	rowId: string,
	choice: PerTitleStreamChoice,
	keepRangePolicies: boolean,
) {
	const inactive = new Set(
		choice === "fixed-range" && keepRangePolicies
			? []
			: [
					"minBitrate",
					"maxBitrate",
					"bitrateSelectionMode",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				],
	);
	const next = { ...goal };
	if (goal.adjustments?.streams?.[rowId]) {
		const streams = { ...goal.adjustments.streams };
		const retained = Object.fromEntries(
			Object.entries(streams[rowId] ?? {}).filter(
				([key]) => !inactive.has(key),
			),
		);
		if (Object.keys(retained).length) streams[rowId] = retained;
		else delete streams[rowId];
		next.adjustments = { ...goal.adjustments, streams };
	}
	if (goal.settingLocks?.streams?.[rowId]) {
		const streams = { ...goal.settingLocks.streams };
		const retained = (streams[rowId] ?? []).filter((key) => !inactive.has(key));
		if (retained.length) streams[rowId] = retained;
		else delete streams[rowId];
		next.settingLocks = { ...goal.settingLocks, streams };
	}
	return next;
}

export function withPerTitleStreamRows(
	goal: PerTitleGoal,
	fixed: readonly FixedRow[],
	ordinary: readonly OrdinaryRow[],
): PerTitleGoal {
	const strategy = !fixed.length
		? goal.countPolicy.kind === "exact"
			? "count"
			: "automatic"
		: fixed.some(
					(row) =>
						resolvePerTitleFixedMode(goal, row) ===
						"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				)
			? "fixed-ranges"
			: goal.strategy === "required-resolutions"
				? "required-resolutions"
				: "fixed-resolutions";
	const rows =
		strategy === goal.strategy
			? fixed
			: fixed.map((row) => ({
					...row,
					mode: resolvePerTitleFixedMode(goal, row),
				}));
	return { ...goal, strategy, rows, automaticTemplates: ordinary };
}

export function changePerTitleStreamChoice(
	goal: PerTitleGoal,
	rowId: string,
	choice: PerTitleStreamChoice,
	proposal?: PerTitleProposal,
): PerTitleGoal {
	const { fixed, ordinary } = editablePerTitleStreams(goal, proposal);
	const fixedSource = fixed.find((row) => row.id === rowId);
	const source = fixedSource ?? ordinary.find((row) => row.id === rowId);
	if (!source) return goal;
	const row: EditableRow = { ...source };
	const previousMode = fixedSource
		? resolvePerTitleFixedMode(goal, fixedSource)
		: "PER_TITLE_TEMPLATE";
	if (
		choice !== "fixed-range" ||
		previousMode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
	) {
		delete row.minBitrate;
		delete row.maxBitrate;
		delete row.bitrateSelectionMode;
		delete row.lowComplexityBoundaryForMaxBitrate;
		delete row.highComplexityBoundaryForMaxBitrate;
	}
	if (
		choice !== "template" &&
		row.height === undefined &&
		row.width === undefined
	)
		row.height = 720;
	const retainedFixed = fixed.filter((item) => item.id !== rowId);
	const retainedOrdinary = ordinary.filter((item) => item.id !== rowId);
	if (choice === "template") {
		delete row.mode;
		retainedOrdinary.push(row);
	} else {
		retainedFixed.push({
			...row,
			mode:
				choice === "fixed-range"
					? "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
					: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
	}
	return withPerTitleStreamRows(
		clearInactivePolicies(
			goal,
			rowId,
			choice,
			previousMode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		),
		retainedFixed,
		retainedOrdinary,
	);
}
