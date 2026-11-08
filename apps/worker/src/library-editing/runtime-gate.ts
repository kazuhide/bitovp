import {
	type LocalSemanticConfiguration,
	readLocalSemanticConfiguration,
} from "@bitovp/core";

/** Build before scheduling: disabled/invalid local setup never registers clip work.
 * Keep initialization failures (for example an unreadable CA) local to editing.
 * No exception contents or operator secrets cross this boundary.
 */
export function createConfiguredLibraryEditing<T>(
	env: Record<string, string | undefined>,
	create: (config: LocalSemanticConfiguration) => T,
): T | undefined {
	try {
		const config = readLocalSemanticConfiguration(env);
		return config ? create(config) : undefined;
	} catch {
		return undefined;
	}
}
