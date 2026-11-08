import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
	localPlamoCaptionIdentityForManifest,
	localSemanticStageRegistry,
	PLAMO_CAPTION_TEMPLATE_HASH,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import {
	diagnoseLocalSemanticReadiness,
	probeLocalSemanticGateway,
} from "./local-semantic-readiness";

const env = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/private-ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
const config = readLocalSemanticConfiguration(env);
if (!config) throw new Error("Test configuration must be valid");
const health = () => ({
	version: "bitovp-semantic-gateway-v1",
	model: LOCAL_SEMANTIC_MODEL,
	modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
	runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
	profiles: ["nvidia", "amd"],
	stages: Object.entries(localSemanticStageRegistry().stages).map(
		([stage, entry]) => ({
			stage,
			promptVersion: entry.promptVersion,
			schemaHash: entry.schemaHash,
			maxOutputTokens: entry.maxOutputTokens,
		}),
	),
});
const ready = {
	version: "bitovp-semantic-readiness-v1",
	profile: "nvidia",
	scope: "METADATA_ONLY",
	ready: true,
	code: "READY",
};

// Synthetic metadata for protocol validation; no installed model or weights.
const plamoIdentity = localPlamoCaptionIdentityForManifest(
	{
		version: "bitovp-plamo-installed-manifest-v1",
		configId: config.configId,
		modelId: "pfnet/plamo-3-translate-31b",
		sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
		weightSha256: "a".repeat(64),
		weightBytes: 42,
		quantization: "Q8_0",
		promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
		contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		runtimes: {
			nvidia: { sourceRevision: "b".repeat(40), binarySha256: "c".repeat(64) },
		},
	},
	"nvidia",
);
const plamoSelection = {
	provider: "PLAMO" as const,
	identity: plamoIdentity,
	manifestHash: plamoIdentity.manifestHash,
};

