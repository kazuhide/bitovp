import type { EditClip } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { expect, it, vi } from "vitest";
import type { EditingProjectView } from "@/lib/library-editing";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { ClipControls } from "./clip-controls";

type EarlyInput = { label: string; value: number };

function CommitInput({
	project,
	clip,
	input,
	onPending,
}: {
	project: EditingProjectView;
	clip: EditClip;
	input: EarlyInput | null;
	onPending: (id: string, value: boolean) => void;
}) {
	// Exercise the first input before child passive effects, then drain all
	// effects with await act. Waiting for those effects first would hide the race.
	useLayoutEffect(() => {
		if (!input) return;
		const element = screen.getByLabelText(input.label) as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!setter) throw new Error("Missing native input value setter");
		setter.call(element, String(input.value));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	}, [input]);
	return (
		<ClipControls
			clip={clip}
			index={0}
			count={1}
			media={project.media}
			canvas={project.draft.canvas}
			disabled={false}
			onChange={() => {}}
			onRange={() => {}}
			onSplit={() => {}}
			onPending={onPending}
			onMove={() => {}}
			onRemove={() => {}}
			onInspect={() => {}}
		/>
	);
}

const cases = (["mount", "trim", "undo"] as const).flatMap((stage) => [
	{ stage, label: "Out (seconds)", value: 5, pending: true },
	{ stage, label: "Split after frame", value: 100, pending: false },
]);

it("keeps framing and audio changes blocked until numeric bounds are applied or reset", async () => {
	const project = editingProjectFixture();
	const clip = project.draft.clips[0];
	if (!clip) throw new Error("Missing clip");
	await act(async () => {
		renderLocalized(
			<CommitInput
				project={project}
				clip={clip}
				input={{ label: "Out (seconds)", value: 5 }}
				onPending={() => {}}
			/>,
		);
	});
	expect(screen.getByLabelText("Audio")).toBeDisabled();
	expect(screen.getByLabelText("Framing")).toBeDisabled();
});

it.each(cases)("keeps $label input immediately after $stage commit", async ({
	stage,
	label,
	value,
	pending: expectedPending,
}) => {
	const project = editingProjectFixture();
	const initial = project.draft.clips[0];
	if (!initial) throw new Error("Missing clip");
	const changed: EditClip = {
		...initial,
		sourceInUs: 2_000_000,
		durationFrames: 180,
		framing: [{ fromFrame: 0, toFrame: 180, mode: "FIT", origin: "MANUAL" }],
	};
	const input = { label, value };
	const pending = vi.fn();
	function probe(clip: EditClip, editNow: boolean) {
		return (
			<CommitInput
				project={project}
				clip={clip}
				input={editNow ? input : null}
				onPending={pending}
			/>
		);
	}
	let mounted: ReturnType<typeof renderLocalized> | undefined;
	await act(async () => {
		mounted = renderLocalized(probe(initial, stage === "mount"));
	});
	if (!mounted) throw new Error("Missing mounted controls");
	const view = mounted;
	if (stage !== "mount")
		await act(async () => {
			view.rerender(probe(changed, stage === "trim"));
		});
	if (stage === "undo")
		await act(async () => {
			view.rerender(probe(initial, true));
		});
	expect(screen.getByLabelText(label)).toHaveValue(value);
	expect(screen.getByLabelText("In (seconds)")).toHaveValue(
		stage === "trim" ? 2 : 0,
	);
	if (expectedPending) {
		expect(screen.getByRole("button", { name: "Split range" })).toBeDisabled();
		expect(screen.getByLabelText("Split after frame")).toHaveValue(
			stage === "trim" ? 90 : 150,
		);
		expect(pending).toHaveBeenLastCalledWith(initial.id, true);
	} else {
		expect(screen.getByRole("button", { name: "Split range" })).toBeEnabled();
		expect(screen.getByLabelText("Out (seconds)")).toHaveValue(
			stage === "trim" ? 8 : 10,
		);
		expect(pending).not.toHaveBeenCalled();
	}
});

