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
	return listed.flat();
}
