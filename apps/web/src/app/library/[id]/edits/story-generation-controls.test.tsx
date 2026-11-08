import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { GenerationControls } from "./generation-controls";
import { GenerationSettings } from "./generation-settings";

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
		targetDurationFrames={450}
		disabled={false}
		renderMode="DRAFT"
	/>
);
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.permitted = true;
});
it("withdraws the STORY option while retaining AUTO and read-only settings", () => {
	renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	const policy = screen.getByRole("combobox", { name: "Selection policy" });
	expect(policy).toHaveValue("AUTO");
	expect(
		[...policy.querySelectorAll("option")].map((option) => option.value),
	).toEqual(["AUTO", "COHESION", "DURATION"]);
	expect(
		screen.queryByText("Story flow (experimental)"),
	).not.toBeInTheDocument();
	expect(
		screen.queryByText("About experimental story selection"),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("textbox", { name: "Context to include" }),
	).not.toBeInTheDocument();
	expect(mocks.api).not.toHaveBeenCalled();
});
it("creates the existing AUTO draft with no context query", async () => {
	mocks.api.mockResolvedValue({
		taskId: ids.task,
		state: "PENDING",
		cached: false,
	});
	renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	const policy = screen.getByRole("combobox", { name: "Selection policy" });
	fireEvent.change(policy, { target: { value: "COHESION" } });
	fireEvent.change(
		screen.getByRole("textbox", { name: "Context to include" }),
		{ target: { value: "rabbit" } },
	);
	fireEvent.change(policy, { target: { value: "AUTO" } });
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	const parameters = JSON.parse(mocks.api.mock.calls[0]?.[1].body).parameters;
	expect(parameters).toMatchObject({
		policy: "AUTO",
		renderMode: "DRAFT",
		targetDurationFrames: 450,
	});
	expect(parameters).not.toHaveProperty("query");
});
it("retains the same AUTO request for an unknown-response retry", async () => {
	mocks.api.mockRejectedValue(new TypeError("receipt lost"));
	const view = renderWithQuery(form());
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	view.rerender(form());
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	expect(mocks.api.mock.calls[1]?.[1].body).toBe(
		mocks.api.mock.calls[0]?.[1].body,
	);
	expect(JSON.parse(mocks.api.mock.calls[0]?.[1].body).parameters.policy).toBe(
		"AUTO",
	);
});
it("does not turn a crafted unsupported selection event into STORY", () => {
	const onChange = vi.fn();
	renderWithQuery(
		<GenerationSettings
			value={{
				policy: "AUTO",
				templateId: "portrait-clean",
				variants: 1,
				captions: "OFF",
				tracking: false,
				language: "auto",
			}}
			disabled={false}
			allowPresentation
			onChange={onChange}
		/>,
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Selection policy" }), {
		target: { value: "STORY" },
	});
	expect(onChange).toHaveBeenCalledOnce();
	expect(onChange.mock.calls[0]?.[0].policy).toBe("COHESION");
});
it("keeps the legacy direct-export policy choices unchanged", () => {
	renderWithQuery(
		<GenerationSettings
			value={{
				policy: "COHESION",
				templateId: "portrait-clean",
				variants: 1,
				captions: "OFF",
				tracking: false,
				language: "auto",
			}}
			disabled={false}
			onChange={vi.fn()}
		/>,
	);
	const policy = screen.getByRole("combobox", { name: "Selection policy" });
	expect(
		[...policy.querySelectorAll("option")].map((option) => option.value),
	).toEqual(["COHESION", "DURATION"]);
	expect(
		screen.queryByRole("option", { name: "Story flow (experimental)" }),
	).not.toBeInTheDocument();
});
