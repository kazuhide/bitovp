import type { LiveWizardState } from "./build-live-plan";

export function liveMirrorEntries(state: LiveWizardState) {
	return [
		...(state.mirror
			? [{ key: state.mirrorKey ?? "mirror-1", output: state.mirror }]
			: []),
		...(state.additionalMirrors ?? []),
	];
}

export function liveOutputEntries(state: LiveWizardState) {
	return [
		{ key: "origin", output: state.output },
		...liveMirrorEntries(state),
		...(state.archive?.output
			? [
					{
						key: state.archive.muxing.destination.outputKey,
						output: state.archive.output,
					},
				]
			: []),
	];
}

export function liveOutputReferenced(state: LiveWizardState, key: string) {
	return (
		state.archive?.muxing.destination.outputKey === key ||
		[
			state.manifests.hls,
			state.manifests.dash,
			...(state.manifests.additionalHls ?? []),
			...(state.manifests.additionalDash ?? []),
		].some((manifest) => manifest.destination?.outputKey === key)
	);
}

export function inResourceOrder<T extends { key: string }>(
	items: T[],
	order?: string[],
): T[] {
	if (!order) return items;
	const byKey = new Map(items.map((item) => [item.key, item]));
	const keys = new Set(order);
	return [...keys]
		.flatMap((key) => (byKey.get(key) ? [byKey.get(key)!] : []))
		.concat(items.filter((item) => !keys.has(item.key)));
}
