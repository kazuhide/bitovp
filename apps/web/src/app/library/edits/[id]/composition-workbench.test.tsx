import {
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	evaluateCompositionAudio,
	splitCompositionClip,
	suggestFixedCrop,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";

const apiFetch = vi.fn();
let canMutate = true;
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
		media,
		imageAssets,
	}: {
		plan: { durationFrames: number };
		media: unknown[];
		imageAssets: unknown[];
	}) => (
		<>
			<output aria-label="Preview duration">{plan.durationFrames}</output>
			<output aria-label="Preview media count">{media.length}</output>
			<output aria-label="Preview image count">{imageAssets.length}</output>
		</>
	),
}));

function fixture() {
	const old = editingProjectFixture(),
		draft = toCompositionDocument(old.draft);
	if (!old.media.timeMap) throw new Error("Fixture time map missing");
	const facts: CompositionSourceFacts = {
		mediaVersionId: old.media.id,
		timeMap: old.media.timeMap,
		width: 1920,
		height: 1080,
		hasAudio: true,
	};
	const project = { ...old, draft, compositionSources: [facts] };
	const id = "99999999-9999-4999-8999-999999999999";
	const extra = {
		...old.media,
		id,
		facts: {
			...facts,
			mediaVersionId: id,
			timeMap: { ...facts.timeMap, id, mediaVersionId: id },
		},
	};
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [{ ...old.media, facts }, extra] };
		if (init.method === "PUT")
			return {
				...project,
				draft: JSON.parse(String(init.body)).document,
				draftRevision: 2,
			};
		throw new Error(`Unexpected test mutation ${url}`);
	});
	return { project, facts, extra };
}
beforeEach(() => {
	canMutate = true;
	apiFetch.mockReset();
});
it.each([
	"PUT",
	"POST",
])("recovers a committed %s after its response is lost and keeps the local edit in Undo", async (method) => {
	const { project } = fixture();
	const readCatalog = apiFetch.getMockImplementation();
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (init?.method === method)
			throw new Error("Connection lost after commit");
		return readCatalog?.(url, init);
	});
	const view = renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.change(screen.getByLabelText("Length (s)"), {
		target: { value: "5" },
	});
	fireEvent.blur(screen.getByLabelText("Length (s)"));
	fireEvent.click(
		screen.getByRole("button", {
			name: method === "PUT" ? "Save draft" : "Save revision",
		}),
	);
	await screen.findByRole("alert");
	const saved = {
		...project,
		draftRevision: 3,
		currentRevisionId: "88888888-8888-4888-8888-888888888888",
		currentRevisionMatchesDraft: true,
	};
	view.rerender(<CompositionWorkbench project={saved} />);
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("150");
	fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("300");
	fireEvent.click(screen.getByText("Previous exports and preview files"));
	expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("150");
	expect(screen.getByRole("button", { name: "Export MP4" })).toBeDisabled();
});
const savedDocument = (): CompositionDocument => {
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
	if (!call) throw new Error("No saved document");
	return JSON.parse(call[1].body).document;
};
it("retains source facts and image URLs for local and Undo drafts after another editor removes them", async () => {
	const { project, extra } = fixture();
	const clip = project.draft.clips[0];
	if (!clip) throw new Error("Missing clip");
	const image = {
		id: "88888888-8888-4888-8888-888888888888",
		url: "/retained-image.png",
		width: 16,
		height: 16,
	};
	project.draft.sources = [{ mediaVersionId: extra.id, timeMapId: extra.id }];
	project.draft.videoTracks = [
		{ id: "main", name: "Main", order: 0 },
		{ id: "pip", name: "PIP", order: 1 },
	];
	project.draft.clips.push({
		...clip,
		id: "77777777-7777-4777-8777-777777777777",
		mediaVersionId: extra.id,
		trackId: "pip",
	});
	project.draft.imageAssets = [{ id: image.id }];
	project.draft.overlays = [
		{
			id: "66666666-6666-4666-8666-666666666666",
			kind: "IMAGE",
			assetId: image.id,
			fromFrame: 0,
			toFrame: 60,
			rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
			opacity: 1,
			zIndex: 1,
		},
	];
	const initial = {
		...project,
		additionalMedia: [extra],
		compositionSources: [...project.compositionSources, extra.facts],
		imageAssets: [image],
	};
	apiFetch.mockResolvedValue({ media: [] });
	const view = renderWithQuery(<CompositionWorkbench project={initial} />);
	await waitFor(() =>
		expect(screen.getByLabelText("Preview media count")).toHaveTextContent("2"),
	);
	const remote = {
		...project,
		draft: toCompositionDocument(editingProjectFixture().draft),
		draftRevision: 2,
	};
	view.rerender(<CompositionWorkbench project={remote} />);
	expect(screen.getByLabelText("Preview media count")).toHaveTextContent("2");
	expect(screen.getByLabelText("Preview image count")).toHaveTextContent("1");
	fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(screen.getByLabelText("Preview media count")).toHaveTextContent("2");
	expect(screen.getByLabelText("Preview image count")).toHaveTextContent("1");
});
it("loads only active images after uploads discard redo branches beyond the history budget", async () => {
	const { project } = fixture();
	let uploads = 0;
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? {
					id: `${String(++uploads).padStart(8, "0")}-1111-4111-8111-111111111111`,
					url: `/image-${uploads}.png`,
					width: 16,
					height: 16,
				}
			: { media: [] },
	);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	for (let i = 0; i < 21; i++) {
		fireEvent.change(screen.getByLabelText(/^Add PNG image/), {
			target: {
				files: [new File(["fixture"], "image.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Preview image count")).toHaveTextContent(
				"1",
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(screen.getByLabelText("Preview image count")).toHaveTextContent("0");
	}
	expect(uploads).toBe(21);
});

it("loads an unrelated media catalog without changing the current composition, then saves a PIP source", async () => {
	const { project, extra } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	await waitFor(() =>
		expect(screen.getByLabelText("Source")).toHaveValue(project.media.id),
	);
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("300");
	fireEvent.change(screen.getByLabelText("Source"), {
		target: { value: extra.id },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Add picture in picture" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().sources).toEqual([
			{
				mediaVersionId: extra.id,
				timeMapId: extra.id,
				analysisRevisionId: null,
			},
		]),
	);
	expect(savedDocument().clips).toHaveLength(2);
	expect(savedDocument().clips[1]).toMatchObject({
		mediaVersionId: extra.id,
		layout: { x: 0.62, y: 0.06, w: 0.32, h: 0.32 },
		audio: { mode: "MUTE" },
	});
});

it("blocks save while a numeric value is pending and saves the confirmed trim as one undoable edit", async () => {
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	const length = screen.getByLabelText("Length (s)");
	fireEvent.change(length, { target: { value: "5" } });
	expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
	fireEvent.blur(length);
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("150");
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("300");
	fireEvent.click(screen.getByRole("button", { name: "Redo" }));
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().clips[0]?.durationFrames).toBe(150),
	);
});

