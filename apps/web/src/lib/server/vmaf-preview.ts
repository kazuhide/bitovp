import "server-only";
import {
	encodingPlanSchema,
	enumerateQcTargets,
	vmafSourceFor,
} from "@bitovp/core";
import { z } from "zod";
import type { VmafResultDetail } from "@/app/qc/vmaf-shared";

type PreviewJob = {
	mode: string;
	params: unknown;
	encodingJob?: { plan: unknown } | null;
};
type PreviewResult = { id: string; renditionRef: unknown; provenance: unknown };
type Unavailable = Extract<
	NonNullable<VmafResultDetail["preview"]>,
	{ unavailableReason: string }
>;
const recorded = z.object({
	distorted: z
		.object({
			bucket: z.string().min(1),
			key: z.string().min(1),
			pinned: z.literal(true),
			bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			identity: z
				.object({
					size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
					etag: z.string().min(1).optional(),
					versionId: z.string().min(1).optional(),
					generation: z.string().min(1).optional(),
				})
				.refine((v) =>
					Boolean(
						v.etag || (v.versionId && v.versionId !== "null") || v.generation,
					),
				),
		})
		.refine((v) => v.bytes === v.identity.size),
});
type Target = {
	credentialId: string;
	bucket: string;
	key: string;
	size: number;
	expect: z.infer<typeof recorded>["distorted"]["identity"];
	contentType: string;
};
const unavailable = (
	unavailableReason: Unavailable["unavailableReason"],
): Unavailable => ({ unavailableReason });

/** Bind a recorded measurement to the compiler-selected output, never any other output. */
export function resolveVmafPreview(
	job: PreviewJob,
	result: PreviewResult,
): Target | Unavailable {
	if (job.mode === "LIVE") return unavailable("LIVE_CAPTURE_NOT_RETAINED");
	if (job.mode !== "VOD") return unavailable("UNSUPPORTED_SOURCE");
	if (
		!z
			.object({ reference: z.object({ fps: z.number().finite().positive() }) })
			.safeParse(job.params).success
	)
		return unavailable("MISSING_FPS");
	const provenance = recorded.safeParse(result.provenance);
	if (!provenance.success) return unavailable("MISSING_PROVENANCE");
	const plan = encodingPlanSchema.safeParse(job.encodingJob?.plan);
	const ref = z
		.object({
			renditionKey: z.string(),
			perTitleVariant: z.string().optional(),
		})
		.safeParse(result.renditionRef);
	if (!plan.success || !ref.success) return unavailable("UNSUPPORTED_SOURCE");
	const target = enumerateQcTargets(plan.data).find(
		(t) => t.renditionKey === ref.data.renditionKey,
	);
	const output = plan.data.outputs.find(
		(o) => o.key === target?.distorted.outputKey,
	);
	if (!target || !output) return unavailable("UNSUPPORTED_SOURCE");
	const source = vmafSourceFor(output);
	const actual = provenance.data.distorted;
	const template = target.distorted.path.split("/");
	const parts = actual.key.split("/");
	const variants = template.flatMap((p, i) =>
		p.includes("{") ? [parts[i]] : [],
	);
	// Captured results use the first placeholder segment (perTitleVariantFromPath);
	// legacy listing results join all placeholder segments (buildKeyMatcher).
	// The full stored key, output and version remain independently pinned below.
	if (
		!source.streamable ||
		source.bucket !== actual.bucket ||
		template.length !== parts.length ||
		!template.every((p, i) =>
			p.includes("{")
				? Boolean(
						parts[i] &&
							parts[i] !== "." &&
							parts[i] !== ".." &&
							!/[{}\\]/.test(parts[i] ?? ""),
					)
				: p === parts[i],
		) ||
		(variants.length
			? variants[0] !== ref.data.perTitleVariant &&
				variants.join("/") !== ref.data.perTitleVariant
			: ref.data.perTitleVariant !== undefined)
	)
		return unavailable("UNSUPPORTED_SOURCE");
	const contentType = actual.key.endsWith(".mp4")
		? "video/mp4"
		: actual.key.endsWith(".webm")
			? "video/webm"
			: null;
	if (!contentType) return unavailable("UNSUPPORTED_SOURCE");
	return {
		credentialId: source.credentialId,
		bucket: source.bucket,
		key: actual.key,
		size: actual.bytes,
		expect: actual.identity,
		contentType,
	};
}

export function previewDescriptor(
	id: string,
	job: PreviewJob,
	result: PreviewResult,
): NonNullable<VmafResultDetail["preview"]> {
	const target = resolveVmafPreview(job, result);
	return "unavailableReason" in target
		? target
		: { url: `/api/vmaf-jobs/${id}/preview?resultId=${result.id}` };
}

export { serveObjectPreview as serveVmafPreview } from "./object-preview";
