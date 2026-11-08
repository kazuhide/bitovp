import {
	type CompositionDocument,
	type CompositionPlan,
	type CompositionSourceFacts,
	toCompositionDocument,
} from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import type { CompositionCropControls } from "./composition-preview";
import { CompositionWorkbench } from "./composition-workbench";
import { describeDirectCrop } from "./direct-crop-model";

const apiFetch = vi.fn();
let canMutate = true;
let controls: CompositionCropControls | undefined;
let timelineActions:
	| { onSelect: (id: string) => void; onFrame: (frame: number) => void }
	| undefined;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canMutate,
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({
		plan,
		sourceCrop,
	}: {
		plan: CompositionPlan;
		sourceCrop: CompositionCropControls;
	}) => {
		controls = sourceCrop;
		return (
			<output aria-label="Preview document">
				{JSON.stringify(plan.document)}
			</output>
		);
	},
}));
vi.mock("./composition-timeline", () => ({
	CompositionTimeline: (props: {
		document: CompositionDocument;
		onSelect: (id: string) => void;
		onFrame: (frame: number) => void;
	}) => {
		timelineActions = props;
		return (
			<output aria-label="Timeline document">
				{JSON.stringify(props.document)}
			</output>
		);
	},
}));
function fixture() {
	const old = editingProjectFixture(),
		draft = toCompositionDocument(old.draft);
	if (!old.media.timeMap) throw Error("Missing fixture clock");
	draft.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		centerCropConfirmed: true,
	};
	const facts: CompositionSourceFacts = {
		mediaVersionId: old.media.id,
		width: 1920,
		height: 1080,
		hasAudio: true,
		timeMap: old.media.timeMap,
	};
	const project = { ...old, draft, compositionSources: [facts] };
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		if (init.method === "PUT")
			return {
				...project,
				draft: JSON.parse(String(init.body)).document,
				draftRevision: 2,
			};
		throw Error("Unexpected mutation");
	});
	const at = describeDirectCrop(draft, [facts], draft.clips[0]?.id ?? "", 0);
	if (!at) throw Error("Missing source crop");
	return { project, target: { ...at.rect, x: 0.1 } };
}
const shown = (label = "Preview document"): CompositionDocument =>
	JSON.parse(screen.getByLabelText(label).textContent ?? "");
const mutateCalls = () =>
	apiFetch.mock.calls.filter(([, init]) => Boolean(init?.method));
beforeEach(() => {
	canMutate = true;
	controls = undefined;
	timelineActions = undefined;
	apiFetch.mockReset();
});

it("updates the preview and timeline during a gesture, then undoes it as one edit", () => {
	const f = fixture();
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	const before = shown();
	act(() => expect(controls?.onStart()).toBe(true));
	act(() => controls?.onPreview({ ...f.target, x: 0.15 }));
	act(() => controls?.onPreview(f.target));
	expect(shown()).not.toEqual(before);
	expect(shown("Timeline document")).toEqual(shown());
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(mutateCalls()).toHaveLength(0);
	act(() => controls?.onCommit(f.target));
	const after = shown();
	expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(shown()).toEqual(before);
	expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Redo" }));
	expect(shown()).toEqual(after);
	expect(mutateCalls()).toHaveLength(0);
});

it("cancels a live adjustment without changing history or saving it", () => {
	const f = fixture();
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	const before = shown();
	act(() => controls?.onStart());
	act(() => controls?.onPreview(f.target));
	act(() => controls?.onCancel());
	expect(shown()).toEqual(before);
	expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(mutateCalls()).toHaveLength(0);
});

it("saves only the released adjustment and retains its source and timeline facts", async () => {
	const f = fixture();
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	act(() => controls?.onStart());
	act(() => controls?.onPreview(f.target));
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	expect(mutateCalls()).toHaveLength(0);
	act(() => controls?.onCommit(f.target));
	const released = shown();
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() => expect(mutateCalls()).toHaveLength(1));
	const saved: CompositionDocument = JSON.parse(
		String(mutateCalls()[0]?.[1].body),
	).document;
	expect(saved).toEqual(released);
	expect(saved.clips[0]?.sourceInUs).toBe(f.project.draft.clips[0]?.sourceInUs);
	expect(saved.clips[0]?.durationFrames).toBe(
		f.project.draft.clips[0]?.durationFrames,
	);
	expect(saved.clips[0]?.framing).toEqual(f.project.draft.clips[0]?.framing);
	expect(saved.clips[0]?.fallbackCrop).toBeDefined();
});

it("rejects crop changes when edit permission is absent", () => {
	const f = fixture();
	canMutate = false;
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	const before = shown();
	act(() => expect(controls?.onStart()).toBe(false));
	act(() => controls?.onPreview(f.target));
	act(() => controls?.onCommit(f.target));
	expect(shown()).toEqual(before);
	expect(mutateCalls()).toHaveLength(0);
});

it("blocks adopting the displayed proposal while a crop adjustment is pending", () => {
	const f = fixture();
	if (!f.project.draft.presentation) throw Error("Missing presentation");
	f.project.draft.presentation.centerCropConfirmed = false;
	const part = f.project.draft.clips[0]?.framing[0];
	if (!part) throw Error("Missing framing proposal");
	part.origin = "AISA_PROPOSAL";
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	const saveRevision = screen.getByRole("button", { name: "Save revision" });
	expect(saveRevision).toBeEnabled();
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
		}),
	).not.toBeInTheDocument();
	act(() => controls?.onStart());
	expect(saveRevision).toBeDisabled();
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeDisabled();
	expect(mutateCalls()).toHaveLength(0);
	act(() => controls?.onCancel());
	expect(saveRevision).toBeEnabled();
	expect(mutateCalls()).toHaveLength(0);
});

it.each([
	true,
	false,
])("respects an explicit PIP selection during the same seek event: %s", (selectPip) => {
	const f = fixture(),
		first = f.project.draft.clips[0];
	if (!first) throw Error("Missing first scene");
	first.trackId = "main";
	f.project.draft.videoTracks = [
		{ id: "main", name: "Main", order: 0 },
		{ id: "pip", name: "PIP", order: 1 },
	];
	const main = {
		...first,
		id: "77777777-7777-4777-8777-777777777777",
		timelineStartFrame: 300,
		sourceInUs: 10_000_000,
	};
	const pip = {
		...first,
		id: "88888888-8888-4888-8888-888888888888",
		trackId: "pip",
		timelineStartFrame: 360,
		durationFrames: 60,
		framing: [
			{
				fromFrame: 0,
				toFrame: 60,
				mode: "FIT" as const,
				origin: "MANUAL" as const,
			},
		],
		layout: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
	};
	f.project.draft.clips.push(main, pip);
	renderWithQuery(<CompositionWorkbench project={f.project} />);
	act(() => {
		if (selectPip) timelineActions?.onSelect(pip.id);
		timelineActions?.onFrame(360);
	});
	expect(controls?.clipId).toBe(selectPip ? pip.id : main.id);
	expect(mutateCalls()).toHaveLength(0);
});
