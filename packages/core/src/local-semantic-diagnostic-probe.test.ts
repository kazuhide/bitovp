import { describe, expect, it, vi } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "./content-editing/local-semantic-protocol";
import { localSemanticStageRegistry } from "./content-editing/local-semantic-stages";
import { localSemanticCombinedStageRegistry } from "./content-editing/local-story-flow-stages";
import * as probe from "./local-semantic-diagnostic-probe";

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
	version: "bitovp-semantic-readiness-v1",
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

describe("FLOW exact six-stage metadata probe", () => {
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
