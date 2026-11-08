import {
	type CompositionDocument,
	type CompositionPlan,
	type CompositionSourceFacts,
	compositionDocumentSchema,
	normalizeSceneAnalysis,
	shotCropCandidates,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized, renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import type {
	CompositionSourceFrame,
	CompositionSourceFrameReader,
} from "./composition-source-frame";
import { CompositionWorkbench } from "./composition-workbench";
import { CropCandidates, cropCandidateSubjects } from "./crop-candidates";

const api = vi.hoisted(() => vi.fn());
let readerSnapshot: CompositionSourceFrame | null = null;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			mode: "none",
			configured: true,
			authenticated: true,
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({
		plan,
		onSourceFrameReader,
		onSourceFrameAvailabilityChange,
	}: {
		plan: CompositionPlan;
		onSourceFrameReader?: (reader: CompositionSourceFrameReader | null) => void;
		onSourceFrameAvailabilityChange?: () => void;
	}) => {
		useEffect(() => {
			onSourceFrameReader?.((clipId) =>
				readerSnapshot?.clipId === clipId ? readerSnapshot : null,
			);
			onSourceFrameAvailabilityChange?.();
			return () => onSourceFrameReader?.(null);
		}, [onSourceFrameReader, onSourceFrameAvailabilityChange]);
		return (
			<output aria-label="Preview document">
				{JSON.stringify(plan.document)}
			</output>
		);
	},
}));
const draw = vi.fn();
beforeEach(() => {
	draw.mockReset();
	api.mockReset();
	readerSnapshot = null;
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		fillRect: vi.fn(),
		clearRect: vi.fn(),
		drawImage: draw,
	} as unknown as CanvasRenderingContext2D);
});
function fixture() {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft),
		map = project.media.timeMap;
	if (!map) throw Error("Missing map");
	const sceneId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		analysisId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		hash = "a".repeat(64);
	const analysis = {
		id: analysisId,
		locale: "en",
		document: normalizeSceneAnalysis({
			metadata: { version: "authored UI fixture" },
			duration: 60,
			scenes: [
				{
					id: sceneId,
					type: "MAIN_CONTENT",
					startInSeconds: 0,
					endInSeconds: 60,
					shots: [
						{
							startInSeconds: 0,
							endInSeconds: 60,
							mainSubjects: [
								{
									classification: "person",
									description: "Position reference",
									appearanceTimeInSeconds: 0,
									centerX: 80,
									centerY: 50,
									box2d: [0, 400, 1000, 950],
								},
							],
						},
					],
				},
			],
		}),
	};
	document.analysisRevisionId = analysisId;
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		fallbackFraming: "AISA_STATIC_V1",
		centerCropConfirmed: true,
	};
	document.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: hash,
		requestedDurationFrames: 300,
		generatedDurationFrames: 300,
		reasonCodes: [],
		binding: {
			schemaVersion: 1,
			kind: "CAPTURED_INPUT",
			organizationId: "00000000-0000-4000-8000-000000000001",
			sourceId: project.media.sourceId,
			locale: "en",
			analysisRevisionId: analysisId,
			analysisRawHash: hash,
			analysisDocumentHash: hash,
			mediaVersionId: project.media.id,
			mediaSha256: hash,
			timeMapId: map.id,
			timeMapHash: hash,
			sourceStartUs: map.sourceStartUs,
			sourceEndUs: map.sourceEndUs,
			width: 1920,
			height: 1080,
		},
	};
	const clip = document.clips[0];
	if (!clip) throw Error("Missing clip");
	clip.evidence = { sceneId, shotIndex: 0 };
	clip.framing = [
		{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "AUTO_POLICY" },
		{
			fromFrame: 30,
			toFrame: 300,
			mode: "CROP",
			origin: "AUTO_POLICY",
			rect: { x: 0.2, y: 0.1, w: 0.3, h: 0.8 },
		},
	];
	clip.cropKeyframes = [
		{ frame: 30, rect: { x: 0.2, y: 0.1, w: 0.3, h: 0.8 }, easing: "LINEAR" },
	];
	const source: CompositionSourceFacts = {
			mediaVersionId: project.media.id,
			timeMap: map,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
		context = { media: project.media, analysis };
	const image = documentCanvas();
	const snapshot: CompositionSourceFrame = {
		clipId: clip.id,
		mediaVersionId: project.media.id,
		sourceFrame: 0,
		width: 1920,
		height: 1080,
		image,
	};
	return {
		project: {
			...project,
			draft: document,
			analysis,
			compositionSources: [source],
		},
		document,
		clip,
		source,
		context,
		snapshot,
	};
}
function documentCanvas() {
	const image = document.createElement("canvas");
	image.width = 1920;
	image.height = 1080;
	return image;
}

