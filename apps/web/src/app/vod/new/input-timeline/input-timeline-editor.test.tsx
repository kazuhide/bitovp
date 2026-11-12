import type { VodInputTimelineDocument } from "@bitovp/core/vod-input-timeline";
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import type { WizardInputFile } from "../build-plan";
import { VodInputTimelineEditor } from "./input-timeline-editor";
import {
	clipA,
	credentialId,
	facts,
	organizationId,
	previewTask,
	taskId,
	timeline,
} from "./test-fixtures";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const changed = vi.fn();
const sources: WizardInputFile[] = ["a", "b"].map((key) => ({
	key,
	inputKey: key,
	kind: "S3",
	credentialId,
	bucket: "sources",
	path: `${key.toUpperCase()}.mp4`,
}));

function Harness({ disabled = false }: { disabled?: boolean }) {
	const [document, setDocument] = useState<VodInputTimelineDocument>(
		timeline(),
	);
	return (
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodInputTimelineEditor
				document={document}
				sources={sources}
				onAddSource={() => {}}
				disabled={disabled}
				onChange={(next: VodInputTimelineDocument) => {
					changed(next);
					setDocument(next);
				}}
			/>
		</DocumentOrganizationContext.Provider>
	);
}

beforeEach(() => {
	changed.mockReset();
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const body = JSON.parse(String(init?.body));
		return Promise.resolve({
			task:
				body.kind === "PROBE"
					? previewTask({
							id: taskId,
							kind: "PROBE",
							result: { sources: facts },
						})
					: previewTask({
							result: {
								preview: { ...body.range, size: 1024, sha256: "b".repeat(64) },
							},
						}),
		});
	});
	vi.stubGlobal(
		"PointerEvent",
		class extends MouseEvent {
			pointerId: number;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
			}
		},
	);
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
	HTMLElement.prototype.releasePointerCapture = vi.fn();
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		left: 0,
		right: 1000,
		top: 0,
		bottom: 100,
		width: 1000,
		height: 100,
		toJSON: () => ({}),
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("edits A/B/A with keyboard alternatives and restores ranges and order with undo", async () => {
	renderLocalized(<Harness />);
	const add = await screen.findByRole("button", {
		name: "Add A.mp4 to sequence",
	});
	await waitFor(() => expect(add).toBeEnabled());
	fireEvent.click(add);
	expect(
		changed.mock.lastCall?.[0].videoClips.map(
			(clip: { sourceKey: string }) => clip.sourceKey,
		),
	).toEqual(["a", "b", "a"]);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(changed.mock.lastCall?.[0].videoClips).toHaveLength(2);
	const start = screen.getByRole("spinbutton", { name: "In (seconds)" });
	fireEvent.change(start, { target: { value: "12" } });
	fireEvent.blur(start);
	expect(changed.mock.lastCall?.[0].videoClips[0]).toMatchObject({
		id: clipA,
		inMs: 12_000,
	});
	fireEvent.click(screen.getByRole("button", { name: "Move later" }));
	expect(changed.mock.lastCall?.[0].videoClips[1].id).toBe(clipA);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	fireEvent.change(screen.getByRole("slider", { name: "Sequence position" }), {
		target: { value: "4000" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
	expect(
		changed.mock.lastCall?.[0].videoClips
			.slice(0, 2)
			.map((clip: { inMs: number; outMs: number }) => [clip.inMs, clip.outMs]),
	).toEqual([
		[12_000, 16_000],
		[16_000, 20_000],
	]);
	const video = screen.getByLabelText(
		"Input timeline preview",
	) as HTMLVideoElement;
	await waitFor(() =>
		expect(video.getAttribute("src")).toBe(
			`/api/vod/input-previews/${taskId}/content?expectedOrganizationId=${organizationId}`,
		),
	);
});

it("previews a pointer trim locally, commits once and cancels Escape without changing the edit", async () => {
	renderLocalized(<Harness />);
	const handle = await screen.findByRole("slider", {
		name: /Trim start, A.mp4, clip 1/,
	});
	await waitFor(() =>
		expect(handle).not.toHaveAttribute("aria-disabled", "true"),
	);
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 });
	expect(changed).not.toHaveBeenCalled();
	fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180 });
	expect(changed).toHaveBeenCalledTimes(1);
	expect(changed.mock.lastCall?.[0].videoClips[0].inMs).toBeGreaterThan(10_000);
	fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 180 });
	fireEvent.pointerMove(handle, { pointerId: 2, clientX: 220 });
	fireEvent.keyDown(handle, { key: "Escape" });
	fireEvent.pointerUp(handle, { pointerId: 2, clientX: 220 });
	expect(changed).toHaveBeenCalledTimes(1);
});

it("keeps unknown source facts unknown and exposes a recovery action", async () => {
	vi.mocked(apiFetch).mockResolvedValue({
		task: previewTask({ kind: "PROBE", result: { sources: [facts[0]] } }),
	});
	renderLocalized(<Harness />);
	await screen.findByRole("alert");
	expect(
		screen.getByRole("button", { name: "Retry source preparation" }),
	).toBeEnabled();
	expect(
		screen.getByRole("button", { name: "Add B.mp4 to sequence" }),
	).toBeDisabled();
	expect(screen.getByLabelText("Input timeline preview")).not.toHaveAttribute(
		"src",
	);
});

it("prevents mutations when disabled while leaving the sequence readable", async () => {
	renderLocalized(<Harness disabled />);
	const tracks = screen.getByRole("region", { name: "Input timeline tracks" });
	expect(within(tracks).getAllByText("A.mp4").length).toBeGreaterThan(0);
	fireEvent.keyDown(screen.getByRole("button", { name: "Clip 1, A.mp4" }), {
		key: "Delete",
	});
	expect(changed).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "Delete clip" })).toBeDisabled();
});

it("deletes by keyboard and restores focus to the next clip", async () => {
	renderLocalized(<Harness />);
	const clip = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	fireEvent.keyDown(clip, { key: "Delete" });
	expect(changed.mock.lastCall?.[0].videoClips).toHaveLength(1);
	expect(screen.getByRole("button", { name: "Clip 1, B.mp4" })).toHaveFocus();
	fireEvent.keyDown(screen.getByRole("button", { name: "Clip 1, B.mp4" }), {
		key: "Delete",
	});
	expect(screen.getByRole("region", { name: "Input timeline" })).toHaveFocus();
});

it("requests actual source preview windows without editing the sequence", async () => {
	renderLocalized(<Harness />);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Add A.mp4 to sequence" }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Preview A.mp4" }));
	fireEvent.change(screen.getByRole("slider", { name: "Source position" }), {
		target: { value: "40_000".replace("_", "") },
	});
	await waitFor(() => {
		const requests = vi
			.mocked(apiFetch)
			.mock.calls.filter(([, init]) => init?.method === "POST")
			.map(([, init]) => JSON.parse(String(init?.body)));
		expect(requests).toContainEqual(
			expect.objectContaining({
				kind: "PREVIEW",
				document: expect.objectContaining({
					schemaVersion: 2,
					videoClips: [
						expect.objectContaining({ sourceKey: "a", inMs: 0, outMs: 60_000 }),
					],
				}),
				range: { startMs: 30_000, durationMs: 30_000 },
			}),
		);
	});
	expect(changed).not.toHaveBeenCalled();
});
