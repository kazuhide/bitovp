import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import type {
	EditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { renderWithQuery } from "@/test/render";
import { editingIds, editingProjectFixture } from "../../editing-fixtures";
import { PortraitResult } from "./portrait-result";

const apiFetch = vi.fn();
let canMutate = true;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canMutate,
}));
beforeEach(() => {
	apiFetch.mockReset();
	canMutate = true;
});

function project(): EditingProjectView {
	const value = editingProjectFixture();
	value.currentRevisionId = editingIds.revision;
	value.currentRevisionMatchesDraft = true;
	value.draft.analysisRevisionId = editingIds.clip;
	value.draft.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 900,
		generatedDurationFrames: 300,
		reasonCodes: ["WHOLE_SHOT_WINDOW"],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: editingIds.content,
			sourceId: editingIds.source,
			locale: "en",
			analysisRevisionId: editingIds.clip,
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
			mediaVersionId: editingIds.media,
			mediaSha256: "d".repeat(64),
			timeMapId: editingIds.media,
			timeMapHash: "e".repeat(64),
			sourceStartUs: 0,
			sourceEndUs: 60_000_000,
			width: 1920,
			height: 1080,
		},
	};
	return value;
}
function run(state: string, generation = 1): EditingRenderView {
	return {
		id: `${generation}8888888-8888-4888-8888-888888888888`,
		revisionId: editingIds.revision,
		kind: "EXPORT",
		state,
		generation,
		error: state === "FAILED" ? "SOURCE_READ_FAILED" : null,
		durationFrames: 300,
		artifact:
			state === "SUCCEEDED"
				? {
						id: editingIds.source,
						url: "/api/library/artifacts/latest/media",
						downloadUrl: "/api/library/artifacts/latest/download",
						derivedContentId: editingIds.content,
					}
				: null,
	};
}

it("plays only the latest real export and displays fixed output duration with navigation", async () => {
	const value = project();
	value.draft.clips = value.draft.clips.map((clip) => ({
		...clip,
		durationFrames: 600,
		framing: [{ fromFrame: 0, toFrame: 600, mode: "FIT", origin: "MANUAL" }],
	}));
	value.renders = [run("SUCCEEDED")];
	apiFetch.mockResolvedValue(value);
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(await screen.findByLabelText("Portrait video result")).toHaveAttribute(
		"src",
		"/api/library/artifacts/latest/media",
	);
	expect(screen.getByText("Requested 30 s")).toBeInTheDocument();
	expect(screen.getByText("Output 10 s")).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "Download MP4" })).toHaveAttribute(
		"href",
		"/api/library/artifacts/latest/download",
	);
	expect(screen.getByRole("link", { name: "Edit video" })).toHaveAttribute(
		"href",
		`/library/edits/${editingIds.project}`,
	);
	expect(screen.getByRole("link", { name: "Back to content" })).toHaveAttribute(
		"href",
		`/library/${editingIds.content}`,
	);
	expect(
		screen.getByRole("link", { name: "Open derived content" }),
	).toHaveAttribute("href", `/library/${editingIds.content}`);
});

it("keeps existing results and owned cancellation while GPU render admission is disabled", async () => {
	const value = project();
	value.renders = [run("RENDERING")];
	apiFetch.mockResolvedValue(value);
	renderWithQuery(
		<PortraitResult id={editingIds.project} clipEditingAvailable={false} />,
	);
	expect(
		await screen.findByRole("button", { name: "Request cancellation" }),
	).toBeEnabled();
	expect(
		screen.getByRole("button", { name: "Retry MP4 generation" }),
	).toBeDisabled();
	expect(
		screen.queryByRole("link", { name: "Edit video" }),
	).not.toBeInTheDocument();
});

it("does not present an old successful artifact after the newest export fails", async () => {
	const value = project();
	value.renders = [run("SUCCEEDED", 1), run("FAILED", 2)];
	apiFetch.mockResolvedValue(value);
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	await screen.findByText("Failed");
	expect(
		screen.queryByRole("link", { name: "Download MP4" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByLabelText("Portrait video result"),
	).not.toBeInTheDocument();
	expect(screen.getByText(/source could not be read/)).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Retry MP4 generation" }),
	).toBeEnabled();
});

it("handles legacy manual projects without automatic metadata", async () => {
	apiFetch.mockResolvedValue(editingProjectFixture());
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(
		await screen.findByText(/no recorded automatic-generation length/),
	).toBeInTheDocument();
	expect(screen.getByText("Waiting for an export.")).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Retry MP4 generation" }),
	).toBeDisabled();
	expect(screen.getByRole("link", { name: "Edit video" })).toBeInTheDocument();
});

