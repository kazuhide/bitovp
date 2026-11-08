import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { EditingProjectSummary } from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import { ClipProjects } from "./clip-projects";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function project(id: string): EditingProjectSummary {
	return {
		id,
		contentId: "source",
		title: `Alternative ${id}`,
		variant: "PORTRAIT",
		archived: false,
		updatedAt: "2026-11-05T01:00:00Z",
		draftRevision: 3,
		currentRevisionId: "revision",
		currentRevisionMatchesDraft: true,
		durationFrames: 900,
		fps: { num: 30, den: 1 },
		latestExport: null,
		latestSuccessfulExport: null,
	};
}

beforeEach(() => apiFetch.mockReset());

it("allows an explicit stored-results view without editor or creation admission", async () => {
	apiFetch.mockResolvedValue({
		items: [project("saved")],
		total: 1,
		offset: 0,
	});
	renderWithQuery(<ClipProjects contentId="source" readOnly />);
	expect(
		await screen.findByRole("link", { name: "Alternative saved" }),
	).toHaveAttribute("href", "/library/edits/saved/result");
	expect(
		screen.queryByRole("link", { name: "Create another clip" }),
	).not.toBeInTheDocument();
});

it.each([
	undefined,
	false,
])("does not read or reveal cached drafts when availability is %s", (clipEditingAvailable) => {
	const view = renderWithQuery(<div />);
	view.client.setQueryData(["library-edit-projects", "source", 0], {
		items: [project("cached")],
		total: 1,
		offset: 0,
	});
	view.rerender(
		<ClipProjects
			contentId="source"
			clipEditingAvailable={clipEditingAvailable}
		/>,
	);
	expect(screen.queryByRole("region", { name: "Clip drafts" })).toBeNull();
	expect(screen.queryByRole("link")).toBeNull();
	expect(apiFetch).not.toHaveBeenCalled();
});

it("shows one draft thumbnail and editor link per alternative without export controls or history", async () => {
	const first = project("one");
	first.latestExport = {
		id: "failed-run",
		revisionId: "new-revision",
		generation: 2,
		state: "FAILED",
		durationFrames: 900,
		finishedAt: null,
		matchesCurrentDraft: false,
		artifact: null,
	};
	first.latestSuccessfulExport = {
		...first.latestExport,
		id: "success-run",
		revisionId: "old-revision",
		generation: 1,
		state: "SUCCEEDED",
		finishedAt: "2026-11-04T01:00:00Z",
		artifact: {
			id: "artifact",
			url: "/api/library/artifacts/artifact/media?expectedOrganizationId=org",
			downloadUrl:
				"/api/library/artifacts/artifact/download?expectedOrganizationId=org",
			derivedContentId: "derived",
		},
	};
	first.thumbnail = {
		url: "/thumb",
		cacheKey: "draft-key",
		draftRevision: 3,
		width: 1080,
		height: 1920,
	};
	apiFetch.mockResolvedValue({
		items: [first, project("two")],
		total: 2,
		offset: 0,
	});
	renderWithQuery(<ClipProjects contentId="source" clipEditingAvailable />);
	const section = await screen.findByRole("region", { name: "Clip drafts" });
	await within(section).findByRole("link", { name: "Alternative one" });
	expect(within(section).getAllByRole("heading", { level: 3 })).toHaveLength(2);
	expect(
		within(section).getByRole("link", { name: "Alternative one" }),
	).toHaveAttribute("href", "/library/edits/one");
	expect(
		within(section).getByRole("link", { name: "Alternative two" }),
	).toHaveAttribute("href", "/library/edits/two");
	expect(within(section).queryByText("Failed")).not.toBeInTheDocument();
	expect(
		within(section).queryByText("Earlier version"),
	).not.toBeInTheDocument();
	expect(
		within(section).queryByRole("link", { name: "Watch export" }),
	).not.toBeInTheDocument();
	expect(
		within(section).queryByRole("link", { name: "Download MP4" }),
	).not.toBeInTheDocument();
	for (const row of within(section).getAllByRole("listitem")) {
		expect(within(row).getAllByRole("link")).toHaveLength(1);
		expect(row.querySelector("time")).toBeNull();
		expect(row.querySelector("[data-clip-thumbnail]")).not.toBeNull();
	}
	expect(
		within(section).getByRole("link", { name: "Create another clip" }),
	).toHaveAttribute("href", "/library/source/edits");
});

it("paginates all alternatives under the same source without a generation request", async () => {
	apiFetch.mockImplementation(async (url: string) => {
		const offset = Number(
			new URL(url, "http://local").searchParams.get("offset"),
		);
		return { items: [project(String(offset))], offset, total: 26 };
	});
	renderWithQuery(<ClipProjects contentId="source" clipEditingAvailable />);
	await screen.findByRole("link", { name: "Alternative 0" });
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await screen.findByRole("link", { name: "Alternative 25" });
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled(),
	);
	expect(
		apiFetch.mock.calls.every(
			([url, options]) => url.includes("contentId=source") && !options.method,
		),
	).toBe(true);
});

it("shows a recoverable error instead of an empty list when alternatives could not be loaded", async () => {
	apiFetch.mockRejectedValueOnce(new Error("unavailable"));
	renderWithQuery(<ClipProjects contentId="source" clipEditingAvailable />);
	await screen.findByRole("alert");
	expect(screen.queryByText("No clip drafts yet.")).not.toBeInTheDocument();
	apiFetch.mockResolvedValue({ items: [], total: 0, offset: 0 });
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await screen.findByText("No clip drafts yet.");
});

it("keeps the draft link as the only row action while an export is preparing", async () => {
	const draft = project("one");
	draft.latestExport = {
		id: "run",
		revisionId: "revision",
		generation: 1,
		state: "PREPARING",
		durationFrames: 900,
		finishedAt: null,
		matchesCurrentDraft: true,
		artifact: null,
	};
	apiFetch.mockResolvedValue({ items: [draft], total: 1, offset: 0 });
	renderWithQuery(<ClipProjects contentId="source" clipEditingAvailable />);
	await screen.findByRole("link", { name: "Alternative one" });
	expect(screen.queryByText("Preparing material")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("link", { name: "Watch export" }),
	).not.toBeInTheDocument();
	expect(
		within(screen.getByRole("listitem")).getAllByRole("link"),
	).toHaveLength(1);
});

it("reads new alternatives when returning while the production cache is still fresh", async () => {
	const view = renderWithQuery(<div />);
	view.client.setDefaultOptions({
		queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: false },
	});
	view.client.setQueryData(["library-edit-projects", "source", 0], {
		items: [project("old")],
		total: 1,
		offset: 0,
	});
	apiFetch.mockResolvedValue({
		items: [project("new"), project("old")],
		total: 2,
		offset: 0,
	});
	view.rerender(<ClipProjects contentId="source" clipEditingAvailable />);
	await waitFor(
		() =>
			expect(
				screen.getByRole("link", { name: "Alternative new" }),
			).toBeVisible(),
		{ timeout: 200 },
	);
});
