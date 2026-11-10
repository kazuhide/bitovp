import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { GenerationProgress } from "./generation-progress";

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
const id = "44444444-4444-4444-8444-444444444444",
	projectId = "55555555-5555-4555-8555-555555555555",
	childId = "66666666-6666-4666-8666-666666666666";
const task = (state = "RUNNING", result: unknown = null) => ({
	taskId: id,
	kind: "GENERATE",
	state,
	phase:
		state === "RUNNING"
			? "TRACKING"
			: state === "SUCCEEDED"
				? "COMPLETE"
				: "FAILED",
	mediaVersionId: "22222222-2222-4222-8222-222222222222",
	analysisRevisionId: "33333333-3333-4333-8333-333333333333",
	parentTaskId: null,
	progress: null,
	result,
	error: null,
	attempts: 1,
	cached: false,
	createdAt: "2026-11-02T00:00:00.000Z",
	finishedAt: null,
});
const result = () => ({
	projectId,
	projectIds: [projectId],
	requestedFrames: 900,
	actualFrames: 870,
	warnings: ["FIXTURE_METADATA", "TRACKING_FIT_FALLBACK"],
	policyVersion: "aisa-scene-cohesion-v2",
	presetIds: ["portrait-clean"],
	metrics: {},
	cacheable: true,
});
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.permitted = true;
});
it.each([
	["ANALYZING_STORY", "Reading the available AISA story descriptions"],
	["SELECTING_STORY", "Selecting a connected passage"],
])("shows the %s story phase without starting another task", async (phase, label) => {
	mocks.api.mockResolvedValue({ ...task(), renderMode: "DRAFT", phase });
	renderWithQuery(<GenerationProgress id={id} />);
	expect(await screen.findByText(label)).toBeInTheDocument();
	expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it.each([
	["STORY_ENGINE_UNAVAILABLE", "Story selection is unavailable."],
	["STORY_GRAPH_INVALID", "The story analysis could not be verified."],
	["STORY_MODEL_CHANGED", "The story analysis model has changed."],
])("shows a safe explanation for %s without changing policy automatically", async (error, message) => {
	mocks.api.mockResolvedValue({ ...task("ERROR"), renderMode: "DRAFT", error });
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText((text) => text.startsWith(message));
	expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it("shows processing phases and cancels against the current task", async () => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST" ? task("CANCELED") : task(),
	);
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Following the subject");
	fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
	await screen.findByText("Generation canceled");
	expect(mocks.api).toHaveBeenCalledWith(
		`/api/library/media-tasks/${id}/cancel`,
		expect.objectContaining({ method: "POST" }),
	);
});

it("retains running-task cancellation when GPU availability is lost", async () => {
	mocks.api.mockResolvedValue(task());
	renderWithQuery(<GenerationProgress id={id} clipEditingAvailable={false} />);
	expect(
		await screen.findByRole("button", { name: "Cancel generation" }),
	).toBeEnabled();
});

it("does not offer retries while GPU availability is missing", async () => {
	mocks.api.mockResolvedValue(task("ERROR"));
	renderWithQuery(<GenerationProgress id={id} clipEditingAvailable={false} />);
	await screen.findByText("Generation failed");
	expect(
		screen.queryByRole("button", { name: "Retry as a new task" }),
	).not.toBeInTheDocument();
});
it("links every generated result without claiming that the MP4 render finished", async () => {
	mocks.api.mockResolvedValue(task("SUCCEEDED", result()));
	renderWithQuery(<GenerationProgress id={id} />);
	expect(
		await screen.findByRole("link", { name: /Open result/ }),
	).toHaveAttribute("href", `/library/edits/${projectId}/result`);
	expect(screen.getByText(/when rendering finishes/)).toBeInTheDocument();
	expect(screen.getByText("29.00s / 30.00s")).toBeInTheDocument();
	expect(screen.getByText(/Fixture-authored metadata/)).toBeInTheDocument();
});
it("uses one fresh child request key across unknown retry responses", async () => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") throw new TypeError("private detail");
		return task("ERROR");
	});
	renderWithQuery(<GenerationProgress id={id} />);
	const button = await screen.findByRole("button", {
		name: "Retry as a new task",
	});
	act(() => {
		fireEvent.click(button);
		fireEvent.click(button);
	});
	await screen.findByRole("alert");
	fireEvent.click(button);
	await waitFor(() =>
		expect(
			mocks.api.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(2),
	);
	const bodies = mocks.api.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.map(([, init]) => JSON.parse(init.body));
	expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
	expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
	mocks.api.mockResolvedValue({
		taskId: childId,
		state: "PENDING",
		cached: false,
	});
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${childId}`),
	);
});
it.each([
	[503, "CLIP_EDITING_UNAVAILABLE", /editing service.*unavailable/i],
	[503, "LOCAL_STORY_ENGINE_UNAVAILABLE", /Automatic editing.*unavailable/i],
	[401, "private session location", /sign in/i],
	[403, "private permission detail", /permission/i],
] as const)("shows a safe recovery explanation when retry returns %s %s", async (status, code, expected) => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") throw new ApiError(status, code);
		return task("ERROR");
	});
	renderWithQuery(<GenerationProgress id={id} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Retry as a new task" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(expected);
	expect(screen.getByRole("alert")).not.toHaveTextContent("private");
});

it.each([
	401, 403,
])("explains %s when cancellation needs authentication or permission", async (status) => {
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST")
			throw new ApiError(status, "private cancellation detail");
		return task();
	});
	renderWithQuery(<GenerationProgress id={id} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Cancel generation" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		status === 401 ? /sign in/i : /permission/i,
	);
	expect(screen.getByRole("alert")).not.toHaveTextContent("private");
});

it.each([
	401, 403,
])("explains %s when the progress data cannot be read", async (status) => {
	mocks.api.mockRejectedValue(new ApiError(status, "private storage location"));
	renderWithQuery(<GenerationProgress id={id} />);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		status === 401 ? /sign in/i : /permission/i,
	);
	expect(screen.getByRole("alert")).not.toHaveTextContent("private");
});
it("allows viewers to read results while withholding cancel and retry", async () => {
	mocks.permitted = false;
	mocks.api.mockResolvedValue(task("ERROR"));
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Generation failed");
	expect(
		screen.queryByRole("button", { name: "Retry as a new task" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Cancel generation" }),
	).not.toBeInTheDocument();
});
it("rejects a foreign task response or malformed completed result", async () => {
	mocks.api.mockResolvedValue({ ...task(), taskId: childId });
	const view = renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByRole("alert");
	view.unmount();
	mocks.api.mockResolvedValue(task("SUCCEEDED", { projectIds: [] }));
	renderWithQuery(<GenerationProgress id={id} />);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"could not be verified",
	);
	expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("keeps an observed successful result when a pending cancel response fails late", async () => {
	let reject!: (failure: unknown) => void;
	mocks.api.mockImplementation(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Promise((_done, fail) => {
					reject = fail;
				})
			: task(),
	);
	const view = renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Following the subject");
	fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
	act(() => {
		view.client.setQueryData(
			["library-media-task", id],
			task("SUCCEEDED", result()),
		);
	});
	await screen.findByRole("link", { name: /Open result/ });
	await act(async () => reject(new TypeError("late failure")));
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(screen.getByRole("link", { name: /Open result/ })).toBeInTheDocument();
});
it("explains an outdated tracker and offers an immutable child retry", async () => {
	mocks.api.mockResolvedValue({
		...task("ERROR"),
		error: "TRACKING_ALGORITHM_CHANGED",
	});
	renderWithQuery(<GenerationProgress id={id} />);
	expect(
		await screen.findByText(
			"Tracking was updated. Retry as a new task to use the current tracker.",
		),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Retry as a new task" }),
	).toBeEnabled();
});

it.each([
	[
		"ja",
		"TRANSCRIBING_STORY",
		{ completedWindows: 0, totalWindows: 9 },
		"構成に使う発話を文字起こししています",
		"音声認識 0 / 9 区間",
		0,
		9,
	],
	[
		"en",
		"TRANSCRIBING_STORY",
		{ completedWindows: 3, totalWindows: 9 },
		"Transcribing speech for the editing structure",
		"Speech recognition 3 / 9 sections",
		3,
		9,
	],
	[
		"ja",
		"TRANSCRIBING",
		{ completedWindows: 1, totalWindows: 2 },
		"音声を認識しています",
		"音声認識 1 / 2 区間",
		1,
		2,
	],
	[
		"ja",
		"ANALYZING_LOCAL_STORY",
		{ completedChunks: 4, totalChunks: 52, message: "RAW_PROGRESS_TEXT" },
		"対象と出来事を整理しています",
		"内容解析 4 / 52 区間",
		4,
		52,
	],
	[
		"en",
		"ANALYZING_LOCAL_STORY",
		{ completedChunks: 52, totalChunks: 52 },
		"Organizing subjects and events",
		"Content analysis 52 / 52 sections",
		52,
		52,
	],
	[
		"en",
		"ANALYZING_LOCAL_STORY",
		{ completedChunks: 128, totalChunks: 128 },
		"Organizing subjects and events",
		"Content analysis 128 / 128 sections",
		128,
		128,
	],
] as const)("shows bounded phase sections in %s for %s", async (locale, phase, progress, label, message, completed, total) => {
	mocks.api.mockResolvedValue({ ...task(), phase, progress });
	renderWithQuery(<GenerationProgress id={id} />, locale);
	await screen.findByText(label);
	const counter = screen.getByRole("progressbar", { name: label });
	expect(counter).toHaveTextContent(message);
	expect(counter).toHaveAttribute("aria-valuemin", "0");
	expect(counter).toHaveAttribute("aria-valuenow", String(completed));
	expect(counter).toHaveAttribute("aria-valuemax", String(total));
	expect(counter).toHaveAttribute("aria-valuetext", message);
	expect(counter).toHaveAttribute("aria-live", "off");
	expect(screen.getByRole("status")).not.toHaveTextContent(message);
	expect(screen.queryByText(/RAW_PROGRESS_TEXT/)).not.toBeInTheDocument();
	expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each([
	null,
	undefined,
	"RAW_PROGRESS_TEXT",
	[],
	{ totalChunks: 52 },
	{ completedChunks: 4 },
	{ completedChunks: "4", totalChunks: 52 },
	{ completedChunks: 4, totalChunks: "52" },
	{ completedChunks: -1, totalChunks: 52 },
	{ completedChunks: 4.5, totalChunks: 52 },
	{ completedChunks: 4, totalChunks: 52.5 },
	{ completedChunks: 0, totalChunks: 0 },
	{ completedChunks: 53, totalChunks: 52 },
	{ completedChunks: Number.NaN, totalChunks: 52 },
	{ completedChunks: Number.POSITIVE_INFINITY, totalChunks: 52 },
	{ completedChunks: 4, totalChunks: Number.NEGATIVE_INFINITY },
	{ completedChunks: 4, totalChunks: 129 },
	{ completedChunks: Number.MAX_SAFE_INTEGER + 1, totalChunks: 52 },
	{ completedChunks: { message: "RAW_PROGRESS_TEXT" }, totalChunks: 52 },
	{ completedWindows: 4, totalWindows: 9 },
])("hides unsafe or mismatched content-analysis counts %#", async (progress) => {
	mocks.api.mockResolvedValue({
		...task(),
		phase: "ANALYZING_LOCAL_STORY",
		progress,
	});
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Organizing subjects and events");
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	expect(screen.queryByText(/RAW_PROGRESS_TEXT/)).not.toBeInTheDocument();
});

it.each([
	["TRANSCRIBING_STORY", { completedWindows: -1, totalWindows: 9 }],
	["TRANSCRIBING", { completedWindows: 2, totalWindows: 1 }],
	["TRANSCRIBING_STORY", { completedWindows: 1, totalWindows: 129 }],
	["TRANSCRIBING_STORY", { completedChunks: 4, totalChunks: 52 }],
	["TRACKING", { completedChunks: 4, totalChunks: 52 }],
	["PLANNING_LOCAL_STORY", { completedChunks: 52, totalChunks: 52 }],
] as const)("hides counts outside a valid %s payload", async (phase, progress) => {
	mocks.api.mockResolvedValue({ ...task(), phase, progress });
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByRole("button", { name: "Cancel generation" });
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it.each([
	"PENDING",
	"ERROR",
	"CANCELED",
	"SUCCEEDED",
])("hides old phase counts for a %s task", async (state) => {
	mocks.api.mockResolvedValue({
		...task(state, state === "SUCCEEDED" ? result() : null),
		phase: "ANALYZING_LOCAL_STORY",
		progress: { completedChunks: 4, totalChunks: 52 },
	});
	renderWithQuery(<GenerationProgress id={id} />);
	if (state === "SUCCEEDED")
		await screen.findByRole("link", { name: /Open result/ });
	else
		await screen.findByRole("button", {
			name: state === "PENDING" ? "Cancel generation" : "Retry as a new task",
		});
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("clears previous counts when the phase changes before its new counters arrive", async () => {
	mocks.api.mockResolvedValue({
		...task(),
		phase: "TRANSCRIBING_STORY",
		progress: { completedWindows: 9, totalWindows: 9 },
	});
	const view = renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Transcribing speech for the editing structure");
	expect(screen.getByRole("progressbar")).toHaveTextContent("9 / 9");
	act(() => {
		view.client.setQueryData(["library-media-task", id], {
			...task(),
			phase: "ANALYZING_LOCAL_STORY",
			progress: { completedWindows: 9, totalWindows: 9 },
		});
	});
	await screen.findByText("Organizing subjects and events");
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("hides cached counts when the refreshed task cannot be verified", async () => {
	mocks.api.mockResolvedValue({
		...task(),
		phase: "ANALYZING_LOCAL_STORY",
		progress: { completedChunks: 4, totalChunks: 52 },
	});
	renderWithQuery(<GenerationProgress id={id} />);
	await screen.findByText("Organizing subjects and events");
	expect(screen.getByRole("progressbar")).toHaveTextContent("4 / 52");
	mocks.api.mockResolvedValue({ ...task(), taskId: childId });
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await screen.findByRole("alert");
	expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
