import {
	type ExpectedLiveArtefacts,
	selectExpectedLiveManifestMuxings,
} from "@bitovp/core";
import type { LiveSample } from "./engine-live";

/** List each storage route under the output identity that was actually read. */
export async function sampleLiveStorageObjects(
	expected: ExpectedLiveArtefacts,
	listAll: (
		outputKey: string,
		prefix: string,
	) => Promise<{ key: string; size?: number }[]>,
): Promise<NonNullable<LiveSample["objects"]>> {
	const mslKeys = new Set(
		(expected.mslEdgeOutputs ?? []).map((o) => o.outputKey),
	);
	const routes = [
		...expected.muxings,
		...expected.manifests
			.filter((m) => !mslKeys.has(m.outputKey))
			.flatMap((m) =>
				selectExpectedLiveManifestMuxings(expected, m).map((route) => ({
					...route,
					outputKey: m.outputKey,
				})),
			),
	];
	const unique = new Map(
		routes.map((m) => [JSON.stringify([m.outputKey, m.dir.prefix]), m]),
	);
	const listed = await Promise.all(
		[...unique.values()].map(async (m) =>
			(await listAll(m.outputKey, m.dir.prefix)).map((o) => ({
				...o,
				outputKey: m.outputKey,
			})),
		),
	);
	type SampledObject = NonNullable<LiveSample["objects"]>[number];
	const objects = new Map<string, SampledObject>();
	const ambiguous = new Set<string>();
	for (const route of listed) {
		for (const observed of route) {
			const candidate: SampledObject = observed;
			const identity = JSON.stringify([candidate.outputKey, candidate.key]);
			if (ambiguous.has(identity)) continue;
			const previous = objects.get(identity);
			if (
				(candidate.size !== undefined &&
					(!Number.isSafeInteger(candidate.size) || candidate.size < 0)) ||
				(previous?.size !== undefined &&
					candidate.size !== undefined &&
					previous.size !== candidate.size) ||
				(previous?.lastModified !== undefined &&
					candidate.lastModified !== undefined &&
					previous.lastModified !== candidate.lastModified)
			) {
				// Conflicting listings cannot certify bytes; later duplicates do not cure them.
				objects.delete(identity);
				ambiguous.add(identity);
				continue;
			}
			const size = previous?.size ?? candidate.size;
			const lastModified = previous?.lastModified ?? candidate.lastModified;
			objects.set(identity, {
				...previous,
				...candidate,
				...(size !== undefined ? { size } : {}),
				...(lastModified !== undefined ? { lastModified } : {}),
			});
		}
	}
	return [...objects.values()];
}
