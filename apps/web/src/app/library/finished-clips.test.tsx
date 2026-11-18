import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import type {
	EditingProjectSummary,
	StoredEditingExport,
} from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import { StoredClipResult } from "./edits/[id]/result/stored-clip-result";
import { FinishedClips } from "./finished-clips";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	apiFetch: calls.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => false,
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

beforeEach(() => calls.api.mockReset());

it("offers titled results in one shelf and loads just the selected export video", async () => {
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
		name: "Finished clips",
	});
	const first = await within(shelf).findByRole("button", {
		name: "Preview Episode teaser",
	});
	const second = within(shelf).getByRole("button", {
		name: "Preview Opening moments",
	});
	expect(first).toHaveTextContent("Trailer · 30.0s");
	expect(first).toHaveTextContent("Earlier version");
	expect(second).toHaveTextContent("Highlight · 30.0s");
	expect(container.querySelectorAll("video")).toHaveLength(0);
	expect(calls.api.mock.calls[0]?.[0]).toContain("scope=exports");

	fireEvent.click(first);
	expect(first).toHaveAttribute("aria-pressed", "true");
	expect(container.querySelector("video")).toHaveAttribute("autoplay");
	expect(container.querySelector("video")).toHaveAttribute(
		"src",
		trailer.render.artifact.url,
	);
	expect(
		within(shelf).getByRole("link", { name: "Watch export" }),
	).toHaveAttribute(
		"href",
		`/library/edits/${trailer.projectId}/result?exportId=${trailer.render.id}`,
	);

	fireEvent.click(second);
	expect(first).toHaveAttribute("aria-pressed", "false");
	expect(second).toHaveAttribute("aria-pressed", "true");
	expect(container.querySelectorAll("video")).toHaveLength(1);
	expect(container.querySelector("video")).toHaveAttribute(
		"src",
		highlight.render.artifact.url,
	);
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
