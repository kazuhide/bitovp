import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AutomaticEditingContext } from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import { AutomaticProjectForm } from "./automatic-project-form";
import type { EditingEligibility } from "./editing-forms";
import { EditingLibraryClient } from "./editing-library";

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
const mediaId = "88888888-8888-4888-8888-888888888888",
	analysisId = "77777777-7777-4777-8777-777777777777",
	taskId = "99999999-9999-4999-8999-999999999999",
	encodingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prepared = () => {
	const base = editingProjectFixture().media;
	return {
		...base,
		id: mediaId,
		url: `/api/library/media-versions/${mediaId}/media`,
		timeMap: base.timeMap && {
			...base.timeMap,
			id: mediaId,
			mediaVersionId: mediaId,
		},
	};
};
function eligibility(
	patch: Partial<AutomaticEditingContext> = {},
): EditingEligibility {
	return {
		sourceId: editingIds.source,
		files: [{ key: "mp4:fixed", label: "Encoding output" }],
		mediaVersions: [editingProjectFixture().media, prepared()],
		analyses: [
			{ id: editingIds.content, locale: "ja", title: "Other analysis" },
			{ id: analysisId, locale: "en", title: "Encoding AISA" },
		],
		automatic: {
			encodingId,
			status: "READY",
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			hasAudio: true,
			preparation: null,
			reason: null,
			...patch,
		},
	};
}
function response(url: string, init?: RequestInit) {
	if (init?.method === "POST") {
		if (url.endsWith("/media-versions"))
			return { ...prepared(), state: "PENDING" };
		if (url === "/api/library/media-tasks")
			return { taskId, state: "PENDING", cached: false };
		throw new Error("Unexpected mutation");
	}
	if (url.includes("editing-eligibility")) return eligibility();
	if (url.startsWith("/api/library/edits?"))
		return { items: [], total: 0, offset: 0 };
	if (url.includes("analysis-associations"))
		return {
			association: "FIXTURE_AUTHORED",
			media: prepared(),
			analysis: { id: analysisId },
		};
	if (url.includes("/media-versions/")) return prepared();
	return {
		id: editingIds.content,
		title: "Recorded encoding",
		source: { id: editingIds.source },
	};
}
const posts = () =>
	mocks.api.mock.calls.filter(([, init]) => init?.method === "POST");
function post(index: number) {
	const call = posts()[index];
	if (!call) throw new Error(`Missing POST ${index}`);
	return call;
}
const tree = (data = eligibility()) => {
	if (!data.automatic) throw new Error("Missing automatic context fixture");
	return (
		<AutomaticProjectForm
			contentId={editingIds.content}
			initialTitle="Recorded encoding"
			eligibility={data}
			context={data.automatic}
			disabled={false}
		/>
	);
};

