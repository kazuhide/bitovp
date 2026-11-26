import type { NextConfig } from "next";

type PatternOption = "remotePatterns" | "localPatterns";

export class UnsupportedImagePatternError extends TypeError {
	readonly code = "ERR_UNSUPPORTED_NEXT_IMAGE_PATTERNS";

	constructor(option: PatternOption) {
		super(
			`Custom images.${option} are unsupported while Next.js uses an unpatched vendored picomatch. Keep the list empty or unset; review the matcher before enabling image patterns.`,
		);
		this.name = "UnsupportedImagePatternError";
	}
}

/** Keep custom image patterns out of Next's unpatched vendored matcher. */
export function assertSupportedImagePatterns(
	config: Pick<NextConfig, "images">,
): void {
	for (const option of ["remotePatterns", "localPatterns"] as const) {
		const patterns = config.images?.[option];
		if (
			patterns !== undefined &&
			(!Array.isArray(patterns) || patterns.length !== 0)
		) {
			throw new UnsupportedImagePatternError(option);
		}
	}
}
