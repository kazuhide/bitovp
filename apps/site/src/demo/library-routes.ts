import {
	type CompositionDocument,
	compileComposition,
	compositionDocumentSchema,
	compositionDurationFrames,
	confirmCompositionFraming,
} from "@bitovp/core";
import { z } from "zod";
import type { LibraryCatalog, LibraryCatalogItem } from "@/lib/library-catalog";
import type {
	AnyEditingProjectView,
	EditingProjectSummary,
} from "@/lib/library-editing";
import {
	type LibrarySceneHit,
	librarySceneRelevance,
} from "@/lib/library-scenes";
import { demoLibrarySamples } from "./library-fixtures";

type Sample = ReturnType<typeof demoLibrarySamples>[number];
type Project = Omit<AnyEditingProjectView, "draft"> & {
	draft: CompositionDocument;
	updatedAt: string;
};
const maxProjects = 20;
const pageSize = 25;
const revision = z.number().int().positive();
const draftUpdate = z.strictObject({
	expectedRevision: revision,
	document: compositionDocumentSchema,
});
const revisionSave = z.strictObject({
	expectedRevision: revision,
	confirmSuggestions: z.boolean(),
});
const projectCreate = z.strictObject({
	contentId: z.uuid(),
	mediaVersionId: z.uuid(),
	analysisRevisionId: z.uuid().nullable(),
	title: z.string().trim().min(1).max(500),
	variant: z.enum(["LANDSCAPE", "PORTRAIT"]),
});
const archiveUpdate = z.strictObject({
	expectedRevision: revision,
	archived: z.boolean(),
});
const matches = (value: string, query: string) =>
	value.toLocaleLowerCase().includes(query);
const normalizeSceneText = (text: string) =>
	text.normalize("NFKC").toLowerCase();

function newProject(
	sample: Sample,
	title: string,
	variant: "LANDSCAPE" | "PORTRAIT",
	analysisId: string | null,
	id = crypto.randomUUID(),
): Project {
	const { content, media, facts } = sample;
	const analysis = content.source.analyses.find(
		(item) => item.id === analysisId,
	);
	const clips = [30, 270].map((sourceFrame, index) => {
		const scene = analysis?.document.scenes[index];
		return {
			id: crypto.randomUUID(),
			sourceInUs: (sourceFrame * 1_000_000) / facts.timeMap.fps.num,
			timelineStartFrame: 150 * index,
			durationFrames: 150,
			framing: [{ fromFrame: 0, toFrame: 150, mode: "FIT", origin: "MANUAL" }],
			audio: { mode: "MUTE" },
			...(scene ? { evidence: { sceneId: scene.id } } : {}),
		};
	});
	const captions =
		content.title === "Studio Interview"
			? [
					"I start with the strongest scene.",
					"Then I find the right place to cut.",
				].map((text, index) => ({
					id: crypto.randomUUID(),
					text,
					fromFrame: index * 150 + 20,
					toFrame: index * 150 + 100,
					anchorClipId: clips[index]?.id,
				}))
			: [];
	return {
		id,
		contentId: content.id,
		title,
		variant,
		updatedAt: content.updatedAt,
		draftRevision: 1,
		currentRevisionId: null,
		currentRevisionMatchesDraft: false,
		media,
		analysis: analysis ?? null,
		renders: [],
		compositionSources: [facts],
		draft: compositionDocumentSchema.parse({
			schemaVersion: 2,
			mediaVersionId: media.id,
			analysisRevisionId: analysis?.id ?? null,
			locale: analysis?.locale ?? content.locale,
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			timeMapId: facts.timeMap.id,
			canvas:
				variant === "PORTRAIT"
					? { width: 1080, height: 1920 }
					: { width: 1920, height: 1080 },
			fps: facts.timeMap.fps,
			clips,
			captions,
		}),
	};
}

