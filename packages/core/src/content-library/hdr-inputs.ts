import {
	hasPrivateStorageLocator,
	type StoragePathKind,
} from "../plan/hdr-source-paths";
import { isObjectStorageInput } from "../plan/object-input-path";
import type { EncodingPlan } from "../plan/schema";

/** Ordinary ingest rows retain their source kind after deletion of the job. */
type CapturedIngestPath = {
	name: string;
	path: string;
	pathKind?: Exclude<StoragePathKind, "UNKNOWN">;
};

export function libraryIngestInputs(plan: EncodingPlan): CapturedIngestPath[] {
	const inputs = new Map<string, EncodingPlan["inputs"][number] | null>();
	for (const input of plan.inputs)
		inputs.set(input.key, inputs.has(input.key) ? null : input);
	return plan.ingest.map((ingest) => {
		const input = inputs.get(ingest.inputKey);
		const objectKey = !!input && isObjectStorageInput(input.kind);
		return {
			name: input?.name ?? ingest.key,
			path: ingest.inputPath,
			...(objectKey
				? { pathKind: "OBJECT_KEY" as const }
				: input?.kind === "HTTPS"
					? { pathKind: "HTTPS_PATH" as const }
					: {}),
		};
	});
}

/** A name/path shared by different source kinds cannot identify an old
 * capture. The same typed source may legitimately feed audio and video. */
export function recoverLibraryIngestInputs<
	T extends {
		name: string;
		path: string;
		pathKind?: Exclude<StoragePathKind, "UNKNOWN">;
		hdr10Plus?: unknown;
	},
>(captured: readonly T[], planned: ReturnType<typeof libraryIngestInputs>) {
	const key = (row: { name: string; path: string }) =>
		JSON.stringify([row.name, row.path]);
	const kinds = new Map<string, StoragePathKind>();
	for (const row of planned) {
		const id = key(row),
			existing = kinds.get(id),
			kind = row.pathKind ?? "UNKNOWN";
		kinds.set(id, existing && existing !== kind ? "UNKNOWN" : kind);
	}
	let changed = false;
	const result = captured.map((row, index) => {
		if (row.hdr10Plus || row.pathKind || !hasPrivateStorageLocator(row.path))
			return row;
		const expected = planned[index];
		if (!expected || key(expected) !== key(row)) return row;
		const kind = kinds.get(key(row));
		if (!kind || kind === "UNKNOWN") return row;
		changed = true;
		return {
			...row,
			pathKind: kind,
		};
	});
	return changed ? result : undefined;
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
