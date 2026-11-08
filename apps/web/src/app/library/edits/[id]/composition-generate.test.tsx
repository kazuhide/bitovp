import { type CompositionDocument, toCompositionDocument } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
	AnyEditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import { editingIds, editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	permitted: true,
	organizationId: "00000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.permitted,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "none",
			organizationId: mocks.organizationId,
		},
	}),
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({ plan }: { plan: { durationFrames: number } }) => (
		<output aria-label="Current preview frames">{plan.durationFrames}</output>
	),
}));
function fixture() {
	const old = editingProjectFixture();
	if (!old.media.timeMap) throw new Error("Missing test map");
	return {
		...old,
		currentRevisionId: editingIds.revision,
		currentRevisionMatchesDraft: true,
		draft: toCompositionDocument(old.draft),
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
}
const newRevision = "88888888-8888-4888-8888-888888888888";
beforeEach(() => {
	mocks.api.mockReset();
	mocks.permitted = true;
	mocks.organizationId = "00000000-0000-4000-8000-000000000001";
});
function server(
	project: AnyEditingProjectView & { draft: CompositionDocument } = fixture(),
) {
	let stored = project;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		if (init.method === "PUT") {
			stored = {
				...stored,
				draft: JSON.parse(String(init.body)).document,
				draftRevision: stored.draftRevision + 1,
				currentRevisionMatchesDraft: false,
			};
			if (stored.draft.autoGeneration)
				for (const clip of stored.draft.clips)
					for (const part of clip.framing)
						if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
			return stored;
		}
		if (url.endsWith("/revisions")) {
			const input = JSON.parse(String(init.body));
			if (input.expectedRevision !== stored.draftRevision)
				throw new Error("Revision CAS mismatch");
			stored = structuredClone(stored);
			if (input.confirmSuggestions)
				for (const clip of stored.draft.clips)
					for (const part of clip.framing)
						if (part.origin === "AISA_PROPOSAL")
							part.origin = "EDITOR_CONFIRMED";
			stored = {
				...stored,
				draftRevision: stored.draftRevision + 1,
				currentRevisionId: newRevision,
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
	return () => stored;
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
function write(index: number) {
	const call = writes()[index];
	if (!call) throw new Error(`Missing write ${index}`);
	return call;
}
function trim() {
	const input = screen.getByLabelText("Length (s)");
	fireEvent.change(input, { target: { value: "5" } });
	fireEvent.blur(input);
}
it("saves the visible edit, fixes that revision and queues one EXPORT in a single action", async () => {
	const project = fixture();
	server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	trim();
	expect(screen.getByLabelText("Current preview frames")).toHaveTextContent(
		"150",
	);
	const generate = screen.getByRole("button", { name: "Generate MP4" });
	expect(generate).toBeEnabled();
	act(() => {
		fireEvent.click(generate);
		fireEvent.click(generate);
	});
	await waitFor(() => expect(writes()).toHaveLength(3));
	expect(writes().map(([url, init]) => [url, init.method])).toEqual([
		[`/api/library/edits/${project.id}/draft`, "PUT"],
		[`/api/library/edits/${project.id}/revisions`, "POST"],
		[`/api/library/edits/${project.id}/renders`, "POST"],
	]);
	expect(JSON.parse(write(0)[1].body)).toMatchObject({
		expectedRevision: 1,
		document: { clips: [{ durationFrames: 150 }] },
	});
	expect(JSON.parse(write(1)[1].body)).toMatchObject({ expectedRevision: 2 });
	expect(JSON.parse(write(2)[1].body)).toEqual({
		revisionId: newRevision,
		kind: "EXPORT",
		requestKey: expect.any(String),
	});
});
it("exports a matching saved proposal without creating another revision or a preview render", async () => {
	const project = fixture();
	server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(1));
	expect(JSON.parse(write(0)[1].body)).toMatchObject({
		revisionId: editingIds.revision,
		kind: "EXPORT",
	});
});
it("does not save or generate while a numeric input is unconfirmed", () => {
	server();
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	fireEvent.change(screen.getByLabelText("Length (s)"), {
		target: { value: "5" },
	});
	const generate = screen.getByRole("button", { name: "Generate MP4" });
	expect(generate).toBeDisabled();
	fireEvent.click(generate);
	expect(writes()).toHaveLength(0);
});
it.each([
	"role",
	"organization",
	"foreign-response",
	"remote-revision",
	"unmount",
])("does not publish an old draft after %s changes during its save", async (boundary) => {
	const project = fixture();
	let resolve!: (value: unknown) => void;
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		return new Promise((done) => {
			resolve = done;
		});
	});
	const view = renderWithQuery(<CompositionWorkbench project={project} />);
	trim();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(1));
	const saved = {
		...project,
		draftRevision: 2,
		currentRevisionMatchesDraft: false,
		draft: JSON.parse(write(0)[1].body).document,
	};
	if (boundary === "role") mocks.permitted = false;
	if (boundary === "organization")
		mocks.organizationId = "00000000-0000-4000-8000-000000000002";
	if (boundary === "unmount") view.unmount();
	else
		view.rerender(
			<CompositionWorkbench
				project={
					boundary === "remote-revision"
						? { ...project, draftRevision: 7 }
						: project
				}
			/>,
		);
	await act(async () =>
		resolve(
			boundary === "foreign-response" ? { ...saved, id: newRevision } : saved,
		),
	);
	expect(writes()).toHaveLength(1);
});
it("stops on a save conflict instead of exporting the previous confirmed revision", async () => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		throw new Error("conflict");
	});
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	trim();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await screen.findByRole("alert");
	expect(writes()).toHaveLength(1);
});

