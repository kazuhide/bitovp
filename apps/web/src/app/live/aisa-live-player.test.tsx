import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";

const mocks = vi.hoisted(() => ({
	thumbnail: vi.fn(),
	instances: [] as unknown[],
}));
vi.mock("./aisa-live-player-thumbnail", () => ({
	requestAisaThumbnail: mocks.thumbnail,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "users",
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));
vi.mock("hls.js", () => {
	class FakeHls {
		static isSupported = () => true;
		static Events = {
			MANIFEST_PARSED: "manifest",
			LEVEL_UPDATED: "level",
			ERROR: "error",
		};
		listeners = new Map<string, (_event: string, data: unknown) => void>();
		loadSource = vi.fn();
		attachMedia = vi.fn();
		startLoad = vi.fn();
		destroy = vi.fn();
		constructor() {
			mocks.instances.push(this);
		}
		on(event: string, callback: (_event: string, data: unknown) => void) {
			this.listeners.set(event, callback);
		}
		emit(event: string, data: unknown) {
			this.listeners.get(event)?.(event, data);
		}
	}
	return { default: FakeHls };
});

import { AisaMomentPreview } from "./aisa-live-player";

const props = {
	accountId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	analysisId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
	encodingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	mediaTimeOriginUnixMs: 1790000000000,
	moment: {
		id: "moment-a",
		lastUpdatedSequence: 1,
		importanceLevel: 1,
		startInSeconds: 12,
		endInSeconds: 18,
		anchorInSeconds: 15,
		observations: [],
		categories: [],
	},
	labels: {
		play: "Play moment",
		pause: "Pause moment",
		replay: "Replay moment",
		loading: "Loading recording",
		unavailable: "Recording range unavailable",
		failed: "Recording failed",
		seek: "Seek inside moment",
		mute: "Mute",
		unmute: "Unmute",
		thumbnailAlt: "Moment thumbnail",
	},
};
type FakeInstance = {
	emit(event: string, data: unknown): void;
	loadSource: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	mocks.instances.length = 0;
	mocks.thumbnail.mockResolvedValue("data:image/jpeg;base64,synthetic");
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("moment recording preview", () => {
	it("requests the anchor thumbnail through an organization-bound local URL", async () => {
		renderLocalized(<AisaMomentPreview {...props} />);
		await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledOnce());
		const source = mocks.thumbnail.mock.calls[0]?.[0];
		expect(source.time).toBe(15);
		expect(source.url).toContain(
			`/api/live/analyses/${props.analysisId}/recording?`,
		);
		expect(source.url).toContain(`encodingId=${props.encodingId}`);
		expect(source.url).toContain(
			"expectedOrganizationId=00000000-0000-4000-8000-000000000001",
		);
		expect(source.url).not.toContain("storage.googleapis.com");
	});

	it("plays only the mapped interval, clamps the seek control, and pauses at its end", async () => {
		const user = userEvent.setup();
		const rendered = renderLocalized(<AisaMomentPreview {...props} />);
		const video = rendered.container.querySelector("video");
		if (!video) throw new Error("Video unavailable");
		let paused = true;
		Object.defineProperties(video, {
			readyState: { value: 2 },
			paused: { get: () => paused },
		});
		vi.spyOn(video, "pause").mockImplementation(() => {
			paused = true;
		});
		vi.spyOn(video, "play").mockImplementation(async () => {
			paused = false;
		});
		await user.click(screen.getByRole("button", { name: "Play moment" }));
		await waitFor(() => expect(mocks.instances).toHaveLength(1));
		const instance = mocks.instances[0] as FakeInstance;
		act(() =>
			instance.emit("level", {
				details: {
					fragments: [
						{
							start: 0,
							programDateTime: props.mediaTimeOriginUnixMs + 10000,
							duration: 5,
						},
						{
							start: 5,
							programDateTime: props.mediaTimeOriginUnixMs + 15000,
							duration: 5,
						},
					],
				},
			}),
		);
		expect(video.currentTime).toBe(2);
		expect(paused).toBe(false);
		const seek = screen.getByRole("slider", { name: "Seek inside moment" });
		fireEvent.change(seek, { target: { value: "6" } });
		expect(video.currentTime).toBeLessThan(8);
		act(() => {
			video.currentTime = 8.1;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(paused).toBe(true);
		expect(video.currentTime).toBeLessThan(8);
		expect(
			screen.getByRole("button", { name: "Replay moment" }),
		).toBeInTheDocument();
		rendered.unmount();
		expect(instance.destroy).toHaveBeenCalledOnce();
	});

	it("does not play a moment whose full recording range is absent", async () => {
		const user = userEvent.setup();
		const rendered = renderLocalized(<AisaMomentPreview {...props} />);
		const video = rendered.container.querySelector("video");
		if (!video) throw new Error("Video unavailable");
		const play = vi.spyOn(video, "play").mockResolvedValue();
		await user.click(screen.getByRole("button", { name: "Play moment" }));
		await waitFor(() => expect(mocks.instances).toHaveLength(1));
		act(() =>
			(mocks.instances[0] as FakeInstance).emit("level", {
				details: {
					fragments: [
						{
							start: 0,
							programDateTime: props.mediaTimeOriginUnixMs + 10000,
							duration: 5,
						},
					],
				},
			}),
		);
		expect(screen.getByText("Recording range unavailable")).toBeInTheDocument();
		expect(play).not.toHaveBeenCalled();
	});
});
