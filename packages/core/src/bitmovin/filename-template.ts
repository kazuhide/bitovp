function escapePattern(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match provider-expanded random tokens in an already escaped filename. */
export function expandRandomFilenameTokens(
	escaped: string,
	maximumLength = Number.MAX_SAFE_INTEGER,
): string {
	// The pinned SDK's muxing models specify alphanumeric strings, default 32.
	return escaped.replace(
		/\\\{(?:segment_)?rand_chars(?::([^{}]*))?\\\}/g,
		(_token, requested: string | undefined) => {
			const length = requested === undefined ? 32 : Number(requested);
			return (requested === undefined || /^[1-9]\d*$/.test(requested)) &&
				Number.isSafeInteger(length) &&
				length <= maximumLength
				? `[A-Za-z0-9]{${length}}`
				: "(?!)";
		},
	);
}

/** Capture only the numeric index; random tokens never add capture groups. */
export function segmentNamePattern(
	segmentNaming: string,
	expandRandomTokens = true,
): RegExp {
	const escaped = escapePattern(segmentNaming);
	const source = (
		expandRandomTokens ? expandRandomFilenameTokens(escaped) : escaped
	).replace(/%number%/g, "([0-9]+)");
	// A strict end assertion also excludes an unexpected trailing newline.
	return new RegExp(`^${source}(?![\\s\\S])`);
}

export function initSegmentCandidates(
	keys: string[],
	name: string | undefined,
	template: string | undefined,
): string[] {
	if (template) {
		const maximumLength = keys.reduce(
			(longest, key) => Math.max(longest, (key.split("/").pop() ?? "").length),
			0,
		);
		const source = expandRandomFilenameTokens(
			escapePattern(template),
			maximumLength,
		);
		const matcher = new RegExp(`^${source}(?![\\s\\S])`);
		return keys.filter((key) => matcher.test(key.split("/").pop() ?? ""));
	}
	return name ? keys.filter((key) => key.endsWith(name)) : [];
}
