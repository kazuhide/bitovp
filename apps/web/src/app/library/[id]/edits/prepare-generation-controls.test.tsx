import { normalizeSceneAnalysis } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import { AutoPortraitForm } from "./auto-portrait-form";
import type { EditingEligibility } from "./editing-forms";
import { PrepareGenerationControls } from "./prepare-generation-controls";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	prepare: true,
	edit: true,
	actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	effectiveId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sessionStatus: "success" as "success" | "pending" | "error",
	sessionMode: "users" as "users" | "none" | "password",
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: async (...args: unknown[]) => mocks.api(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: (control: string) =>
		control === "library.edits.prepare" ? mocks.prepare : mocks.edit,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: mocks.sessionStatus,
		data: {
			configured: true,
			authenticated: true,
			mode: mocks.sessionMode,
			...(mocks.sessionMode === "users"
				? {
						organizationId: "11111111-1111-4111-8111-111111111111",
						actorUserId: mocks.actorId,
						effectiveUserId: mocks.effectiveId,
					}
				: {}),
		},
	}),
}));
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect(value: unknown): void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({
						credentialId: "66666666-6666-4666-8666-666666666666",
						bucket: "editing",
						path: "new-preview/",
					})
				}
			>
				Use selected output folder
			</button>
		) : null,
}));
const preparedId = "88888888-8888-4888-8888-888888888888",
	analysisId = "77777777-7777-4777-8777-777777777777",
	taskId = "44444444-4444-4444-8444-444444444444",
	org = "11111111-1111-4111-8111-111111111111";
function media(state = "READY") {
	const base = editingProjectFixture().media;
	return {
		...base,
		id: preparedId,
		state,
		timeMap: base.timeMap
			? { ...base.timeMap, id: preparedId, mediaVersionId: preparedId }
			: null,
		url: `/api/library/media-versions/${preparedId}/media`,
	};
}
function eligibility(): EditingEligibility {
	return {
		sourceId: editingIds.source,
		files: [{ key: "mp4:original", label: "Original source" }],
		mediaVersions: [],
		analyses: [{ id: analysisId, locale: "en", title: "Recorded analysis" }],
	};
}
function tree(data = eligibility(), organization = org) {
	return (
		<DocumentOrganizationContext.Provider value={organization}>
			<AutoPortraitForm
				contentId={editingIds.content}
				initialTitle="Interview"
				eligibility={data}
				disabled={false}
			/>
		</DocumentOrganizationContext.Provider>
	);
}
let association = "FIXTURE_AUTHORED";
function inspection() {
	return {
		association,
		media: media(),
		analysis: {
			id: analysisId,
			locale: "en",
			document: normalizeSceneAnalysis({
				metadata: { version: "fixture" },
				duration: 16,
				scenes: [
					{
						id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						startInSeconds: 0,
						endInSeconds: 16,
						title: "Interview",
					},
				],
			}),
		},
	};
}
function responses(url: string, init?: RequestInit): unknown {
	if (init?.method === "POST") {
		if (url.includes("/media-versions")) return media("PENDING");
		if (url === "/api/library/analysis-associations") {
			association = "EDITOR_ATTESTED";
			return { confirmed: true, bindingKind: association };
		}
		return { taskId, state: "PENDING", cached: false };
	}
	if (url.includes("analysis-associations")) return inspection();
	if (url.includes("editing-eligibility"))
		return {
			...eligibility(),
			mediaVersions: [media(), editingProjectFixture().media],
		};
	return media();
}
const posts = () =>
	mocks.api.mock.calls.filter(([, init]) => init?.method === "POST");
const generates = () =>
	posts().filter(([url]) => url === "/api/library/media-tasks");
const open = () =>
	fireEvent.click(
		screen.getByRole("button", {
			name: "Prepare a source and generate",
		}),
	);
