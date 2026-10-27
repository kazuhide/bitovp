import {
	type ExpectedLiveArtefacts,
	expandRandomFilenameTokens,
	segmentNamePattern,
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
	const source = segmentNamePattern(
		muxing.segmentNaming,
		muxing.segmentNamingIsTemplate === true,
	).source;
	// Keep other provider naming-policy tokens while constraining numeric indices.
	const segment = new RegExp(source.replace(/%[a-zA-Z]+%/g, "[^/]+"));
	const template = muxing.initSegmentNameTemplate;
	const initPattern = template
		? new RegExp(
				`^${expandRandomFilenameTokens(
					template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
					candidates.reduce(
						(n, o) => Math.max(n, o.key.length - muxing.dir.prefix.length),
						0,
					),
					true,
				)}(?![\\s\\S])`,
			)
		: undefined;
	const init: T[] = [];
	const media: T[] = [];
	for (const object of candidates) {
		const name = object.key.slice(muxing.dir.prefix.length);
		if (
			initPattern
				? initPattern.test(name)
				: muxing.initSegment !== undefined && name === muxing.initSegment
		)
			init.push(object);
		else if (segment.test(name)) media.push(object);
	}
	return { init, media };
}
