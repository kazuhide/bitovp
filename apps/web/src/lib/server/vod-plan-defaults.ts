/** Historical VOD plans may omit either optional stream list. Preserve every other byte of plan data. */
export function equivalentVodPlanDefaults(
	plan: unknown,
): Record<string, unknown>[] {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) return [];
	const source = plan as Record<string, unknown>;
	const variants = [source];
	for (const field of ["hdr10PlusStreams", "captionStreams"] as const) {
		if (
			Object.hasOwn(source, field) &&
			!(Array.isArray(source[field]) && source[field].length === 0)
		)
			continue;
		for (const variant of [...variants]) {
			const equivalent = { ...variant };
			if (Object.hasOwn(source, field)) delete equivalent[field];
			else equivalent[field] = [];
			variants.push(equivalent);
		}
	}
	return variants.slice(1);
}