function projectSummary(project: Project): EditingProjectSummary {
	return {
		id: project.id,
		contentId: project.contentId,
		title: project.title,
		variant: project.variant,
		updatedAt: project.updatedAt,
		archived: false,
		draftRevision: project.draftRevision,
		currentRevisionId: project.currentRevisionId,
		currentRevisionMatchesDraft: project.currentRevisionMatchesDraft,
		durationFrames: compositionDurationFrames(project.draft),
		fps: project.draft.fps,
		latestExport: null,
		latestSuccessfulExport: null,
	};
}

export function createDemoLibraryRoutes({
	json,
	readBody,
	now,
}: {
	json: (value: unknown, status?: number) => Response;
	readBody: (request: Request) => Promise<Record<string, unknown>>;
	now: () => number;
}) {
	const error = (message: string, status: number) =>
		json({ error: message }, status);
	let samples = demoLibrarySamples(now());
	let projects = seedProjects();

	function seedProjects() {
		return new Map(
			samples.map((sample) => [
				sample.projectId,
				newProject(
					sample,
					`${sample.content.title} · Sample cut`,
					"LANDSCAPE",
					sample.content.source.analyses.find(
						({ locale }) => locale === sample.content.locale,
					)?.id ?? null,
					sample.projectId,
				),
			]),
		);
	}

	const catalogItem = ({ content }: Sample): LibraryCatalogItem => {
		const { source, parent: _parent, ...view } = content;
		const analysis = source.analyses[0]?.document;
		return {
			...view,
			clipProjectCount: [...projects.values()].filter(
				(project) => project.contentId === content.id,
			).length,
			clipExportCount: 0,
			catalogMetadata: {
				formats: [],
				duration: analysis?.duration,
				sceneCount: analysis?.scenes.length,
			},
		};
	};

	async function route(
		request: Request,
		url: URL,
	): Promise<Response | undefined> {
		const path = url.pathname.replace(/\/$/, "");
		if (path !== "/api/library" && !path.startsWith("/api/library/")) return;
		const { method } = request;
		const params = url.searchParams;
		const query = (params.get("q") ?? "").trim().toLocaleLowerCase();
		const archived = params.get("archived") === "true";
		const offset = z.coerce
			.number()
			.int()
			.min(0)
			.max(100000)
			.catch(0)
			.parse(params.get("offset"));
		const visible = samples.filter(
			({ content }) => archived === content.archived,
		);

		if (method === "GET" && path === "/api/library") {
			const items = visible
				.filter(({ content }) =>
					matches(
						[content.title, content.description, ...content.tags].join(" "),
						query,
					),
				)
				.map(catalogItem);
			const filtered = params.get("playback") === "playback" ? [] : items;
			return json({
				items: filtered.slice(offset, offset + pageSize),
				total: filtered.length,
				counts: { all: items.length, playback: 0, metadata: items.length },
			} satisfies LibraryCatalog);
		}

		if (method === "GET" && path === "/api/library/scenes/options")
			return json({
				locales: [
					...new Set(visible.map(({ content }) => content.locale)),
				].sort(),
			});

		if (method === "GET" && path === "/api/library/scenes") {
			const locale = params.get("locale");
			const terms = [
				...new Set(
					normalizeSceneText(params.get("q") ?? "")
						.split(/\s+/u)
						.filter(Boolean),
				),
			];
			const matchAny = params.get("match") === "any";
			const sortByRelevance = params.get("sort") !== "recent";
			const items = visible.flatMap(({ content }) => {
				// The detail route pins to the registered content locale.
				const analysis = content.source.analyses.find(
					(item) => item.locale === content.locale,
				);
				if (
					!analysis ||
					!terms.length ||
					(locale && analysis.locale !== locale)
				)
					return [];
				return analysis.document.scenes.flatMap((scene, ordinal) => {
					const fields = [
						{ weight: 8, text: normalizeSceneText(scene.title) },
						{
							weight: 5,
							text: normalizeSceneText(
								[
									...scene.keywords,
									...scene.shots.flatMap((shot) => shot.keywords),
								].join(" "),
							),
						},
						{ weight: 3, text: normalizeSceneText(scene.summary) },
						{
							weight: 1,
							text: normalizeSceneText(
								scene.shots.map((shot) => shot.detailedDescription).join(" "),
							),
						},
					];
					let coverage = 0;
					let weight = 0;
					for (const term of terms) {
						const field = fields.find(({ text }) => text.includes(term));
						if (field) {
							coverage++;
							weight += field.weight;
						}
					}
					if (!coverage || (!matchAny && coverage !== terms.length)) return [];
					const hit: LibrarySceneHit = {
						contentId: content.id,
						contentTitle: content.title,
						contentRevision: content.revision,
						analysisRevisionId: analysis.id,
						sceneId: scene.id,
						locale: analysis.locale,
						archived: content.archived,
						startInSeconds: scene.startInSeconds,
						endInSeconds: scene.endInSeconds,
						title: scene.title,
						summary: scene.summary,
						relevance: librarySceneRelevance(coverage, terms.length, weight),
					};
					return [
						{ hit, updatedAt: content.updatedAt, ordinal, coverage, weight },
					];
				});
			});
			items.sort((a, b) => {
				if (sortByRelevance) {
					const rank = b.coverage - a.coverage || b.weight - a.weight;
					if (rank) return rank;
				}
				return (
					b.updatedAt.localeCompare(a.updatedAt) ||
					a.hit.contentId.localeCompare(b.hit.contentId) ||
					a.hit.startInSeconds - b.hit.startInSeconds ||
					a.ordinal - b.ordinal
				);
			});
			return json({
				items: items.slice(offset, offset + pageSize).map(({ hit }) => hit),
				total: items.length,
			});
		}

		if (method === "GET" && path === "/api/library/editing-media")
			return json({
				media: samples
					.filter(({ content }) => !content.archived)
					.map(({ media, facts }) => ({ ...media, facts })),
			});

		if (
			method === "GET" &&
			path === "/api/library/media-tasks" &&
			params.get("view") === "history"
		)
			return json({ items: [], hasMore: false });

		if (path === "/api/library/edits" && method === "GET") {
			const items =
				params.get("scope") === "exports"
					? []
					: [...projects.values()]
							.filter(
								(project) => project.contentId === params.get("contentId"),
							)
							.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
							.map(projectSummary);
			return json({
				items: items.slice(offset, offset + pageSize),
				total: items.length,
				offset,
			});
		}

		if (path === "/api/library/edits" && method === "POST") {
			const input = projectCreate.safeParse(await readBody(request));
			if (!input.success) return error("Invalid clip project.", 400);
			const { contentId, mediaVersionId, analysisRevisionId, title, variant } =
				input.data;
			const sample = samples.find(
				({ content, media }) =>
					content.id === contentId &&
					!content.archived &&
					media.id === mediaVersionId &&
					(analysisRevisionId === null ||
						content.source.analyses.some(
							(item) => item.id === analysisRevisionId,
						)),
			);
			if (!sample) return error("Sample source is unavailable.", 404);
			if (projects.size >= maxProjects)
				return error("Reset the demo to create more clip projects.", 409);
			const project = newProject(sample, title, variant, analysisRevisionId);
			project.updatedAt = new Date(now()).toISOString();
			projects.set(project.id, project);
			return json(project, 201);
		}

		const edit =
			/^\/api\/library\/edits\/([^/]+)(?:\/(draft|revisions))?$/.exec(path);
		if (edit) {
			const id = edit[1] ?? "";
			const action = edit[2];
			if (!action && method === "GET") {
				const project = projects.get(id);
				return project
					? json(project)
					: error("Clip project was not found.", 404);
			}
			if (action === "draft" && method === "PUT") {
				const input = draftUpdate.safeParse(await readBody(request));
				if (!input.success) return error("Invalid clip draft.", 400);
				const project = projects.get(id);
				if (!project) return error("Clip project was not found.", 404);
				if (project.draftRevision !== input.data.expectedRevision)
					return error("The clip draft has changed.", 409);
				const draft = input.data.document;
				const additional = (draft.sources ?? []).flatMap(
					({ mediaVersionId, analysisRevisionId }) => {
						const sample = samples.find(
							({ media }) => media.id === mediaVersionId,
						);
						return sample &&
							(!analysisRevisionId ||
								sample.content.source.analyses.some(
									({ id }) => id === analysisRevisionId,
								))
							? [sample]
							: [];
					},
				);
				const primary = samples.find(
					({ media }) => media.id === project.media.id,
				);
				if (
					!primary ||
					draft.mediaVersionId !== project.media.id ||
					draft.analysisRevisionId !== project.draft.analysisRevisionId ||
					draft.autoGeneration ||
					draft.imageAssets?.length
				)
					return error("The draft must use the sample sources.", 400);
				const compositionSources = [primary, ...additional].map(
					({ facts }) => facts,
				);
				try {
					compileComposition(draft, compositionSources, {
						allowUnconfirmed: true,
					});
				} catch {
					return error("The draft exceeds the sample source range.", 400);
				}
				const next = {
					...project,
					draft,
					compositionSources,
					additionalMedia: additional.map(({ media }) => media),
					draftRevision: project.draftRevision + 1,
					currentRevisionMatchesDraft: false,
					updatedAt: new Date(now()).toISOString(),
				};
				projects.set(id, next);
				return json(next);
			}
			if (action === "revisions" && method === "POST") {
				const input = revisionSave.safeParse(await readBody(request));
				if (!input.success) return error("Invalid clip revision.", 400);
				const project = projects.get(id);
				if (!project) return error("Clip project was not found.", 404);
				if (project.draftRevision !== input.data.expectedRevision)
					return error("The clip draft has changed.", 409);
				const next = {
					...project,
					draft: input.data.confirmSuggestions
						? confirmCompositionFraming(project.draft)
						: project.draft,
					draftRevision: project.draftRevision + 1,
					currentRevisionId: crypto.randomUUID(),
					currentRevisionMatchesDraft: true,
					updatedAt: new Date(now()).toISOString(),
				};
				projects.set(id, next);
				return json(next, 201);
			}
		}

		const eligibility =
			/^\/api\/library\/sources\/([^/]+)\/editing-eligibility$/.exec(path);
		if (eligibility && method === "GET") {
			const sample = samples.find(
				({ content }) => content.source.id === eligibility[1],
			);
			if (!sample) return error("Sample source was not found.", 404);
			return json({
				sourceId: sample.content.source.id,
				files: [],
				mediaVersions: [sample.media],
				analyses: sample.content.source.analyses.map(
					({ id, locale, document }) => ({ id, locale, title: document.title }),
				),
			});
		}

		const detail = /^\/api\/library\/([^/]+)$/.exec(path);
		if (detail && (method === "GET" || method === "PATCH")) {
			const input =
				method === "PATCH"
					? archiveUpdate.safeParse(await readBody(request))
					: null;
			const sample = samples.find(({ content }) => content.id === detail[1]);
			if (!sample) return error("Content was not found.", 404);
			if (input && !input.success) return error("Invalid content change.", 400);
			if (input?.success) {
				const { content } = sample;
				if (content.revision !== input.data.expectedRevision)
					return error("The content has changed.", 409);
				content.archived = input.data.archived;
				content.revision++;
				content.updatedAt = new Date(now()).toISOString();
				content.source.contents = [
					{ id: content.id, title: content.title, archived: content.archived },
				];
			}
			return json(sample.content);
		}
	}

	return {
		route,
		reset() {
			samples = demoLibrarySamples(now());
			projects = seedProjects();
		},
	};
}
