import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderLocalized } from "@/test/render";
import { ClipThumbnail } from "./clip-thumbnail";

const load = vi.hoisted(() => vi.fn());
vi.mock("./clip-thumbnail-loader", () => ({ requestClipThumbnail: load }));
let observe: IntersectionObserverCallback;
const reference = {
	url: "/thumb?expectedOrganizationId=org",
	cacheKey: "draft-1",
	draftRevision: 1,
	width: 1080,
	height: 1920,
};
beforeEach(() => {
	load.mockReset();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(fn: IntersectionObserverCallback) {
				observe = fn;
			}
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());
function visible(value = true) {
	act(() =>
		observe(
			[{ isIntersecting: value }] as IntersectionObserverEntry[],
			{} as IntersectionObserver,
		),
	);
}
function thumbnail(ref = reference, org = "org") {
	return (
		<DocumentOrganizationContext.Provider value={org}>
			<ClipThumbnail reference={ref} />
		</DocumentOrganizationContext.Provider>
	);
}
it("loads only visible drafts with the parent locale and drops old images immediately on a version change", async () => {
	load.mockResolvedValue("data:image/jpeg;base64,current");
	const view = renderLocalized(thumbnail(), "ja");
	expect(load).not.toHaveBeenCalled();
	visible();
	await waitFor(() =>
		expect(view.container.querySelector("img")).not.toBeNull(),
	);
	expect(load.mock.calls[0]?.[1]).toBe("ja");
	load.mockImplementation(() => new Promise(() => {}));
	view.rerender(
		thumbnail({ ...reference, cacheKey: "draft-2", draftRevision: 2 }),
	);
	expect(view.container.querySelector("img")).toBeNull();
	expect(load.mock.calls[0]?.[2].aborted).toBe(true);
});
it("aborts offscreen/unmounted captures and keeps a quiet placeholder on failure", async () => {
	load.mockResolvedValue(null);
	const view = renderLocalized(thumbnail());
	visible();
	await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
	expect(view.container.querySelector("img")).toBeNull();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	visible(false);
	expect(load.mock.calls[0]?.[2].aborted).toBe(true);
	view.unmount();
});
it("clears a prior organization image synchronously and never loads it in another document organization", async () => {
	load.mockResolvedValue("data:image/jpeg;base64,current");
	const view = renderLocalized(thumbnail());
	visible();
	await waitFor(() =>
		expect(view.container.querySelector("img")).not.toBeNull(),
	);
	view.rerender(thumbnail(reference, "another-org"));
	expect(view.container.querySelector("img")).toBeNull();
	expect(load.mock.calls[0]?.[2].aborted).toBe(true);
	expect(load).toHaveBeenCalledTimes(1);
});
