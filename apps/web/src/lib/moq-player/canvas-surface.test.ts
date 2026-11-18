import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoqCanvasSurface } from "./canvas-surface";

const play = vi.fn<() => Promise<void>>();
const pause = vi.fn();
beforeEach(() => {
	play.mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
});
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

function fixture() {
	const host = document.createElement("div");
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 360;
	host.append(canvas);
	document.body.append(host);
	const stop = vi.fn();
	const stream = { getTracks: () => [{ kind: "video", stop }] };
	const capture = vi.fn(() => stream);
	Object.assign(canvas, { captureStream: capture });
	let pixels = new Uint8ClampedArray([10, 20, 30, 255, 100, 110, 120, 255]);
	const read = vi.fn(() => ({ data: pixels }));
	const draw = vi.fn();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: draw,
		getImageData: read,
	} as unknown as CanvasRenderingContext2D);
	return {
		host,
		canvas,
		capture,
		stream,
		stop,
		read,
		draw,
		pixels(value: number[]) {
			pixels = new Uint8ClampedArray(value);
		},
	};
}

describe("owned MoQ canvas observation surface", () => {
	it("captures received drawing without requesting an artificial frame rate", () => {
		const f = fixture();
		const surface = createMoqCanvasSurface(f.canvas, f.host);
		expect(surface).not.toBeNull();
		expect(f.capture).toHaveBeenCalledWith();
		expect(surface?.video.srcObject).toBe(f.stream);
		expect(surface?.video.dataset.bitovpMoqCanvasMirror).toBe("true");
		expect(surface?.video.muted).toBe(true);
		expect(surface?.video.getAttribute("aria-hidden")).toBe("true");
		expect(play).toHaveBeenCalledOnce();
		surface?.dispose();
	});

	it("counts changed pixels only after a readable baseline and rejects blank or stale draws", () => {
		const f = fixture();
		const surface = createMoqCanvasSurface(f.canvas, f.host);
		expect(surface?.changed()).toBe(false);
		expect(surface?.changed()).toBe(false);
		f.pixels([11, 20, 30, 255, 100, 110, 120, 255]);
		expect(surface?.changed()).toBe(true);
		expect(surface?.changed()).toBe(false);
		f.pixels([0, 0, 0, 255, 0, 0, 0, 255]);
		expect(surface?.changed()).toBe(false);
		f.pixels([11, 20, 30, 255, 100, 110, 120, 255]);
		expect(surface?.changed()).toBe(false);
		surface?.dispose();
	});

	it("keeps unreadable frames unknown and releases only its own tracks and video once", () => {
		const f = fixture();
		const surface = createMoqCanvasSurface(f.canvas, f.host);
		f.read.mockImplementation(() => {
			throw new DOMException("private source", "SecurityError");
		});
		expect(surface?.changed()).toBe(false);
		surface?.dispose();
		surface?.dispose();
		expect(f.stop).toHaveBeenCalledOnce();
		expect(pause).toHaveBeenCalledOnce();
		expect(surface?.video.srcObject).toBeNull();
		expect(surface?.video.isConnected).toBe(false);
		expect(f.canvas.isConnected).toBe(true);
		expect(surface?.changed()).toBe(false);
	});

	it("returns unavailable when native capture fails without leaking a mirror", () => {
		const f = fixture();
		f.capture.mockImplementation(() => {
			throw new DOMException("private token", "SecurityError");
		});
		expect(createMoqCanvasSurface(f.canvas, f.host)).toBeNull();
		expect(f.host.querySelector("video")).toBeNull();
	});

	it("releases capture if playback of the owned mirror rejects", async () => {
		const f = fixture();
		play.mockRejectedValueOnce(new Error("private source"));
		const surface = createMoqCanvasSurface(f.canvas, f.host);
		await Promise.resolve();
		await Promise.resolve();
		expect(f.stop).toHaveBeenCalledOnce();
		expect(surface?.video.isConnected).toBe(false);
		expect(surface?.changed()).toBe(false);
	});
});
