import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { MoqClientPlaybackClock } from "./moq-client-playback-clock";

const ORIGIN = Date.parse("2026-11-17T20:37:51.158Z");
function media(position = 5) {
	const video = document.createElement("video");
	let time = position;
	let seeking = false;
	Object.defineProperties(video, {
		readyState: { get: () => 2 },
		currentTime: { get: () => time },
		seeking: { get: () => seeking },
	});
	return {
		ref: { current: video },
		position(value: number) {
			time = value;
		},
		seeking(value: boolean) {
			seeking = value;
		},
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-18T01:00:00.000Z"));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("independent client playback clock", () => {
	it("uses the actual client wall clock during live playback", () => {
		render(<MoqClientPlaybackClock mode="live" active />);
		expect(screen.getByText("2026-11-18 01:00:00.000 UTC")).toBeVisible();
		act(() => vi.advanceTimersByTime(1200));
		expect(screen.getByText("2026-11-18 01:00:01.200 UTC")).toBeVisible();
	});
	it("maps archived positions from the original client observation, independent of today and image pixels", () => {
		const f = media(5.003);
		const pixels = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
		render(
			<MoqClientPlaybackClock
				mode="archive"
				mediaRef={f.ref}
				originUtcMs={ORIGIN}
				durationMs={21_073}
			/>,
		);
		expect(screen.getByText("2026-11-17 20:37:56.161 UTC")).toHaveAttribute(
			"datetime",
			"2026-11-17T20:37:56.161Z",
		);
		expect(screen.queryByText(/2026-11-18 01:/)).toBeNull();
		expect(pixels).not.toHaveBeenCalled();
	});
	it("freezes with paused media and follows forward and backward seeks", () => {
		const f = media();
		render(
			<MoqClientPlaybackClock
				mode="archive"
				mediaRef={f.ref}
				originUtcMs={ORIGIN}
				durationMs={21_073}
			/>,
		);
		expect(screen.getByText("2026-11-17 20:37:56.158 UTC")).toBeVisible();
		act(() => vi.advanceTimersByTime(700));
		expect(screen.getByText("2026-11-17 20:37:56.158 UTC")).toBeVisible();
		f.position(12);
		fireEvent.seeked(f.ref.current);
		act(() => vi.advanceTimersByTime(100));
		expect(screen.getByText("2026-11-17 20:38:03.158 UTC")).toBeVisible();
		f.position(0);
		fireEvent.seeked(f.ref.current);
		act(() => vi.advanceTimersByTime(100));
		expect(screen.getByText("2026-11-17 20:37:51.158 UTC")).toBeVisible();
	});
	it("does not retain a previous position while a seek is pending", () => {
		const f = media();
		render(
			<MoqClientPlaybackClock
				mode="archive"
				mediaRef={f.ref}
				originUtcMs={ORIGIN}
				durationMs={21_073}
			/>,
		);
		f.seeking(true);
		fireEvent.seeking(f.ref.current);
		expect(screen.queryByText("2026-11-17 20:37:56.158 UTC")).toBeNull();
		expect(screen.getByText("—")).toBeVisible();
	});
	it("coalesces frequent media events into one advancing update per 100ms", () => {
		const f = media();
		render(
			<MoqClientPlaybackClock
				mode="archive"
				mediaRef={f.ref}
				originUtcMs={ORIGIN}
				durationMs={21_073}
			/>,
		);
		act(() => vi.advanceTimersByTime(50));
		f.position(5.05);
		fireEvent.timeUpdate(f.ref.current);
		expect(screen.getByText("2026-11-17 20:37:56.158 UTC")).toBeVisible();
		f.position(5.06);
		fireEvent.rateChange(f.ref.current);
		expect(screen.getByText("2026-11-17 20:37:56.158 UTC")).toBeVisible();
		act(() => vi.advanceTimersByTime(50));
		expect(screen.getByText("2026-11-17 20:37:56.218 UTC")).toBeVisible();
	});
	it("never falls back to the current clock for legacy recordings without an origin", () => {
		const f = media();
		render(
			<MoqClientPlaybackClock
				mode="archive"
				mediaRef={f.ref}
				originUtcMs={null}
				durationMs={21_073}
			/>,
		);
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.getByText("—")).toBeVisible();
		expect(screen.queryByText(/2026-/)).toBeNull();
	});
	it("stops the live clock when playback is inactive and releases its timer", () => {
		const rendered = render(<MoqClientPlaybackClock mode="live" active />);
		expect(vi.getTimerCount()).toBe(1);
		rendered.rerender(<MoqClientPlaybackClock mode="live" active={false} />);
		expect(screen.getByText("—")).toBeVisible();
		expect(vi.getTimerCount()).toBe(0);
		rendered.unmount();
	});
});