it("uses AISA only for the exact primary-source binding and scene/shot tuple", () => {
	const f = fixture();
	expect(
		cropCandidateSubjects(f.document, f.clip, f.source, f.context),
	).toEqual(f.context.analysis.document.scenes[0]?.shots[0]?.mainSubjects);
	const foreign = {
		...f.clip,
		mediaVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	};
	expect(
		cropCandidateSubjects(f.document, foreign, f.source, f.context),
	).toBeUndefined();
	expect(
		cropCandidateSubjects(
			f.document,
			{ ...f.clip, evidence: { sceneId: f.clip.id, shotIndex: 0 } },
			f.source,
			f.context,
		),
	).toBeUndefined();
	const untrusted = structuredClone(f.document);
	if (!untrusted.autoGeneration) throw Error("Missing binding");
	untrusted.autoGeneration.binding.kind = "FIXTURE_AUTHORED";
	expect(
		cropCandidateSubjects(untrusted, f.clip, f.source, f.context),
	).toBeUndefined();
});

it("compares one current source image and changes only the fallback rectangle and confirmation flag", async () => {
	const f = fixture(),
		changed = vi.fn(),
		reader = vi.fn(() => f.snapshot),
		before = structuredClone(f.document);
	renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={reader}
			frameRevision={1}
			disabled={false}
			onChange={changed}
		/>,
		"ja",
	);
	await waitFor(() => expect(draw).toHaveBeenCalled());
	expect(reader).toHaveBeenCalledOnce();
	expect(draw.mock.calls.every((call) => call[0] === f.snapshot.image)).toBe(
		true,
	);
	expect(document.querySelectorAll("video")).toHaveLength(0);
	fireEvent.click(
		screen.getByRole("button", { name: "「この場面の構図候補」の説明" }),
	);
	expect(changed).not.toHaveBeenCalled();
	expect(screen.getByRole("note")).toHaveTextContent("追跡済み区間は保ちます");
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	expect(changed).toHaveBeenCalledOnce();
	const next = changed.mock.calls[0]?.[0] as CompositionDocument;
	expect(next.presentation).toEqual({
		...before.presentation,
		centerCropConfirmed: false,
	});
	expect(next.clips[0]?.framing).toEqual(before.clips[0]?.framing);
	expect(next.clips[0]?.cropKeyframes).toEqual(before.clips[0]?.cropKeyframes);
	expect(next.clips[0]?.videoFit).toEqual(before.clips[0]?.videoFit);
	expect(next.clips[0]?.fallbackCrop).toEqual(
		shotCropCandidates({
			sourceWidth: f.source.width,
			sourceHeight: f.source.height,
			targetWidth: 1080,
			targetHeight: 1920,
			mainSubjects:
				f.context.analysis.document.scenes[0]?.shots[0]?.mainSubjects,
		})[0]?.rect,
	);
	expect(f.document).toEqual(before);
});

