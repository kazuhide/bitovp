import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	LOCAL_STORY_MAX_CHUNK_BYTES,
	LOCAL_STORY_MAX_CHUNKS,
	type LocalStoryBlueprint,
	type LocalStoryChunk,
	type LocalStoryCorpus,
	type LocalStoryEvent,
	type LocalStoryField,
	type LocalStoryInput,
	type LocalStoryLedger,
	localStoryBlueprintSchema,
	localStoryCorpusSchema,
	localStoryLedgerSchema,
} from "./local-story-contracts";
import {
	getPreparedShotPartitionEntry,
	type PreparedShotPartition,
} from "./prepared-shot-partition";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
const EXCLUDED = new Set([
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
]);
/** Diagnostic identifiers only; never include evidence or schema issue content. */
export const LOCAL_STORY_FAILURE_RULES = Object.freeze([
	"EVENT_IDS_DUPLICATED",
	"EVENT_REFS_INVALID",
	"EVENT_QUOTE_REFS_MISMATCH",
	"QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
	"LABEL_NUMBERS_UNSUPPORTED",
	"CHUNK_REFS_SHOTS_MISMATCH",
	"BLUEPRINT_EVENT_IDS_DUPLICATED",
	"BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
	"BLUEPRINT_ROLE_MISMATCH",
] as const);
export type LocalStoryFailureRule = (typeof LOCAL_STORY_FAILURE_RULES)[number];
export class LocalStoryError extends Error {
	constructor(
		readonly code: string,
		readonly rule?: LocalStoryFailureRule,
	) {
		super(code);
		this.name = "LocalStoryError";
	}
}
function assert(
	valid: unknown,
	code = "LOCAL_STORY_EVIDENCE_INVALID",
	rule?: LocalStoryFailureRule,
): asserts valid {
	if (!valid) throw new LocalStoryError(code, rule);
}

/** Exact decimal arithmetic keeps a genuine sub-frame timestamp conservative. */
function rawFrame(
	seconds: number,
	originUs: number,
	rounding: "FLOOR" | "CEIL",
) {
	const [mantissa = "0", power = "0"] = seconds
		.toString()
		.toLowerCase()
		.split("e");
	const [whole = "0", fraction = ""] = mantissa.split(".");
	let numerator = BigInt(whole + fraction),
		denominator = 10n ** BigInt(fraction.length);
	const exponent = Number(power);
	if (exponent > 0) numerator *= 10n ** BigInt(exponent);
	else if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
	const n = (numerator * 1_000_000n - BigInt(originUs) * denominator) * 30n,
		d = denominator * 1_000_000n,
		q = n / d,
		r = n % d;
	return Number(
		!r
			? q
			: rounding === "FLOOR"
				? q - (n < 0n ? 1n : 0n)
				: q + (n > 0n ? 1n : 0n),
	);
}
const field = (pointer: string, text: string): LocalStoryField => ({
	pointer,
	kind: "AISA",
	text,
});

