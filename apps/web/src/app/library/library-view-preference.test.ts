import { afterEach, expect, it, vi } from "vitest";
import {
	libraryBrowseSearch,
	readLibraryBrowseState,
	readLibraryViewPreference,
	saveLibraryViewPreference,
} from "./library-view-preference";

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

it("round-trips browse context in the URL, validating hostile query shapes", () => {
	const state = readLibraryBrowseState({
		q: "trees & birds",
		archived: "true",
		playback: "metadata",
		mode: "scenes",
		offset: "25",
	});
	expect(
		readLibraryBrowseState(
			Object.fromEntries(new URLSearchParams(libraryBrowseSearch(state))),
		),
	).toEqual(state);
	expect(
		readLibraryBrowseState({
			q: ["unexpected"],
			playback: "unknown",
			mode: "other",
			offset: "-25",
		}),
	).toEqual({
		q: "",
		archived: false,
		playback: "all",
		mode: "content",
		offset: 0,
		match: "all",
		sort: "relevance",
		locale: "",
	});
	expect(
		readLibraryBrowseState({ q: "x".repeat(300), offset: "100001" }),
	).toMatchObject({ q: "x".repeat(200), offset: 0 });
});

it("persists only an allowlisted view value and tolerates unavailable storage", () => {
	expect(readLibraryViewPreference()).toBe("grid");
	saveLibraryViewPreference("list");
	expect(readLibraryViewPreference()).toBe("list");
	expect(Object.keys(localStorage)).toEqual(["bitovp.library.view"]);
	localStorage.setItem("bitovp.library.view", "arbitrary");
	expect(readLibraryViewPreference()).toBe("grid");
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new DOMException("denied");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new DOMException("denied");
	});
	expect(readLibraryViewPreference()).toBe("grid");
	expect(() => saveLibraryViewPreference("list")).not.toThrow();
});

it("round-trips scene filters and rejects invalid filter and locale URL values", () => {
	const state = readLibraryBrowseState({
		mode: "scenes",
		match: "any",
		sort: "recent",
		locale: "zh-Hant",
		offset: "25",
	});
	expect(state).toMatchObject({
		match: "any",
		sort: "recent",
		locale: "zh-Hant",
	});
	expect(
		readLibraryBrowseState(
			Object.fromEntries(new URLSearchParams(libraryBrowseSearch(state))),
		),
	).toEqual(state);
	for (const locale of ["en_US", "ja<script>", "a".repeat(36)]) {
		expect(
			readLibraryBrowseState({ match: "other", sort: "random", locale }),
		).toMatchObject({
			match: "all",
			sort: "relevance",
			locale: "",
		});
	}
	expect(readLibraryBrowseState({ locale: "und" })).toMatchObject({
		locale: "und",
	});
	expect(libraryBrowseSearch(readLibraryBrowseState({}))).toBe("");
});