it.each([
	"analysis",
	"locale",
	"source",
	"map",
	"dimensions",
	"shot",
])("rejects AISA positions when %s is outside the fixed tuple", (part) => {
	const f = fixture();
	if (part === "analysis") f.context.analysis.id = f.clip.id;
	if (part === "locale") f.context.analysis.locale = "ja";
	if (part === "source") f.context.media.sourceId = f.clip.id;
	if (part === "map") f.source.timeMap.id = f.clip.id;
	if (part === "dimensions") f.source.width = 640;
	if (part === "shot")
		f.clip.evidence = {
			sceneId: f.clip.evidence?.sceneId ?? f.clip.id,
			shotIndex: 99,
		};
	expect(
		cropCandidateSubjects(f.document, f.clip, f.source, f.context),
	).toBeUndefined();
});

it("clears the old image immediately and never uses a snapshot from another clip", async () => {
	const f = fixture(),
		changed = vi.fn(),
		reader = vi.fn((): CompositionSourceFrame | null => f.snapshot);
	const tree = (revision: number) => (
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={reader}
			frameRevision={revision}
			disabled={false}
			onChange={changed}
		/>
	);
	const view = renderLocalized(tree(1), "ja");
	await waitFor(() =>
		expect(view.container.querySelectorAll("canvas").length).toBeGreaterThan(0),
	);
	reader.mockReturnValue({
		...f.snapshot,
		clipId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	});
	view.rerender(tree(2));
	expect(view.container.querySelectorAll("canvas")).toHaveLength(0);
	expect(view.container.querySelector("section")).toHaveAttribute(
		"data-preview-state",
		"unavailable",
	);
	for (const button of view.container.querySelectorAll("[data-crop-candidate]"))
		expect(button).toBeDisabled();
	expect(changed).not.toHaveBeenCalled();
	expect(reader).toHaveBeenCalledTimes(2);
});

it("keeps read-only help available while candidate edits stay disabled", async () => {
	const f = fixture(),
		changed = vi.fn();
	renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={() => f.snapshot}
			frameRevision={1}
			disabled
			onChange={changed}
		/>,
		"ja",
	);
	await waitFor(() => expect(draw).toHaveBeenCalled());
	fireEvent.click(
		screen.getByRole("button", { name: "「この場面の構図候補」の説明" }),
	);
	expect(screen.getByRole("note")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	expect(changed).not.toHaveBeenCalled();
});

it("projects candidate thumbnails through the same BANDS main viewport and marks partial AISA bounds", async () => {
	const f = fixture();
	if (!f.document.presentation) throw Error("Missing presentation");
	f.document.presentation.captionPlacement = "BANDS";
	renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={() => f.snapshot}
			frameRevision={1}
			disabled={false}
			onChange={vi.fn()}
		/>,
		"ja",
	);
	await waitFor(() => expect(draw).toHaveBeenCalled());
	expect(screen.getByText("一部が切れます")).toBeVisible();
	const first = draw.mock.calls[0];
	if (!first) throw Error("Missing candidate draw");
	expect(first[6]).toBeGreaterThan(0);
	expect(first[8]).toBeLessThan(284);
	expect(document.querySelector('[data-crop-kind="AISA"]')).toHaveAttribute(
		"data-preview-state",
		"ready",
	);
});