/** No sampling or string truncation. Oversized model chunks are rejected later. */
export function buildLocalStoryInput(options: {
	analysis: unknown;
	timeMap: unknown;
	preparedPartition?: PreparedShotPartition;
	segments?: readonly { startUs: number; endUs: number; text: string }[];
}): LocalStoryInput {
	if (options.analysis && typeof options.analysis === "object") {
		const scenes = (options.analysis as { scenes?: unknown }).scenes;
		if (Array.isArray(scenes)) {
			let count = 0;
			for (const scene of scenes) {
				const shots = (scene as { shots?: unknown } | null)?.shots;
				count += Array.isArray(shots) && shots.length ? shots.length : 1;
				assert(count <= 10_000, "LOCAL_STORY_INPUT_LIMIT");
			}
		}
	}
	const analysis = sceneAnalysisDocumentSchema.parse(options.analysis),
		map = cfrTimeMapSchema.parse(options.timeMap),
		p = options.preparedPartition;
	if (p) {
		// The public accessor also verifies the unforgeable factory-owned partition.
		getPreparedShotPartitionEntry(p, {
			sceneId: analysis.scenes[0]?.id ?? "missing",
		});
		assert(
			p.analysisDocumentHash === hashEditingEvidence(analysis) &&
				p.timeMapHash === hashEditingEvidence(map),
			"LOCAL_STORY_CLOCK_MISMATCH",
		);
	}
	assert(
		bytes({ title: analysis.title, description: analysis.description }) <= 500,
		"LOCAL_STORY_BRIEF_LIMIT",
	);
	const segments = (options.segments ?? []).map((s) => {
		assert(
			Number.isSafeInteger(s.startUs) &&
				Number.isSafeInteger(s.endUs) &&
				s.startUs >= map.sourceStartUs &&
				s.endUs <= map.sourceEndUs &&
				s.endUs > s.startUs &&
				typeof s.text === "string" &&
				s.text.length <= 16_000,
			"LOCAL_STORY_TRANSCRIPT_INVALID",
		);
		return { startUs: s.startUs, endUs: s.endUs, text: s.text };
	});
	assert(segments.length <= 20_000, "LOCAL_STORY_TRANSCRIPT_LIMIT");
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: analysis.title,
		description: analysis.description,
		timeMap: map,
		timeMapHash: hashEditingEvidence(map),
		...(p ? { normalizationReceiptHash: p.normalizationReceiptHash } : {}),
		scenes: [],
		shots: [],
		coverage: [],
		segments,
	};
	let ordinal = 0;
	analysis.scenes.forEach((scene, sceneIndex) => {
		const context = [
			field(`/scenes/${sceneIndex}/summary`, scene.summary),
			...(scene.content?.objects ?? []).flatMap((o, i) => [
				field(
					`/scenes/${sceneIndex}/content/objects/${i}/category`,
					o.category,
				),
				field(
					`/scenes/${sceneIndex}/content/objects/${i}/description`,
					o.description,
				),
			]),
			...(scene.content?.characters ?? []).flatMap((c, i) => [
				field(`/scenes/${sceneIndex}/content/characters/${i}/name`, c.name),
				field(
					`/scenes/${sceneIndex}/content/characters/${i}/description`,
					c.description,
				),
			]),
		].filter((v) => v.text.trim());
		input.scenes.push({
			sceneId: scene.id,
			text: context.map((v) => v.text).join("\n"),
			fields: context,
		});
		const intervals = scene.shots.length ? scene.shots : [scene];
		intervals.forEach((interval, index) => {
			const ref = `s${ordinal++}`;
			if (EXCLUDED.has(scene.type.toUpperCase())) {
				input.coverage.push({ ref, status: "EXCLUDED" });
				return;
			}
			if (
				interval.startInSeconds < map.sourceStartUs / 1_000_000 ||
				interval.endInSeconds > map.sourceEndUs / 1_000_000
			) {
				input.coverage.push({ ref, status: "OUTSIDE_MEDIA" });
				return;
			}
			const shotIndex = scene.shots.length ? index : undefined,
				entry = p
					? getPreparedShotPartitionEntry(p, { sceneId: scene.id, shotIndex })
					: undefined;
			const fromFrame = p
					? entry?.fromFrame
					: rawFrame(interval.startInSeconds, map.sourceStartUs, "CEIL"),
				toFrame = p
					? entry?.toFrame
					: rawFrame(interval.endInSeconds, map.sourceStartUs, "FLOOR");
			if (
				fromFrame === undefined ||
				toFrame === undefined ||
				toFrame <= fromFrame
			) {
				input.coverage.push({ ref, status: "UNREPRESENTABLE" });
				return;
			}
			assert(
				Number.isSafeInteger(fromFrame) &&
					Number.isSafeInteger(toFrame) &&
					fromFrame >= 0 &&
					toFrame <= map.editingEndFrame - map.editingStartFrame,
				"LOCAL_STORY_CLOCK_MISMATCH",
			);
			const shot = shotIndex === undefined ? undefined : scene.shots[shotIndex],
				prefix = `/scenes/${sceneIndex}${shot ? `/shots/${shotIndex}` : ""}`;
			const fields: LocalStoryField[] = [
				field(
					`${prefix}/${shot ? "detailedDescription" : "summary"}`,
					shot ? shot.detailedDescription : scene.summary,
				),
				...(shot?.mainSubjects ?? []).flatMap((subject, i) => [
					field(
						`${prefix}/mainSubjects/${i}/classification`,
						subject.classification,
					),
					field(`${prefix}/mainSubjects/${i}/description`, subject.description),
				]),
				...segments.flatMap((s, i): LocalStoryField[] =>
					s.endUs > interval.startInSeconds * 1_000_000 &&
					s.startUs < interval.endInSeconds * 1_000_000 &&
					s.text.trim()
						? [
								{
									pointer: `/segments/${i}/text`,
									kind: "ASR",
									text: s.text,
									startUs: s.startUs,
									endUs: s.endUs,
								},
							]
						: [],
				),
			].filter((v) => v.text.trim());
			input.shots.push({
				ref,
				sceneId: scene.id,
				...(shotIndex === undefined ? {} : { shotIndex }),
				fromFrame,
				toFrame,
				text: fields.map((v) => v.text).join("\n"),
				fields,
			});
			input.coverage.push({ ref, status: "ELIGIBLE" });
		});
	});
	input.shots.sort(
		(a, b) =>
			a.fromFrame - b.fromFrame ||
			a.toFrame - b.toFrame ||
			a.ref.localeCompare(b.ref),
	);
	return input;
}