function output() {
	fireEvent.click(screen.getByRole("button", { name: "Choose output folder" }));
	fireEvent.click(
		screen.getByRole("button", { name: "Use selected output folder" }),
	);
}
const start = () =>
	fireEvent.click(screen.getByRole("button", { name: "Prepare and generate" }));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.prepare = true;
	mocks.edit = true;
	mocks.actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	mocks.effectiveId = mocks.actorId;
	mocks.sessionStatus = "success";
	mocks.sessionMode = "users";
	association = "FIXTURE_AUTHORED";
	mocks.api.mockImplementation(responses);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("prepares with no READY source, pins advanced intent and generates only the returned media ID", async () => {
	renderWithQuery(tree());
	fireEvent.click(screen.getByRole("button", { name: "15 s" }));
	open();
	output();
	fireEvent.change(screen.getByRole("combobox", { name: "Captions" }), {
		target: { value: "ORIGINAL" },
	});
	fireEvent.change(screen.getByLabelText("Speech language"), {
		target: { value: "en" },
	});
	fireEvent.change(screen.getByLabelText("Formats to generate"), {
		target: { value: "3" },
	});
	start();
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(2);
	expect(posts()[0]?.[0]).toBe(
		`/api/library/sources/${editingIds.source}/media-versions`,
	);
	expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
		fileKey: "mp4:original",
		output: {
			credentialId: "66666666-6666-4666-8666-666666666666",
			bucket: "editing",
			prefix: "new-preview/",
		},
	});
	expect(JSON.parse(String(generates()[0]?.[1]?.body))).toMatchObject({
		kind: "GENERATE",
		mediaVersionId: preparedId,
		analysisRevisionId: analysisId,
		requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
		parameters: {
			contentId: editingIds.content,
			targetDurationFrames: 450,
			captions: "ORIGINAL",
			language: "en",
			variants: 3,
			templateId: "portrait-clean",
			policy: "COHESION",
		},
	});
	expect(
		mocks.api.mock.calls.some(
			([url]) => url === `/api/library/media-versions/${preparedId}`,
		),
	).toBe(true);
});
it("requires an output before preparing and does not write when merely opened", () => {
	renderWithQuery(tree());
	open();
	expect(
		screen.getByRole("button", { name: "Prepare and generate" }),
	).toBeDisabled();
	expect(posts()).toHaveLength(0);
});
it("keeps all original form fields fixed while waiting and synchronously rejects a double click", async () => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST" ? pending.promise : responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	const button = screen.getByRole("button", {
		name: "Prepare and generate",
	});
	act(() => {
		fireEvent.click(button);
		fireEvent.click(button);
	});
	expect(posts()).toHaveLength(1);
	expect(screen.getByLabelText("Desired length (seconds)")).toBeDisabled();
	expect(screen.getByLabelText("AISA metadata")).toBeDisabled();
	expect(screen.getByLabelText("Source file")).toBeDisabled();
	expect(screen.getByLabelText("First format")).toBeDisabled();
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel this generation request" }),
	);
	await act(async () => pending.resolve(media("PENDING")));
	expect(generates()).toHaveLength(0);
});
it.each([
	"response-source",
	"read-source",
	"read-id",
	"read-map",
	"read-state",
])("rejects mismatched prepared facts: %s", async (kind) => {
	mocks.api.mockImplementation((url: string, init?: RequestInit) => {
		if (init?.method === "POST" && url.includes("media-versions"))
			return {
				...media("PENDING"),
				...(kind === "response-source"
					? { sourceId: "99999999-9999-4999-8999-999999999999" }
					: {}),
			};
		if (url === `/api/library/media-versions/${preparedId}`)
			return {
				...media(),
				...(kind === "read-source"
					? { sourceId: "99999999-9999-4999-8999-999999999999" }
					: {}),
				...(kind === "read-id" ? { id: editingIds.media } : {}),
				...(kind === "read-map"
					? { timeMap: editingProjectFixture().media.timeMap }
					: {}),
				...(kind === "read-state"
					? { state: "ERROR", error: "MEDIA_PROFILE_UNSUPPORTED" }
					: {}),
			};
		return responses(url, init);
	});
	renderWithQuery(tree());
	open();
	output();
	start();
	await screen.findByRole("alert");
	expect(generates()).toHaveLength(0);
});
it("does not adopt another READY candidate from eligibility refetches", async () => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === `/api/library/media-versions/${preparedId}`
			? pending.promise
			: responses(url, init),
	);
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() =>
		expect(mocks.api).toHaveBeenCalledWith(
			`/api/library/media-versions/${preparedId}`,
			expect.anything(),
		),
	);
	view.rerender(
		tree({ ...eligibility(), mediaVersions: [editingProjectFixture().media] }),
	);
	expect(generates()).toHaveLength(0);
	await act(async () => pending.resolve(media()));
	await waitFor(() => expect(generates()).toHaveLength(1));
	expect(JSON.parse(String(generates()[0]?.[1]?.body)).mediaVersionId).toBe(
		preparedId,
	);
});
it("stops UNVERIFIED without attesting and requires explicit review plus a separate continue", async () => {
	association = "UNVERIFIED";
	renderWithQuery(tree());
	open();
	output();
	start();
	const confirm = await screen.findByRole("button", {
		name: "Record this association",
	});
	expect(generates()).toHaveLength(0);
	expect(posts()).toHaveLength(1);
	fireEvent.loadedMetadata(
		screen.getByLabelText("Prepared source for association review"),
	);
	for (const name of [
		"I checked that the scene times match this video.",
		"I checked the resolution, orientation and subject coordinates.",
		"I checked that the scene descriptions match the video content.",
	])
		fireEvent.click(screen.getByLabelText(name));
	fireEvent.click(confirm);
	const proceed = screen.getByRole("button", {
		name: "Continue with these settings",
	});
	await waitFor(() => expect(proceed).toBeEnabled());
	expect(generates()).toHaveLength(0);
	fireEvent.click(proceed);
	await waitFor(() => expect(generates()).toHaveLength(1));
	expect(
		mocks.api.mock.calls.filter(([url]) =>
			String(url).startsWith("/api/library/analysis-associations?"),
		).length,
	).toBeGreaterThanOrEqual(3);
});
it("never retries an unknown prepare or adopts a new READY source after that unknown outcome", async () => {
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST"
			? Promise.reject(new TypeError("private detail"))
			: responses(url, init),
	);
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Preparation may have been accepted",
	);
	view.rerender(tree({ ...eligibility(), mediaVersions: [media()] }));
	expect(posts()).toHaveLength(1);
	expect(generates()).toHaveLength(0);
	expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
});
it("retries only GENERATE with identical fixed body/key after an unknown generation response", async () => {
	let failures = 1;
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === "/api/library/media-tasks" && failures-- > 0
			? Promise.reject(new TypeError("network"))
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Check the same generation request",
		}),
	);
	await waitFor(() => expect(mocks.push).toHaveBeenCalled());
	expect(generates()).toHaveLength(2);
	expect(generates()[1]?.[1]?.body).toBe(generates()[0]?.[1]?.body);
	expect(
		posts().filter(([url]) => String(url).includes("/sources/")),
	).toHaveLength(1);
});
it.each([
	"cancel",
	"unmount",
	"analysis",
	"duration",
	"organization",
	"role",
])("fences late READY/inspection after %s", async (kind) => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === `/api/library/media-versions/${preparedId}`
			? pending.promise
			: responses(url, init),
	);
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() =>
		expect(mocks.api).toHaveBeenCalledWith(
			`/api/library/media-versions/${preparedId}`,
			expect.anything(),
		),
	);
	if (kind === "cancel")
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel this generation request" }),
		);
	if (kind === "unmount") view.unmount();
	if (kind === "analysis")
		view.rerender(
			tree({
				...eligibility(),
				analyses: [
					{
						id: "99999999-9999-4999-8999-999999999999",
						locale: "en",
						title: "Other",
					},
				],
			}),
		);
	if (kind === "duration")
		fireEvent.change(screen.getByLabelText("Desired length (seconds)"), {
			target: { value: "15" },
		});
	if (kind === "organization")
		view.rerender(tree(eligibility(), "22222222-2222-4222-8222-222222222222"));
	if (kind === "role") {
		mocks.edit = false;
		view.rerender(tree());
	}
	await act(async () => pending.resolve(media()));
	expect(generates()).toHaveLength(0);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts().some(([url]) => String(url).includes("/cancel"))).toBe(false);
});
it.each([
	"prepare",
	"edit",
] as const)("keeps a missing %s role gate closed", (kind) => {
	mocks[kind] = false;
	renderWithQuery(tree());
	open();
	expect(
		screen.getByRole("button", { name: "Choose output folder" }),
	).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Prepare and generate" }),
	).toBeDisabled();
	start();
	expect(posts()).toHaveLength(0);
});
it("does not restore/repost an old intent on remount or StrictMode replay", async () => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST" ? pending.promise : responses(url, init),
	);
	const view = renderWithQuery(<StrictMode>{tree()}</StrictMode>);
	open();
	output();
	start();
	view.unmount();
	renderWithQuery(<StrictMode>{tree()}</StrictMode>);
	expect(posts()).toHaveLength(1);
	await act(async () => pending.resolve(media("PENDING")));
	expect(generates()).toHaveLength(0);
});
it("stops bounded preparation polling without writing again", async () => {
	vi.useFakeTimers();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === `/api/library/media-versions/${preparedId}`
			? media("PREPARING")
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
	});
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Source preparation could not be confirmed",
	);
	expect(posts()).toHaveLength(1);
	expect(generates()).toHaveLength(0);
});

