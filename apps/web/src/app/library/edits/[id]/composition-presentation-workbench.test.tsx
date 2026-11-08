import {
	type CompositionDocument,
	canonicalEditingJson,
	compositionDocumentSchema,
	confirmCompositionFraming,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingIds, editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "none",
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
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
function fixture() {
	const original = editingProjectFixture();
	if (!original.media.timeMap) throw new Error("Missing fixture time map");
	return {
		...original,
		currentRevisionId: editingIds.revision,
		currentRevisionMatchesDraft: true,
		draft: toCompositionDocument(original.draft),
		compositionSources: [
			{
				mediaVersionId: original.media.id,
				timeMap: original.media.timeMap,
				width: 1920,
				height: 1080,
				hasAudio: true,
			},
		],
	};
}
function visible() {
	return compositionDocumentSchema.parse(
		JSON.parse(
			screen.getByLabelText("Visible edit document").textContent ?? "null",
		),
	);
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
beforeEach(() => mocks.api.mockReset());
it("keeps presentation and caption background edits through history, save and reload", async () => {
	const project = fixture();
	let stored = project;
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") {
			const input = JSON.parse(String(init.body));
			expect(input.expectedRevision).toBe(stored.draftRevision);
			stored = {
				...stored,
				draft: input.document,
				draftRevision: 2,
				currentRevisionMatchesDraft: false,
			};
			return stored;
		}
		return { media: [] };
	});
	const view = renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.change(screen.getByLabelText("Video framing"), {
		target: { value: "FILL" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(screen.getByLabelText("Caption placement"), {
		target: { value: "BANDS" },
	});
	fireEvent.change(screen.getByLabelText("Caption background color"), {
		target: { value: "#123456" },
	});
	fireEvent.change(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
		{ target: { value: "25" } },
	);
	expect(visible().presentation).toMatchObject({
		videoFit: "FILL",
		captionPlacement: "BANDS",
	});
	expect(visible().captionStyle?.backgroundColor).toBe("#12345640");
	fireEvent.click(screen.getByRole("button", { name: "Undo" }));
	expect(visible().captionStyle?.backgroundColor).toBe("#123456B3");
	fireEvent.click(screen.getByRole("button", { name: "Redo" }));
	expect(visible().captionStyle?.backgroundColor).toBe("#12345640");
	const expected = canonicalEditingJson(visible());
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await waitFor(() => expect(writes()).toHaveLength(1));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled(),
	);
	expect(canonicalEditingJson(stored.draft)).toBe(expected);
	view.unmount();
	renderWithQuery(<CompositionWorkbench project={stored} />);
	expect(canonicalEditingJson(visible())).toBe(expected);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	expect(screen.getByLabelText("Caption placement")).toHaveValue("BANDS");
	expect(screen.getByLabelText("Caption background color")).toHaveValue(
		"#123456",
	);
	expect(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
	).toHaveValue("25");
});
it("adopts the current automatic crop on Generate and matches the server snapshot after a manual edit", async () => {
	const project = fixture();
	const map = project.media.timeMap;
	if (!map) throw new Error("Missing map");
	const hash = "a".repeat(64),
		analysisId = "77777777-7777-4777-8777-777777777777";
	// Structural fixture metadata, not an attested production association.
	project.draft.analysisRevisionId = analysisId;
	project.draft.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: hash,
		requestedDurationFrames: 300,
		generatedDurationFrames: 300,
		reasonCodes: [],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
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
			sourceStartUs: 0,
			sourceEndUs: 60_000_000,
			width: 1920,
			height: 1080,
		},
	};
	project.draft.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		centerCropConfirmed: false,
	};
	for (const clip of project.draft.clips) {
		clip.evidence = { sceneId: analysisId, shotIndex: 0 };
		for (const part of clip.framing) part.origin = "AUTO_POLICY";
	}
	let stored = project;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		const input = JSON.parse(String(init.body));
		if (init.method === "PUT") {
			const document = compositionDocumentSchema.parse(input.document);
			for (const clip of document.clips)
				for (const part of clip.framing)
					if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
			stored = {
				...stored,
				draft: document,
				draftRevision: 2,
				currentRevisionMatchesDraft: false,
			};
			return stored;
		}
		if (url.endsWith("/revisions")) {
			expect(input).toMatchObject({
				expectedRevision: 2,
				confirmSuggestions: true,
			});
			stored = {
				...stored,
				draft: confirmCompositionFraming(stored.draft),
				draftRevision: 3,
				currentRevisionId: "88888888-8888-4888-8888-888888888888",
				currentRevisionMatchesDraft: true,
			};
			return stored;
		}
		return {
			id: "99999999-9999-4999-8999-999999999999",
			revisionId: stored.currentRevisionId,
			kind: "EXPORT",
			state: "QUEUED",
			generation: 1,
			error: null,
			artifact: null,
		};
	});
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.queryByRole("heading", { name: "Review the central crop" }),
	).not.toBeInTheDocument();
	const generate = screen.getByRole("button", { name: "Generate MP4" });
	expect(generate).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Audio" }));
	const volume = screen.getByLabelText("Volume (dB)");
	fireEvent.change(volume, { target: { value: "-1" } });
	expect(generate).toBeDisabled();
	fireEvent.blur(volume);
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
		}),
	).not.toBeInTheDocument();
	expect(generate).toBeEnabled();
	fireEvent.click(generate);
	await waitFor(() => expect(writes()).toHaveLength(3));
	expect(writes().map(([url]) => String(url).split("/").at(-1))).toEqual([
		"draft",
		"revisions",
		"renders",
	]);
	expect(stored.draft.presentation?.centerCropConfirmed).toBe(true);
	expect(stored.draft.autoGeneration).toEqual(project.draft.autoGeneration);
	expect(stored.draft.clips[0]?.framing[0]?.origin).toBe("MANUAL");
	expect(stored.draft.clips[0]?.framing[0]?.mode).toBe("FIT");
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("does not hide a pending caption position when switching presentation", () => {
	const project = fixture();
	mocks.api.mockResolvedValue({ media: [] });
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	const position = screen.getByLabelText("Caption vertical position");
	fireEvent.change(position, { target: { value: "0.72" } });
	expect(screen.getByLabelText("Caption placement")).toBeDisabled();
	expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(position).toHaveValue(0.72);
	fireEvent.blur(position);
	expect(visible().captionLayout?.y).toBe(0.72);
	expect(screen.getByLabelText("Caption placement")).toBeEnabled();
	expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
});