const output = (
	state: string,
	generation: number,
	artifact = false,
): EditingRenderView => ({
	id: "99999999-9999-4999-8999-999999999999",
	revisionId: editingIds.revision,
	kind: "EXPORT",
	state,
	generation,
	error: state === "FAILED" ? "RENDER_FAILED" : null,
	artifact: artifact
		? {
				id: newRevision,
				url: "/api/test-output",
				downloadUrl: "/api/test-download",
				derivedContentId: null,
			}
		: null,
});
it("shows the current MP4 export progress without opening the previous-output history", () => {
	const project = { ...fixture(), renders: [output("QUEUED", 2)] };
	server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.getByRole("status", { name: "MP4 export status" }),
	).toHaveTextContent("Queued");
	expect(
		screen.getByRole("link", { name: "View generated MP4" }),
	).toHaveAttribute("href", `/library/edits/${project.id}/result`);
});
it("does not present an older successful MP4 as the newest failed export", () => {
	const project = {
		...fixture(),
		renders: [output("SUCCEEDED", 1, true), output("FAILED", 2)],
	};
	server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.getByRole("status", { name: "MP4 export status" }),
	).toHaveTextContent("Failed");
	expect(
		screen.queryByRole("link", { name: "Download MP4" }),
	).not.toBeInTheDocument();
});
it("keeps speech context in collapsed help and accepts the server's manual origins after editing an automatic draft", async () => {
	const project = fixture();
	// Structural UI fixture; these placeholder hashes do not author a database binding.
	const hash = "a".repeat(64);
	project.draft.analysisRevisionId = newRevision;
	project.draft.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: hash,
		requestedDurationFrames: 450,
		generatedDurationFrames: 300,
		reasonCodes: ["SPEECH_REVIEW_REQUIRED"],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: mocks.organizationId,
			sourceId: project.media.sourceId,
			locale: "en",
			analysisRevisionId: newRevision,
			analysisRawHash: hash,
			analysisDocumentHash: hash,
			mediaVersionId: project.media.id,
			mediaSha256: hash,
			timeMapId: project.media.id,
			timeMapHash: hash,
			sourceStartUs: 0,
			sourceEndUs: 60_000_000,
			width: 1920,
			height: 1080,
		},
	};
	for (const clip of project.draft.clips) {
		clip.evidence = { sceneId: newRevision, shotIndex: 0 };
		for (const part of clip.framing) part.origin = "AUTO_POLICY";
	}
	const stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(
		screen.getByText("About this editing proposal", { selector: "h3" }),
	).not.toBeVisible();
	fireEvent.click(
		screen.getByText("Editing controls", { selector: "summary" }),
	);
	expect(
		screen.getByText(
			"The detected speech could not be kept within safe whole-shot boundaries.",
		),
	).toBeVisible();
	trim();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(3));
	expect(stored().draft.autoGeneration).toEqual(project.draft.autoGeneration);
	expect(
		stored()
			.draft.clips.flatMap((clip) => clip.framing)
			.every((part) => part.origin === "MANUAL"),
	).toBe(true);
	expect(
		screen.getByText("About this editing proposal", { selector: "h3" }),
	).toBeVisible();
});

it("confirms an existing unconfirmed draft at revision +1 before exporting it", async () => {
	const project = {
		...fixture(),
		currentRevisionId: null,
		currentRevisionMatchesDraft: false,
	};
	const stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(2));
	expect(writes().map(([url]) => url)).toEqual([
		`/api/library/edits/${project.id}/revisions`,
		`/api/library/edits/${project.id}/renders`,
	]);
	expect(JSON.parse(write(0)[1].body)).toEqual({
		expectedRevision: 1,
		confirmSuggestions: false,
	});
	expect(stored().draftRevision).toBe(2);
	expect(JSON.parse(write(1)[1].body)).toMatchObject({
		revisionId: newRevision,
		kind: "EXPORT",
	});
});
it("accepts only the confirmed AISA origins while preserving the proposed geometry and timing", async () => {
	const project = {
		...fixture(),
		currentRevisionId: null,
		currentRevisionMatchesDraft: false,
	};
	project.draft.analysisRevisionId = newRevision;
	for (const clip of project.draft.clips) {
		clip.evidence = { sceneId: newRevision, shotIndex: 0 };
		for (const part of clip.framing) part.origin = "AISA_PROPOSAL";
	}
	const expected = structuredClone(project.draft);
	for (const clip of expected.clips)
		for (const part of clip.framing) part.origin = "EDITOR_CONFIRMED";
	const stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	expect(
		screen.queryByLabelText("I have checked the suggested framing"),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes()).toHaveLength(2));
	expect(JSON.parse(write(0)[1].body)).toEqual({
		expectedRevision: 1,
		confirmSuggestions: true,
	});
	expect(stored().draftRevision).toBe(2);
	expect(stored().draft).toEqual(expected);
	expect(JSON.parse(write(1)[1].body)).toMatchObject({
		revisionId: newRevision,
		kind: "EXPORT",
	});
});
