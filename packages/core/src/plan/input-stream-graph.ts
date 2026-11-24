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
	const leaves = new Set(
		[
			...plan.ingest,
			...plan.fileStreams,
			...plan.dolbyStreams,
			...plan.hdr10PlusStreams,
		].map((stream) => stream.key),
	);
	if (seen.has(key)) return undefined;
	if (leaves.has(key)) return [key];
	const derived = new Map(
		[
			...plan.trimmingStreams,
			...plan.concatenationStreams,
			...plan.audioMixStreams,
		].map((stream) => [stream.key, stream] as const),
	);
	const visiting = new Set(seen);
	const visited = new Set<string>();
	const order: string[] = [];
	const stack = [{ key, exit: false }];
	while (stack.length) {
		const frame = stack.pop();
		if (!frame) break;
		const id = frame.key;
		if (frame.exit) {
			visiting.delete(id);
			visited.add(id);
			continue;
		}
		if (visiting.has(id)) return undefined;
		if (visited.has(id)) continue;
		order.push(id);
		if (leaves.has(id)) {
			visited.add(id);
			continue;
		}
		const stream = derived.get(id);
		if (!stream) return undefined;
		const parents =
			"sourceKey" in stream
				? [stream.sourceKey]
				: ("sources" in stream ? stream.sources : stream.audioMixChannels).map(
						(parent) => parent.sourceKey,
					);
		if (!parents.length) return undefined;
		visiting.add(id);
		stack.push({ key: id, exit: true });
		for (const parent of parents.reverse())
			stack.push({ key: parent, exit: false });
	}
	return order;
}

/** Leaves only, retaining unknown/cycle semantics of the complete ancestry. */
export function inputStreamLeaves(
	plan: EncodingPlan,
	key: string,
): string[] | undefined {
	const leaves = new Set(
		[
			...plan.ingest,
			...plan.fileStreams,
			...plan.dolbyStreams,
			...plan.hdr10PlusStreams,
		].map((s) => s.key),
	);
	return inputStreamAncestry(plan, key)?.filter((k) => leaves.has(k));
}
