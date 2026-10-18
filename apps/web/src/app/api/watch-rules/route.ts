import { watchSelfIntersectionIssues, watchTemplateIssues } from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { watchRuleCreateSchema } from "@/lib/watch/schemas";

/**
 * Watch rules . Creation validates the preset as a watch
 * TEMPLATE (core's watchTemplateIssues — exactly one input) at the door,
 * so the sweep never discovers an unusable rule at fire time.
 */

export async function GET() {
	try {
		const ctx = await getServerContext();
		const [rules, counts] = await Promise.all([
			ctx.prisma.watchRule.findMany({
				orderBy: { createdAt: "asc" },
				include: {
					credential: { select: { label: true } },
					preset: { select: { name: true } },
				},
			}),
			ctx.prisma.watchedObject.groupBy({
				by: ["watchRuleId", "state"],
				_count: { _all: true },
			}),
		]);
		const countsByRule = new Map<string, Record<string, number>>();
		for (const row of counts) {
			const bucket = countsByRule.get(row.watchRuleId) ?? {};
			bucket[row.state] = row._count._all;
			countsByRule.set(row.watchRuleId, bucket);
		}
		return NextResponse.json(
			rules.map((rule) => ({
				...rule,
				credentialLabel: rule.credential.label,
				presetName: rule.preset.name,
				credential: undefined,
				preset: undefined,
				objectCounts: countsByRule.get(rule.id) ?? {},
			})),
		);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const parsed = watchRuleCreateSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const preset = await ctx.prisma.preset.findUnique({
			where: { id: parsed.data.presetId },
			select: { kind: true, body: true },
		});
		if (preset?.kind !== "FULL_PLAN") {
			return jsonError(422, "Preset must exist and be a FULL_PLAN preset");
		}
		// Resolved BEFORE the template checks, because one of them needs the
		// provider: a credential that cannot back the template's input kind is
		// a rule that claims objects and then fails per-object in the worker
		// (audit aa972a2 AA972-WATCH-001).
		const credential = await ctx.prisma.credential.findUnique({
			where: { id: parsed.data.credentialId },
			select: { id: true, provider: true },
		});
		if (!credential) {
			return jsonError(422, "Credential does not exist");
		}
		const templateIssues = [
			...watchTemplateIssues(preset.body, {
				credentialProvider: credential.provider,
			}),
			// The rule's own outputs must not land where it is watching
			// (audit f63f76b F63-RUN-002) — checked HERE and on the PATCH,
			// which can move outputPrefixTemplate under the watched prefix.
			...watchSelfIntersectionIssues(preset.body, parsed.data),
		];
		if (templateIssues.length > 0) {
			return jsonError(422, "Preset cannot serve as a watch template", {
				issues: templateIssues,
			});
		}
		const rule = await ctx.prisma.watchRule.create({ data: parsed.data });
		return NextResponse.json(rule, { status: 201 });
	} catch (err) {
		if (
			typeof err === "object" &&
			err !== null &&
			(err as { code?: string }).code === "P2002"
		) {
			return jsonError(409, "A watch rule with this name already exists");
		}
		return routeError(err);
	}
}
