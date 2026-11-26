import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
let canManage = true;
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canManage,
}));

import { ContentRemovalAction } from "./content-removal-action";

const content = {
	id: "b1111111-1111-4111-8111-111111111111",
	title: "Sample footage",
	revision: 3,
	archived: false,
};

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue({ ...content, archived: true, revision: 4 });
	canManage = true;
});

it("confirms registration-only removal without deleting media, jobs or clip history", async () => {
	const changed = vi.fn();
	const { client } = renderWithQuery(
		<ContentRemovalAction content={content} onChanged={changed} />,
	);
	client.setQueryData(["library", "content"], { items: [content] });
	client.setQueryData(["library-scene-options", false], { locales: ["en"] });
	client.setQueryData(["job-analysis", "job"], { contents: [content] });
	fireEvent.click(
		screen.getByRole("button", { name: "Remove from Library: Sample footage" }),
	);
	const dialog = screen.getByRole("dialog");
	expect(dialog).toHaveTextContent("Archived content");
	expect(dialog).toHaveTextContent(
		"Cloud media, encoding jobs and clip history are kept",
	);
	expect(apiFetch).not.toHaveBeenCalled();
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(apiFetch).not.toHaveBeenCalled();
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Remove from Library: Sample footage" }),
	);
	within(screen.getByRole("dialog"))
		.getByRole("button", { name: "Remove from Library" })
		.focus();
	await user.keyboard("{Enter}");
	await waitFor(() => expect(changed).toHaveBeenCalledOnce());
	expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
		`/api/library/${content.id}`,
		{
			method: "PATCH",
			body: JSON.stringify({ expectedRevision: 3, archived: true }),
		},
	);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(client.getQueryState(["library", "content"])?.isInvalidated).toBe(
		true,
	);
	expect(
		client.getQueryState(["library-scene-options", false])?.isInvalidated,
	).toBe(true);
	expect(client.getQueryState(["job-analysis", "job"])?.isInvalidated).toBe(
		true,
	);
});

it("restores an archived entry with its latest revision", async () => {
	apiFetch.mockResolvedValue({ ...content, revision: 5 });
	renderWithQuery(
		<ContentRemovalAction
			content={{ ...content, archived: true, revision: 4 }}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Restore to Library: Sample footage" }),
	);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }),
	);
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
		`/api/library/${content.id}`,
		{
			method: "PATCH",
			body: JSON.stringify({ expectedRevision: 4, archived: false }),
		},
	);
});

it.each([
	409, 403,
])("keeps a rejected %s entry visible and does not report success", async (status) => {
	apiFetch.mockRejectedValue(new ApiError(status, "Rejected"));
	const changed = vi.fn();
	const { client } = renderWithQuery(
		<ContentRemovalAction content={content} onChanged={changed} />,
	);
	client.setQueryData(["library", "content"], { items: [content] });
	fireEvent.click(
		screen.getByRole("button", { name: "Remove from Library: Sample footage" }),
	);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "Remove from Library",
		}),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		status === 409
			? "This content changed in another session"
			: "You do not have permission to change this Library entry.",
	);
	expect(changed).not.toHaveBeenCalled();
	expect(client.getQueryData(["library", "content"])).toEqual({
		items: [content],
	});
	expect(screen.getByRole("dialog")).toBeVisible();
});

it("hides removal and restore from viewers and unresolved sessions", () => {
	canManage = false;
	const { rerender } = renderWithQuery(
		<ContentRemovalAction content={content} />,
	);
	expect(screen.queryByRole("button")).not.toBeInTheDocument();
	rerender(<ContentRemovalAction content={{ ...content, archived: true }} />);
	expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("shows Japanese removal scope and a compact action label", () => {
	renderWithQuery(<ContentRemovalAction content={content} />, "ja");
	fireEvent.click(
		screen.getByRole("button", { name: "ライブラリから削除: Sample footage" }),
	);
	const dialog = screen.getByRole("dialog");
	expect(dialog).toHaveTextContent("アーカイブ済み");
	expect(dialog).toHaveTextContent(
		"クラウド上の映像・エンコード履歴・クリップの履歴は保持します",
	);
	expect(apiFetch).not.toHaveBeenCalled();
});
