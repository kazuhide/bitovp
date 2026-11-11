import { canonicalEditingJson } from "@bitovp/core";
import {
	admitLocalStoryFlowArchiveTranscript,
	type BoundLocalStoryFlowSourceArchive,
	buildLocalStoryFlowSourceArchive,
	type LocalStoryFlowLegacyRecordPair,
	LocalStoryFlowSourceArchiveError,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	type PreparedLocalStoryFlowArchiveSource,
} from "@bitovp/core/local-story-flow-hierarchy";
import type { LocalStoryArtifactCacheRow } from "@bitovp/core/local-story-flow-server";

export type LocalStoryFlowLegacySourceRequest = ReturnType<
	typeof localStoryFlowArchivePreparationEvidence
>["transcript"];
type Lookup = (
	requests: readonly LocalStoryFlowLegacySourceRequest[],
) => Promise<readonly LocalStoryArtifactCacheRow[]>;
function fail(): never {
	throw new LocalStoryFlowSourceArchiveError();
}
const need = (ok: unknown): void => {
	if (!ok) fail();
};
const fields = [
	"id",
	"organizationId",
	"sourceId",
	"mediaVersionId",
	"analysisRevisionId",
	"kind",
	"proof",
	"proofHash",
] as const;

/** Private orchestration only. The owning DB snapshot supplies the narrow lookup. */
export async function resolveLibraryFlowSourceArchive(
	preparation: PreparedLocalStoryFlowArchiveSource,
	lookup: Lookup,
): Promise<BoundLocalStoryFlowSourceArchive> {
	const p = localStoryFlowArchivePreparationEvidence(preparation),
		scope = p.sourceTuple;
	async function batch(requests: readonly LocalStoryFlowLegacySourceRequest[]) {
		need(requests.length <= 512);
		const expected = new Map<string, LocalStoryFlowLegacySourceRequest>();
		for (const r of requests) {
			const q = {
				kind: r.kind,
				key: r.key,
				cacheHash: r.cacheHash,
				inputKeyHash: r.inputKeyHash,
				receiptId: r.receiptId,
			};
			const old = expected.get(q.receiptId);
			need(!old || canonicalEditingJson(old) === canonicalEditingJson(q));
			expected.set(q.receiptId, structuredClone(q));
		}
		const rows = await lookup(structuredClone([...expected.values()]));
		need(Array.isArray(rows) && rows.length <= expected.size);
		const found = new Map<string, LocalStoryArtifactCacheRow>();
		for (const row of rows) {
			need(
				row &&
					Object.getPrototypeOf(row) === Object.prototype &&
					Object.getOwnPropertySymbols(row).length === 0,
			);
			const d = Object.getOwnPropertyDescriptors(row);
			need(Object.keys(d).length === fields.length);
			for (const field of fields)
				need(d[field]?.enumerable && "value" in d[field]);
			const q = expected.get(row.id);
			need(
				q &&
					!found.has(row.id) &&
					row.organizationId === scope.organizationId &&
					row.sourceId === scope.sourceId &&
					row.mediaVersionId === scope.mediaVersionId &&
					row.kind === q.kind &&
					row.analysisRevisionId ===
						(q.kind === "LOCAL_STORY_TRANSCRIPT_V1"
							? null
							: scope.analysisRevisionId),
			);
			found.set(row.id, row);
		}
		return found;
	}
	function pair(
		q: LocalStoryFlowLegacySourceRequest,
		row: LocalStoryArtifactCacheRow | undefined,
	): LocalStoryFlowLegacyRecordPair {
		if (!row) fail();
		return {
			ref: {
				kind: q.kind,
				receiptId: q.receiptId,
				cacheHash: q.cacheHash,
				inputKeyHash: q.inputKeyHash,
				proofHash: row.proofHash,
			},
			row,
		};
	}
	const transcriptRows = p.hasAudio ? await batch([p.transcript]) : null;
	const transcript = admitLocalStoryFlowArchiveTranscript(
		preparation,
		transcriptRows
			? pair(p.transcript, transcriptRows.get(p.transcript.receiptId))
			: null,
	);
	const { chunks } = localStoryFlowArchiveTranscriptEvidence(transcript);
	need(chunks.length > 0 && chunks.length <= 128);
	const families = chunks.map((_, i) =>
		localStoryFlowArchiveLedgerRequests(transcript, i),
	);
	const pointerRows = await batch(families.flat());
	const selected = families.map((requests, index) => {
		const request = requests.find((q) => pointerRows.has(q.receiptId));
		if (!request) fail();
		const pointer = pair(request, pointerRows.get(request.receiptId));
		return {
			pointer,
			stageRequest: localStoryFlowArchiveLedgerStageRequest(
				transcript,
				index,
				pointer,
			),
		};
	});
	const stageRows = await batch(selected.map((s) => s.stageRequest));
	return buildLocalStoryFlowSourceArchive({
		transcript,
		ledgers: selected.map((s) => ({
			pointer: s.pointer,
			stage: pair(s.stageRequest, stageRows.get(s.stageRequest.receiptId)),
		})),
	});
}
