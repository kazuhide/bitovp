import { describe, expect, it, vi } from "vitest";
import { resolveBandingSelection } from "./local-selection";

const gpu = {
	backend: "cuda" as const,
	device: 0,
	identity: {
		sourceSha256: "a".repeat(64),
		binarySha256: "b".repeat(64),
		supervisorBinarySha256: "c".repeat(64),
		deviceUuid: "gpu-id",
	},
};
const signal = new AbortController().signal;

describe("banding metric backend selection", () => {
	it("defaults to CPU without requiring a VMAF model", async () => {
		const selectNative = vi.fn();
		expect(
			await resolveBandingSelection(
				{ selectNative },
				{ execution: { backend: "LOCAL" }, signal },
			),
		).toEqual({ version: 1, model: "CAMBI", requested: "CPU", backend: "cpu" });
		expect(selectNative).not.toHaveBeenCalled();
	});

	it("allows actual GPU CAMBI with CPU-reference decisions even for delivery QC", async () => {
		const selected = await resolveBandingSelection(
			{ selectNative: async () => gpu, available: async () => true },
			{ execution: { backend: "LOCAL", localMode: "AUTO" }, signal },
		);
		expect(selected).toMatchObject({
			requested: "AUTO",
			model: "CAMBI",
			...gpu,
		});
	});

	it("falls back only for unsupported capabilities before scoring and pins that fallback", async () => {
		const selection = await resolveBandingSelection(
			{ selectNative: async () => gpu, available: async () => false },
			{ execution: { backend: "LOCAL", localMode: "AUTO" }, signal },
		);
		expect(selection).toMatchObject({
			backend: "cpu",
			reason: "GPU_RUNTIME_UNAVAILABLE",
		});
		const selectNative = vi.fn();
		expect(
			await resolveBandingSelection(
				{ selectNative },
				{
					execution: { backend: "LOCAL", localMode: "AUTO" },
					stored: selection,
					signal,
				},
			),
		).toEqual(selection);
		expect(selectNative).not.toHaveBeenCalled();
	});

	it("does not hide invalid runtime identity or an unavailable pinned GPU", async () => {
		await expect(
			resolveBandingSelection(
				{
					selectNative: async () => gpu,
					available: async () => {
						throw new Error("BANDING_CAPABILITY_BUILD_MISMATCH");
					},
				},
				{ execution: { backend: "LOCAL", localMode: "AUTO" }, signal },
			),
		).rejects.toThrow("BANDING_CAPABILITY_BUILD_MISMATCH");
		await expect(
			resolveBandingSelection(
				{ selectNative: async () => gpu, available: async () => false },
				{
					execution: { backend: "LOCAL", localMode: "AUTO" },
					stored: { version: 1, model: "CAMBI", requested: "AUTO", ...gpu },
					signal,
				},
			),
		).rejects.toThrow("BANDING_LOCAL_SELECTION_UNAVAILABLE");
	});

	it("rejects a VMAF-specific fallback reason in the independent banding snapshot", async () => {
		await expect(
			resolveBandingSelection(
				{},
				{
					execution: { backend: "LOCAL", localMode: "AUTO" },
					signal,
					stored: {
						version: 1,
						model: "CAMBI",
						requested: "AUTO",
						backend: "cpu",
						reason: "GPU_GATE_CPU_ONLY",
					},
				},
			),
		).rejects.toThrow("BANDING_LOCAL_SELECTION_INVALID");
	});
});
