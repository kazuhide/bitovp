/** Run with the workspace TS loader. Reads public metadata only; never calls a model. */
import { readLocalCaptionTranslationSelection } from "../../packages/core/src/content-editing/local-caption-config-node";
import { readLocalSemanticConfiguration } from "../../packages/core/src/content-editing/local-semantic-config";
try {
	const config = readLocalSemanticConfiguration(process.env);
	if (!config) throw new Error("LOCAL_SEMANTIC_NOT_CONFIGURED");
	const selection = readLocalCaptionTranslationSelection(config);
	console.log(JSON.stringify({ version: "bitovp-caption-preflight-v1", provider: selection.provider, identity: selection.identity }));
} catch {
	console.error(JSON.stringify({ error: { code: "LOCAL_CAPTION_CONFIGURATION_INVALID" } }));
	process.exitCode = 1;
}
