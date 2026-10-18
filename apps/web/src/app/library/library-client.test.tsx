import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryCatalog } from "@/lib/library-catalog";
import { renderWithQuery } from "@/test/render";

const response: LibraryCatalog = {
	total: 26,
	counts: { all: 26, playback: 26, metadata: 0 },
	items: [
		{
			id: "content",
			title: "A real asset",
			description: "The source video",
			locale: "ja",
			tags: ["nature"],
			revision: 1,
			archived: false,
			updatedAt: "2026-09-15",
			catalogMetadata: { formats: ["HLS"], duration: 90, sceneCount: 3 },
			catalogPreview: {
				kind: "HLS",
				url: "https://media.test/asset.m3u8",
				time: 5,
				duration: 90,
				sceneCount: 3,
			},
		},
	],
};
const apiFetch = vi.fn(async (_url: string) => response);
beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue(response);
	localStorage.clear();
	window.history.replaceState(null, "", "/library");
});
vi.mock("@/lib/api", () => ({
	apiFetch: (url: string) => apiFetch(url),
}));
vi.mock("./catalog-thumbnail", () => ({
	CatalogThumbnail: ({
		source,
		fallback,
		compact,
	}: {
		source: { kind: string };
		fallback: string;
		compact: boolean;
	}) => (
		<div
			data-testid="thumbnail"
			data-kind={source.kind}
			data-compact={String(compact)}
		>
			{fallback}
		</div>
	),
}));

import { LibraryClient } from "./library-client";

it.each([
	"content",
	"scenes",
] as const)("bounds %s paging at the accepted maximum and still permits Previous", async (mode) => {
	const scene = {
		contentId: "content",
		contentTitle: "A real asset",
		title: "Boundary scene",
		summary: "Scene result",
		startInSeconds: 0,
		endInSeconds: 10,
		contentRevision: 1,
		analysisRevisionId: "a1111111-1111-4111-8111-111111111111",
		sceneId: "b1111111-1111-4111-8111-111111111111",
		locale: "ja",
		archived: false,
	};
	apiFetch.mockResolvedValue(
		mode === "content"
			? { ...response, total: 100026 }
			: ({ items: [scene], total: 100026 } as unknown as LibraryCatalog),
	);
	renderWithQuery(
		<LibraryClient
			initialQuery={{
				q: "boundary",
				archived: false,
				playback: "all",
				mode,
				offset: 100000,
			}}
		/>,
	);
	await screen.findByRole("link", {
		name: mode === "content" ? /A real asset/ : /Boundary scene/,
	});
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Previous" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("offset=99975"),
		),
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("offset=100000"),
		),
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled(),
	);
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	expect(
		apiFetch.mock.calls.every(
			([url]) =>
				Number(new URL(url, "http://localhost").searchParams.get("offset")) <=
				100000,
		),
	).toBe(true);
});

it("defaults to large thumbnails, persists list mode, and preserves paging/search/archive", async () => {
	const view = renderWithQuery(<LibraryClient />);
	expect(
		await screen.findByRole("link", { name: /A real asset/ }),
	).toHaveAttribute("href", "/library/content");
	expect(screen.getByTestId("thumbnail")).toBeInTheDocument();
	expect(view.container.querySelector("ul")).toHaveClass("grid");
	expect(screen.getByTestId("thumbnail")).toHaveAttribute(
		"data-compact",
		"false",
	);
	fireEvent.click(screen.getByRole("button", { name: "List view" }));
	expect(view.container.querySelector("ul")).not.toHaveClass("grid");
	expect(localStorage.getItem("bitovp.library.view")).toBe("list");
	expect(screen.getByText("HLS")).toBeInTheDocument();
	expect(screen.getByText("1–1 of 26")).toBeInTheDocument();
	expect(screen.getByText("1:30")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("offset=25"),
		),
	);
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Nature" },
	});
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("q=Nature&archived=false&offset=0"),
		),
	);
	fireEvent.click(screen.getByRole("checkbox"));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("archived=true&offset=0"),
		),
	);
});

it("requests playback filtering on the server and resets pagination while retaining other filters", async () => {
	renderWithQuery(<LibraryClient />);
	await screen.findByRole("link", { name: /A real asset/ });
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Nature" },
	});
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("q=Nature"),
		),
	);
	fireEvent.click(screen.getByRole("checkbox"));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("offset=25"),
		),
	);
	fireEvent.click(
		screen.getByRole("button", { name: /^Playback metadata/, pressed: false }),
	);
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			"/api/library?q=Nature&archived=true&offset=0&playback=playback",
		),
	);
	expect(
		screen.getByRole("button", { name: /^Playback metadata/, pressed: true }),
	).toHaveAttribute("aria-pressed", "true");
	fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			"/api/library?q=&archived=false&offset=0&playback=all",
		),
	);
});

