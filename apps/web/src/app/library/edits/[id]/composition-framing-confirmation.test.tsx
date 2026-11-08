import {
	type CompositionDocument,
	compileComposition,
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
		<output aria-label="Visible confirmation draft">
			{JSON.stringify(plan.document)}
		</output>
	),
}));
const confirmedRevision = "88888888-8888-4888-8888-888888888888";
function fixture(kind: "central" | "AISA" | "legacy" | "confirmed") {
	const original = editingProjectFixture(),
		draft = toCompositionDocument(original.draft),
		map = original.media.timeMap;
	if (!map) throw new Error("Missing fixture map");
	if (kind === "central" || kind === "confirmed") {
		const analysisId = "77777777-7777-4777-8777-777777777777",
			hash = "a".repeat(64);
		draft.analysisRevisionId = analysisId;
		// Structural UI fixture only; no stored or provider association is claimed.
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
				sourceId: original.media.sourceId,
				locale: "en",
				analysisRevisionId: analysisId,
				analysisRawHash: hash,
				analysisDocumentHash: hash,
				mediaVersionId: original.media.id,
				mediaSha256: hash,
				timeMapId: map.id,
				timeMapHash: hash,
				sourceStartUs: 0,
				sourceEndUs: 60_000_000,
				width: 1920,
				height: 1080,
			},
		};
		draft.presentation = {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "OVERLAY",
			centerCropConfirmed: kind === "confirmed",
		};
	}
	if (kind === "AISA") {
		const part = draft.clips[0]?.framing[0];
		if (!part) throw new Error("Missing fixture framing");
		part.origin = "AISA_PROPOSAL";
	}
	return {
		...original,
		draft: compositionDocumentSchema.parse(draft),
		currentRevisionId: editingIds.revision,
		currentRevisionMatchesDraft: true,
		compositionSources: [
			{
				mediaVersionId: original.media.id,
				timeMap: map,
				width: 1920,
				height: 1080,
				hasAudio: true,
			},
		],
	};
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
function server(project: ReturnType<typeof fixture>) {
	let stored = project;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		const input = JSON.parse(String(init.body));
		if (url.endsWith("/revisions")) {
			expect(input.expectedRevision).toBe(stored.draftRevision);
			expect(input.confirmSuggestions).toBe(true);
			stored = {
				...stored,
				draft: confirmCompositionFraming(stored.draft),
				draftRevision: stored.draftRevision + 1,
				currentRevisionId: confirmedRevision,
				currentRevisionMatchesDraft: true,
			};
			return stored;
		}
		if (!url.endsWith("/renders"))
			throw new Error("Unexpected draft write for an unedited project");
		// The export boundary rejects the actual old unconfirmed document.
		compileComposition(stored.draft, stored.compositionSources);
		expect(input.revisionId).toBe(stored.currentRevisionId);
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
	return () => stored;
}
beforeEach(() => mocks.api.mockReset());
it.each([
	"central",
	"AISA",
] as const)("adopts an unedited matching %s draft on Generate without a checkbox or draft write", async (kind) => {
	const project = fixture(kind),
		stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	const generate = screen.getByRole("button", { name: "Generate MP4" });
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
		}),
	).not.toBeInTheDocument();
	expect(generate).toBeEnabled();
	fireEvent.click(generate);
	await waitFor(() =>
		expect(writes().map(([url]) => String(url).split("/").at(-1))).toEqual([
			"revisions",
			"renders",
		]),
	);
	expect(writes().map(([, init]) => init.method)).toEqual(["POST", "POST"]);
	expect(JSON.parse(String(writes()[1]?.[1].body))).toMatchObject({
		revisionId: confirmedRevision,
		kind: "EXPORT",
	});
	expect(stored().draftRevision).toBe(project.draftRevision + 1);
	expect(stored().draft).toEqual(confirmCompositionFraming(project.draft));
	expect(
		JSON.parse(
			screen.getByLabelText("Visible confirmation draft").textContent ?? "null",
		),
	).toEqual(stored().draft);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each([
	"central",
	"AISA",
] as const)("adopts the displayed %s proposal when saving a revision without starting an export", async (kind) => {
	const project = fixture(kind),
		stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	const save = screen.getByRole("button", { name: "Save revision" });
	expect(save).toBeEnabled();
	expect(writes()).toHaveLength(0);
	fireEvent.click(save);
	await waitFor(() => expect(writes()).toHaveLength(1));
	expect(String(writes()[0]?.[0])).toBe(
		`/api/library/edits/${project.id}/revisions`,
	);
	expect(writes()[0]?.[1].method).toBe("POST");
	expect(JSON.parse(String(writes()[0]?.[1].body))).toEqual({
		expectedRevision: project.draftRevision,
		confirmSuggestions: true,
	});
	expect(stored().draft).toEqual(confirmCompositionFraming(project.draft));
	expect(stored().draftRevision).toBe(project.draftRevision + 1);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each([
	"legacy",
	"confirmed",
] as const)("exports an unedited %s matching revision directly without an extra revision or preview", async (kind) => {
	const project = fixture(kind),
		stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
		}),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(1));
	expect(String(writes()[0]?.[0])).toBe(
		`/api/library/edits/${project.id}/renders`,
	);
	expect(JSON.parse(String(writes()[0]?.[1].body))).toMatchObject({
		revisionId: editingIds.revision,
		kind: "EXPORT",
	});
	expect(stored().draftRevision).toBe(project.draftRevision);
	expect(stored().draft).toEqual(project.draft);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
