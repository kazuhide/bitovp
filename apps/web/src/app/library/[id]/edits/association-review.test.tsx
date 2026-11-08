import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { AssociationReview } from "./association-review";

const mocks = vi.hoisted(() => ({ api: vi.fn(), permitted: true }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.permitted,
}));
const mediaId = "22222222-2222-4222-8222-222222222222",
	analysisId = "33333333-3333-4333-8333-333333333333";
const inspection = (association = "UNVERIFIED") => ({
	association,
	media: {
		id: mediaId,
		state: "READY",
		width: 640,
		height: 360,
		url: `/api/library/media-versions/${mediaId}/media`,
		timeMap: {
			id: mediaId,
			mediaVersionId: mediaId,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
	},
	analysis: {
		id: analysisId,
		document: normalizeSceneAnalysis({
			duration: 2,
			metadata: { version: "fixture" },
			scenes: [
				{
					id: "77777777-7777-4777-8777-777777777777",
					startInSeconds: 0,
					endInSeconds: 2,
					title: "Actual scene",
				},
			],
		}),
	},
});
const render = (onVerified = vi.fn()) => ({
	onVerified,
	...renderLocalized(
		<AssociationReview
			mediaVersionId={mediaId}
			analysisRevisionId={analysisId}
			disabled={false}
			onVerified={onVerified}
		/>,
	),
});
beforeEach(() => {
	mocks.api.mockReset();
	mocks.permitted = true;
});
it("requires an actual source load and all three explicit human confirmations", async () => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? { confirmed: true, bindingKind: "EDITOR_ATTESTED" }
			: inspection(),
	);
	const f = render();
	const video = await screen.findByLabelText(
		"Prepared source for association review",
	);
	expect(screen.getByText("Actual scene")).toBeInTheDocument();
	expect(f.onVerified).toHaveBeenLastCalledWith(false);
	const button = screen.getByRole("button", {
		name: "Record this association",
	});
	expect(button).toBeDisabled();
	fireEvent.loadedMetadata(video);
	const boxes = screen.getAllByRole("checkbox");
	expect(boxes).toHaveLength(3);
	for (const box of boxes) expect(box).not.toBeChecked();
	for (const box of boxes.slice(0, 2)) fireEvent.click(box);
	expect(button).toBeDisabled();
	fireEvent.click(boxes[2] as HTMLElement);
	fireEvent.click(button);
	await waitFor(() => expect(f.onVerified).toHaveBeenLastCalledWith(true));
	expect(
		JSON.parse(
			mocks.api.mock.calls.find(([, init]) => init?.method === "POST")?.[1]
				?.body,
		),
	).toEqual({
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: expect.any(String),
		confirmation: { time: true, geometry: true, content: true },
	});
});
it("accepts recorded fixture identity while labeling it separately from captured AISA", async () => {
	mocks.api.mockResolvedValue(inspection("FIXTURE_AUTHORED"));
	const f = render();
	await screen.findByText(
		"Fixture-authored metadata. This is not a real AISA capture.",
	);
	expect(f.onVerified).toHaveBeenLastCalledWith(true);
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it("fails closed for unknown association values and unavailable source playback", async () => {
	mocks.api.mockResolvedValue(inspection("UNKNOWN"));
	const f = render();
	const video = await screen.findByLabelText(
		"Prepared source for association review",
	);
	fireEvent.error(video);
	expect(f.onVerified).toHaveBeenLastCalledWith(false);
	expect(
		screen.getByRole("button", { name: "Record this association" }),
	).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("could not be played");
});
it("shows a safe error and refuses a mismatched response tuple", async () => {
	mocks.api.mockResolvedValue({
		...inspection("CAPTURED_INPUT"),
		analysis: {
			...inspection().analysis,
			id: "55555555-5555-4555-8555-555555555555",
		},
	});
	const f = render();
	await screen.findByRole("alert");
	expect(f.onVerified).toHaveBeenLastCalledWith(false);
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
