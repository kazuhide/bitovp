import {
	type CompositionDocument,
	canonicalEditingJson,
	compositionCaptionClipSnapshot,
	compositionCaptionSourceSnapshot,
	compositionDocumentSchema,
	hashEditingEvidence,
	normalizeManualCaptionSourceEvidenceEdits,
	normalizeManualCaptionTranslationEdits,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	permitted: true,
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.permitted,
}));
vi.mock("../../[id]/edits/use-editing-actor", () => ({
	useEditingActor: () => "operator:org",
}));
vi.mock("../../[id]/edits/association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({
		plan,
	}: {
		plan: { document: CompositionDocument };
	}) => (
		<output aria-label="Visible edit document">
			{JSON.stringify(plan.document)}
		</output>
	),
}));

const taskId = "77777777-7777-4777-8777-777777777777";
function fixture(automaticFraming = false, sourceReferences = false) {
	const old = editingProjectFixture();
	if (!old.media.timeMap) throw new Error("Missing fixture clock");
	const draft = toCompositionDocument(old.draft);
	draft.analysisRevisionId = "88888888-8888-4888-8888-888888888888";
	draft.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
	};
	draft.captionDisplayLanguage = "ja";
	draft.captions = [
		{
			id: "99999999-9999-4999-8999-999999999999",
			fromFrame: 10,
			toFrame: 80,
			text: "Hello world.",
			words: [
				{ text: "Hello", startChar: 0, endChar: 5, fromFrame: 10, toFrame: 30 },
			],
			translation: {
				targetLanguage: "ja",
				text: "こんにちは。",
				sourceText: "Hello world.",
				sourceTextHash: hashEditingEvidence("Hello world."),
				origin: "LOCAL_LLM",
				evidenceHash: "b".repeat(64),
			},
		},
	];
	if (sourceReferences) {
		const caption = draft.captions[0],
			clip = draft.clips[0];
		if (!caption || !clip) throw new Error("Missing source reference fixture");
		// Structural source reference, not an ASR/native quality receipt.
		caption.sourceEvidence = {
			version: "source-caption-v1",
			mediaVersionId: draft.mediaVersionId,
			timeMapId: draft.timeMapId,
			segmentIndex: 0,
			segmentStartUs: 333333,
			segmentEndUs: 2666667,
			segmentTextHash: hashEditingEvidence(caption.text),
			transcriptSegmentsHash: "c".repeat(64),
			caption: compositionCaptionSourceSnapshot(caption),
			spans: [
				{
					clipId: clip.id,
					sourceFromFrame: 10,
					sourceToFrame: 80,
					outputFromFrame: 10,
					outputToFrame: 80,
					clip: compositionCaptionClipSnapshot(clip),
				},
			],
		};
	}
	if (automaticFraming) {
		// Structural UI fixture; this is not an attested provider association.
		const hash = "a".repeat(64);
		draft.autoGeneration = {
			policyVersion: "aisa-shot-window-v1",
			requestHash: hash,
			requestedDurationFrames: 300,
			generatedDurationFrames: 300,
			reasonCodes: [],
			binding: {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId: "00000000-0000-4000-8000-000000000001",
				sourceId: old.media.sourceId,
				locale: "en",
				analysisRevisionId: draft.analysisRevisionId,
				analysisRawHash: hash,
				analysisDocumentHash: hash,
				mediaVersionId: old.media.id,
				mediaSha256: hash,
				timeMapId: old.media.timeMap.id,
				timeMapHash: hash,
				sourceStartUs: 0,
				sourceEndUs: 60000000,
				width: 1920,
				height: 1080,
			},
		};
		for (const clip of draft.clips) {
			clip.evidence = { sceneId: draft.analysisRevisionId, shotIndex: 0 };
			for (const part of clip.framing) part.origin = "AUTO_POLICY";
		}
	}
	const project = {
		...old,
		draft,
		compositionSources: [
			{
				mediaVersionId: old.media.id,
				timeMap: old.media.timeMap,
				width: 1920,
				height: 1080,
				hasAudio: true,
			},
		],
	};
	const eligibility = {
		sourceId: old.media.sourceId,
		files: [],
		mediaVersions: [old.media],
		analyses: [{ id: draft.analysisRevisionId, locale: "en", title: "Source" }],
		localStoryAvailable: false,
		captionTranslationAvailable: true,
	};
	let stored = project;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/editing-eligibility")) return eligibility;
		if (!init?.method) return { media: [] };
		if (init.method === "PUT") {
			const input = JSON.parse(String(init.body));
			expect(input.expectedRevision).toBe(stored.draftRevision);
			for (const clip of input.document.clips)
				for (const part of clip.framing)
					if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
			stored = {
				...stored,
				draft: normalizeManualCaptionSourceEvidenceEdits(
					stored.draft,
					normalizeManualCaptionTranslationEdits(
						stored.draft,
						compositionDocumentSchema.parse(input.document),
					),
				),
				draftRevision: stored.draftRevision + 1,
			};
			return stored;
		}
		if (url === "/api/library/media-tasks")
			return { taskId, state: "PENDING", cached: false };
		throw new Error(`Unexpected mutation ${url}`);
	});
	return { project, eligibility, stored: () => stored };
}
function visible() {
	return compositionDocumentSchema.parse(
		JSON.parse(
			screen.getByLabelText("Visible edit document").textContent ?? "null",
		),
	);
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.permitted = true;
});

