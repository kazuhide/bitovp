import {
	type LocalStoryBlueprint,
	type LocalStoryChunk,
	type LocalStoryCorpus,
	type LocalStoryInput,
	type LocalStoryMode,
	localStoryBlueprintSchema,
	localStoryEventMinimumDurationFrames,
} from "@bitovp/core";
import {
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	LocalStoryLegacyLedgerError,
	localStoryLegacyLedgerPrompt,
} from "@bitovp/core/local-story-flow-server";
import { MediaOperationError } from "./process";

export const LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.generic;
export const LOCAL_LEDGER_QUOTE_REPAIR_SUFFIX =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.quote;

function legacyLedgerPrompt<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof LocalStoryLegacyLedgerError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}
export function localLedgerPrompt(chunk: LocalStoryChunk) {
	return localStoryLegacyLedgerPrompt({ kind: "BASE", chunk });
}
export function localQuoteLedgerRepairPrompt(
	chunk: LocalStoryChunk,
): string | undefined {
	return localStoryLegacyLedgerPrompt({ kind: "QUOTE", chunk });
}
export function localNumericLedgerRepairPrompt(
	chunk: LocalStoryChunk,
): string | undefined {
	return localStoryLegacyLedgerPrompt({ kind: "NUMERIC", chunk });
}
type StructuredLedgerRepairOptions = {
	input: LocalStoryInput;
	chunk: LocalStoryChunk;
	family: "QUOTE" | "ASR";
};
export function localStructuredLedgerRepairPrompt(
	options: StructuredLedgerRepairOptions,
): string | undefined {
	return legacyLedgerPrompt(() =>
		localStoryLegacyLedgerPrompt({
			...options,
			kind: "STRUCTURED",
			version: "V4",
		}),
	);
}
/** Fixed predecessor instructions remain the exact v3 bytes. */
export function localLegacyV3StructuredLedgerRepairPrompt(
	options: StructuredLedgerRepairOptions,
): string | undefined {
	return legacyLedgerPrompt(() =>
		localStoryLegacyLedgerPrompt({
			...options,
			kind: "STRUCTURED",
			version: "V3",
		}),
	);
}

export type LocalBlueprintRoleConflict = {
	beatId: string;
	beatRole: LocalStoryBlueprint["beats"][number]["role"];
	eventId: string;
	eventRole: LocalStoryCorpus["events"][number]["role"];
};

/** Keep only schema-checked IDs and ledger roles; model messages are never repair instructions. */
export function localBlueprintRoleConflicts(
	ledger: LocalStoryCorpus,
	value: unknown,
): LocalBlueprintRoleConflict[] | undefined {
	const parsed = localStoryBlueprintSchema.safeParse(value);
	if (!parsed.success) return undefined;
	const roles = new Map(ledger.events.map((event) => [event.id, event.role]));
	const conflicts: LocalBlueprintRoleConflict[] = [];
	for (const beat of parsed.data.beats) {
		for (const eventId of beat.eventIds) {
			const eventRole = roles.get(eventId);
			if (!eventRole) return undefined;
			if (eventRole !== beat.role)
				conflicts.push({
					beatId: beat.id,
					beatRole: beat.role,
					eventId,
					eventRole,
				});
		}
	}
	return conflicts.length ? conflicts : undefined;
}

export function localBlueprintRoleRepairInstruction(attempt: number) {
	if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2)
		throw new RangeError("Invalid bounded Blueprint repair attempt");
	return `Previous blueprint violated role eligibility. Every alternative must have exactly that beat's role and occur in allowedEventIdsByRole[role]. roleConflicts contains the exact previous violations as JSON data. Choose another eligible event or separate correctly typed beats; never reclassify an event. Use only supplied evidence. Repair attempt ${attempt}.`;
}

export type LocalBlueprintRepairMeta =
	| { kind: "COHERENCE" | "FIT" | "SCHEMA"; attempt: number }
	| { kind: "EXPAND"; attempt: number; actualDurationFrames: number };

function assertBlueprintRepairAttempt(attempt: number) {
	if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2)
		throw new RangeError("Invalid bounded Blueprint repair attempt");
}
function assertBlueprintRepairFrames(frames: number) {
	if (!Number.isSafeInteger(frames) || frames <= 0)
		throw new RangeError("Invalid Blueprint repair duration");
}

