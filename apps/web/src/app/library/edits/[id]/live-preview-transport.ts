import { type PreviewPlan, previewLocation } from "../preview-model";

export type PreviewPhase =
	| "unavailable"
	| "loading"
	| "buffering"
	| "paused"
	| "playing"
	| "ended"
	| "error";
export type PreviewSnapshot = {
	phase: PreviewPhase;
	frame: number;
	playing: boolean;
	muted: boolean;
	clipMuted: boolean;
	loop: boolean;
	rate: number;
};
type Callbacks = {
	onFrameChange: (frame: number) => void;
	onDraw: (frame: number, plan: PreviewPlan) => void;
	onSnapshot: (state: PreviewSnapshot) => void;
};
type Seek = {
	frame: number;
	source: number;
	notify: boolean;
	ending: boolean;
	force: boolean;
};

/** One native decoder, one generation, and explicit playback intent. */
export class LivePreviewTransport {
	private plan: PreviewPlan | null = null;
	private frame = 0;
	private phase: PreviewPhase = "unavailable";
	private desired = false;
	private blocked = false;
	private visible = true;
	private dead = false;
	private epoch = 0;
	private playEpoch = -1;
	private pending: Seek | null = null;
	private callback: { id: number; native: boolean } | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private propFrame = Number.NaN;
	private pauseSignal = 0;
	private seekSignal = 0;
	private echoes = new Set<number>();
	private lastNotified = -1;
	private muted = true;
	private loop = false;
	private rate = 1;
	private listeners: [string, EventListener][] = [];

