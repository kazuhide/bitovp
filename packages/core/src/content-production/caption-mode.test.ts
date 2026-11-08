import { describe, expect, it } from "vitest";
import { localCaptionIdentityForConfiguration } from "../content-editing/local-semantic-stages";
import {
	generationTaskParametersSchema,
	mediaTaskEnvelopeSchema,
	usesGeneratedCaptions,
} from "./schema";

const id = "11111111-1111-4111-8111-111111111111";
const params = { contentId: id, targetDurationFrames: 450 };
describe("additive caption modes", () => {
	it.each([
		"OFF",
		"AUTO",
		"ORIGINAL",
		"JAPANESE",
	] as const)("keeps %s wire intent intact", (captions) => {
		const parsed = generationTaskParametersSchema.parse({
			...params,
			captions,
		});
		expect(parsed.captions).toBe(captions);
		expect(usesGeneratedCaptions(parsed.captions)).toBe(captions !== "OFF");
	});
	it("requires a separate local translation identity only for explicit Japanese", () => {
		const envelope = {
			schemaVersion: 1,
			input: {
				kind: "GENERATE",
				mediaVersionId: id,
				analysisRevisionId: id,
				requestKey: id,
				parameters: { ...params, captions: "JAPANESE" },
			},
			identity: {
				organizationId: id,
				mediaSha256: null,
				modelSha256: null,
				analysisDocumentHash: null,
				analysisRawHash: null,
				timeMapHash: null,
			},
		};
		expect(mediaTaskEnvelopeSchema.safeParse(envelope).success).toBe(false);
		const pinned = {
			...envelope,
			identity: {
				...envelope.identity,
				captionTranslationModel: localCaptionIdentityForConfiguration({
					profile: "amd",
					configId: id,
				} as Parameters<typeof localCaptionIdentityForConfiguration>[0]),
			},
		};
		expect(mediaTaskEnvelopeSchema.safeParse(pinned).success).toBe(true);
		expect(
			mediaTaskEnvelopeSchema.safeParse({
				...pinned,
				input: {
					...envelope.input,
					parameters: { ...params, captions: "AUTO" },
				},
			}).success,
		).toBe(false);
	});
});