it.each([
	"READY",
	"NEEDS_PREPARATION",
] as const)("ignores stale STORY availability in the %s project form without starting work", (status) => {
	const data = eligibility({
		status,
		preparation:
			status === "NEEDS_PREPARATION"
				? {
						fileKey: "mp4:fixed",
						output: {
							credentialId: "66666666-6666-4666-8666-666666666666",
							bucket: "editing",
							prefix: "story/",
						},
					}
				: null,
	});
	data.storyAvailable = true;
	renderWithQuery(tree(data));
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	expect(
		screen.queryByRole("option", { name: "Story flow (experimental)" }),
	).not.toBeInTheDocument();
	expect(
		screen.getByRole("combobox", { name: "Selection policy" }),
	).toHaveValue("AUTO");
	expect(posts()).toHaveLength(0);
});
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.permitted = true;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) =>
		response(url, init),
	);
});
it.each([
	"READY",
	"NEEDS_PREPARATION",
] as const)("uses the configured local story default through the %s automatic entry", async (status) => {
	const data = eligibility({
		status,
		preparation:
			status === "NEEDS_PREPARATION"
				? {
						fileKey: "mp4:fixed",
						output: {
							credentialId: "66666666-6666-4666-8666-666666666666",
							bucket: "editing",
							prefix: "local-story/",
						},
					}
				: null,
	});
	data.localStoryAvailable = true;
	renderWithQuery(tree(data));
	if (status === "READY")
		fireEvent.click(
			screen.getByRole("button", { name: "Association checked" }),
		);
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() =>
		expect(posts().some(([url]) => url === "/api/library/media-tasks")).toBe(
			true,
		),
	);
	const call = posts().find(([url]) => url === "/api/library/media-tasks");
	expect(JSON.parse(String(call?.[1].body)).parameters).toMatchObject({
		policy: "LOCAL_STORY",
		storyMode: "AUTO",
		renderMode: "DRAFT",
		targetDurationFrames: 900,
	});
	expect(posts().some(([url]) => String(url).includes("/renders"))).toBe(false);
});
it("has one project action and uses only the resolver's encoding, media and analysis with DRAFT defaults", async () => {
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	const create = await screen.findByRole("button", { name: "Create project" });
	expect(
		screen.getAllByRole("button", { name: "Create project" }),
	).toHaveLength(1);
	expect(
		screen.queryByRole("button", { name: "Generate portrait video" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Prepare editing material" }),
	).not.toBeInTheDocument();
	expect(screen.getByText(encodingId)).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "15 s" }));
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(create);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(1);
	expect(post(0)[0]).toBe("/api/library/media-tasks");
	expect(JSON.parse(String(post(0)[1].body))).toMatchObject({
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		parameters: {
			renderMode: "DRAFT",
			targetDurationFrames: 450,
			captions: "AUTO",
			tracking: true,
			variants: 1,
			policy: "AUTO",
		},
	});
});
it.each([
	"UNAVAILABLE",
	"ANALYSIS_PENDING",
	"PREPARING",
] as const)("does not choose another ready candidate or post while context is %s", (status) => {
	renderWithQuery(
		tree(
			eligibility({ status, mediaVersionId: null, analysisRevisionId: null }),
		),
	);
	const create = screen.getByRole("button", { name: "Create project" });
	expect(create).toBeDisabled();
	fireEvent.click(create);
	expect(posts()).toHaveLength(0);
});
it("does not fall back to the first media or analysis when a resolved ID is foreign", () => {
	renderWithQuery(tree(eligibility({ mediaVersionId: encodingId })));
	expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
	expect(posts()).toHaveLength(0);
});
it("keeps association confirmation explicit even when the resolver names a ready pair", () => {
	renderWithQuery(tree(eligibility({ status: "NEEDS_CONFIRMATION" })));
	expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
	expect(posts()).toHaveLength(0);
});
it("retains the exact preparation reservation through a normal resolver PREPARING update", async () => {
	const target = {
		fileKey: "mp4:fixed",
		output: {
			credentialId: editingIds.source,
			bucket: "editing",
			prefix: "fixed/",
		},
	};
	const data = eligibility({
		status: "NEEDS_PREPARATION",
		mediaVersionId: null,
		preparation: target,
		hasAudio: null,
	});
	let resolve!: (value: unknown) => void;
	mocks.api.mockImplementation((url: string, init?: RequestInit) => {
		if (init?.method === "POST" && url.endsWith("/media-versions"))
			return new Promise((done) => {
				resolve = done;
			});
		return Promise.resolve(response(url, init));
	});
	const view = renderWithQuery(tree(data));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(1));
	view.rerender(
		tree(
			eligibility({
				status: "PREPARING",
				mediaVersionId: mediaId,
				preparation: null,
			}),
		),
	);
	await act(async () => resolve({ ...prepared(), state: "PENDING" }));
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(2);
	expect(JSON.parse(String(post(0)[1].body))).toEqual(target);
	expect(JSON.parse(String(post(1)[1].body))).toMatchObject({
		mediaVersionId: mediaId,
		parameters: { renderMode: "DRAFT" },
	});
});
it("keeps viewer access read-only in the integrated entry", async () => {
	mocks.permitted = false;
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	await screen.findByText("Recorded encoding");
	expect(
		screen.queryByRole("button", { name: "Generate portrait video" }),
	).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
});
it("keeps a non-encoding source manually editable behind the additional source controls", async () => {
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("editing-eligibility"))
			return eligibility({
				encodingId: null,
				status: "UNAVAILABLE",
				reason: "NO_ENCODING_SOURCE",
				analysisRevisionId: null,
				mediaVersionId: null,
			});
		if (init?.method === "POST" && url === "/api/library/edits")
			return editingProjectFixture();
		return response(url, init);
	});
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	const additional = await screen.findByText("Source tools and manual editing");
	expect(
		screen.queryByRole("button", { name: "Create project" }),
	).not.toBeInTheDocument();
	fireEvent.click(additional);
	const manualCreate = await screen.findByRole("button", {
		name: "Create project",
	});
	fireEvent.change(screen.getByLabelText("Format"), {
		target: { value: "PORTRAIT" },
	});
	fireEvent.click(manualCreate);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(
			`/library/edits/${editingIds.project}`,
		),
	);
	expect(posts()).toHaveLength(1);
	expect(post(0)[0]).toBe("/api/library/edits");
	expect(JSON.parse(String(post(0)[1].body))).toMatchObject({
		contentId: editingIds.content,
		mediaVersionId: editingIds.media,
		variant: "PORTRAIT",
		analysisRevisionId: null,
	});
});