function CropControls({
	disabled = false,
	tiny = false,
	smallLandscape = false,
}: {
	disabled?: boolean;
	tiny?: boolean;
	smallLandscape?: boolean;
}) {
	const project = editingProjectFixture();
	const initial = project.draft.clips[0];
	if (!initial) throw new Error("Missing clip");
	const [clip, setClip] = useState<EditClip>({
		...initial,
		framing: [
			{ fromFrame: 0, toFrame: 150, mode: "FIT", origin: "MANUAL" },
			{
				fromFrame: 150,
				toFrame: 300,
				mode: "CROP",
				origin: "EDITOR_CONFIRMED",
				rect: smallLandscape
					? { x: 0, y: (1 - 1 / 960) / 2, w: 1, h: 1 / 960 }
					: tiny
						? { x: 0.21875, y: 0, w: 0.5625, h: 1 }
						: { x: 0.341796875, y: 0, w: 0.31640625, h: 1 },
			},
		],
	});
	return (
		<>
			<ClipControls
				clip={clip}
				index={0}
				count={1}
				media={
					smallLandscape
						? { ...project.media, width: 2, height: 1080 }
						: tiny
							? { ...project.media, width: 2, height: 2 }
							: project.media
				}
				canvas={
					smallLandscape ? { width: 1920, height: 1080 } : project.draft.canvas
				}
				disabled={disabled}
				onChange={setClip}
				onRange={() => {}}
				onSplit={() => {}}
				onPending={() => {}}
				onMove={() => {}}
				onRemove={() => {}}
				onInspect={() => {}}
			/>
			<pre data-testid="clip-document">{JSON.stringify(clip)}</pre>
		</>
	);
}

it("changes zoom for the selected shot and preserves its size when moving the center", () => {
	renderLocalized(<CropControls />);
	expect(screen.queryByLabelText("Crop zoom")).not.toBeInTheDocument();
	fireEvent.change(screen.getByLabelText("Framing segment"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("Crop zoom"), {
		target: { value: "2" },
	});
	fireEvent.change(screen.getByLabelText("Horizontal center (%)"), {
		target: { value: "80" },
	});
	fireEvent.change(screen.getByLabelText("Vertical center (%)"), {
		target: { value: "60" },
	});
	const clip = JSON.parse(
		screen.getByTestId("clip-document").textContent || "",
	);
	expect(clip.framing[0]).toEqual({
		fromFrame: 0,
		toFrame: 150,
		mode: "FIT",
		origin: "MANUAL",
	});
	expect(clip.framing[1]).toMatchObject({
		fromFrame: 150,
		toFrame: 300,
		mode: "CROP",
		origin: "MANUAL",
		manualOverride: true,
		rect: { w: 0.158203125, h: 0.5 },
	});
	expect(clip.framing[1].rect.x).toBeCloseTo(0.7208984375);
	expect(clip.framing[1].rect.y).toBeCloseTo(0.35);
	expect(clip.audio).toEqual({ mode: "SOURCE" });
	expect(screen.getByLabelText("Crop zoom")).toHaveValue("2");
});

it.each(["viewer", "unapplied range"])("blocks crop zoom with %s", (state) => {
	renderLocalized(<CropControls disabled={state === "viewer"} />);
	fireEvent.change(screen.getByLabelText("Framing segment"), {
		target: { value: "1" },
	});
	if (state === "unapplied range")
		fireEvent.change(screen.getByLabelText("Out (seconds)"), {
			target: { value: "9" },
		});
	expect(screen.getByLabelText("Crop zoom")).toBeDisabled();
	expect(screen.getByLabelText("Horizontal center (%)")).toBeDisabled();
});

it("limits zoom to a nonempty source crop on the smallest supported material", () => {
	renderLocalized(<CropControls tiny />);
	fireEvent.change(screen.getByLabelText("Framing segment"), {
		target: { value: "1" },
	});
	const zoom = screen.getByLabelText("Crop zoom");
	expect(zoom).toHaveAttribute("max", "1.125");
	fireEvent.change(zoom, { target: { value: "3" } });
	const clip = JSON.parse(
		screen.getByTestId("clip-document").textContent || "",
	);
	const { x, y, w, h } = clip.framing[1].rect;
	expect(Math.round((x + w) * 2) - Math.round(x * 2)).toBeGreaterThanOrEqual(1);
	expect(Math.round((y + h) * 2) - Math.round(y * 2)).toBeGreaterThanOrEqual(1);
});

it("keeps a one-pixel crop nonempty while panning at a half-pixel boundary", () => {
	renderLocalized(<CropControls smallLandscape />);
	fireEvent.change(screen.getByLabelText("Framing segment"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("Crop zoom"), {
		target: { value: "1.125" },
	});
	const before = JSON.parse(
		screen.getByTestId("clip-document").textContent || "",
	).framing[1].rect;
	fireEvent.change(screen.getByLabelText("Vertical center (%)"), {
		target: { value: "75" },
	});
	const after = JSON.parse(
		screen.getByTestId("clip-document").textContent || "",
	).framing[1].rect;
	expect(after.w).toBe(before.w);
	expect(after.h).toBe(before.h);
	expect(
		Math.round((after.y + after.h) * 1080) - Math.round(after.y * 1080),
	).toBeGreaterThanOrEqual(1);
});
