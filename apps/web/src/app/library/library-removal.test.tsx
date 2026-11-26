import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryCatalog } from "@/lib/library-catalog";
import { renderWithQuery } from "@/test/render";

let archived = false;
const content = {
	id: "b1111111-1111-4111-8111-111111111111",
	title: "Library removal fixture",
	description: "",
	tags: [],
	locale: "en",
	revision: 1,
	archived: false,
	updatedAt: "2026-11-13T00:00:00Z",
	catalogMetadata: { formats: ["HLS" as const], duration: 120 },
};
const apiFetch = vi.fn(
	async (url: string, init?: RequestInit): Promise<unknown> => {
		if (init?.method === "PATCH") {
			archived = JSON.parse(String(init.body)).archived;
			return { ...content, archived, revision: archived ? 2 : 3 };
		}
		const params = new URL(url, "http://localhost").searchParams;
		const visible = archived === (params.get("archived") === "true");
		const catalog: LibraryCatalog = {
			items: visible
				? [{ ...content, archived, revision: archived ? 2 : 1 }]
				: [],
			total: visible ? 1 : 0,
			counts: { all: visible ? 1 : 0, playback: visible ? 1 : 0, metadata: 0 },
		};
		return catalog;
	},
);
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: (...args: Parameters<typeof apiFetch>) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("./catalog-thumbnail", () => ({
	CatalogThumbnail: () => <span>Preview</span>,
}));

import { LibraryClient } from "./library-client";

beforeEach(() => {
	archived = false;
	apiFetch.mockClear();
	localStorage.clear();
	window.history.replaceState(null, "", "/library");
});

it.each([
	"grid",
	"list",
])("removes and restores from the %s catalog without a GPU or local model", async (view) => {
	localStorage.setItem("bitovp.library.view", view);
	const rendered = renderWithQuery(
		<LibraryClient clipEditingAvailable={false} />,
	);
	const link = await screen.findByRole("link", {
		name: /Library removal fixture/,
	});
	const remove = screen.getByRole("button", {
		name: /Remove from Library: Library removal fixture/,
	});
	expect(link.contains(remove)).toBe(false);
	expect(rendered.container.querySelector("a button")).toBeNull();
	fireEvent.click(remove);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "Remove from Library",
		}),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("link", { name: /Library removal fixture/ }),
		).not.toBeInTheDocument(),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Archived content" }));
	await screen.findByRole("link", { name: /Library removal fixture/ });
	fireEvent.click(
		screen.getByRole("button", {
			name: "Restore to Library: Library removal fixture",
		}),
	);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("link", { name: /Library removal fixture/ }),
		).not.toBeInTheDocument(),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Archived content" }));
	await screen.findByRole("link", { name: /Library removal fixture/ });
	expect(
		apiFetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
	).toEqual([
		[
			`/api/library/${content.id}`,
			{
				method: "PATCH",
				body: JSON.stringify({ expectedRevision: 1, archived: true }),
			},
		],
		[
			`/api/library/${content.id}`,
			{
				method: "PATCH",
				body: JSON.stringify({ expectedRevision: 2, archived: false }),
			},
		],
	]);
});

it("returns to the first page after removing the last row and preserves search and view", async () => {
	localStorage.setItem("bitovp.library.view", "list");
	renderWithQuery(
		<LibraryClient
			initialQuery={{
				q: "fixture",
				archived: false,
				playback: "all",
				mode: "content",
				offset: 25,
			}}
		/>,
	);
	await screen.findByRole("link", { name: /Library removal fixture/ });
	fireEvent.click(
		screen.getByRole("button", {
			name: "Remove from Library: Library removal fixture",
		}),
	);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "Remove from Library",
		}),
	);
	await waitFor(() =>
		expect(
			new URLSearchParams(window.location.search).get("offset"),
		).toBeNull(),
	);
	expect(new URLSearchParams(window.location.search).get("q")).toBe("fixture");
	expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(
		apiFetch.mock.calls.some(([url]) =>
			url.includes("q=fixture&archived=false&offset=0"),
		),
	).toBe(true);
});
