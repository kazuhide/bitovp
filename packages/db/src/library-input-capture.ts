import {
	encodingPlanSchema,
	hashEditingEvidence,
	type PinnedInputCapture,
	pinnedInputCaptureSchema,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "./client";

export type CapturedOriginalInput = {
	receiptId: string;
	storage: PinnedInputCapture["storage"];
	sourceFacts: PinnedInputCapture["sourceFacts"];
	label: string;
	/** Server-only lineage used by the authoritative importer. */
	proof: PinnedInputCapture;
	providerInputId: string;
	ingestStreamId: string;
};
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const isUuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);

/** Only a finished job's actual DONE ingest witness can expose a captured original. */
export async function listCapturedOriginalInputs(input: {
	prisma: AppPrismaClient | AppTransactionClient;
	organizationId: string;
	sourceId: string;
}): Promise<CapturedOriginalInput[]> {
	const source = await input.prisma.librarySource.findUnique({
		where: { id: input.sourceId },
	});
	if (
		!source ||
		source.organizationId !== input.organizationId ||
		source.sourceKind !== "VOD_JOB"
	)
		return [];
	const jobId = source.originalJobId ?? source.jobId;
	if (!jobId || !source.encodingId || !source.accountId) return [];
	const job = await input.prisma.encodingJob.findUnique({
		where: { id: jobId },
	});
	if (
		!job ||
		job.organizationId !== input.organizationId ||
		job.status !== "FINISHED" ||
		job.bitmovinEncodingId !== source.encodingId ||
		job.bitmovinAccountId !== source.accountId
	)
		return [];
	const plan = encodingPlanSchema.safeParse(job.plan);
	const steps = stepLogSchema.safeParse(job.stepLog);
	if (!plan.success || !steps.success) return [];
	const p = plan.data;
	if (
		!p.aiSceneAnalysis ||
		p.ingest.length !== 1 ||
		(p.encodings?.length ?? 1) !== 1 ||
		p.trimmingStreams.length ||
		p.concatenationStreams.length ||
		p.audioMixStreams.length ||
		p.dolbyStreams.length ||
		p.fileStreams.length ||
		p.filters.length
	)
		return [];
	const ingest = p.ingest[0];
	if (ingest?.selectionMode !== "VIDEO_RELATIVE" || ingest.position !== 0)
		return [];
	const origin = p.inputs.find((entry) => entry.key === ingest.inputKey);
	if (!origin || !("credentialId" in origin) || !("bucket" in origin))
		return [];
	const receipts = await input.prisma.libraryEvidenceReceipt.findMany({
		where: {
			organizationId: input.organizationId,
			jobId,
			encodingId: source.encodingId,
			kind: "INPUT_CAPTURE",
		},
		orderBy: { createdAt: "asc" },
		take: 101,
	});
	if (receipts.length > 100) throw new Error("INPUT_CAPTURE_LIMIT");
	const result: CapturedOriginalInput[] = [];
	for (const row of receipts) {
		const parsed = pinnedInputCaptureSchema.safeParse(row.proof);
		if (
			!parsed.success ||
			row.proofHash !== hashEditingEvidence(row.proof) ||
			row.organizationId !== input.organizationId ||
			row.jobId !== jobId ||
			row.encodingId !== source.encodingId
		)
			continue;
		const proof = parsed.data;
		if (
			proof.organizationId !== input.organizationId ||
			proof.jobId !== jobId ||
			proof.encodingId !== source.encodingId ||
			proof.planHash !== hashEditingEvidence(job.plan) ||
			proof.ingestKey !== ingest.key ||
			proof.storage.credentialId !== origin.credentialId ||
			proof.storage.bucket !== origin.bucket ||
			proof.storage.key !== ingest.inputPath.replace(/^\/+/, "")
		)
			continue;
		const witnesses = steps.data.filter(
			(step) =>
				step.step === `ingest:${ingest.key}` &&
				step.kind === "CREATE_INGEST_INPUT_STREAM" &&
				step.status === "DONE" &&
				object(step.response).inputReceiptId === row.id &&
				object(step.request).inputPath === ingest.inputPath &&
				object(step.request).selectionMode === ingest.selectionMode &&
				object(step.request).position === ingest.position &&
				object(object(step.request).refs).encodingId === source.encodingId &&
				object(step.response).id === step.resourceId &&
				isUuid(step.resourceId) &&
				isUuid(object(step.response).providerInputId),
		);
		if (witnesses.length !== 1) continue;
		const witness = witnesses[0];
		if (!witness?.resourceId) continue;
		result.push({
			receiptId: row.id,
			storage: proof.storage,
			sourceFacts: proof.sourceFacts,
			label: "Captured original input",
			proof,
			providerInputId: String(object(witness.response).providerInputId),
			ingestStreamId: witness.resourceId,
		});
	}
	return result;
}

export async function resolveCapturedOriginalInput(input: {
	prisma: AppPrismaClient | AppTransactionClient;
	organizationId: string;
	sourceId: string;
	receiptId: string;
}): Promise<CapturedOriginalInput | null> {
	return (
		(await listCapturedOriginalInputs(input)).find(
			(entry) => entry.receiptId === input.receiptId,
		) ?? null
	);
}