it("debounces searches and retains the prior page/range through refresh failure and retry", async () => {
	renderWithQuery(<LibraryClient />);
	await screen.findByRole("link", { name: /A real asset/ });
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await screen.findByText("26–26 of 26");
	let reject: (reason: Error) => void = () => {};
	apiFetch.mockImplementationOnce(
		() =>
			new Promise((_, fail) => {
				reject = fail;
			}),
	);
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "N" } });
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Nature" },
	});
	expect(apiFetch).toHaveBeenCalledTimes(2);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
	expect(
		screen.getByRole("link", { name: /A real asset/ }),
	).toBeInTheDocument();
	expect(screen.getByText("26–26 of 26")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	await act(async () => reject(new Error("Temporary read failure")));
	await screen.findByRole("alert");
	expect(
		screen.getByRole("link", { name: /A real asset/ }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
	);
	expect(apiFetch).toHaveBeenLastCalledWith(
		expect.stringContaining("q=Nature"),
	);
});

it("searches scenes with immutable selection links and preserves archive/query across modes", async () => {
	const hit = {
		contentId: "analysis",
		contentTitle: "Metadata asset",
		title: "In the forest",
		summary: "Trees and birds",
		startInSeconds: 10.5,
		endInSeconds: 25,
		contentRevision: 3,
		analysisRevisionId: "a1111111-1111-4111-8111-111111111111",
		sceneId: "b1111111-1111-4111-8111-111111111111",
		locale: "ja",
		archived: true,
	};
	apiFetch.mockImplementation(async (url) =>
		url.startsWith("/api/library/scenes")
			? ({
					items: [
						hit,
						{
							...hit,
							sceneId: "c1111111-1111-4111-8111-111111111111",
							title: " ",
						},
					],
					total: 26,
				} as unknown as LibraryCatalog)
			: response,
	);
	renderWithQuery(<LibraryClient />);
	await screen.findByRole("link", { name: /A real asset/ });
	await userEvent.click(screen.getByRole("tab", { name: "Scenes" }));
	expect(
		screen.getByText("Enter keywords to find scenes."),
	).toBeInTheDocument();
	expect(apiFetch).toHaveBeenCalledTimes(2);
	expect(
		screen.queryByRole("button", { name: /^Playback metadata/ }),
	).not.toBeInTheDocument();
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "forest" },
	});
	fireEvent.click(screen.getByRole("checkbox"));
	const link = await screen.findByRole("link", { name: /In the forest/ });
	expect(apiFetch).toHaveBeenLastCalledWith(
		"/api/library/scenes?q=forest&archived=true&offset=0&match=all&sort=relevance",
	);
	const params = new URL(link.getAttribute("href") ?? "", "http://localhost")
		.searchParams;
	expect(params.get("sceneId")).toBe(hit.sceneId);
	expect(params.get("contentRevision")).toBe("3");
	expect(params.get("analysisRevisionId")).toBe(hit.analysisRevisionId);
	expect(params.get("locale")).toBe("ja");
	expect(params.has("time")).toBe(false);
	expect(link).toHaveTextContent("0:10–0:25");
	expect(link).toHaveTextContent("Metadata asset");
	expect(
		screen.getByRole("link", { name: /Scenes · 0:10/ }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			expect.stringContaining("offset=25"),
		),
	);
	await userEvent.click(screen.getByRole("tab", { name: "Content" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			"/api/library?q=forest&archived=true&offset=0&playback=all",
		),
	);
	expect(window.location.search).toContain("q=forest");
	expect(window.location.search).toContain("archived=true");
	expect(localStorage.getItem("bitovp.library.view")).toBeNull();
});

