import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	PlaybackControl,
	PlaybackSnapshot,
} from "../jobs/[id]/playback-control";
import { synchronizePlayback } from "./synchronize-playback";

function output(time = 0, duration = 120) {
	const state: PlaybackSnapshot = {
		time,
		duration,
		paused: true,
		ready: true,
		ended: false,
		failed: false,
	};
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	let gate: Promise<void> | undefined;
	let notifyPlay = true;
	const control: PlaybackControl = {
		read: () => ({ ...state }),
		play: vi.fn(async () => {
			await gate;
			state.paused = false;
			if (notifyPlay) notify();
		}),
		pause: vi.fn(() => {
			if (!state.paused) {
				state.paused = true;
				notify();
			}
		}),
		seek: vi.fn((seconds) => {
			state.time = seconds;
			if (seconds < state.duration) state.ended = false;
			notify();
		}),
		mute: vi.fn(),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		qualities: () => [],
		selectQuality: () => false,
	};
	return {
		control,
		state,
		change: (patch: Partial<PlaybackSnapshot>) => {
			Object.assign(state, patch);
			notify();
		},
		gate: (value: Promise<void>) => {
			gate = value;
		},
		quietPlay: () => {
			notifyPlay = false;
		},
	};
}
afterEach(() => vi.useRealTimers());

describe("synchronized output playback", () => {
	it("prefers advertised 2160p over larger adaptive renditions", () => {
		const left = output();
		const right = output();
		left.control.qualities = () => [
			{ id: "8k", height: 4320 },
			{ id: "4k", height: 2160 },
			{ id: "hd", height: 1080 },
		];
		left.control.selectQuality = vi.fn(() => true);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		expect(left.control.selectQuality).toHaveBeenCalledWith("4k");
		expect(right.control.qualities()).toEqual([]);
		sync.dispose();
	});
	it("restarts both ended outputs at their shared beginning", async () => {
		const left = output(120);
		const right = output(120);
		left.change({ ended: true });
		right.change({ ended: true });
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		try {
			await sync.play();
			expect(left.state.time).toBe(0);
			expect(right.state.time).toBe(0);
			expect(left.state.paused || right.state.paused).toBe(false);
		} finally {
			sync.dispose();
		}
	});
	it("plays and pauses both outputs with only the selected side audible", async () => {
		const left = output();
		const right = output();
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		await sync.play();
		expect(left.state.paused).toBe(false);
		expect(right.state.paused).toBe(false);
		expect(left.control.mute).toHaveBeenLastCalledWith(false);
		expect(right.control.mute).toHaveBeenLastCalledWith(true);
		sync.audio("right");
		expect(left.control.mute).toHaveBeenLastCalledWith(true);
		expect(right.control.mute).toHaveBeenLastCalledWith(false);
		sync.pause();
		expect(left.state.paused && right.state.paused).toBe(true);
		sync.dispose();
	});
	it("seeks both outputs inside their common duration", () => {
		const left = output(0, 100);
		const right = output(0, 80);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		sync.seek(32.5);
		expect(left.state.time).toBe(32.5);
		expect(right.state.time).toBe(32.5);
		sync.seek(95);
		expect(left.state.time).toBeLessThanOrEqual(80);
		expect(right.state.time).toBe(left.state.time);
		sync.dispose();
	});
	it("corrects follower drift without chasing differences below 150 ms", async () => {
		vi.useFakeTimers();
		const left = output(10);
		const right = output(9.9);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		await sync.play();
		vi.advanceTimersByTime(250);
		expect(right.control.seek).not.toHaveBeenCalled();
		right.change({ time: 9 });
		vi.advanceTimersByTime(250);
		expect(right.state.time).toBe(10);
		expect(left.control.seek).not.toHaveBeenCalled();
		sync.dispose();
	});
	it("holds both during follower buffering and resumes when both are ready", async () => {
		const left = output(10);
		const right = output(10);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		await sync.play();
		right.change({ ready: false });
		expect(left.state.paused && right.state.paused).toBe(true);
		expect(sync.read().status).toBe("waiting");
		right.change({ ready: true });
		await vi.waitFor(() =>
			expect(left.state.paused || right.state.paused).toBe(false),
		);
		sync.dispose();
	});
	it.each([
		"failed",
		"ended",
	] as const)("stops both outputs when one is %s", async (field) => {
		const left = output();
		const right = output();
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		await sync.play();
		right.change({ [field]: true });
		expect(left.state.paused && right.state.paused).toBe(true);
		expect(sync.read().status).toBe(field === "failed" ? "failed" : "ready");
		sync.dispose();
	});
	it.each([
		"pause",
		"dispose",
	] as const)("fences late play completion after %s", async (action) => {
		const left = output();
		const right = output();
		let release = () => {};
		right.gate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		const playing = sync.play();
		sync[action]();
		release();
		await playing;
		expect(left.state.paused && right.state.paused).toBe(true);
		sync.dispose();
	});
	it("stops both if one play promise rejects", async () => {
		const left = output();
		const right = output();
		vi.mocked(right.control.play).mockRejectedValue(
			new Error("decode refused"),
		);
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		await sync.play();
		expect(left.state.paused && right.state.paused).toBe(true);
		expect(sync.read().status).toBe("failed");
		sync.dispose();
	});
	it("pauses each late output immediately while the other play promise is still pending", async () => {
		const left = output();
		const right = output();
		let releaseLeft = () => {};
		let releaseRight = () => {};
		left.gate(
			new Promise<void>((resolve) => {
				releaseLeft = resolve;
			}),
		);
		right.gate(
			new Promise<void>((resolve) => {
				releaseRight = resolve;
			}),
		);
		left.quietPlay();
		right.quietPlay();
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		const playing = sync.play();
		sync.pause();
		releaseLeft();
		try {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(left.state.paused).toBe(true);
			expect(right.state.paused).toBe(true);
		} finally {
			releaseRight();
			await playing;
			sync.dispose();
		}
	});
	it("contains synchronous play command failure and pauses the other output", async () => {
		const left = output();
		const right = output();
		vi.mocked(right.control.play).mockImplementation(() => {
			throw new Error("player unavailable");
		});
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		try {
			await expect(sync.play()).resolves.toBeUndefined();
			expect(sync.read().status).toBe("failed");
			expect(left.state.paused && right.state.paused).toBe(true);
		} finally {
			sync.dispose();
		}
	});
	it("contains synchronous seek failure and keeps both paused", () => {
		const left = output();
		const right = output();
		vi.mocked(right.control.seek).mockImplementation(() => {
			throw new Error("not seekable");
		});
		const sync = synchronizePlayback([left.control, right.control], vi.fn());
		try {
			expect(() => sync.seek(20)).not.toThrow();
			expect(sync.read().status).toBe("failed");
			expect(left.state.paused && right.state.paused).toBe(true);
		} finally {
			sync.dispose();
		}
	});
});
