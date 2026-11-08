import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { ContentClipPanel } from "./content-clip-panel";

const list = vi.fn(({ contentId }: { contentId: string }) => (
	<section aria-label="Clip list">{contentId}</section>
));
vi.mock("./clip-projects", () => ({
	ClipProjects: (props: { contentId: string }) => list(props),
}));
beforeEach(() => {
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
	renderLocalized(
		<ContentClipPanel
			contentId="source"
			clipEditingAvailable={clipEditingAvailable}
		/>,
	);
	expect(screen.queryByRole("button", { name: "Clips" })).toBeNull();
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(list).not.toHaveBeenCalled();
});
