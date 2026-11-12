import type { VodInputPreviewRequest } from "@bitovp/core/vod-input-timeline";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { previewTask, taskB, taskId, timeline } from "./test-fixtures";
import { usePreviewTask } from "./use-preview-task";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
const request = (startMs = 0): VodInputPreviewRequest => ({
	kind: "PREVIEW",
	probeId: taskId,
	document: timeline(),
	range: { startMs, durationMs: 25_000 },
});

it("never adopts an old completion after a newer edit even if abort was ignored", async () => {
	let oldResolve: ((value: unknown) => void) | undefined;
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const body = JSON.parse(String(init?.body));
		if (body.range.startMs === 0)
			return new Promise((resolve) => {
				oldResolve = resolve;
			});
		return Promise.resolve({
			task: previewTask({
				id: taskB,
				result: {
					preview: {
						startMs: 10_000,
						durationMs: 25_000,
						size: 1024,
						sha256: "b".repeat(64),
					},
				},
			}),
		});
	});
	const { result, rerender } = renderHook(
		({ value }) => usePreviewTask(value, { debounceMs: 0 }),
		{ initialProps: { value: request() } },
	);
	await waitFor(() => expect(oldResolve).toBeDefined());
	rerender({ value: request(10_000) });
	await waitFor(() => expect(result.current.ready?.id).toBe(taskB));
	await act(async () => oldResolve?.({ task: previewTask() }));
	expect(result.current.ready?.id).toBe(taskB);
});

it("retains a prior video as stale while the current request is running", async () => {
	vi.mocked(apiFetch).mockResolvedValue({ task: previewTask() });
	const { result, rerender } = renderHook(
		({ value }) => usePreviewTask(value, { debounceMs: 0, pollMs: 60_000 }),
		{ initialProps: { value: request() } },
	);
	await waitFor(() => expect(result.current.ready?.id).toBe(taskId));
	vi.mocked(apiFetch).mockResolvedValue({
		task: previewTask({ id: taskB, status: "RUNNING", result: undefined }),
	});
	rerender({ value: request(10_000) });
	await waitFor(() => expect(result.current.task?.status).toBe("RUNNING"));
	expect(result.current.ready).toBeNull();
	expect(result.current.previous?.id).toBe(taskId);
	expect(result.current.stale).toBe(true);
});

it("rejects expired and malformed success responses", async () => {
	vi.mocked(apiFetch).mockResolvedValue({
		task: previewTask({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
	});
	const { result } = renderHook(() =>
		usePreviewTask(request(), { debounceMs: 0 }),
	);
	await waitFor(() => expect(result.current.error).toBe("expired"));
	expect(result.current.ready).toBeNull();
	vi.mocked(apiFetch).mockResolvedValue({ task: { status: "SUCCEEDED" } });
	act(() => result.current.retry());
	await waitFor(() => expect(result.current.error).toBe("invalidResponse"));
	expect(result.current.ready).toBeNull();
});

it("does not delete a completed cached preview when the editor unmounts", async () => {
	vi.mocked(apiFetch).mockResolvedValue({ task: previewTask() });
	const { result, unmount } = renderHook(() =>
		usePreviewTask(request(), { debounceMs: 0 }),
	);
	await waitFor(() => expect(result.current.ready?.id).toBe(taskId));
	unmount();
	expect(
		vi
			.mocked(apiFetch)
			.mock.calls.filter(([, init]) => init?.method === "DELETE"),
	).toHaveLength(0);
});

it("rejects a successful task whose preview window differs from the request", async () => {
	vi.mocked(apiFetch).mockResolvedValue({ task: previewTask() });
	const { result } = renderHook(() =>
		usePreviewTask(request(10_000), { debounceMs: 0 }),
	);
	await waitFor(() => expect(result.current.error).toBe("invalidResponse"));
	expect(result.current.ready).toBeNull();
});
