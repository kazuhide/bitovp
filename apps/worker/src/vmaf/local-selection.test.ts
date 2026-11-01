import { describe, expect, it, vi } from "vitest";
import {
	type NativeLocalSelection,
	resolveLocalSelection,
	type SelectLocalNative,
} from "./local-selection";

const model = "vmaf_v1.0.16_3d0h";
const cuda: NativeLocalSelection = {
	backend: "cuda",
	device: 2,
	identity: {
		sourceSha256: "a".repeat(64),
		binarySha256: "b".repeat(64),
		supervisorBinarySha256: "c".repeat(64),
		deviceUuid: "GPU-first",
	},
};
function request(localMode?: "CPU" | "AUTO") {
	return {
		execution: {
			backend: "LOCAL" as const,
			...(localMode ? { localMode } : {}),
		},
		model,
		gate: false,
		signal: new AbortController().signal,
	};
}
const select = () => vi.fn<SelectLocalNative>(async () => cuda);

describe("job-local processing selection", () => {
	it("keeps omitted LOCAL and CLOUD execution completely outside selection", async () => {
		const selectNative = select();
		expect(
			await resolveLocalSelection({ selectNative }, request()),
		).toBeUndefined();
		expect(
			await resolveLocalSelection(
				{ selectNative },
				{
					...request(),
					execution: {
						backend: "CLOUD",
						profileId: "cloud",
						budgetUsd: 1,
					},
				},
			),
		).toBeUndefined();
		expect(selectNative).not.toHaveBeenCalled();
	});
	it("selects explicit CPU without consulting GPU availability", async () => {
		const selectNative = select();
		expect(
			await resolveLocalSelection({ selectNative }, request("CPU")),
		).toEqual({
			version: 1,
			requested: "CPU",
			model,
			backend: "cpu",
		});
		expect(selectNative).not.toHaveBeenCalled();
	});
	it("pins the selected AUTO GPU and its complete runtime/device identity", async () => {
		const selectNative = select();
		expect(
			await resolveLocalSelection({ selectNative }, request("AUTO")),
		).toEqual({
			version: 1,
			requested: "AUTO",
			model,
			...cuda,
		});
		expect(selectNative).toHaveBeenCalledWith({
			signal: expect.any(AbortSignal),
		});
	});
	it.each([
		["runtime", {}, {}, "GPU_RUNTIME_UNAVAILABLE"],
		[
			"unsupported model",
			{ selectNative: select() },
			{ model: "vmaf_v0.6.1" },
			"GPU_MODEL_UNSUPPORTED",
		],
		["gate", { selectNative: select() }, { gate: true }, "GPU_GATE_CPU_ONLY"],
	])("uses same-model CPU before scoring when %s is ineligible", async (_name, deps, patch, reason) => {
		const input = { ...request("AUTO"), ...patch };
		expect(await resolveLocalSelection(deps, input)).toEqual({
			version: 1,
			requested: "AUTO",
			model: input.model,
			backend: "cpu",
			reason,
		});
		if ("selectNative" in deps)
			expect(deps.selectNative).not.toHaveBeenCalled();
	});
	it("records a positive no-GPU result without changing the requested model", async () => {
		expect(
			await resolveLocalSelection(
				{
					selectNative: async () => ({
						backend: "cpu",
						reason: "GPU_NOT_AVAILABLE",
					}),
				},
				request("AUTO"),
			),
		).toEqual({
			version: 1,
			requested: "AUTO",
			model,
			backend: "cpu",
			reason: "GPU_NOT_AVAILABLE",
		});
	});
	it("resumes a pinned CPU result even when a GPU is now available", async () => {
		const selectNative = select();
		const stored = {
			version: 1,
			requested: "AUTO",
			model,
			backend: "cpu",
			reason: "GPU_NOT_AVAILABLE",
		};
		expect(
			await resolveLocalSelection(
				{ selectNative },
				{ ...request("AUTO"), stored },
			),
		).toEqual(stored);
		expect(selectNative).not.toHaveBeenCalled();
	});
	it("rechecks precisely the pinned GPU on resume", async () => {
		const selectNative = select();
		const stored = { version: 1, requested: "AUTO", model, ...cuda };
		expect(
			await resolveLocalSelection(
				{ selectNative },
				{ ...request("AUTO"), stored },
			),
		).toEqual(stored);
		expect(selectNative).toHaveBeenCalledWith({
			signal: expect.any(AbortSignal),
			pinned: cuda,
		});
	});
	it.each([
		["missing runtime", {}],
		[
			"missing device",
			{
				selectNative: async () => ({
					backend: "cpu",
					reason: "GPU_NOT_AVAILABLE",
				}),
			},
		],
		[
			"different backend",
			{ selectNative: async () => ({ ...cuda, backend: "vulkan" }) },
		],
		["different index", { selectNative: async () => ({ ...cuda, device: 3 }) }],
		[
			"different source",
			{
				selectNative: async () => ({
					...cuda,
					identity: { ...cuda.identity, sourceSha256: "d".repeat(64) },
				}),
			},
		],
		[
			"different binary",
			{
				selectNative: async () => ({
					...cuda,
					identity: { ...cuda.identity, binarySha256: "d".repeat(64) },
				}),
			},
		],
		[
			"different supervisor",
			{
				selectNative: async () => ({
					...cuda,
					identity: {
						...cuda.identity,
						supervisorBinarySha256: "d".repeat(64),
					},
				}),
			},
		],
		[
			"different UUID",
			{
				selectNative: async () => ({
					...cuda,
					identity: { ...cuda.identity, deviceUuid: "GPU-other" },
				}),
			},
		],
	])("refuses to replace a pinned GPU after %s", async (_name, deps) => {
		await expect(
			resolveLocalSelection(deps as { selectNative?: SelectLocalNative }, {
				...request("AUTO"),
				stored: { version: 1, requested: "AUTO", model, ...cuda },
			}),
		).rejects.toThrow();
	});
	it.each([
		{ version: 1, requested: "CPU", model, backend: "cpu" },
		{
			version: 1,
			requested: "AUTO",
			model: "vmaf_v1.0.16_5d0h",
			backend: "cpu",
			reason: "GPU_NOT_AVAILABLE",
		},
		{ version: 1, requested: "AUTO", model, backend: "cuda", device: 2 },
	])("rejects incompatible or incomplete stored selection", async (stored) => {
		await expect(
			resolveLocalSelection(
				{ selectNative: select() },
				{ ...request("AUTO"), stored },
			),
		).rejects.toThrow();
	});
	it("rejects dropping the requested mode from an already selected row", async () => {
		await expect(
			resolveLocalSelection(
				{},
				{
					...request(),
					stored: {
						version: 1,
						requested: "CPU",
						model,
						backend: "cpu",
					},
				},
			),
		).rejects.toThrow("VMAF_LOCAL_SELECTION_CHANGED");
	});
	it("does not swallow cancellation or a native validation failure", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const selectNative = select();
		await expect(
			resolveLocalSelection(
				{ selectNative },
				{ ...request("AUTO"), signal: controller.signal },
			),
		).rejects.toThrow("cancelled");
		expect(selectNative).not.toHaveBeenCalled();
		await expect(
			resolveLocalSelection(
				{
					selectNative: async () => {
						throw new Error("NATIVE_DEVICE_INFO_INVALID_JSON");
					},
				},
				request("AUTO"),
			),
		).rejects.toThrow("NATIVE_DEVICE_INFO_INVALID_JSON");
	});
	it("rejects a known invalid startup runtime instead of using CPU", async () => {
		await expect(
			resolveLocalSelection(
				{ nativeFailure: new Error("VMAF_SUPERVISOR_IDENTITY_MISMATCH") },
				request("AUTO"),
			),
		).rejects.toThrow("VMAF_SUPERVISOR_IDENTITY_MISMATCH");
	});
});

