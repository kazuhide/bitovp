import { editingDocumentSchema, normalizeSceneAnalysis } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { editingIds, editingProjectFixture } from "../editing-fixtures";

const apiFetch = vi.fn();
let canMutate = true;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canMutate,
}));

import { EditorClient } from "./editor-client";

function projectWithShots(count = 1) {
	const project = editingProjectFixture();
	const duration = Math.max(10, count);
	project.draft.analysisRevisionId = editingIds.revision;
	project.draft.clips = project.draft.clips.map((clip) => ({
		...clip,
		durationFrames: duration * 30,
		framing: [
			{ fromFrame: 0, toFrame: duration * 30, mode: "FIT", origin: "MANUAL" },
		],
	}));
	project.media.durationUs = duration * 1_000_000;
	if (project.media.timeMap)
		project.media.timeMap = {
			...project.media.timeMap,
			sourceEndUs: duration * 1_000_000,
			editingEndFrame: duration * 30,
		};
	project.analysis = {
		id: editingIds.revision,
		locale: "en",
		document: normalizeSceneAnalysis({
			metadata: { version: "fixture" },
			duration,
			scenes: [
				{
					id: editingIds.content,
					startInSeconds: 0,
					endInSeconds: duration,
					shots: Array.from({ length: count }, (_, index) => ({
						startInSeconds: count === 1 ? 0 : index,
						endInSeconds: count === 1 ? duration : index + 1,
						mainSubjects: [
							{
								classification: "person",
								description: "Interview participant",
								appearanceTimeInSeconds: 0,
								centerX: 70,
								centerY: 50,
							},
						],
					})),
				},
			],
		}),
	};
	return project;
}

beforeEach(() => {
	apiFetch.mockReset();
	canMutate = true;
});

it("splits at the playhead as one undoable edit and keeps numeric pending edits blocked", async () => {
	apiFetch.mockResolvedValue(editingProjectFixture());
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
		{ target: { value: "150" } },
	);
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "9" },
	});
	expect(
		screen.getByRole("button", { name: "Split at playhead" }),
	).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Reset range" }));
	fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
	expect(
		screen
			.getAllByLabelText("Out (seconds)")
			.map((input) => (input as HTMLInputElement).value),
	).toEqual(["5", "10"]);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(screen.getAllByLabelText("Out (seconds)")).toHaveLength(1);
	expect(screen.getByLabelText("Out (seconds)")).toHaveValue(10);
	fireEvent.click(screen.getByRole("button", { name: "Redo" }));
	expect(screen.getAllByLabelText("Out (seconds)")).toHaveLength(2);
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("preserves pending inspector input when seeking another range", async () => {
	apiFetch.mockResolvedValue(editingProjectFixture());
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
		{ target: { value: "150" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
	const selectedOut = screen.getAllByLabelText("Out (seconds)")[1];
	if (!selectedOut) throw new Error("Missing selected range");
	fireEvent.change(selectedOut, { target: { value: "9" } });
	expect(screen.getByLabelText("Range to edit")).toBeDisabled();
	fireEvent.change(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
		{ target: { value: "0" } },
	);
	expect(selectedOut).toBeVisible();
	expect(selectedOut).toHaveValue(9);
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Reset range" }));
	expect(selectedOut).toHaveValue(10);
	expect(screen.getByLabelText("Range to edit")).toBeEnabled();
	expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
	fireEvent.change(screen.getByLabelText("Range to edit"), {
		target: { value: editingIds.clip },
	});
	expect(screen.getByRole("button", { name: "Range 1" })).toBeInTheDocument();
});

it("clears a cancelled drag when edit permission is revoked and restored", async () => {
	apiFetch.mockResolvedValue(editingProjectFixture());
	const bounds = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 600,
			bottom: 60,
			width: 600,
			height: 60,
			toJSON: () => ({}),
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
	try {
		const view = renderWithQuery(<EditorClient id={editingIds.project} />);
		await screen.findByRole("heading", { name: "Interview highlights" });
		const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
		Object.assign(handle, {
			setPointerCapture: vi.fn(),
			hasPointerCapture: () => false,
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(handle, { pointerId: 7, clientX: 600, button: 0 });
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 580 });
		expect(
			screen.getByRole("button", { name: "Save confirmed revision" }),
		).toBeDisabled();
		canMutate = false;
		view.rerender(<EditorClient id={editingIds.project} />);
		expect(handle).toHaveAttribute("aria-disabled", "true");
		canMutate = true;
		view.rerender(<EditorClient id={editingIds.project} />);
		expect(handle).toHaveAttribute("aria-disabled", "false");
		expect(handle).toHaveAttribute("aria-valuenow", "300");
		expect(
			screen.getByRole("button", { name: "Save confirmed revision" }),
		).toBeEnabled();
		expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
	} finally {
		bounds.mockRestore();
		vi.unstubAllGlobals();
	}
});

it("saves applied numeric ranges as frame-based source edits", async () => {
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...editingProjectFixture(),
					draft: JSON.parse(String(init.body)).document,
					draftRevision: 2,
				}
			: editingProjectFixture(),
	);
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "5" },
	});
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Split range" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	expect(screen.getByRole("button", { name: "Split range" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/library/edits/${editingIds.project}/draft`,
			expect.objectContaining({ method: "PUT" }),
		),
	);
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
	expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
		expectedRevision: 1,
		document: { clips: [{ sourceInUs: 0, durationFrames: 150 }] },
	});
});

