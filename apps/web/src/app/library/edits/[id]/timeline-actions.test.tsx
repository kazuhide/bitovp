import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { TimelineActions } from "./timeline-actions";

function setup(
	options: { frame?: number; selected?: number; blocked?: boolean } = {},
) {
	const project = editingProjectFixture();
	const first = project.draft.clips[0];
	if (!first) throw new Error("Missing fixture clip");
	first.framing = [
		{
			fromFrame: 0,
			toFrame: 300,
			mode: "CROP",
			origin: "MANUAL",
			manualOverride: true,
			rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
		},
	];
	project.draft.clips.push({
		...first,
		id: "77777777-7777-4777-8777-777777777777",
		sourceInUs: 20_000_000,
		timelineStartFrame: 300,
	});
	const onChange = vi.fn();
	const onSelectClip = vi.fn();
	const view = renderLocalized(
		<TimelineActions
			document={project.draft}
			map={project.media.timeMap}
			positionFrame={options.frame ?? 150}
			selectedClipId={project.draft.clips[options.selected ?? 0]?.id ?? null}
			blocked={options.blocked ?? false}
			onChange={onChange}
			onSelectClip={onSelectClip}
		/>,
	);
	return { project, onChange, onSelectClip, view };
}

it("splits the playhead range even when another range is selected, preserving framing and source", () => {
	const { project, onChange, onSelectClip } = setup({ selected: 1 });
	fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
	const result = onChange.mock.calls[0]?.[0];
	expect(result.clips).toHaveLength(3);
	expect(
		result.clips.map((clip: { durationFrames: number }) => clip.durationFrames),
	).toEqual([150, 150, 300]);
	expect(result.clips[1]).toMatchObject({
		sourceInUs: 5_000_000,
		timelineStartFrame: 150,
		framing: [
			{ fromFrame: 0, toFrame: 150, mode: "CROP", manualOverride: true },
		],
	});
	expect(result.clips[2]).toEqual({
		...project.draft.clips[1],
		timelineStartFrame: 300,
	});
	expect(onSelectClip).toHaveBeenCalledWith(result.clips[1].id);
});

it("moves and removes the selected range rather than the range under the playhead", () => {
	const { project, onChange } = setup({ selected: 1, frame: 0 });
	fireEvent.click(
		screen.getByRole("button", { name: "Move selected range earlier" }),
	);
	expect(
		onChange.mock.calls[0]?.[0].clips.map((clip: { id: string }) => clip.id),
	).toEqual([project.draft.clips[1]?.id, project.draft.clips[0]?.id]);
	fireEvent.click(
		screen.getByRole("button", { name: "Remove selected range" }),
	);
	expect(onChange.mock.calls[1]?.[0].clips).toEqual([project.draft.clips[0]]);
});

it("keeps every editing action blocked while a gesture or numeric range is pending", () => {
	const { onChange } = setup({ selected: 1, blocked: true });
	for (const name of [
		"Split at playhead",
		"Move selected range earlier",
		"Move selected range later",
		"Remove selected range",
	]) {
		const button = screen.getByRole("button", { name });
		expect(button).toBeDisabled();
		fireEvent.click(button);
	}
	expect(onChange).not.toHaveBeenCalled();
});

it("does not split at a range boundary or remove the only range", () => {
	const { project, onChange, onSelectClip, view } = setup({ frame: 300 });
	expect(
		screen.getByRole("button", { name: "Split at playhead" }),
	).toBeDisabled();
	project.draft.clips = project.draft.clips.slice(0, 1);
	view.rerender(
		<TimelineActions
			document={project.draft}
			map={project.media.timeMap}
			positionFrame={0}
			selectedClipId={null}
			blocked={false}
			onChange={onChange}
			onSelectClip={onSelectClip}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "Remove selected range" }),
	).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Move selected range earlier" }),
	).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Move selected range later" }),
	).toBeDisabled();
});
