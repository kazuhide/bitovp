import {
	type LocalStoryBlueprint,
	type LocalStoryCorpus,
	type LocalStoryInput,
	localStoryBlueprintSchema,
} from "./local-story-contracts";
import { localStoryNumericTokens } from "./local-story-input";
import type { LocalStorySelectionResult } from "./local-story-planner";
import { originalTimeToCfrFrame } from "./time";

export const LOCAL_STORY_PLAN_VALIDATION_POLICY =
	"local-story-supported-plan-v3" as const;
export type LocalStoryPlanIssue = {
	code:
		| "CONTEXT_DEPENDENCY_MISSING"
		| "SELECTION_MISMATCH"
		| "SELECTED_QUOTE_NOT_COVERED"
		| "SELECTED_MESSAGE_NUMBER_UNSUPPORTED";
	beatId?: string;
	eventId?: string;
	ref?: string;
};
type SelectedPlan = Pick<
	LocalStorySelectionResult,
	| "localStorySelection"
	| "clips"
	| "actualDurationFrames"
	| "requestedDurationFrames"
>;

/** A dependency is declared context, not proof that one observed action caused another. */
export function localStoryBlueprintCoherenceIssues(
	value: unknown,
): LocalStoryPlanIssue[] {
	const blueprint = localStoryBlueprintSchema.parse(value);
	return blueprint.mode === "FLOW"
		? blueprint.beats.flatMap((beat, index) =>
				index > 0 && !beat.requires.length
					? [{ code: "CONTEXT_DEPENDENCY_MISSING" as const, beatId: beat.id }]
					: [],
			)
		: [];
}

/** Mechanical coverage/claim guards over the actual chosen windows. Exact quotation
 * support and source order do not prove semantic entailment, speaker or causality. */
export function localStorySelectedPlanIssues(options: {
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	blueprint: LocalStoryBlueprint;
	selection: SelectedPlan;
}): LocalStoryPlanIssue[] {
	const { input, ledger, blueprint, selection } = options,
		chosen = selection.localStorySelection;
	if (
		chosen.selectedEventIds.length !== blueprint.beats.length ||
		chosen.selectedBeatIds.length !== blueprint.beats.length ||
		new Set(chosen.selectedEventIds).size !== chosen.selectedEventIds.length ||
		blueprint.beats.some(
			(beat, i) =>
				chosen.selectedBeatIds[i] !== beat.id ||
				!beat.eventIds.includes(chosen.selectedEventIds[i] ?? "") ||
				!beat.requires.every((id) =>
					chosen.selectedBeatIds.slice(0, i).includes(id),
				),
		)
	)
		return [{ code: "SELECTION_MISMATCH" }];
	const events = chosen.selectedEventIds.flatMap((id) => {
		const event = ledger.events.find((event) => event.id === id);
		return event ? [event] : [];
	});
	if (
		events.length !== blueprint.beats.length ||
		events.some((event, i) => event.role !== blueprint.beats[i]?.role) ||
		selection.clips.reduce((sum, clip) => sum + clip.durationFrames, 0) !==
			selection.actualDurationFrames
	)
		return [{ code: "SELECTION_MISMATCH" }];
	const frame = (us: number, rounding: "FLOOR" | "CEIL") =>
		Number(originalTimeToCfrFrame(us, input.timeMap.sourceStartUs, rounding));
	const spans = selection.clips
		.map((clip) => ({
			from: frame(clip.sourceInUs, "FLOOR"),
			to: frame(clip.sourceInUs, "FLOOR") + clip.durationFrames,
		}))
		.sort((a, b) => a.from - b.from);
	if (
		spans.some(
			(span) =>
				span.from < 0 ||
				span.to >
					input.timeMap.editingEndFrame - input.timeMap.editingStartFrame,
		)
	)
		return [{ code: "SELECTION_MISMATCH" }];
	const covered = (from: number, to: number) => {
		let cursor = from;
		for (const span of spans) {
			if (span.to <= cursor) continue;
			if (span.from > cursor) return false;
			cursor = Math.max(cursor, span.to);
			if (cursor >= to) return true;
		}
		return cursor >= to;
	};
	const issues: LocalStoryPlanIssue[] = [];
	for (const event of events)
		for (const quote of event.quotes) {
			const shot = input.shots.find((shot) => shot.ref === quote.ref);
			const fields =
				shot?.fields.filter((field) => field.text.includes(quote.quote)) ?? [];
			const supported =
				!!shot &&
				fields.some((field) =>
					field.kind === "ASR" &&
					field.startUs !== undefined &&
					field.endUs !== undefined
						? covered(frame(field.startUs, "FLOOR"), frame(field.endUs, "CEIL"))
						: covered(shot.fromFrame, shot.toFrame),
				);
			if (!supported)
				issues.push({
					code: "SELECTED_QUOTE_NOT_COVERED",
					eventId: event.id,
					ref: quote.ref,
				});
		}
	const numbers = new Set(
		localStoryNumericTokens(
			events
				.flatMap((event) => event.quotes.map((quote) => quote.quote))
				.join("\n"),
		),
	);
	if (
		localStoryNumericTokens(blueprint.message).some(
			(number) => !numbers.has(number),
		)
	)
		issues.push({ code: "SELECTED_MESSAGE_NUMBER_UNSUPPORTED" });
	return issues;
}

/** A bounded retry opportunity, never padding with unrelated or invented footage. */
export function localStoryPlanNeedsExpansion(
	input: LocalStoryInput,
	ledger: LocalStoryCorpus,
	selection: SelectedPlan,
): boolean {
	const supportedRefs = new Set(ledger.events.flatMap((event) => event.refs)),
		possible = input.shots
			.filter((shot) => supportedRefs.has(shot.ref))
			.reduce((sum, shot) => sum + shot.toFrame - shot.fromFrame, 0);
	return (
		selection.actualDurationFrames <
			Math.floor(selection.requestedDurationFrames * 0.8) &&
		possible >=
			selection.actualDurationFrames +
				Math.max(30, Math.floor(selection.requestedDurationFrames * 0.1))
	);
}