describe("manual local model diagnostic", () => {
	it.each([
		{},
		{ BITOVP_LOCAL_SEMANTIC_ENABLED: "1" },
		env,
	])("does no network or registry I/O for a configuration read %#", async (value) => {
		const readWorkers = vi.fn();
		const probeGateway = vi.fn();
		await diagnoseLocalSemanticReadiness({
			env: value,
			readWorkers,
			probeGateway,
		});
		expect(readWorkers).not.toHaveBeenCalled();
		expect(probeGateway).not.toHaveBeenCalled();
	});
	it("keeps missing configuration distinct from malformed settings", async () => {
		expect(
			(await diagnoseLocalSemanticReadiness({ env: {}, diagnose: true }))
				.configuration,
		).toBe("DISABLED");
		expect(
			(
				await diagnoseLocalSemanticReadiness({
					env: { BITOVP_LOCAL_SEMANTIC_ENABLED: "1" },
					diagnose: true,
				})
			).configuration,
		).toBe("INVALID");
	});
	it.each([
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO" },
		{
			BITOVP_LOCAL_CAPTION_PROVIDER: "QWEN",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/unused.json",
		},
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "UNSUPPORTED" },
	])("rejects an unusable caption selection before diagnostics %#", async (captionEnv) => {
		const readWorkers = vi.fn();
		const probeGateway = vi.fn();
		expect(
			await diagnoseLocalSemanticReadiness({
				env: { ...env, ...captionEnv },
				diagnose: true,
				readWorkers,
				probeGateway,
			}),
		).toMatchObject({
			configuration: "INVALID",
			worker: { code: "NOT_CHECKED" },
			gateway: { code: "NOT_CHECKED" },
		});
		expect(readWorkers).not.toHaveBeenCalled();
		expect(probeGateway).not.toHaveBeenCalled();
	});
	it("returns independent fixed failure codes and no connection secrets", async () => {
		const result = await diagnoseLocalSemanticReadiness({
			env,
			diagnose: true,
			readWorkers: async () => {
				throw new Error(JSON.stringify(env));
			},
			probeGateway: async () => {
				throw new Error(config.token);
			},
		});
		expect(result).toMatchObject({
			configuration: "CONFIGURED",
			worker: { code: "REGISTRY_UNAVAILABLE" },
			gateway: { code: "CONNECTION_FAILED", scope: "METADATA_ONLY" },
		});
		expect(JSON.stringify(result)).not.toMatch(
			/fixture\.invalid|private-ca|11111111|aaaa/,
		);
	});
	it("allows an explicit second diagnosis to observe recovery", async () => {
		const readWorkers = vi
			.fn()
			.mockResolvedValueOnce({ code: "MISSING", readyCount: 0, failedCount: 0 })
			.mockResolvedValueOnce({ code: "READY", readyCount: 1, failedCount: 0 });
		const probeGateway = vi
			.fn()
			.mockResolvedValueOnce({
				code: "RUNTIME_UNAVAILABLE",
				scope: "METADATA_ONLY",
			})
			.mockResolvedValueOnce({ code: "READY", scope: "METADATA_ONLY" });
		expect(
			(
				await diagnoseLocalSemanticReadiness({
					env,
					diagnose: true,
					readWorkers,
					probeGateway,
				})
			).worker.code,
		).toBe("MISSING");
		expect(
			await diagnoseLocalSemanticReadiness({
				env,
				diagnose: true,
				readWorkers,
				probeGateway,
			}),
		).toMatchObject({ worker: { code: "READY" }, gateway: { code: "READY" } });
	});
	it("checks stage/model pins, then reads the configured profile without inference", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(health())
			.mockResolvedValueOnce(ready);
		expect(await probeLocalSemanticGateway(config, read)).toEqual({
			code: "READY",
			scope: "METADATA_ONLY",
		});
		expect(read.mock.calls.map((call) => call[1])).toEqual([
			"/health",
			"/readiness/nvidia",
		]);
	});
	it("also verifies the selected translation model without loading it", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(health())
			.mockResolvedValueOnce(ready)
			.mockResolvedValueOnce({
				version: "bitovp-plamo-readiness-v1",
				profile: "nvidia",
				scope: "METADATA_ONLY",
				ready: true,
				code: "READY",
				manifestHash: plamoIdentity.manifestHash,
				identity: plamoIdentity,
			});
		expect(
			await probeLocalSemanticGateway(config, read, undefined, plamoSelection),
		).toEqual({ code: "READY", scope: "METADATA_ONLY" });
		expect(read.mock.calls.map((call) => call[1])).toEqual([
			"/health",
			"/readiness/nvidia",
			`/readiness/plamo/nvidia/${plamoIdentity.manifestHash}`,
		]);
	});
	it("reports an uninstalled selected translation model separately", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(health())
			.mockResolvedValueOnce(ready)
			.mockResolvedValueOnce({
				version: "bitovp-plamo-readiness-v1",
				profile: "nvidia",
				scope: "METADATA_ONLY",
				ready: false,
				code: "MODEL_NOT_INSTALLED",
				manifestHash: null,
				identity: null,
			});
		expect(
			await probeLocalSemanticGateway(config, read, undefined, plamoSelection),
		).toEqual({ code: "MODEL_NOT_INSTALLED", scope: "METADATA_ONLY" });
	});
	it("rejects a foreign translation identity even when its manifest hash is claimed", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(health())
			.mockResolvedValueOnce(ready)
			.mockResolvedValueOnce({
				version: "bitovp-plamo-readiness-v1",
				profile: "nvidia",
				scope: "METADATA_ONLY",
				ready: true,
				code: "READY",
				manifestHash: plamoIdentity.manifestHash,
				identity: {
					...plamoIdentity,
					configId: "22222222-2222-4222-8222-222222222222",
				},
			});
		expect(
			(await probeLocalSemanticGateway(config, read, undefined, plamoSelection))
				.code,
		).toBe("MODEL_MISMATCH");
	});
	it.each([
		"modelDigest",
		"runtimeVersion",
	])("rejects changed %s before reading readiness", async (field) => {
		const read = vi.fn().mockResolvedValue({ ...health(), [field]: "foreign" });
		expect((await probeLocalSemanticGateway(config, read)).code).toBe(
			"GATEWAY_VERSION_MISMATCH",
		);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("rejects a missing current caption stage or incorrect stage budget", async () => {
		for (const value of [
			{
				...health(),
				stages: health().stages.filter(
					(stage) => stage.stage !== "LOCAL_CAPTION_JA_V2",
				),
			},
			{
				...health(),
				stages: health().stages.map((stage) => ({
					...stage,
					maxOutputTokens: 1,
				})),
			},
		]) {
			expect(
				(
					await probeLocalSemanticGateway(
						config,
						vi.fn().mockResolvedValue(value),
					)
				).code,
			).toBe("GATEWAY_VERSION_MISMATCH");
		}
	});
	it.each([
		{ ...ready, profile: "amd" },
		{ ...ready, ready: false },
		{ ...ready, secret: "injected" },
	])("rejects inconsistent or foreign runtime response %#", async (value) => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(health())
			.mockResolvedValueOnce(value);
		expect((await probeLocalSemanticGateway(config, read)).code).toBe(
			"INVALID_RESPONSE",
		);
	});
});
