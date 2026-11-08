import type { CompositionFrame, CompositionPlan } from "@bitovp/core";

export type CompositionSourceFrame = {
	clipId: string;
	mediaVersionId: string;
	sourceFrame: number;
	width: number;
	height: number;
	image: HTMLCanvasElement;
};
export type CompositionSourceFrameReader = (
	clipId: string,
) => CompositionSourceFrame | null;
type Current = { plan: CompositionPlan; frame: number; playing: boolean };
type FrameInput = {
	plan: CompositionPlan;
	state: CompositionFrame;
	videos: Map<string, HTMLVideoElement>;
	media: readonly { id: string; url: string | null }[];
	playing: boolean;
	baseUrl: string;
	seek?: (video: HTMLVideoElement, seconds: number) => void;
};

export class CompositionSourceFrameBridge {
	private input?: FrameInput;
	private availability = "";
	private pending?: Omit<Current, "playing"> & {
		clipId: string;
		mediaVersionId: string;
		sourceUrl?: string;
		nudged: boolean;
	};
	private snapshots = new Map<string, CompositionSourceFrame>();
	private observers = new Map<
		HTMLVideoElement,
		{
			sourceUrl: string;
			mediaTime: number | null;
			hasFrameCallback: boolean;
			dispose: () => void;
		}
	>();
	constructor(
		private current: () => Current,
		private createCanvas: () => HTMLCanvasElement,
	) {}
	private source(clipId: string) {
		const input = this.input,
			current = this.current();
		if (
			!input ||
			current.playing ||
			input.playing ||
			current.plan !== input.plan ||
			current.frame !== input.state.frame
		)
			return null;
		const layer = input.state.layers.find((item) => item.clipId === clipId),
			video = input.videos.get(clipId),
			source = input.plan.sources.find(
				(item) => item.mediaVersionId === layer?.mediaVersionId,
			),
			url = input.media.find((item) => item.id === layer?.mediaVersionId)?.url,
			observation = video && this.observers.get(video);
		if (!layer || !video || !source || !url || !observation) return null;
		let expectedUrl: string;
		try {
			expectedUrl = new URL(url, input.baseUrl).href;
		} catch {
			return null;
		}
		if (
			video.error ||
			!video.paused ||
			video.seeking ||
			video.readyState < 2 ||
			video.src !== expectedUrl ||
			video.currentSrc !== expectedUrl ||
			observation.sourceUrl !== expectedUrl ||
			!Number.isFinite(video.currentTime) ||
			video.videoWidth !== source.width ||
			video.videoHeight !== source.height
		)
			return null;
		return {
			layer,
			video,
			source,
			observation,
			key: `${clipId}:${layer.mediaVersionId}:${layer.sourceFrame}:${expectedUrl}`,
		};
	}
	private ready(clipId: string) {
		const source = this.source(clipId);
		if (!source) return null;
		const { video, layer, observation } = source;
		if (
			observation.mediaTime === null ||
			!Number.isFinite(observation.mediaTime) ||
			Math.abs(video.currentTime - layer.sourceSeconds) > 0.012 ||
			Math.abs(observation.mediaTime - layer.sourceSeconds) > 0.012 ||
			(!observation.hasFrameCallback &&
				video.currentTime - layer.sourceSeconds < 0.000005)
		)
			return null;
		return source;
	}
	read: CompositionSourceFrameReader = (clipId) => {
		const ready = this.ready(clipId);
		if (!ready) {
			const current = this.current(),
				clip = current.plan.clips.find(
					(item) =>
						item.clip.id === clipId &&
						current.frame >= item.outputFromFrame &&
						current.frame < item.outputToFrame,
				);
			if (current.playing) this.pending = undefined;
			else if (
				clip &&
				(this.pending?.plan !== current.plan ||
					this.pending.frame !== current.frame ||
					this.pending.clipId !== clipId)
			)
				this.pending = {
					plan: current.plan,
					frame: current.frame,
					clipId,
					mediaVersionId: clip.mediaVersionId,
					nudged: false,
				};
			return null;
		}
		this.pending = undefined;
		const cached = this.snapshots.get(ready.key);
		if (cached) return cached;
		const image = this.createCanvas(),
			{ source, layer, video } = ready;
		image.width = source.width;
		image.height = source.height;
		try {
			const context = image.getContext("2d");
			if (!context) return null;
			context.drawImage(video, 0, 0, source.width, source.height);
		} catch {
			return null;
		}
		const snapshot = {
			clipId,
			mediaVersionId: layer.mediaVersionId,
			sourceFrame: layer.sourceFrame,
			width: source.width,
			height: source.height,
			image,
		};
		this.snapshots.set(ready.key, snapshot);
		return snapshot;
	};
	/** Called by the existing preview RAF; it never captures an image itself. */
	update(input: FrameInput): boolean {
		const planChanged = this.input?.plan !== input.plan;
		this.input = input;
		const active = new Set(input.videos.values());
		for (const [video, observer] of this.observers)
			if (!active.has(video) || observer.sourceUrl !== video.src) {
				observer.dispose();
				this.observers.delete(video);
			}
		for (const video of active)
			if (!this.observers.has(video)) this.observe(video);
		const requested = this.pending;
		if (requested) {
			const url = input.media.find(
				(item) => item.id === requested.mediaVersionId,
			)?.url;
			let sourceUrl: string | undefined;
			try {
				sourceUrl = url ? new URL(url, input.baseUrl).href : undefined;
			} catch {
				this.pending = undefined;
			}
			const video = input.videos.get(requested.clipId),
				sourceChanged =
					(requested.sourceUrl !== undefined &&
						requested.sourceUrl !== sourceUrl) ||
					(sourceUrl && video?.src && video.src !== sourceUrl);
			if (
				input.playing ||
				requested.plan !== input.plan ||
				requested.frame !== input.state.frame ||
				sourceChanged ||
				this.pending === undefined
			)
				this.pending = undefined;
			else if (
				!requested.nudged &&
				input.seek &&
				!this.ready(requested.clipId)
			) {
				requested.sourceUrl ??= sourceUrl;
				const source = this.source(requested.clipId);
				if (
					source &&
					source.layer.mediaVersionId === requested.mediaVersionId &&
					Math.abs(source.video.currentTime - source.layer.sourceSeconds) <=
						0.012
				) {
					// Chrome truncates fractional microseconds at a CFR boundary. A requested
					// paused capture seeks inside frame N, then still requires N's metadata.
					requested.nudged = true;
					input.seek(source.video, source.layer.sourceSeconds + 0.00001);
				}
			}
		}
		const key = input.playing
			? "playing"
			: input.state.layers
					.map((layer) => this.ready(layer.clipId)?.key)
					.filter(Boolean)
					.join("|") || "waiting";
		if (key === this.availability && (!planChanged || input.playing))
			return false;
		this.availability = key;
		this.snapshots.clear();
		return true;
	}
	private observe(video: HTMLVideoElement) {
		const sourceUrl = video.src,
			hasFrameCallback = typeof video.requestVideoFrameCallback === "function";
		let handle: number | undefined;
		const observation = {
			sourceUrl,
			hasFrameCallback,
			mediaTime: null as number | null,
			dispose: () => {
				if (handle !== undefined) video.cancelVideoFrameCallback?.(handle);
				for (const event of ["seeking", "loadstart", "emptied", "error"])
					video.removeEventListener(event, reset);
				video.removeEventListener("seeked", fallback);
				video.removeEventListener("loadeddata", fallback);
			},
		};
		const reset = () => {
			observation.mediaTime = null;
		};
		const fallback = () => {
			if (!hasFrameCallback && !video.seeking && video.readyState >= 2)
				observation.mediaTime = video.currentTime;
		};
		const request = () => {
			if (!hasFrameCallback) return;
			handle = video.requestVideoFrameCallback((_now, metadata) => {
				if (this.observers.get(video) !== observation) return;
				observation.mediaTime =
					video.src === sourceUrl &&
					video.currentSrc === sourceUrl &&
					Number.isFinite(metadata.mediaTime)
						? metadata.mediaTime
						: null;
				request();
			});
		};
		this.observers.set(video, observation);
		for (const event of ["seeking", "loadstart", "emptied", "error"])
			video.addEventListener(event, reset);
		video.addEventListener("seeked", fallback);
		video.addEventListener("loadeddata", fallback);
		request();
	}
	clear() {
		for (const observer of this.observers.values()) observer.dispose();
		this.observers.clear();
		this.snapshots.clear();
		this.input = undefined;
		this.availability = "";
		this.pending = undefined;
	}
}
