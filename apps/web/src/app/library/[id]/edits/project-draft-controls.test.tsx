import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { GenerationProgress } from "../../generations/[id]/generation-progress";
import { GenerationControls } from "./generation-controls";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	permitted: true,
	session: {
		configured: true,
		authenticated: true,
		mode: "none",
		organizationId: "00000000-0000-4000-8000-000000000001",
	},
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.permitted,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({ status: "success", data: mocks.session }),
}));
vi.mock("./association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
const ids = {
	content: "11111111-1111-4111-8111-111111111111",
	media: "22222222-2222-4222-8222-222222222222",
	analysis: "33333333-3333-4333-8333-333333333333",
	task: "44444444-4444-4444-8444-444444444444",
	project: "55555555-5555-4555-8555-555555555555",
};
const form = (hasAudio = true, mediaVersionId = ids.media) => (
	<GenerationControls
		contentId={ids.content}
		mediaVersionId={mediaVersionId}
		analysisRevisionId={ids.analysis}
		targetDurationFrames={450}
		disabled={false}
		renderMode="DRAFT"
		hasAudio={hasAudio}
	/>
);
const receipt = () => ({ taskId: ids.task, state: "PENDING", cached: false });
function requestCall(index: number) {
	const call = mocks.api.mock.calls[index];
	if (!call) throw new Error(`Missing request ${index}`);
	return call;
}
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.replace.mockReset();
	mocks.permitted = true;
	mocks.session.organizationId = "00000000-0000-4000-8000-000000000001";
});
it.each([
	true,
	false,
])("creates an editable draft with tracking and audio-aware captions (audio %s)", async (audio) => {
	mocks.api.mockResolvedValue(receipt());
	renderWithQuery(form(audio));
	const create = screen.getByRole("button", { name: "Create project" });
	expect(create).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	act(() => {
		fireEvent.click(create);
		fireEvent.click(create);
	});
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${ids.task}`),
	);
	expect(mocks.api).toHaveBeenCalledOnce();
	expect(JSON.parse(requestCall(0)[1].body).parameters).not.toHaveProperty(
		"query",
	);
	expect(JSON.parse(requestCall(0)[1].body)).toMatchObject({
		kind: "GENERATE",
		mediaVersionId: ids.media,
		analysisRevisionId: ids.analysis,
		parameters: {
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			presentation: {
				version: "portrait-layout-v1",
				videoFit: "AUTO",
				fallbackFraming: "PRESERVE_SOURCE_V1",
				captionPlacement: "OVERLAY",
			},
			contentId: ids.content,
			targetDurationFrames: 450,
			policy: "AUTO",
			templateId: "portrait-clean",
			variants: 1,
			tracking: true,
			captions: audio ? "AUTO" : "OFF",
		},
	});
	expect(
		screen.queryByRole("button", { name: "Start configured generation" }),
	).not.toBeInTheDocument();
});
it("preserves the complete DRAFT request after an unknown response", async () => {
	mocks.api.mockRejectedValue(new TypeError("receipt lost"));
	renderWithQuery(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	expect(requestCall(1)[1].body).toBe(requestCall(0)[1].body);
});
it.each([
	"role",
	"organization",
	"media",
])("does not navigate from a late creation receipt after the %s changes", async (boundary) => {
	let resolve!: (value: unknown) => void;
	mocks.api.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const view = renderWithQuery(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	if (boundary === "role") mocks.permitted = false;
	if (boundary === "organization")
		mocks.session.organizationId = "00000000-0000-4000-8000-000000000002";
	view.rerender(form(true, boundary === "media" ? ids.content : ids.media));
	await act(async () => resolve(receipt()));
	expect(mocks.push).not.toHaveBeenCalled();
	expect(mocks.api).toHaveBeenCalledOnce();
});
it("opens the same DRAFT project directly in the editor without waiting for MP4 rendering", async () => {
	mocks.api.mockResolvedValue({
		taskId: ids.task,
		kind: "GENERATE",
		state: "SUCCEEDED",
		mediaVersionId: ids.media,
		analysisRevisionId: ids.analysis,
		parentTaskId: null,
		phase: "COMPLETE",
		progress: null,
		error: null,
		attempts: 1,
		cached: false,
		createdAt: "2026-11-02T00:00:00.000Z",
		finishedAt: "2026-11-02T00:00:01.000Z",
		result: {
			projectId: ids.project,
			projectIds: [ids.project],
			renderMode: "DRAFT",
			requestedFrames: 450,
			actualFrames: 420,
			warnings: [],
			policyVersion: "aisa-prepared-scene-cohesion-v3",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: false,
		},
	});
	renderWithQuery(<GenerationProgress id={ids.task} />);
	await waitFor(() =>
		expect(mocks.replace).toHaveBeenCalledWith(`/library/edits/${ids.project}`),
	);
	expect(mocks.replace).toHaveBeenCalledOnce();
	expect(mocks.push).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("link", { name: /Open result/ }),
	).not.toBeInTheDocument();
	expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it("provides one native project form for keyboard submission", async () => {
	mocks.api.mockResolvedValue(receipt());
	renderWithQuery(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.submit(screen.getByRole("form", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	expect(JSON.parse(requestCall(0)[1].body).parameters.renderMode).toBe(
		"DRAFT",
	);
});
