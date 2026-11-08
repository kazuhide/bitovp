import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	type AutoPortraitClip,
	type AutoPortraitSelection,
	AutoPortraitSelectionError,
	type AutoPortraitSelectionInput,
	createPortraitSelectionSearchBudget,
	type PortraitCandidateFrameResolver,
	selectAutoPortraitClips,
} from "./auto-portrait";
import { cfrTimeMapSchema } from "./schema";
import {
	type SemanticEvidence,
	semanticEvidenceSchema,
} from "./semantic-evidence";
import { selectSemanticPortraitClips } from "./semantic-portrait";

const EXCLUDED = new Set([
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
]);
const normalize = (value: string) =>
	value.normalize("NFKC").toLocaleLowerCase("und");
const ROLE_CUE =
	/\b(?:protagonist|main character|central|primary|needed|crucial|essential)\b|主人公|主役|中心|重要|不可欠/iu;
function mentions(text: string, label: string): boolean {
	const term = normalize(label.trim());
	if (!term) return false;
	const haystack = normalize(text);
	if (/[^\p{Script=Latin}\p{N}\s-]/u.test(term)) return haystack.includes(term);
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
		"u",
	).test(haystack);
}
type Analysis = ReturnType<typeof sceneAnalysisDocumentSchema.parse>;
type Scene = Analysis["scenes"][number];
type Moment = {
	sceneId: string;
	shotIndex?: number;
	from: number;
	to: number;
	label: string;
	score: number;
	reasonCodes: string[];
};
export type ContentHighlightSelection = Omit<
	AutoPortraitSelection,
	"policyVersion" | "reasonCodes"
> & {
	policyVersion: "aisa-content-highlight-v1";
	reasonCodes: string[];
	semanticEvidence: SemanticEvidence;
};

/** Deliberately coarse bilingual metadata cues, not a learned or calibrated prediction. */
const EVENT_CUES = [
	{
		reason: "STATE_CHANGE",
		pattern:
			/\b(?:reveal\w*|realiz\w*|discover\w*|recogniz\w*|decid\w*|transform\w*|unveil\w*)\b|気[づ付]く|気[づ付]いた|判明|発見|明らか|決意|変身|変化/iu,
		weight: 340,
	},
	{
		reason: "OUTCOME",
		pattern:
			/\b(?:complet\w*|succeed\w*|resolv\w*|finish\w*|win(?:s|ning)?|won|victory|scor(?:e[sd]?|ing)|rescu\w*|sav(?:es?|ed|ing)|defeat\w*)\b|完成|解決|成功|達成|勝利|得点|ゴール|救出|優勝/iu,
		weight: 360,
	},
	{
		reason: "SIGNIFICANT_ACTION",
		pattern:
			/\b(?:shoot\w*|explod\w*|crash\w*|escap\w*|confront\w*|launch\w*|demonstrat\w*|unbox\w*)\b|撃墜|爆発|脱出|対決|実演|披露|開封/iu,
		weight: 180,
	},
	{
		reason: "REACTION",
		pattern:
			/\b(?:surpris\w*|astonish\w*|celebrat\w*|reunit\w*|embrac\w*)\b|驚[きくい]|再会|抱き合|歓喜/iu,
		weight: 140,
	},
];
function checkedAnalysis(value: unknown): Analysis {
	// Bound raw intervals before Zod clones descriptions and subject arrays.
	if (value && typeof value === "object") {
		const scenes = (value as { scenes?: unknown }).scenes;
		if (Array.isArray(scenes)) {
			let intervals = 0,
				eligible = 0;
			for (const raw of scenes) {
				const scene =
					raw && typeof raw === "object"
						? (raw as { shots?: unknown; type?: unknown })
						: undefined;
				intervals +=
					Array.isArray(scene?.shots) && scene.shots.length
						? scene.shots.length
						: 1;
				if (!EXCLUDED.has(String(scene?.type ?? "").toUpperCase())) eligible++;
				if (intervals > 10000 || eligible > 128)
					throw new RangeError("Content metadata candidate limit exceeded");
			}
		}
	}
	return sceneAnalysisDocumentSchema.parse(value);
}
const context = (scene: Scene) =>
	[scene.title, scene.summary, scene.verboseSummary, ...scene.keywords].join(
		"\n",
	);
