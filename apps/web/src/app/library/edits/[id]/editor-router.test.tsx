import { toCompositionDocument } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { EditorRouter } from "./editor-router";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({ plan }: { plan: { durationFrames: number } }) => (
		<output aria-label="Preview duration">{plan.durationFrames}</output>
	),
}));
beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue(editingProjectFixture());
	window.sessionStorage.clear();
});

it("clears only the accepted re-edit belonging to the open draft and organization", async () => {
	const project = editingProjectFixture();
	const organizationId = "00000000-0000-4000-8000-000000000004";
	const otherOrganizationId = "00000000-0000-4000-8000-000000000005";
	const sourceId = "00000000-0000-4000-8000-000000000006";
	const exportId = "00000000-0000-4000-8000-000000000007";
	const otherExportId = "00000000-0000-4000-8000-000000000008";
	const storageKey = `bitovp:library:reedit:${organizationId}:${sourceId}:${exportId}`;
	const foreignKey = `bitovp:library:reedit:${otherOrganizationId}:${sourceId}:${exportId}`;
	const pendingKey = `bitovp:library:reedit:${organizationId}:${sourceId}:${otherExportId}`;
	const pending = {
		title: "Clip",
		requestKey: "00000000-0000-4000-8000-000000000009",
	};
	const accepted = JSON.stringify({
		...pending,
		created: { id: project.id, contentId: project.contentId },
	});
	window.sessionStorage.setItem(storageKey, accepted);
	window.sessionStorage.setItem(foreignKey, accepted);
	window.sessionStorage.setItem(pendingKey, JSON.stringify(pending));
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={organizationId}>
			<EditorRouter id={project.id} />
		</DocumentOrganizationContext.Provider>,
	);
	await screen.findByRole("heading", { name: project.title });
	await waitFor(() =>
		expect(window.sessionStorage.getItem(storageKey)).toBeNull(),
	);
	expect(window.sessionStorage.getItem(foreignKey)).toBe(accepted);
	expect(window.sessionStorage.getItem(pendingKey)).not.toBeNull();
});
it.each([
	false,
	true,
])("cannot discard a legacy %s applied edit when opening composition tools", async (applied) => {
	renderWithQuery(<EditorRouter id={editingProjectFixture().id} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	const upgrade = screen.getByRole("button", {
		name: "Open composition tools",
	});
	await waitFor(() => expect(upgrade).toBeEnabled());
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "9" },
	});
	if (applied)
		fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	expect(upgrade).toBeDisabled();
	fireEvent.click(upgrade);
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
	expect(screen.getByLabelText("Out (seconds)")).toHaveValue(9);
});
it("keeps an unsaved legacy edit mounted when a background refresh temporarily fails", async () => {
	const project = editingProjectFixture();
	const view = renderWithQuery(<EditorRouter id={project.id} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "9" },
	});
	apiFetch.mockRejectedValue(new ApiError(503, "Temporary unavailable"));
	await view.client.invalidateQueries({
		queryKey: ["library-edit", project.id],
	});
	await screen.findByRole("alert");
	expect(screen.getByLabelText("Out (seconds)")).toHaveValue(9);
	expect(
		screen.getByRole("button", { name: "Open composition tools" }),
	).toBeDisabled();
	apiFetch.mockResolvedValue(project);
	fireEvent.click(screen.getByRole("button", { name: "Reload" }));
	await waitFor(() =>
		expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
	);
	expect(screen.getByLabelText("Out (seconds)")).toHaveValue(9);
});
it("keeps pending legacy changes after another tab upgrades, then retains them in composition Undo", async () => {
	const original = editingProjectFixture();
	const view = renderWithQuery(<EditorRouter id={original.id} />);
	await screen.findByRole("heading", { name: original.title });
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "9" },
	});
	if (!original.media.timeMap) throw new Error("Missing time map");
	const remote = {
		...original,
		draft: toCompositionDocument(original.draft),
		draftRevision: 2,
		compositionSources: [
			{
				mediaVersionId: original.media.id,
				timeMap: original.media.timeMap,
				width: 1920,
				height: 1080,
				hasAudio: true,
			},
		],
	};
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/library/editing-media" ? { media: [] } : remote,
	);
	await view.client.invalidateQueries({
		queryKey: ["library-edit", original.id],
	});
	expect(
		await screen.findByRole("button", { name: "Load saved draft" }),
	).toBeDisabled();
	expect(screen.getByLabelText("Out (seconds)")).toHaveValue(9);
	fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Load saved draft" }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("300");
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("270");
});
