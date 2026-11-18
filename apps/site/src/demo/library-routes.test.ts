import { type ContentDetail, sceneAnalysisDocumentSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { LibraryCatalog } from "@/lib/library-catalog";
import type {
	AnyEditingProjectView,
	EditingProjectPage,
} from "@/lib/library-editing";
import type { LibrarySceneResults } from "@/lib/library-scenes";
import { createDemoLibraryRoutes } from "./library-routes";

function setup() {
	let timestamp = Date.parse("2026-11-19T00:00:00Z");
	const { route, reset } = createDemoLibraryRoutes({
		now: () => timestamp,
		json: (value, status) => Response.json(value, { status }),
		readBody: (request) => request.json(),
	});
	async function call(path: string, method = "GET", body?: unknown) {
		const url = new URL(path, "https://demo.invalid/");
		const response = await route(
			new Request(url, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			url,
		);
		if (!response) throw new Error("Demo route unavailable");
		return response;
	}
	return {
		call,
		reset,
		advance: (ms: number) => {
			timestamp += ms;
		},
	};
}

describe("demo content library", () => {
	it("lists sample content and resolves a pinned bilingual scene using the same content identities", async () => {
		const { call } = setup();
		const catalog: LibraryCatalog = await (await call("/api/library")).json();
		expect(catalog.items.map(({ title }) => title)).toEqual([
			"Big Buck Bunny",
			"Harbor at Sunrise",
			"Studio Interview",
		]);
		expect(catalog.counts).toEqual({ all: 3, playback: 0, metadata: 3 });
		const results: LibrarySceneResults = await (
			await call(
				`/api/library/scenes?q=${encodeURIComponent("漁船")}&locale=ja`,
			)
		).json();
		expect(results.total).toBe(1);
		const scene = results.items.find(({ title }) => title === "漁船の帰港");
		expect(scene).toBeDefined();
		const content: ContentDetail = await (
			await call(`/api/library/${scene?.contentId}`)
		).json();
		expect(content.locale).toBe("ja");
		expect(content.revision).toBe(scene?.contentRevision);
		const analysis = content.source.analyses.find(
			({ id }) => id === scene?.analysisRevisionId,
		);
		expect(
			sceneAnalysisDocumentSchema.parse(analysis?.document).scenes,
		).toContainEqual(
			expect.objectContaining({ id: scene?.sceneId, startInSeconds: 8 }),
		);
		expect(content.source.snapshot.playbackLinks).toEqual([]);
	});

	it("ranks scene coverage and applies ordering before the page offset", async () => {
		const { call } = setup();
		const path = "/api/library/scenes?q=bunny+pursuit&match=any";
		const relevant: LibrarySceneResults = await (await call(path)).json();
		expect(relevant.items.map(({ title }) => title)).toEqual([
			"A playful pursuit",
			"Morning in the meadow",
			"An unexpected encounter",
		]);
		expect(relevant.items[0]?.relevance).toMatchObject({
			matchedTerms: 2,
			totalTerms: 2,
		});
		const recent: LibrarySceneResults = await (
			await call(`${path}&sort=recent&offset=1`)
		).json();
		expect(recent.total).toBe(3);
		expect(recent.items.map(({ title }) => title)).toEqual([
			"An unexpected encounter",
			"A playful pursuit",
		]);
	});

	it("sorts recent scenes by updated content before applying the page offset", async () => {
		const { call, advance } = setup();
		const catalog: LibraryCatalog = await (
			await call("/api/library?q=Studio")
		).json();
		const path = `/api/library/${catalog.items[0]?.id}`;
		advance(1000);
		expect(
			(await call(path, "PATCH", { expectedRevision: 1, archived: true }))
				.status,
		).toBe(200);
		expect(
			(await call(path, "PATCH", { expectedRevision: 2, archived: false }))
				.status,
		).toBe(200);
		const recent: LibrarySceneResults = await (
			await call(
				"/api/library/scenes?q=bunny+studio&match=any&sort=recent&offset=2",
			)
		).json();
		expect(recent.total).toBe(6);
		expect(
			recent.items.map(({ contentTitle, title }) => [contentTitle, title]),
		).toEqual([
			["Studio Interview", "Closing remarks"],
			["Big Buck Bunny", "Morning in the meadow"],
			["Big Buck Bunny", "An unexpected encounter"],
			["Big Buck Bunny", "A playful pursuit"],
		]);
	});

	it("saves an edited sample clip by revision, rejects stale writes and restores the seed on reset", async () => {
		const { call, reset } = setup();
		const catalog: LibraryCatalog = await (
			await call("/api/library?q=bunny")
		).json();
		expect(catalog.total).toBe(1);
		const projects: EditingProjectPage = await (
			await call(`/api/library/edits?contentId=${catalog.items[0]?.id}`)
		).json();
		expect(projects.total).toBe(1);
		const url = `/api/library/edits/${projects.items[0]?.id}`;
		const project: AnyEditingProjectView = await (await call(url)).json();
		const [first, second] = project.draft.clips;
		if (!first || !second)
			throw new Error("Sample must have two timeline clips.");
		const document = {
			...project.draft,
			clips: [
				{
					...first,
					durationFrames: 120,
					framing: [
						{ ...first.framing[0], toFrame: 120, origin: "AISA_PROPOSAL" },
					],
				},
				{ ...second, timelineStartFrame: 120 },
			],
		};
		const input = { expectedRevision: 1, document };
		const saved = await call(`${url}/draft`, "PUT", input);
		expect(saved.status).toBe(200);
		expect(await (await call(url)).json()).toMatchObject({
			draftRevision: 2,
			draft: { clips: [{ durationFrames: 120 }, { timelineStartFrame: 120 }] },
		});
		expect((await call(`${url}/draft`, "PUT", input)).status).toBe(409);
		const revision = await call(`${url}/revisions`, "POST", {
			expectedRevision: 2,
			confirmSuggestions: true,
		});
		expect(revision.status).toBe(201);
		const confirmed: AnyEditingProjectView = await revision.json();
		expect(confirmed).toMatchObject({
			draftRevision: 3,
			currentRevisionMatchesDraft: true,
			currentRevisionId: expect.any(String),
		});
		expect(confirmed.draft.clips[0]?.framing[0]?.origin).toBe(
			"EDITOR_CONFIRMED",
		);
		expect(
			(await call(`${url}/draft`, "PUT", { expectedRevision: 2, document }))
				.status,
		).toBe(409);
		expect(
			(
				await call(`${url}/revisions`, "POST", {
					expectedRevision: 2,
					confirmSuggestions: true,
				})
			).status,
		).toBe(409);
		const repeated = await call(`${url}/revisions`, "POST", {
			expectedRevision: 3,
			confirmSuggestions: false,
		});
		expect(repeated.status).toBe(201);
		const next: AnyEditingProjectView = await repeated.json();
		expect(next.draftRevision).toBe(4);
		expect(next.currentRevisionId).not.toBe(confirmed.currentRevisionId);
		reset();
		expect(await (await call(url)).json()).toMatchObject({
			draftRevision: 1,
			draft: { clips: [{ durationFrames: 150 }, { timelineStartFrame: 150 }] },
		});
	});

	it("supports archive and restore locally and creates projects only from the chosen sample", async () => {
		const { call } = setup();
		const catalog: LibraryCatalog = await (
			await call("/api/library?q=Studio")
		).json();
		const contentId = catalog.items[0]?.id;
		const content: ContentDetail = await (
			await call(`/api/library/${contentId}`)
		).json();
		const eligibility = await (
			await call(
				`/api/library/sources/${content.source.id}/editing-eligibility`,
			)
		).json();
		const input = {
			contentId,
			title: "Interview summary",
			variant: "PORTRAIT",
			mediaVersionId: eligibility.mediaVersions[0].id,
			analysisRevisionId: eligibility.analyses[0].id,
		};
		expect(
			(
				await call("/api/library/edits", "POST", {
					...input,
					mediaVersionId: content.source.id,
				})
			).status,
		).toBe(404);
		const created = await call("/api/library/edits", "POST", input);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			contentId,
			title: input.title,
			draft: {
				canvas: { width: 1080, height: 1920 },
				captions: [
					expect.objectContaining({
						text: "I start with the strongest scene.",
					}),
					expect.objectContaining({
						text: "Then I find the right place to cut.",
					}),
				],
			},
		});
		const detail = `/api/library/${contentId}`;
		expect(
			(await call(detail, "PATCH", { expectedRevision: 1, archived: true }))
				.status,
		).toBe(200);
		expect(await (await call("/api/library?q=Studio")).json()).toMatchObject({
			total: 0,
		});
		expect(
			await (await call("/api/library?archived=true")).json(),
		).toMatchObject({
			total: 1,
			items: [{ id: contentId, archived: true }],
		});
		const sceneQuery = "/api/library/scenes?q=bunny+studio&match=any";
		const archivedScenes: LibrarySceneResults = await (
			await call(`${sceneQuery}&archived=true`)
		).json();
		expect(archivedScenes.total).toBe(3);
		expect(
			archivedScenes.items.map(({ contentTitle }) => contentTitle),
		).toEqual(["Studio Interview", "Studio Interview", "Studio Interview"]);
		expect(
			await (await call("/api/library/scenes/options?archived=true")).json(),
		).toEqual({
			locales: ["en"],
		});
		expect((await call("/api/library/edits", "POST", input)).status).toBe(404);
		expect(
			(await call(detail, "PATCH", { expectedRevision: 2, archived: false }))
				.status,
		).toBe(200);
		expect(await (await call("/api/library?q=Studio")).json()).toMatchObject({
			total: 1,
		});
	});
});
