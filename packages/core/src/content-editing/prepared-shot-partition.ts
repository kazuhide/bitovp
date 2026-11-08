import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	type AutoPortraitSelection,
	type AutoPortraitSelectionInput,
	createPortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import { selectContentHighlightClips } from "./content-highlight";
import {
	type NormalizationCaptureReceipt,
	normalizationCaptureReceiptSchema,
} from "./normalization-evidence";
import { type CfrTimeMap, cfrTimeMapSchema } from "./schema";
import type { SemanticEvidence } from "./semantic-evidence";
import { selectSemanticPortraitClips } from "./semantic-portrait";
import {
	type StorySelectionResult,
	selectStoryPortraitClips,
} from "./story-selection";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const PREPARED_SHOT_CLOCK_VERSION = "aisa-prepared-clock-v3" as const;
export class PreparedShotClockError extends Error {
	readonly code = "PREPARED_SHOT_CLOCK_UNVERIFIED";
	constructor(message = "PREPARED_SHOT_CLOCK_UNVERIFIED") {
		super(message);
		this.name = "PreparedShotClockError";
	}
}
function requireClock(value: unknown, message?: string): asserts value {
	if (!value) throw new PreparedShotClockError(message);
}
function parsedReceipt(proof: unknown) {
	if (proof && typeof proof === "object") {
		const index = (proof as { sourceFrameIndex?: unknown }).sourceFrameIndex;
		if (Array.isArray(index) && index.length > 108000)
			throw new PreparedShotClockError("PREPARED_INDEX_LIMIT");
	}
	return normalizationCaptureReceiptSchema.parse(proof);
}
/** Verify the persisted row against its externally supplied tenant/media facts; no DB or provider trust is created. */
export function verifyPreparedNormalizationReceipt(input: {
	proof: unknown;
	proofHash: string;
	organizationId: string;
	sourceId: string;
	mediaVersionId: string;
	preparedSha256: string;
	timeMap: unknown;
	width: number;
	height: number;
}): NormalizationCaptureReceipt {
	const n = parsedReceipt(input.proof),
		map = cfrTimeMapSchema.parse(input.timeMap),
		count = n.output.frameCount;
	const originalDuration = Number(
		(BigInt(n.source.frameCount) * BigInt(n.source.fps.den) * 1000000n +
			BigInt(n.source.fps.num) -
			1n) /
			BigInt(n.source.fps.num),
	);
	const videoFilter = `fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=${count},setpts=N/(30*TB),setsar=1/1`;
	const audioFilter = n.source.audio
		? `aresample=48000:async=0:first_pts=0,apad=whole_len=${count * 1600},atrim=end_sample=${count * 1600},asetpts=N/SR/TB`
		: null;
	requireClock(
		input.proofHash === hashEditingEvidence(input.proof) &&
			n.organizationId === input.organizationId &&
			n.sourceId === input.sourceId &&
			n.mediaVersionId === input.mediaVersionId &&
			n.preparedSha256 === input.preparedSha256 &&
			n.timeMapId === map.id &&
			map.mediaVersionId === input.mediaVersionId &&
			map.sourceStartUs === 0 &&
			map.editingStartFrame === 0 &&
			map.sourceEndUs === n.sourceEndUs &&
			map.editingEndFrame === count &&
			map.fps.num === 30 &&
			map.fps.den === 1 &&
			n.output.width === input.width &&
			n.output.height === input.height &&
			n.source.durationUs === originalDuration &&
			n.indexMapHash === hashEditingEvidence(n.sourceFrameIndex) &&
			n.recipeHash ===
				hashEditingEvidence({
					profile: n.profile,
					mode: n.mode,
					source: n.source,
					videoFilter,
					audioFilter,
				}),
	);
	return n;
}
export type PreparedShotFitBand = {
	readonly fromFrame: number;
	readonly toFrame: number;
	readonly reason: "RAW_TIMESTAMP_ROUNDTRIP_GUARD";
};
export type PreparedShotPartitionEntry = {
	readonly sceneId: string;
	readonly shotIndex?: number;
	readonly shotHash: string;
	readonly rawStartInSeconds: number;
	readonly rawEndInSeconds: number;
	readonly fromFrame: number;
	readonly toFrame: number;
	readonly legacyFromFrame: number;
	readonly legacyToFrame: number;
	readonly certainFromFrame: number;
	readonly certainToFrame: number;
	readonly fitBands: readonly PreparedShotFitBand[];
};
type Analysis = ReturnType<typeof sceneAnalysisDocumentSchema.parse>;
export type PreparedShotPartition = {
	readonly version: typeof PREPARED_SHOT_CLOCK_VERSION;
	readonly normalizationReceiptHash: string;
	readonly analysisDocumentHash: string;
	readonly timeMapHash: string;
	readonly analysis: Analysis;
	readonly timeMap: CfrTimeMap;
	readonly entries: readonly PreparedShotPartitionEntry[];
	readonly unresolvedSharedBoundaryCount: number;
};
const clocks = new WeakMap<
	PreparedShotPartition,
	{
		normalization: NormalizationCaptureReceipt;
		entries: Map<string, PreparedShotPartitionEntry>;
		unrepresentable: Set<string>;
	}
