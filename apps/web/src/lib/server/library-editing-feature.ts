import "server-only";
import { readLocalSemanticConfiguration } from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";

/** Configuration capability only. Never probes a model or exposes server settings. */
export function isClipEditingAvailable(
	env: Record<string, string | undefined> = process.env,
): boolean {
	try {
		const config = readLocalSemanticConfiguration(env);
		if (!config) return false;
		readLocalCaptionTranslationSelection(config, env);
		return true;
	} catch {
		return false;
	}
}