it("wires current source frames into the workbench, keeps Generate available, and preserves Undo and saved raw framing", async () => {
	const f = fixture();
	if (!f.project.draft.presentation) throw Error("Missing presentation");
	f.project.draft.presentation.centerCropConfirmed = false;
	for (const part of f.clip.framing) part.origin = "MANUAL";
	readerSnapshot = f.snapshot;
	api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...f.project,
					draft: JSON.parse(String(init.body)).document,
					draftRevision: 2,
				}
			: { media: [] },
	);
	renderWithQuery(<CompositionWorkbench project={f.project} />, "ja");
	expect(screen.queryByRole("heading", { name: "構図候補を確認" })).toBeNull();
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /AISA参考 1/ })).toBeEnabled(),
	);
	const before = structuredClone(f.document);
	expect(
		screen.queryByRole("checkbox", { name: "提案された構図を確認しました" }),
	).toBeNull();
	expect(screen.getByRole("button", { name: "生成" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	expect(screen.getByRole("button", { name: /AISA参考 1/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(
		screen.queryByRole("checkbox", { name: "提案された構図を確認しました" }),
	).toBeNull();
	expect(screen.getByRole("button", { name: "生成" })).toBeEnabled();
	expect(
		api.mock.calls.filter(([, init]) => init?.method && init.method !== "GET"),
	).toHaveLength(0);
	fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
	expect(
		JSON.parse(screen.getByLabelText("Preview document").textContent ?? "null")
			.clips,
	).toEqual(before.clips);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /AISA参考 1/ })).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
	await waitFor(() =>
		expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
			true,
		),
	);
	const call = api.mock.calls.find(([, init]) => init?.method === "PUT");
	if (!call) throw Error("Missing save");
	const saved = JSON.parse(String(call[1].body))
		.document as CompositionDocument;
	expect(saved.clips[0]?.fallbackCrop).toBeDefined();
	expect(saved.clips[0]?.framing).toEqual(before.clips[0]?.framing);
	expect(saved.clips[0]?.cropKeyframes).toEqual(before.clips[0]?.cropKeyframes);
	expect(saved.presentation?.centerCropConfirmed).toBe(false);
});

it("rejects a stale source frame even when clip and media ids match", () => {
	const f = fixture();
	const view = renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={1}
			expectedSourceFrame={1}
			frameReader={() => f.snapshot}
			frameRevision={1}
			disabled={false}
			onChange={vi.fn()}
		/>,
		"ja",
	);
	expect(view.container.querySelectorAll("canvas")).toHaveLength(0);
	expect(view.container.querySelector("section")).toHaveAttribute(
		"data-preview-state",
		"unavailable",
	);
});

