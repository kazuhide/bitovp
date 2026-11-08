import "server-only";
import { createHash } from "node:crypto";
import {
	encodingPlanSchema,
	manifestPlaybackLinks,
	vmafSourceFor,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { AutomaticEditingOutput } from "./library-editing-context";

export type EditingHlsOutput = AutomaticEditingOutput & {
	kind: "HLS";
	hlsRootPrefix: string;
};

/** Derive private storage coordinates only from the identical finished encoding plan. */
export async function libraryEditingHlsOutputs(
	prisma: Pick<AppPrismaClient, "encodingJob">,
	source: {
		organizationId: string;
		sourceKind: string;
		encodingId: string | null;
		jobId: string | null;
		originalJobId: string | null;
	},
	snapshot: { kind: string; planHash: string },
	organizationId: string,
): Promise<EditingHlsOutput[]> {
	const jobId = source.jobId ?? source.originalJobId;
	if (
		source.organizationId !== organizationId ||
		source.sourceKind !== "VOD_JOB" ||
		snapshot.kind !== "VOD_JOB" ||
		!source.encodingId ||
		!jobId
	)
		return [];
	const job = await prisma.encodingJob.findUnique({
		where: { id: jobId },
		select: {
			organizationId: true,
			bitmovinEncodingId: true,
			status: true,
			plan: true,
		},
	});
	if (
		!job ||
		job.organizationId !== organizationId ||
		job.bitmovinEncodingId !== source.encodingId ||
		job.status !== "FINISHED" ||
		createHash("sha256").update(JSON.stringify(job.plan)).digest("hex") !==
			snapshot.planHash
	)
		return [];
	const parsed = encodingPlanSchema.safeParse(job.plan);
	if (!parsed.success) return [];
	const plan = parsed.data,
		links = manifestPlaybackLinks(plan, []);
	return plan.manifests.flatMap((manifest) => {
		if (manifest.kind !== "HLS" || manifest.drmKind) return [];
		const output = plan.outputs.find(
			(candidate) => candidate.key === manifest.destination.outputKey,
		);
		if (!output) return [];
		const locator = vmafSourceFor(output);
		if (!locator.streamable) return [];
		const link = links.find(
			(candidate) => candidate.key === manifest.key && candidate.kind === "HLS",
		);
		if (!link) return [];
		const root = manifest.destination.path.replace(/\/+$/, "");
		const safe = (path: string) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!/[?#]/.test(path) &&
			[...path].every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
			) &&
			!/^[a-z][a-z0-9+.-]*:/i.test(path) &&
			!path.split("/").some((part) => part === "." || part === "..");
		if (
			!safe(root) ||
			!safe(link.path) ||
			(root && !link.path.startsWith(`${root}/`))
		)
			return [];
		const key = `hls:${manifest.key}`;
		if (key.length > 160) return [];
		return [
			{
				key,
				kind: "HLS" as const,
				credentialId: locator.credentialId,
				bucket: locator.bucket,
				path: link.path,
				hlsRootPrefix: root,
			},
		];
	});
}