it("clears former word timing when the editor rewrites a caption", async () => {
	const { project } = fixture();
	project.draft.captions = [
		{
			id: "77777777-7777-4777-8777-777777777777",
			text: "Hello world",
			fromFrame: 0,
			toFrame: 60,
			words: [
				{ text: "Hello", startChar: 0, endChar: 5, fromFrame: 0, toFrame: 20 },
			],
		},
	];
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "Edited sentence" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().captions?.[0]).toMatchObject({
			text: "Edited sentence",
		}),
	);
	expect(savedDocument().captions?.[0]?.words).toBeUndefined();
});

it("keeps the preview visible to a viewer and exposes no editing writes", async () => {
	canMutate = false;
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(screen.getByLabelText("Preview duration")).toHaveTextContent("300");
	expect(
		screen.queryByRole("button", { name: "Save draft" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Add picture in picture" }),
	).not.toBeInTheDocument();
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("trims exactly one prepared frame from the left edge using the keyboard", async () => {
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.keyDown(
		screen.getByRole("button", { name: "Source start (s) 1" }),
		{ key: "ArrowRight" },
	);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().clips[0]).toMatchObject({
			sourceInUs: 33_334,
			timelineStartFrame: 1,
			durationFrames: 299,
		}),
	);
});

it("does not change a microsecond source position when a rounded numeric value is only focused and blurred", async () => {
	const { project } = fixture();
	const clip = project.draft.clips[0];
	if (!clip) throw new Error("Missing fixture clip");
	clip.sourceInUs = 66_667;
	clip.durationFrames = 298;
	clip.framing = [
		{ fromFrame: 0, toFrame: 298, mode: "FIT", origin: "MANUAL" },
	];
	renderWithQuery(<CompositionWorkbench project={project} />);
	const input = screen.getByLabelText("Source start (s)");
	fireEvent.focus(input);
	fireEvent.blur(input);
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("starts an explicitly added fade from the newly split clip boundary", async () => {
	const { project, facts } = fixture(),
		clip = project.draft.clips[0];
	if (!clip) throw new Error("Missing clip");
	project.draft = splitCompositionClip(
		project.draft,
		clip.id,
		37,
		"66666666-6666-4666-8666-666666666666",
		[facts],
	);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Selected clip 2" }));
	fireEvent.click(screen.getByRole("button", { name: "Audio" }));
	const input = screen.getByLabelText("Fade in (s)");
	fireEvent.change(input, { target: { value: "0.5" } });
	fireEvent.blur(input);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().clips[1]?.audio.fadeInFrames).toBe(15),
	);
	const plan = compileComposition(savedDocument(), [facts]);
	expect(evaluateCompositionAudio(plan, 37)[0]?.gain).toBe(0);
	expect(evaluateCompositionAudio(plan, 52)[0]?.gain).toBe(1);
});

it("keeps caption words, titles and audio aligned when a crossfade moves their clip", async () => {
	const { project } = fixture(),
		first = project.draft.clips[0];
	if (!first) throw new Error("Missing clip");
	const id = "55555555-5555-4555-8555-555555555555";
	project.draft.clips = [
		{
			...first,
			durationFrames: 150,
			framing: [{ fromFrame: 0, toFrame: 150, mode: "FIT", origin: "MANUAL" }],
		},
		{
			...first,
			id,
			timelineStartFrame: 150,
			durationFrames: 150,
			framing: [{ fromFrame: 0, toFrame: 150, mode: "FIT", origin: "MANUAL" }],
		},
	];
	project.draft.captions = [
		{
			id: "44444444-4444-4444-8444-444444444444",
			anchorClipId: id,
			text: "later",
			fromFrame: 155,
			toFrame: 180,
			words: [
				{
					text: "later",
					startChar: 0,
					endChar: 5,
					fromFrame: 155,
					toFrame: 165,
				},
			],
		},
	];
	project.draft.overlays = [
		{
			id: "33333333-3333-4333-8333-333333333334",
			kind: "TEXT",
			text: "title",
			anchorClipId: id,
			fromFrame: 150,
			toFrame: 190,
			opacity: 1,
			zIndex: 1,
			rect: { x: 0, y: 0, w: 1, h: 0.2 },
		},
	];
	project.draft.audioTracks = [
		{
			id: "22222222-2222-4222-8222-222222222223",
			mediaVersionId: project.media.id,
			anchorClipId: id,
			sourceInUs: 0,
			timelineStartFrame: 150,
			durationFrames: 60,
			gainDb: -6,
			fadeInFrames: 0,
			fadeOutFrames: 0,
		},
	];
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Selected clip 2" }));
	fireEvent.click(
		screen.getByRole("button", { name: "Crossfade from previous clip" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().clips[1]?.timelineStartFrame).toBe(135),
	);
	expect(savedDocument().captions?.[0]).toMatchObject({
		fromFrame: 140,
		toFrame: 165,
		words: [{ fromFrame: 140, toFrame: 150 }],
	});
	expect(savedDocument().overlays?.[0]).toMatchObject({
		fromFrame: 135,
		toFrame: 175,
	});
	expect(savedDocument().audioTracks?.[0]?.timelineStartFrame).toBe(135);
});

it("uses an exact prepared frame stamp for external audio source position", async () => {
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Audio" }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Add music / sound from source" }),
		).toBeEnabled(),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Add music / sound from source" }),
	);
	const duration = screen.getByLabelText("Length (s)");
	fireEvent.change(duration, { target: { value: "9" } });
	fireEvent.blur(duration);
	const input = screen.getByLabelText("Source start (s)");
	fireEvent.change(input, { target: { value: String(1 / 30) } });
	fireEvent.blur(input);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().audioTracks?.[0]?.sourceInUs).toBe(33334),
	);
});

it("keeps zoom while panning a crop inside a custom-aspect video layout", async () => {
	const { project } = fixture(),
		clip = project.draft.clips[0];
	if (!clip) throw new Error("Missing clip");
	clip.layout = { x: 0, y: 0, w: 1, h: 0.25 };
	const rect = suggestFixedCrop({
		sourceWidth: 1920,
		sourceHeight: 1080,
		targetWidth: 1080,
		targetHeight: 480,
		centerX: 0.5,
		centerY: 0.5,
		zoom: 2,
	});
	clip.framing = [
		{ fromFrame: 0, toFrame: 300, mode: "CROP", origin: "MANUAL", rect },
	];
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(screen.getByRole("slider", { name: "Crop zoom" })).toHaveValue("2");
	fireEvent.change(
		screen.getByRole("slider", { name: "Subject horizontal position" }),
		{ target: { value: "0.6" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(savedDocument().clips[0]?.framing[0]).toMatchObject({
			mode: "CROP",
			rect: { w: rect.w, h: rect.h },
		}),
	);
});
