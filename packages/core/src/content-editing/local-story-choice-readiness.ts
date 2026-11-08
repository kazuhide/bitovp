import { z } from "zod";
import {
	localSemanticDiagnosticKeys,
	localSemanticDiagnosticRequestSchema,
	localSemanticDiagnosticResultSchema,
	PUBLISH_LOCAL_SEMANTIC_DIAGNOSTIC,
	REQUEST_LOCAL_SEMANTIC_DIAGNOSTIC,
} from "./local-semantic-diagnostics";

export const localStoryChoiceDiagnosticRequestSchema =
	localSemanticDiagnosticRequestSchema.extend({
		version: z.literal("local-story-choice-diagnostic-request-v1"),
	});
export type LocalStoryChoiceDiagnosticRequest = z.infer<
	typeof localStoryChoiceDiagnosticRequestSchema
>;
export const localStoryChoiceDiagnosticResultSchema =
	localSemanticDiagnosticResultSchema.extend({
		version: z.literal("local-story-choice-diagnostic-result-v1"),
	});
export type LocalStoryChoiceDiagnosticResult = z.infer<
	typeof localStoryChoiceDiagnosticResultSchema
>;
export function localStoryChoiceDiagnosticKeys(connectionHash: string) {
	const old = localSemanticDiagnosticKeys(connectionHash);
	return Object.fromEntries(
		Object.entries(old).map(([k, value]) => [
			k,
			value.replace(":diagnostic:", ":choice-diagnostic:"),
		]),
	) as typeof old;
}
export const REQUEST_LOCAL_STORY_CHOICE_DIAGNOSTIC =
	REQUEST_LOCAL_SEMANTIC_DIAGNOSTIC;
export const PUBLISH_LOCAL_STORY_CHOICE_DIAGNOSTIC =
	PUBLISH_LOCAL_SEMANTIC_DIAGNOSTIC;
