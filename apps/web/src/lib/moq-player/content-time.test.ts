import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMoqContentTime, observeMoqContentTime } from "./content-time";

// Independent fixture: literal source layout and BigInt bit extraction; decoder
// must not share its arithmetic or infer time from the observer's clock.
function barcode(epochMs: number) {
	const pixels = new Uint8ClampedArray(64 * 4);
	for (let cell = 0; cell < 64; cell++) {
		const white =
			cell === 0 ||
			(cell >= 2 &&
				cell < 50 &&
				((BigInt(epochMs) >> BigInt(cell - 2)) & 1n) === 1n);
		pixels.set(
			[white ? 255 : 0, white ? 255 : 0, white ? 255 : 0, 255],
			cell * 4,
		);
	}
	return pixels;
}
const EPOCH = Date.parse("2026-11-17T20:37:39.707Z");

describe("received-frame epoch barcode", () => {
	it.each([
		"2000-01-01T00:00:00.000Z",
		"2005-03-04T05:06:07.008Z",
		"2026-11-17T23:59:59.999Z",
		"2026-11-18T00:00:00.000Z",
		"2099-12-31T23:59:59.999Z",
	])("decodes exact 48-bit epoch milliseconds including midnight: %s", (iso) => {
		const epoch = Date.parse(iso);
		expect(decodeMoqContentTime(barcode(epoch))).toBe(epoch);
	});
	it("accepts old archives independently of the current wall clock", () => {
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.parse("2150-01-01Z"));
		expect(decodeMoqContentTime(barcode(EPOCH))).toBe(EPOCH);
		expect(clock).not.toHaveBeenCalled();
		clock.mockRestore();
	});
	it("accepts opaque neutral compressed black/white cells", () => {
		const pixels = barcode(EPOCH);
		for (let i = 0; i < pixels.length; i += 4) {
			const white = pixels[i] === 255;
			pixels.set(white ? [235, 229, 232, 255] : [18, 24, 21, 255], i);
		}
		expect(decodeMoqContentTime(pixels)).toBe(EPOCH);
	});
	it.each([
		"black",
		"white",
		"header",
		"suffix",
		"gray",
		"color",
		"alpha",
	])("rejects non-barcode or ambiguous pixels: %s", (kind) => {
		const pixels = barcode(EPOCH);
		if (kind === "black" || kind === "white")
			for (let i = 0; i < pixels.length; i += 4)
				pixels.set(kind === "black" ? [0, 0, 0, 255] : [255, 255, 255, 255], i);
		if (kind === "header") pixels.set([255, 255, 255, 255], 4);
		if (kind === "suffix") pixels.set([255, 255, 255, 255], 63 * 4);
		if (kind === "gray") pixels.set([128, 128, 128, 255], 10 * 4);
		if (kind === "color") pixels.set([255, 0, 0, 255], 10 * 4);
		if (kind === "alpha") pixels[10 * 4 + 3] = 0;
		expect(decodeMoqContentTime(pixels)).toBeNull();
	});
	it.each([
		Date.parse("1999-12-31T23:59:59.999Z"),
		Date.parse("2100-01-01T00:00:00.000Z"),
		2 ** 48 - 1,
	])("rejects dates outside the fixed demo format range: %i", (epoch) => {
		expect(decodeMoqContentTime(barcode(epoch))).toBeNull();
	});
	it("rejects wrong lengths and nonfinite, out-of-range or fractional channels", () => {
		expect(decodeMoqContentTime(new Uint8ClampedArray(255))).toBeNull();
		expect(decodeMoqContentTime(new Uint8ClampedArray(260))).toBeNull();
		for (const channel of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			256,
			0.5,
		]) {
			const pixels = Array.from(barcode(EPOCH));
			pixels[12] = channel;
			expect(decodeMoqContentTime(pixels)).toBeNull();
		}
	});
});