it("does not dirty or unconfirm a project when its active candidate is selected again", async () => {
	const f = fixture(),
		changed = vi.fn();
	const candidate = shotCropCandidates({
		sourceWidth: f.source.width,
		sourceHeight: f.source.height,
		targetWidth: f.document.canvas.width,
		targetHeight: f.document.canvas.height,
		mainSubjects: f.context.analysis.document.scenes[0]?.shots[0]?.mainSubjects,
	})[0];
	if (!candidate) throw Error("Missing candidate");
	f.clip.fallbackCrop = candidate.rect;
	renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={() => f.snapshot}
			frameRevision={1}
			disabled={false}
			onChange={changed}
		/>,
		"ja",
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /AISA参考 1/ })).toBeEnabled(),
	);
	expect(screen.getByRole("button", { name: /AISA参考 1/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	expect(changed).not.toHaveBeenCalled();
	expect(f.document.presentation?.centerCropConfirmed).toBe(true);
});

it.each([
	"policy",
	"presentation",
])("offers only position candidates for legacy documents missing %s without editing them", async (missing) => {
	const f = fixture();
	if (missing === "presentation") {
		delete f.document.presentation;
		f.clip.videoFit = "FILL";
	} else if (f.document.presentation) {
		delete f.document.presentation.fallbackFraming;
	}
	const before = structuredClone(f.document),
		changed = vi.fn();
	expect(
		cropCandidateSubjects(f.document, f.clip, f.source, f.context),
	).toBeUndefined();
	const view = renderLocalized(
		<CropCandidates
			document={f.document}
			clip={f.clip}
			source={f.source}
			context={f.context}
			frame={0}
			expectedSourceFrame={0}
			frameReader={() => f.snapshot}
			frameRevision={1}
			disabled={false}
			onChange={changed}
		/>,
		"ja",
	);
	await waitFor(() => expect(draw).toHaveBeenCalled());
	expect(view.container.querySelector('[data-crop-kind="AISA"]')).toBeNull();
	expect(
		[...view.container.querySelectorAll("[data-crop-candidate]")].map(
			(button) => button.getAttribute("data-crop-candidate"),
		),
	).toEqual(["left", "center", "right"]);
	expect(changed).not.toHaveBeenCalled();
	expect(f.document).toEqual(before);
});

it.each([
	{
		name: "portrait bands cut a canonically fitting box",
		width: 1080,
		height: 1920,
		box: [100, 450, 900, 550],
		canonical: "FULL",
		label: "一部が切れます",
		sourceRect: [0, 346, 1080, 1228],
	},
	{
		name: "wider landscape-source bands include a canonically partial box",
		width: 1920,
		height: 1080,
		box: [100, 300, 900, 700],
		canonical: "PARTIAL",
		label: "AISAの枠が収まります",
		sourceRect: [485, 0, 950, 1080],
	},
])("reports displayed coverage when $name", async (test) => {
	const f = fixture(),
		presentation = f.document.presentation,
		binding = f.document.autoGeneration?.binding,
		subject = f.context.analysis.document.scenes[0]?.shots[0]?.mainSubjects[0];
	if (!presentation || !binding || !subject) throw Error("Missing fixture");
	presentation.captionPlacement = "BANDS";
	subject.box2d = test.box as [number, number, number, number];
	f.source.width = f.context.media.width = binding.width = test.width;
	f.source.height = f.context.media.height = binding.height = test.height;
	f.snapshot.width = f.snapshot.image.width = test.width;
	f.snapshot.height = f.snapshot.image.height = test.height;
	const candidates = shotCropCandidates({
		sourceWidth: test.width,
		sourceHeight: test.height,
		targetWidth: f.document.canvas.width,
		targetHeight: f.document.canvas.height,
		mainSubjects: [subject],
	});
	expect(candidates[0]?.coverage).toBe(test.canonical);
	const before = structuredClone(f.document),
		changed = vi.fn(),
		view = renderLocalized(
			<CropCandidates
				document={f.document}
				clip={f.clip}
				source={f.source}
				context={f.context}
				frame={0}
				expectedSourceFrame={0}
				frameReader={() => f.snapshot}
				frameRevision={1}
				disabled={false}
				onChange={changed}
			/>,
			"ja",
		);
	await waitFor(() => expect(draw).toHaveBeenCalled());
	expect(screen.getByRole("button", { name: /AISA参考 1/ })).toHaveTextContent(
		test.label,
	);
	expect(
		[...view.container.querySelectorAll("[data-crop-candidate]")].map(
			(button) => button.getAttribute("data-crop-candidate"),
		),
	).toEqual(candidates.map((candidate) => candidate.id));
	expect(draw.mock.calls[0]?.slice(1, 5)).toEqual(test.sourceRect);
	fireEvent.click(screen.getByRole("button", { name: /AISA参考 1/ }));
	expect(changed.mock.calls[0]?.[0].clips[0].fallbackCrop).toEqual(
		candidates[0]?.rect,
	);
	expect(f.document).toEqual(before);
});

it("removes shot references after a source-start edit, restores them with Undo, and keeps them absent after save and reload", async () => {
	const f = fixture();
	readerSnapshot = f.snapshot;
	api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "PUT"
			? {
					...f.project,
					draft: JSON.parse(String(init.body)).document,
					draftRevision: 2,
				}
			: { media: [] },
	);
	const view = renderWithQuery(
		<CompositionWorkbench project={f.project} />,
		"ja",
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /AISA参考 1/ })).toBeEnabled(),
	);
	const changeSource = () => {
		const input = screen.getByRole("spinbutton", {
			name: "元映像の開始（秒）",
		});
		fireEvent.change(input, {
			target: { value: "10" },
		});
		fireEvent.blur(input);
	};
	changeSource();
	expect(screen.queryByRole("button", { name: /AISA参考/ })).toBeNull();
	expect(
		view.container.querySelectorAll('[data-crop-kind="POSITION"]'),
	).toHaveLength(3);
	const edited = JSON.parse(
		screen.getByLabelText("Preview document").textContent ?? "null",
	) as CompositionDocument;
	expect(edited.clips[0]?.sourceInUs).toBe(10_000_000);
	expect(edited.clips[0]?.evidence).toEqual({
		sceneId: f.clip.evidence?.sceneId,
	});
	expect(edited.presentation?.centerCropConfirmed).toBe(false);
	fireEvent.click(screen.getByText("編集の操作"));
	expect(
		screen.getByText(
			"未追跡区間は固定構図を使います。元映像の枠や場面ごとの候補から調整できます。",
		),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /AISA参考 1/ })).toBeEnabled(),
	);
	expect(
		JSON.parse(screen.getByLabelText("Preview document").textContent ?? "null")
			.clips[0].evidence,
	).toEqual(f.clip.evidence);
	changeSource();
	fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
	await waitFor(() =>
		expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
			true,
		),
	);
	const save = api.mock.calls.find(([, init]) => init?.method === "PUT");
	if (!save) throw Error("Missing save");
	const saved = compositionDocumentSchema.parse(
		JSON.parse(String(save[1].body)).document,
	);
	expect(Object.hasOwn(saved.clips[0]?.evidence ?? {}, "shotIndex")).toBe(
		false,
	);
	view.unmount();
	const reload = renderWithQuery(
		<CompositionWorkbench
			project={{ ...f.project, draft: saved, draftRevision: 2 }}
		/>,
		"ja",
	);
	expect(screen.queryByRole("button", { name: /AISA参考/ })).toBeNull();
	expect(
		reload.container.querySelectorAll('[data-crop-kind="POSITION"]'),
	).toHaveLength(3);
});