it("continues reproposal after an original subtitle correction clears its stale source reference", async () => {
	const { project, stored } = fixture(false, true);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption display language" }),
		{ target: { value: "ORIGINAL" } },
	);
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "Manual source correction." },
	});
	fireEvent.click(screen.getByRole("button", { name: "Revise this proposal" }));
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(
		await within(dialog).findByRole("button", { name: "Association checked" }),
	);
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "Save and create another proposal",
		}),
	);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(writes().map(([, init]) => init.method)).toEqual(["PUT", "POST"]);
	expect(stored().draft.captions?.[0]?.sourceEvidence).toBeUndefined();
	expect(stored().draft.captions?.[0]?.text).toBe("Manual source correction.");
});

it("applies fill to the current timeline immediately, preserves captions, and supports Undo without encoding", async () => {
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	const preview = screen.getByLabelText("Visible edit document");
	const before = canonicalEditingJson(visible());
	fireEvent.click(screen.getByRole("button", { name: "Revise this proposal" }));
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Crop to fill" }));
	expect(visible().presentation?.videoFit).toBe("FILL");
	expect(visible().captions).toEqual(project.draft.captions);
	expect(
		visible().clips.map(({ sourceInUs, durationFrames }) => ({
			sourceInUs,
			durationFrames,
		})),
	).toEqual(
		project.draft.clips.map(({ sourceInUs, durationFrames }) => ({
			sourceInUs,
			durationFrames,
		})),
	);
	expect(screen.getByLabelText("Visible edit document")).toBe(preview);
	expect(writes()).toHaveLength(0);
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(canonicalEditingJson(visible())).toBe(before);
	expect(writes()).toHaveLength(0);
});

it.each([
	false,
	true,
])("saves subtitles before another DRAFT including normalized automatic framing (%s)", async (automaticFraming) => {
	const { project, stored } = fixture(automaticFraming);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "ようこそ。" },
	});
	const edited = canonicalEditingJson(visible());
	fireEvent.click(screen.getByRole("button", { name: "Revise this proposal" }));
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(
		await within(dialog).findByRole("button", { name: "Association checked" }),
	);
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "Save and create another proposal",
		}),
	);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(writes().map(([url, init]) => [url, init.method])).toEqual([
		[`/api/library/edits/${project.id}/draft`, "PUT"],
		["/api/library/media-tasks", "POST"],
	]);
	if (automaticFraming) {
		expect(
			stored()
				.draft.clips.flatMap((clip) => clip.framing)
				.every((part) => part.origin === "MANUAL"),
		).toBe(true);
		expect(stored().draft.captions?.[0]?.translation?.text).toBe("ようこそ。");
	} else expect(canonicalEditingJson(stored().draft)).toBe(edited);
	expect(stored().id).toBe(project.id);
	expect(stored().draft.captions?.[0]?.translation).toMatchObject({
		text: "ようこそ。",
		origin: "MANUAL",
		derivedFromEvidenceHash: "b".repeat(64),
	});
	expect(JSON.parse(writes()[1]?.[1].body).parameters).toMatchObject({
		renderMode: "DRAFT",
		captions: "JAPANESE",
		variants: 1,
	});
});

it("still rejects unexpected saved content instead of treating every server change as normalization", async () => {
	const { project } = fixture(true);
	const handler = mocks.api.getMockImplementation();
	mocks.api.mockImplementation(async (url, init) => {
		const response = await handler?.(url, init);
		if (init?.method !== "PUT") return response;
		return {
			...response,
			draft: {
				...response.draft,
				captions: response.draft.captions.map((caption: { text: string }) => ({
					...caption,
					text: "Unexpected server content",
				})),
			},
		};
	});
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "ようこそ。" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Revise this proposal" }));
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(
		await within(dialog).findByRole("button", { name: "Association checked" }),
	);
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "Save and create another proposal",
		}),
	);
	await within(dialog).findByRole("alert");
	expect(writes().map(([, init]) => init.method)).toEqual(["PUT"]);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(visible().captions?.[0]?.text).toBe("Hello world.");
});

it("keeps original text and word timing separate from Japanese, and drops stale translation after source edits", () => {
	const { project } = fixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	expect(screen.getByLabelText("Caption text 1")).toHaveValue("こんにちは。");
	expect(
		screen.getByRole("button", { name: "こんにちは。" }),
	).toBeInTheDocument();
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "やあ、世界。" },
	});
	expect(visible().captions?.[0]?.text).toBe("Hello world.");
	expect(visible().captions?.[0]?.words).toEqual(
		project.draft.captions?.[0]?.words,
	);
	expect(visible().captions?.[0]?.translation?.evidenceHash).toBeUndefined();
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption display language" }),
		{ target: { value: "ORIGINAL" } },
	);
	expect(screen.getByLabelText("Caption text 1")).toHaveValue("Hello world.");
	expect(
		screen.getByRole("button", { name: "Hello world." }),
	).toBeInTheDocument();
	fireEvent.change(screen.getByLabelText("Caption text 1"), {
		target: { value: "Goodbye world." },
	});
	expect(visible().captions?.[0]?.words).toBeUndefined();
	expect(visible().captions?.[0]?.translation?.sourceText).toBe("Hello world.");
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption display language" }),
		{ target: { value: "ja" } },
	);
	expect(screen.getByLabelText("Caption text 1")).toHaveValue("Goodbye world.");
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(writes()).toHaveLength(0);
});

it("does not allow viewers to change caption language or create another proposal", () => {
	const { project } = fixture();
	mocks.permitted = false;
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.queryByRole("button", { name: "Revise this proposal" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("combobox", { name: "Caption display language" }),
	).not.toBeInTheDocument();
	expect(visible().captions).toEqual(project.draft.captions);
	expect(writes()).toHaveLength(0);
});
