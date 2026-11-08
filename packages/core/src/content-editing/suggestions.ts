import { z } from "zod";
import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import { MAX_EDIT_DURATION_FRAMES } from "./schema";

const DEFAULT_EXCLUDED_TYPES = [
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
];
export const highlightProposalOptionsSchema = z.strictObject({
	query: z.string().trim().max(200).optional(),
	selectedSceneIds: z.array(z.uuid()).max(5000).optional(),
	excludedSceneTypes: z.array(z.string().trim().max(128)).max(50).optional(),
	targetDurationFrames: z
		.number()
		.int()
		.min(1)
		.max(MAX_EDIT_DURATION_FRAMES)
		.optional(),
	maxCandidates: z.number().int().min(1).max(100).optional(),
	analysisBinding: z
		.enum(["UNVERIFIED", "PROVEN", "EDITOR_CONFIRMED"])
		.optional(),
});
export type HighlightProposalOptions = z.infer<
	typeof highlightProposalOptionsSchema
>;
export type HighlightCandidate = {
	sceneId: string;
	sourceInUs: number;
	sourceOutUs: number;
	durationFrames: number;
	title: string;
	reasonCodes: ("SCENE_SELECTED" | "QUERY_MATCH")[];
	binding: "UNVERIFIED" | "PROVEN" | "EDITOR_CONFIRMED";
	requiresConfirmation: true;
	exceedsTargetDuration: boolean;
};

/** A bounded selection helper over real scene intervals, not a highlight quality model. */
export function proposeHighlightCandidates(
	input: unknown,
	inputOptions: HighlightProposalOptions = {},
): HighlightCandidate[] {
	const document = sceneAnalysisDocumentSchema.parse(input);
	const options = highlightProposalOptionsSchema.parse(inputOptions);
	const selected = new Set(
		options.selectedSceneIds?.map((id) => id.toLowerCase()),
	);
	const terms = (options.query ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!selected.size && !terms.length) return [];
	const excluded = new Set(
		(options.excludedSceneTypes ?? DEFAULT_EXCLUDED_TYPES).map((type) =>
			type.toUpperCase(),
		),
	);
	const candidates: HighlightCandidate[] = [];
	for (const scene of document.scenes) {
		if (excluded.has(scene.type.toUpperCase())) continue;
		const sceneSelected = selected.has(scene.id.toLowerCase());
		const text = [
			scene.title,
			scene.summary,
			scene.verboseSummary,
			...scene.keywords,
			...scene.shots.map((shot) => shot.detailedDescription),
		]
			.join("\n")
			.toLowerCase();
		const queryMatches =
			terms.length > 0 && terms.every((term) => text.includes(term));
		if (selected.size ? !sceneSelected : !queryMatches) continue;
		const sourceInUs = Math.round(scene.startInSeconds * 1_000_000);
		const sourceOutUs = Math.round(scene.endInSeconds * 1_000_000);
		if (!Number.isSafeInteger(sourceInUs) || !Number.isSafeInteger(sourceOutUs))
			throw new RangeError("Scene time exceeds the editing time domain");
		const durationFrames = Number(
			(BigInt(sourceOutUs - sourceInUs) * 30n) / 1_000_000n,
		);
		if (durationFrames < 1) continue;
		const reasonCodes: HighlightCandidate["reasonCodes"] = [];
		if (sceneSelected) reasonCodes.push("SCENE_SELECTED");
		if (queryMatches) reasonCodes.push("QUERY_MATCH");
		candidates.push({
			sceneId: scene.id,
			sourceInUs,
			sourceOutUs,
			durationFrames,
			title: (scene.title || scene.summary).slice(0, 240),
			reasonCodes,
			binding: options.analysisBinding ?? "UNVERIFIED",
			requiresConfirmation: true,
			exceedsTargetDuration:
				durationFrames >
				(options.targetDurationFrames ?? MAX_EDIT_DURATION_FRAMES),
		});
	}
	candidates.sort(
		(a, b) =>
			a.sourceInUs - b.sourceInUs ||
			a.sourceOutUs - b.sourceOutUs ||
			a.sceneId.localeCompare(b.sceneId),
	);
	const seen = new Set<string>();
	return candidates
		.filter((candidate) => {
			const key = `${candidate.sourceInUs}:${candidate.sourceOutUs}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, options.maxCandidates ?? 20);
}
