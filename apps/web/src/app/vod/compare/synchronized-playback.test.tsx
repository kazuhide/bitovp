import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type {
	PlaybackControl,
	PlaybackSnapshot,
} from "../jobs/[id]/playback-control";
import { SynchronizedPlayback } from "./synchronized-playback";

function device() {
	const state: PlaybackSnapshot = {
		time: 0,
		duration: 60,
		ready: true,
		paused: true,
		failed: false,
		ended: false,
	};
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const control: PlaybackControl = {
		read: () => ({ ...state }),
		play: vi.fn(async () => {
			state.paused = false;
			changed();
		}),
		pause: vi.fn(() => {
			if (!state.paused) {
				state.paused = true;
				changed();
			}
		}),
		seek: vi.fn((time) => {
			state.time = time;
			changed();
		}),
		mute: vi.fn(),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		qualities: () => [
			{ id: "hd", height: 1080 },
			{ id: "4k", height: 2160 },
		],
		selectQuality: vi.fn((id) => {
			state.qualityId = id || undefined;
			changed();
			return true;
		}),
	};
	return { state, control, changed };
}
let left = device();
let right = device();
let center = device();
vi.mock("../jobs/[id]/playback-surface", () => ({
	PlaybackSurface: ({
		url,
		onControl,
	}: {
		url: string;
		onControl: (control: PlaybackControl | null) => void;
	}) => {
		useEffect(() => {
			onControl(
				url.includes("left")
					? left.control
					: url.includes("center")
						? center.control
						: right.control,
			);
			return () => onControl(null);
		}, [url, onControl]);
		return <div data-testid="player-placeholder" />;
	},
}));
const outputs = [
	{
		jobId: "left",
		heading: <h2>Left output</h2>,
		link: {
			key: "hls",
			kind: "HLS",
			label: "HLS",
			url: "https://media.example.test/left.m3u8",
			path: "left.m3u8",
			via: "derived",
		},
	},
	{
		jobId: "right",
		heading: <h2>Right output</h2>,
		link: {
			key: "hls",
			kind: "HLS",
			label: "HLS",
			url: "https://media.example.test/right.m3u8",
			path: "right.m3u8",
			via: "derived",
		},
	},
] as const;
beforeEach(() => {
	left = device();
	right = device();
	center = device();
});

it("binds all three columns to common controls and center audio", async () => {
	const thirdOutput = {
		...outputs[1],
		jobId: "center",
		heading: <h2>Center output</h2>,
		link: { ...outputs[1].link, url: "https://media.example.test/center.m3u8" },
	};
	renderLocalized(
		<SynchronizedPlayback outputs={[outputs[0], thirdOutput, outputs[1]]} />,
	);
	const play = await screen.findByRole("button", { name: "Play together" });
	await waitFor(() => expect(play).toBeEnabled());
	expect(screen.getByLabelText("Video quality Center")).toHaveValue("4k");
	const user = userEvent.setup();
	await user.click(play);
	expect([left, center, right].every((device) => !device.state.paused)).toBe(
		true,
	);
	await user.selectOptions(screen.getByLabelText("Audio"), "center");
	expect(left.control.mute).toHaveBeenLastCalledWith(true);
	expect(center.control.mute).toHaveBeenLastCalledWith(false);
	expect(right.control.mute).toHaveBeenLastCalledWith(true);
	await user.click(screen.getByRole("button", { name: "Pause together" }));
	fireEvent.change(screen.getByLabelText("Playback position (seconds)"), {
		target: { value: "12.5" },
	});
	expect([left, center, right].map((device) => device.state.time)).toEqual([
		12.5, 12.5, 12.5,
	]);
});

it("binds common controls, advertised 4K selection and one audible side to both players", async () => {
	const view = renderLocalized(<SynchronizedPlayback outputs={outputs} />);
	const play = await screen.findByRole("button", { name: "Play both" });
	await waitFor(() => expect(play).toBeEnabled());
	expect(screen.getByLabelText("Video quality Left")).toHaveValue("4k");
	expect(screen.getByLabelText("Video quality Right")).toHaveValue("4k");
	const user = userEvent.setup();
	await user.click(play);
	expect(
		await screen.findByRole("button", { name: "Pause both" }),
	).toBeEnabled();
	expect(left.state.paused || right.state.paused).toBe(false);
	await user.selectOptions(screen.getByLabelText("Audio"), "right");
	expect(left.control.mute).toHaveBeenLastCalledWith(true);
	expect(right.control.mute).toHaveBeenLastCalledWith(false);
	await user.click(screen.getByRole("button", { name: "Pause both" }));
	fireEvent.change(screen.getByLabelText("Playback position (seconds)"), {
		target: { value: "12.5" },
	});
	expect(left.state.time).toBe(12.5);
	expect(right.state.time).toBe(12.5);
	await user.selectOptions(screen.getByLabelText("Video quality Left"), "hd");
	expect(left.control.selectQuality).toHaveBeenLastCalledWith("hd");
	expect(left.state.paused && right.state.paused).toBe(true);
	view.unmount();
	expect(left.control.pause).toHaveBeenCalled();
	expect(right.control.pause).toHaveBeenCalled();
});

it("keeps pause available while a follower buffers and shows automatic quality honestly", async () => {
	right.control.qualities = () => [];
	renderLocalized(<SynchronizedPlayback outputs={outputs} />);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled(),
	);
	expect(screen.getByLabelText("Video quality Right")).toHaveValue("");
	expect(screen.getByLabelText("Video quality Right")).toBeDisabled();
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Play both" }));
	act(() => {
		right.state.ready = false;
		right.changed();
	});
	expect(screen.getByText("Waiting for both outputs")).toBeVisible();
	expect(screen.getByRole("button", { name: "Pause both" })).toBeEnabled();
	expect(left.state.paused && right.state.paused).toBe(true);
	await user.click(screen.getByRole("button", { name: "Pause both" }));
	act(() => {
		right.state.ready = true;
		right.changed();
	});
	expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
	expect(left.state.paused && right.state.paused).toBe(true);
});
