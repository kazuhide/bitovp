import { DEFAULT_FEATURE_FLAGS } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import type { MoqHeartbeatPoint } from "@/lib/moq-player/heartbeat";
import type { MoqObservationSession } from "@/lib/moq-player/observations";
import type {
	MoqPlaybackDescriptor,
	MoqPlayerFactory,
} from "@/lib/moq-player/types";
import { renderWithQuery } from "@/test/render";
import { MoqPlayerPreview } from "./moq-player-preview";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	operation: vi.fn(),
	load: vi.fn(),
	history: vi.fn(),
	historyRead: vi.fn(),
	observation: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	apiFetch: (path: string, init?: RequestInit) => {
		if (!path.includes("/moq-observations")) return mocks.api(path, init);
		const runId = path.split("/runs/")[1]?.split("/")[0];
		if (init?.method === "PUT") {
			const value = JSON.parse(String(init.body));
			const session = {
				...value,
				id: path.split("/").at(-1),
				createdAt: value.startedAt,
				updatedAt: value.startedAt,
				archive: null,
			};
			return Promise.resolve(mocks.observation(session)).then(() => ({
				runId,
				session,
			}));
		}
		return Promise.resolve(mocks.historyRead(runId, init?.signal));
	},
}));
vi.mock("@/lib/moq-player/loader", () => ({ loadMoqPlayer: mocks.load }));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const NEXT = "00000000-0000-4000-8000-000000000003";
const ORG = "00000000-0000-4000-8000-000000000010";
const inputHeartbeatPoint: MoqHeartbeatPoint = {
	observedAt: "2026-11-20T00:00:00.000Z",
	sampledAt: null,
	source: "poll",
	ingestStatus: "CONNECTED",
	ingestHealthy: true,
	videoIncomingBitrateBps: 2_000_000,
	audioIncomingBitrateBps: null,
	videoFps: null,
	droppedPacketsVideo: null,
	droppedPacketsAudio: null,
	corruptPacketsVideo: null,
	corruptPacketsAudio: null,
	segmentProcessingMeanMs: null,
	segmentProcessingMinMs: null,
	segmentProcessingMaxMs: null,
};
const descriptor: MoqPlaybackDescriptor = {
	runId: RUN,
	encodingId: "00000000-0000-4000-8000-000000000004",
	playerLicenseKey: "SYNTHETIC_PLAYER_SECRET",
	resource: {
		type: "moq",
		url: "https://relay.example.test/SYNTHETIC_SUBSCRIBE_SECRET",
		metadata: {
			namespace: "owned-run",
			catalogTrackName: "catalog",
			draftVersion: 18,
			mediaTypes: ["audio", "video"],
		},
	},
};
let video: HTMLVideoElement;
let frames = 0;
let factory: ReturnType<typeof vi.fn<MoqPlayerFactory>>;
const source = {
	setTargetBufferLevel: vi.fn(),
	setVolume: vi.fn(),
	play: vi.fn(),
};
const player = { sources: { add: vi.fn(), remove: vi.fn() }, dispose: vi.fn() };
const view = (runId = RUN, active = true, standalone = false) => (
	<DocumentOrganizationContext.Provider value={ORG}>
		<MoqPlayerPreview
			channelId={CHANNEL}
			runId={runId}
			active={active}
			standalone={standalone}
		/>
	</DocumentOrganizationContext.Provider>
);
const analyticsView = (runId = RUN, active = true) => (
	<FeatureFlagsProvider
		flags={{ ...DEFAULT_FEATURE_FLAGS, operationAnalytics: true }}
	>
		{view(runId, active)}
	</FeatureFlagsProvider>
);
const operationEvents = () =>
	mocks.operation.mock.calls.map(([, init]) => JSON.parse(init.body));

function DuringCommit({ action }: { action: () => void }) {
	useLayoutEffect(action, [action]);
	return null;
}

beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"getLatency",
		"getBufferLevel",
		"getVideoQuality",
		"getAvailableVideoQualities",
		"setVideoQuality",
	])
		Reflect.deleteProperty(source, key);
	vi.stubGlobal("WebTransport", class {});
	vi.stubGlobal("fetch", mocks.operation);
	mocks.operation.mockResolvedValue({ ok: true });
	frames = 0;
	source.play.mockResolvedValue(undefined);
	player.sources.add.mockReturnValue(source);
	player.dispose.mockResolvedValue(undefined);
	factory = vi.fn(({ defaultContainer }) => {
		video = document.createElement("video");
		Object.defineProperties(video, {
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
		});
		Object.assign(video, {
			getVideoPlaybackQuality: () => ({
				totalVideoFrames: frames,
				droppedVideoFrames: 0,
			}),
		});
		defaultContainer.append(video);
		return player;
	});
	mocks.load.mockResolvedValue(factory);
	mocks.api.mockResolvedValue(descriptor);
	mocks.historyRead.mockImplementation((runId) => ({
		runId,
		sessions: mocks.history(runId) ?? [],
		heartbeat: {
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
		},
	}));
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("MoQ playback operation analytics", () => {
	it("records click-to-first-frame once and waits for the start acknowledgement without delaying playback", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		let acknowledge!: (response: { ok: boolean }) => void;
		mocks.operation.mockReturnValueOnce(
			new Promise((resolve) => {
				acknowledge = resolve;
			}),
		);
		renderWithQuery(analyticsView());
		expect(mocks.operation).not.toHaveBeenCalled();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
		});
		expect(source.play).toHaveBeenCalledOnce();
		expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(
			"/api/operation-attempts",
			expect.objectContaining({
				method: "POST",
				keepalive: true,
				headers: expect.objectContaining({
					"content-type": "application/json",
					"x-bitovp-expected-org": ORG,
				}),
			}),
		);
		const identity = {
			operation: "LIVE_MOQ_PLAYBACK",
			attemptId: expect.stringMatching(
				/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/,
			),
			channelId: CHANNEL,
			runId: RUN,
		};
		expect(operationEvents()).toEqual([{ ...identity, stage: "STARTED" }]);
		const [{ attemptId }] = operationEvents();
		act(() => {
			vi.advanceTimersByTime(1234);
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(screen.getByRole("status")).toHaveTextContent(
			"Video frames received",
		);
		expect(mocks.operation).toHaveBeenCalledOnce();
		await act(async () => {
			vi.advanceTimersByTime(50);
			acknowledge({ ok: true });
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		});
		expect(operationEvents()).toEqual([
			{ ...identity, attemptId, stage: "STARTED" },
			{ ...identity, attemptId, stage: "FIRST_FRAME", elapsedMs: 1234 },
		]);
	});

	it("does not record an inactive choice and records an unsupported explicit Play as a failure", async () => {
		const { rerender } = renderWithQuery(analyticsView(RUN, false));
		fireEvent.click(screen.getByRole("button", { name: "Play", hidden: true }));
		expect(mocks.operation).not.toHaveBeenCalled();
		rerender(analyticsView());
		vi.stubGlobal("WebTransport", undefined);
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(screen.getByRole("status")).toHaveTextContent(
			"MoQ playback unavailable",
		);
		const [started, result] = operationEvents();
		expect(operationEvents()).toHaveLength(2);
		expect(started.stage).toBe("STARTED");
		expect(result).toEqual({
			...started,
			stage: "FAILED",
			elapsedMs: expect.any(Number),
		});
		expect(mocks.api).not.toHaveBeenCalled();
	});

	it("records a playback setup failure before any first frame", async () => {
		mocks.load.mockRejectedValueOnce(new Error(descriptor.resource.url));
		renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback failed",
		);
		const [started, result] = operationEvents();
		expect(operationEvents()).toHaveLength(2);
		expect(started.stage).toBe("STARTED");
		expect(result).toEqual({
			...started,
			stage: "FAILED",
			elapsedMs: expect.any(Number),
		});
	});

	it("cancels the replaced run while ignoring a stale video callback", async () => {
		const { rerender } = renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		const previousVideo = video;
		const [started] = operationEvents();
		rerender(analyticsView(NEXT));
		act(() => {
			frames = 3;
			previousVideo.currentTime = 1;
			previousVideo.dispatchEvent(new Event("timeupdate"));
		});
		await waitFor(() => expect(mocks.operation).toHaveBeenCalledTimes(2));
		expect(operationEvents()).toEqual([
			started,
			{ ...started, stage: "CANCELED", elapsedMs: expect.any(Number) },
		]);
		expect(screen.getByRole("status")).toHaveTextContent("Not playing");
		frames = 0;
		mocks.api.mockResolvedValue({ ...descriptor, runId: NEXT });
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		const nextStarted = operationEvents().at(-1);
		expect(nextStarted).toMatchObject({ stage: "STARTED", runId: NEXT });
		expect(nextStarted.attemptId).not.toBe(started.attemptId);
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(operationEvents()).toHaveLength(4);
		expect(operationEvents().at(-1)).toEqual({
			...nextStarted,
			stage: "CANCELED",
			elapsedMs: expect.any(Number),
		});
	});

	it("records cancellation when the preview closes before descriptor work begins", async () => {
		const rendered = renderWithQuery(analyticsView());
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			rendered.unmount();
		});
		const [started, result] = operationEvents();
		expect(operationEvents()).toHaveLength(2);
		expect(started.stage).toBe("STARTED");
		expect(result).toEqual({
			...started,
			stage: "CANCELED",
			elapsedMs: expect.any(Number),
		});
		expect(mocks.api).not.toHaveBeenCalled();
	});

	it.each([
		{ runId: RUN, active: false, event: "timeupdate" },
		{ runId: NEXT, active: true, event: "error" },
	])("settles cancellation before a stale $event during commit", async ({
		runId,
		active,
		event,
	}) => {
		const rendered = renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		const previousVideo = video;
		await act(async () => {
			rendered.rerender(
				<>
					{analyticsView(runId, active)}
					<DuringCommit
						action={() => {
							frames = 3;
							previousVideo.currentTime = 1;
							previousVideo.dispatchEvent(new Event(event));
						}}
					/>
				</>,
			);
		});
		const [started, result] = operationEvents();
		expect(started.stage).toBe("STARTED");
		expect(result).toEqual({
			...started,
			stage: "CANCELED",
			elapsedMs: expect.any(Number),
		});
		expect(operationEvents()).toHaveLength(2);
	});

	it("dispatches one keepalive cancellation during pagehide if start is acknowledged", async () => {
		const rendered = renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		const [started] = operationEvents();
		window.dispatchEvent(new Event("pagehide"));
		expect(operationEvents()).toEqual([
			started,
			{ ...started, stage: "CANCELED", elapsedMs: expect.any(Number) },
		]);
		expect(mocks.operation.mock.calls.at(-1)?.[1].keepalive).toBe(true);
		window.dispatchEvent(new Event("pagehide"));
		rendered.unmount();
		expect(mocks.operation).toHaveBeenCalledTimes(2);
	});

	it("sends a pagehide cancellation after start acknowledgement if the document is still running", async () => {
		let acknowledge!: (response: { ok: boolean }) => void;
		mocks.operation.mockReturnValueOnce(
			new Promise((resolve) => {
				acknowledge = resolve;
			}),
		);
		const rendered = renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		const [started] = operationEvents();
		window.dispatchEvent(new Event("pagehide"));
		rendered.unmount();
		expect(mocks.operation).toHaveBeenCalledOnce();
		await act(async () => acknowledge({ ok: true }));
		expect(operationEvents()).toEqual([
			started,
			{ ...started, stage: "CANCELED", elapsedMs: expect.any(Number) },
		]);
	});

	it("continues playback when the start request throws and skips sending its result", async () => {
		mocks.operation.mockImplementationOnce(() => {
			throw new Error("operation start unavailable");
		});
		renderWithQuery(analyticsView());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(source.play).toHaveBeenCalledOnce();
		await act(async () => {
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(mocks.operation).toHaveBeenCalledOnce();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Video frames received",
		);
	});
});

