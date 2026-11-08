import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { GenerationControls } from "./generation-controls";
import { GenerationSettings } from "./generation-settings";

const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
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
const ids = {
	content: "11111111-1111-4111-8111-111111111111",
	media: "22222222-2222-4222-8222-222222222222",
	analysis: "33333333-3333-4333-8333-333333333333",
	task: "44444444-4444-4444-8444-444444444444",
};
const form = (available = true) => (
	<GenerationControls
		contentId={ids.content}
		mediaVersionId={ids.media}
		analysisRevisionId={ids.analysis}
		targetDurationFrames={900}
		disabled={false}
		renderMode="DRAFT"
		hasAudio
		localStoryAvailable={available}
	/>
);
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.api.mockResolvedValue({
		taskId: ids.task,
		state: "PENDING",
		cached: false,
	});
});
it("defaults a configured project to a local story draft with an automatic approach", async () => {
	const { container } = renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	expect(
		screen.getByRole("combobox", { name: "Selection policy" }),
	).toHaveValue("LOCAL_STORY");
	expect(
		screen.getByRole("combobox", { name: "Editing approach" }),
	).toHaveValue("AUTO");
	expect(
		screen.queryByRole("textbox", { name: "Context to include" }),
	).not.toBeInTheDocument();
	expect(container.textContent).not.toMatch(/qwen|ollama|nvidia|rocm|gateway/i);
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	expect(mocks.api.mock.calls[0]?.[0]).toBe("/api/library/media-tasks");
	expect(
		JSON.parse(mocks.api.mock.calls[0]?.[1].body).parameters,
	).toMatchObject({
		policy: "LOCAL_STORY",
		storyMode: "AUTO",
		renderMode: "DRAFT",
		targetDurationFrames: 900,
	});
	expect(
		mocks.api.mock.calls.some(([url]) => String(url).includes("/renders")),
	).toBe(false);
});
it.each([
	"FLOW",
	"THEME",
])("sends the %s approach without a leftover context query", async (mode) => {
	renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	const policy = screen.getByRole("combobox", { name: "Selection policy" });
	fireEvent.change(policy, { target: { value: "COHESION" } });
	fireEvent.change(
		screen.getByRole("textbox", { name: "Context to include" }),
		{ target: { value: "old filter" } },
	);
	fireEvent.change(policy, { target: { value: "LOCAL_STORY" } });
	fireEvent.change(screen.getByRole("combobox", { name: "Editing approach" }), {
		target: { value: mode },
	});
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	const p = JSON.parse(mocks.api.mock.calls[0]?.[1].body).parameters;
	expect(p).toMatchObject({
		policy: "LOCAL_STORY",
		storyMode: mode,
		renderMode: "DRAFT",
	});
	expect(p).not.toHaveProperty("query");
});
it("clears the story approach when explicitly returning to metadata selection", async () => {
	renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	fireEvent.change(screen.getByRole("combobox", { name: "Editing approach" }), {
		target: { value: "THEME" },
	});
	fireEvent.change(screen.getByRole("combobox", { name: "Selection policy" }), {
		target: { value: "AUTO" },
	});
	expect(
		screen.queryByRole("combobox", { name: "Editing approach" }),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
	const p = JSON.parse(mocks.api.mock.calls[0]?.[1].body).parameters;
	expect(p.policy).toBe("AUTO");
	expect(p).not.toHaveProperty("storyMode");
});
it("keeps speech language editable for story analysis with captions turned off", () => {
	renderWithQuery(form());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	fireEvent.change(screen.getByRole("combobox", { name: "Captions" }), {
		target: { value: "OFF" },
	});
	expect(
		screen.getByRole("combobox", { name: "Speech language" }),
	).toBeEnabled();
});
it("does not offer local analysis in an unconfigured preview or legacy direct export", () => {
	const view = renderWithQuery(form(false));
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	expect(
		screen.getByRole("combobox", { name: "Selection policy" }),
	).toHaveValue("AUTO");
	expect(
		screen.queryByRole("option", { name: "Story-led edit" }),
	).not.toBeInTheDocument();
	view.unmount();
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
			allowLocalStory
			onChange={vi.fn()}
		/>,
	);
	expect(
		screen.queryByRole("option", { name: "Story-led edit" }),
	).not.toBeInTheDocument();
});
