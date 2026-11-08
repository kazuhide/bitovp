import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";

const apiFetch = vi.fn();
const push = vi.fn();
let canMutate = true;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canMutate,
}));
vi.mock("@/components/storage-picker", () => ({ StoragePicker: () => null }));

import { EditingLibraryClient } from "./editing-library";

beforeEach(() => {
	apiFetch.mockReset();
	push.mockReset();
	canMutate = true;
});
function responses(url: string) {
	if (url.startsWith("/api/library/edits?"))
		return { items: [], offset: 0, total: 0 };
	if (url.includes("editing-eligibility"))
		return {
			sourceId: editingIds.source,
			files: [{ key: "mp4", label: "MP4" }],
			mediaVersions: [editingProjectFixture().media],
			analyses: [],
		};
	return {
		id: editingIds.content,
		title: "Interview",
		source: { id: editingIds.source },
	};
}

it.each([
	undefined,
	false,
])("does not mount project creation or read editing data when availability is %s", (clipEditingAvailable) => {
	apiFetch.mockImplementation(async (url: string) => responses(url));
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable={clipEditingAvailable}
		/>,
	);
	expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
	expect(apiFetch).not.toHaveBeenCalled();
});
it("creates a project from a ready fixed material and chosen format", async () => {
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
		init?.method === "POST" ? editingProjectFixture() : responses(url),
	);
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	await screen.findByRole("button", { name: "Create project" });
	fireEvent.change(screen.getByLabelText("Format"), {
		target: { value: "PORTRAIT" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(`/library/edits/${editingIds.project}`),
	);
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
	expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
		contentId: editingIds.content,
		mediaVersionId: editingIds.media,
		variant: "PORTRAIT",
		analysisRevisionId: null,
	});
});
it("allows viewers to inspect projects while preparation and creation stay disabled", async () => {
	canMutate = false;
	apiFetch.mockImplementation(async (url: string) => responses(url));
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	expect(
		await screen.findByRole("button", { name: "Create project" }),
	).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Prepare editing material" }),
	).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
