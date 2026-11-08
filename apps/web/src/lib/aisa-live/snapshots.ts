import { type AisaResultSnapshot, aisaResultSchema } from "./contracts";

type Observation = AisaResultSnapshot["observations"][number];
type KeyMoment = AisaResultSnapshot["keyMoments"][number];

// JSONB/Prisma can round the final binary floating-point digit. Compare media
// seconds at microsecond precision while retaining the provider's original values.
const comparableSeconds = (value: number) => Number(value.toFixed(6));

export type AisaSnapshotState = {
	readonly snapshot: AisaResultSnapshot;
	readonly knownObservations: ReadonlyMap<string, string>;
	readonly knownKeyMoments: ReadonlyMap<
		string,
		{ content: string; sequence: number }
	>;
};

const observationContent = (item: Observation) =>
	JSON.stringify([
		item.text,
		comparableSeconds(item.startTimeSeconds),
		comparableSeconds(item.endTimeSeconds),
	]);
const momentContent = (item: KeyMoment) =>
	JSON.stringify([
		item.importanceLevel,
		comparableSeconds(item.startInSeconds),
		comparableSeconds(item.endInSeconds),
		comparableSeconds(item.anchorInSeconds),
		[...item.observations].sort(),
		[...item.categories].sort(),
	]);

/** Collection and set ordering does not change an immutable result generation. */
function snapshotContent(snapshot: AisaResultSnapshot): string {
	return JSON.stringify([
		snapshot.analysisId,
		snapshot.encodingId,
		snapshot.sequence,
		snapshot.producedAt,
		snapshot.mediaTimeOriginUnixMs,
		snapshot.isFinal,
		comparableSeconds(snapshot.analyzedStartTimeSeconds),
		comparableSeconds(snapshot.analyzedEndTimeSeconds),
		snapshot.metadata.version,
		snapshot.metadata.disclaimer,
		snapshot.observations
			.map((item) => JSON.stringify([item.id, observationContent(item)]))
			.sort(),
		snapshot.keyMoments
			.map((item) =>
				JSON.stringify([
					item.id,
					item.lastUpdatedSequence,
					momentContent(item),
				]),
			)
			.sort(),
		snapshot.sourceGaps
			.map((item) =>
				JSON.stringify([
					comparableSeconds(item.startTimeSeconds),
					comparableSeconds(item.endTimeSeconds),
					item.reason,
				]),
			)
			.sort(),
	]);
}

/** Throws before modifying the retained state when a newer result breaks its contract. */
export function applyAisaSnapshot(
	previous: AisaSnapshotState | null,
	next: unknown,
): AisaSnapshotState {
	const snapshot = aisaResultSchema.parse(next);
	if (previous) {
		const old = previous.snapshot;
		if (
			snapshot.analysisId !== old.analysisId ||
			snapshot.encodingId !== old.encodingId ||
			snapshot.mediaTimeOriginUnixMs !== old.mediaTimeOriginUnixMs
		)
			throw new Error("Analysis identity or media origin changed");
		if (snapshot.sequence < old.sequence) return previous;
		if (snapshot.sequence === old.sequence) {
			if (snapshotContent(snapshot) !== snapshotContent(old)) {
				throw new Error("An immutable analysis result changed");
			}
			return previous;
		}
		if (old.isFinal) throw new Error("A result followed finality");
		if (
			comparableSeconds(snapshot.analyzedStartTimeSeconds) !==
				comparableSeconds(old.analyzedStartTimeSeconds) ||
			comparableSeconds(snapshot.analyzedEndTimeSeconds) <
				comparableSeconds(old.analyzedEndTimeSeconds)
		)
			throw new Error("Analyzed coverage regressed");
	}

	const knownObservations = new Map(previous?.knownObservations);
	const knownKeyMoments = new Map(previous?.knownKeyMoments);
	const activeObservations = new Set(
		previous?.snapshot.observations.map((item) => item.id),
	);
	const activeMoments = new Set(
		previous?.snapshot.keyMoments.map((item) => item.id),
	);
	for (const item of snapshot.observations) {
		const content = observationContent(item);
		const known = knownObservations.get(item.id);
		if (
			known !== undefined &&
			(!activeObservations.has(item.id) || known !== content)
		) {
			throw new Error("An observation identity was reused or mutated");
		}
		knownObservations.set(item.id, content);
	}
	for (const item of snapshot.keyMoments) {
		const content = momentContent(item);
		const known = knownKeyMoments.get(item.id);
		// A complete prior snapshot also proves that an unseen older revision
		// was absent. Skipped polls cannot make that withdrawn identity valid.
		if (
			!known &&
			previous &&
			item.lastUpdatedSequence <= previous.snapshot.sequence
		) {
			throw new Error("A key moment revision predates its first appearance");
		}
		if (
			known &&
			(!activeMoments.has(item.id) ||
				(content === known.content
					? item.lastUpdatedSequence !== known.sequence
					: item.lastUpdatedSequence <= (previous?.snapshot.sequence ?? 0)))
		)
			throw new Error(
				"A key moment identity or revision was reused or mutated",
			);
		knownKeyMoments.set(item.id, {
			content,
			sequence: item.lastUpdatedSequence,
		});
	}
	return { snapshot, knownObservations, knownKeyMoments };
}
