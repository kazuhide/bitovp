import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import { cfrTimeMapSchema } from "./schema";
import {
	type StoryGraph,
	type StoryModelInput,
	storyGraphSchema,
	storyModelInputSchema,
} from "./story-contracts";

const EXCLUDED = new Set([
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
]);
export class StoryGraphError extends Error {
	readonly code = "STORY_GRAPH_INVALID";
	constructor(
		message = "Story evidence is not grounded in the supplied catalog",
	) {
		super(message);
		this.name = "StoryGraphError";
	}
}
const requireStory = (value: unknown): void => {
	if (!value) throw new StoryGraphError();
};
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
const sample = <T>(items: readonly T[], count: number): T[] =>
	count >= items.length
		? [...items]
		: Array.from(
				{ length: count },
				(_, i) => items[Math.floor((i * items.length) / count)],
			).filter((item): item is T => item !== undefined);

/** Bounded descriptions only; no storage URLs, credentials, frames or external context. */
export function buildStoryModelInput(input: {
	analysis: unknown;
	timeMap: unknown;
}): StoryModelInput {
	if (input.analysis && typeof input.analysis === "object") {
		const scenes = (input.analysis as { scenes?: unknown }).scenes;
		if (Array.isArray(scenes)) {
			requireStory(scenes.length <= 10_000);
			let intervals = 0;
			for (const s of scenes) {
				const shots = (s as { shots?: unknown } | null)?.shots;
				intervals += Array.isArray(shots) && shots.length ? shots.length : 1;
				requireStory(intervals <= 10_000);
			}
		}
	}
	const analysis = sceneAnalysisDocumentSchema.parse(input.analysis),
		map = cfrTimeMapSchema.parse(input.timeMap);
	const intervals: StoryModelInput["intervals"] = [];
	let index = 0;
	for (const scene of analysis.scenes) {
		if (EXCLUDED.has(scene.type.toUpperCase())) continue;
		const entities = [
			...(scene.content?.characters ?? []).map((c) => c.name),
			...(scene.content?.objects ?? []).map((o) => o.category),
		]
			.map((s) => s.trim().slice(0, 80))
			.filter(Boolean)
			.slice(0, 4);
		for (const [shotIndex, interval] of (scene.shots.length
			? scene.shots
			: [scene]
		).entries()) {
			const ref = `i${index++}`;
			if (
				interval.startInSeconds < map.sourceStartUs / 1_000_000 ||
				interval.endInSeconds > map.sourceEndUs / 1_000_000
			)
				continue;
			const shot = scene.shots.length ? scene.shots[shotIndex] : undefined;
			const text = [
				scene.title.slice(0, 120),
				(shot ? shot.detailedDescription : scene.summary).slice(0, 640),
				(shot ? shot.keywords : scene.keywords).slice(0, 6).join(", "),
			]
				.filter(Boolean)
				.join("\n")
				.slice(0, 960);
			if (!text.trim()) continue;
			intervals.push({
				ref,
				sceneId: scene.id,
				...(shot ? { shotIndex } : {}),
				startInSeconds: interval.startInSeconds,
				endInSeconds: interval.endInSeconds,
				text,
				entities,
			});
		}
	}
	const sorted = intervals.sort(
		(a, b) => a.startInSeconds - b.startInSeconds || a.ref.localeCompare(b.ref),
	);
	const result: StoryModelInput = {
		version: "aisa-story-input-v1",
		asset: {
			title: analysis.title.slice(0, 512),
			description: analysis.description.slice(0, 2400),
		},
		coverage: {
			totalIntervals: sorted.length,
			includedIntervals: Math.min(sorted.length, 192),
			truncated: sorted.length > 192,
		},
		intervals: sample(sorted, Math.min(sorted.length, 192)),
	};
	while (bytes(result) > 96 * 1024 && result.intervals.length) {
		result.intervals = sample(sorted, result.intervals.length - 1);
		result.coverage.includedIntervals = result.intervals.length;
		result.coverage.truncated = true;
	}
	return storyModelInputSchema.parse(result);
}

/** Quotation integrity is checked; causal interpretation is still a model inference. */
export function validateStoryGraph(input: {
	input: StoryModelInput;
	graph: unknown;
}): StoryGraph {
	const catalog = storyModelInputSchema.parse(input.input),
		parsed = storyGraphSchema.safeParse(input.graph);
	if (!parsed.success || bytes(input.graph) > 192 * 1024)
		throw new StoryGraphError();
	const graph = parsed.data,
		refs = new Map(catalog.intervals.map((s) => [s.ref, s])),
		entities = new Set(graph.keyEntities.map((e) => e.id)),
		events = new Map(graph.events.map((e) => [e.id, e]));
	requireStory(refs.size === catalog.intervals.length);
	requireStory(catalog.coverage.includedIntervals === catalog.intervals.length);
	requireStory(entities.size === graph.keyEntities.length);
	requireStory(events.size === graph.events.length);
	requireStory(new Set(graph.arcs.map((a) => a.id)).size === graph.arcs.length);
	for (const entity of graph.keyEntities) {
		requireStory(new Set(entity.refs).size === entity.refs.length);
		requireStory(entity.refs.every((ref) => refs.has(ref)));
	}
	for (const event of graph.events) {
		requireStory(new Set(event.entityIds).size === event.entityIds.length);
		requireStory(event.entityIds.every((id) => entities.has(id)));
		requireStory(new Set(event.dependsOn).size === event.dependsOn.length);
		requireStory(
			event.dependsOn.every((id) => id !== event.id && events.has(id)),
		);
		for (const evidence of event.evidence)
			requireStory(refs.get(evidence.ref)?.text.includes(evidence.quote));
	}
	for (const arc of graph.arcs) {
		requireStory(new Set(arc.eventIds).size === arc.eventIds.length);
		requireStory(arc.eventIds.every((id) => events.has(id)));
	}
	const visiting = new Set<string>(),
		visited = new Set<string>();
	const visit = (id: string) => {
		requireStory(!visiting.has(id));
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of events.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of events.keys()) visit(id);
	return graph;
}
