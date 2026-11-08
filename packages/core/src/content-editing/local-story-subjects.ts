import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	type FramingGeometry,
	type ShotFramingProposal,
	suggestShotFraming,
} from "./framing";
import {
	type LocalStoryCorpus,
	type LocalStoryInput,
	type LocalStorySelection,
	localStoryCorpusSchema,
	localStorySelectionSchema,
} from "./local-story-contracts";
import { LocalStoryError } from "./local-story-input";
import type { NormalizedCropRect } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const LOCAL_STORY_SUBJECT_POLICY_VERSION =
	"local-story-subjects-v1" as const;
export const LOCAL_STORY_TRACKING_POLICY_VERSION =
	"immutable-seed-bounded-recovery-v1" as const;

export type LocalStorySubjectTarget = {
	ref: string;
	sceneId: string;
	shotIndex?: number;
	targetId: string;
	eventIds: string[];
	subjectLabels: string[];
	subjectIndexes: number[];
	analysisDocumentHash: string;
	timeMapHash: string;
	sourceAppearanceUs?: number;
	protectedBoxes: NormalizedCropRect[];
	decision: "CROP" | "FIT";
	reason:
		| "STORY_SUBJECT_MATCHED"
		| "SUBJECT_UNRESOLVED"
		| "SUBJECT_AMBIGUOUS"
		| "SUBJECT_BOX_MISSING"
		| "SUBJECT_CLOCK_AMBIGUOUS"
		| "PROTECTED_REGION_TOO_LARGE";
	proposal?: ShotFramingProposal;
};
const name = (value: string) =>
	value
		.normalize("NFKC")
		.trim()
		.toLocaleLowerCase("en-US")
		.replace(/\s+/gu, " ");

/** No substring/fuzzy identity or ASR-name-to-face inference. IDs are shot-local,
 * metadata-grounded targets, not a claim of identity across camera cuts. */
export function resolveLocalStorySubjects(options: {
	analysis: unknown;
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	selection: LocalStorySelection;
	geometry: FramingGeometry;
}): LocalStorySubjectTarget[] {
	const analysis = sceneAnalysisDocumentSchema.parse(options.analysis),
		ledger = localStoryCorpusSchema.parse(options.ledger),
		selection = localStorySelectionSchema.parse(options.selection),
		events = selection.selectedEventIds.map((id) => {
			const event = ledger.events.find((event) => event.id === id);
			if (!event) throw new LocalStoryError("LOCAL_STORY_EVIDENCE_INVALID");
			return event;
		}),
		analysisDocumentHash = hashEditingEvidence(analysis);
	return options.input.shots.flatMap((shot) => {
		const supporting = events.filter((event) => event.refs.includes(shot.ref));
		if (!supporting.length) return [];
		const scene = analysis.scenes.find((scene) => scene.id === shot.sceneId),
			actual =
				shot.shotIndex === undefined ? undefined : scene?.shots[shot.shotIndex],
			labels = [...new Set(supporting.flatMap((event) => event.subjects))],
			indexes: number[] = [];
		let reason: LocalStorySubjectTarget["reason"] = "STORY_SUBJECT_MATCHED";
		if (!actual || !labels.length) reason = "SUBJECT_UNRESOLVED";
		for (const label of labels) {
			const key = name(label);
			const exactCharacterDescriptions = (scene?.content?.characters ?? [])
				.filter((character) => name(character.name) === key)
				.map((character) => name(character.description))
				.filter(Boolean);
			const matches = (actual?.mainSubjects ?? []).flatMap((subject, index) =>
				name(subject.classification) === key ||
				name(subject.description) === key ||
				exactCharacterDescriptions.includes(name(subject.description))
					? [index]
					: [],
			);
			if (matches.length !== 1) {
				reason = matches.length ? "SUBJECT_AMBIGUOUS" : "SUBJECT_UNRESOLVED";
				break;
			}
			const index = matches[0];
			if (index !== undefined && !indexes.includes(index)) indexes.push(index);
		}
		indexes.sort((a, b) => a - b);
		if (indexes.length > 4) reason = "SUBJECT_AMBIGUOUS";
		const selected = indexes.flatMap((index) =>
				actual?.mainSubjects[index] ? [actual.mainSubjects[index]] : [],
			),
			protectedBoxes = selected.flatMap((subject) =>
				subject.box2d
					? [
							{
								x: subject.box2d[1] / 1000,
								y: subject.box2d[0] / 1000,
								w: (subject.box2d[3] - subject.box2d[1]) / 1000,
								h: (subject.box2d[2] - subject.box2d[0]) / 1000,
							},
						]
					: [],
			);
		if (
			reason === "STORY_SUBJECT_MATCHED" &&
			protectedBoxes.length !== selected.length
		)
			reason = "SUBJECT_BOX_MISSING";
		const appearances = selected.map(
			(subject) => subject.appearanceTimeInSeconds,
		);
		if (reason === "STORY_SUBJECT_MATCHED" && new Set(appearances).size !== 1)
			reason = "SUBJECT_CLOCK_AMBIGUOUS";
		let proposal: ShotFramingProposal | undefined;
		if (reason === "STORY_SUBJECT_MATCHED" && protectedBoxes.length) {
			const boxes = selected.flatMap((subject) =>
					subject.box2d ? [subject.box2d] : [],
				),
				left = Math.min(...boxes.map((box) => box[1])),
				top = Math.min(...boxes.map((box) => box[0])),
				right = Math.max(...boxes.map((box) => box[3])),
				bottom = Math.max(...boxes.map((box) => box[2]));
			proposal = suggestShotFraming({
				...options.geometry,
				coordinateSpaceVerified: true,
				mainSubjects: [{ box2d: [top, left, bottom, right] }],
			});
			if (proposal.mode !== "CROP") reason = "PROTECTED_REGION_TOO_LARGE";
		}
		return [
			{
				ref: shot.ref,
				sceneId: shot.sceneId,
				...(shot.shotIndex === undefined ? {} : { shotIndex: shot.shotIndex }),
				targetId: `target-${hashEditingEvidence({ analysisDocumentHash, sceneId: shot.sceneId, shotIndex: shot.shotIndex ?? null, subjectIndexes: indexes })}`,
				eventIds: supporting.map((event) => event.id),
				subjectLabels: labels,
				subjectIndexes: indexes,
				analysisDocumentHash,
				timeMapHash: options.input.timeMapHash,
				...(actual && appearances.length && new Set(appearances).size === 1
					? {
							sourceAppearanceUs: Math.ceil(
								(actual.startInSeconds + (appearances[0] ?? 0)) * 1_000_000,
							),
						}
					: {}),
				protectedBoxes,
				decision:
					reason === "STORY_SUBJECT_MATCHED"
						? ("CROP" as const)
						: ("FIT" as const),
				reason,
				...(proposal ? { proposal } : {}),
			},
		];
	});
}