>();
const key = (sceneId: string, shotIndex?: number) =>
	`${sceneId.toLowerCase()}:${shotIndex ?? "scene"}`;
function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}
function decimal(value: number) {
	const text = value.toString().toLowerCase(),
		[coefficient, exponent = "0"] = text.split("e"),
		[whole, fraction = ""] = (coefficient ?? "").split(".");
	const digits = BigInt((whole ?? "") + fraction),
		power = Number(exponent) - fraction.length;
	return power >= 0
		? { num: digits * 10n ** BigInt(power), den: 1n }
		: { num: digits, den: 10n ** BigInt(-power) };
}
/** Recognize a source-grid boundary by binary ULP equality or exact nearest-microsecond serialization roundtrip. */
function sourceGridFrame(
	seconds: number,
	n: NormalizationCaptureReceipt,
): number | undefined {
	const value = (seconds * n.source.fps.num) / n.source.fps.den,
		nearest = Math.round(value);
	if (
		!Number.isSafeInteger(nearest) ||
		nearest < 0 ||
		nearest > n.source.frameCount
	)
		return undefined;
	if (
		Math.abs(value - nearest) <=
		4 * Number.EPSILON * Math.max(1, Math.abs(value))
	)
		return nearest;
	const time = decimal(seconds),
		us = time.num * 1000000n;
	if (us % time.den !== 0n) return undefined;
	const numerator = BigInt(nearest) * BigInt(n.source.fps.den) * 1000000n,
		denominator = BigInt(n.source.fps.num),
		rounded = (2n * numerator + denominator) / (2n * denominator);
	return rounded === us / time.den ? nearest : undefined;
}
function outputBoundary(n: NormalizationCaptureReceipt, sourceFrame: number) {
	let low = 0,
		high = n.sourceFrameIndex.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((n.sourceFrameIndex[middle] ?? Infinity) < sourceFrame)
			low = middle + 1;
		else high = middle;
	}
	return low;
}
function legacyFrame(seconds: number, rounding: "CEIL" | "FLOOR") {
	const value = seconds * 30,
		nearest = Math.round(value),
		result =
			Math.abs(value - nearest) <=
			4 * Number.EPSILON * Math.max(1, Math.abs(value))
				? nearest
				: rounding === "CEIL"
					? Math.ceil(value)
					: Math.floor(value);
	requireClock(Number.isSafeInteger(result), "PREPARED_FRAME_OVERFLOW");
	return result;
}
/** Build globally before query/exclusion filtering. Different raw values remain different cuts/gaps. */
export function buildPreparedShotPartition(input: {
	analysis: unknown;
	timeMap: unknown;
	normalization: NormalizationCaptureReceipt;
}): PreparedShotPartition {
	const rawScenes =
		input.analysis && typeof input.analysis === "object"
			? (input.analysis as { scenes?: unknown }).scenes
			: undefined;
	if (Array.isArray(rawScenes)) {
		let count = 0;
		for (const scene of rawScenes) {
			const shots =
				scene && typeof scene === "object"
					? (scene as { shots?: unknown }).shots
					: undefined;
			count += Array.isArray(shots) && shots.length ? shots.length : 1;
			requireClock(count <= 10000, "PREPARED_CANDIDATE_LIMIT");
		}
	}
	const map = cfrTimeMapSchema.parse(input.timeMap),
		n = verifyPreparedNormalizationReceipt({
			proof: input.normalization,
			proofHash: hashEditingEvidence(input.normalization),
			organizationId: input.normalization.organizationId,
			sourceId: input.normalization.sourceId,
			mediaVersionId: map.mediaVersionId,
			preparedSha256: input.normalization.preparedSha256,
			timeMap: map,
			width: input.normalization.output.width,
			height: input.normalization.output.height,
		}),
		analysis = sceneAnalysisDocumentSchema.parse(input.analysis);
	const intervals: {
		sceneId: string;
		shotIndex: number | undefined;
		shot:
			| Analysis["scenes"][number]
			| Analysis["scenes"][number]["shots"][number];
	}[] = [];
	for (const scene of analysis.scenes) {
		if (scene.shots.length)
			scene.shots.forEach((shot, shotIndex) => {
				intervals.push({ sceneId: scene.id, shotIndex, shot });
			});
		else
			intervals.push({ sceneId: scene.id, shotIndex: undefined, shot: scene });
	}
	const cuts = new Map<
		number,
		{ start: boolean; end: boolean; frame?: number }
	>();
	for (const item of intervals) {
		for (const [value, side] of [
			[item.shot.startInSeconds, "start"],
			[item.shot.endInSeconds, "end"],
		] as const) {
			const cut = cuts.get(value) ?? { start: false, end: false };
			cut[side] = true;
			cuts.set(value, cut);
		}
	}
	let unresolved = 0;
	for (const [seconds, cut] of cuts) {
		if (!cut.start || !cut.end) continue;
		const frame = sourceGridFrame(seconds, n);
		if (frame === undefined) {
			unresolved++;
			continue;
		}
		cut.frame = outputBoundary(n, frame);
	}
	const entries: PreparedShotPartitionEntry[] = [],
		unrepresentable = new Set<string>();
	for (const { sceneId, shotIndex, shot } of intervals) {
		const start = shot.startInSeconds,
			end = shot.endInSeconds;
		if (start < 0 || end > map.sourceEndUs / 1000000) continue;
		const legacyFromFrame = legacyFrame(start, "CEIL"),
			legacyToFrame = legacyFrame(end, "FLOOR"),
			fromFrame = cuts.get(start)?.frame ?? legacyFromFrame,
			toFrame = cuts.get(end)?.frame ?? legacyToFrame;
		if (fromFrame < 0 || toFrame > map.editingEndFrame) continue;
		if (toFrame <= fromFrame) {
			unrepresentable.add(key(sceneId, shotIndex));
			continue;
		}
		const certainFromFrame = Math.min(
			toFrame,
			Math.max(fromFrame, legacyFromFrame, frameForAppearance(n, start)),
		);
		requireClock(
			certainFromFrame - fromFrame <= 1,
			"PREPARED_AMBIGUOUS_BAND_LIMIT",
		);
		entries.push(
			frozen({
				sceneId,
				...(shotIndex === undefined ? {} : { shotIndex }),
				shotHash: hashEditingEvidence(shot),
				rawStartInSeconds: start,
				rawEndInSeconds: end,
				fromFrame,
				toFrame,
				legacyFromFrame,
				legacyToFrame,
				certainFromFrame,
				certainToFrame: toFrame,
				fitBands:
					certainFromFrame > fromFrame
						? [
								{
									fromFrame,
									toFrame: certainFromFrame,
									reason: "RAW_TIMESTAMP_ROUNDTRIP_GUARD" as const,
								},
							]
						: [],
			}),
		);
	}
	const partition: PreparedShotPartition = frozen({
		version: PREPARED_SHOT_CLOCK_VERSION,
		normalizationReceiptHash: hashEditingEvidence(n),
		analysisDocumentHash: hashEditingEvidence(analysis),
		timeMapHash: hashEditingEvidence(map),
		analysis,
		timeMap: map,
		entries,
		unresolvedSharedBoundaryCount: unresolved,
	});
	clocks.set(partition, {
		normalization: n,
		entries: new Map(entries.map((e) => [key(e.sceneId, e.shotIndex), e])),
		unrepresentable,
	});
	return partition;
}
function clock(partition: PreparedShotPartition) {
	const value = clocks.get(partition);
	requireClock(value, "PREPARED_PARTITION_FACTORY_REQUIRED");
	return value;
}
export function getPreparedShotPartitionEntry(
	partition: PreparedShotPartition,
	input: { sceneId: string; shotIndex?: number },
): PreparedShotPartitionEntry | undefined {
	return clock(partition).entries.get(key(input.sceneId, input.shotIndex));
}
/** Video ownership only. Audio/ASR stays on its original continuous microsecond clock. EOF is an unseedable sentinel. */
export function preparedFrameForSourceAppearance(
	partition: PreparedShotPartition,
	sourceTimeInSeconds: number,
): number {
	return frameForAppearance(
		clock(partition).normalization,
		sourceTimeInSeconds,
	);
}
function frameForAppearance(
	n: NormalizationCaptureReceipt,
	sourceTimeInSeconds: number,
): number {
	requireClock(
		Number.isFinite(sourceTimeInSeconds) && sourceTimeInSeconds >= 0,
		"PREPARED_APPEARANCE_INVALID",
	);
	if (sourceTimeInSeconds >= n.source.durationUs / 1000000)
		return n.output.frameCount;
	const grid = sourceGridFrame(sourceTimeInSeconds, n);
	if (grid !== undefined) return outputBoundary(n, grid);
	const time = decimal(sourceTimeInSeconds),
		num = time.num * BigInt(n.source.fps.num),
		den = time.den * BigInt(n.source.fps.den),
		frame = Number((num + den - 1n) / den);
	return outputBoundary(n, frame);
}

