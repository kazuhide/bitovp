import { describe, expect, it } from "vitest";
import {
	librarySceneHref,
	librarySceneRelevance,
	readLibrarySceneSelection,
} from "./library-scenes";

it("reports bounded relevance consistent with term coverage then field weights", () => {
	expect(librarySceneRelevance(2, 2, 16)).toEqual({
		score: 100,
		matchedTerms: 2,
		totalTerms: 2,
	});
	expect(librarySceneRelevance(2, 2, 10).score).toBe(88);
	expect(librarySceneRelevance(2, 2, 6).score).toBe(80);
	expect(librarySceneRelevance(2, 2, 2).score).toBe(72);
	expect(librarySceneRelevance(1, 2, 8).score).toBe(50);
	expect(librarySceneRelevance(1, 1, 3).score).toBe(70.6);
});

const hit = {
	contentId: "59b20fda-8677-4af0-af43-05ce23dd3966",
	contentTitle: "A film",
	contentRevision: 4,
	analysisRevisionId: "bc7bd47a-b0f7-426c-a839-46ae1f45768e",
	sceneId: "a302f681-b9e3-4c6a-aacb-63fb63b28c36",
	locale: "ja",
	archived: false,
	startInSeconds: 1.25,
	endInSeconds: 3.5,
	title: "Arrival",
	summary: "The character arrives.",
};

const params = () =>
	Object.fromEntries(
		new URL(librarySceneHref(hit), "http://localhost").searchParams,
	);

describe("library scene links", () => {
	it("carries the saved content and analysis identities without trusting a URL timestamp", () => {
		const url = new URL(librarySceneHref(hit), "http://localhost");
		expect(url.pathname).toBe(`/library/${hit.contentId}`);
		expect(readLibrarySceneSelection(params())).toEqual({
			contentRevision: 4,
			analysisRevisionId: hit.analysisRevisionId,
			sceneId: hit.sceneId,
			locale: "ja",
			archived: false,
		});
		expect([...url.searchParams.keys()]).not.toContain("startInSeconds");
	});

	it("requires a complete unambiguous selection", () => {
		expect(readLibrarySceneSelection({})).toBeUndefined();
		for (const key of Object.keys(params())) {
			const incomplete = params();
			delete incomplete[key];
			expect(readLibrarySceneSelection(incomplete)).toBeUndefined();
			expect(
				readLibrarySceneSelection({
					...params(),
					[key]: [params()[key] ?? "", params()[key] ?? ""],
				}),
			).toBeUndefined();
		}
	});

	it.each([
		"0",
		"-1",
		"1.5",
		"Infinity",
		"2147483648",
	])("rejects invalid saved revision %s", (contentRevision) => {
		expect(
			readLibrarySceneSelection({ ...params(), contentRevision }),
		).toBeUndefined();
	});

	it("rejects invalid identities and accepts explicitly archived content", () => {
		expect(
			readLibrarySceneSelection({ ...params(), sceneId: "next" }),
		).toBeUndefined();
		expect(
			readLibrarySceneSelection({ ...params(), analysisRevisionId: "latest" }),
		).toBeUndefined();
		expect(
			readLibrarySceneSelection({ ...params(), archived: "yes" }),
		).toBeUndefined();
		expect(
			readLibrarySceneSelection({ ...params(), archived: "true" })?.archived,
		).toBe(true);
	});
});