function integratedRegion() {
	const section = screen
		.getByRole("heading", { name: "Create project" })
		.closest("section");
	if (!section) throw new Error("Missing integrated project section");
	return within(section);
}

it("releases a conclusively rejected draft reservation before refresh selects a new ready pair", async () => {
	let currentEligibility = eligibility();
	let rejected = false;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("editing-eligibility")) return currentEligibility;
		if (
			url === "/api/library/media-tasks" &&
			init?.method === "POST" &&
			!rejected
		) {
			rejected = true;
			throw new ApiError(422, "ANALYSIS_BINDING_UNVERIFIED");
		}
		return response(url, init);
	});
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	await screen.findByRole("button", { name: "Create project" });
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	expect(posts()).toHaveLength(1);
	const failedBody = JSON.parse(String(post(0)[1].body));
	currentEligibility = eligibility({
		mediaVersionId: editingIds.media,
		analysisRevisionId: editingIds.content,
	});
	currentEligibility.mediaVersions = currentEligibility.mediaVersions.filter(
		(media) => media.id !== mediaId,
	);
	currentEligibility.analyses = currentEligibility.analyses.filter(
		(analysis) => analysis.id !== analysisId,
	);
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(
			integratedRegion().getByText("ja: Other analysis"),
		).toBeInTheDocument(),
	);
	expect(
		integratedRegion().queryByText("en: Encoding AISA"),
	).not.toBeInTheDocument();
	expect(posts()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(2);
	const nextBody = JSON.parse(String(post(1)[1].body));
	expect(nextBody).toMatchObject({
		mediaVersionId: editingIds.media,
		analysisRevisionId: editingIds.content,
		parameters: { renderMode: "DRAFT" },
	});
	expect(nextBody.requestKey).not.toBe(failedBody.requestKey);
});

it.each([
	"transport",
	"server",
] as const)("retains an unknown %s receipt reservation and the exact request through a resolver refresh", async (kind) => {
	let currentEligibility = eligibility();
	let submitted = false;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("editing-eligibility")) return currentEligibility;
		if (
			url === "/api/library/media-tasks" &&
			init?.method === "POST" &&
			!submitted
		) {
			submitted = true;
			throw kind === "server"
				? new ApiError(503, "RECEIPT_UNAVAILABLE")
				: new TypeError("receipt lost");
		}
		return response(url, init);
	});
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	await screen.findByRole("button", { name: "Create project" });
	fireEvent.click(screen.getByRole("button", { name: "15 s" }));
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByRole("alert");
	const firstBody = String(post(0)[1].body);
	currentEligibility = eligibility({
		mediaVersionId: editingIds.media,
		analysisRevisionId: editingIds.content,
	});
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(
			mocks.api.mock.calls.filter(([url]) =>
				String(url).includes("editing-eligibility"),
			),
		).toHaveLength(2),
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled(),
	);
	expect(integratedRegion().getByText("en: Encoding AISA")).toBeInTheDocument();
	expect(
		integratedRegion().queryByText("ja: Other analysis"),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText("Desired length (seconds)")).toBeDisabled();
	expect(posts()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());
	expect(posts()).toHaveLength(2);
	expect(String(post(1)[1].body)).toBe(firstBody);
});

function withoutReservedHistory(patch: Partial<AutomaticEditingContext> = {}) {
	const next = eligibility({
		mediaVersionId: editingIds.media,
		analysisRevisionId: editingIds.content,
		...patch,
	});
	next.mediaVersions = next.mediaVersions.filter(
		(media) => media.id !== mediaId,
	);
	next.analyses = next.analyses.filter(
		(analysis) => analysis.id !== analysisId,
	);
	next.files = [];
	return next;
}

it.each([
	"transport",
	"server",
] as const)("retains the same %s request after the reserved media and analysis both leave history", async (kind) => {
	let currentEligibility = eligibility();
	let submitted = false;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("editing-eligibility")) return currentEligibility;
		if (
			url === "/api/library/media-tasks" &&
			init?.method === "POST" &&
			!submitted
		) {
			submitted = true;
			throw kind === "server"
				? new ApiError(503, "RECEIPT_UNAVAILABLE")
				: new TypeError("receipt lost");
		}
		return response(url, init);
	});
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	const create = await screen.findByRole("button", { name: "Create project" });
	fireEvent.click(screen.getByRole("button", { name: "15 s" }));
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(create);
	await screen.findByRole("alert");
	const firstBody = String(post(0)[1].body);
	const originalForm = screen.getByRole("form", { name: "Create project" });
	currentEligibility = withoutReservedHistory();
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(
			mocks.api.mock.calls.filter(([url]) =>
				String(url).includes("editing-eligibility"),
			),
		).toHaveLength(2),
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled(),
	);
	expect(screen.getByRole("form", { name: "Create project" })).toBe(
		originalForm,
	);
	expect(integratedRegion().getByText("en: Encoding AISA")).toBeInTheDocument();
	expect(
		integratedRegion().queryByText("ja: Other analysis"),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText("Desired length (seconds)")).toHaveValue(15);
	expect(screen.getByLabelText("Desired length (seconds)")).toBeDisabled();
	expect(posts()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());
	expect(posts()).toHaveLength(2);
	expect(String(post(1)[1].body)).toBe(firstBody);
});

