import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { GenerationHistory as History } from "@/lib/library-generation-history";
import { renderWithQuery } from "@/test/render";
import { GenerationHistory } from "./generation-history";

const runningId = "ad6153cb-540c-4df2-bae8-3fce02768490";
const succeededId = "9d0a30c9-5b62-4f41-929c-8466bf4c7681";
const projectId = "8f10e411-67d4-452a-a93d-ba099cc2853b";
const exportId = "f765c4f8-3d38-4b60-a370-c611d0d8a26c";
const response: History = {
	items: [
		{
			taskId: runningId,
			state: "RUNNING",
			contentTitle: "Sol Levante",
			updatedAt: "2026-11-18T13:50:00.000Z",
			clips: [],
		},
		{
			taskId: succeededId,
			state: "SUCCEEDED",
			contentTitle: "Meridian",
			updatedAt: "2026-11-18T13:48:00.000Z",
			clips: [{ projectId, exportId, title: "Meridian teaser" }],
		},
	],
	hasMore: false,
};
const apiFetch = vi.fn(async (_url: string) => response);
vi.mock("@/lib/api", () => ({ apiFetch: (url: string) => apiFetch(url) }));

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue(response);
	window.history.replaceState(null, "", "/library/generations");
});

it("opens active progress and a pinned export after loading durable history", async () => {
	renderWithQuery(
		<GenerationHistory
			initialFilters={{ q: "", offset: 0, state: "", period: "" }}
			clipEditingAvailable={false}
		/>,
	);
	expect(
		await screen.findByRole("link", { name: "View progress" }),
	).toHaveAttribute("href", `/library/generations/${runningId}?view=details`);
	expect(screen.getByRole("link", { name: "View job" })).toHaveAttribute(
		"href",
		`/library/generations/${succeededId}?view=details`,
	);
	expect(screen.getByText("Sol Levante")).toBeVisible();
	expect(
		within(screen.getByRole("list", { name: "Generation history" })).getByText(
			"Running",
		),
	).toBeVisible();
	expect(screen.getByText("Meridian")).toBeVisible();
	expect(
		screen.getByRole("link", { name: /View export.*Meridian teaser/ }),
	).toHaveAttribute(
		"href",
		`/library/edits/${projectId}/result?exportId=${exportId}`,
	);
});

it("restores URL search/filter state and resets pagination on filter edits", async () => {
	renderWithQuery(
		<GenerationHistory
			initialFilters={{
				q: "Sol",
				offset: 25,
				state: "RUNNING",
				period: "week",
			}}
			clipEditingAvailable
		/>,
	);
	await screen.findByText("Sol Levante");
	expect(apiFetch.mock.calls[0]?.[0]).toBe(
		"/api/library/media-tasks?view=history&q=Sol&state=RUNNING&period=week&offset=25",
	);
	expect(screen.getByRole("searchbox", { name: "Content title" })).toHaveValue(
		"Sol",
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
		target: { value: "ERROR" },
	});
	await waitFor(() =>
		expect(apiFetch).toHaveBeenLastCalledWith(
			"/api/library/media-tasks?view=history&q=Sol&state=ERROR&period=week",
		),
	);
	expect(window.location.search).toBe("?q=Sol&state=ERROR&period=week");
});

it("refreshes a recently cached empty history when the user returns", async () => {
	const { client, rerender } = renderWithQuery(null);
	client.setDefaultOptions({ queries: { staleTime: 15_000, retry: false } });
	client.setQueryData(
		["library-generation-history", undefined, "view=history"],
		{
			items: [],
			hasMore: false,
		},
	);
	rerender(
		<GenerationHistory
			initialFilters={{ q: "", offset: 0, state: "", period: "" }}
			clipEditingAvailable
		/>,
	);
	expect(await screen.findByText("Sol Levante")).toBeVisible();
});
