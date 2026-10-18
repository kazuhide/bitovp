import { watchSelfIntersectionIssues } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { watchOutputPrefixTemplateSchema } from "@/lib/watch/schemas";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Rule detail : the rule + its recent object rows with job
 * linkage — the operator's answer to "what happened to my file".
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const rule = await ctx.prisma.watchRule.findUnique({
			where: { id },
			include: {
				credential: { select: { label: true } },
				preset: { select: { name: true } },
			},
		});
		if (!rule) {
			return jsonError(404, "Not found");
		}
		const objects = await ctx.prisma.watchedObject.findMany({
			where: { watchRuleId: id },
			orderBy: { updatedAt: "desc" },
			take: 100,
			include: {
				encodingJob: { select: { id: true, status: true, name: true } },
			},
		});
		return NextResponse.json({
			...rule,
			credentialLabel: rule.credential.label,
			presetName: rule.preset.name,
			credential: undefined,
			preset: undefined,
			objects: objects.map((object) => ({
				...object,
				// BigInt cannot serialize; the UI only displays it.
				size: object.size === null ? null : Number(object.size),
			})),
		});
	} catch (err) {
		return routeError(err);
	}
}

const patchSchema = z.strictObject({
	enabled: z.boolean().optional(),
	/**
	 * : required (as literal true) to enable a rule the data
	 * reset disarmed. The reset deleted WatchedObject — the at-most-once
	 * memory — so this enable re-detects EVERYTHING under the prefix and
	 * submits billable encodings. The one-object re-arm route guards the
	 * same act three ways; the all-objects version was unguarded.
	 */
	acknowledgeRedetection: z.literal(true).optional(),
	extensions: z
		.array(z.string().min(1).max(16).toLowerCase())
		.max(20)
		.optional(),
	// review-87b I-3: the SAME refined schema as create — a PATCH must not
	// bypass the uniquifying-token requirement.
	outputPrefixTemplate: watchOutputPrefixTemplateSchema.optional(),
	labels: z.array(z.string().min(1).max(64)).max(10).optional(),
	pollIntervalSec: z.number().int().min(60).max(3_600).optional(),
	stabilityChecks: z.number().int().min(1).max(10).optional(),
	maxConcurrentJobs: z.number().int().min(1).max(20).optional(),
});

/** Reversible knobs only — bucket/credential/preset changes are a NEW rule. */
export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = patchSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const { acknowledgeRedetection, ...patch } = parsed.data;
		const data: Record<string, unknown> = { ...patch };
		/**
		 * A PATCH can move `outputPrefixTemplate`, and the create-time
		 * self-intersection check would then be bypassable by editing the rule
		 * afterwards — the same reasoning the uniquifying-token schema is
		 * shared for (review-87b I-3). Re-checked against the rule's STORED
		 * storage and preset, with the incoming template.
		 */
		if (patch.outputPrefixTemplate !== undefined) {
			const rule = await ctx.prisma.watchRule.findUnique({
				where: { id },
				select: {
					credentialId: true,
					bucket: true,
					prefix: true,
					preset: { select: { body: true } },
				},
			});
			if (!rule) {
				return jsonError(404, "Not found");
			}
			const issues = watchSelfIntersectionIssues(rule.preset.body, {
				credentialId: rule.credentialId,
				bucket: rule.bucket,
				prefix: rule.prefix,
				outputPrefixTemplate: patch.outputPrefixTemplate,
			});
			if (issues.length > 0) {
				return jsonError(422, "Preset cannot serve as a watch template", {
					issues,
				});
			}
		}
		if (patch.enabled === true) {
			const rule = await ctx.prisma.watchRule.findUnique({
				where: { id },
				select: { disarmedByResetAt: true },
			});
			if (!rule) {
				return jsonError(404, "Not found");
			}
			if (rule.disarmedByResetAt) {
				if (!acknowledgeRedetection) {
					// 409, not 400: the request is well-formed; the STATE makes
					// it billable, and the caller must say they know.
					return jsonError(
						409,
						"This rule was disarmed by the data reset, which deleted its watched-object memory. Enabling it re-detects every object under the prefix as NEW and submits an encoding for each — that is billable. Repeat with acknowledgeRedetection: true if that is what you want.",
					);
				}
				// The acknowledgement consumes the stamp: the NEXT reset stamps
				// again, and an un-stamped rule enables without ceremony.
				data.disarmedByResetAt = null;
			}
		}
		const { count } = await ctx.prisma.watchRule.updateMany({
			where: { id },
			data,
		});
		if (count === 0) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, ...patch });
	} catch (err) {
		return routeError(err);
	}
}

/** Deletes the rule + its tracking rows (Cascade); SUBMITTED JOBS remain. */
export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const { count } = await ctx.prisma.watchRule.deleteMany({ where: { id } });
		if (count === 0) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, deleted: true });
	} catch (err) {
		return routeError(err);
	}
}
