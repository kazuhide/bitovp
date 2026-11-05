/** The persisted discriminator, never a model-name guess, identifies CAMBI jobs. */
export function isBandingOnly(params: unknown): boolean {
	return (
		typeof params === "object" &&
		params !== null &&
		"kind" in params &&
		params.kind === "BANDING"
	);
}

export function hasBanding(params: unknown): boolean {
	return (
		isBandingOnly(params) ||
		(typeof params === "object" &&
			params !== null &&
			"banding" in params &&
			params.banding === true)
	);
}
