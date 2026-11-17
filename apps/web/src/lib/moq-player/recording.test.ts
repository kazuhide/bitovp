import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoqRecording } from "./recording";

let recorder: FakeRecorder;
let finalChunk = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])]);
class FakeRecorder extends EventTarget {
	static isTypeSupported = () => true;
	state = "inactive";
	start = vi.fn(() => {
		this.state = "recording";
	});
	stop = vi.fn(() => {
		this.state = "inactive";
		this.emit(finalChunk);
		this.dispatchEvent(new Event("stop"));
	});
	constructor(_stream: MediaStream, _options: MediaRecorderOptions) {
		super();
		recorder = this;
	}
	emit(blob: Blob) {
		const event = new Event("dataavailable");
		Object.assign(event, { data: blob });
		this.dispatchEvent(event);
	}
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	finalChunk = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])]);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function videoFixture() {
	const video = document.createElement("video");
	const stop = vi.fn();
	const stream = { getTracks: () => [{ stop }], getVideoTracks: () => [{}] };
	const capture = vi.fn(() => stream);
	Object.assign(video, { captureStream: capture });
	return { video, stop, capture };
}
describe("received MoQ video recording", () => {
	it("captures only the supplied video, includes stop's final data, and waits for upload confirmation", async () => {
		const f = videoFixture();
		const upload = vi.fn().mockResolvedValue(undefined);
		const state = vi.fn();
		const recording = createMoqRecording(f.video, { upload, onState: state });
		expect(f.capture).toHaveBeenCalledOnce();
		expect(state).toHaveBeenLastCalledWith("recording");
		vi.advanceTimersByTime(1000);
		const done = recording.finish();
		expect(recording.finish()).toBe(done);
		await done;
		expect(upload).toHaveBeenCalledWith(
			expect.any(Blob),
			1000,
			expect.any(AbortSignal),
		);
		expect(upload.mock.calls[0]?.[0].size).toBe(finalChunk.size);
		expect(state).toHaveBeenLastCalledWith("saved");
		expect(f.stop).toHaveBeenCalledOnce();
	});
	it("marks unsupported capture explicitly without inventing an archive", async () => {
		const upload = vi.fn();
		const state = vi.fn();
		const recording = createMoqRecording(document.createElement("video"), {
			upload,
			onState: state,
		});
		await recording.finish();
		expect(state).toHaveBeenLastCalledWith("unsupported");
		expect(upload).not.toHaveBeenCalled();
	});
	it("releases its captured tracks if recorder construction fails", async () => {
		class BrokenRecorder {
			static isTypeSupported = () => true;
			constructor() {
				throw new Error("private-url");
			}
		}
		vi.stubGlobal("MediaRecorder", BrokenRecorder);
		const f = videoFixture();
		const recording = createMoqRecording(f.video, {
			upload: vi.fn(),
			onState: vi.fn(),
		});
		await recording.finish();
		expect(f.stop).toHaveBeenCalledOnce();
	});
	it("stops at 90 seconds and does not upload bytes beyond 16MiB", async () => {
		const f = videoFixture();
		const upload = vi.fn().mockResolvedValue(undefined);
		const state = vi.fn();
		const recording = createMoqRecording(f.video, { upload, onState: state });
		recorder.emit(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]));
		await expect(recording.finish()).rejects.toThrow(/^MoQ recording failed$/);
		expect(upload).not.toHaveBeenCalled();
		expect(state).toHaveBeenLastCalledWith("failed");
		const second = createMoqRecording(f.video, { upload, onState: state });
		vi.advanceTimersByTime(90_000);
		await second.finish();
		expect(recorder.stop).toHaveBeenCalledOnce();
	});
	it("aborts an upload that does not settle within the finalization budget", async () => {
		const f = videoFixture();
		const upload = vi.fn<
			(blob: Blob, durationMs: number, signal: AbortSignal) => Promise<void>
		>(() => new Promise<void>(() => {}));
		const state = vi.fn();
		const recording = createMoqRecording(f.video, { upload, onState: state });
		const done = recording.finish();
		vi.advanceTimersByTime(5001);
		await expect(done).rejects.toThrow(/^MoQ recording failed$/);
		expect(upload.mock.calls[0]?.[2].aborted).toBe(true);
		expect(f.stop).toHaveBeenCalledOnce();
		expect(state).toHaveBeenLastCalledWith("failed");
	});
});