it("does not continue after a canceled association inspection resolves late", async () => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url.startsWith("/api/library/analysis-associations?")
			? pending.promise
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() =>
		expect(
			mocks.api.mock.calls.some(([url]) =>
				String(url).startsWith("/api/library/analysis-associations?"),
			),
		).toBe(true),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel this generation request" }),
	);
	await act(async () => pending.resolve(inspection()));
	expect(generates()).toHaveLength(0);
});
it.each([
	"media",
	"analysis",
])("rejects a mismatched association %s before generation", async (kind) => {
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url.startsWith("/api/library/analysis-associations?")
			? {
					...inspection(),
					...(kind === "media"
						? { media: { ...media(), id: editingIds.media } }
						: { analysis: { ...inspection().analysis, id: editingIds.media } }),
				}
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	await screen.findByRole("alert");
	expect(generates()).toHaveLength(0);
});
it.each([
	"server",
	"malformed",
])("treats an ambiguous prepare %s response as unknown without reposting", async (kind) => {
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST"
			? kind === "server"
				? Promise.reject(new ApiError(503, "private storage detail"))
				: null
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Preparation may have been accepted",
	);
	expect(posts()).toHaveLength(1);
	expect(generates()).toHaveLength(0);
});
it("stops after three failed reads with one preparation and no generation", async () => {
	vi.useFakeTimers();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === `/api/library/media-versions/${preparedId}`
			? Promise.reject(new TypeError("network"))
			: responses(url, init),
	);
	renderWithQuery(tree());
	open();
	output();
	start();
	await act(async () => {});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6001);
	});
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Source preparation could not be confirmed",
	);
	expect(
		mocks.api.mock.calls.filter(
			([url]) => url === `/api/library/media-versions/${preparedId}`,
		),
	).toHaveLength(3);
	expect(posts()).toHaveLength(1);
});
it("returns from an unknown preparation without silently selecting the newest READY source", async () => {
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST"
			? Promise.reject(new TypeError("network"))
			: responses(url, init),
	);
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	await screen.findByRole("alert");
	fireEvent.click(
		screen.getByRole("button", { name: "Return to the prepared source list" }),
	);
	view.rerender(
		tree({
			...eligibility(),
			mediaVersions: [media(), editingProjectFixture().media],
		}),
	);
	expect(screen.getByLabelText("Source video")).toHaveValue("");
	expect(
		screen.getByRole("button", {
			name: "Generate portrait video",
		}),
	).toBeDisabled();
	fireEvent.change(screen.getByLabelText("Source video"), {
		target: { value: preparedId },
	});
	expect(
		screen.getByRole("button", {
			name: "Generate portrait video",
		}),
	).toBeEnabled();
	expect(posts()).toHaveLength(1);
});

