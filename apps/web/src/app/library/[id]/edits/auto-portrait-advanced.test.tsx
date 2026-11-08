import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import { AutoPortraitForm } from "./auto-portrait-form";

const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
const analysisId = "33333333-3333-4333-8333-333333333333",
	taskId = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
});
it("mounts advanced settings only after an explicit action and starts the durable task path", async () => {
	const media = {
		...editingProjectFixture().media,
		url: `/api/library/media-versions/${editingIds.media}/media`,
	};
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? { taskId, state: "PENDING", cached: false }
			: {
					association: "FIXTURE_AUTHORED",
					media,
					analysis: {
						id: analysisId,
						document: normalizeSceneAnalysis({
							metadata: { version: "fixture" },
							duration: 2,
							scenes: [
								{
									id: "77777777-7777-4777-8777-777777777777",
									startInSeconds: 0,
									endInSeconds: 2,
								},
							],
						}),
					},
				},
	);
	renderLocalized(
		<AutoPortraitForm
			contentId={editingIds.content}
			initialTitle="Interview"
			eligibility={{
				sourceId: editingIds.source,
				files: [],
				mediaVersions: [media],
				analyses: [{ id: analysisId, locale: "ja", title: "Fixture" }],
			}}
			disabled={false}
		/>,
	);
	expect(mocks.api).not.toHaveBeenCalled();
	expect(screen.getAllByRole("combobox")).toHaveLength(2);
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	fireEvent.click(
		screen.getByRole("button", { name: "Advanced generation settings" }),
	);
	const start = await screen.findByRole("button", {
		name: "Start configured generation",
	});
	await waitFor(() => expect(start).toBeEnabled());
	fireEvent.click(start);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(
		mocks.api.mock.calls.find(([, init]) => init?.method === "POST")?.[0],
	).toBe("/api/library/media-tasks");
});
