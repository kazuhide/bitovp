import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import { GenerationControls } from "./generation-controls";

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
};
const form = () => (
	<GenerationControls
		contentId={ids.content}
		mediaVersionId={ids.media}
		analysisRevisionId={ids.analysis}
		targetDurationFrames={900}
		disabled={false}
	/>
);
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.permitted = true;
});
it("requires a verified association and posts the strict advanced generation intent", async () => {
	mocks.api.mockResolvedValue({
		taskId: ids.task,
		state: "PENDING",
		cached: false,
	});
	renderLocalized(form());
	const start = screen.getByRole("button", {
		name: "Start configured generation",
	});
	expect(start).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.change(screen.getByLabelText("Context to include"), {
		target: { value: " Interview " },
	});
	fireEvent.change(screen.getByRole("combobox", { name: "Captions" }), {
		target: { value: "ORIGINAL" },
	});
	fireEvent.click(screen.getByLabelText("Follow the visible subject"));
	fireEvent.change(screen.getByLabelText("Formats to generate"), {
		target: { value: "3" },
	});
	fireEvent.click(start);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${ids.task}`),
	);
	expect(JSON.parse(mocks.api.mock.calls[0]?.[1].body)).toEqual({
		kind: "GENERATE",
		mediaVersionId: ids.media,
		analysisRevisionId: ids.analysis,
		requestKey: expect.any(String),
		parameters: {
			contentId: ids.content,
			targetDurationFrames: 900,
			policy: "COHESION",
			query: "Interview",
			templateId: "portrait-clean",
			variants: 3,
			captions: "ORIGINAL",
			tracking: true,
			language: "auto",
		},
	});
});
it("blocks synchronous duplicate starts and preserves the same unknown request key", async () => {
	mocks.api.mockRejectedValue(new TypeError("private diagnostic"));
	renderLocalized(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	const button = screen.getByRole("button", {
		name: "Start configured generation",
	});
	act(() => {
		fireEvent.click(button);
		fireEvent.click(button);
	});
	await screen.findByRole("alert");
	expect(mocks.api).toHaveBeenCalledOnce();
	fireEvent.click(button);
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	expect(JSON.parse(mocks.api.mock.calls[1]?.[1].body).requestKey).toBe(
		JSON.parse(mocks.api.mock.calls[0]?.[1].body).requestKey,
	);
	expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
});
it("disables semantic context under duration policy and hides writing for viewers", () => {
	const view = renderLocalized(form());
	fireEvent.change(screen.getByLabelText("Selection policy"), {
		target: { value: "DURATION" },
	});
	expect(screen.getByLabelText("Context to include")).toBeDisabled();
	mocks.permitted = false;
	view.rerender(form());
	expect(
		screen.queryByRole("button", { name: "Start configured generation" }),
	).not.toBeInTheDocument();
	expect(mocks.api).not.toHaveBeenCalled();
});
it("uses a new key after a definitive validation failure", async () => {
	mocks.api.mockRejectedValue(new ApiError(422, "ANALYSIS_BINDING_UNVERIFIED"));
	renderLocalized(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	const button = screen.getByRole("button", {
		name: "Start configured generation",
	});
	fireEvent.click(button);
	await screen.findByRole("alert");
	fireEvent.click(button);
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	expect(JSON.parse(mocks.api.mock.calls[1]?.[1].body).requestKey).not.toBe(
		JSON.parse(mocks.api.mock.calls[0]?.[1].body).requestKey,
	);
});

it.each([
	[
		503,
		"LOCAL_STORY_ENGINE_UNAVAILABLE",
		/Automatic editing is temporarily unavailable/,
	],
	[503, "CLIP_EDITING_UNAVAILABLE", /editing service.*unavailable/i],
	[422, "HLS_UNSUPPORTED", /HLS.*MP4/],
	[401, "private auth text", /sign in/i],
	[403, "private permission text", /permission/i],
] as const)("shows a safe actionable creation failure%s %s", async (status, code, expected) => {
	mocks.api.mockRejectedValue(new ApiError(status, code));
	renderLocalized(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(
		screen.getByRole("button", { name: "Start configured generation" }),
	);
	const alert = await screen.findByRole("alert");
	expect(alert).toHaveTextContent(expected);
	expect(alert).not.toHaveTextContent("private");
	if (status === 503) {
		fireEvent.click(
			screen.getByRole("button", { name: "Start configured generation" }),
		);
		await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
		expect(mocks.api.mock.calls[1]?.[1].body).toBe(
			mocks.api.mock.calls[0]?.[1].body,
		);
	}
});
