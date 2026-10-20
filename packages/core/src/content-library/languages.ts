/** English is the default analysis output; requested translations are additional. */
export function sceneAnalysisLocales(
	additionalLanguages: readonly string[] = [],
): string[] {
	return [...new Set([...additionalLanguages, "en"])];
}
