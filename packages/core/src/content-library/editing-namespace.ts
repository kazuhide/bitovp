/** Reserved across providers, buckets and credential aliases, including case-insensitive storage. */
export const MANAGED_EDITING_OUTPUT_SEGMENT = "bitovp-editing";

/** Storage keys are raw paths: match whole segments, without URL decoding or prefix guesses. */
export function isManagedEditingObjectKey(key: string): boolean {
	return key
		.split("/")
		.some(
			(segment) => segment.toLowerCase() === MANAGED_EDITING_OUTPUT_SEGMENT,
		);
}
