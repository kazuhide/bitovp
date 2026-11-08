import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AnyEditingProjectView } from "@/lib/library-editing";

const state = vi.hoisted(() => ({
	canMutate: true,
	project: null as unknown as AnyEditingProjectView,
	api: vi.fn(),
	refetch: vi.fn(),
	queryFn: null as
		| null
		| ((input: { signal: AbortSignal }) => Promise<unknown>),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => state.canMutate,
}));
vi.mock("@/lib/i18n/context", () => ({
	useT: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	apiFetch: state.api,
}));
vi.mock("./editor-workbench", () => ({
	EditorWorkbench: () => {
		throw new Error("History must not mount mutation/inference workbench");
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: {
		queryFn: (input: { signal: AbortSignal }) => Promise<unknown>;
	}) => {
		state.queryFn = options.queryFn;
		return { data: state.project, error: null, refetch: state.refetch };
	},
	useQueryClient: () => ({
		cancelQueries: async () => {},
		setQueryData: vi.fn(),
	}),
}));

import { EditorClient } from "./editor-client";

function project(schemaVersion: 1 | 2): AnyEditingProjectView {
	return {
		id: "project",
		title: "Saved clip",
		contentId: "content",
		currentRevisionId: "revision",
		draftRevision: 1,
		currentRevisionMatchesDraft: true,
		draft: { schemaVersion, clips: [] },
		renders: [
			{
				id: "active-preview",
				kind: "PREVIEW",
				state: "RENDERING",
				revisionId: "revision",
				generation: 4,
			},
			{
				id: "active-export",
				kind: "EXPORT",
				state: "QUEUED",
				revisionId: "revision",
				generation: 3,
			},
			{
				id: "saved-preview",
				kind: "PREVIEW",
				state: "SUCCEEDED",
				revisionId: "old-revision",
				generation: 2,
				artifact: { url: "/stored/preview", downloadUrl: "/download/preview" },
			},
			{
				id: "saved-export",
				kind: "EXPORT",
				state: "SUCCEEDED",
				revisionId: "old-revision",
				generation: 1,
				artifact: { url: "/stored/export", downloadUrl: "/download/export" },
			},
		],
	} as unknown as AnyEditingProjectView;
}
beforeEach(() => {
	state.canMutate = true;
	state.project = project(2);
	state.api
		.mockReset()
		.mockImplementation(async (url: string) =>
			url.endsWith("/cancel")
				? { id: url.split("/").at(-2), state: "CANCEL_REQUESTED" }
				: state.project,
		);
	state.refetch.mockReset().mockResolvedValue(undefined);
});

it.each([
	1, 2,
] as const)("retains all stored preview/export history for schema%s while hiding new-work actions", async (version) => {
	state.project = project(version);
	render(<EditorClient id="project" historyOnly />);
	expect(
		await screen.findByRole("heading", { name: "Saved clip" }),
	).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "editing.preview" })).toHaveAttribute(
		"href",
		"/download/preview",
	);
	expect(screen.getByRole("link", { name: "editing.export" })).toHaveAttribute(
		"href",
		"/download/export",
	);
	expect(
		screen.queryByRole("button", { name: "editing.previewAction" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "editing.export" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "editing.saveDraft" }),
	).not.toBeInTheDocument();
	expect(state.api).not.toHaveBeenCalled();
});

it("cancels each exact owned PREVIEW/EXPORT run while new rendering is disabled", async () => {
	render(<EditorClient id="project" historyOnly />);
	const buttons = screen.getAllByRole("button", { name: "editing.cancel" });
	expect(buttons).toHaveLength(2);
	const [previewCancel, exportCancel] = buttons;
	if (!previewCancel || !exportCancel)
		throw new Error("Expected both owned render cancellation controls");
	fireEvent.click(previewCancel);
	await waitFor(() =>
		expect(state.api).toHaveBeenCalledWith(
			"/api/library/renders/active-preview/cancel",
			{ method: "POST", body: "{}" },
		),
	);
	await waitFor(() => expect(exportCancel).not.toBeDisabled());
	fireEvent.click(exportCancel);
	await waitFor(() =>
		expect(state.api).toHaveBeenCalledWith(
			"/api/library/renders/active-export/cancel",
			{ method: "POST", body: "{}" },
		),
	);
	expect(
		state.api.mock.calls.every(([url]) => String(url).endsWith("/cancel")),
	).toBe(true);
});

it("keeps viewer history readable without granting cancellation", () => {
	state.canMutate = false;
	render(<EditorClient id="project" historyOnly />);
	expect(
		screen.getByRole("link", { name: "editing.preview" }),
	).toBeInTheDocument();
	for (const button of screen.getAllByRole("button", {
		name: "editing.cancel",
	})) {
		expect(button).toBeDisabled();
		fireEvent.click(button);
	}
	expect(state.api).not.toHaveBeenCalled();
});
