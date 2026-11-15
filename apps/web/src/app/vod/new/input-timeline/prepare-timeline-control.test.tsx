import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PrepareTimelineControl } from "./prepare-timeline-control";
import { credentialId, facts, previewTask, taskId } from "./test-fixtures";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
const document = {
	schemaVersion: 2 as const,
	id: taskId,
	durationMs: 1000,
	audioEnabled: true,
	videoClips: [
		{ id: taskId, sourceKey: "a", startMs: 0, inMs: 0, outMs: 1000 },
	],
	audioClips: [
		{ id: taskId, sourceKey: "b", startMs: 0, inMs: 0, outMs: 1000 },
	],
};
const output = { credentialId, bucket: "output", prefix: "edits/" };
const prepared = previewTask({
	kind: "TIMELINE_PREPARE",
	result: {
		preparation: {
			source: {
				key: "prepared",
				credentialId,
				bucket: "output",
				objectKey: "owned.mp4",
			},
			facts: { ...facts[0], key: "prepared" },
			durationMs: 1000,
			sha256: "a".repeat(64),
			profile: "H264_CRF12_AAC320_SDR8_V1",
		},
	},
});
beforeEach(() => {
	apiFetch.mockReset();
});
afterEach(cleanup);

it("starts only on request and invalidates a completed preparation when editing changes", async () => {
	apiFetch.mockResolvedValue({ task: prepared });
	const onChange = vi.fn();
	const props = {
		document,
		output,
		probeId: taskId,
		preparationKey: "original",
		ready: true,
		disabled: false,
		onChange,
	};
	const { rerender } = renderLocalized(<PrepareTimelineControl {...props} />);
	expect(apiFetch).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Prepare encoding input" }),
	);
	await waitFor(() =>
		expect(onChange).toHaveBeenLastCalledWith({
			key: "original",
			task: prepared,
		}),
	);
	const firstCall = apiFetch.mock.calls[0];
	if (!firstCall) throw new Error("Expected preparation submission");
	expect(JSON.parse(firstCall[1].body)).toEqual({
		kind: "TIMELINE_PREPARE",
		probeId: taskId,
		document,
		output,
	});
	rerender(
		<PrepareTimelineControl
			{...props}
			preparationKey="edited"
			document={{ ...document, durationMs: 1100 }}
		/>,
	);
	await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
	expect(
		screen.getByRole("button", { name: "Prepare encoding input" }),
	).toBeEnabled();
	expect(apiFetch).toHaveBeenCalledTimes(1);
});

it("cancels the durable task when the user cancels preparation", async () => {
	apiFetch.mockResolvedValue({
		task: { ...prepared, status: "RUNNING", result: undefined },
	});
	renderLocalized(
		<PrepareTimelineControl
			document={document}
			output={output}
			probeId={taskId}
			preparationKey="test"
			ready
			disabled={false}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Prepare encoding input" }),
	);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/vod/input-previews/${prepared.id}`,
			{ method: "DELETE" },
		),
	);
});

it.each([
	"cancel",
	"unmount",
])("cancels a task whose create response arrives after %s", async (action) => {
	let completeCreate: (() => void) | undefined;
	let creationSignal: AbortSignal | undefined;
	apiFetch.mockImplementation((_url, init) => {
		if (init?.method !== "POST") return Promise.resolve(undefined);
		creationSignal = init.signal;
		return new Promise((resolve, reject) => {
			completeCreate = () =>
				resolve({
					task: { ...prepared, status: "RUNNING", result: undefined },
				});
			init.signal?.addEventListener("abort", () =>
				reject(new DOMException("Aborted", "AbortError")),
			);
		});
	});
	const onChange = vi.fn();
	const { unmount } = renderLocalized(
		<PrepareTimelineControl
			document={document}
			output={output}
			probeId={taskId}
			preparationKey="deferred-create"
			ready
			disabled={false}
			onChange={onChange}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Prepare encoding input" }),
	);
	await waitFor(() => expect(completeCreate).toBeDefined());
	if (action === "cancel")
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	else unmount();
	expect(creationSignal?.aborted ?? false).toBe(false);
	await act(async () => completeCreate?.());
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/vod/input-previews/${prepared.id}`,
			{ method: "DELETE" },
		),
	);
	expect(onChange).not.toHaveBeenCalledWith(
		expect.objectContaining({ task: expect.anything() }),
	);
});

it("blocks over-one-hour preparation with a concrete limit before any request", () => {
	renderLocalized(
		<PrepareTimelineControl
			document={{ ...document, durationMs: 3_600_001 }}
			output={output}
			probeId={taskId}
			preparationKey="long"
			ready
			disabled={false}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "Prepare encoding input" }),
	).toBeDisabled();
	expect(screen.getByRole("status")).toHaveTextContent("up to one hour");
	expect(apiFetch).not.toHaveBeenCalled();
});

it("explains unsupported color/depth in Japanese and keeps the long quality note folded", async () => {
	apiFetch.mockResolvedValue({
		task: {
			...prepared,
			status: "FAILED",
			result: undefined,
			error: { code: "PREPARATION_SOURCE_UNSUPPORTED", message: "unsupported" },
		},
	});
	renderLocalized(
		<PrepareTimelineControl
			document={document}
			output={output}
			probeId={taskId}
			preparationKey="test"
			ready
			disabled={false}
		/>,
		"ja",
	);
	fireEvent.click(
		screen.getByRole("button", { name: "エンコード用素材を準備" }),
	);
	await waitFor(() =>
		expect(screen.getByRole("status")).toHaveTextContent("8bit・BT.709 SDR"),
	);
	expect(screen.getByText("準備の仕様").closest("details")).not.toHaveAttribute(
		"open",
	);
});
