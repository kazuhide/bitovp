import {
	canonicalEditingJson,
	cfrTimeMapSchema,
	type EditingMediaStorage,
	type EditingNormalizationEvidence,
	type EditingObject,
	hashEditingEvidence,
	normalizationCaptureReceiptSchema,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { EditingMediaFacts } from "./media";
import { MediaOperationError } from "./process";

const json = (input: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue;

/** Receipt creation rolls back with a lost lease or failed READY update. */
export async function persistPreparedMedia(input: {
	prisma: AppPrismaClient;
	mediaVersionId: string;
	sourceId: string;
	organizationId: string;
	leaseToken: string;
	now: () => Date;
	storage: EditingMediaStorage;
	prepared: EditingObject;
	facts: EditingMediaFacts;
	normalization: EditingNormalizationEvidence;
	signal?: AbortSignal;
}) {
	input.signal?.throwIfAborted();
	const n = input.normalization,
		facts = input.facts;
	const timeMap = cfrTimeMapSchema.parse({
		id: input.mediaVersionId,
		mediaVersionId: input.mediaVersionId,
		kind: "CFR",
		sourceStartUs: n.sourceStartUs,
		sourceEndUs: n.sourceEndUs,
		editingStartFrame: 0,
		editingEndFrame: facts.frameCount,
		fps: facts.fps,
	});
	const receipt = normalizationCaptureReceiptSchema.parse({
		...n,
		organizationId: input.organizationId,
		sourceId: input.sourceId,
		mediaVersionId: input.mediaVersionId,
		timeMapId: timeMap.id,
	});
	if (
		n.preparedBytes !== input.prepared.size ||
		n.output.width !== facts.width ||
		n.output.height !== facts.height ||
		n.output.frameCount !== facts.frameCount ||
		n.output.hasAudio !== facts.hasAudio ||
		n.output.durationUs !== facts.durationUs
	)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	const proofHash = hashEditingEvidence(receipt);
	await input.prisma.$transaction(async (tx) => {
		const ready = await tx.libraryMediaVersion.updateMany({
			where: {
				id: input.mediaVersionId,
				state: "RUNNING",
				leaseToken: input.leaseToken,
				leaseUntil: { gt: input.now() },
			},
			data: {
				state: "READY",
				sha256: n.preparedSha256,
				durationUs: BigInt(facts.durationUs),
				width: facts.width,
				height: facts.height,
				fpsNum: facts.fps.num,
				fpsDen: facts.fps.den,
				storage: json({ ...input.storage, prepared: input.prepared }),
				timeMap: json(timeMap),
				probe: json(facts.probe),
				leaseToken: null,
				leaseUntil: null,
				error: null,
			},
		});
		if (!ready.count) throw new MediaOperationError("LEASE_LOST");
		input.signal?.throwIfAborted();
		const existing = await tx.libraryEvidenceReceipt.findMany({
			where: {
				organizationId: input.organizationId,
				kind: "NORMALIZATION_CAPTURE",
				mediaVersionId: input.mediaVersionId,
			},
			take: 2,
		});
		if (existing.length) {
			if (
				existing.length !== 1 ||
				existing[0]?.proofHash !== proofHash ||
				canonicalEditingJson(existing[0].proof) !==
					canonicalEditingJson(receipt)
			)
				throw new MediaOperationError("SOURCE_UNVERIFIED");
			input.signal?.throwIfAborted();
			return;
		}
		const stored = await tx.libraryEvidenceReceipt.create({
			data: {
				organizationId: input.organizationId,
				kind: "NORMALIZATION_CAPTURE",
				sourceId: input.sourceId,
				mediaVersionId: input.mediaVersionId,
				proof: json(receipt),
				proofHash,
			},
		});
		if (
			stored.proofHash !== proofHash ||
			canonicalEditingJson(stored.proof) !== canonicalEditingJson(receipt)
		)
			throw new MediaOperationError("SOURCE_UNVERIFIED");
		input.signal?.throwIfAborted();
	});
	return timeMap;
}
