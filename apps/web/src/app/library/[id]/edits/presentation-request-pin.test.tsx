import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderWithQuery } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import type { EditingEligibility } from "./editing-forms";
import { GenerationControls } from "./generation-controls";
import type { GenerationSettingsValue } from "./generation-settings";
import { PrepareGenerationControls } from "./prepare-generation-controls";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	settings: null as GenerationSettingsValue | null,
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
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
vi.mock("./association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
vi.mock("./generation-settings", async (original) => ({
	...(await original<object>()),
	GenerationSettings: ({ value }: { value: GenerationSettingsValue }) => {
		mocks.settings = value;
		return null;
	},
}));
const analysisId = "77777777-7777-4777-8777-777777777777",
	preparedId = "88888888-8888-4888-8888-888888888888",
	taskId = "99999999-9999-4999-8999-999999999999";
const defaults = {
	version: "portrait-layout-v1",
	videoFit: "AUTO",
	fallbackFraming: "PRESERVE_SOURCE_V1",
	captionPlacement: "OVERLAY",
};
function mutateNestedReference() {
	const presentation = mocks.settings?.presentation;
	if (!presentation) throw new Error("Missing captured presentation");
	presentation.videoFit = "FIT";
	presentation.captionPlacement = "BANDS";
}
const generates = () =>
	mocks.api.mock.calls.filter(([url]) => url === "/api/library/media-tasks");
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.settings = null;
});
it("replays the exact body and key after an unknown draft outcome despite a changed nested settings reference", async () => {
	mocks.api.mockRejectedValue(new TypeError("receipt lost"));
	renderWithQuery(
		<GenerationControls
			contentId={editingIds.content}
			mediaVersionId={editingIds.media}
			analysisRevisionId={analysisId}
			targetDurationFrames={450}
			disabled={false}
			renderMode="DRAFT"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	const first = String(generates()[0]?.[1].body);
	expect(JSON.parse(first).parameters.presentation).toEqual(defaults);
	mutateNestedReference();
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(generates()).toHaveLength(2));
	expect(generates()[1]?.[1].body).toBe(first);
});
it("snapshots nested presentation before waiting for media preparation", async () => {
	const base = editingProjectFixture().media;
	if (!base.timeMap) throw new Error("Missing fixture map");
	const media = {
		...base,
		id: preparedId,
		state: "READY",
		timeMap: {
			...base.timeMap,
			id: preparedId,
			mediaVersionId: preparedId,
		},
		url: `/api/library/media-versions/${preparedId}/media`,
	};
	const eligibility: EditingEligibility = {
		sourceId: editingIds.source,
		files: [{ key: "mp4:original", label: "Original source" }],
		mediaVersions: [],
		analyses: [{ id: analysisId, locale: "en", title: "Recorded analysis" }],
	};
	let resolvePreparation: ((value: unknown) => void) | undefined;
	const preparation = new Promise<unknown>((resolve) => {
		resolvePreparation = resolve;
	});
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (init?.method === "POST" && url.endsWith("/media-versions"))
			return preparation;
		if (url.includes("analysis-associations"))
			return {
				association: "FIXTURE_AUTHORED",
				media,
				analysis: { id: analysisId },
			};
		if (url.includes("editing-eligibility"))
			return { ...eligibility, mediaVersions: [media] };
		if (url === "/api/library/media-tasks")
			return { taskId, state: "PENDING", cached: false };
		return media;
	});
	renderWithQuery(
		<DocumentOrganizationContext.Provider value="00000000-0000-4000-8000-000000000001">
			<PrepareGenerationControls
				contentId={editingIds.content}
				eligibility={eligibility}
				analysisRevisionId={analysisId}
				targetDurationFrames={450}
				disabled={false}
				renderMode="DRAFT"
				onBusyChange={() => {}}
				onReturn={() => {}}
				preparationTarget={{
					fileKey: "mp4:original",
					output: {
						credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
						bucket: "editing",
						prefix: "automatic-edit/",
					},
				}}
			/>
		</DocumentOrganizationContext.Provider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	mutateNestedReference();
	await act(async () => {
		resolvePreparation?.(media);
	});
	await waitFor(() => expect(generates()).toHaveLength(1));
	expect(
		JSON.parse(String(generates()[0]?.[1].body)).parameters.presentation,
	).toEqual(defaults);
	expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`);
});
