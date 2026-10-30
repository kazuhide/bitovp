import { describe, expect, it } from "vitest";
import {
	localVmafExecutionOf,
	localVmafExecutionSchema,
} from "./local-execution";

const cpu = {
	version: 1,
	requestedDecode: "auto",
	device: 0,
	decode: {
		reference: { backend: "cuda" },
		distorted: { backend: "cpu", reason: "CUDA_UNSUPPORTED_CODEC" },
	},
	scoring: {
		backend: "cpu",
		implementation: "libvmaf",
		model: "vmaf_v1.0.16_3d0h",
	},
	attempts: 1,
};
const gpu = {
	...cpu,
	scoring: {
		backend: "cuda",
		implementation: "vmafx",
		model: "vmaf_v1.0.16_3d0h",
		modelSha256: "a".repeat(64),
		features: ["adm_cuda", "vif_cuda", "motion_cuda", "cambi_cuda"],
		bitDepth: 10,
		distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
		revision: "b".repeat(40),
	},
};

describe("public local VMAF execution", () => {
	it("accepts default CPU execution without inventing a GPU device", () => {
		const execution = {
			version: 1,
			requestedDecode: "cpu",
			decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
			scoring: cpu.scoring,
			attempts: 1,
		};
		expect(localVmafExecutionSchema.parse(execution)).toEqual(execution);
	});

	it("distinguishes hardware decoding from CPU feature extraction", () => {
		expect(localVmafExecutionSchema.parse(cpu)).toEqual(cpu);
	});

	it("retains CUDA implementation, exact model hash, feature names and bit depth", () => {
		expect(localVmafExecutionSchema.parse(gpu)).toEqual(gpu);
	});

	it("accepts one CPU retry with a fixed fallback reason", () => {
		const retried = {
			...cpu,
			attempts: 2,
			fallbackReason: "CUDA_RUNTIME_UNAVAILABLE",
		};
		expect(localVmafExecutionSchema.parse(retried)).toEqual(retried);
	});

	it("projects only the validated execution block from private provenance", () => {
		expect(
			localVmafExecutionOf({
				reference: { path: "/private/input.mp4", key: "secret" },
				stderr: "private diagnostic",
				localExecution: cpu,
			}),
		).toEqual(cpu);
	});

	it.each([
		null,
		undefined,
		1,
		[],
		{},
		{ localExecution: null },
		{ localExecution: [] },
	])("omits missing and historical values: %j", (value) =>
		expect(localVmafExecutionOf(value)).toBeUndefined());

	it.each([
		{ ...cpu, version: 2 },
		{ ...cpu, attempts: 0 },
		{ ...cpu, attempts: 3 },
		{ ...cpu, device: -1 },
		{ ...cpu, device: 0.5 },
		{ ...cpu, device: Number.NaN },
		{ ...cpu, requestedDecode: "gpu" },
		{ ...cpu, stderr: "private diagnostic" },
		{ ...cpu, path: "/private/input.mp4" },
		{ ...cpu, fallbackReason: "/private/file" },
		{ ...cpu, fallbackReason: "cuda error detail" },
		{
			...cpu,
			decode: {
				...cpu.decode,
				reference: { backend: "cpu", path: "input.mp4" },
			},
		},
		{
			...cpu,
			decode: {
				...cpu.decode,
				distorted: { backend: "cpu", reason: "https://secret.example" },
			},
		},
		{ ...cpu, scoring: { ...cpu.scoring, implementation: "vmafx" } },
		{ ...cpu, scoring: { ...cpu.scoring, model: "../models/private.json" } },
		{ ...cpu, scoring: { ...cpu.scoring, model: "/private/model.json" } },
		{ ...cpu, scoring: { ...cpu.scoring, model: "C:\\private\\model.json" } },
		{ ...cpu, scoring: { ...cpu.scoring, model: "." } },
		{ ...cpu, scoring: { ...cpu.scoring, modelPath: "/private/model.json" } },
		{ ...gpu, scoring: { ...gpu.scoring, implementation: "libvmaf" } },
		{ ...gpu, scoring: { ...gpu.scoring, modelSha256: "bad" } },
		{ ...gpu, scoring: { ...gpu.scoring, revision: "../private-revision" } },
		{ ...gpu, scoring: { ...gpu.scoring, features: ["/private/feature"] } },
		{ ...gpu, scoring: { ...gpu.scoring, features: ["stderr detail"] } },
		{ ...gpu, scoring: { ...gpu.scoring, bitDepth: 8 } },
	])("rejects invalid or private execution metadata: %j", (execution) => {
		expect(localVmafExecutionSchema.safeParse(execution).success).toBe(false);
		expect(localVmafExecutionOf({ localExecution: execution })).toBeUndefined();
	});
});