function cueScore(text: string) {
	const reasons = EVENT_CUES.filter((cue) => cue.pattern.test(text));
	return {
		score: reasons.reduce((sum, cue) => sum + cue.weight, 0),
		reasonCodes: reasons.map((cue) => cue.reason),
	};
}
function profile(analysis: Analysis): SemanticEvidence["profile"] {
	const text = normalize(
		[
			analysis.title,
			analysis.description,
			...analysis.keywords,
			...analysis.scenes
				.filter((scene) => !EXCLUDED.has(scene.type.toUpperCase()))
				.map(context),
		].join("\n"),
	);
	const profiles: Array<{
		kind: SemanticEvidence["profile"];
		pattern: RegExp;
	}> = [
		{
			kind: "INSTRUCTION",
			pattern:
				/\b(?:recipe|cooking|tutorial|instructions?|assembly|making)\b|料理|調理|作り方|組み立て|手順/gu,
		},
		{
			kind: "SPORT",
			pattern:
				/\b(?:football|soccer|basketball|tennis|match|athlete|tournament)\b|スポーツ|試合|選手|決勝|サッカー|野球/gu,
		},
		{
			kind: "PRODUCT",
			pattern:
				/\b(?:product|unboxing|demonstration)\b|製品|商品|開封|機能紹介|実演/gu,
		},
		{
			kind: "CONVERSATION",
			pattern:
				/\b(?:interview|conversation|discussion|debate|news)\b|インタビュー|対談|討論|会話|ニュース/gu,
		},
		{
			kind: "NARRATIVE",
			pattern:
				/\b(?:story|protagonist|hero|rabbit|robot|character|adventure)\b|物語|主人公|冒険|キャラクター|ロボット/gu,
		},
	];
	const ranked = profiles
		.map(({ kind, pattern }, index) => ({
			kind,
			index,
			count: [...text.matchAll(pattern)].length,
		}))
		.sort((a, b) => b.count - a.count || a.index - b.index);
	return ranked[0]?.count ? ranked[0].kind : "GENERAL";
}
function moments(analysis: Analysis): Moment[] {
	return analysis.scenes
		.filter((scene) => !EXCLUDED.has(scene.type.toUpperCase()))
		.flatMap((scene) => {
			const sceneScore = cueScore(context(scene));
			return (scene.shots.length ? scene.shots : [scene]).map(
				(interval, index) => {
					const shot = scene.shots.length ? scene.shots[index] : undefined;
					const local = shot
						? cueScore([shot.detailedDescription, ...shot.keywords].join("\n"))
						: sceneScore;
					const metadata = !!(
						scene.content?.characters.length || scene.content?.objects.length
					);
					// Scene-level cues support context but never create an event timestamp within a shot.
					const score = Math.min(
						1000,
						local.score +
							Math.floor(sceneScore.score / 3) +
							(metadata && (local.score || sceneScore.score) ? 40 : 0),
					);
					return {
						sceneId: scene.id,
						...(shot ? { shotIndex: index } : {}),
						from: interval.startInSeconds,
						to: interval.endInSeconds,
						label:
							(
								shot?.detailedDescription.trim() ||
								scene.title.trim() ||
								scene.summary.trim()
							).slice(0, 240) || "AISA interval",
						score,
						reasonCodes: [
							...new Set([
								...local.reasonCodes,
								...sceneScore.reasonCodes.map((reason) => `SCENE_${reason}`),
								...(metadata ? ["ENTITY_CONTEXT"] : []),
							]),
						].slice(0, 8),
					};
				},
			);
		});
}
const key = (item: { sceneId: string; shotIndex?: number }) =>
	`${item.sceneId.toLowerCase()}:${item.shotIndex ?? "scene"}`;
