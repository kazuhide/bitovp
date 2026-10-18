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
	if (
		[...plan.ingest, ...plan.fileStreams, ...plan.dolbyStreams].some(
			(s) => s.key === key,
		)
	)
		return [key];
	const parents = inputStreamDependencies(plan, key);
	if (!parents.length) return undefined;
	const next = new Set(seen).add(key);
	const leaves = parents.map((parent) =>
		inputStreamAncestry(plan, parent, next),
	);
	return leaves.some((v) => v === undefined)
		? undefined
		: [key, ...new Set(leaves.flatMap((v) => v ?? []))];
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
