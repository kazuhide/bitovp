import type { EncodingPlan } from "./schema";
export function inputStreamDependencies(
	plan: EncodingPlan,
	key: string,
): string[] {
	const trim = plan.trimmingStreams.find((s) => s.key === key);
	if (trim) return [trim.sourceKey];
	const concat = plan.concatenationStreams.find((s) => s.key === key);
	if (concat) return concat.sources.map((s) => s.sourceKey);
	return (
		plan.audioMixStreams
			.find((s) => s.key === key)
			?.audioMixChannels.map((s) => s.sourceKey) ?? []
	);
}
/** Shared ancestry traversal: undefined means unknown/cyclic, never assume audio. */
export function inputStreamAncestry(
	plan: EncodingPlan,
	key: string,
	seen = new Set<string>(),
): string[] | undefined {
	if (seen.has(key)) return undefined;
	const leaves = new Set(
		[...plan.ingest, ...plan.fileStreams, ...plan.dolbyStreams].map(
			(row) => row.key,
		),
	);
	if (leaves.has(key)) return [key];
	// Preserve the lookup precedence used by inputStreamDependencies.
	const inputs = new Map<string, string[]>();
	for (const row of plan.trimmingStreams)
		if (!inputs.has(row.key)) inputs.set(row.key, [row.sourceKey]);
	for (const row of plan.concatenationStreams)
		if (!inputs.has(row.key))
			inputs.set(
				row.key,
				row.sources.map((s) => s.sourceKey),
			);
	for (const row of plan.audioMixStreams)
		if (!inputs.has(row.key))
			inputs.set(
				row.key,
				row.audioMixChannels.map((s) => s.sourceKey),
			);

	const active = new Set(seen);
	const ordered = new Set<string>();
	const pending = [{ key, leaving: false }];
	while (pending.length) {
		const node = pending.pop();
		if (!node) break;
		if (node.leaving) {
			active.delete(node.key);
			continue;
		}
		if (active.has(node.key)) return undefined;
		if (ordered.has(node.key)) continue;
		ordered.add(node.key);
		if (leaves.has(node.key)) continue;
		const parents = inputs.get(node.key);
		if (!parents?.length) return undefined;
		active.add(node.key);
		pending.push({ key: node.key, leaving: true });
		for (const parent of parents.toReversed())
			pending.push({ key: parent, leaving: false });
	}
	return [...ordered];
}

/** Leaves only, retaining unknown/cycle semantics of the complete ancestry. */
export function inputStreamLeaves(
	plan: EncodingPlan,
	key: string,
): string[] | undefined {
	const leaves = new Set(
		[...plan.ingest, ...plan.fileStreams, ...plan.dolbyStreams].map(
			(s) => s.key,
		),
	);
	return inputStreamAncestry(plan, key)?.filter((k) => leaves.has(k));
}
