import { act, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { MoqContentTime } from "./moq-content-time";

const mocks = vi.hoisted(() => ({
	observe: vi.fn(),
}));
vi.mock("@/lib/moq-player/content-time", () => ({
	observeMoqContentTime: mocks.observe,
}));

let callbacks: Array<(value: number | null) => void>;
let disposals: Array<ReturnType<typeof vi.fn>>;
beforeEach(() => {
	callbacks = [];
	disposals = [];
	mocks.observe.mockImplementation((_source, onTime) => {
		callbacks.push(onTime);
		const dispose = vi.fn();
		disposals.push(dispose);
		return dispose;
	});
});
afterEach(() => {
	vi.clearAllMocks();
});

describe("MoQ content clock", () => {
	it("shows the UTC date and milliseconds read from the displayed frame, not the current clock", () => {
		const video = document.createElement("video");
		const mediaRef = { current: video };
		render(<MoqContentTime mediaRef={mediaRef} />);
		expect(screen.getByText("—")).toBeInTheDocument();
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:50.657Z")));
		expect(screen.getByText("2026-11-17 20:37:50.657 UTC")).toHaveAttribute(
			"dateTime",
			"2026-11-17T20:37:50.657Z",
		);
	});

	it("follows decoded frame changes and clears the clock when that frame is unreadable", () => {
		const mediaRef = { current: document.createElement("video") };
		render(<MoqContentTime mediaRef={mediaRef} />);
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:50.657Z")));
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:55.017Z")));
		expect(screen.getByText("2026-11-17 20:37:55.017 UTC")).toBeVisible();
		act(() => callbacks[0]?.(null));
		expect(screen.queryByText("2026-11-17 20:37:55.017 UTC")).toBeNull();
		expect(screen.getByText("—")).toBeVisible();
	});

	it("observes the visible live canvas instead of its hidden recording mirror", () => {
		const host = document.createElement("section");
		const mirror = document.createElement("video");
		mirror.dataset.bitovpMoqCanvasMirror = "true";
		const canvas = document.createElement("canvas");
		host.append(mirror, canvas);
		render(<MoqContentTime mediaRef={{ current: host }} />);
		expect(mocks.observe).toHaveBeenCalledWith(canvas, expect.any(Function));
	});

	it("discovers a late player surface and rejects callbacks from a disposed surface", async () => {
		const host = document.createElement("section");
		const rendered = render(<MoqContentTime mediaRef={{ current: host }} />);
		expect(mocks.observe).not.toHaveBeenCalled();
		const first = document.createElement("canvas");
		act(() => host.append(first));
		await waitFor(() => expect(mocks.observe).toHaveBeenCalledTimes(1));
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:50.657Z")));
		const second = document.createElement("canvas");
		act(() => host.replaceChildren(second));
		await waitFor(() => expect(mocks.observe).toHaveBeenCalledTimes(2));
		expect(disposals[0]).toHaveBeenCalledOnce();
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:59.000Z")));
		expect(screen.queryByText("2026-11-17 20:37:59.000 UTC")).toBeNull();
		act(() => callbacks[1]?.(Date.parse("2026-11-17T20:38:00.000Z")));
		expect(screen.getByText("2026-11-17 20:38:00.000 UTC")).toBeVisible();
		rendered.unmount();
		expect(disposals[1]).toHaveBeenCalledOnce();
	});

	it("releases the old archive and clears its timestamp when the selected recording changes", () => {
		const first: RefObject<HTMLElement | null> = {
			current: document.createElement("video"),
		};
		const second: RefObject<HTMLElement | null> = {
			current: document.createElement("video"),
		};
		const rendered = render(<MoqContentTime mediaRef={first} />);
		act(() => callbacks[0]?.(Date.parse("2026-11-17T20:37:50.657Z")));
		rendered.rerender(<MoqContentTime mediaRef={second} />);
		expect(disposals[0]).toHaveBeenCalledOnce();
		expect(screen.queryByText("2026-11-17 20:37:50.657 UTC")).toBeNull();
		expect(screen.getByText("—")).toBeVisible();
	});
});