export type PreparedPortraitSelection = Omit<
	AutoPortraitSelection,
	"policyVersion" | "reasonCodes"
> & {
	policyVersion:
		| "aisa-prepared-shot-window-v3"
		| "aisa-prepared-scene-cohesion-v3"
		| "aisa-prepared-content-highlight-v4"
		| "aisa-prepared-story-window-v1";
	normalizationReceiptHash: string;
	reasonCodes: string[];
	semanticEvidence?: SemanticEvidence;
	storySelection?: StorySelectionResult;
};
/** New policies share the existing bounded search; legacy calls never receive a resolver. */
export function selectPreparedPortraitClips(input: {
	partition: PreparedShotPartition;
	targetDurationFrames: number;
	policy: "DURATION" | "COHESION" | "AUTO" | "STORY";
	story?: Parameters<typeof selectStoryPortraitClips>[0]["story"];
	query?: string;
	searchBudget?: AutoPortraitSelectionInput["searchBudget"];
	acceptWindow?: AutoPortraitSelectionInput["acceptWindow"];
}): PreparedPortraitSelection {
	const p = input.partition,
		source = clock(p);
	requireClock(
		input.policy === "DURATION" ||
			input.policy === "COHESION" ||
			input.policy === "AUTO" ||
			input.policy === "STORY",
		"PREPARED_POLICY_INVALID",
	);
	requireClock(
		input.policy !== "DURATION" || !input.query,
		"PREPARED_DURATION_QUERY_FORBIDDEN",
	);
	requireClock(
		input.policy !== "AUTO" || input.query === undefined,
		"PREPARED_AUTO_QUERY_FORBIDDEN",
	);
	requireClock(
		input.policy !== "STORY" || input.query === undefined,
		"PREPARED_STORY_QUERY_FORBIDDEN",
	);
	const parameters = {
		analysis: p.analysis,
		timeMap: p.timeMap,
		targetDurationFrames: input.targetDurationFrames,
		searchBudget:
			input.searchBudget === undefined
				? createPortraitSelectionSearchBudget()
				: input.searchBudget,
		acceptWindow: input.acceptWindow,
	};
	const resolver = (sceneId: string, shotIndex?: number) => {
		const entry = source.entries.get(key(sceneId, shotIndex));
		if (entry) return { fromFrame: entry.fromFrame, toFrame: entry.toFrame };
		requireClock(
			source.unrepresentable.has(key(sceneId, shotIndex)),
			"PREPARED_CANDIDATE_MISSING",
		);
		return { fromFrame: 0, toFrame: 0 };
	};
	const selected = (() => {
		if (input.policy === "STORY") {
			requireClock(input.story, "PREPARED_STORY_REQUIRED");
			return selectStoryPortraitClips(
				{ ...parameters, story: input.story },
				resolver,
			);
		}
		return input.policy === "DURATION"
			? selectAutoPortraitClips(parameters, resolver)
			: input.policy === "AUTO"
				? selectContentHighlightClips(parameters, resolver)
				: selectSemanticPortraitClips(
						{ ...parameters, query: input.query },
						resolver,
					);
	})();
	return {
		...selected,
		policyVersion:
			input.policy === "DURATION"
				? "aisa-prepared-shot-window-v3"
				: input.policy === "AUTO"
					? "aisa-prepared-content-highlight-v4"
					: input.policy === "STORY"
						? "aisa-prepared-story-window-v1"
						: "aisa-prepared-scene-cohesion-v3",
		normalizationReceiptHash: p.normalizationReceiptHash,
		reasonCodes: [
			...selected.reasonCodes,
			"PREPARED_SOURCE_FRAME_PARTITION",
			...(p.unresolvedSharedBoundaryCount
				? ["UNRESOLVED_SHARED_BOUNDARY"]
				: []),
			...(selected.clips.some(
				(c) => source.entries.get(key(c.sceneId, c.shotIndex))?.fitBands.length,
			)
				? ["BOUNDARY_FIT_GUARD"]
				: []),
		],
	};
}