// Exercise the real apiFetch and response.json(), not a promise that ignores its AbortSignal.
async function signalAwareTransport(holdPreparation = false) {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	const pending: {
		signal: AbortSignal | undefined;
		body: string | null | undefined;
		finish(): void;
		fail(): void;
	}[] = [];
	const transport = vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input),
			isPreparation =
				url.includes("/sources/") && url.endsWith("/media-versions");
		if (
			init?.method !== "POST" ||
			!(holdPreparation ? isPreparation : url === "/api/library/media-tasks")
		)
			return new Response(JSON.stringify(await responses(url, init)), {
				status: init?.method === "POST" ? 202 : 200,
				headers: { "content-type": "application/json" },
			});
		let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined,
			settled = false;
		const signal = init.signal ?? undefined;
		const abort = () => {
			if (!settled) {
				settled = true;
				bodyController?.error(
					new DOMException("Response body aborted", "AbortError"),
				);
			}
		};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				bodyController = controller;
			},
		});
		signal?.addEventListener("abort", abort, { once: true });
		pending.push({
			signal,
			body: typeof init.body === "string" ? init.body : undefined,
			finish() {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				bodyController?.enqueue(
					new TextEncoder().encode(
						JSON.stringify(
							holdPreparation
								? media("PENDING")
								: { taskId, state: "PENDING", cached: false },
						),
					),
				);
				bodyController?.close();
			},
			fail() {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				bodyController?.error(
					new TypeError("Connection closed while reading receipt"),
				);
			},
		});
		if (signal?.aborted) abort();
		return new Response(stream, {
			status: 202,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", transport);
	mocks.api.mockImplementation(actual.apiFetch);
	return { pending, transport };
}

it("signal-aware: cancel retains a bounded accepted receipt, prevents new start and exposes its late link without navigation", async () => {
	const io = await signalAwareTransport();
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() => expect(io.pending).toHaveLength(1));
	const receipt = io.pending[0];
	if (!receipt) throw new Error("Missing accepted receipt");
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel this generation request" }),
	);
	expect(receipt.signal?.aborted).toBe(false);
	expect(
		screen.getByRole("button", { name: "Prepare and generate" }),
	).toBeDisabled();
	start();
	expect(posts()).toHaveLength(2);
	expect(
		screen.getByText(
			"Generation may still be running. Retrying this request can start it if it was not accepted.",
		),
	).toBeVisible();
	await act(async () => receipt.finish());
	expect(
		await screen.findByRole("link", { name: "Generation progress" }),
	).toHaveAttribute("href", `/library/generations/${taskId}`);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts()).toHaveLength(2);
});
it.each([
	"cancel-first",
	"network-first",
] as const)("signal-aware: %s keeps unknown generation recovery on exactly the original body/key", async (order) => {
	const io = await signalAwareTransport();
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() => expect(io.pending).toHaveLength(1));
	const first = io.pending[0];
	if (!first) throw new Error("Missing receipt");
	if (order === "cancel-first")
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel this generation request" }),
		);
	await act(async () => first.fail());
	await screen.findByRole("button", {
		name: "Check the same generation request",
	});
	if (order === "network-first")
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel this generation request" }),
		);
	expect(
		screen.getByText(
			"Generation may still be running. Retrying this request can start it if it was not accepted.",
		),
	).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Prepare and generate" }),
	).toBeDisabled();
	fireEvent.click(
		screen.getByRole("button", { name: "Check the same generation request" }),
	);
	await waitFor(() => expect(io.pending).toHaveLength(2));
	expect(io.pending[1]?.body).toBe(first.body);
	expect(
		posts().filter(([url]) => String(url).includes("/sources/")),
	).toHaveLength(1);
	await act(async () => io.pending[1]?.finish());
	expect(
		await screen.findByRole("link", { name: "Generation progress" }),
	).toHaveAttribute("href", `/library/generations/${taskId}`);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts().some(([url]) => String(url).includes("/cancel"))).toBe(false);
});
it.each([
	"unmount",
	"organization",
	"analysis",
	"duration",
	"role",
] as const)("signal-aware: %s aborts the pending receipt and suppresses late UI and replay", async (kind) => {
	const io = await signalAwareTransport();
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() => expect(io.pending).toHaveLength(1));
	const receipt = io.pending[0];
	if (!receipt) throw new Error("Missing receipt");
	if (kind === "unmount") view.unmount();
	if (kind === "organization")
		view.rerender(tree(eligibility(), "22222222-2222-4222-8222-222222222222"));
	if (kind === "analysis")
		view.rerender(
			tree({
				...eligibility(),
				analyses: [
					{
						id: "99999999-9999-4999-8999-999999999999",
						locale: "en",
						title: "Other",
					},
				],
			}),
		);
	if (kind === "duration")
		fireEvent.change(screen.getByLabelText("Desired length (seconds)"), {
			target: { value: "15" },
		});
	if (kind === "role") {
		mocks.edit = false;
		view.rerender(tree());
	}
	expect(receipt.signal?.aborted).toBe(true);
	await act(async () => receipt.finish());
	expect(
		screen.queryByRole("link", { name: "Generation progress" }),
	).not.toBeInTheDocument();
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts()).toHaveLength(2);
});
it("signal-aware: cancel still aborts preparation receipt and never retries it", async () => {
	const io = await signalAwareTransport(true);
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() => expect(io.pending).toHaveLength(1));
	const receipt = io.pending[0];
	if (!receipt) throw new Error("Missing receipt");
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel this generation request" }),
	);
	expect(receipt.signal?.aborted).toBe(true);
	await act(async () => receipt.finish());
	expect(posts()).toHaveLength(1);
	expect(generates()).toHaveLength(0);
});

