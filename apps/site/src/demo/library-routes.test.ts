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
	const { route, reset } = createDemoLibraryRoutes({
		now: () => Date.parse("2026-11-19T00:00:00Z"),
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
	return { call, reset };
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
					framing: [{ ...first.framing[0], toFrame: 120 }],
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
			confirmSuggestions: false,
		});
		expect(await revision.json()).toMatchObject({
			currentRevisionMatchesDraft: true,
			currentRevisionId: expect.any(String),
		});
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
