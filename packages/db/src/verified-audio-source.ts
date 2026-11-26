import {
	audioCopyIdentitySchema,
	audioCopySourceBinding,
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
	const binding = audioCopySourceBinding(plan);
	if (!binding) throw new Error("AUDIO_COPY_INPUT_UNVERIFIED");
	const row = await prisma.storageInspection.findFirst({
		where: {
			id: binding.inspectionId,
			organizationId,
			credentialId: binding.storage.credentialId,
			bucket: binding.storage.bucket,
			objectKey: binding.storage.key,
			status: "FINISHED",
			verifyAudioCopy: true,
		},
		select: { sourceIdentity: true, probe: true },
	});
	const identity = audioCopyIdentitySchema.safeParse(row?.sourceIdentity);
	const track = verifiedAudioTracks(row?.probe).find(
		(t) =>
			t.position === binding.track.position &&
			t.sourceCodec === binding.track.sourceCodec,
	);
	if (!track || !identity.success)
		throw new Error("AUDIO_COPY_INPUT_UNVERIFIED");
	const { size, ...expect } = identity.data;
	return {
		inspectionId: binding.inspectionId,
		track,
		storage: {
			...binding.storage,
			size,
			expect,
		},
	};
}