it.each([
	"actor",
	"effective-user",
	"session",
] as const)("signal-aware identity: %s invalidates a submitted receipt even at the same operator floor", async (kind) => {
	const io = await signalAwareTransport();
	const view = renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() => expect(io.pending).toHaveLength(1));
	const receipt = io.pending[0];
	if (!receipt) throw new Error("Missing receipt");
	if (kind === "actor") mocks.actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	if (kind === "effective-user")
		mocks.effectiveId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	if (kind === "session") mocks.sessionStatus = "error";
	view.rerender(tree());
	expect(receipt.signal?.aborted).toBe(true);
	await act(async () => receipt.finish());
	expect(
		screen.queryByRole("link", { name: "Generation progress" }),
	).not.toBeInTheDocument();
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts()).toHaveLength(2);
});

it.each([
	"none",
	"password",
] as const)("retains resolved %s single-owner mode without inventing actor IDs", async (mode) => {
	mocks.sessionMode = mode;
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(2);
});

const automaticTarget = {
	fileKey: "mp4:original",
	output: {
		credentialId: "66666666-6666-4666-8666-666666666666",
		bucket: "editing",
		prefix: "automatic-edit/",
	},
};
function automaticPreparation(
	target = automaticTarget,
	storyAvailable = false,
) {
	return (
		<DocumentOrganizationContext.Provider value={org}>
			<PrepareGenerationControls
				contentId={editingIds.content}
				eligibility={{ ...eligibility(), storyAvailable }}
				analysisRevisionId={analysisId}
				targetDurationFrames={450}
				disabled={false}
				renderMode="DRAFT"
				preparationTarget={target}
				onBusyChange={automaticBusy}
				onReturn={() => {}}
			/>
		</DocumentOrganizationContext.Provider>
	);
}
const automaticBusy = vi.fn();
it("keeps preparation on AUTO despite stale STORY availability and sends no context query", async () => {
	renderWithQuery(automaticPreparation(automaticTarget, true));
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	const policy = screen.getByRole("combobox", { name: "Selection policy" });
	expect(policy).toHaveValue("AUTO");
	expect(
		screen.queryByRole("option", { name: "Story flow (experimental)" }),
	).not.toBeInTheDocument();
	fireEvent.change(policy, { target: { value: "COHESION" } });
	fireEvent.change(
		screen.getByRole("textbox", { name: "Context to include" }),
		{
			target: { value: "object" },
		},
	);
	fireEvent.change(policy, { target: { value: "AUTO" } });
	expect(policy).toHaveValue("AUTO");
	expect(
		screen.queryByRole("textbox", { name: "Context to include" }),
	).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(generates()).toHaveLength(1));
	const body = JSON.parse(String(generates()[0]?.[1].body));
	expect(body.parameters).toMatchObject({
		policy: "AUTO",
		renderMode: "DRAFT",
	});
	expect(body.parameters).not.toHaveProperty("query");
});
it("removes the withdrawn STORY option during preparation without starting work", () => {
	renderWithQuery(automaticPreparation());
	fireEvent.click(screen.getByText("Caption, framing and scene settings"));
	expect(
		screen.queryByRole("option", { name: "Story flow (experimental)" }),
	).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
});
it("creates a DRAFT proposal using the resolver's exact preparation target without another source/output form", async () => {
	renderWithQuery(automaticPreparation());
	expect(posts()).toHaveLength(0);
	expect(
		screen.queryByRole("button", { name: "Choose output folder" }),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	expect(posts()).toHaveLength(2);
	const preparation = posts()[0],
		generation = generates()[0];
	if (!preparation || !generation)
		throw new Error("Missing DRAFT preparation requests");
	expect(JSON.parse(String(preparation[1].body))).toEqual(automaticTarget);
	expect(JSON.parse(String(generation[1].body))).toMatchObject({
		kind: "GENERATE",
		mediaVersionId: preparedId,
		analysisRevisionId: analysisId,
		parameters: {
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			presentation: {
				version: "portrait-layout-v1",
				videoFit: "AUTO",
				fallbackFraming: "PRESERVE_SOURCE_V1",
				captionPlacement: "OVERLAY",
			},
			targetDurationFrames: 450,
			captions: "AUTO",
			tracking: true,
			variants: 1,
			policy: "AUTO",
		},
	});
});
it("keeps an unverified prepared DRAFT source stopped with unchecked confirmations and no generation", async () => {
	association = "UNVERIFIED";
	renderWithQuery(automaticPreparation());
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await screen.findByText(/This analysis has no verified association/);
	expect(generates()).toHaveLength(0);
	expect(posts()).toHaveLength(1);
	for (const label of [
		"I checked that the scene times match this video.",
		"I checked the resolution, orientation and subject coordinates.",
		"I checked that the scene descriptions match the video content.",
	])
		expect(screen.getByRole("checkbox", { name: label })).not.toBeChecked();
	expect(
		screen.getByRole("button", { name: "Continue with these settings" }),
	).toBeDisabled();
});
it("does not continue a resolver preparation target that changed while its receipt was pending", async () => {
	const pending = deferred<unknown>();
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST" && url.includes("/media-versions")
			? pending.promise
			: Promise.resolve(responses(url, init)),
	);
	const view = renderWithQuery(automaticPreparation());
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(1));
	view.rerender(
		automaticPreparation({
			...automaticTarget,
			output: { ...automaticTarget.output, prefix: "other/" },
		}),
	);
	await act(async () => pending.resolve(media("PENDING")));
	expect(generates()).toHaveLength(0);
	expect(mocks.push).not.toHaveBeenCalled();
});

it("keeps the legacy prepare-and-generate request free of the DRAFT-only policy version", async () => {
	renderWithQuery(tree());
	open();
	output();
	start();
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${taskId}`),
	);
	const call = generates()[0];
	if (!call) throw new Error("Missing legacy generation");
	const parameters = JSON.parse(String(call[1].body)).parameters;
	expect(parameters).not.toHaveProperty("draftPolicyVersion");
	expect(parameters).not.toHaveProperty("renderMode");
	expect(posts()).toHaveLength(2);
});
