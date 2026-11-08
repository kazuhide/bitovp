import type { CompositionFrame, PixelRect } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { paintCompositionFrame } from "./composition-preview";

type Pixel = [number, number, number, number];
type Image = { colorAt(x: number, y: number): Pixel };
type Draw = { source: Image; args: number[]; filter: string; alpha: number };

/** A spatial premultiplied compositor; blur kernels are checked by native proofs. */
class RasterCanvas implements Image {
	width = 36;
	height = 64;
	globalAlpha = 1;
	globalCompositeOperation = "source-over";
	fillStyle = "black";
	filter = "none";
	draws: Draw[] = [];
	private pixels = new Map<string, Pixel>();
	private path: PixelRect = { x: 0, y: 0, w: 36, h: 64 };
	private region = this.path;
	private stack: {
		alpha: number;
		fill: string;
		filter: string;
		region: PixelRect;
	}[] = [];
	getContext() {
		return this;
	}
	colorAt(x: number, y: number): Pixel {
		return this.pixels.get(`${Math.floor(x)},${Math.floor(y)}`) ?? [0, 0, 0, 0];
	}
	clearRect() {
		this.pixels.clear();
	}
	save() {
		this.stack.push({
			alpha: this.globalAlpha,
			fill: this.fillStyle,
			filter: this.filter,
			region: this.region,
		});
	}
	restore() {
		const saved = this.stack.pop();
		if (!saved) throw new Error("Unbalanced canvas state");
		this.globalAlpha = saved.alpha;
		this.fillStyle = saved.fill;
		this.filter = saved.filter;
		this.region = saved.region;
	}
	beginPath() {}
	rect(x: number, y: number, w: number, h: number) {
		this.path = { x, y, w, h };
	}
	clip() {
		const x = Math.max(this.path.x, this.region.x),
			y = Math.max(this.path.y, this.region.y);
		this.region = {
			x,
			y,
			w: Math.min(this.path.x + this.path.w, this.region.x + this.region.w) - x,
			h: Math.min(this.path.y + this.path.h, this.region.y + this.region.h) - y,
		};
	}
	private paint(rect: PixelRect, color: (x: number, y: number) => Pixel) {
		for (let y = 0; y < this.height; y++)
			for (let x = 0; x < this.width; x++) {
				if (
					x < rect.x ||
					y < rect.y ||
					x >= rect.x + rect.w ||
					y >= rect.y + rect.h ||
					x < this.region.x ||
					y < this.region.y ||
					x >= this.region.x + this.region.w ||
					y >= this.region.y + this.region.h
				)
					continue;
				const source = color(x, y),
					destination = this.colorAt(x, y),
					alpha = source[3] * this.globalAlpha;
				this.pixels.set(
					`${x},${y}`,
					destination.map((value, channel) =>
						Math.min(
							1,
							(source[channel] ?? 0) * this.globalAlpha +
								value *
									(this.globalCompositeOperation === "lighter" ? 1 : 1 - alpha),
						),
					) as Pixel,
				);
			}
	}
	fillRect(x: number, y: number, w: number, h: number) {
		const alpha = this.fillStyle.startsWith("rgba(")
			? Number(this.fillStyle.split(",").at(-1)?.replace(")", ""))
			: 1;
		this.paint({ x, y, w, h }, () => [0, 0, 0, alpha]);
	}
	drawImage(source: Image, ...args: number[]) {
		this.draws.push({
			source,
			args,
			filter: this.filter,
			alpha: this.globalAlpha,
		});
		const [sx, sy, sw, sh, x, y, w, h] =
			args.length === 8 ? args : [0, 0, 36, 64, args[0], args[1], 36, 64];
		if ([sx, sy, sw, sh, x, y, w, h].some((value) => value === undefined))
			throw new Error("Missing drawing coordinates");
		this.paint({ x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 }, (px, py) =>
			source.colorAt(
				(sx ?? 0) + ((px - (x ?? 0)) * (sw ?? 0)) / (w ?? 1),
				(sy ?? 0) + ((py - (y ?? 0)) * (sh ?? 0)) / (h ?? 1),
			),
		);
	}
}