describe("received content-time DOM observer", () => {
	let pixels: Uint8ClampedArray;
	let unreadable: boolean;
	let reads: number[];
	let draw: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		pixels = barcode(EPOCH);
		unreadable = false;
		reads = [];
		draw = vi.fn(() => reads.push(performance.now()));
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: draw,
			getImageData: () => {
				if (unreadable)
					throw new DOMException("Unreadable pixels", "SecurityError");
				return { data: pixels };
			},
			imageSmoothingEnabled: true,
		} as unknown as CanvasRenderingContext2D);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	function videoFixture() {
		const video = document.createElement("video");
		const state = { ready: 2, paused: false, seeking: false, ended: false };
		let sequence = 0;
		const callbacks = new Map<number, VideoFrameRequestCallback>();
		const request = vi.fn((callback: VideoFrameRequestCallback) => {
			callbacks.set(++sequence, callback);
			return sequence;
		});
		const cancel = vi.fn((handle: number) => callbacks.delete(handle));
		Object.defineProperties(video, {
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
			readyState: { get: () => state.ready },
			paused: { get: () => state.paused },
			seeking: { get: () => state.seeking },
			ended: { get: () => state.ended },
			requestVideoFrameCallback: { value: request },
			cancelVideoFrameCallback: { value: cancel },
		});
		return {
			video,
			state,
			callbacks,
			request,
			cancel,
			frame() {
				const entry = callbacks.entries().next().value;
				if (!entry) throw new Error("No owned frame callback pending");
				callbacks.delete(entry[0]);
				entry[1](performance.now(), {} as VideoFrameCallbackMetadata);
			},
		};
	}
	it("reads actual presented video pixels into a bounded 64×1 centre strip", () => {
		const f = videoFixture();
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		expect(changed).toHaveBeenLastCalledWith(EPOCH, "decoded");
		expect(draw).toHaveBeenCalledWith(f.video, 0, 14, 640, 1, 0, 0, 64, 1);
		pixels = barcode(EPOCH + 40);
		vi.advanceTimersByTime(100);
		f.frame();
		expect(changed).toHaveBeenLastCalledWith(EPOCH + 40, "decoded");
		stop();
	});
	it("waits for loadeddata and never reads a video without a current frame", () => {
		const f = videoFixture();
		f.state.ready = 1;
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		expect(changed).toHaveBeenLastCalledWith(null, "unreadable");
		expect(draw).not.toHaveBeenCalled();
		f.state.ready = 2;
		f.video.dispatchEvent(new Event("loadeddata"));
		expect(changed).toHaveBeenLastCalledWith(EPOCH, "decoded");
		stop();
	});
	it("caps pixel reads at 10Hz even when presented-frame callbacks arrive faster", () => {
		const f = videoFixture();
		const stop = observeMoqContentTime(f.video, vi.fn());
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(10);
			pixels = barcode(EPOCH + i);
			f.frame();
		}
		for (let i = 1; i < reads.length; i++)
			expect((reads[i] ?? 0) - (reads[i - 1] ?? 0)).toBeGreaterThanOrEqual(100);
		expect(reads.length).toBeLessThanOrEqual(6);
		stop();
	});
	it("clears immediately on seek and decodes the actual earlier frame after seeked", () => {
		const f = videoFixture();
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		f.state.seeking = true;
		f.video.dispatchEvent(new Event("seeking"));
		expect(changed).toHaveBeenLastCalledWith(null, "unreadable");
		vi.advanceTimersByTime(500);
		expect(changed).toHaveBeenCalledTimes(2);
		f.state.seeking = false;
		f.state.paused = true;
		pixels = barcode(EPOCH - 20_000);
		f.video.dispatchEvent(new Event("seeked"));
		expect(changed).toHaveBeenLastCalledWith(EPOCH - 20_000, "decoded");
		stop();
	});
	it("reads the final paused/ended frame and never advances its content time by the clock", () => {
		const f = videoFixture();
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		vi.advanceTimersByTime(100);
		f.state.paused = true;
		pixels = barcode(EPOCH + 400);
		f.video.dispatchEvent(new Event("pause"));
		expect(changed).toHaveBeenLastCalledWith(EPOCH + 400, "decoded");
		const pausedReads = draw.mock.calls.length;
		vi.advanceTimersByTime(5_000);
		expect(draw).toHaveBeenCalledTimes(pausedReads);
		f.state.ended = true;
		pixels = barcode(EPOCH + 800);
		f.video.dispatchEvent(new Event("ended"));
		expect(changed).toHaveBeenLastCalledWith(EPOCH + 800, "decoded");
		stop();
	});
	it("clears errors until fresh data and distinguishes unreadable pixels from no barcode", () => {
		const f = videoFixture();
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		f.video.dispatchEvent(new Event("error"));
		expect(changed).toHaveBeenLastCalledWith(null, "unreadable");
		vi.advanceTimersByTime(500);
		expect(changed).toHaveBeenCalledTimes(2);
		pixels = new Uint8ClampedArray(256);
		f.video.dispatchEvent(new Event("loadeddata"));
		expect(changed).toHaveBeenLastCalledWith(null, "no-barcode");
		unreadable = true;
		vi.advanceTimersByTime(100);
		f.frame();
		expect(changed).toHaveBeenLastCalledWith(null, "unreadable");
		unreadable = false;
		pixels = barcode(EPOCH + 1_000);
		vi.advanceTimersByTime(100);
		f.frame();
		expect(changed).toHaveBeenLastCalledWith(EPOCH + 1_000, "decoded");
		stop();
	});
	it("polls a canvas at 100ms and cleanup leaves unrelated media, listeners and timers alone", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const changed = vi.fn();
		const unrelated = vi.fn();
		canvas.addEventListener("custom", unrelated);
		const timer = setInterval(unrelated, 1_000);
		const stop = observeMoqContentTime(canvas, changed);
		pixels = barcode(EPOCH + 100);
		vi.advanceTimersByTime(100);
		expect(changed).toHaveBeenLastCalledWith(EPOCH + 100, "decoded");
		stop();
		stop();
		const count = changed.mock.calls.length;
		vi.advanceTimersByTime(1_000);
		expect(changed).toHaveBeenCalledTimes(count);
		canvas.dispatchEvent(new Event("custom"));
		expect(unrelated).toHaveBeenCalledTimes(2);
		clearInterval(timer);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels only its frame callback and never plays, pauses or stops source media", () => {
		const f = videoFixture();
		const play = vi.spyOn(f.video, "play").mockResolvedValue();
		const pause = vi.spyOn(f.video, "pause").mockImplementation(() => {});
		const external = f.request(vi.fn());
		const changed = vi.fn();
		const stop = observeMoqContentTime(f.video, changed);
		stop();
		expect(f.callbacks.has(external)).toBe(true);
		expect(f.callbacks.size).toBe(1);
		const count = changed.mock.calls.length;
		f.video.dispatchEvent(new Event("seeked"));
		vi.advanceTimersByTime(500);
		expect(changed).toHaveBeenCalledTimes(count);
		expect(play).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