/** These registered instructions retain the exact predecessor inline bytes. */
export function localBlueprintSchemaRepairInstruction(attempt: number) {
	assertBlueprintRepairAttempt(attempt);
	return `Previous native JSON did not satisfy the Blueprint schema. Return only mode, message, beats and uncertainty. Give each beat a unique id (b1,b2,...); eventIds contains only eligible event IDs; requires contains unique earlier beat IDs, never event IDs. Do not copy mode into id. Keep immutable roles and evidence. Repair attempt ${attempt}.`;
}
export function localBlueprintCoherenceRepairInstruction(attempt: number) {
	assertBlueprintRepairAttempt(attempt);
	return `Previous plan omitted required context/quoted windows or claimed an unsupported selected number. In multi-beat FLOW, connect every later beat with requires. Include complete quoted evidence, and remove numerical claims absent from selected quotes. Preserve immutable roles; invent no causal link or ending. Repair attempt ${attempt}.`;
}
export function localBlueprintFitRepairInstruction({
	targetDurationFrames,
	attempt,
}: {
	targetDurationFrames: number;
	attempt: number;
}) {
	assertBlueprintRepairAttempt(attempt);
	assertBlueprintRepairFrames(targetDurationFrames);
	return `Previous complete blueprint did not fit source order, complete speech and ${targetDurationFrames / 30}s. Use fewer mandatory beats (possibly one), shorter measured events and alternatives; preserve necessary context. Repair attempt ${attempt}.`;
}
export function localBlueprintExpansionRepairInstruction({
	actualDurationFrames,
	targetDurationFrames,
	attempt,
}: {
	actualDurationFrames: number;
	targetDurationFrames: number;
	attempt: number;
}) {
	assertBlueprintRepairAttempt(attempt);
	assertBlueprintRepairFrames(actualDurationFrames);
	assertBlueprintRepairFrames(targetDurationFrames);
	return `Previous supported plan used only ${actualDurationFrames / 30}s of ${targetDurationFrames / 30}s. Include more supported necessary events or alternatives, preserving context, roles and complete quoted speech. Never pad unrelated shots or invent an ending. Repair attempt ${attempt}.`;
}

export function localBlueprintPrompt(options: {
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	mode: LocalStoryMode;
	targetDurationFrames: number;
	repair?: string;
	roleConflicts?: LocalBlueprintRoleConflict[];
}) {
	const { input, ledger, mode, targetDurationFrames } = options;
	const roleConflictRows = new Map<
		string,
		[
			string,
			LocalBlueprintRoleConflict["beatRole"],
			[string, LocalBlueprintRoleConflict["eventRole"]][],
		]
	>();
	for (const conflict of options.roleConflicts ?? []) {
		const key = JSON.stringify([conflict.beatId, conflict.beatRole]);
		const row = roleConflictRows.get(key);
		if (row) row[2].push([conflict.eventId, conflict.eventRole]);
		else
			roleConflictRows.set(key, [
				conflict.beatId,
				conflict.beatRole,
				[[conflict.eventId, conflict.eventRole]],
			]);
	}
	const flatFeedback = options.roleConflicts
		? { roleConflicts: options.roleConflicts }
		: {};
	const groupedFeedback = {
		roleConflictFields: ["beatId", "beatRole", "eventIdAndRolePairs"],
		roleConflicts: Array.from(roleConflictRows.values()),
	};
	// Preserve the original single-conflict shape when its complete JSON is smaller.
	// Neither encoding omits a violation; a repair never grows beyond the flat form.
	const roleFeedback =
		options.roleConflicts &&
		Buffer.byteLength(JSON.stringify(groupedFeedback)) <
			Buffer.byteLength(JSON.stringify(flatFeedback))
			? groupedFeedback
			: flatFeedback;
	const minimumFrames = new Map(
		ledger.events.map((event) => [
			event.id,
			localStoryEventMinimumDurationFrames(input, event),
		]),
	);
	const cards = ledger.events.map((event) => {
		const shots = event.refs
			.map((ref) => input.shots.find((s) => s.ref === ref))
			.filter((s) => s !== undefined);
		return [
			event.id,
			event.role,
			event.label,
			event.subjects,
			Math.min(...shots.map((s) => s.fromFrame)),
			minimumFrames.get(event.id) ?? null,
		];
	});
	const data = {
		requestedMode: mode,
		targetSeconds: targetDurationFrames / 30,
		targetFrames: targetDurationFrames,
		cardFields: [
			"id",
			"role",
			"label",
			"subjects",
			"sourceOrder",
			"minimumFrames",
		],
		events: cards,
		allowedEventIdsByRole: Object.fromEntries(
			(["CONTEXT", "ACTION", "CHANGE", "OUTCOME", "POINT"] as const).map(
				(role) => [
					role,
					ledger.events
						.filter((event) => {
							const frames = minimumFrames.get(event.id);
							return (
								event.role === role &&
								frames !== undefined &&
								frames <= targetDurationFrames
							);
						})
						.map((event) => event.id),
				],
			),
		),
		...(options.repair ? { repair: options.repair } : {}),
		...roleFeedback,
	};
	return `Compose a faithful short film from ALL event cards, not a top-K ranking. Use evidence only; invent no identity, causality or ending. Return JSON: mode FLOW or THEME, message (Japanese, <=100 chars), beats [{id,role,eventIds,requires}], uncertainty (Japanese, short). FLOW preserves situation/action/change/result; THEME connects topic/points/evidence; AUTO chooses. Roles are immutable. Copy each beat role from its event; eventIds ONLY from allowedEventIdsByRole[role], including every alternative. Never reclassify or mix roles; empty role lists have no eligible events. Each beat offers 1-4 alternatives. requires lists earlier beat IDs; every later FLOW beat needs a dependency. All beats are mandatory, in source order. Message must hold for all alternatives; use no unselected numbers. minimumFrames includes complete speech/usable footage; null is unavailable. Listed IDs fit targetFrames; so must the whole plan. Favor 2-3 beats at 15s, up to 5 at 60s. One faithful beat beats an impossible arc. Return no times, ranks, cameras or commands.\nDATA\n${JSON.stringify(data)}`;
}
