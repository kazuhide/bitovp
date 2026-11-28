/** Match one observed snapshot to every confirmed resource ID exactly once. */
export function sameConfirmedResourceIds(
	observed: readonly (string | undefined)[],
	confirmed: readonly string[],
): boolean {
	const pending = new Set(confirmed);
	if (pending.size === 0 || pending.size !== confirmed.length) return false;
	for (const id of observed) {
		if (id === undefined || !pending.delete(id)) return false;
	}
	return pending.size === 0;
}
