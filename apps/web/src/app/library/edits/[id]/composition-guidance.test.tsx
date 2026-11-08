import {
	type CompositionDocument,
	compositionDocumentSchema,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { storyEvidenceFixture } from "@/test/story-evidence";
import { editingIds, editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";

const mocks = vi.hoisted(() => ({ api: vi.fn(), permitted: true }));
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
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));
vi.mock("./composition-preview", () => ({
	CompositionPreview: ({
		plan,
	}: {
		plan: { document: CompositionDocument; durationFrames: number };
	}) => (
		<output aria-label="Guidance preview frames">{plan.durationFrames}</output>
	),
}));

function fixture(proposal = true) {
	const original = editingProjectFixture(),
		draft = toCompositionDocument(original.draft),
		map = original.media.timeMap;
	if (!map) throw new Error("Missing fixture map");
	if (proposal) {
		const analysisId = "77777777-7777-4777-8777-777777777777",
			hash = "a".repeat(64);
		draft.analysisRevisionId = analysisId;
		// Structural UI fixture; this does not claim a stored/provider association.
		draft.autoGeneration = {
			policyVersion: "aisa-shot-window-v1",
			requestHash: hash,
			requestedDurationFrames: 300,
			generatedDurationFrames: 300,
			reasonCodes: ["SPEECH_REVIEW_REQUIRED"],
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
			centerCropConfirmed: false,
		};
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
function semanticFixture(reasonCodes = ["SPEECH_REVIEW_REQUIRED"]) {
	const project = fixture(),
		origin = project.draft.autoGeneration;
	if (!origin) throw new Error("Missing authored provenance");
	project.draft.autoGeneration = {
		...origin,
		reasonCodes,
		policyVersion: "aisa-content-highlight-v1",
		renderMode: "DRAFT",
		draftPolicyVersion: "duration-review-v2",
		semanticEvidence: {
			version: "aisa-content-evidence-v1",
			method: "METADATA_HEURISTIC",
			profile: "PRODUCT",
			keyEntities: [
				{
					kind: "OBJECT",
					label: "Finished camera",
					sceneIds: ["11111111-1111-4111-8111-111111111111"],
				},
			],
			selectedMoments: [
				{
					sceneId: "11111111-1111-4111-8111-111111111111",
					shotIndex: 0,
					label: "The completed camera is revealed",
					score: 800,
					reasonCodes: ["STATE_CHANGE"],
				},
			],
			selectionReason: "CONTENT_RANKED",
		},
	};
	project.draft = compositionDocumentSchema.parse(project.draft);
	return project;
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
function trim() {
	const input = screen.getByLabelText("Length (s)");
	fireEvent.change(input, { target: { value: "5" } });
	fireEvent.blur(input);
}
function openControls() {
	const summary = screen.getByText("Editing controls", { selector: "summary" }),
		details = summary.closest("details");
	if (!details) throw new Error("Missing editing disclosure");
	fireEvent.click(summary);
	expect(details).toHaveAttribute("open");
	return details;
}
beforeEach(() => {
	mocks.permitted = true;
	mocks.api.mockReset();
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method) throw new Error("Unexpected editing write");
		return { media: [] };
	});
});
it("keeps a saved automatic proposal usable without proactive warning cards or a confirmation checkbox", () => {
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
			hidden: true,
		}),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", {
			name: /Review framing candidates|Review the central crop|Review this editing proposal/,
		}),
	).not.toBeInTheDocument();
	expect(
		screen
			.queryAllByRole("note")
			.filter((element) => /amber/.test(element.className)),
	).toHaveLength(0);
	expect(screen.getByText("Draft saved")).toHaveClass("text-zinc-500");
	expect(
		screen.queryByText("Why these moments were selected"),
	).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	expect(writes()).toHaveLength(0);
});
it("shows supplemental framing and speech reasons only inside the existing closed editing controls", () => {
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	const heading = screen.getByRole("heading", {
		name: "About this editing proposal",
		hidden: true,
	});
	expect(heading.tagName).toBe("H3");
	expect(heading).not.toBeVisible();
	const details = openControls();
	expect(details).toContainElement(heading);
	expect(heading).toBeVisible();
	expect(
		within(details).getByText(
			/Tracking was unavailable|Untracked ranges|central crop/i,
		),
	).toBeVisible();
	expect(
		within(details).getByText(/detected speech|spoken.*(selection|scene)/i),
	).toBeVisible();
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	fireEvent.click(
		within(details).getByText("Editing controls", { selector: "summary" }),
	);
	expect(heading).not.toBeVisible();
	expect(writes()).toHaveLength(0);
});
it("keeps an ordinary unsaved edit as a muted live status with Save draft available and no automatic write", () => {
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	trim();
	expect(screen.getByLabelText("Guidance preview frames")).toHaveTextContent(
		"150",
	);
	const status = screen.getByText("Unsaved changes");
	expect(status).toHaveAttribute("role", "status");
	expect(status).toHaveClass("text-zinc-500");
	expect(status.className).not.toMatch(/amber/);
	expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
	openControls();
	expect(writes()).toHaveLength(0);
});
it("preserves a real API failure as an alert while leaving the local edit available to save again", async () => {
	renderWithQuery(<CompositionWorkbench project={fixture(false)} />);
	trim();
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method) throw new Error("Draft write unavailable");
		return { media: [] };
	});
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	const alert = await screen.findByRole("alert");
	expect(alert).toBeVisible();
	expect(alert).toHaveTextContent("The operation failed. Try again.");
	expect(alert).toHaveClass("border-amber-900");
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled(),
	);
	expect(writes()).toHaveLength(1);
	expect(writes()[0]?.[1].method).toBe("PUT");
});
it("keeps mutation controls unavailable to a viewer even when supplemental information is opened", () => {
	mocks.permitted = false;
	renderWithQuery(<CompositionWorkbench project={fixture()} />);
	openControls();
	expect(screen.getByText("View only", { selector: "p" })).toBeVisible();
	expect(
		screen.queryByRole("button", { name: "Generate MP4" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Save draft" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("checkbox", {
			name: "I have checked the suggested framing",
			hidden: true,
		}),
	).not.toBeInTheDocument();
	expect(writes()).toHaveLength(0);
});