it("shows the actual duration of a manual export without inventing a requested length", async () => {
	const value = editingProjectFixture();
	value.currentRevisionId = editingIds.revision;
	value.currentRevisionMatchesDraft = true;
	value.renders = [run("SUCCEEDED")];
	apiFetch.mockResolvedValue(value);
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	await screen.findByText(/no recorded automatic-generation length/);
	expect(screen.getByText("Output 10 s")).toBeInTheDocument();
	expect(screen.queryByText(/Requested .* s/)).not.toBeInTheDocument();
});

it("polls a real export from queued through success and ignores a preview artifact", async () => {
	const value = project();
	value.renders = [{ ...run("SUCCEEDED", 9), kind: "PREVIEW" }, run("QUEUED")];
	apiFetch
		.mockResolvedValueOnce(value)
		.mockResolvedValue({ ...value, renders: [run("SUCCEEDED")] });
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(await screen.findByText("Queued")).toBeInTheDocument();
	expect(
		screen.queryByRole("link", { name: "Download MP4" }),
	).not.toBeInTheDocument();
	expect(
		await screen.findByRole("link", { name: "Download MP4" }),
	).toBeInTheDocument();
	expect(apiFetch).toHaveBeenCalledTimes(2);
});

it("cancels the real active run and prevents duplicate synchronous cancel requests", async () => {
	const value = project();
	value.renders = [run("RENDERING")];
	let finish!: (value: unknown) => void;
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST")
			return new Promise((resolve) => {
				finish = resolve;
			});
		return value;
	});
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	const cancel = await screen.findByRole("button", {
		name: "Request cancellation",
	});
	act(() => {
		fireEvent.click(cancel);
		fireEvent.click(cancel);
	});
	expect(
		apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
	).toHaveLength(1);
	expect(
		apiFetch.mock.calls.find(([, init]) => init?.method === "POST")?.[0],
	).toBe(`/api/library/renders/${run("RENDERING").id}/cancel`);
	await act(async () => finish(run("CANCEL_REQUESTED")));
});

it("retries the fixed revision with the same key after an unknown outcome and a new key after acceptance", async () => {
	const value = project();
	value.renders = [run("FAILED")];
	const bodies: Array<{
		revisionId: string;
		kind: string;
		requestKey: string;
	}> = [];
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			bodies.push(JSON.parse(String(init.body)));
			if (bodies.length === 1) throw new TypeError("private network detail");
			value.renders = [run("CANCELED", bodies.length)];
			return value.renders[0];
		}
		return structuredClone(value);
	});
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Retry MP4 generation" }),
	);
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Retry MP4 generation" }));
	await screen.findByText("Canceled");
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Retry MP4 generation" }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Retry MP4 generation" }));
	await waitFor(() => expect(bodies).toHaveLength(3));
	expect(bodies[0]).toMatchObject({
		revisionId: editingIds.revision,
		kind: "EXPORT",
	});
	expect(bodies[1]?.requestKey).toBe(bodies[0]?.requestKey);
	expect(bodies[2]?.requestKey).not.toBe(bodies[1]?.requestKey);
	expect(screen.queryByText(/private network detail/)).not.toBeInTheDocument();
});

it("keeps a read-only result playable while disabling render mutations", async () => {
	canMutate = false;
	const value = project();
	value.renders = [run("SUCCEEDED")];
	apiFetch.mockResolvedValue(value);
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(
		await screen.findByLabelText("Portrait video result"),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Request cancellation" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Retry MP4 generation" }),
	).not.toBeInTheDocument();
	expect(screen.getByText(/Operator access/)).toBeInTheDocument();
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("uses a new key when the immutable current revision changes after an uncertain retry", async () => {
	const value = project();
	value.renders = [run("FAILED")];
	const bodies: Array<{ revisionId: string; requestKey: string }> = [];
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			bodies.push(JSON.parse(String(init.body)));
			throw new TypeError("unknown");
		}
		return value;
	});
	const view = renderWithQuery(<PortraitResult id={editingIds.project} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Retry MP4 generation" }),
	);
	await screen.findByRole("alert");
	const nextRevision = "99999999-9999-4999-8999-999999999999";
	await act(async () => {
		view.client.setQueryData(["library-edit", editingIds.project], {
			...value,
			currentRevisionId: nextRevision,
		});
	});
	expect(await screen.findByText(/earlier edit/)).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Retry MP4 generation" }));
	await waitFor(() => expect(bodies).toHaveLength(2));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Retry MP4 generation" }),
		).toBeEnabled(),
	);
	expect(bodies[1]?.revisionId).toBe(nextRevision);
	expect(bodies[1]?.requestKey).not.toBe(bodies[0]?.requestKey);
});

