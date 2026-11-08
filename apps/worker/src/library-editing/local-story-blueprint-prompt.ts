import {
	type LocalStoryBlueprint,
	type LocalStoryCorpus,
	LocalStoryError,
	localSemanticStageRegistry,
	localStoryBlueprintSchema,
} from "@bitovp/core";
import {
	type LocalBlueprintRepairMeta,
	type LocalBlueprintRoleConflict,
	localBlueprintCoherenceRepairInstruction,
	localBlueprintExpansionRepairInstruction,
	localBlueprintFitRepairInstruction,
	localBlueprintPrompt,
	localBlueprintRoleRepairInstruction,
	localBlueprintSchemaRepairInstruction,
} from "./local-story-prompts";
import { MediaOperationError } from "./process";

const roles = ["CONTEXT", "ACTION", "CHANGE", "OUTCOME", "POINT"] as const;
const maxPromptBytes =
	8192 -
	localSemanticStageRegistry().stages.LOCAL_BLUEPRINT_V1.maxOutputTokens -
	1024;
const instruction =
	"Faithful film,ALL evidence;no ranks/invented identity/cause/ending. Use JSON schema. FLOW=situation/action/change/result;THEME=topic/points/evidence;AUTO chooses. message<=100chars;uncertainty short;both Japanese. m=mode,t=frames@30fps. eligible=[role,rows];contextOnly=UNSELECTABLE rows at same role index. row=[id,label,subjects#,order,minFrames];s=subjects,0-based. Select ONLY eligible IDs;copy full group role;1-4 options/beat. Not all roles needed. Unique beat IDs b1,b2,...;all mandatory/source-ordered;requires earlier BEAT IDs only;later FLOW nonempty. Message true for ALL options;no unselected numbers. minFrames=full speech/footage;plan<=t. Use 1-3beats/30s,<=5/60s;one faithful beat over impossible arc. No times/cameras/commands.";
type Role = LocalStoryCorpus["events"][number]["role"];
type Card = [string, Role, string, string[], number, number | null];
type GroupedConflict = [string, Role, [string, Role][]];
type FlatData = {
	requestedMode: string;
	targetSeconds: number;
	targetFrames: number;
	cardFields: string[];
	events: Card[];
	allowedEventIdsByRole: Record<Role, string[]>;
	roleConflictFields?: string[];
	roleConflicts?: LocalBlueprintRoleConflict[] | GroupedConflict[];
};
export type PreparedLocalBlueprintPrompt = {
	prompt: string;
	representation: "FLAT" | "ELIGIBLE_ALIASES_V1";
	decodeNativeOutput?: (value: unknown) => LocalStoryBlueprint;
};
function invalidReference(): never {
	throw new LocalStoryError(
		"LOCAL_STORY_BLUEPRINT_INVALID",
		"BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
	);
}

function aliasForIndex(index: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let value = index + 1,
		alias = "";
	while (value > 0) {
		value--;
		alias = alphabet[value % 52] + alias;
		value = Math.floor(value / 52);
	}
	return alias;
}

/** Preserve the original short wire. Long inputs use explicit grouped aliases; every card and
 * exact source string remains present. The existing byte ceiling still applies. */