/** Bound the serialized chunk itself; caller additionally reserves prompt/template/schema/output. */
export function buildLocalStoryChunks(
	input: LocalStoryInput,
	options: { maxBytes?: number; maxShots?: number } = {},
): LocalStoryChunk[] {
	const maxBytes = options.maxBytes ?? LOCAL_STORY_MAX_CHUNK_BYTES,
		maxShots = options.maxShots ?? 32;
	assert(
		Number.isSafeInteger(maxBytes) &&
			maxBytes > 0 &&
			maxBytes <= LOCAL_STORY_MAX_CHUNK_BYTES &&
			Number.isInteger(maxShots) &&
			maxShots > 0 &&
			maxShots <= 32,
		"LOCAL_STORY_INPUT_LIMIT",
	);
	const chunks: LocalStoryChunk[] = [];
	const pack = (
		shots: LocalStoryInput["shots"],
		index: number,
	): LocalStoryChunk => ({
		id: `chunk${index}`,
		refs: shots.map((v) => v.ref),
		context: input.scenes
			.filter((s) => shots.some((v) => v.sceneId === s.sceneId))
			.map(({ sceneId, text }) => ({ sceneId, text })),
		shots: shots.map(({ ref, sceneId, text }) => ({ ref, sceneId, text })),
	});
	let current: LocalStoryInput["shots"] = [];
	for (const shot of input.shots) {
		if (
			current.length &&
			(current.length >= maxShots ||
				bytes(pack([...current, shot], chunks.length)) > maxBytes)
		) {
			chunks.push(pack(current, chunks.length));
			current = [];
		}
		assert(
			bytes(pack([shot], chunks.length)) <= maxBytes,
			"LOCAL_STORY_INPUT_LIMIT",
		);
		current.push(shot);
	}
	if (current.length) chunks.push(pack(current, chunks.length));
	assert(
		chunks.length > 0 && chunks.length <= LOCAL_STORY_MAX_CHUNKS,
		"LOCAL_STORY_INPUT_LIMIT",
	);
	return chunks;
}