it("keeps automatic selection evidence folded as provenance after manual timeline edits", () => {
	const project = semanticFixture();
	renderWithQuery(<CompositionWorkbench project={project} />);
	const summary = screen.getByText("Why these moments were selected", {
			selector: "summary",
		}),
		details = summary.closest("details");
	expect(details).not.toHaveAttribute("open");
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	trim();
	fireEvent.click(summary);
	expect(screen.getByText("Finished camera")).toBeVisible();
	expect(details).toHaveTextContent("when this project was created");
	expect(details).toHaveTextContent("The completed camera is revealed");
	expect(details).not.toHaveTextContent("800");
	expect(writes()).toHaveLength(0);
});

it("retains the folded story creation record after manual edits without saving or generating automatically", () => {
	const project = fixture(),
		origin = project.draft.autoGeneration;
	if (!origin) throw new Error("Missing authored provenance");
	project.draft.autoGeneration = {
		...origin,
		policyVersion: "aisa-story-window-v1",
		renderMode: "DRAFT",
		storyEvidence: storyEvidenceFixture(),
	};
	renderWithQuery(<CompositionWorkbench project={project} />);
	const summary = screen.getByText("Why this story passage was selected", {
		selector: "summary",
	});
	expect(summary.closest("details")).not.toHaveAttribute("open");
	trim();
	fireEvent.click(summary);
	expect(screen.getByText("Rabbit")).toBeVisible();
	expect(screen.getByText("Bow and arrow")).toBeVisible();
	expect(summary.closest("details")).toHaveTextContent(
		"when this project was created",
	);
	expect(summary.closest("details")).toHaveTextContent(
		"The arrow lands in the tree",
	);
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	expect(writes()).toHaveLength(0);
});

it("keeps speech search exhaustion as folded information with generation available", () => {
	renderWithQuery(
		<CompositionWorkbench
			project={semanticFixture(["SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED"])}
		/>,
	);
	const note = screen.getByText(
		"The additional speech-boundary search reached its limit, so the initial selection is being used.",
	);
	expect(note).not.toBeVisible();
	const details = openControls();
	expect(details).toContainElement(note);
	expect(note).toBeVisible();
	expect(screen.getByRole("button", { name: "Generate MP4" })).toBeEnabled();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	expect(details).not.toHaveTextContent(
		"The detected speech could not be kept within safe whole-shot boundaries.",
	);
	expect(writes()).toHaveLength(0);
});
