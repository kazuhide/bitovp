import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { vodInputTimelineDocumentSchema } from "@bitovp/core/vod-input-timeline";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import type { WizardInputFile } from "../build-plan";
import { VodInputTimelineEditor } from "./input-timeline-editor";
import {
	clipA,
	clipB,
	credentialId,
	organizationId,
	previewTask,
	sequenceId,
	taskId,
} from "./test-fixtures";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const changed = vi.fn();
const unpairedVideoId = "20000000-0000-4000-8000-000000000010";
const unpairedAudioId = "20000000-0000-4000-8000-000000000011";
function fact(
	key: string,
	primary: number,
	video: number | null,
	audio: number | null,
): VodInputTimelineSourceFacts {
	return {
		key,
		durationMs: primary,
		video:
			video === null
				? null
				: {
						streamIndex: 0,
						width: 960,
						height: 540,
						frameRate: { num: 30, den: 1 },
						durationMs: video,
					},
		audio:
			audio === null
				? null
				: { streamIndex: 1, sampleRate: 48000, channels: 2, durationMs: audio },
		identity: { size: 1024 },
	};
}
let sourceFacts: VodInputTimelineSourceFacts[];
const sources: WizardInputFile[] = ["a", "b", "c"].map((key) => ({
	key,
	inputKey: key,
	kind: "S3",
	credentialId,
	bucket: "sources",
	path: key === "c" ? "C.wav" : `${key.toUpperCase()}.mp4`,
}));
function paired(durationMs = 2000): VodInputTimelineV2Document {
	const clip = {
		id: clipA,
		sourceKey: "a",
		startMs: 0,
		inMs: 0,
		outMs: durationMs,
	};
	return {
		schemaVersion: 2,
		id: sequenceId,
		audioEnabled: true,
		durationMs,
		videoClips: [clip],
		audioClips: [{ ...clip }],
	};
}
function mixed(): VodInputTimelineV2Document {
	const a = { id: clipA, sourceKey: "a", startMs: 0, inMs: 0, outMs: 2000 },
		b = { id: clipB, sourceKey: "b", startMs: 2000, inMs: 0, outMs: 2000 };
	return {
		...paired(6000),
		videoClips: [
			a,
			b,
			{
				id: unpairedVideoId,
				sourceKey: "a",
				startMs: 4000,
				inMs: 4000,
				outMs: 6000,
			},
		],
		audioClips: [
			{ ...a },
			{ ...b },
			{
				id: unpairedAudioId,
				sourceKey: "c",
				startMs: 4000,
				inMs: 0,
				outMs: 2000,
			},
		],
	};
}
function Harness({
	initial = paired(),
}: {
	initial?: VodInputTimelineDocument;
}) {
	const [document, setDocument] = useState(initial);
	return (
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodInputTimelineEditor
				document={document}
				sources={sources}
				onAddSource={() => {}}
				onChange={(next) => {
					changed(next);
					setDocument(next);
				}}
			/>
		</DocumentOrganizationContext.Provider>
	);
}
function lastEdit(): VodInputTimelineV2Document {
	expect(changed).toHaveBeenCalled();
	return changed.mock.lastCall?.[0];
}
async function ready() {
	await screen.findByText("Preview ready");
}
function previewRequests() {
	return vi
		.mocked(apiFetch)
		.mock.calls.filter(([, init]) => init?.method === "POST")
		.map(([, init]) => JSON.parse(String(init?.body)))
		.filter((request) => request.kind === "PREVIEW");
}
beforeEach(() => {
	changed.mockReset();
	sourceFacts = [
		fact("a", 8000, 8000, 8000),
		fact("b", 6000, 6000, 5994),
		fact("c", 6000, null, 6000),
	];
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const request = JSON.parse(String(init?.body));
		return Promise.resolve({
			task:
				request.kind === "PROBE"
					? previewTask({
							id: taskId,
							kind: "PROBE",
							result: { sources: sourceFacts },
						})
					: previewTask({
							result: {
								preview: {
									...request.range,
									size: 1024,
									sha256: "b".repeat(64),
								},
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
it("auditions a measured audio tail in a valid fresh document without changing primary facts", async () => {
	sourceFacts[0] = fact("a", 8000, 8000, 8085);
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview A.mp4" }));
	await waitFor(() => {
		const request = previewRequests().find(
			(request) => request.document.id !== sequenceId,
		);
		expect(request).toBeDefined();
		expect(request.sourcePreviewKey).toBe("a");
		expect(
			previewRequests().find((request) => request.document.id === sequenceId),
		).not.toHaveProperty("sourcePreviewKey");
		expect(
			vodInputTimelineDocumentSchema.safeParse(request.document).success,
		).toBe(true);
		expect(request.document.durationMs).toBe(8085);
		expect(request.document.videoClips[0].outMs).toBe(8000);
		expect(request.document.audioClips[0].outMs).toBe(8085);
	});
	expect(sourceFacts[0]?.durationMs).toBe(8000);
	expect(
		screen.getByRole("slider", { name: "Source position" }),
	).toHaveAttribute("max", "8084");
});
it("quick-add uses the available linked AV duration when audio ends before video", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(
		screen.getByRole("button", { name: "Add B.mp4 to sequence" }),
	);
	const next = lastEdit();
	expect(next.videoClips[1]).toMatchObject({
		sourceKey: "b",
		inMs: 0,
		outMs: 5994,
		startMs: 2000,
	});
	expect(next.audioClips[1]).toMatchObject({
		sourceKey: "b",
		inMs: 0,
		outMs: 5994,
		startMs: 2000,
	});
	expect(next.durationMs).toBe(7994);
	expect(
		screen.getByRole("slider", { name: "Trim end, B.mp4, clip 2" }),
	).toHaveAttribute("aria-valuemax", "5994");
	expect(sourceFacts[1]?.durationMs).toBe(6000);
});
it("defaults the linked monitor to the common range and preserves an explicit excessive range as an error", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	expect(output).toHaveValue(5.994);
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeEnabled();
	fireEvent.change(output, { target: { value: "6" } });
	fireEvent.blur(output);
	expect(output).toHaveValue(6);
	expect(screen.getByRole("button", { name: "Append to end" })).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Choose a range within the source duration.",
	);
	fireEvent.change(output, { target: { value: "5" } });
	fireEvent.blur(output);
	expect(screen.getByRole("button", { name: "Append to end" })).toBeEnabled();
});
it("uses the measured A1 duration beyond primary video for ranges, full quick-add and audition seeking", async () => {
	sourceFacts[0] = fact("a", 4000, 4000, 8000);
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Select A1 track" }));
	fireEvent.click(screen.getByRole("button", { name: "Preview A.mp4" }));
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	expect(output).toHaveValue(8);
	expect(output).toHaveAttribute("max", "8");
	const input = screen.getByRole("spinbutton", { name: "Source in (seconds)" });
	fireEvent.change(input, { target: { value: "4" } });
	fireEvent.blur(input);
	fireEvent.click(screen.getByRole("button", { name: "Append to end" }));
	expect(lastEdit().audioClips[1]).toMatchObject({
		inMs: 4000,
		outMs: 8000,
		startMs: 2000,
	});
	expect(lastEdit().videoClips).toEqual(paired().videoClips);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	fireEvent.click(
		screen.getByRole("button", { name: "Add A.mp4 to sequence" }),
	);
	expect(lastEdit().audioClips[1]).toMatchObject({
		inMs: 0,
		outMs: 8000,
		startMs: 2000,
	});
	expect(lastEdit().durationMs).toBe(10000);
	expect(
		screen.getByRole("spinbutton", { name: "Out (seconds)" }),
	).toHaveAttribute("max", "8");
	const clipInput = screen.getByRole("spinbutton", { name: "In (seconds)" });
	fireEvent.change(clipInput, { target: { value: "4" } });
	fireEvent.blur(clipInput);
	expect(lastEdit().audioClips[1]).toMatchObject({
		inMs: 4000,
		outMs: 8000,
		startMs: 6000,
	});
});
it.each([
	"pointer",
	"keyboard",
] as const)("links a newly operated exact pair after an unpaired selection for %s edits", async (mode) => {
	const original = mixed();
	renderLocalized(<Harness initial={original} />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Clip 3, A.mp4" }));
	const target = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	target.focus();
	if (mode === "pointer") {
		fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: 100 });
		fireEvent.pointerMove(target, { pointerId: 1, clientX: 200 });
		fireEvent.pointerUp(target, { pointerId: 1, clientX: 200 });
	} else fireEvent.keyDown(target, { key: "ArrowRight", altKey: true });
	expect(lastEdit().videoClips[0]?.id).toBe(clipB);
	expect(lastEdit().audioClips[0]?.id).toBe(clipB);
});
it.each([
	"pointer",
	"keyboard",
] as const)("edits a newly operated unpaired clip independently after a paired selection for %s edits", async (mode) => {
	const original = mixed();
	renderLocalized(<Harness initial={original} />);
	await ready();
	const target = screen.getByRole("button", { name: "Clip 3, A.mp4" });
	target.focus();
	if (mode === "pointer") {
		fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: 200 });
		fireEvent.pointerMove(target, { pointerId: 1, clientX: 100 });
		fireEvent.pointerUp(target, { pointerId: 1, clientX: 100 });
	} else fireEvent.keyDown(target, { key: "ArrowLeft", altKey: true });
	expect(lastEdit().videoClips[1]?.id).toBe(unpairedVideoId);
	expect(lastEdit().audioClips).toEqual(original.audioClips);
	expect(lastEdit().durationMs).toBe(original.durationMs);
});
it("honors an explicit unlink even when the operated keyboard target has an exact partner", async () => {
	const original = mixed();
	renderLocalized(<Harness initial={original} />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Unlink V1 / A1" }));
	fireEvent.keyDown(screen.getByRole("button", { name: "Clip 2, B.mp4" }), {
		key: "ArrowLeft",
		altKey: true,
	});
	expect(lastEdit().videoClips[0]?.id).toBe(clipB);
	expect(lastEdit().audioClips).toEqual(original.audioClips);
});
it("permits a WAV quick-add to available A1 when V1 has 64 clips", async () => {
	sourceFacts = [
		fact("a", 64000, 64000, 64000),
		fact("b", 6000, 6000, 5994),
		fact("c", 1000, null, 1000),
	];
	const original: VodInputTimelineV2Document = {
		...paired(64000),
		videoClips: Array.from({ length: 64 }, (_, index) => ({
			id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			sourceKey: "a",
			startMs: index * 1000,
			inMs: 0,
			outMs: 1000,
		})),
	};
	renderLocalized(<Harness initial={original} />);
	await ready();
	const add = screen.getByRole("button", { name: "Add C.wav to sequence" });
	expect(add).toBeEnabled();
	fireEvent.click(add);
	expect(lastEdit().videoClips).toEqual(original.videoClips);
	expect(lastEdit().audioClips).toHaveLength(2);
	expect(lastEdit().audioClips[1]).toMatchObject({
		sourceKey: "c",
		startMs: 64000,
		inMs: 0,
		outMs: 1000,
	});
});