	constructor(
		private video: HTMLVideoElement,
		private callbacks: Callbacks,
	) {
		this.listen("loadedmetadata", () => {
			this.seekVideo();
			this.settle();
		});
		for (const name of ["loadeddata", "seeked", "canplay"])
			this.listen(name, () => {
				if (this.pending) this.settle();
				else if (this.desired && !this.video.paused) {
					this.clearDeadline();
					this.publish("playing");
					this.arm();
				}
			});
		for (const name of ["waiting", "stalled"])
			this.listen(name, () => {
				if (this.desired) {
					this.publish("buffering");
					this.deadline();
				}
			});
		this.listen("error", () => {
			if (this.video.error) this.fail();
		});
		this.listen("ended", () => {
			if (!this.video.ended || this.pending || this.video.seeking) return;
			this.nextClip();
		});
		this.listen("pause", () => {
			// Native EOF dispatches pause before ended; retain the playback intent.
			if (
				this.desired &&
				!this.pending &&
				this.video.paused &&
				!this.video.ended
			)
				this.pause(false);
		});
		this.listen("play", () => {
			if (
				!this.desired ||
				this.pending ||
				this.blocked ||
				!this.visible ||
				this.dead
			)
				this.stopVideo();
		});
	}
	private listen(name: string, handler: EventListener) {
		this.listeners.push([name, handler]);
		this.video.addEventListener(name, handler);
	}
	private stopVideo() {
		if (!this.video.paused) this.video.pause();
	}
	private clearDeadline() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
	private deadline() {
		this.clearDeadline();
		if (!this.visible) return;
		const epoch = this.epoch;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.dead && epoch === this.epoch) this.fail();
		}, 15_000);
	}
	private cancelPump() {
		if (this.callback?.native)
			this.video.cancelVideoFrameCallback?.(this.callback.id);
		else if (this.callback) cancelAnimationFrame(this.callback.id);
		this.callback = null;
	}
	private invalidate() {
		this.epoch++;
		this.playEpoch = -1;
		this.cancelPump();
		this.clearDeadline();
	}
	private publish(phase = this.phase) {
		this.phase = phase;
		if (this.dead) return;
		const item = this.plan?.clips.find((c) => this.frame < c.outputTo);
		this.callbacks.onSnapshot({
			phase,
			frame: this.frame,
			playing: this.desired,
			muted: this.muted,
			clipMuted: item?.clip.audio.mode === "MUTE",
			loop: this.loop,
			rate: this.rate,
		});
	}
	private notify(force = false) {
		if (!force && this.frame === this.lastNotified) return;
		this.lastNotified = this.frame;
		if (this.frame !== this.propFrame) {
			this.echoes.add(this.frame);
			if (this.echoes.size > 64) {
				const first = this.echoes.values().next().value;
				if (first !== undefined) this.echoes.delete(first);
			}
		}
		this.callbacks.onFrameChange(this.frame);
	}
	private paint(frame: number, notify: boolean, force = false) {
		if (!this.plan || this.dead) return false;
		try {
			this.frame = previewLocation(this.plan, frame).frame;
			this.video.muted =
				this.muted ||
				!this.desired ||
				previewLocation(this.plan, this.frame).muted;
			this.callbacks.onDraw(this.frame, this.plan);
			if (notify) this.notify(force);
			this.publish();
			return true;
		} catch {
			this.fail();
			return false;
		}
	}
	update(
		plan: PreviewPlan | null,
		frame: number,
		blocked: boolean,
		pauseSignal = 0,
		seekSignal = 0,
	) {
		if (this.dead) return;
		const changed =
			plan?.document !== this.plan?.document ||
			plan?.sourceKey !== this.plan?.sourceKey;
		const wasBlocked = this.blocked;
		const signalChanged = pauseSignal !== this.pauseSignal;
		const seekChanged = seekSignal !== this.seekSignal;
		this.seekSignal = seekSignal;
		this.pauseSignal = pauseSignal;
		this.blocked = blocked;
		this.plan = plan;
		const requested = plan ? previewLocation(plan, frame).frame : 0;
		const propChanged = requested !== this.propFrame;
		const echo = propChanged && this.echoes.has(requested);
		if (echo)
			for (const value of this.echoes) {
				this.echoes.delete(value);
				if (value === requested) break;
			}
		this.propFrame = requested;
		if (!plan) {
			this.pause(false);
			this.publish("unavailable");
			return;
		}
		if (changed || seekChanged || (propChanged && !echo)) {
			this.echoes.clear();
			this.beginSeek(requested, false, false);
		} else if ((blocked && !wasBlocked) || signalChanged) this.pause(false);
	}
	private beginSeek(
		frame: number,
		resume: boolean,
		notify: boolean,
		ending = false,
		force = false,
	) {
		if (!this.plan || this.dead) return;
		this.invalidate();
		this.stopVideo();
		const point = previewLocation(this.plan, frame);
		this.frame = point.frame;
		this.desired = resume && !this.blocked && this.visible;
		this.pending = {
			frame: point.frame,
			source: point.sourceFrame,
			notify,
			ending,
			force,
		};
		this.video.muted = true;
		this.publish(this.video.readyState < 1 ? "loading" : "buffering");
		this.deadline();
		this.seekVideo();
		this.settle();
	}
	private seekVideo() {
		if (!this.pending || this.video.readyState < 1) return;
		try {
			if (Math.abs(this.video.currentTime - this.pending.source / 30) > 1e-7)
				this.video.currentTime = this.pending.source / 30;
		} catch {
			this.fail();
			return;
		}
		this.arm();
	}
	private settle() {
		const pending = this.pending;
		if (
			!pending ||
			this.video.readyState < 2 ||
			this.video.seeking ||
			Math.abs(this.video.currentTime * 30 - pending.source) > 0.25
		)
			return;
		this.pending = null;
		this.clearDeadline();
		this.cancelPump();
		if (!this.paint(pending.frame, pending.notify, pending.force)) return;
		if (this.desired) this.startNativePlay();
		else this.publish(pending.ending ? "ended" : "paused");
	}
	private startNativePlay() {
		if (
			!this.plan ||
			!this.desired ||
			this.blocked ||
			!this.visible ||
			this.dead ||
			this.playEpoch === this.epoch
		)
			return;
		const epoch = this.epoch;
		this.playEpoch = epoch;
		this.video.muted =
			this.muted || previewLocation(this.plan, this.frame).muted;
		this.video.playbackRate = this.rate;
		this.arm();
		try {
			Promise.resolve(this.video.play()).then(
				() => {
					if (this.dead || !this.desired || this.blocked || !this.visible) {
						this.stopVideo();
						return;
					}
					if (epoch !== this.epoch) {
						if (this.pending) this.stopVideo();
						return;
					}
					this.clearDeadline();
					this.publish("playing");
					this.arm();
				},
				() => {
					if (!this.dead && epoch === this.epoch && this.desired) this.fail();
				},
			);
		} catch {
			if (epoch === this.epoch) this.fail();
		}
	}
	private arm() {
		if (
			this.callback ||
			this.dead ||
			!this.visible ||
			(!this.pending && !this.desired) ||
			this.video.readyState < 1
		)
			return;
		const epoch = this.epoch;
		if (typeof this.video.requestVideoFrameCallback === "function") {
			const id = this.video.requestVideoFrameCallback((_time, metadata) => {
				if (
					epoch !== this.epoch ||
					this.dead ||
					this.callback?.id !== id ||
					!this.callback.native
				)
					return;
				this.callback = null;
				this.present(Math.round(metadata.mediaTime * 30));
				this.arm();
			});
			this.callback = { id, native: true };
		} else {
			const id = requestAnimationFrame(() => {
				if (
					epoch !== this.epoch ||
					this.dead ||
					this.callback?.id !== id ||
					this.callback.native
				)
					return;
				this.callback = null;
				this.present(Math.floor(this.video.currentTime * 30 + 1e-6));
				this.arm();
			});
			this.callback = { id, native: false };
		}
	}
	private present(sourceFrame: number) {
		if (this.pending) {
			if (sourceFrame === this.pending.source) this.settle();
			return;
		}
		if (!this.plan || !this.desired || this.video.seeking) return;
		let index = previewLocation(this.plan, this.frame).clipIndex;
		let item = this.plan.clips[index];
		if (!item || sourceFrame < item.sourceFrom) return;
		while (sourceFrame >= item.sourceTo) {
			const next = this.plan.clips[++index];
			if (!next) {
				this.finish();
				return;
			}
			if (next.sourceFrom !== item.sourceTo) {
				this.beginSeek(next.outputFrom, true, true);
				return;
			}
			item = next;
		}
		this.clearDeadline();
		this.phase = "playing";
		this.paint(item.outputFrom + sourceFrame - item.sourceFrom, true);
	}
	private nextClip() {
		if (!this.plan || !this.desired) return;
		const item =
			this.plan.clips[previewLocation(this.plan, this.frame).clipIndex];
		if (!item || this.video.currentTime * 30 + 0.25 < item.sourceTo) {
			this.fail();
			return;
		}
		const next =
			this.plan.clips[previewLocation(this.plan, this.frame).clipIndex + 1];
		if (next) this.beginSeek(next.outputFrom, true, true);
		else this.finish();
	}
	private finish() {
		if (this.plan)
			this.beginSeek(
				this.loop ? 0 : this.plan.total - 1,
				this.loop,
				true,
				!this.loop,
			);
	}
	play() {
		if (
			!this.plan ||
			this.blocked ||
			!this.visible ||
			this.dead ||
			this.phase === "error"
		)
			return;
		this.desired = true;
		if (this.pending) {
			this.pending.notify = true;
			this.pending.force = true;
			this.publish();
			return;
		}
		if (this.frame >= this.plan.total - 1) this.beginSeek(0, true, true);
		else {
			this.notify(true);
			this.publish("buffering");
			this.deadline();
			this.startNativePlay();
		}
	}
	pause(notify = true) {
		const pending = this.pending;
		const failed = this.phase === "error";
		this.invalidate();
		this.desired = false;
		this.video.muted = true;
		this.stopVideo();
		if (pending && this.visible) {
			pending.notify = notify;
			pending.force = notify;
			this.publish(this.video.readyState < 1 ? "loading" : "buffering");
			this.deadline();
			this.seekVideo();
			this.settle();
		} else {
			this.pending = null;
			if (notify && this.plan) this.notify(true);
			this.publish(failed ? "error" : this.plan ? "paused" : "unavailable");
		}
	}
	seek(frame: number) {
		if (this.plan && !this.blocked && this.visible && !this.dead)
			this.beginSeek(frame, false, true, false, true);
	}
	step(delta: number) {
		this.seek(this.frame + delta);
	}
	toggle() {
		if (this.desired) this.pause();
		else this.play();
	}
	setMuted(value: boolean) {
		this.muted = value;
		this.video.muted =
			value ||
			!this.desired ||
			this.pending !== null ||
			(this.plan ? previewLocation(this.plan, this.frame).muted : true);
		this.publish();
	}
	setLoop(value: boolean) {
		this.loop = value;
		this.publish();
	}
	setRate(value: number) {
		if (![0.5, 1, 2].includes(value)) return;
		this.rate = value;
		this.video.playbackRate = value;
		this.publish();
	}
	setVisible(value: boolean) {
		if (value === this.visible) return;
		this.visible = value;
		if (!value) this.pause(false);
		else if (this.plan && this.phase !== "error")
			this.beginSeek(this.frame, false, false);
	}
	retry() {
		if (!this.plan || this.blocked || this.dead) return;
		this.pause(false);
		try {
			this.video.load();
			this.beginSeek(this.frame, false, false);
		} catch {
			this.fail();
		}
	}
	private fail() {
		this.invalidate();
		this.pending = null;
		this.desired = false;
		this.video.muted = true;
		this.stopVideo();
		this.publish("error");
	}
	destroy() {
		this.dead = true;
		this.invalidate();
		this.desired = false;
		this.pending = null;
		this.video.muted = true;
		this.stopVideo();
		for (const [name, handler] of this.listeners)
			this.video.removeEventListener(name, handler);
		this.listeners = [];
		this.echoes.clear();
	}
}
