import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { CloudProgress } from "./cloud-progress";
import type { VmafComputeTaskSummary } from "./vmaf-shared";

const task: VmafComputeTaskSummary = {
	id: "current-task",
	profileId: "test",
	state: "RUNNING",
	reservedUsd: 1,
	createdAt: new Date().toISOString(),
	cleanedAt: null,
	error: null,
	current: true,
	attempt: 2,
	provisioningModel: "SPOT",
	progress: {
		phase: "SCORING",
		framesProcessed: 250,
		totalFrames: 1000,
		updatedAt: "2020-01-01T00:00:00Z",
	},
};
it("shows scoring-only progress, capacity, retry attempt and stale updates", () => {
	renderWithQuery(
		<CloudProgress
			tasks={[{ ...task, id: "old-task", current: false }, task]}
		/>,
	);
	expect(screen.getByText("Frames 250/1000 (25.0%)")).toBeInTheDocument();
	expect(screen.getByText("Spot")).toBeInTheDocument();
	expect(screen.getByText("Attempt 2")).toBeInTheDocument();
	expect(screen.getByText(/Awaiting an update/)).toBeInTheDocument();
	expect(screen.queryByText("old-task")).not.toBeInTheDocument();
});
it("does not turn alignment into a percentage and hides finished jobs", () => {
	const { rerender } = renderWithQuery(
		<CloudProgress
			tasks={[
				{
					...task,
					progress: {
						phase: "ALIGNMENT",
						updatedAt: "2020-01-01T00:00:00Z",
						framesProcessed: 250,
						totalFrames: 1000,
					},
				},
			]}
		/>,
		"ja",
	);
	expect(screen.getByText("フレーム対応を検査中")).toBeInTheDocument();
	expect(screen.queryByText(/25.0%/)).not.toBeInTheDocument();
	rerender(<CloudProgress tasks={[task]} active={false} />);
	expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("marks unchanged progress stale without waiting for a new API payload and stops its clock when inactive", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
	const interval = vi.spyOn(globalThis, "setInterval");
	const clear = vi.spyOn(globalThis, "clearInterval");
	try {
		const tasks: VmafComputeTaskSummary[] = [
			{
				...task,
				progress: {
					phase: "SCORING",
					updatedAt: new Date().toISOString(),
					framesProcessed: 250,
					totalFrames: 1000,
				},
			},
		];
		const { rerender, unmount } = renderWithQuery(
			<CloudProgress tasks={tasks} />,
		);
		expect(screen.queryByText(/Awaiting an update/)).not.toBeInTheDocument();
		const clockIndex = interval.mock.calls.findIndex(
			([, delay]) => delay === 15_000,
		);
		expect(clockIndex).toBeGreaterThanOrEqual(0);
		const clock = interval.mock.results[clockIndex]?.value;
		act(() => vi.advanceTimersByTime(135_000));
		expect(screen.getByText(/Awaiting an update/)).toBeInTheDocument();
		expect(screen.getByText("Frames 250/1000 (25.0%)")).toBeInTheDocument();
		rerender(<CloudProgress tasks={tasks} active={false} />);
		expect(clear).toHaveBeenCalledWith(clock);
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
		unmount();
	} finally {
		interval.mockRestore();
		clear.mockRestore();
		vi.useRealTimers();
	}
});
