import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized, renderWithQuery } from "@/test/render";
import { ContentClipPanel } from "./content-clip-panel";

const metadata = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: metadata }));
const list = vi.fn(({ contentId }: { contentId: string }) => (
	<section aria-label="Clip list">{contentId}</section>
));
vi.mock("./clip-projects", () => ({
	ClipProjects: (props: { contentId: string }) => list(props),
}));
beforeEach(() => {
	metadata.mockReset().mockResolvedValue({ items: [], total: 0, offset: 0 });
	list.mockClear();
	window.history.replaceState(null, "", "/library/source?scene=selected");
});

it("opens the auxiliary list on demand and restores focus without changing the selected scene", async () => {
	renderLocalized(<ContentClipPanel contentId="source" clipEditingAvailable />);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(list).not.toHaveBeenCalled();
	const trigger = screen.getByRole("button", { name: "Clips" });
	await userEvent.click(trigger);
	expect(screen.getByRole("dialog", { name: "Clip drafts" })).toBeVisible();
	expect(screen.getByRole("region", { name: "Clip list" })).toHaveTextContent(
		"source",
	);
	expect(window.location.search).toBe("?scene=selected");
	await userEvent.keyboard("{Escape}");
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	await waitFor(() => expect(trigger).toHaveFocus());
	expect(window.location.hash).toBe("");
	expect(window.location.search).toBe("?scene=selected");
});

it("supports an existing direct link while keeping the list inside the dialog", async () => {
	window.history.replaceState(null, "", "/library/source#clip-drafts");
	renderLocalized(<ContentClipPanel contentId="source" clipEditingAvailable />);
	await screen.findByRole("dialog", { name: "Clip drafts" });
	expect(
		screen
			.getByRole("region", { name: "Clip list" })
			.closest('[role="dialog"]'),
	).not.toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "Close" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each([
	undefined,
	false,
])("does not expose or mount clip editing from a deep hash when availability is %s", (clipEditingAvailable) => {
	window.history.replaceState(null, "", "/library/source#clip-drafts");
	renderWithQuery(
		<ContentClipPanel
			contentId="source"
			clipEditingAvailable={clipEditingAvailable}
		/>,
	);
	expect(screen.queryByRole("button", { name: "Clips" })).toBeNull();
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(list).not.toHaveBeenCalled();
});

it("offers stored clips as a read-only overlay when GPU admission is unavailable", async () => {
	metadata.mockResolvedValue({ items: [], total: 2, offset: 0 });
	renderWithQuery(
		<ContentClipPanel contentId="source" clipEditingAvailable={false} />,
	);
	const trigger = await screen.findByRole("button", { name: "Clips" });
	expect(list).not.toHaveBeenCalled();
	await userEvent.click(trigger);
	expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
		contentId: "source",
		clipEditingAvailable: false,
		readOnly: true,
		showCreate: false,
	});
	expect(metadata.mock.calls[0]?.[0]).toContain(
		"/api/library/edits?contentId=source",
	);
});