it("keeps MP4 metadata despite a missing thumbnail and renders analysis without a large empty preview", async () => {
	apiFetch.mockResolvedValue({
		total: 2,
		counts: { all: 2, playback: 1, metadata: 1 },
		items: [
			{
				...(response.items[0] as LibraryCatalog["items"][number]),
				title: "A long MP4 job name that remains readable",
				catalogMetadata: { formats: ["MP4"] },
				catalogPreview: {
					kind: "MP4",
					url: "/api/library/sources/a1111111-1111-4111-8111-111111111111/media?key=mp4",
					time: 5,
				},
			},
			{
				...(response.items[0] as LibraryCatalog["items"][number]),
				id: "analysis",
				title: "Analysis only",
				catalogMetadata: { formats: [], duration: 60, sceneCount: 8 },
				catalogPreview: undefined,
			},
		],
	} as LibraryCatalog);
	const view = renderWithQuery(<LibraryClient />);
	await screen.findByRole("link", { name: /A long MP4/ });
	expect(screen.getByText("MP4")).toBeInTheDocument();
	expect(screen.getByTestId("thumbnail")).toHaveAttribute("data-kind", "MP4");
	expect(screen.getByText("No thumbnail")).toBeInTheDocument();
	expect(screen.getByRole("link", { name: /Analysis only/ })).toHaveTextContent(
		"No playback metadata",
	);
	expect(screen.getByRole("link", { name: /Analysis only/ })).toHaveTextContent(
		"1:00",
	);
	expect(view.container.querySelector("h2")).not.toHaveClass("line-clamp-2");
	expect(screen.getAllByTestId("thumbnail")).toHaveLength(1);
});

it("offers recovery for an empty filter and retries a failed read", async () => {
	apiFetch.mockResolvedValue({
		total: 0,
		items: [],
		counts: { all: 26, playback: 26, metadata: 0 },
	});
	renderWithQuery(<LibraryClient />);
	await screen.findByText(
		"No content yet. Completed VOD jobs are registered automatically.",
	);
	fireEvent.click(
		screen.getByRole("button", { name: /^No playback metadata/ }),
	);
	await screen.findByText("No assets match these filters.");
	expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(
		2,
	);
	apiFetch.mockRejectedValueOnce(new Error("Temporary read failure"));
	const clearButton = screen.getAllByRole("button", {
		name: "Clear filters",
	})[0];
	if (!clearButton) throw new Error("Clear filter button missing");
	fireEvent.click(clearButton);
	await screen.findByRole("alert");
	apiFetch.mockResolvedValue(response);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(
		await screen.findByRole("link", { name: /A real asset/ }),
	).toBeInTheDocument();
});

it("restores a shared URL browse context and the browser's list preference", async () => {
	localStorage.setItem("bitovp.library.view", "list");
	const view = renderWithQuery(
		<LibraryClient
			initialQuery={{
				q: "Nature",
				archived: true,
				playback: "metadata",
				mode: "content",
				offset: 25,
			}}
		/>,
	);
	await screen.findByRole("link", { name: /A real asset/ });
	expect(apiFetch).toHaveBeenLastCalledWith(
		"/api/library?q=Nature&archived=true&offset=25&playback=metadata",
	);
	expect(screen.getByRole("searchbox")).toHaveValue("Nature");
	expect(screen.getByRole("checkbox")).toBeChecked();
	expect(screen.getByText("26–26 of 26")).toBeInTheDocument();
	expect(view.container.querySelector("ul")).not.toHaveClass("grid");
	expect(window.location.search).toContain("offset=25");
});

it("dismisses an obsolete read error immediately when a different search is entered", async () => {
	apiFetch.mockRejectedValueOnce(new Error("Previous query failed"));
	renderWithQuery(<LibraryClient />);
	await screen.findByRole("alert");
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "New query" },
	});
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	await screen.findByRole("link", { name: /A real asset/ });
});

it("does not let a late abandoned search replace a newer successful result", async () => {
	const pending = new Map<string, (data: LibraryCatalog) => void>();
	apiFetch.mockImplementation((url) => {
		const q = new URL(url, "http://localhost").searchParams.get("q");
		return q
			? new Promise((resolve) => pending.set(q, resolve))
			: Promise.resolve(response);
	});
	renderWithQuery(<LibraryClient />);
	await screen.findByRole("link", { name: /A real asset/ });
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "older" },
	});
	await waitFor(() => expect(pending.has("older")).toBe(true));
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "newer" },
	});
	await waitFor(() => expect(pending.has("newer")).toBe(true));
	await act(async () =>
		pending.get("newer")?.({
			...response,
			items: response.items.map((item) => ({ ...item, title: "New result" })),
		}),
	);
	await screen.findByRole("link", { name: /New result/ });
	await act(async () =>
		pending.get("older")?.({
			...response,
			items: response.items.map((item) => ({
				...item,
				title: "Obsolete result",
			})),
		}),
	);
	expect(
		screen.queryByRole("link", { name: /Obsolete result/ }),
	).not.toBeInTheDocument();
	expect(screen.getByRole("link", { name: /New result/ })).toBeInTheDocument();
});
