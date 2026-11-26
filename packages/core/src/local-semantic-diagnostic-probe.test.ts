import { describe, expect, it, vi } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "./content-editing/local-semantic-protocol";
import { summarizeClipEditingAvailability } from "./content-editing/local-semantic-readiness";
import { localSemanticStageRegistry } from "./content-editing/local-semantic-stages";
import { localSemanticCombinedStageRegistry } from "./content-editing/local-story-flow-stages";
import * as probe from "./local-semantic-diagnostic-probe";

const organizationId = "22222222-2222-4222-8222-222222222222";
const config = {
	url: "https://fixture.invalid/",
	token: "a".repeat(48),
	caFile: "/fixture/ca",
	profile: "nvidia" as const,
	configId: "11111111-1111-4111-8111-111111111111",
};
const rows = (flow: boolean) =>
	Object.entries(
		(flow ? localSemanticCombinedStageRegistry() : localSemanticStageRegistry())
			.stages,
	).map(([stage, { schema: _schema, ...definition }]) => ({
		stage,
		...definition,
	}));
const health = (stages = rows(true)) => ({
	version: "bitovp-semantic-gateway-v1",
	runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
	model: LOCAL_SEMANTIC_MODEL,
	modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
	profiles: ["amd", "nvidia"],
	stages,
});
const readiness = {
	version: "bitovp-semantic-readiness-v2",
	organizationId,
	profile: "nvidia",
	scope: "METADATA_ONLY",
	ready: true,
	code: "READY",
	gpu: {
		version: "bitovp-runtime-gpu-capability-v1",
		profile: "nvidia",
		method: "OLLAMA_NATIVE_DISCOVERY",
		backend: "CUDA",
		observedAt: Date.now(),
	},
};
const reader = (value = health()) =>
	vi.fn(async (_config: unknown, path: string) =>
		path === "/health" ? value : readiness,
	);

describe("passive GPU device-access metadata", () => {
	it.each([
		["nvidia", "CUDA"],
		["amd", "ROCm"],
	] as const)("accepts fresh %s access without claiming native discovery", async (profile, backend) => {
		const observedAt = Date.now() - 1_000;
		const read = vi.fn(async (_config: unknown, path: string) =>
			path === "/health"
				? health()
				: {
						...readiness,
						profile,
						gpu: {
							...readiness.gpu,
							method: "PASSIVE_DEVICE_ACCESS",
							profile,
							backend,
							observedAt,
						},
					},
		);
		const result = await probe.probeLocalClipGateway(
			{ ...config, profile },
			read,
		);
		expect(result).toEqual({
			scope: "METADATA_ONLY",
			code: "READY",
			gpuObservedAt: observedAt,
			authorizedOrganizationId: organizationId,
		});
		expect(read.mock.calls.map((call) => call[1])).toEqual([
			"/health",
			`/readiness/${profile}`,
		]);
		const hash = "a".repeat(64);
		const heartbeat = {
			version: "local-semantic-worker-v1",
			connectionHash: hash,
			instanceId: config.configId,
			profile,
			state: "READY",
			observedAt: Date.now(),
			clipAvailability: {
				version: "local-clip-availability-v2",
				checkedAt: result.gpuObservedAt,
				code: result.code,
				authorizedOrganizationId: result.authorizedOrganizationId,
			},
		};
		expect(
			summarizeClipEditingAvailability(
				[heartbeat],
				hash,
				profile,
				Date.now(),
				organizationId,
			),
		).toBe(true);
		expect(
			summarizeClipEditingAvailability(
				[heartbeat],
				hash,
				profile,
				Date.now(),
				"33333333-3333-4333-8333-333333333333",
			),
		).toBe(false);
		expect(
			summarizeClipEditingAvailability(
				[heartbeat],
				hash,
				profile,
				observedAt + 15_001,
				organizationId,
			),
		).toBe(false);
	});

	it.each([
		["missing proof", undefined, "GPU_UNVERIFIED"],
		["another profile", { profile: "amd" }, "GPU_UNVERIFIED"],
		["another backend", { backend: "ROCm" }, "GPU_UNVERIFIED"],
		["old observation", { observedAt: 84_999 }, "GPU_UNVERIFIED"],
		["future observation", { observedAt: 105_001 }, "GPU_UNVERIFIED"],
		["unknown method", { method: "CACHED_NATIVE_RESULT" }, "INVALID_RESPONSE"],
		["CPU backend", { backend: "CPU" }, "INVALID_RESPONSE"],
	] as const)("rejects passive %s without upgrading its evidence", async (_label, changes, code) => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
		try {
			const read = vi.fn(async (_config: unknown, path: string) =>
				path === "/health"
					? health()
					: {
							...readiness,
							gpu:
								changes === undefined
									? undefined
									: {
											...readiness.gpu,
											method: "PASSIVE_DEVICE_ACCESS",
											observedAt: 100_000,
											...changes,
										},
						},
			);
			await expect(probe.probeLocalClipGateway(config, read)).resolves.toEqual({
				scope: "METADATA_ONLY",
				code,
				gpuObservedAt: undefined,
				authorizedOrganizationId: undefined,
			});
		} finally {
			clock.mockRestore();
		}
	});

	it.each([
		undefined,
		"not-a-tenant",
	])("rejects passive readiness with invalid tenant %s", async (organizationId) => {
		const read = vi.fn(async (_config: unknown, path: string) =>
			path === "/health"
				? health()
				: {
						...readiness,
						organizationId,
						gpu: {
							...readiness.gpu,
							method: "PASSIVE_DEVICE_ACCESS",
							observedAt: Date.now(),
						},
					},
		);
		await expect(probe.probeLocalClipGateway(config, read)).resolves.toEqual({
			scope: "METADATA_ONLY",
			code: "INVALID_RESPONSE",
			gpuObservedAt: undefined,
			authorizedOrganizationId: undefined,
		});
	});

	it("does not publish passive success from a GPU_UNVERIFIED response", async () => {
		const read = vi.fn(async (_config: unknown, path: string) =>
			path === "/health"
				? health()
				: {
						...readiness,
						ready: false,
						code: "GPU_UNVERIFIED",
						gpu: {
							...readiness.gpu,
							method: "PASSIVE_DEVICE_ACCESS",
							observedAt: Date.now(),
						},
					},
		);
		await expect(probe.probeLocalClipGateway(config, read)).resolves.toEqual({
			scope: "METADATA_ONLY",
			code: "GPU_UNVERIFIED",
			gpuObservedAt: undefined,
			authorizedOrganizationId: undefined,
		});
	});
});

