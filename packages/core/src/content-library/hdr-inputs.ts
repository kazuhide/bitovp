import type { EncodingPlan } from "../plan/schema";

export function libraryHdr10PlusInputs(plan: EncodingPlan) {
	const names = new Map(plan.inputs.map((input) => [input.key, input.name]));
	return plan.hdr10PlusStreams.flatMap((stream) =>
		(["VIDEO", "METADATA"] as const).map((role) => ({
			name: names.get(stream.inputKey) ?? stream.key,
			path: role === "VIDEO" ? stream.videoInputPath : stream.metadataInputPath,
			hdr10Plus: { streamKey: stream.key, inputKey: stream.inputKey, role },
		})),
	);
}

/** Fill only absent roles. Preserve the original coordinates of existing editorial sources. */
export function missingLibraryHdrInputs(
	existing: readonly {
		hdr10Plus?: { streamKey: string; role: "VIDEO" | "METADATA" };
	}[],
	expected: ReturnType<typeof libraryHdr10PlusInputs>,
) {
	const present = new Set(
		existing.flatMap((row) =>
			row.hdr10Plus
				? [JSON.stringify([row.hdr10Plus.streamKey, row.hdr10Plus.role])]
				: [],
		),
	);
	return expected.filter(
		(row) =>
			!present.has(
				JSON.stringify([row.hdr10Plus.streamKey, row.hdr10Plus.role]),
			),
	);
}
