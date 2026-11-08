import { expect, it } from "vitest";
import { GENERATION_POLICY_FINGERPRINT } from "./generation-policy";
import { mediaTaskCacheKey } from "./identity";
import {
	generationTaskResultSchema,
	mediaTaskCreateSchema,
	mediaTaskEnvelopeSchema,
	mediaTaskIdentitySchema,
} from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
const identity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: null,
	analysisDocumentHash: "b".repeat(64),
	analysisRawHash: "c".repeat(64),
	timeMapHash: "d".repeat(64),
};
const input = mediaTaskCreateSchema.parse({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: { contentId: id, targetDurationFrames: 900 },
});
const result = {
	projectId: id,
	projectIds: [id],
	requestedFrames: 900,
	actualFrames: 870,
	warnings: [],
	policyVersion: "aisa-scene-cohesion-v2",
	presetIds: ["portrait-clean"],
	metrics: {},
	cacheable: true,
};
it("separates new GENERATE output policy without changing legacy intent/cache/history parsing", () => {
	expect(mediaTaskCacheKey(input, identity)).toBe(
		"82a4b4b9852498742c4650605063a077d2e1f9fbfc4a47bd11d500d150e704fa",
	);
	const current = mediaTaskIdentitySchema.parse({
		...identity,
		generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
	});
	expect(mediaTaskCacheKey(input, current)).not.toBe(
		mediaTaskCacheKey(input, identity),
	);
	expect(
		generationTaskResultSchema.parse({
			...result,
			generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
		}),
	).toHaveProperty(
		"generationPolicyFingerprint",
		GENERATION_POLICY_FINGERPRINT,
	);
	expect(generationTaskResultSchema.parse(result)).toEqual(result);
});
it("does not admit a GENERATE policy pin into independent TRANSCRIBE or TRACK identity", () => {
	for (const kind of ["TRANSCRIBE", "TRACK"]) {
		const other = mediaTaskCreateSchema.parse({
			kind,
			mediaVersionId: id,
			...(kind === "TRACK" ? { analysisRevisionId: id } : {}),
			requestKey: id,
			parameters: {},
		});
		expect(
			mediaTaskEnvelopeSchema.safeParse({
				schemaVersion: 1,
				input: other,
				identity,
			}).success,
		).toBe(true);
		expect(
			mediaTaskEnvelopeSchema.safeParse({
				schemaVersion: 1,
				input: other,
				identity: {
					...identity,
					generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				},
			}).success,
		).toBe(false);
	}
});