describe("FLOW exact six-stage metadata probe", () => {
	it("attests the token-authorized organization only from authenticated readiness metadata", async () => {
		await expect(
			probe.probeLocalClipGateway(config, reader()),
		).resolves.toMatchObject({
			code: "READY",
			gpuObservedAt: readiness.gpu.observedAt,
			authorizedOrganizationId: organizationId,
		});
		const oldRead = vi.fn(async (_config: unknown, path: string) =>
			path === "/health"
				? health()
				: {
						...readiness,
						version: "bitovp-semantic-readiness-v1",
						organizationId: undefined,
					},
		);
		await expect(
			probe.probeLocalClipGateway(config, oldRead),
		).resolves.toMatchObject({ code: "INVALID_RESPONSE" });
	});
	it.each([
		undefined,
		{
			version: "bitovp-runtime-gpu-capability-v1",
			profile: "amd",
			method: "OLLAMA_NATIVE_DISCOVERY",
			backend: "ROCm",
			observedAt: Date.now(),
		},
		{
			version: "bitovp-runtime-gpu-capability-v1",
			profile: "nvidia",
			method: "OLLAMA_NATIVE_DISCOVERY",
			backend: "ROCm",
			observedAt: Date.now(),
		},
		{
			version: "bitovp-runtime-gpu-capability-v1",
			profile: "nvidia",
			method: "OLLAMA_NATIVE_DISCOVERY",
			backend: "CUDA",
			observedAt: Date.now() - 15_001,
		},
	])("rejects old config-only readiness or unbound GPU metadata %#", async (gpu) => {
		const read = vi.fn(async (_config: unknown, path: string) =>
			path === "/health" ? health() : { ...readiness, gpu },
		);
		await expect(
			probe.probeLocalSemanticGateway(config, read),
		).resolves.toMatchObject({ code: "GPU_UNVERIFIED" });
	});
	it("adds a named six-stage probe while keeping legacy four-stage behavior", async () => {
		const read = reader();
		await expect(
			probe.probeLocalStoryFlowGateway(config, read),
		).resolves.toEqual({ scope: "METADATA_ONLY", code: "READY" });
		expect(read.mock.calls.map((c) => c[1])).toEqual([
			"/health",
			"/readiness/nvidia",
		]);
		await expect(
			probe.probeLocalSemanticGateway(config, reader(health(rows(false)))),
		).resolves.toMatchObject({ code: "READY" });
		await expect(
			probe.probeLocalSemanticGateway(config, reader()),
		).resolves.toMatchObject({ code: "READY" });
		await expect(
			probe.probeLocalStoryFlowGateway(config, reader(health(rows(false)))),
		).resolves.toMatchObject({ code: "GATEWAY_VERSION_MISMATCH" });
	});
	it("rejects missing, duplicate, unknown, mismatched-version, schema or token rows before readiness", async () => {
		const definitions = rows(true);
		const first = definitions[0];
		if (!first) throw new Error("Missing authored registry entry");
		for (const stages of [
			definitions.slice(1),
			[...definitions, first],
			[...definitions, { ...first, stage: "UNKNOWN" }],
			[...definitions.slice(1), { ...first, stage: "UNKNOWN" }],
			[{ ...first, promptVersion: "wrong" }, ...definitions.slice(1)],
			[{ ...first, schemaHash: "f".repeat(64) }, ...definitions.slice(1)],
			[{ ...first, maxOutputTokens: 1 }, ...definitions.slice(1)],
		]) {
			const read = reader(health(stages));
			await expect(
				probe.probeLocalStoryFlowGateway(config, read),
			).resolves.toMatchObject({ code: "GATEWAY_VERSION_MISMATCH" });
			expect(read).toHaveBeenCalledTimes(1);
		}
	});
	it("retains model/profile and sanitized error checks without native or POST access", async () => {
		await expect(
			probe.probeLocalStoryFlowGateway(
				config,
				reader({ ...health(), model: "other" }),
			),
		).resolves.toMatchObject({ code: "GATEWAY_VERSION_MISMATCH" });
		await expect(
			probe.probeLocalStoryFlowGateway(
				config,
				reader({ ...health(), profiles: ["amd"] }),
			),
		).resolves.toMatchObject({ code: "GATEWAY_VERSION_MISMATCH" });
		const read = vi.fn(async () => {
			throw new Error("private-token-sentinel");
		});
		await expect(
			probe.probeLocalStoryFlowGateway(config, read),
		).resolves.toEqual({ scope: "METADATA_ONLY", code: "CONNECTION_FAILED" });
	});
});