it("retains verified AISA references for protected projects only when Fill is explicitly selected", () => {
	const f = fixture();
	if (!f.document.presentation) throw Error("Missing presentation");
	f.document.presentation.fallbackFraming = "PRESERVE_SOURCE_V1";
	f.document.presentation.videoFit = "AUTO";
	const before = structuredClone(f.document),
		changed = vi.fn();
	const props = {
		document: f.document,
		clip: f.clip,
		source: f.source,
		context: f.context,
		frame: 0,
		expectedSourceFrame: 0,
		frameReader: () => f.snapshot,
		frameRevision: 1,
		disabled: false,
		onChange: changed,
	};
	const view = renderLocalized(<CropCandidates {...props} />, "ja");
	expect(view.container.querySelector("[data-crop-candidate]")).toBeNull();
	expect(
		cropCandidateSubjects(f.document, f.clip, f.source, f.context),
	).toEqual(f.context.analysis.document.scenes[0]?.shots[0]?.mainSubjects);
	expect(f.document).toEqual(before);
	f.document.presentation.videoFit = "FILL";
	view.rerender(<CropCandidates {...props} />);
	expect(
		view.container.querySelector('[data-crop-kind="AISA"]'),
	).not.toBeNull();
	expect(changed).not.toHaveBeenCalled();
	const first = view.container.querySelector<HTMLButtonElement>(
		'[data-crop-kind="AISA"]',
	);
	if (!first) throw Error("Missing AISA candidate");
	fireEvent.click(first);
	expect(changed).toHaveBeenCalledOnce();
	const next = changed.mock.calls[0]?.[0] as CompositionDocument;
	expect(next.clips[0]?.framing).toEqual(before.clips[0]?.framing);
	expect(next.clips[0]?.cropKeyframes).toEqual(before.clips[0]?.cropKeyframes);
	expect(next.clips[0]?.fallbackCrop).toBeDefined();
	expect(next.presentation).toMatchObject({
		videoFit: "FILL",
		fallbackFraming: "PRESERVE_SOURCE_V1",
		centerCropConfirmed: false,
	});
});