it("discovers an accepted export by polling after the retry response is unknown", async () => {
	const value = project();
	value.renders = [run("FAILED")];
	const bodies: Array<{ requestKey: string }> = [];
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			bodies.push(body);
			value.renders = [
				{ ...run("QUEUED", bodies.length + 1), requestKey: body.requestKey },
			];
			if (bodies.length === 1) throw new TypeError("lost response");
			return value.renders[0];
		}
		return structuredClone(value);
	});
	const view = renderWithQuery(<PortraitResult id={editingIds.project} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Retry MP4 generation" }),
	);
	await screen.findByRole("alert");
	expect(await screen.findByText("Queued")).toBeInTheDocument();
	await waitFor(() =>
		expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
	);
	expect(
		screen.getByRole("button", { name: "Retry MP4 generation" }),
	).toBeDisabled();
	value.renders = [
		{ ...run("SUCCEEDED", 2), requestKey: bodies[0]?.requestKey },
	];
	await act(async () => {
		await view.client.invalidateQueries({
			queryKey: ["library-edit", editingIds.project],
		});
	});
	await screen.findByRole("link", { name: "Download MP4" });
	fireEvent.click(screen.getByRole("button", { name: "Retry MP4 generation" }));
	await waitFor(() => expect(bodies).toHaveLength(2));
	expect(bodies[1]?.requestKey).not.toBe(bodies[0]?.requestKey);
});

it("labels fixture-authored metadata without describing it as provider analysis", async () => {
	const value = project();
	apiFetch.mockResolvedValue(value);
	const view = renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(
		await screen.findByText(en.editing.autoPortrait.fixtureMetadata),
	).toBeInTheDocument();
	const automatic = value.draft.autoGeneration;
	if (!automatic) throw new Error("fixture metadata missing");
	automatic.binding.kind = "CAPTURED_INPUT";
	apiFetch.mockResolvedValue(structuredClone(value));
	await act(async () => {
		await view.client.invalidateQueries({
			queryKey: ["library-edit", editingIds.project],
		});
	});
	await waitFor(() =>
		expect(
			screen.queryByText(en.editing.autoPortrait.fixtureMetadata),
		).not.toBeInTheDocument(),
	);
});

it("keeps an observed matching request acknowledged when its POST fails later", async () => {
	const value = project();
	value.renders = [run("FAILED")];
	let reject!: (reason: unknown) => void;
	let requestKey = "";
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			requestKey = JSON.parse(String(init.body)).requestKey;
			return new Promise((_resolve, fail) => {
				reject = fail;
			});
		}
		return structuredClone(value);
	});
	const view = renderWithQuery(<PortraitResult id={editingIds.project} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Retry MP4 generation" }),
	);
	value.renders = [{ ...run("QUEUED", 2), requestKey }];
	await act(async () => {
		view.client.setQueryData(
			["library-edit", editingIds.project],
			structuredClone(value),
		);
	});
	await screen.findByText("Queued");
	await act(async () => reject(new TypeError("late lost response")));
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Retry MP4 generation" }),
	).toBeDisabled();
});

it("announces read and parse failures with a safe refresh action", async () => {
	apiFetch.mockResolvedValue(null);
	renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"operation failed",
	);
	apiFetch.mockResolvedValue(project());
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	expect(await screen.findByText("Waiting for an export.")).toBeInTheDocument();
});

it("does not show malformed successful runs as playable and reports native playback errors", async () => {
	const value = project();
	value.renders = [{ ...run("SUCCEEDED"), artifact: null }];
	apiFetch.mockResolvedValue(value);
	const view = renderWithQuery(<PortraitResult id={editingIds.project} />);
	expect(await screen.findByText(/video is unavailable/)).toBeInTheDocument();
	apiFetch.mockResolvedValue({ ...value, renders: [run("SUCCEEDED")] });
	await act(async () => {
		await view.client.invalidateQueries({
			queryKey: ["library-edit", editingIds.project],
		});
	});
	fireEvent.error(await screen.findByLabelText("Portrait video result"));
	expect(screen.getByRole("alert")).toHaveTextContent(
		"video could not be played",
	);
	const failedVideo = screen.getByLabelText("Portrait video result");
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
	);
	expect(screen.getByLabelText("Portrait video result")).not.toBe(failedVideo);
});
