import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import type { MoqObservationSession } from "@/lib/moq-player/observations";
import type {
	MoqPlaybackDescriptor,
	MoqPlayerFactory,
} from "@/lib/moq-player/types";
import { renderWithQuery } from "@/test/render";
import { MoqPlayerPreview } from "./moq-player-preview";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	load: vi.fn(),
	history: vi.fn(),
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
		return Promise.resolve({
			runId,
			sessions: mocks.history(runId) ?? [],
			heartbeat: {
				source: "live-encoder-heartbeat",
				points: [],
				truncated: false,
			},
		});
	},
}));
vi.mock("@/lib/moq-player/loader", () => ({ loadMoqPlayer: mocks.load }));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const NEXT = "00000000-0000-4000-8000-000000000003";
const ORG = "00000000-0000-4000-8000-000000000010";
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
beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"getLatency",
		"getBufferLevel",
		"getVideoQuality",
		"getAvailableVideoQualities",
	])
		Reflect.deleteProperty(source, key);
	vi.stubGlobal("WebTransport", class {});
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
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
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
			document.querySelector("[data-moq-live-metrics] [data-moq-chart]"),
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
		expect(
			screen.getByText("Target buffer").nextElementSibling,
		).toHaveTextContent("2.00 s");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		});
		expect(document.querySelector("[data-moq-resolution]")).toBeNull();
		expect(
			document.querySelector("[data-moq-live-metrics] [data-moq-chart]"),
		).toBeNull();
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_");
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
		expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
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
