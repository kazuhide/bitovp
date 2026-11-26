import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderLocalized } from "@/test/render";
import { PreviewMonitor } from "./preview-monitor";
import { previewTask } from "./test-fixtures";

const organizationId = "00000000-0000-4000-8000-000000000001";

it("seeks during active playback and does not feed rounded media time back into a seek", () => {
	const onPosition = vi.fn();
	const props = {
		task: previewTask(),
		stale: false,
		pending: false,
		mode: "sequence" as const,
		positionMs: 0,
		durationMs: 25_000,
		whole: false,
		fullAllowed: true,
		onMode: vi.fn(),
		onPosition,
		onSeek: vi.fn(),
		onWhole: vi.fn(),
		onError: vi.fn(),
	};
	const monitor = (positionMs: number) => (
		<DocumentOrganizationContext.Provider value={organizationId}>
			<PreviewMonitor {...props} positionMs={positionMs} />
		</DocumentOrganizationContext.Provider>
	);
	const { rerender } = renderLocalized(monitor(0));
	const video = screen.getByLabelText(
		"Input timeline preview",
	) as HTMLVideoElement;
	Object.defineProperty(video, "paused", { configurable: true, value: false });
	video.currentTime = 2;
	rerender(monitor(9000));
	expect(video.currentTime).toBe(9);
	let mediaTime = 9.1235;
	const seek = vi.fn((value: number) => {
		mediaTime = value;
	});
	Object.defineProperty(video, "currentTime", {
		configurable: true,
		get: () => mediaTime,
		set: seek,
	});
	fireEvent.timeUpdate(video);
	expect(onPosition).toHaveBeenLastCalledWith(9124);
	rerender(monitor(9124));
	expect(seek).not.toHaveBeenCalled();
});

it("binds native media to the document organization and refuses a URL without one", () => {
	const task = previewTask();
	const props = {
		task,
		stale: false,
		pending: false,
		mode: "sequence" as const,
		positionMs: 0,
		durationMs: 25_000,
		whole: false,
		fullAllowed: true,
		onMode: vi.fn(),
		onPosition: vi.fn(),
		onSeek: vi.fn(),
		onWhole: vi.fn(),
		onError: vi.fn(),
	};
	const { rerender } = renderLocalized(
		<DocumentOrganizationContext.Provider value={organizationId}>
			<PreviewMonitor {...props} />
		</DocumentOrganizationContext.Provider>,
	);
	expect(screen.getByLabelText("Input timeline preview")).toHaveAttribute(
		"src",
		`/api/vod/input-previews/${task.id}/content?expectedOrganizationId=${organizationId}`,
	);
	rerender(<PreviewMonitor {...props} />);
	expect(screen.getByLabelText("Input timeline preview")).not.toHaveAttribute(
		"src",
	);
	expect(screen.getByRole("button", { name: "Play / pause" })).toBeDisabled();
});
