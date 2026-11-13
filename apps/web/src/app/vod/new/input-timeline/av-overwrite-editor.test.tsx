import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
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
	credentialId,
	facts,
	organizationId,
	previewTask,
	sequenceId,
	taskId,
} from "./test-fixtures";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const changed = vi.fn();
const audioFact = { ...facts[0], key: "c", durationMs: 6000, video: null };
let sourceFacts: VodInputTimelineSourceFacts[];
const sources: WizardInputFile[] = ["a", "b", "c"].map((key) => ({
	key,
	inputKey: key,
	kind: "S3",
	credentialId,
	bucket: "sources",
	path: key === "c" ? "C.wav" : `${key.toUpperCase()}.mp4`,
}));

function original() {
	return {
		schemaVersion: 1 as const,
		id: sequenceId,
		audioEnabled: true,
		clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 8000 }],
	};
}

function Harness({ audioOnly = false }: { audioOnly?: boolean }) {
	const [document, setDocument] = useState<VodInputTimelineDocument>(
		original(),
	);
	return (
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodInputTimelineEditor
				document={document}
				onChange={(next) => {
					changed(next);
					setDocument(next);
				}}
				sources={audioOnly ? sources : sources.slice(0, 2)}
				onAddSource={() => {}}
			/>
		</DocumentOrganizationContext.Provider>
	);
}

function lastEdit(): VodInputTimelineV2Document {
	const document = changed.mock.lastCall?.[0];
	expect(document?.schemaVersion).toBe(2);
	return document;
}

async function ready() {
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Add A.mp4 to sequence" }),
		).toBeEnabled(),
	);
}

function seekAndSplit(position: number) {
	fireEvent.change(screen.getByRole("slider", { name: "Sequence position" }), {
		target: { value: String(position) },
	});
	fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
}

function sourceRange(start: string, end: string) {
	const input = screen.getByRole("spinbutton", { name: "Source in (seconds)" });
	fireEvent.change(input, { target: { value: start } });
	fireEvent.blur(input);
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	fireEvent.change(output, { target: { value: end } });
	fireEvent.blur(output);
}

beforeEach(() => {
	changed.mockReset();
	sourceFacts = facts;
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
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("splits A1 into three pieces and replaces its middle while V1 and program duration stay unchanged", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Unlink V1 / A1" }));
	fireEvent.click(screen.getByRole("button", { name: "Audio clip 1, A.mp4" }));
	seekAndSplit(2000);
	seekAndSplit(6000);
	fireEvent.click(screen.getByRole("button", { name: "Audio clip 2, A.mp4" }));
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	sourceRange("1", "5");
	expect(screen.getByLabelText("Selection target")).toHaveTextContent("A1");
	expect(screen.getByLabelText("Selection target")).toHaveTextContent(
		"0:02.000 – 0:06.000",
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Replace selected interval" }),
	);
	const result = lastEdit();
	expect(result.durationMs).toBe(8000);
	expect(result.videoClips).toEqual([{ ...original().clips[0], startMs: 0 }]);
	expect(
		result.audioClips.map(({ sourceKey, startMs, inMs, outMs }) => ({
			sourceKey,
			startMs,
			inMs,
			outMs,
		})),
	).toEqual([
		{ sourceKey: "a", startMs: 0, inMs: 0, outMs: 2000 },
		{ sourceKey: "b", startMs: 2000, inMs: 1000, outMs: 5000 },
		{ sourceKey: "a", startMs: 6000, inMs: 6000, outMs: 8000 },
	]);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(lastEdit().audioClips[1]).toMatchObject({
		sourceKey: "a",
		startMs: 2000,
		inMs: 2000,
		outMs: 6000,
	});
	fireEvent.click(screen.getByRole("button", { name: "Redo" }));
	expect(lastEdit().audioClips[1]?.sourceKey).toBe("b");
});

it("replaces only the selected middle of V1 while the original A1 remains one uninterrupted clip", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Unlink V1 / A1" }));
	seekAndSplit(2000);
	seekAndSplit(6000);
	fireEvent.click(screen.getByRole("button", { name: "Clip 2, A.mp4" }));
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	sourceRange("1", "5");
	fireEvent.click(
		screen.getByRole("button", { name: "Replace selected interval" }),
	);
	const result = lastEdit();
	expect(result.durationMs).toBe(8000);
	expect(result.audioClips).toEqual([{ ...original().clips[0], startMs: 0 }]);
	expect(result.videoClips[1]).toMatchObject({
		sourceKey: "b",
		startMs: 2000,
		inMs: 1000,
		outMs: 5000,
	});
});

it("refuses an insufficient source range without looping, stretching or editing either track", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Unlink V1 / A1" }));
	seekAndSplit(2000);
	seekAndSplit(6000);
	fireEvent.click(screen.getByRole("button", { name: "Clip 2, A.mp4" }));
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	sourceRange("59", "60");
	const before = changed.mock.calls.length;
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeDisabled();
	expect(
		screen.getByText(
			"The source range is too short for the selected interval.",
		),
	).toBeVisible();
	expect(changed).toHaveBeenCalledTimes(before);
});

