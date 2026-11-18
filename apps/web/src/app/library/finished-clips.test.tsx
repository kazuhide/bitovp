import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import type {
	EditingProjectPage,
	EditingProjectSummary,
	StoredEditingExport,
} from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import { StoredClipResult } from "./edits/[id]/result/stored-clip-result";
import { FinishedClips } from "./finished-clips";

const calls = vi.hoisted(() => ({ api: vi.fn(), canEdit: false }));
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	apiFetch: calls.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => calls.canEdit,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

const id = (suffix: number) =>
	`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const contentId = id(1);
const org = id(2);
function exported(index: number, title: string, earlierVersion = false) {
	const artifactId = id(index + 10);
	const base = `/api/library/artifacts/${artifactId}`;
	return {
		projectId: id(index + 20),
		contentId,
		title,
		earlierVersion,
		purpose: earlierVersion ? "TRAILER" : "HIGHLIGHT",
		render: {
			id: id(index + 30),
			revisionId: id(index + 40),
			generation: 1,
			state: "SUCCEEDED",
			kind: "EXPORT",
			error: null,
			durationFrames: 900,
			artifact: {
				id: artifactId,
				url: `${base}/media?expectedOrganizationId=${org}`,
				downloadUrl: `${base}/download?expectedOrganizationId=${org}`,
				derivedContentId: null,
			},
		},
	} satisfies StoredEditingExport;
}

function project(result: ReturnType<typeof exported>): EditingProjectSummary {
	const success = {
		...result.render,
		finishedAt: "2026-11-18T00:00:00Z",
		purpose: result.purpose,
		matchesCurrentDraft: !result.earlierVersion,
	};
	return {
		id: result.projectId,
		title: result.title,
		contentId,
		durationFrames: result.render.durationFrames,
		fps: { num: 30, den: 1 },
		variant: "LANDSCAPE",
		archived: false,
		updatedAt: "2026-11-18T00:00:00Z",
		draftRevision: 1,
		currentRevisionId: result.render.revisionId,
		currentRevisionMatchesDraft: !result.earlierVersion,
		latestExport: result.earlierVersion
			? { ...success, id: id(999), state: "FAILED", artifact: null }
			: success,
		latestSuccessfulExport: success,
	};
}

beforeEach(() => {
	calls.api.mockReset();
	calls.canEdit = false;
});

it("renders one click-ready player and its result link in each clip card", async () => {
	const trailer = exported(1, "Episode teaser", true);
	const highlight = exported(2, "Opening moments");
	calls.api.mockResolvedValue({
		items: [project(trailer), project(highlight)],
		offset: 0,
		total: 2,
	});
	const { container } = renderWithQuery(
		<DocumentOrganizationContext.Provider value={org}>
			<FinishedClips contentId={contentId} />
		</DocumentOrganizationContext.Provider>,
	);
	const shelf = await screen.findByRole("complementary", {
		name: "Clips",
	});
	const [first, second] = within(shelf).getAllByRole("listitem");
	if (!first || !second) throw new Error("Expected both exported clips");
	expect(first).toHaveTextContent("Trailer · 30.0s");
	expect(first).toHaveTextContent("Earlier version");
	expect(second).toHaveTextContent("Highlight · 30.0s");
	expect(container.querySelectorAll("video")).toHaveLength(2);
	expect(calls.api.mock.calls[0]?.[0]).toContain("scope=exports");

	for (const [card, result] of [
		[first, trailer],
		[second, highlight],
	] as const) {
		const video = within(card).getByLabelText(result.title);
		expect(video.tagName).toBe("VIDEO");
		expect(video).toHaveAttribute("controls");
		expect(video).toHaveAttribute("preload", "none");
		expect(video).not.toHaveAttribute("autoplay");
		expect(video).toHaveAttribute("src", result.render.artifact.url);
		expect(
			within(card).getByRole("link", { name: "Watch export" }),
		).toHaveAttribute(
			"href",
			`/library/edits/${result.projectId}/result?exportId=${result.render.id}`,
		);
	}
	const splitter = within(shelf).getByRole("separator", {
		name: "Resize clips panel",
	});
	const initialWidth = Number(splitter.getAttribute("aria-valuenow"));
	fireEvent.keyDown(splitter, { key: "ArrowLeft" });
	expect(Number(splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(
		initialWidth,
	);
	fireEvent.keyDown(splitter, { key: "End" });
	expect(splitter.getAttribute("aria-valuenow")).toBe(
		splitter.getAttribute("aria-valuemax"),
	);
	fireEvent.keyDown(splitter, { key: "Home" });
	expect(splitter.getAttribute("aria-valuenow")).toBe(
		splitter.getAttribute("aria-valuemin"),
	);
});

it("keeps both players mounted when the clips divider is dragged or cancelled", async () => {
	const result = exported(1, "Episode teaser", true);
	calls.api.mockResolvedValue({
		items: [project(result)],
		offset: 0,
		total: 1,
	});
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={org}>
			<FinishedClips contentId={contentId}>
				<p>Source player</p>
			</FinishedClips>
		</DocumentOrganizationContext.Provider>,
		"ja",
	);
	const shelf = await screen.findByRole("complementary", {
		name: "クリップ映像",
	});
	const splitter = within(shelf).getByRole("separator", {
		name: "クリップ映像欄の幅を調整",
	});
	const exportedVideo = within(shelf).getByLabelText(result.title);
	const sourcePlayer = screen.getByText("Source player");
	const captured = new Set<number>();
	Object.assign(splitter, {
		setPointerCapture: (id: number) => captured.add(id),
		hasPointerCapture: (id: number) => captured.has(id),
		releasePointerCapture: (id: number) => captured.delete(id),
	});
	const pointer = { pointerId: 1, isPrimary: true, button: 0 };
	const initialWidth = Number(splitter.getAttribute("aria-valuenow"));
	fireEvent.pointerDown(splitter, { ...pointer, clientX: 600 });
	fireEvent.pointerMove(splitter, { ...pointer, clientX: 550 });
	expect(splitter).toHaveAttribute("aria-valuenow", String(initialWidth + 50));
	fireEvent.keyDown(splitter, { key: "Escape" });
	expect(splitter).toHaveAttribute("aria-valuenow", String(initialWidth));
	expect(captured.size).toBe(0);

	fireEvent.pointerDown(splitter, { ...pointer, clientX: 600 });
	fireEvent.pointerMove(splitter, { ...pointer, pointerId: 2, clientX: 690 });
	expect(splitter).toHaveAttribute("aria-valuenow", String(initialWidth));
	fireEvent.pointerUp(splitter, { ...pointer, clientX: 100 });
	expect(splitter.getAttribute("aria-valuenow")).toBe(
		splitter.getAttribute("aria-valuemax"),
	);
	expect(captured.size).toBe(0);
	expect(within(shelf).getByLabelText(result.title)).toBe(exportedVideo);
	expect(screen.getByText("Source player")).toBe(sourcePlayer);
});

it("keeps empty clips in the main flow and offers the existing editing entry", async () => {
	calls.canEdit = true;
	calls.api.mockResolvedValue({ items: [], offset: 0, total: 0 });
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={org}>
			<FinishedClips contentId={contentId} canCreate>
				<p>Source player</p>
			</FinishedClips>
		</DocumentOrganizationContext.Provider>,
	);
	expect(
		await screen.findByRole("link", { name: "Create a clip" }),
	).toHaveAttribute("href", `/library/${contentId}/edits`);
	expect(screen.getByText("Source player")).toBeVisible();
	expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
	expect(screen.queryByRole("separator")).not.toBeInTheDocument();
});

it("does not offer clip creation in an empty shelf without edit access", async () => {
	calls.api.mockResolvedValue({ items: [], offset: 0, total: 0 });
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={org}>
			<FinishedClips contentId={contentId} canCreate />
		</DocumentOrganizationContext.Provider>,
	);
	expect(await screen.findByText("No clips yet.")).toBeVisible();
	expect(
		screen.queryByRole("link", { name: "Create a clip" }),
	).not.toBeInTheDocument();
	expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("follows an anchored shelf when the first export replaces cached empty results", async () => {
	const scroll = vi.fn();
	const originalScroll = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"scrollIntoView",
	);
	const originalUrl = window.location.href;
	const historyState = window.history.state;
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: scroll,
	});
	try {
		window.history.replaceState(null, "", "#finished-clips");
		const response = Promise.withResolvers<EditingProjectPage>();
		const next = exported(2, "Second page clip");
		calls.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({
			items: [project(next)],
			offset: 25,
			total: 26,
		});
		const { client, rerender } = renderWithQuery(null);
		client.setQueryData(
			["library-edit-projects", contentId, "exports", org, 0],
			{
				items: [],
				offset: 0,
				total: 0,
			},
		);
		rerender(
			<DocumentOrganizationContext.Provider value={org}>
				<FinishedClips contentId={contentId}>
					<p>Source player</p>
				</FinishedClips>
			</DocumentOrganizationContext.Provider>,
		);
		const empty = screen.getByRole("region", { name: "Clips" });
		expect(scroll.mock.contexts).toEqual([empty]);

		const first = exported(1, "First export");
		await act(async () => {
			response.resolve({ items: [project(first)], offset: 0, total: 26 });
		});
		const shelf = await screen.findByRole("complementary", { name: "Clips" });
		expect(scroll.mock.contexts).toEqual([empty, shelf]);

		fireEvent.click(within(shelf).getByRole("button", { name: "Next" }));
		await within(shelf).findByRole("heading", { name: next.title });
		expect(scroll.mock.contexts).toEqual([empty, shelf]);
	} finally {
		if (originalScroll)
			Object.defineProperty(
				HTMLElement.prototype,
				"scrollIntoView",
				originalScroll,
			);
		else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		window.history.replaceState(historyState, "", originalUrl);
	}
});

it("shows the pinned output and download in read-only mode", async () => {
	const result = exported(1, "Episode teaser", true);
	calls.api.mockResolvedValue(result);
	const { container } = renderWithQuery(
		<DocumentOrganizationContext.Provider value={org}>
			<StoredClipResult
				id={result.projectId}
				exportId={result.render.id}
				clipEditingAvailable={false}
			/>
		</DocumentOrganizationContext.Provider>,
	);
	await screen.findByRole("heading", { name: "Episode teaser" });
	expect(screen.getByText("Earlier version")).toBeVisible();
	expect(container.querySelector("video")).toHaveAttribute(
		"src",
		result.render.artifact.url,
	);
	expect(screen.getByRole("link", { name: "Download MP4" })).toHaveAttribute(
		"href",
		result.render.artifact.downloadUrl,
	);
	expect(
		screen.getByRole("link", { name: "Generation history" }),
	).toHaveAttribute("href", `/library/edits/${result.projectId}`);
	expect(calls.api).toHaveBeenCalledExactlyOnceWith(
		`/api/library/edits/${result.projectId}?exportId=${result.render.id}`,
		expect.objectContaining({ signal: expect.any(AbortSignal) }),
	);
});

it("does not play an export returned under a different document organization", async () => {
	const result = exported(1, "Episode teaser", true);
	calls.api.mockResolvedValue(result);
	const { container } = renderWithQuery(
		<DocumentOrganizationContext.Provider value={id(3)}>
			<StoredClipResult
				id={result.projectId}
				exportId={result.render.id}
				clipEditingAvailable
			/>
		</DocumentOrganizationContext.Provider>,
	);
	await screen.findByRole("alert");
	expect(container.querySelector("video")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("link", { name: "Download MP4" }),
	).not.toBeInTheDocument();
});
