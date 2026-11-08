import "server-only";
import {
	hashEditingEvidence,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { readWorkerClipAvailability } from "./local-semantic-readiness";

/** Configuration alone never enables clips; Web reads fresh worker-verified GPU evidence. */
export async function isClipEditingAvailable(
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	try {
		const config = readLocalSemanticConfiguration(env);
		if (!config) return false;
		const caption = readLocalCaptionTranslationSelection(config, env);
		return await readWorkerClipAvailability({
			...config,
			captionModelHash: hashEditingEvidence(caption.identity),
		});
	} catch {
		return false;
	}
}
