import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibrarySceneResults } from "@/lib/library-scenes";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
vi.mock("@/lib/api", () => ({
	apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));

import { LibraryClient } from "./library-client";

const initial = {
	q: "birds trees",
	archived: false,
	playback: "all",
	mode: "scenes",
	offset: 25,
} as const;
function scenes(title: string): LibrarySceneResults {
	return {
		total: 51,
		items: [
			{
				contentId: "content",
				contentTitle: "Nature",
				contentRevision: 1,
				analysisRevisionId: "a1111111-1111-4111-8111-111111111111",
				sceneId: "b1111111-1111-4111-8111-111111111111",
				title,
				summary: "Trees and birds",
				startInSeconds: 0,
				endInSeconds: 10,
				locale: "ja",
				archived: false,
			},
		],
	};
}
const sceneCalls = () =>
	apiFetch.mock.calls.filter(([url]) => url.startsWith("/api/library/scenes?"));
const optionsCalls = () =>
	apiFetch.mock.calls.filter(([url]) =>
		url.startsWith("/api/library/scenes/options?"),
	);

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url) =>
		url.startsWith("/api/library/scenes/options?")
			? { locales: ["en", "ja"] }
			: url.startsWith("/api/library/scenes?")
				? scenes("Forest scene")
				: { items: [], total: 0, counts: { all: 0, playback: 0, metadata: 0 } },
	);
	localStorage.clear();
	window.history.replaceState(null, "", "/library");
});

it("persists scene filters, resets each changed page, and clears all scene conditions", async () => {
	renderWithQuery(<LibraryClient initialQuery={initial} />);
	await screen.findByRole("link", { name: /Forest scene/ });
	expect(screen.getByText("26–26 of 51")).toBeInTheDocument();
	const match = screen.getByRole("combobox", { name: "Match" });
	const sort = screen.getByRole("combobox", { name: "Sort" });
	const language = screen.getByRole("combobox", { name: "Analysis language" });
	expect(match).toHaveValue("all");
	expect(sort).toHaveValue("relevance");
	await waitFor(() =>
		expect(
			within(language).getByRole("option", { name: "Japanese (ja)" }),
		).toBeInTheDocument(),
	);
	for (const [control, value, key] of [
		[match, "any", "match"],
		[sort, "recent", "sort"],
		[language, "ja", "locale"],
	] as const) {
		fireEvent.change(control, { target: { value } });
		await waitFor(() => {
			const params = new URL(sceneCalls().at(-1)?.[0] ?? "", "http://localhost")
				.searchParams;
			expect(params.get(key)).toBe(value);
			expect(params.get("offset")).toBe("0");
		});
		expect(new URLSearchParams(window.location.search).get(key)).toBe(value);
	}
	expect(optionsCalls()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
	expect(screen.getByRole("searchbox")).toHaveValue("");
	expect(match).toHaveValue("all");
	expect(sort).toHaveValue("relevance");
	expect(language).toHaveValue("");
	expect(window.location.search).toBe("?mode=scenes");
});

it("isolates cached scene filters and ignores an aborted late filter response", async () => {
	const pending = new Map<string, (data: LibrarySceneResults) => void>();
	apiFetch.mockImplementation(async (url) => {
		if (url.startsWith("/api/library/scenes/options?"))
			return { locales: ["ja"] };
		const params = new URL(url, "http://localhost").searchParams;
		return params.get("match") === "any"
			? new Promise((resolve) =>
					pending.set(params.get("sort") ?? "relevance", resolve),
				)
			: scenes("Original scene");
	});
	const { client } = renderWithQuery(
		<LibraryClient initialQuery={{ ...initial, offset: 0 }} />,
	);
	await screen.findByRole("link", { name: /Original scene/ });
	fireEvent.change(screen.getByRole("combobox", { name: "Match" }), {
		target: { value: "any" },
	});
	await waitFor(() => expect(pending.has("relevance")).toBe(true));
	const abandoned = sceneCalls().at(-1)?.[1]?.signal;
	expect(
		screen.getByRole("link", { name: /Original scene/ }),
	).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
		target: { value: "recent" },
	});
	await waitFor(() => expect(pending.has("recent")).toBe(true));
	expect(abandoned?.aborted).toBe(true);
	await act(async () => pending.get("recent")?.(scenes("Newest scene")));
	await screen.findByRole("link", { name: /Newest scene/ });
	await act(async () => pending.get("relevance")?.(scenes("Obsolete scene")));
	expect(
		screen.queryByRole("link", { name: /Obsolete scene/ }),
	).not.toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: /Newest scene/ }),
	).toBeInTheDocument();
	expect(
		client.getQueryCache().findAll({ queryKey: ["library", "scenes"] }),
	).toHaveLength(3);
});

it("loads languages only in scenes, retries failure, and preserves a selected unavailable language", async () => {
	let reads = 0;
	apiFetch.mockImplementation(async (url) => {
		if (url.startsWith("/api/library/scenes/options?")) {
			if (++reads === 1) throw new Error("Language options unavailable");
			return { locales: ["en", "ja"] };
		}
		return url.startsWith("/api/library/scenes?")
			? { items: [], total: 0 }
			: { items: [], total: 0, counts: { all: 0, playback: 0, metadata: 0 } };
	});
	renderWithQuery(
		<LibraryClient
			initialQuery={{ ...initial, mode: "content", locale: "fr" }}
		/>,
	);
	await screen.findByText("No assets match these filters.");
	expect(optionsCalls()).toHaveLength(0);
	window.history.replaceState(
		null,
		"",
		"/library?mode=scenes&q=birds&locale=fr&match=any&sort=recent&offset=25",
	);
	fireEvent.popState(window);
	await screen.findByText("Could not load analysis languages.");
	const language = screen.getByRole("combobox", { name: "Analysis language" });
	expect(language).toHaveValue("fr");
	expect(
		within(language).getByRole("option", { name: "French (fr)" }),
	).toBeInTheDocument();
	expect(screen.getByRole("combobox", { name: "Match" })).toHaveValue("any");
	expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("recent");
	fireEvent.click(screen.getByRole("button", { name: "Retry languages" }));
	await waitFor(() =>
		expect(
			within(language).getByRole("option", { name: "Japanese (ja)" }),
		).toBeInTheDocument(),
	);
	expect(language).toHaveValue("fr");
	expect(
		screen.queryByText("Could not load analysis languages."),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("checkbox"));
	await waitFor(() =>
		expect(optionsCalls().at(-1)?.[0]).toBe(
			"/api/library/scenes/options?archived=true",
		),
	);
	expect(language).toHaveValue("fr");
});