function evidence(
	analysis: Analysis,
	scored: Moment[],
	clips: readonly AutoPortraitClip[],
	selectionReason: SemanticEvidence["selectionReason"],
): SemanticEvidence {
	const selected = new Set(clips.map(key)),
		sceneIds = new Set(clips.map((clip) => clip.sceneId.toLowerCase()));
	const entities = new Map<string, SemanticEvidence["keyEntities"][number]>();
	const relevance = new Map<string, number>();
	for (const scene of analysis.scenes) {
		if (
			!sceneIds.has(scene.id.toLowerCase()) ||
			EXCLUDED.has(scene.type.toUpperCase())
		)
			continue;
		const selectedText = scored
			.filter(
				(moment) => moment.sceneId === scene.id && selected.has(key(moment)),
			)
			.map((moment) => moment.label)
			.join("\n");
		const add = (
			kind: "CHARACTER" | "OBJECT",
			text: string,
			description: string,
		) => {
			const label = text.trim().slice(0, 160);
			if (!label) return;
			const id = `${kind}:${normalize(label)}`;
			// These are repeated metadata labels, not inferred cross-scene identities.
			const entity = entities.get(id) ?? { kind, label, sceneIds: [] };
			if (!entity.sceneIds.includes(scene.id) && entity.sceneIds.length < 8)
				entity.sceneIds.push(scene.id);
			entities.set(id, entity);
			relevance.set(
				id,
				(relevance.get(id) ?? 0) +
					(mentions(selectedText, label) ? 4 : 0) +
					(ROLE_CUE.test(description) ? 2 : 0) +
					1,
			);
		};
		for (const character of scene.content?.characters ?? [])
			add(
				"CHARACTER",
				character.name || character.description,
				character.description,
			);
		for (const object of scene.content?.objects ?? [])
			add("OBJECT", object.category || object.description, object.description);
	}
	return semanticEvidenceSchema.parse({
		version: "aisa-content-evidence-v1",
		method: "METADATA_HEURISTIC",
		profile: profile(analysis),
		keyEntities: [...entities.entries()]
			.sort(([a], [b]) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0))
			.slice(0, 12)
			.map(([, entity]) => entity),
		selectedMoments: scored
			.filter((moment) => selected.has(key(moment)))
			.map(({ from: _from, to: _to, ...moment }) => moment)
			.slice(0, 20),
		selectionReason,
	});
}

/** Immutable creation provenance. Rebuild after speech refinement; never imply later manual edits were selected by this policy. */
export function buildContentHighlightEvidence(input: {
	analysis: unknown;
	clips: readonly AutoPortraitClip[];
	selectionReason?: SemanticEvidence["selectionReason"];
}): SemanticEvidence {
	const analysis = checkedAnalysis(input.analysis),
		scored = moments(analysis);
	return evidence(
		analysis,
		scored,
		input.clips,
		input.selectionReason ??
			(scored.some((item) => item.score > 0)
				? "CONTENT_RANKED"
				: "INSUFFICIENT_METADATA"),
	);
}

/**
 * Rank at most twelve metadata anchors, delegating all real window construction,
 * exclusions, raw adjacency, clock rounding and final-window predicates to v1.
 * Only windows retaining at least 80% of the baseline duration can replace it.
 * Every call shares one 200k budget. A fully validated baseline survives an
 * exhausted optional ranking search with an explicit SEARCH_BUDGET explanation.
 */