it("keeps the user's draft after a save conflict", async () => {
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") throw new ApiError(409, "conflict");
		return editingProjectFixture();
	});
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(screen.getByLabelText("In (seconds)"), {
		target: { value: "1" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	expect(screen.getByLabelText("In (seconds)")).toHaveValue(1);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("another editor");
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
	expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
		expectedRevision: 1,
		document: { clips: [{ sourceInUs: 1_000_000, durationFrames: 270 }] },
	});
	expect(screen.getByLabelText("In (seconds)")).toHaveValue(1);
	expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
});

it("does not overwrite local edits during background refresh", async () => {
	let revision = 1;
	apiFetch.mockImplementation(async () => ({
		...editingProjectFixture(),
		draftRevision: revision,
	}));
	const { client } = renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(screen.getByLabelText("In (seconds)"), {
		target: { value: "1" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	revision = 2;
	await act(() =>
		client.refetchQueries({ queryKey: ["library-edit", editingIds.project] }),
	);
	expect(screen.getByLabelText("In (seconds)")).toHaveValue(1);
});

it("requires a saved revision before generating preview and preserves an uncertain request key", async () => {
	let requests = 0;
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			requests++;
			if (requests === 1) throw new ApiError(503, "retry");
			return {
				id: editingIds.source,
				revisionId: editingIds.revision,
				kind: "PREVIEW",
				state: "QUEUED",
				generation: 1,
				error: null,
				artifact: null,
			};
		}
		return {
			...editingProjectFixture(),
			currentRevisionId: editingIds.revision,
			currentRevisionMatchesDraft: true,
		};
	});
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
	await waitFor(() => expect(requests).toBe(2));
	const bodies = apiFetch.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.map(([, init]) => JSON.parse(String(init.body)));
	expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
	expect(bodies[0]).toMatchObject({
		revisionId: editingIds.revision,
		kind: "PREVIEW",
	});
});

it("offers viewer read access without write actions", async () => {
	canMutate = false;
	apiFetch.mockResolvedValue(editingProjectFixture());
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	for (const name of [
		"Split at playhead",
		"Move selected range earlier",
		"Move selected range later",
		"Remove selected range",
		"Save draft",
		"Save confirmed revision",
		"Add range",
		"Split range",
		"Generate preview",
		"Export MP4",
	])
		expect(screen.getByRole("button", { name })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("splits a range at the requested output frame and saves both source intervals", async () => {
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...editingProjectFixture(),
					draft: JSON.parse(String(init.body)).document,
					draftRevision: 2,
				}
			: editingProjectFixture(),
	);
	renderWithQuery(<EditorClient id={editingIds.project} />);
	const splitAt = await screen.findByLabelText("Split after frame");
	fireEvent.change(splitAt, { target: { value: "100" } });
	fireEvent.click(screen.getByRole("button", { name: "Split range" }));
	expect(screen.getAllByLabelText("In (seconds)")).toHaveLength(2);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await screen.findByText("Draft saved");
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
	expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
		expectedRevision: 1,
		document: {
			clips: [
				{
					id: editingIds.clip,
					sourceInUs: 0,
					durationFrames: 100,
					timelineStartFrame: 0,
				},
				{ sourceInUs: 3_333_334, durationFrames: 200, timelineStartFrame: 100 },
			],
		},
	});
});

it("confirms only the draft revision actually reviewed on screen", async () => {
	let revision = 1;
	apiFetch.mockImplementation(async () => ({
		...editingProjectFixture(),
		draftRevision: revision,
	}));
	const { client } = renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	revision = 2;
	await act(() =>
		client.refetchQueries({ queryKey: ["library-edit", editingIds.project] }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Save confirmed revision" }),
	);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
	expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
		expectedRevision: 1,
	});
});

it("requires confirmation again after saving changes to a previously confirmed project", async () => {
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...editingProjectFixture(),
					draft: JSON.parse(String(init.body)).document,
					draftRevision: 2,
					currentRevisionId: editingIds.revision,
					currentRevisionMatchesDraft: false,
				}
			: {
					...editingProjectFixture(),
					currentRevisionId: editingIds.revision,
					currentRevisionMatchesDraft: true,
				},
	);
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.change(screen.getByLabelText("Out (seconds)"), {
		target: { value: "5" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(screen.getByText("Draft saved")).toBeInTheDocument(),
	);
	expect(
		screen.getByRole("button", { name: "Generate preview" }),
	).toBeDisabled();
});

