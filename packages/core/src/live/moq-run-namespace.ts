export const MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH = 1_024;

export function moqRunNamespaceSuffix(runId: string): string {
	return `-bitovp-${runId}`;
}

/** Preserve the single-field shape supported by Player Web X. */
export function bindMoqPlaybackNamespace(
	namespace: string[],
	runId: string,
): string[] {
	const [field] = namespace;
	if (namespace.length !== 1 || !field) return namespace;
	const suffix = moqRunNamespaceSuffix(runId);
	if (
		field.endsWith(suffix) &&
		field.length <= MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH
	)
		return namespace;
	const base = field.endsWith(suffix) ? field.slice(0, -suffix.length) : field;
	const prefix = base
		.slice(0, MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH - suffix.length)
		.replace(/[\uD800-\uDBFF]$/, "");
	return [prefix + suffix];
}
