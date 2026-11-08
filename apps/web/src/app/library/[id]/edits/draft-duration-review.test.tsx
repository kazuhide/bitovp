import {
	type CompositionSourceFacts,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { CompositionWorkbench } from "../../edits/[id]/composition-workbench";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import { GenerationProgress } from "../../generations/[id]/generation-progress";
import { GenerationControls } from "./generation-controls";
import { productionWarning, useProductionCopy } from "./production-copy";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: { mode: "none", configured: true, authenticated: true },
	}),
}));
vi.mock("./association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
vi.mock("@/app/library/edits/[id]/composition-preview", () => ({
	CompositionPreview: () => null,
}));
const taskId = "99999999-9999-4999-8999-999999999999",
	analysisId = "77777777-7777-4777-8777-777777777777",
	org = "00000000-0000-4000-8000-000000000001";
const warning = "SPEECH_DURATION_REVIEW_REQUIRED";
const copy = {
	en: "Avoiding the detected speech would shorten the original scene selection substantially. The original proposal is shown to stay closer to the requested length. Review clip beginnings, endings and captions before generating the MP4.",
	ja: "発話の途中を避けると元の案から大きく短くなるため、希望尺に近い元の案を表示しています。MP4を生成する前に、各区間の始まり・終わりと字幕を確認してください。",
};
const legacyCopy = {
	en: "The detected speech could not be kept within safe whole-shot boundaries. Review the clip beginnings, endings and captions before generating the MP4.",
	ja: "観測した発話の途中を避けるショット区間を選べませんでした。MP4を生成する前に、各区間の始まり・終わりと字幕を確認してください。",
};
const reviewSummary = {
	en: "Review clip beginnings, endings and captions before generating the MP4.",
	ja: "生成前に、各区間の始まり・終わりと字幕を確認してください。",
};
const editorHelpTitle = {
	en: "Editing controls",
	ja: "編集の操作",
};
const durationReason = {
	en: "Avoiding the detected speech would shorten the original scene selection substantially. The original proposal is shown to stay closer to the requested length.",
	ja: "発話の途中を避けると元の案から大きく短くなるため、希望尺に近い元の案を表示しています。",
};
const legacyReason = {
	en: "The detected speech could not be kept within safe whole-shot boundaries.",
	ja: "観測した発話の途中を避けるショット区間を選べませんでした。",
};
const posts = () =>
	mocks.api.mock.calls.filter(([, init]) => init?.method === "POST");
function request(index = 0) {
	const value = posts()[index];
	if (!value) throw new Error("Missing request");
	return JSON.parse(String(value[1].body));
}
const control = (renderMode?: "DRAFT" | "EXPORT") => (
	<GenerationControls
		contentId={editingIds.content}
		mediaVersionId={editingIds.media}
		analysisRevisionId={analysisId}
		targetDurationFrames={900}
		disabled={false}
		renderMode={renderMode}
	/>
);
function project(reason: string) {
	const original = editingProjectFixture(),
		draft = toCompositionDocument(original.draft),
		map = original.media.timeMap;
	if (!map) throw new Error("Missing map");
	draft.analysisRevisionId = analysisId;
	// Structural UI metadata only; placeholder hashes do not author a stored binding.
	const hash = "a".repeat(64);
	draft.autoGeneration = {
		...(reason === warning
			? {
					renderMode: "DRAFT" as const,
					draftPolicyVersion: "duration-review-v2" as const,
				}
			: {}),
		policyVersion: "aisa-shot-window-v1",
		requestHash: hash,
		requestedDurationFrames: 900,
		generatedDurationFrames: 300,
		reasonCodes: [reason],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: org,
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
	const facts: CompositionSourceFacts = {
		mediaVersionId: original.media.id,
		timeMap: map,
		width: 1920,
		height: 1080,
		hasAudio: true,
	};
	return { ...original, draft, compositionSources: [facts] };
}
function resultTask() {
	return {
		taskId,
		kind: "GENERATE",
		state: "SUCCEEDED",
		renderMode: "DRAFT",
		mediaVersionId: editingIds.media,
		analysisRevisionId: analysisId,
		parentTaskId: null,
		phase: "COMPLETE",
		progress: null,
		error: null,
		attempts: 1,
		cached: false,
		createdAt: "2026-11-02T00:00:00.000Z",
		finishedAt: "2026-11-02T00:00:01.000Z",
		result: {
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			projectId: editingIds.project,
			projectIds: [editingIds.project],
			requestedFrames: 900,
			actualFrames: 896,
			warnings: [warning],
			policyVersion: "aisa-prepared-scene-cohesion-v3",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: false,
		},
	};
}
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.replace.mockReset();
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? { taskId, state: "PENDING", cached: false }
			: { media: [] },
	);
});