export function prepareLocalBlueprintPrompt(
	options: Parameters<typeof localBlueprintPrompt>[0] & {
		repairMeta?: LocalBlueprintRepairMeta;
	},
): PreparedLocalBlueprintPrompt {
	const flat = localBlueprintPrompt(options);
	if (Buffer.byteLength(flat) <= maxPromptBytes)
		return { prompt: flat, representation: "FLAT" };
	const data: FlatData = JSON.parse(flat.slice(flat.indexOf("\nDATA\n") + 6));
	const {
		requestedMode,
		targetSeconds,
		targetFrames,
		cardFields: _fields,
		events: cards,
		allowedEventIdsByRole,
		...rest
	} = data;
	const ids = cards.map((card) => card[0]);
	if (new Set(ids).size !== ids.length) invalidReference();
	if (targetSeconds !== targetFrames / 30) invalidReference();
	const aliases = new Map(ids.map((id, index) => [id, aliasForIndex(index)]));
	const originalByAlias = new Map(
		ids.map((id, index) => [aliasForIndex(index), id]),
	);
	const roleById = new Map(cards.map(([id, role]) => [id, role]));
	const aliasFor = (id: string) => aliases.get(id) ?? invalidReference();
	// Only event references change namespace; beat IDs and dependencies do not.
	const feedback = rest.roleConflicts
		? rest.roleConflictFields
			? {
					roleConflicts: (rest.roleConflicts as GroupedConflict[]).map(
						([beat, role, pairs]) => [
							beat,
							role,
							pairs.map(([id, eventRole]) => [aliasFor(id), eventRole]),
						],
					),
				}
			: {
					roleConflicts: (
						rest.roleConflicts as LocalBlueprintRoleConflict[]
					).map((conflict) => ({
						...conflict,
						eventId: aliasFor(conflict.eventId),
					})),
				}
		: {};
	const subjects: string[] = [];
	const subjectIndices = new Map<string, number>();
	type Row = [string, string, number[], number, number | null];
	const eligible: [Role, Row[]][] = roles.map((role) => [role, []]);
	const contextOnly: Row[][] = roles.map(() => []);
	const eligibleAliases = new Set<string>();
	for (const [id, role, label, names, sourceOrder, minimumFrames] of cards) {
		const index = roles.indexOf(role),
			group = eligible[index],
			context = contextOnly[index],
			available = minimumFrames !== null && minimumFrames <= targetFrames;
		if (
			!group ||
			!context ||
			allowedEventIdsByRole[role].includes(id) !== available
		)
			invalidReference();
		if (available) eligibleAliases.add(aliasFor(id));
		(available ? group[1] : context).push([
			aliasFor(id),
			label,
			names.map((name) => {
				let index = subjectIndices.get(name);
				if (index === undefined) {
					index = subjects.length;
					subjects.push(name);
					subjectIndices.set(name, index);
				}
				return index;
			}),
			sourceOrder,
			minimumFrames,
		]);
	}
	const wire: Record<string, unknown> = {
		...rest,
		...feedback,
		m: requestedMode,
		t: targetFrames,
		s: subjects,
		eligible,
		contextOnly,
	};
	// Only the two registered role-repair instructions have this dictionary form.
	// Unknown/free-form repair text keeps its original bytes and budget behavior.
	const roleRepairAttempt = [1, 2].find(
		(attempt) =>
			options.repair === localBlueprintRoleRepairInstruction(attempt),
	);
	if (roleRepairAttempt && options.roleConflicts?.length) {
		delete wire.roleConflicts;
		delete wire.roleConflictFields;
		wire.repair = `Fix conflicts=[beat,wantedGroup#,id,actualGroup#];eligible 0-based. #${roleRepairAttempt}`;
		wire.conflicts = options.roleConflicts.map((conflict) => {
			if (roleById.get(conflict.eventId) !== conflict.eventRole)
				invalidReference();
			const wanted = roles.indexOf(conflict.beatRole),
				actual = roles.indexOf(conflict.eventRole);
			if (wanted < 0 || actual < 0) invalidReference();
			return [conflict.beatId, wanted, aliasFor(conflict.eventId), actual];
		});
	}
	const meta = options.repairMeta;
	if (
		meta?.kind === "SCHEMA" &&
		options.repair === localBlueprintSchemaRepairInstruction(meta.attempt)
	)
		wire.repair = `Unique beat IDs b1,b2,...;no mode as id;requires unique earlier BEAT IDs,never event IDs;no extra fields;exact schema. #${meta.attempt}`;

	if (
		meta?.kind === "COHERENCE" &&
		options.repair === localBlueprintCoherenceRepairInstruction(meta.attempt)
	)
		wire.repair = `Restore context/full quotes;remove numbers absent from selected quotes;later FLOW beats need requires;no unsupported cause/ending. #${meta.attempt}`;
	if (
		meta?.kind === "FIT" &&
		options.repair ===
			localBlueprintFitRepairInstruction({
				targetDurationFrames: targetFrames,
				attempt: meta.attempt,
			})
	)
		wire.repair = `Use fewer mandatory beats or shorter eligible events;keep source order/full speech/context;whole plan<=t. #${meta.attempt}`;
	if (
		meta?.kind === "EXPAND" &&
		options.repair ===
			localBlueprintExpansionRepairInstruction({
				actualDurationFrames: meta.actualDurationFrames,
				targetDurationFrames: targetFrames,
				attempt: meta.attempt,
			})
	)
		wire.repair = `Expand from ${meta.actualDurationFrames} toward ${targetFrames} frames with relevant eligible events/options;keep context/roles/full speech;no padding/invented ending. #${meta.attempt}`;
	const prompt = `${instruction}\nDATA\n${JSON.stringify(wire)}`;
	if (Buffer.byteLength(prompt) > maxPromptBytes)
		throw new MediaOperationError("LOCAL_STORY_CONTEXT_LIMIT");
	return {
		prompt,
		representation: "ELIGIBLE_ALIASES_V1",
		// This callback is exclusively for a newly received native response. The
		// artifact store saves canonical IDs and validates those without decoding.
		decodeNativeOutput(value) {
			const parsed = localStoryBlueprintSchema.parse(value);
			return {
				...parsed,
				beats: parsed.beats.map((beat) => ({
					...beat,
					eventIds: beat.eventIds.map((alias) => {
						const id = originalByAlias.get(alias) ?? invalidReference();
						if (!eligibleAliases.has(alias))
							throw new MediaOperationError("LOCAL_STORY_NO_FITTING_PLAN");
						return id;
					}),
				})),
			};
		},
	};
}
