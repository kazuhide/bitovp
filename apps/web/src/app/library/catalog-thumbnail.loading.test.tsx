import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { CatalogThumbnail } from "./catalog-thumbnail";

const load = vi.hoisted(() => vi.fn());
vi.mock("./catalog-thumbnail-loader", () => ({ requestThumbnail: load }));
let observers: IntersectionObserverCallback[] = [];
beforeEach(() => {
	load.mockReset();
	observers = [];
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				observers.push(callback);
			}
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());
const source = { kind: "MP4" as const, url: "/private/media", time: 5 };
function intersect(index: number, isIntersecting = true) {
	act(() =>
		observers[index]?.(
			[{ isIntersecting } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		),
	);
}

it("distinguishes waiting/loading from an unavailable still", async () => {
	let resolve: (image: string | null) => void = () => {};
	load.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	renderLocalized(<CatalogThumbnail source={source} fallback="No thumbnail" />);
	expect(screen.getByText("Loading thumbnail…")).toBeInTheDocument();
	expect(screen.queryByText("No thumbnail")).not.toBeInTheDocument();
	expect(load).not.toHaveBeenCalled();
	intersect(0);
	await act(async () => resolve(null));
	expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
	expect(screen.queryByText("Loading thumbnail…")).not.toBeInTheDocument();
});

it("never paints a canceled prior source or offscreen result", async () => {
	const resolves: ((image: string | null) => void)[] = [];
	load.mockImplementation(() => new Promise((done) => resolves.push(done)));
	const view = renderLocalized(
		<CatalogThumbnail source={source} fallback="No thumbnail" />,
	);
	intersect(0);
	const firstSignal = load.mock.calls[0]?.[1] as AbortSignal;
	view.rerender(
		<CatalogThumbnail
			source={{ ...source, time: 10 }}
			fallback="No thumbnail"
		/>,
	);
	expect(firstSignal.aborted).toBe(true);
	intersect(1);
	await act(async () => resolves[0]?.("data:image/jpeg;base64,old"));
	expect(view.container.querySelector("img")).toBeNull();
	intersect(1, false);
	await act(async () => resolves[1]?.("data:image/jpeg;base64,offscreen"));
	expect(view.container.querySelector("img")).toBeNull();
	intersect(1);
	await act(async () => resolves[2]?.("data:image/jpeg;base64,current"));
	expect(view.container.querySelector("img")).toHaveAttribute(
		"src",
		"data:image/jpeg;base64,current",
	);
});
