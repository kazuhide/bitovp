import { MOQ_OBSERVATION_LIMITS as LIMITS } from "./observations";

export type MoqRecordingState =
	| "idle"
	| "recording"
	| "saving"
	| "saved"
	| "unsupported"
	| "empty"
	| "failed"
	| "unavailable";
type Options = {
	upload(blob: Blob, durationMs: number, signal: AbortSignal): Promise<void>;
	onState(state: MoqRecordingState): void;
};
/** Capture only the supplied, owned received-video element. No input substitution. */
export function createMoqRecording(video: HTMLVideoElement, options: Options) {
	const capture = Reflect.get(video, "captureStream");
	if (typeof capture !== "function" || typeof MediaRecorder !== "function") {
		options.onState("unsupported");
		return { finish: () => Promise.resolve() };
	}
	let stream: MediaStream | undefined;
	let recorder: MediaRecorder;
	try {
		stream = capture.call(video) as MediaStream;
		if (!stream.getVideoTracks().length) throw new Error();
		const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find((type) =>
			MediaRecorder.isTypeSupported(type),
		);
		if (!mimeType) throw new Error();
		recorder = new MediaRecorder(stream, {
			mimeType,
			videoBitsPerSecond: 1_000_000,
			audioBitsPerSecond: 96_000,
		});
	} catch {
		for (const track of stream?.getTracks() ?? []) {
			try {
				track.stop();
			} catch {
				/* Owned capture cleanup. */
			}
		}
		options.onState("unsupported");
		return { finish: () => Promise.resolve() };
	}
	const ownedStream = stream;
	const started = performance.now();
	const abort = new AbortController();
	let chunks: Blob[] = [];
	let bytes = 0;
	let failed = false;
	let settled = false;
	let finalizing = false;
	let durationMs: number | undefined;
	let deadline: number | undefined;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const done = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void done.catch(() => {});
	const maximum = window.setTimeout(() => {
		void finish().catch(() => {});
	}, LIMITS.archiveDurationMs);
	function cleanup() {
		window.clearTimeout(maximum);
		if (deadline !== undefined) window.clearTimeout(deadline);
		for (const track of ownedStream.getTracks()) {
			try {
				track.stop();
			} catch {
				/* Own tracks only. */
			}
		}
		chunks = [];
	}
	function completeFailure() {
		if (settled) return;
		settled = true;
		abort.abort();
		cleanup();
		options.onState("failed");
		reject(new Error("MoQ recording failed"));
	}
	function ensureDeadline() {
		if (deadline === undefined)
			deadline = window.setTimeout(completeFailure, 5000);
	}
	async function finalize() {
		if (finalizing || settled) return;
		finalizing = true;
		ensureDeadline();
		if (failed) {
			completeFailure();
			return;
		}
		if (bytes === 0) {
			settled = true;
			cleanup();
			options.onState("empty");
			resolve();
			return;
		}
		try {
			options.onState("saving");
			await options.upload(
				new Blob(chunks, { type: "video/webm" }),
				durationMs ??
					Math.max(
						1,
						Math.min(
							LIMITS.archiveDurationMs,
							Math.round(performance.now() - started),
						),
					),
				abort.signal,
			);
			if (settled) return;
			settled = true;
			cleanup();
			options.onState("saved");
			resolve();
		} catch {
			completeFailure();
		}
	}
	function finish(): Promise<void> {
		if (settled || finalizing || durationMs !== undefined) return done;
		durationMs = Math.max(
			1,
			Math.min(
				LIMITS.archiveDurationMs,
				Math.round(performance.now() - started),
			),
		);
		ensureDeadline();
		try {
			if (recorder.state !== "inactive") recorder.stop();
		} catch {
			completeFailure();
		}
		return done;
	}
	recorder.addEventListener("dataavailable", (event: BlobEvent) => {
		if (settled || failed || !event.data.size) return;
		if (bytes + event.data.size > LIMITS.archiveBytes) {
			failed = true;
			void finish().catch(() => {});
			return;
		}
		bytes += event.data.size;
		chunks.push(event.data);
	});
	recorder.addEventListener("stop", () => {
		void finalize();
	});
	recorder.addEventListener("error", () => {
		failed = true;
		void finish().catch(() => {});
	});
	try {
		recorder.start(1000);
		options.onState("recording");
	} catch {
		completeFailure();
	}
	return { finish };
}
