/** Plans saved before HDR10+ omit its optional list. Only these two JSON
 * representations describe the same plan across that upgrade boundary. */
export function equivalentHdrDefault(
	plan: unknown,
): Record<string, unknown> | undefined {
	if (!plan || typeof plan !== "object" || Array.isArray(plan))
		return undefined;
	const object = plan as Record<string, unknown>;
	if (!Object.hasOwn(object, "hdr10PlusStreams"))
		return { ...object, hdr10PlusStreams: [] };
	const { hdr10PlusStreams, ...without } = object;
	return Array.isArray(hdr10PlusStreams) && hdr10PlusStreams.length === 0
		? without
		: undefined;
}
