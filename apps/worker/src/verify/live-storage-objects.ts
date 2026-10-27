import {
	createFilenameMatcher,
	type ExpectedLiveArtefacts,
} from "@bitovp/core";

/** Bind complete object names to one writer, including any declared subdirectories. */
export function liveStorageObjects<
	T extends { outputKey: string; key: string },
>(
	objects: readonly T[],
	muxing: ExpectedLiveArtefacts["muxings"][number],
): { init: T[]; media: T[] } {
	const candidates = objects.filter(
		(o) =>
			o.outputKey === muxing.outputKey && o.key.startsWith(muxing.dir.prefix),
	);
	const segment = createFilenameMatcher(muxing.segmentNaming, {
		policyTokens: true,
		randomTokens: muxing.segmentNamingIsTemplate === true,
	});
	const template = muxing.initSegmentNameTemplate;
	const initPattern =
		template || muxing.initSegment
			? createFilenameMatcher(template || muxing.initSegment || "", {
					policyTokens: false,
					randomTokens: Boolean(template),
				})
			: undefined;
	const init: T[] = [];
	const media: T[] = [];
	for (const object of candidates) {
		const name = object.key.slice(muxing.dir.prefix.length);
		const initMatch = initPattern?.(name);
		if (initMatch === "MATCH") init.push(object);
		// An undecidable init name cannot be relabelled as positive media evidence.
		else if (initMatch !== "UNVERIFIED" && segment(name) === "MATCH")
			media.push(object);
	}
	return { init, media };
}
