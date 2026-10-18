/**
 * THE structural destination walk ('s shared design
 * note: one rebase in the tree). Destinations share one wire shape
 * ({ outputKey, path, … }) across muxings, manifests, sprites, thumbnails
 * and DRM — walking the structure covers them all, so a NEW destination
 * site cannot be silently missed. Template launches (#109), watch folders
 * (#87), the per-run live rebase (#155) and BOTH verify runners' per-run
 * reprefix (review-284 N1 — they used to keep hand-listed array walks,
 * structurally blind to any site off the list) express their rewrites
 * over this walk; growing a second walk is how one of them silently
 * misses a site the others cover.
 */
export function mapDestinations(
	node: unknown,
	map: (
		dest: { outputKey: string; path: string } & Record<string, unknown>,
	) => Record<string, unknown>,
): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => mapDestinations(item, map));
	}
	if (typeof node !== "object" || node === null) {
		return node;
	}
	const record = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		out[key] = mapDestinations(value, map);
	}
	if (typeof record.outputKey === "string" && typeof record.path === "string") {
		return map(out as { outputKey: string; path: string });
	}
	return out;
}

/** The path-only rewrite every rebase uses — `mapDestinations` narrowed. */
export function mapDestinationPaths(
	node: unknown,
	map: (path: string) => string,
): unknown {
	return mapDestinations(node, (dest) => ({ ...dest, path: map(dest.path) }));
}

/** Every destination path in the node, in walk order (arrays in order, then object keys). */
export function collectDestinationPaths(node: unknown): string[] {
	const paths: string[] = [];
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) {
			for (const item of n) {
				walk(item);
			}
			return;
		}
		if (typeof n !== "object" || n === null) {
			return;
		}
		const record = n as Record<string, unknown>;
		if (
			typeof record.outputKey === "string" &&
			typeof record.path === "string"
		) {
			paths.push(record.path);
		}
		for (const value of Object.values(record)) {
			walk(value);
		}
	};
	walk(node);
	return paths;
}
