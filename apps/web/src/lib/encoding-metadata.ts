/** Return only the number of own enumerable metadata keys. */
export function projectEncodingMetadata(value: unknown) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return;
	return { keyCount: Object.keys(value).length };
}