it("retains an uncertain preview request key while an export is requested", async () => {
	const bodies: { kind: string; requestKey: string }[] = [];
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			bodies.push(body);
			if (bodies.length === 1) throw new ApiError(503, "PROCESS_FAILED");
			return {
				id: body.kind === "EXPORT" ? editingIds.media : editingIds.source,
				revisionId: editingIds.revision,
				kind: body.kind,
				state: "QUEUED",
				generation: 1,
				error: null,
				artifact: null,
			};
		}
		return {
			...editingProjectFixture(),
			currentRevisionId: editingIds.revision,
			currentRevisionMatchesDraft: true,
		};
	});
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByRole("heading", { name: "Interview highlights" });
	fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
	await waitFor(() => expect(bodies).toHaveLength(2));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Export MP4" })).toBeDisabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
	await waitFor(() => expect(bodies).toHaveLength(3));
	expect(bodies[2]?.requestKey).toBe(bodies[0]?.requestKey);
});

it("links the active exported artifact back to its derived library content", async () => {
	apiFetch.mockResolvedValue({
		...editingProjectFixture(),
		currentRevisionId: editingIds.revision,
		currentRevisionMatchesDraft: true,
		renders: [
			{
				id: editingIds.source,
				revisionId: editingIds.revision,
				kind: "EXPORT",
				state: "SUCCEEDED",
				generation: 1,
				error: null,
				artifact: {
					id: editingIds.media,
					url: "/api/library/artifacts/example/media",
					downloadUrl: "/api/library/artifacts/example/download",
					derivedContentId: editingIds.content,
				},
			},
		],
	});
	renderWithQuery(<EditorClient id={editingIds.project} />);
	expect(
		await screen.findByRole("link", { name: "Open derived content" }),
	).toHaveAttribute("href", `/library/${editingIds.content}`);
});

it("preserves an editor-selected fit after saving, reloading, and proposing again", async () => {
	let stored = projectWithShots();
	stored.draft.clips = stored.draft.clips.map((clip) => ({
		...clip,
		framing: [
			{
				fromFrame: 0,
				toFrame: clip.durationFrames,
				mode: "CROP",
				origin: "AISA_PROPOSAL",
				rect: { x: 0.3, y: 0, w: 0.3, h: 1 },
			},
		],
	}));
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT")
			stored = {
				...stored,
				draft: editingDocumentSchema.parse(
					JSON.parse(String(init.body)).document,
				),
				draftRevision: stored.draftRevision + 1,
			};
		return structuredClone(stored);
	});
	const view = renderWithQuery(<EditorClient id={editingIds.project} />);
	fireEvent.change(await screen.findByLabelText("Framing"), {
		target: { value: "FIT" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await screen.findByText("Draft saved");
	expect(stored.draft.clips[0]?.framing[0]).toMatchObject({
		mode: "FIT",
		origin: "MANUAL",
		manualOverride: true,
	});
	view.unmount();
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByLabelText("Framing");
	fireEvent.click(
		screen.getByLabelText(
			"I checked that the analysis uses this material’s timeline and displayed orientation.",
		),
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "Suggest framing for unadjusted ranges",
		}),
	);
	expect(screen.getByLabelText("Framing")).toHaveValue("FIT");
});

it("keeps the draft and explains when shot proposals exceed 128 framing segments", async () => {
	apiFetch.mockResolvedValue(projectWithShots(129));
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByLabelText("Framing");
	fireEvent.click(
		screen.getByLabelText(
			"I checked that the analysis uses this material’s timeline and displayed orientation.",
		),
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "Suggest framing for unadjusted ranges",
		}),
	);
	expect(screen.getByRole("alert")).toHaveTextContent("128");
	expect(screen.getByLabelText("Framing")).toHaveValue("FIT");
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(
		screen.queryByLabelText(
			"I reviewed the suggested ranges and framing against the source.",
		),
	).not.toBeInTheDocument();
});

it("accepts all 128 shot framing segments at the shared boundary", async () => {
	const stored = projectWithShots(128);
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...stored,
					draftRevision: 2,
					draft: editingDocumentSchema.parse(
						JSON.parse(String(init.body)).document,
					),
				}
			: stored,
	);
	renderWithQuery(<EditorClient id={editingIds.project} />);
	await screen.findByLabelText("Framing");
	fireEvent.click(
		screen.getByLabelText(
			"I checked that the analysis uses this material’s timeline and displayed orientation.",
		),
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "Suggest framing for unadjusted ranges",
		}),
	);
	expect(
		screen.getByLabelText("Framing segment").querySelectorAll("option"),
	).toHaveLength(128);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await screen.findByText("Draft saved");
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
	expect(
		JSON.parse(String(call?.[1]?.body)).document.clips[0].framing,
	).toHaveLength(128);
});
