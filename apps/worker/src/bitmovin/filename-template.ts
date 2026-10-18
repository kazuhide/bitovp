/** Match provider-expanded random filename tokens without accepting literal braces. */
export function expandRandomFilenameTokens(escaped: string): string {
	return escaped.replace(
		/\\\{(?:segment_)?rand_chars:(\d+)\\\}/g,
		(_token, length: string) => `[^/{}]{${Number(length)}}`,
	);
}

export function initSegmentCandidates(
	keys: string[],
	name: string | undefined,
	template: string | undefined,
): string[] {
	if (template) {
		const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const matcher = new RegExp(`^${expandRandomFilenameTokens(escaped)}$`);
		return keys.filter((key) => matcher.test(key.split("/").pop() ?? ""));
	}
	return name ? keys.filter((key) => key.endsWith(name)) : [];
}