export const localStoryNumericTokens = (s: string) =>
	(
		s
			.normalize("NFKC")
			.replace(
				/([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:percent\b|per\s+cent\b|パーセント)/gi,
				"$1%",
			)
			.match(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? []
	).map((token) => {
		const percent = token.endsWith("%") ? "%" : "",
			plain = token.replaceAll(",", "").replace(/%$/, "").replace(/^\+/, ""),
			[whole = "0", fraction = ""] = plain.split(".");
		const decimal = fraction.replace(/0+$/, "");
		return (
			whole.replace(/^(-?)0+(?=\d)/, "$1") +
			(decimal ? `.${decimal}` : "") +
			percent
		);
	});

function validateEvents(
	input: LocalStoryInput,
	events: LocalStoryEvent[],
	allowed: Set<string>,
) {
	const shots = new Map(input.shots.map((s) => [s.ref, s]));
	assert(
		new Set(events.map((v) => v.id)).size === events.length,
		"LOCAL_STORY_EVIDENCE_INVALID",
		"EVENT_IDS_DUPLICATED",
	);
	for (const event of events) {
		assert(
			new Set(event.refs).size === event.refs.length &&
				event.refs.every((v) => allowed.has(v) && shots.has(v)),
			"LOCAL_STORY_EVIDENCE_INVALID",
			"EVENT_REFS_INVALID",
		);
		assert(
			event.refs.every((ref) => event.quotes.some((q) => q.ref === ref)) &&
				event.quotes.every((q) => event.refs.includes(q.ref)),
			"LOCAL_STORY_EVIDENCE_INVALID",
			"EVENT_QUOTE_REFS_MISMATCH",
		);
		for (const q of event.quotes)
			assert(
				shots.get(q.ref)?.fields.some((f) => f.text.includes(q.quote)),
				"LOCAL_STORY_EVIDENCE_INVALID",
				"QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
			);
		// A limited mechanical guard, not an entailment/causality or semantic-quality test.

		const quoted = new Set(
			localStoryNumericTokens(event.quotes.map((q) => q.quote).join("\n")),
		);
		assert(
			localStoryNumericTokens(event.label).every((n) => quoted.has(n)),
			"LOCAL_STORY_EVIDENCE_UNSUPPORTED",
			"LABEL_NUMBERS_UNSUPPORTED",
		);
	}
}
export function validateLocalStoryLedger(options: {
	input: LocalStoryInput;
	chunk: LocalStoryChunk;
	ledger: unknown;
}): LocalStoryLedger {
	const ledger = localStoryLedgerSchema.parse(options.ledger);
	assert(
		options.chunk.refs.length === options.chunk.shots.length &&
			options.chunk.refs.every((ref, i) => ref === options.chunk.shots[i]?.ref),
		"LOCAL_STORY_EVIDENCE_INVALID",
		"CHUNK_REFS_SHOTS_MISMATCH",
	);
	validateEvents(options.input, ledger.events, new Set(options.chunk.refs));
	return ledger;
}
export function mergeLocalStoryLedgers(options: {
	input: LocalStoryInput;
	chunks: readonly LocalStoryChunk[];
	ledgers: readonly unknown[];
}): LocalStoryCorpus {
	assert(
		options.chunks.length === options.ledgers.length &&
			options.chunks.length > 0,
		"LOCAL_STORY_COVERAGE_INVALID",
	);
	const refs = options.chunks.flatMap((v) => v.refs);
	assert(
		refs.length === options.input.shots.length &&
			new Set(refs).size === refs.length &&
			refs.every((v, i) => v === options.input.shots[i]?.ref),
		"LOCAL_STORY_COVERAGE_INVALID",
	);
	const ledgers = options.chunks.map((chunk, i) =>
		validateLocalStoryLedger({
			input: options.input,
			chunk,
			ledger: options.ledgers[i],
		}),
	);
	return localStoryCorpusSchema.parse({
		version: "local-story-corpus-v1",
		summaries: ledgers.map((v) => v.summary),
		coveredRefs: refs,
		events: ledgers.flatMap((ledger, i) =>
			ledger.events.map((event, eventIndex) => ({
				...event,
				id: `l${i}_e${eventIndex}`,
			})),
		),
	});
}
export function validateLocalStoryBlueprint(options: {
	ledger: { events: readonly LocalStoryEvent[] };
	blueprint: unknown;
}): LocalStoryBlueprint {
	const blueprint = localStoryBlueprintSchema.parse(options.blueprint),
		events = new Map(options.ledger.events.map((v) => [v.id, v]));
	assert(
		events.size === options.ledger.events.length,
		"LOCAL_STORY_EVIDENCE_INVALID",
		"BLUEPRINT_EVENT_IDS_DUPLICATED",
	);
	const seen = new Set<string>();
	for (const beat of blueprint.beats) {
		assert(
			!seen.has(beat.id) &&
				new Set(beat.eventIds).size === beat.eventIds.length &&
				beat.eventIds.every((v) => events.has(v)) &&
				new Set(beat.requires).size === beat.requires.length &&
				beat.requires.every((v) => seen.has(v)),
			"LOCAL_STORY_BLUEPRINT_INVALID",
			"BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
		);
		// Alternatives must fulfill the declared role, not merely name an event.
		// An ACTION or progress CHANGE cannot substitute for a completed OUTCOME.
		assert(
			beat.eventIds.every((id) => events.get(id)?.role === beat.role),
			"LOCAL_STORY_BLUEPRINT_ROLE_MISMATCH",
			"BLUEPRINT_ROLE_MISMATCH",
		);
		seen.add(beat.id);
	}
	return blueprint;
}

/** For caller-owned fixtures/plans; quotation integrity does not prove semantic support. */
export function validateLocalStoryCorpusEvents(
	input: LocalStoryInput,
	events: LocalStoryEvent[],
) {
	validateEvents(input, events, new Set(input.shots.map((v) => v.ref)));
}