it("trims and deletes A1 independently without moving V1 or changing program duration", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Unlink V1 / A1" }));
	fireEvent.click(screen.getByRole("button", { name: "Audio clip 1, A.mp4" }));
	const input = screen.getByRole("spinbutton", { name: "In (seconds)" });
	fireEvent.change(input, { target: { value: "2" } });
	fireEvent.blur(input);
	expect(lastEdit().audioClips[0]).toMatchObject({
		startMs: 2000,
		inMs: 2000,
		outMs: 8000,
	});
	expect(lastEdit().videoClips).toEqual([
		{ ...original().clips[0], startMs: 0 },
	]);
	expect(lastEdit().durationMs).toBe(8000);
	fireEvent.click(screen.getByRole("button", { name: "Delete clip" }));
	expect(lastEdit().audioClips).toEqual([]);
	expect(lastEdit().videoClips).toEqual([
		{ ...original().clips[0], startMs: 0 },
	]);
	expect(lastEdit().durationMs).toBe(8000);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(lastEdit().audioClips[0]).toMatchObject({
		startMs: 2000,
		inMs: 2000,
		outMs: 8000,
	});
});

it("disables insertion for an invalid displayed source range and clears that draft when the source changes", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	fireEvent.change(output, { target: { value: "-1" } });
	fireEvent.blur(output);
	expect(screen.getByRole("button", { name: "Append to end" })).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeDisabled();
	fireEvent.change(output, { target: { value: "10" } });
	fireEvent.blur(output);
	expect(screen.getByRole("button", { name: "Append to end" })).toBeEnabled();
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeEnabled();
	fireEvent.change(output, { target: { value: "-1" } });
	fireEvent.blur(output);
	fireEvent.click(screen.getByRole("button", { name: "Preview A.mp4" }));
	expect(
		screen.getByRole("spinbutton", { name: "Source out (seconds)" }),
	).toHaveValue(60);
	expect(screen.getByRole("button", { name: "Append to end" })).toBeEnabled();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(changed).not.toHaveBeenCalled();
});

it("previews an audio-only source with a fresh v2 document and appends its chosen range only to A1", async () => {
	sourceFacts = [...facts, audioFact];
	renderLocalized(<Harness audioOnly />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview C.wav" }));
	await waitFor(() => {
		const requests = vi
			.mocked(apiFetch)
			.mock.calls.filter(([, init]) => init?.method === "POST")
			.map(([, init]) => JSON.parse(String(init?.body)));
		const request = requests.find(
			(request) =>
				request.kind === "PREVIEW" &&
				request.document.audioClips?.[0]?.sourceKey === "c",
		);
		expect(request?.document).toMatchObject({
			schemaVersion: 2,
			audioEnabled: true,
			durationMs: 6000,
			videoClips: [],
			audioClips: [{ sourceKey: "c", startMs: 0, inMs: 0, outMs: 6000 }],
		});
		expect(request?.document.id).not.toBe(sequenceId);
	});
	sourceRange("1", "3");
	fireEvent.click(screen.getByRole("button", { name: "Append to end" }));
	const result = lastEdit();
	expect(result.videoClips).toEqual([{ ...original().clips[0], startMs: 0 }]);
	expect(result.audioClips[1]).toMatchObject({
		sourceKey: "c",
		startMs: 8000,
		inMs: 1000,
		outMs: 3000,
	});
	expect(result.durationMs).toBe(10_000);
});

it("resets an invalid source draft even when the next source has identical saved bounds", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	fireEvent.change(output, { target: { value: "-1" } });
	fireEvent.blur(output);
	fireEvent.click(screen.getByRole("button", { name: "Preview A.mp4" }));
	expect(
		screen.getByRole("spinbutton", { name: "Source out (seconds)" }),
	).toHaveValue(60);
	expect(
		screen.getByRole("button", { name: "Replace selected interval" }),
	).toBeEnabled();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("quick-add always appends the full source independently of a partial or invalid monitor draft", async () => {
	renderLocalized(<Harness />);
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "Preview B.mp4" }));
	sourceRange("1", "5");
	const output = screen.getByRole("spinbutton", {
		name: "Source out (seconds)",
	});
	fireEvent.change(output, { target: { value: "-1" } });
	fireEvent.blur(output);
	fireEvent.click(
		screen.getByRole("button", { name: "Add B.mp4 to sequence" }),
	);
	expect(lastEdit().videoClips[1]).toMatchObject({
		sourceKey: "b",
		startMs: 8000,
		inMs: 0,
		outMs: 60_000,
	});
	expect(lastEdit().audioClips[1]).toMatchObject({
		sourceKey: "b",
		startMs: 8000,
		inMs: 0,
		outMs: 60_000,
	});
});