it.each([
	"DRAFT",
	"EXPORT",
	undefined,
] as const)("uses the new duration policy only for the explicit %s draft control", async (mode) => {
	renderWithQuery(control(mode));
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(
		screen.getByRole("button", {
			name: mode === "DRAFT" ? "Create project" : "Start configured generation",
		}),
	);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(1);
	const value = request();
	if (mode === "DRAFT")
		expect(value.parameters).toMatchObject({
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
		});
	else expect(value.parameters).not.toHaveProperty("draftPolicyVersion");
	if (mode === undefined)
		expect(value.parameters).not.toHaveProperty("renderMode");
	expect(screen.queryByText("duration-review-v2")).not.toBeInTheDocument();
});
it("recovers an unknown new-policy DRAFT with the same full body and key", async () => {
	mocks.api
		.mockRejectedValueOnce(new TypeError("receipt lost"))
		.mockResolvedValue({ taskId, state: "PENDING", cached: false });
	renderWithQuery(control("DRAFT"));
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	const first = posts()[0];
	if (!first) throw new Error("Missing first request");
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(2));
	const second = posts()[1];
	if (!second) throw new Error("Missing retry");
	expect(second[1].body).toBe(first[1].body);
	expect(request().parameters.draftPolicyVersion).toBe("duration-review-v2");
});
it.each([
	"en",
	"ja",
] as const)("explains the duration-priority fallback on DRAFT progress in %s", async (locale) => {
	mocks.api.mockResolvedValue(resultTask());
	renderWithQuery(<GenerationProgress id={taskId} />, locale);
	expect(await screen.findByText(copy[locale])).toBeVisible();
	expect(screen.queryByText(warning)).not.toBeInTheDocument();
	await waitFor(() =>
		expect(mocks.replace).toHaveBeenCalledWith(
			`/library/edits/${editingIds.project}`,
		),
	);
	expect(posts()).toHaveLength(0);
});
it.each([
	"en",
	"ja",
] as const)("retains the duration rationale in collapsed editing help after reloading the saved draft in %s", (locale) => {
	renderWithQuery(<CompositionWorkbench project={project(warning)} />, locale);
	expect(screen.queryByText(reviewSummary[locale])).not.toBeInTheDocument();
	const details = screen.getByText(editorHelpTitle[locale]).closest("details");
	expect(details).not.toHaveAttribute("open");
	if (!details) throw Error("Missing review explanation");
	expect(within(details).getByText(durationReason[locale])).not.toBeVisible();
	fireEvent.click(screen.getByText(editorHelpTitle[locale]));
	expect(within(details).getByText(durationReason[locale])).toBeVisible();
	expect(screen.queryByText(legacyReason[locale])).not.toBeInTheDocument();
	expect(screen.queryByText(legacyCopy[locale])).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
});
it.each([
	"en",
	"ja",
] as const)("keeps the no-safe-window rationale in collapsed editing help in %s", (locale) => {
	renderWithQuery(
		<CompositionWorkbench project={project("SPEECH_REVIEW_REQUIRED")} />,
		locale,
	);
	expect(screen.queryByText(reviewSummary[locale])).not.toBeInTheDocument();
	const details = screen.getByText(editorHelpTitle[locale]).closest("details");
	expect(details).not.toHaveAttribute("open");
	if (!details) throw Error("Missing review explanation");
	expect(within(details).getByText(legacyReason[locale])).not.toBeVisible();
	fireEvent.click(screen.getByText(editorHelpTitle[locale]));
	expect(within(details).getByText(legacyReason[locale])).toBeVisible();
	expect(screen.queryByText(durationReason[locale])).not.toBeInTheDocument();
	expect(screen.queryByText(copy[locale])).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
});

it.each([
	"en",
	"ja",
] as const)("explains the speech-search fallback without a safety claim (%s)", (locale) => {
	function SearchLimitNote() {
		return (
			<p>
				{productionWarning(
					"SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
					useProductionCopy(),
				)}
			</p>
		);
	}
	renderWithQuery(<SearchLimitNote />, locale);
	expect(
		screen.getByText(
			locale === "ja"
				? "字幕境界の追加探索が上限に達したため、最初の選定案を使っています。"
				: "The additional speech-boundary search reached its limit, so the initial selection is being used.",
		),
	).toBeVisible();
});