function frame(backdrop = true): CompositionFrame {
	const layer = {
		clipId: "clip",
		mediaVersionId: "source",
		trackId: "main",
		trackOrder: 0,
		localFrame: 0,
		sourceFrame: 10,
		sourceSeconds: 10 / 30,
		sourceTimeUs: 333334,
		opacity: 1,
		transitionWeight: 1,
		mode: "FIT" as const,
		layoutRect: { x: 0, y: 12, w: 36, h: 40 },
		sourceRect: { x: 0, y: 0, w: 1920, h: 1080 },
		drawRect: { x: 0, y: 22, w: 36, h: 20 },
	};
	if (backdrop)
		Object.assign(layer, {
			backdrop: {
				kind: "BLUR",
				sourceRect: { x: 474, y: 0, w: 972, h: 1080 },
				drawRect: { x: -3, y: 9, w: 42, h: 46 },
				clipRect: { ...layer.layoutRect },
				blurPx: 0.8,
				shadeOpacity: 0.35,
			},
		});
	return {
		frame: 0,
		timeUs: 0,
		canvas: { width: 36, height: 64 },
		layers: [layer],
		audio: [],
		captions: [],
		overlays: [],
	};
}
function paint(state: CompositionFrame) {
	const output = new RasterCanvas(),
		track = new RasterCanvas(),
		clip = new RasterCanvas();
	const video = { readyState: 2, colorAt: (): Pixel => [1, 1, 1, 1] };
	paintCompositionFrame(
		output as unknown as CanvasRenderingContext2D,
		state,
		new Map(
			state.layers.map((layer) => [
				layer.clipId,
				video as unknown as HTMLVideoElement,
			]),
		),
		new Map(),
		track as unknown as HTMLCanvasElement,
		clip as unknown as HTMLCanvasElement,
	);
	return { output, track, clip, video };
}

describe("AUTO canvas backdrop", () => {
	it("uses the same decoded frame, resets blur before the foreground, and preserves BANDS", () => {
		const { output, clip, video } = paint(frame());
		expect(output.colorAt(18, 0)).toEqual([0, 0, 0, 1]);
		expect(output.colorAt(18, 60)).toEqual([0, 0, 0, 1]);
		expect(output.colorAt(18, 14)).toEqual([0.65, 0.65, 0.65, 1]);
		expect(output.colorAt(18, 30)).toEqual([1, 1, 1, 1]);
		expect(clip.draws).toEqual([
			{
				source: video,
				args: [474, 0, 972, 1080, -3, 9, 42, 46],
				filter: "blur(0.8px)",
				alpha: 1,
			},
			{
				source: video,
				args: [0, 0, 1920, 1080, 0, 22, 36, 20],
				filter: "none",
				alpha: 1,
			},
		]);
		expect(clip.filter).toBe("none");
	});
	it.each([
		1, 0.5,
	])("applies opacity %s once to the combined backdrop and foreground during crossfade", (opacity) => {
		const state = frame(),
			first = state.layers[0];
		if (!first) throw new Error("Missing clip");
		first.opacity = opacity * 0.25;
		state.layers.push({ ...first, clipId: "next", opacity: opacity * 0.75 });
		const { output } = paint(state);
		for (const value of output.colorAt(18, 14).slice(0, 3))
			expect(value).toBeCloseTo(0.65 * opacity);
		for (const value of output.colorAt(18, 30).slice(0, 3))
			expect(value).toBeCloseTo(opacity);
	});
	it("keeps legacy FIT black and does not add another source draw", () => {
		const { output, clip } = paint(frame(false));
		expect(output.colorAt(18, 14)).toEqual([0, 0, 0, 1]);
		expect(output.colorAt(18, 30)).toEqual([1, 1, 1, 1]);
		expect(clip.draws).toHaveLength(1);
		expect(clip.draws[0]?.filter).toBe("none");
	});
});
