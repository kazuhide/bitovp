import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	probeLocalSemanticGateway,
	probeLocalStoryChoiceGateway,
	type readLocalSemanticMetadata,
} from "../local-semantic-diagnostic-probe";
import {
	localSemanticDiagnosticKeys,
	localSemanticDiagnosticRequestSchema,
} from "./local-semantic-diagnostics";
import {
	LOCAL_SEMANTIC_OUTPUT_TOKENS,
	localSemanticJobRequestSchema,
	localSemanticPromptVersion,
	localSemanticReceiptSchema,
} from "./local-semantic-protocol";
import {
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import { localStoryChoiceSchema } from "./local-story-choice";
import {
	localStoryChoiceDiagnosticKeys,
	localStoryChoiceDiagnosticRequestSchema,
} from "./local-story-choice-readiness";
import {
	localSemanticPlanningStageRegistry,
	localStoryChoiceStageRegistry,
} from "./local-story-choice-stages";
import { localSemanticCombinedStageRegistry } from "./local-story-flow-stages";
import { hashEditingEvidence } from "./verify-automatic-binding";

const config = {
	url: "https://fixture.invalid/",
	token: "synthetic-fixture-token-".repeat(3),
	caFile: "/never-read.pem",
	profile: "nvidia" as const,
	configId: "33333333-3333-4333-8333-333333333333",
};
describe("separate choice stage and capability", () => {
	it("preserves both legacy registries, model identity and old FLOW6", () => {
		expect(hashEditingEvidence(localStoryStageRegistry())).toBe(
			"c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
		);
		expect(hashEditingEvidence(localSemanticStageRegistry())).toBe(
			"cca2b05de7299f0a87569dd225d8646d2f78aab398a8c5479957a2135de4b50e",
		);
		expect(
			hashEditingEvidence(localStoryIdentityForConfiguration(config)),
		).toBe("651e61b705049e70a07adda5bff85a9e9d71bc02e5f1858e8f9aedbfebf953d0");
		expect(
			Object.keys(localSemanticCombinedStageRegistry().stages),
		).toHaveLength(6);
		const planning = localSemanticPlanningStageRegistry(),
			component = localStoryChoiceStageRegistry();
		expect(Object.keys(planning.stages)).toHaveLength(5);
		expect(planning.legacyRegistryHash).toBe(
			hashEditingEvidence(localSemanticStageRegistry()),
		);
		expect(planning.choiceRegistryHash).toBe(hashEditingEvidence(component));
		expect(component.stages.LOCAL_STORY_CHOICE_V1.schema).toEqual(
			z.toJSONSchema(localStoryChoiceSchema),
		);
		expect(component.stages.LOCAL_STORY_CHOICE_V1.maxOutputTokens).toBe(512);
	});
	it("binds the dedicated prompt version and512tokens without changing existing limits", () => {
		const stage = "LOCAL_STORY_CHOICE_V1",
			promptVersion = localSemanticPromptVersion(stage);
		expect(promptVersion).toBe("local-story-choice-v1");
		expect(LOCAL_SEMANTIC_OUTPUT_TOKENS[stage]).toBe(512);
		expect(LOCAL_SEMANTIC_OUTPUT_TOKENS.LOCAL_BLUEPRINT_V1).toBe(1536);
		const body = {
			version: "bitovp-semantic-job-v1",
			requestKey: config.configId,
			organizationId: config.configId,
			profile: "nvidia",
			stage,
			prompt: "Choose p0.",
			inputHash: "a".repeat(64),
			promptVersion,
			schemaHash: localStoryChoiceStageRegistry().stages[stage].schemaHash,
		};
		expect(localSemanticJobRequestSchema.safeParse(body).success).toBe(true);
		expect(
			localSemanticJobRequestSchema.safeParse({
				...body,
				promptVersion: "local-story-v1",
			}).success,
		).toBe(false);
		expect(
			localSemanticReceiptSchema.shape.promptVersion.safeParse(promptVersion)
				.success,
		).toBe(true);
		expect(
			localSemanticReceiptSchema.shape.maxOutputTokens.safeParse(512).success,
		).toBe(true);
	});
	it("requires exact planning5 metadata and preserves legacy4 readiness", async () => {
		const health = (
			stages: Record<
				string,
				{ promptVersion: string; schemaHash: string; maxOutputTokens: number }
			>,
		) => ({
			version: "bitovp-semantic-gateway-v1",
			runtimeVersion: "0.40.14",
			model: "qwen3.8:27b-q8_0",
			modelDigest:
				"8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039",
			profiles: ["nvidia"],
			stages: Object.entries(stages).map(([stage, entry]) => ({
				stage,
				promptVersion: entry.promptVersion,
				schemaHash: entry.schemaHash,
				maxOutputTokens: entry.maxOutputTokens,
			})),
		});
		const reader =
			(
				stages: Parameters<typeof health>[0],
			): typeof readLocalSemanticMetadata =>
			async (_config, path): Promise<unknown> =>
				path === "/health"
					? health(stages)
					: {
							version: "bitovp-semantic-readiness-v1",
							profile: "nvidia",
							scope: "METADATA_ONLY",
							ready: true,
							code: "READY",
						};
		expect(
			(
				await probeLocalStoryChoiceGateway(
					config,
					reader(localSemanticPlanningStageRegistry().stages),
				)
			).code,
		).toBe("READY");
		expect(
			(
				await probeLocalStoryChoiceGateway(
					config,
					reader(localSemanticStageRegistry().stages),
				)
			).code,
		).toBe("GATEWAY_VERSION_MISMATCH");
		expect(
			(
				await probeLocalSemanticGateway(
					config,
					reader(localSemanticStageRegistry().stages),
				)
			).code,
		).toBe("READY");
		const changed = localSemanticPlanningStageRegistry().stages;
		changed.LOCAL_STORY_CHOICE_V1.schemaHash = "f".repeat(64);
		expect(
			(await probeLocalStoryChoiceGateway(config, reader(changed))).code,
		).toBe("GATEWAY_VERSION_MISMATCH");
	});
	it("keeps choice diagnostics distinct from legacy queues and versions", () => {
		const hash = "a".repeat(64),
			old = localSemanticDiagnosticKeys(hash),
			current = localStoryChoiceDiagnosticKeys(hash);
		for (const key of ["active", "requests", "results"] as const)
			expect(current[key]).not.toBe(old[key]);
		const request = {
			version: "local-story-choice-diagnostic-request-v1",
			requestId: config.configId,
			expiresAt: 1000,
		};
		expect(
			localStoryChoiceDiagnosticRequestSchema.safeParse(request).success,
		).toBe(true);
		expect(
			localSemanticDiagnosticRequestSchema.safeParse(request).success,
		).toBe(false);
		expect(() => localStoryChoiceDiagnosticKeys("bad")).toThrow();
	});
});