it.each([
	[{ gate: true }, "GPU_GATE_CPU_ONLY"],
	[{ model: "vmaf_v0.6.1" }, "GPU_MODEL_UNSUPPORTED"],
])("keeps known CPU-only AUTO policies independent of unrelated invalid native preflight", async (patch, reason) => {
	const selectNative = select();
	expect(
		await resolveLocalSelection(
			{ selectNative, nativeFailure: new Error("invalid optional pair") },
			{ ...request("AUTO"), ...patch },
		),
	).toMatchObject({ backend: "cpu", reason });
	expect(selectNative).not.toHaveBeenCalled();
});
it("does not accept a selection resolved after cancellation", async () => {
	const controller = new AbortController();
	await expect(
		resolveLocalSelection(
			{
				selectNative: async () => {
					controller.abort(new Error("cancelled"));
					return cuda;
				},
			},
			{ ...request("AUTO"), signal: controller.signal },
		),
	).rejects.toThrow("cancelled");
});
it("rejects non-string persisted reason values", async () => {
	await expect(
		resolveLocalSelection(
			{},
			{
				...request("AUTO"),
				stored: {
					version: 1,
					requested: "AUTO",
					model,
					backend: "cpu",
					reason: ["GPU_NOT_AVAILABLE"],
				},
			},
		),
	).rejects.toThrow("VMAF_LOCAL_SELECTION_INVALID");
});