it.each([
	"pending",
	"unknown",
] as const)("retains a %s preparation when its original analysis and file leave resolver history", async (kind) => {
	const target = {
		fileKey: "mp4:fixed",
		output: {
			credentialId: editingIds.source,
			bucket: "editing",
			prefix: "fixed/",
		},
	};
	const initial = eligibility({
		status: "NEEDS_PREPARATION",
		mediaVersionId: null,
		preparation: target,
		hasAudio: null,
	});
	let complete!: (value: unknown) => void;
	mocks.api.mockImplementation((url: string, init?: RequestInit) => {
		if (url.endsWith("/media-versions") && init?.method === "POST") {
			if (kind === "unknown")
				return Promise.reject(new TypeError("preparation receipt lost"));
			return new Promise((resolve) => {
				complete = resolve;
			});
		}
		return Promise.resolve(response(url, init));
	});
	const view = renderWithQuery(tree(initial));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(1));
	if (kind === "unknown") await screen.findByRole("alert");
	const originalForm = screen.getByRole("form", { name: "Create project" });
	view.rerender(
		tree(withoutReservedHistory({ status: "PREPARING", preparation: null })),
	);
	expect(screen.getByRole("form", { name: "Create project" })).toBe(
		originalForm,
	);
	expect(integratedRegion().getByText("en: Encoding AISA")).toBeInTheDocument();
	expect(screen.getByLabelText("Desired length (seconds)")).toBeDisabled();
	expect(posts()).toHaveLength(1);
	if (kind === "unknown") {
		fireEvent.click(
			screen.getByRole("button", {
				name: "Return to the prepared source list",
			}),
		);
		expect(
			screen.queryByRole("button", {
				name: "Return to the prepared source list",
			}),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create project" }),
		).toBeDisabled();
		expect(posts()).toHaveLength(1);
		expect(mocks.push).not.toHaveBeenCalled();
	} else {
		await act(async () => complete({ ...prepared(), state: "PENDING" }));
		await waitFor(() =>
			expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
		);
		expect(posts()).toHaveLength(2);
		expect(JSON.parse(String(post(0)[1].body))).toEqual(target);
		expect(JSON.parse(String(post(1)[1].body))).toMatchObject({
			analysisRevisionId: analysisId,
			mediaVersionId: mediaId,
			parameters: { renderMode: "DRAFT", targetDurationFrames: 900 },
		});
	}
});

it.each([
	"source",
	"encoding",
] as const)("fences a late draft receipt when the live %s identity changes despite a reservation snapshot", async (boundary) => {
	let currentEligibility = eligibility();
	let currentSourceId = editingIds.source;
	let complete!: (value: unknown) => void;
	let signal: AbortSignal | null | undefined;
	mocks.api.mockImplementation((url: string, init?: RequestInit) => {
		if (url.includes("editing-eligibility"))
			return Promise.resolve(currentEligibility);
		if (url === `/api/library/${editingIds.content}`)
			return Promise.resolve({
				id: editingIds.content,
				title: "Recorded encoding",
				source: { id: currentSourceId },
			});
		if (url === "/api/library/media-tasks" && init?.method === "POST") {
			signal = init.signal;
			return new Promise((resolve) => {
				complete = resolve;
			});
		}
		return Promise.resolve(response(url, init));
	});
	renderWithQuery(
		<EditingLibraryClient
			contentId={editingIds.content}
			clipEditingAvailable
		/>,
	);
	await screen.findByRole("button", { name: "Create project" });
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(1));
	currentEligibility = eligibility();
	if (boundary === "source") {
		currentSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		currentEligibility.sourceId = currentSourceId;
		currentEligibility.mediaVersions = currentEligibility.mediaVersions.map(
			(media) => ({ ...media, sourceId: currentSourceId }),
		);
	} else {
		if (!currentEligibility.automatic) throw new Error("Missing context");
		currentEligibility.automatic.encodingId =
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	}
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() => expect(signal?.aborted).toBe(true));
	await act(async () => complete({ taskId, state: "PENDING", cached: false }));
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts()).toHaveLength(1);
});