export function selectContentHighlightClips(
	input: AutoPortraitSelectionInput,
	internalFrameResolver?: PortraitCandidateFrameResolver,
): ContentHighlightSelection {
	const analysis = checkedAnalysis(input.analysis),
		scored = moments(analysis),
		map = cfrTimeMapSchema.parse(input.timeMap),
		origin = map.sourceStartUs / 1_000_000,
		end = map.sourceEndUs / 1_000_000;
	const parameters = {
		...input,
		analysis,
		searchBudget: input.searchBudget ?? createPortraitSelectionSearchBudget(),
	};
	const useful = scored
		// Prepared partitions intentionally have no entry outside the raw source
		// window. Reject such anchors before consulting that immutable clock or
		// spending the bounded anchor slots; never clamp their source timestamps.
		.filter((item) => item.score > 0 && item.from >= origin && item.to <= end)
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.from - b.from ||
				key(a).localeCompare(key(b), "en"),
		);
	if (!useful.length) {
		const selected = selectSemanticPortraitClips(
			parameters,
			internalFrameResolver,
		);
		return {
			...selected,
			policyVersion: "aisa-content-highlight-v1",
			reasonCodes: [...selected.reasonCodes, "CONTENT_METADATA_INSUFFICIENT"],
			semanticEvidence: evidence(
				analysis,
				scored,
				selected.clips,
				"INSUFFICIENT_METADATA",
			),
		};
	}
	const baseline = selectAutoPortraitClips(parameters, internalFrameResolver);
	let best: Omit<AutoPortraitSelection, "policyVersion" | "reasonCodes"> & {
			reasonCodes: string[];
		} = baseline,
		reason: SemanticEvidence["selectionReason"] = "CONTENT_RANKED";
	const byKey = new Map(scored.map((item) => [key(item), item]));
	const quality = (
		selection: Pick<AutoPortraitSelection, "clips" | "actualDurationFrames">,
	) => {
		let weighted = 0,
			max = 0;
		for (const clip of selection.clips) {
			const score = byKey.get(key(clip))?.score ?? 0;
			weighted += score * clip.durationFrames;
			max = Math.max(max, score);
		}
		return max + weighted / selection.actualDurationFrames;
	};
	const frame = (seconds: number, rounding: "CEIL" | "FLOOR") => {
		const value = (seconds - origin) * 30,
			nearest = Math.round(value);
		return Math.abs(value - nearest) <=
			4 *
				Number.EPSILON *
				Math.max(1, Math.abs(seconds * 30), Math.abs(origin * 30))
			? nearest
			: rounding === "CEIL"
				? Math.ceil(value)
				: Math.floor(value);
	};
	for (const anchor of useful.slice(0, 12)) {
		const bounds = internalFrameResolver?.(
			anchor.sceneId,
			anchor.shotIndex,
		) ?? {
			fromFrame: frame(anchor.from, "CEIL"),
			toFrame: frame(anchor.to, "FLOOR"),
		};
		if (
			bounds.toFrame <= bounds.fromFrame ||
			bounds.toFrame - bounds.fromFrame > input.targetDurationFrames
		)
			continue;
		try {
			const candidate = selectAutoPortraitClips(
				{
					...parameters,
					acceptWindow: (window) =>
						window.fromFrame <= bounds.fromFrame &&
						window.toFrame >= bounds.toFrame &&
						(input.acceptWindow?.(window) ?? true),
				},
				internalFrameResolver,
			);
			if (
				candidate.actualDurationFrames * 5 <
				baseline.actualDurationFrames * 4
			)
				continue;
			const difference = quality(candidate) - quality(best);
			if (
				difference > 0 ||
				(difference === 0 &&
					candidate.actualDurationFrames > best.actualDurationFrames)
			)
				best = candidate;
		} catch (error) {
			if (error instanceof AutoPortraitSelectionError) continue;
			if (
				error instanceof RangeError &&
				error.message === "Auto portrait search limit exceeded (200000)"
			) {
				best = baseline;
				reason = "SEARCH_BUDGET";
				break;
			}
			throw error;
		}
	}
	if (reason !== "SEARCH_BUDGET" && quality(best) === 0) {
		try {
			best = selectSemanticPortraitClips(parameters, internalFrameResolver);
			reason = "INSUFFICIENT_METADATA";
		} catch (error) {
			if (
				error instanceof RangeError &&
				error.message === "Auto portrait search limit exceeded (200000)"
			) {
				best = baseline;
				reason = "SEARCH_BUDGET";
			} else throw error;
		}
	}
	return {
		...best,
		policyVersion: "aisa-content-highlight-v1",
		reasonCodes: [
			...best.reasonCodes,
			reason === "SEARCH_BUDGET"
				? "CONTENT_SEARCH_BUDGET_FALLBACK"
				: reason === "INSUFFICIENT_METADATA"
					? "CONTENT_METADATA_INSUFFICIENT"
					: "CONTENT_METADATA_RANKED",
		],
		semanticEvidence: evidence(analysis, scored, best.clips, reason),
	};
}
