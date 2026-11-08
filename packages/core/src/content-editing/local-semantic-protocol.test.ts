import { describe, expect, it } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_OUTPUT_TOKENS,
	localSemanticJobRequestSchema,
	localSemanticJobSchema,
	localSemanticPromptVersion,
	localSemanticReceiptSchema,
	localSemanticStageSchema,
} from "./local-semantic-protocol";

const flows = [
	["LOCAL_FLOW_CONTEXT_V1", "local-story-flow-context-v1"],
	["LOCAL_FLOW_ROUTE_V1", "local-story-flow-route-v1"],
] as const;
const profiles = ["amd", "nvidia"] as const;
function request(stage: string, promptVersion: string, profile: string) {
	return {
		version: "bitovp-semantic-job-v1",
		requestKey: "11111111-1111-4111-8111-111111111111",
		organizationId: "22222222-2222-4222-8222-222222222222",
		profile,
		stage,
		prompt: "Synthetic evidence only",
		inputHash: "a".repeat(64),
		promptVersion,
		schemaHash: "b".repeat(64),
	};
}
function receipt(promptVersion: string, profile: string) {
	return {
		version: "bitovp-semantic-receipt-v1",
		profile,
		model: LOCAL_SEMANTIC_MODEL,
		modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
		runtimeVersion: "0.40.14",
		inputHash: "a".repeat(64),
		promptHash: "c".repeat(64),
		schemaHash: "b".repeat(64),
		promptVersion,
		context: 8192,
		maxOutputTokens: 1536,
		thinking: false,
		requestHash: "d".repeat(64),
		elapsedMs: 12,
		apiStats: {
			promptEvalCount: 3,
			evalCount: 2,
			doneReason: "stop",
			loadDurationNs: 1,
			promptEvalDurationNs: 1,
			evalDurationNs: 1,
		},
		placement: [
			{
				name: LOCAL_SEMANTIC_MODEL,
				size: 100,
				sizeVram: 70,
				contextLength: 8192,
			},
		],
		cleanupConfirmed: true,
		schemaVerified: false,
	};
}

describe("additive local FLOW transport", () => {
	it.each(
		flows.flatMap(([stage, promptVersion]) =>
			profiles.map((profile) => ({ stage, promptVersion, profile })),
		),
	)("accepts $stage/$profile with its independent prompt identity", ({
		stage,
		promptVersion,
		profile,
	}) => {
		const body = request(stage, promptVersion, profile),
			proof = receipt(promptVersion, profile);
		expect(localSemanticStageSchema.parse(stage)).toBe(stage);
		expect(localSemanticJobRequestSchema.parse(body)).toEqual(body);
		expect(localSemanticReceiptSchema.parse(proof)).toEqual(proof);
		expect(
			localSemanticJobSchema.parse({
				id: body.requestKey,
				state: "SUCCEEDED",
				stage,
				requestHash: proof.requestHash,
				cleanupConfirmed: true,
				result: { content: "{}", receipt: proof },
			}).stage,
		).toBe(stage);
		expect(localSemanticPromptVersion(stage)).toBe(promptVersion);
		expect(LOCAL_SEMANTIC_OUTPUT_TOKENS[stage]).toBe(1536);
		for (const wrong of ["local-story-v1", "caption-ja-v2", "future"]) {
			expect(
				localSemanticJobRequestSchema.safeParse({
					...body,
					promptVersion: wrong,
				}).success,
			).toBe(false);
		}
		expect(
			localSemanticJobRequestSchema.safeParse({ ...body, extra: true }).success,
		).toBe(false);
	});
	it.each([
		["LOCAL_LEDGER_V1", "local-story-v1", 1024],
		["LOCAL_BLUEPRINT_V1", "local-story-v1", 1536],
		["LOCAL_CAPTION_JA_V1", "caption-ja-v1", 1536],
		["LOCAL_CAPTION_JA_V2", "caption-ja-v2", 1536],
	] as const)("keeps the legacy %s request literals", (stage, promptVersion, tokens) => {
		expect(localSemanticPromptVersion(stage)).toBe(promptVersion);
		expect(LOCAL_SEMANTIC_OUTPUT_TOKENS[stage]).toBe(tokens);
		expect(
			localSemanticJobRequestSchema.parse(
				request(stage, promptVersion, "nvidia"),
			).stage,
		).toBe(stage);
	});
	it("rejects unknown stages and prompt versions without widening the runtime contract", () => {
		expect(
			localSemanticJobRequestSchema.safeParse(
				request("LOCAL_FLOW_UNKNOWN_V1", "local-story-flow-route-v1", "nvidia"),
			).success,
		).toBe(false);
		expect(
			localSemanticReceiptSchema.safeParse(receipt("future", "nvidia")).success,
		).toBe(false);
		expect(
			localSemanticReceiptSchema.safeParse({
				...receipt("local-story-flow-route-v1", "nvidia"),
				context: 16384,
			}).success,
		).toBe(false);
	});
});
