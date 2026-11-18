import {
	buildFeasibleStoryChoices,
	compileFeasibleStoryChoice,
	LOCAL_STORY_CHOICE_POLICY,
} from "./local-story-choice";
import {
	type LocalStoryCorpus,
	type LocalStoryInput,
	type LocalStoryTrailerIntent,
	localStoryTrailerAllowsEvent,
	localStoryTrailerIntentSchema,
} from "./local-story-contracts";
import {
	LocalStoryError,
	validateLocalStoryCorpusEvents,
} from "./local-story-input";
import { originalTimeToCfrFrame } from "./time";

/** Remove all ambiguous and unclassified footage before the shared selector expands speech. */
function scopeTrailer(
	input: LocalStoryInput,
	ledger: LocalStoryCorpus,
	intent: LocalStoryTrailerIntent,
) {
	const blocked = new Set(
		ledger.events
			.filter((event) => !localStoryTrailerAllowsEvent(event, intent))
			.flatMap((event) => event.refs),
	);
	const ordered = [...input.shots].sort((a, b) => a.fromFrame - b.fromFrame);
	for (const shot of ordered)
		if (!shot.fields.some((field) => field.kind === "AISA"))
			blocked.add(shot.ref);
	const classified = new Set(
		ledger.events
			.filter((event) => event.refs.every((ref) => !blocked.has(ref)))
			.flatMap((event) => event.refs),
	);
	const excluded = [
		...(input.excludedWindows ?? []),
		...ordered.flatMap((shot) =>
			shot.exclusionWindow && !classified.has(shot.ref)
				? [shot.exclusionWindow]
				: [],
		),
	].sort((a, b) => a.fromFrame - b.fromFrame);
	let priorEnd = 0;
	let nextExcluded = 0;
	ordered.forEach((shot, index) => {
		while ((excluded[nextExcluded]?.toFrame ?? Infinity) <= shot.fromFrame)
			nextExcluded++;
		// Overlapping intervals give the same frames ambiguous classifications.
		if (
			shot.fromFrame < priorEnd ||
			(ordered[index + 1]?.fromFrame ?? Infinity) < shot.toFrame ||
			(excluded[nextExcluded]?.fromFrame ?? Infinity) < shot.toFrame
		)
			blocked.add(shot.ref);
		priorEnd = Math.max(priorEnd, shot.toFrame);
	});
	const events = ledger.events.filter((event) =>
		event.refs.every((ref) => !blocked.has(ref)),
	);
	const approved = new Set(events.flatMap((event) => event.refs));
	return {
		input: {
			...input,
			shots: ordered.filter((shot) => approved.has(shot.ref)),
			trailerSelection: true as const,
		},
		ledger: { ...ledger, events },
	};
}

/** Reuse the bounded story search with editor-approved roles and final source bounds. */
export function selectLocalStoryTrailer(options: {
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	trailer: LocalStoryTrailerIntent;
	targetDurationFrames: number;
}) {
	const { input, ledger, targetDurationFrames } = options;
	const intent = localStoryTrailerIntentSchema.parse(options.trailer);
	validateLocalStoryCorpusEvents(input, ledger.events);
	const scoped = scopeTrailer(input, ledger, intent);
	const mode = "FLOW" as const;
	const exact = intent.durationMode === "EXACT";
	const maxBeats = LOCAL_STORY_CHOICE_POLICY.longMaxBeats;
	const frontier = buildFeasibleStoryChoices({
		...scoped,
		mode,
		targetDurationFrames,
		maxBeats,
		openingRole: "CONTEXT",
		exactDuration: exact,
	});
	const roles = new Map(
		scoped.ledger.events.map((event) => [event.id, event.role]),
	);
	const hasQuestion = (ids: string[]) =>
		ids.some((id) => roles.get(id) !== "CONTEXT") ? 1 : 0;
	const [choice] = [...frontier.plans].sort(
		(a, b) =>
			b.actualDurationFrames - a.actualDurationFrames ||
			hasQuestion(b.eventIds) - hasQuestion(a.eventIds),
	);
	if (!choice) {
		if (exact && frontier.diagnostics.truncated)
			throw new LocalStoryError("LOCAL_TRAILER_SEARCH_LIMIT");
		throw new LocalStoryError(
			exact
				? "LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE"
				: "LOCAL_TRAILER_NO_FITTING_PLAN",
		);
	}
	const { blueprint, selection } = compileFeasibleStoryChoice({
		...scoped,
		choices: frontier,
		requestedMode: mode,
		maxBeats,
		choice: {
			planId: choice.id,
			message: "Trailer from selected source passages.",
			uncertainty: "",
		},
	});
	const opening = scoped.ledger.events.find(
		(event) => event.id === selection.localStorySelection.selectedEventIds[0],
	);
	if (opening?.role !== "CONTEXT")
		throw new LocalStoryError("LOCAL_TRAILER_NO_FITTING_PLAN");
	let previousEnd = 0;
	const windows = selection.clips.map(
		({ sourceInUs, durationFrames, sceneId, shotIndex }, index) => {
			const from = Number(
				originalTimeToCfrFrame(
					sourceInUs,
					input.timeMap.sourceStartUs,
					"FLOOR",
				),
			);
			const to = from + durationFrames;
			if (
				from < previousEnd ||
				!scoped.input.shots.some(
					(shot) =>
						shot.sceneId === sceneId &&
						shot.shotIndex === shotIndex &&
						shot.fromFrame <= from &&
						shot.toFrame >= to &&
						(index !== 0 || opening.refs.includes(shot.ref)),
				)
			)
				throw new LocalStoryError("LOCAL_TRAILER_NO_FITTING_PLAN");
			previousEnd = to;
			return { sourceInUs, durationFrames };
		},
	);
	return { blueprint, selection, windows };
}
