import { isObjectStorageInput } from "../plan/object-input-path";
import type { EncodingPlan } from "../plan/schema";

/** Ordinary ingest rows retain their source kind after deletion of the job. */
export function libraryIngestInputs(plan: EncodingPlan) {
	const inputs = new Map<string, EncodingPlan["inputs"][number] | null>();
	for (const input of plan.inputs)
		inputs.set(input.key, inputs.has(input.key) ? null : input);
	return plan.ingest.map((ingest) => {
		const input = inputs.get(ingest.inputKey);
		const objectKey = !!input && isObjectStorageInput(input.kind);
		return {
			name: input?.name ?? ingest.key,
			path: ingest.inputPath,
			...(objectKey && { pathKind: "OBJECT_KEY" as const }),
		};
	});
}

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
