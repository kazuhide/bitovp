import {
	audioCopyIdentitySchema,
	audioCopyRendition,
	type EncodingPlan,
	verifiedAudioTracks,
} from "@bitovp/core";
import type { AppPrismaClient } from "./client";

/** Only the inspector can attest an immutable source version and its selected track. */
export async function resolveInspectedAudioSource(
	prisma: AppPrismaClient,
	organizationId: string,
	plan: EncodingPlan,
) {
	const copy = audioCopyRendition(plan);
	const ingest = plan.ingest.find((row) => row.key === copy?.ingestKey);
	const origin = plan.inputs.find((row) => row.key === ingest?.inputKey);
	if (
		!copy ||
		!ingest ||
		ingest.selectionMode !== "AUDIO_RELATIVE" ||
		!origin ||
		!("bucket" in origin) ||
		!("credentialId" in origin)
	)
		throw new Error("AUDIO_COPY_INPUT_UNVERIFIED");
	const key = ingest.inputPath.replace(/^\/+/, "");
	const row = await prisma.storageInspection.findFirst({
		where: {
			id: copy.inspectionId,
			organizationId,
			credentialId: origin.credentialId,
			bucket: origin.bucket,
			objectKey: key,
			status: "FINISHED",
			verifyAudioCopy: true,
		},
		select: { sourceIdentity: true, probe: true },
	});
	const identity = audioCopyIdentitySchema.safeParse(row?.sourceIdentity);
	const track = verifiedAudioTracks(row?.probe).find(
		(t) => t.position === ingest.position && t.sourceCodec === copy.sourceCodec,
	);
	if (!track || !identity.success)
		throw new Error("AUDIO_COPY_INPUT_UNVERIFIED");
	const { size, ...expect } = identity.data;
	return {
		inspectionId: copy.inspectionId,
		track,
		storage: {
			credentialId: origin.credentialId,
			bucket: origin.bucket,
			key,
			size,
			expect,
		},
	};
}