describe("explicit MoQ preview", () => {
	it("shows ready playback rather than stopped when the run first becomes active", async () => {
		const { rerender } = renderWithQuery(view(RUN, false));
		expect(
			screen.getByRole("button", { name: "Play", hidden: true }),
		).toBeDisabled();
		rerender(view(RUN, true));
		expect(await screen.findByRole("button", { name: "Play" })).toBeEnabled();
		expect(screen.getByRole("status")).toHaveTextContent("Not playing");
	});
	it("keeps idle capture bookkeeping out of the primary player view", () => {
		renderWithQuery(view());
		expect(
			screen.getByText("Recording waits for received video"),
		).not.toBeVisible();
		expect(screen.getByText("Observations have not started")).not.toBeVisible();
		expect(screen.getByText("Analytics not configured")).not.toBeVisible();
		expect(screen.queryByText("Decoded frames")).toBeNull();
	});
	it("passes the document organization to the native asset loader and exposes a safe initialization phase", async () => {
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		expect(mocks.load).toHaveBeenCalledWith(ORG);
		expect(rendered.container.querySelector("#moq-preview")).toHaveAttribute(
			"data-moq-phase",
			"waiting",
		);
	});
	it("prioritizes saved history on an ended run and collapses the empty live player without detaching its host", async () => {
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		const liveHost = rendered.container.querySelector(
			`[data-moq-live-host="${RUN}"]`,
		);
		await act(async () => {
			rendered.rerender(view(RUN, false));
		});
		const saved = rendered.container.querySelector(
			`[data-moq-history="${RUN}"]`,
		);
		expect(saved).toBeVisible();
		expect(
			rendered.container.querySelector(`[data-moq-live-host="${RUN}"]`),
		).toBe(liveHost);
		expect(liveHost).not.toBeVisible();
		expect(liveHost?.closest("details")).not.toHaveAttribute("open");
		expect(saved?.compareDocumentPosition(liveHost as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});
	it("drops previously visible encoder telemetry when a later read is forbidden", async () => {
		mocks.historyRead.mockResolvedValueOnce({
			runId: RUN,
			sessions: [],
			heartbeat: {
				source: "live-encoder-heartbeat",
				points: [inputHeartbeatPoint],
				truncated: false,
			},
		});
		const { client, container } = renderWithQuery(view());
		const encoder = container.querySelector("[data-moq-encoder-history]");
		await waitFor(() => {
			expect(
				encoder?.querySelector('[data-moq-chart="inputBitrate"]'),
			).toBeVisible();
		});

		mocks.historyRead.mockRejectedValueOnce(
			Object.assign(new Error("Forbidden"), { status: 403 }),
		);
		await act(async () => {
			await client.invalidateQueries({
				queryKey: ["moq-observations", CHANNEL, RUN],
			});
		});
		expect(
			await screen.findByText("Could not load saved observations"),
		).toBeVisible();
		expect(encoder?.querySelector("[data-moq-chart]")).toBeNull();
		expect(encoder?.querySelector("time")).toBeNull();
	});

	it("aborts a stalled live read and promptly loads independent ended history", async () => {
		let liveSignal: AbortSignal | undefined;
		mocks.historyRead.mockImplementationOnce((_run, signal: AbortSignal) => {
			liveSignal = signal;
			return new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		});
		const { rerender } = renderWithQuery(view());
		await waitFor(() => expect(liveSignal).toBeDefined());

		rerender(view(RUN, false));
		expect(
			await screen.findByText("No saved playback observations"),
		).toBeVisible();
		expect(liveSignal?.aborted).toBe(true);
		expect(mocks.historyRead).toHaveBeenCalledTimes(2);
	});

	it("refreshes just-cached archive history when the live run ends", async () => {
		const { client, container, rerender } = renderWithQuery(null);
		client.setDefaultOptions({
			queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
		});
		const oldHistory = {
			runId: RUN,
			sessions: [],
			heartbeat: {
				source: "live-encoder-heartbeat",
				points: [],
				truncated: false,
			},
		};
		client.setQueryData(["moq-observations", CHANNEL, RUN], oldHistory);
		const liveHistory = {
			...oldHistory,
			heartbeat: { ...oldHistory.heartbeat, points: [inputHeartbeatPoint] },
		};
		const startedAt = inputHeartbeatPoint.observedAt;
		const endedAt = "2026-11-20T00:00:01.000Z";
		const archived: MoqObservationSession = {
			id: NEXT,
			startedAt,
			endedAt,
			createdAt: startedAt,
			updatedAt: endedAt,
			samples: [],
			events: [
				{ elapsedMs: 0, type: "first-frame" },
				{ elapsedMs: 1000, type: "ended" },
			],
			archive: {
				contentType: "video/webm",
				bytes: 100,
				sha256: "a".repeat(64),
				durationMs: 1000,
				recordedAt: endedAt,
			},
		};
		mocks.historyRead
			.mockResolvedValueOnce(liveHistory)
			.mockResolvedValueOnce({ ...liveHistory, sessions: [archived] });

		rerender(view());
		await waitFor(() => {
			expect(
				container.querySelector("[data-moq-encoder-history] time"),
			).toHaveAttribute("datetime", startedAt);
		});
		expect(mocks.historyRead).toHaveBeenCalledTimes(1);

		rerender(view(RUN, false));
		await waitFor(() => expect(mocks.historyRead).toHaveBeenCalledTimes(2), {
			timeout: 1000,
		});
		await waitFor(() => {
			expect(
				container.querySelector("video[data-moq-archive]"),
			).toHaveAttribute("data-moq-archive", archived.id);
		});
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.observation).not.toHaveBeenCalled();
	});

	it.each([
		{ standalone: false, commits: true },
		{ standalone: true, commits: true },
		{ standalone: true, commits: false },
	])("reconciles an uncertain recording after the run ends ($standalone, $commits)", async ({
		standalone,
		commits,
	}) => {
		vi.useFakeTimers();
		const upload = vi.fn().mockRejectedValue(new TypeError("Connection lost"));
		vi.stubGlobal("fetch", upload);
		class Recorder extends EventTarget {
			static isTypeSupported = () => true;
			state = "inactive";
			start() {
				this.state = "recording";
			}
			stop() {
				this.state = "inactive";
				this.dispatchEvent(
					Object.assign(new Event("dataavailable"), {
						data: new Blob(["WebM test recording"]),
					}),
				);
				this.dispatchEvent(new Event("stop"));
			}
		}
		vi.stubGlobal("MediaRecorder", Recorder);
		let session: MoqObservationSession | undefined;
		let committed = false;
		mocks.observation.mockImplementation((value) => {
			session = value;
		});
		mocks.history.mockImplementation((runId) => {
			if (runId !== RUN || !session) return [];
			return [
				{
					...session,
					archive: committed
						? {
								contentType: "video/webm",
								bytes: 100,
								sha256: "a".repeat(64),
								durationMs: 1_000,
								recordedAt: session.startedAt,
							}
						: null,
				},
			];
		});
		const rendered = renderWithQuery(view(RUN, true, standalone));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
		});
		expect(source.play).toHaveBeenCalledOnce();
		Object.assign(video, {
			captureStream: () => ({
				getTracks: () => [{ stop: vi.fn() }],
				getVideoTracks: () => [{}],
			}),
		});
		act(() => {
			vi.advanceTimersByTime(100);
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		await act(async () => {
			rendered.rerender(view(RUN, false, standalone));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(upload).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining(
				`/runs/${RUN}/moq-observations/${session?.id}/archive`,
			),
			expect.objectContaining({ method: "PUT" }),
		);
		const history = rendered.container.querySelector(
			`[data-moq-history="${RUN}"]`,
		);
		expect(history).toHaveTextContent("Recording save could not be confirmed");
		expect(history).not.toHaveTextContent("No received-video recording");
		expect(history?.querySelector("video")).toBeNull();

		// The first refetch was too early. The saved result can appear later.
		committed = commits;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		if (commits) {
			expect(history?.querySelector("video")).toHaveAttribute(
				"data-moq-archive",
				session?.id,
			);
			expect(history).not.toHaveTextContent(
				"Recording save could not be confirmed",
			);
		}
		const reads = mocks.history.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(80_000);
		});
		if (commits) {
			expect(mocks.history).toHaveBeenCalledTimes(reads);
		} else {
			expect(mocks.history.mock.calls.length).toBeGreaterThan(reads);
			expect(history).toHaveTextContent(
				"Recording save could not be confirmed",
			);
		}
		const finalReads = mocks.history.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(80_000);
		});
		expect(mocks.history).toHaveBeenCalledTimes(finalReads);
	});
	it("shows configured MoQ metadata and measured video statistics, then resets measurements on Stop", async () => {
		vi.useFakeTimers();
		Object.assign(source, {
			getLatency: () => 0.3,
			getBufferLevel: () => 1.5,
			getVideoQuality: () => ({ name: "360p", width: 640, height: 360 }),
			getAvailableVideoQualities: () => [
				{ name: "360p", width: 640, height: 360 },
			],
		});
		renderWithQuery(view());
		expect(screen.getByRole("region", { name: "MoQ playback" })).toBeVisible();
		expect(
			document.querySelector(
				'[data-moq-live-metrics] [data-moq-chart="segmentProcessing"]',
			),
		).toHaveTextContent("Waiting for data");
		expect(
			document.querySelector("[data-moq-viewer-metrics] figure"),
		).toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
		});
		expect(source.play).toHaveBeenCalledOnce();
		act(() => {
			vi.advanceTimersByTime(100);
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
			vi.advanceTimersByTime(900);
		});
		expect(
			screen.getByText("Configured namespace").nextElementSibling,
		).toHaveTextContent("owned-run");
		expect(
			screen.getByText("Configured draft").nextElementSibling,
		).toHaveTextContent("18");
		expect(document.querySelector("[data-moq-resolution]")).toHaveTextContent(
			"640×360",
		);
		expect(
			document.querySelector(
				'[data-moq-live-metrics] [data-moq-chart="latencyMs"]',
			),
		).toHaveTextContent("300 ms");
		expect(
			document.querySelector(
				'[data-moq-live-metrics] [data-moq-chart="bufferSeconds"]',
			),
		).toHaveTextContent("1.50 s");
		expect(screen.getByLabelText("Target buffer (ms)")).toHaveValue(2000);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		});
		expect(document.querySelector("[data-moq-resolution]")).toBeNull();
		expect(
			document.querySelector("[data-moq-viewer-metrics] figure"),
		).toBeNull();
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_");
	});
	it("applies a target before Play and changes it on the same source during playback", async () => {
		const user = userEvent.setup();
		renderWithQuery(view());
		await user.click(screen.getByText("Playback settings", { exact: false }));
		const target = screen.getByRole("spinbutton", {
			name: "Target buffer (ms)",
		});
		const apply = screen.getByRole("button", { name: "Apply" });
		await user.clear(target);
		await user.type(target, "750");
		await user.click(apply);
		expect(source.setTargetBufferLevel).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => {
			expect(source.setTargetBufferLevel).toHaveBeenCalledExactlyOnceWith(0.75);
		});
		expect(source.setTargetBufferLevel).toHaveBeenCalledBefore(source.play);
		await user.clear(target);
		await user.type(target, "1250");
		await user.click(apply);
		expect(source.setTargetBufferLevel).toHaveBeenLastCalledWith(1.25);
		expect(factory).toHaveBeenCalledOnce();
		expect(player.sources.remove).not.toHaveBeenCalled();
		expect(source.play).toHaveBeenCalledOnce();
		await user.clear(target);
		await user.click(apply);
		expect(source.setTargetBufferLevel).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("alert")).toHaveTextContent("whole number");
		fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
			target: { value: "50" },
		});
		expect(target).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("alert")).toHaveTextContent("whole number");
		await user.click(screen.getByRole("button", { name: "Stop" }));
		await user.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => {
			expect(source.setTargetBufferLevel.mock.calls).toEqual([
				[0.75],
				[1.25],
				[1.25],
			]);
		});
	});
	it("adjusts audio and follows the full SDK quality catalog without frame telemetry", async () => {
		vi.useFakeTimers();
		const low = { name: "video/360p", width: 640, height: 360 };
		const high = { name: "video/720p", width: 1280, height: 720 };
		const qualities = [
			low,
			...Array.from({ length: 16 }, (_, index) => ({
				name: `video/alternate-${index}`,
				width: 640,
				height: 360,
			})),
			high,
		];
		let currentQuality = low;
		const setVideoQuality = vi.fn((quality: typeof low) => {
			currentQuality = quality;
		});
		// An SDK can render a canvas that this browser cannot mirror for measurement.
		factory.mockImplementationOnce(({ defaultContainer }) => {
			defaultContainer.append(document.createElement("canvas"));
			return player;
		});
		Object.assign(source, {
			getVideoQuality: () => currentQuality,
			getAvailableVideoQualities: () => qualities,
			setVideoQuality,
		});
		renderWithQuery(view());
		fireEvent.click(screen.getByText("Playback settings", { exact: false }));
		expect(
			screen.queryByRole("combobox", { name: "Video quality" }),
		).toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
		});
		expect(source.setVolume).toHaveBeenCalledExactlyOnceWith(0);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
			target: { value: "35" },
		});
		expect(source.setVolume).toHaveBeenLastCalledWith(0.35);
		const quality = screen.getByRole("combobox", { name: "Video quality" });
		expect(quality).toHaveValue(low.name);
		expect(quality.querySelectorAll("option")).toHaveLength(19);
		fireEvent.change(quality, {
			target: { value: high.name },
		});
		expect(setVideoQuality).toHaveBeenCalledOnce();
		expect(setVideoQuality.mock.calls[0]?.[0]).toBe(high);
		expect(quality).toHaveValue(high.name);
		currentQuality = low;
		act(() => vi.advanceTimersByTime(1000));
		expect(quality).toHaveValue(low.name);
		fireEvent.change(quality, { target: { value: high.name } });
		expect(setVideoQuality).toHaveBeenCalledTimes(2);
		expect(source.play).toHaveBeenCalledOnce();
		expect(player.sources.remove).not.toHaveBeenCalled();
	});
	it("starts rendering while the first history receipt and Analytics collector are pending", async () => {
		let acknowledge!: () => void;
		mocks.observation.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				acknowledge = resolve;
			}),
		);
		mocks.api.mockResolvedValue({
			...descriptor,
			analytics: {
				licenseKey: "SYNTHETIC_ANALYTICS_SECRET",
				licenseKeySha256: "a".repeat(64),
				videoId: `bitovp-moq:${descriptor.encodingId}:${RUN}`,
				collectorVersion: "2.62.0",
				latencyField: "customData1",
			},
		});
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		const collector = document.querySelector("[data-bitovp-moq-analytics]");
		expect(collector).toBeInTheDocument();
		expect(
			rendered.container.querySelector(
				'[data-moq-playback-stage="subscribe-requested"]',
			),
		).toBeInTheDocument();

		const capture = vi.fn(() => {
			throw new Error("test video has no supported recorder");
		});
		Object.assign(video, { captureStream: capture });
		vi.stubGlobal("MediaRecorder", class {});
		act(() => {
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(rendered.container.querySelector("#moq-preview")).toHaveAttribute(
			"data-moq-phase",
			"frames",
		);
		expect(
			rendered.container.querySelector(
				'[data-moq-playback-stage="first-frame"]',
			),
		).toBeInTheDocument();
		expect(capture).not.toHaveBeenCalled();
		await act(async () => acknowledge());
		expect(capture).toHaveBeenCalledOnce();

		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(player.dispose).toHaveBeenCalledOnce());
		expect(collector).not.toBeInTheDocument();
		expect(
			mocks.observation.mock.calls
				.at(-1)?.[0]
				.events.map((event: { type: string }) => event.type),
		).toEqual([
			"started",
			"descriptor-ready",
			"subscribe-requested",
			"first-frame",
			"stopped",
		]);
	});

	it("starts only on Play, keeps secrets out of the DOM and waits for actual video progress", async () => {
		renderWithQuery(view());
		expect(mocks.api).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		expect(mocks.api).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL}/runs/${RUN}/moq-playback`,
			expect.objectContaining({
				cache: "no-store",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(screen.getByRole("status")).toHaveTextContent("Waiting for video");
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_");
		await waitFor(() => expect(video.muted).toBe(true));
		const capture = vi.fn(() => {
			throw new Error(descriptor.resource.url);
		});
		Object.assign(video, { captureStream: capture });
		vi.stubGlobal("MediaRecorder", class {});
		expect(capture).not.toHaveBeenCalled();
		act(() => {
			frames = 3;
			video.currentTime = 1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(screen.getByRole("status")).toHaveTextContent(
			"Video frames received",
		);
		expect(capture).toHaveBeenCalledOnce();
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(player.dispose).toHaveBeenCalledOnce());
		expect(player.sources.remove).toHaveBeenCalledExactlyOnceWith(source);
		expect(screen.getByRole("status")).toHaveTextContent("Stopped");
		expect(mocks.operation).not.toHaveBeenCalled();
	});
	it("shows a fixed error on loader failure and allows a fresh explicit retry", async () => {
		mocks.load.mockRejectedValueOnce(new Error(descriptor.resource.url));
		renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback failed",
		);
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_");
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
	});
	it("does not fetch a bearer descriptor for an unsupported browser or inactive run", async () => {
		const rendered = renderWithQuery(view(RUN, false));
		expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
		rendered.rerender(view());
		vi.stubGlobal("WebTransport", undefined);
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(await screen.findByRole("status")).toHaveTextContent(
			"MoQ playback unavailable",
		);
		expect(mocks.api).not.toHaveBeenCalled();
	});
	it("aborts pending descriptor work on run change and requires Play for the new run", async () => {
		let resolve!: (value: MoqPlaybackDescriptor) => void;
		mocks.api.mockReturnValueOnce(
			new Promise<MoqPlaybackDescriptor>((done) => {
				resolve = done;
			}),
		);
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		const call = mocks.api.mock.calls.at(0);
		if (!call) throw new Error("expected descriptor request");
		const signal = call[1].signal as AbortSignal;
		rendered.rerender(view(NEXT));
		expect(signal.aborted).toBe(true);
		await act(async () => {
			resolve(descriptor);
		});
		expect(factory).not.toHaveBeenCalled();
		expect(screen.getByRole("status")).toHaveTextContent("Not playing");
		mocks.api.mockResolvedValue({ ...descriptor, runId: NEXT });
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
	});
	it("ignores a loader resolving after unmount", async () => {
		let resolve!: (value: MoqPlayerFactory) => void;
		mocks.load.mockReturnValue(
			new Promise<MoqPlayerFactory>((done) => {
				resolve = done;
			}),
		);
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
		rendered.unmount();
		await act(async () => {
			resolve(factory);
		});
		expect(factory).not.toHaveBeenCalled();
	});
	it("disposes the previous playing source when the run changes", async () => {
		const rendered = renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		rendered.rerender(view(NEXT));
		await waitFor(() => expect(player.dispose).toHaveBeenCalledOnce());
		expect(player.sources.remove).toHaveBeenCalledOnce();
		expect(screen.getByRole("status")).toHaveTextContent("Not playing");
	});
	it("refuses a descriptor from a different run before loading player code", async () => {
		mocks.api.mockResolvedValue({ ...descriptor, runId: NEXT });
		renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback failed",
		);
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("shows a safe failure when player cleanup rejects instead of claiming it stopped", async () => {
		player.dispose.mockRejectedValue(new Error(descriptor.resource.url));
		renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback failed",
		);
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_");
	});
	it("keeps keyboard focus on the playback control through Play and pending Stop", async () => {
		const user = userEvent.setup();
		let release!: () => void;
		player.dispose.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		renderWithQuery(view());

		await user.tab();
		expect(screen.getByRole("button", { name: "Play" })).toHaveFocus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();

		await user.keyboard("{Enter}");
		expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
		await act(async () => release());
		expect(await screen.findByRole("button", { name: "Play" })).toHaveFocus();
	});

	it("leaves focus where the operator moved it while stopping playback", async () => {
		const user = userEvent.setup();
		let release!: () => void;
		player.dispose.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		renderWithQuery(view());
		await user.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		await user.click(screen.getByRole("button", { name: "Stop" }));
		const link = screen.getByRole("link", { name: "Open player" });
		await user.tab();
		expect(link).toHaveFocus();

		await act(async () => release());
		await screen.findByRole("button", { name: "Play" });
		expect(link).toHaveFocus();
	});

	it("keeps Stop disabled while its owned disposal is pending and preserves a deferred failure", async () => {
		let reject!: (error: Error) => void;
		player.dispose.mockReturnValue(
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			}),
		);
		renderWithQuery(view());
		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(screen.getByRole("status")).not.toHaveTextContent("Stopped");
		await act(async () => {
			reject(new Error(descriptor.resource.url));
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback failed",
		);
		expect(player.dispose).toHaveBeenCalledOnce();
	});
});
