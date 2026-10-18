import { watchObjectExtension } from "@bitovp/core";
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

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.strictObject({ objectId: z.uuid() });

function isP2002(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === "P2002"
	);
}

/**
 * Re-arm : re-encode an already-processed
 * object WITHOUT waiting for a content change — a NEW row whose contentId
 * carries a bump suffix, so the unique key admits it and the ordinary
 * SEEN→STABLE→SUBMITTED machinery runs. Created STABLE directly: the
 * original row already proved stability, and the operator asked NOW.
 *
 * review-87b hardening — this route spends money, so it refuses:
 * - a DISABLED rule (the sweep would silently never pick the row up, N-7);
 * - an object the rule's extension allowlist excludes (C-2 — re-arm must
 *   not launder a SKIPPED sidecar file into a paid encoding; same helper
 *   as the sweep, so the two checks cannot drift);
 * - a key that already has a pending or in-flight row (C-1 — the second
 *   click of a double-click gets 409, not a second encoding). The sweep's
 *   per-key serialization backstops the remaining concurrent-create race.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const rule = await ctx.prisma.watchRule.findUnique({
			where: { id },
			select: { enabled: true, extensions: true },
		});
		if (!rule) {
			return jsonError(404, "Not found");
		}
		if (!rule.enabled) {
			return jsonError(
				409,
				"Rule is disabled — the sweep would never pick the re-armed row up. Enable the rule first.",
			);
		}
		const source = await ctx.prisma.watchedObject.findFirst({
			where: { id: parsed.data.objectId, watchRuleId: id },
		});
		if (!source) {
			return jsonError(404, "Not found");
		}
		const extension = watchObjectExtension(source.objectKey);
		if (rule.extensions.length > 0 && !rule.extensions.includes(extension)) {
			return jsonError(
				422,
				`Extension "${extension || "(none)"}" is outside this rule's allowlist — re-arm would encode an object the rule was told to skip`,
			);
		}
		const pending = await ctx.prisma.watchedObject.findFirst({
			where: {
				watchRuleId: id,
				objectKey: source.objectKey,
				OR: [
					{ state: { in: ["SEEN", "STABLE"] } },
					{ state: "SUBMITTED", encodingJobId: null },
					{
						state: "SUBMITTED",
						encodingJob: { is: { status: { in: ["QUEUED", "RUNNING"] } } },
					},
				],
			},
			select: { id: true, state: true },
		});
		if (pending) {
			return jsonError(
				409,
				`This object already has a ${pending.state} row pending or in flight — re-arming again would bill twice for one file`,
			);
		}
		const bumped = await ctx.prisma.watchedObject.create({
			data: {
				watchRuleId: id,
				objectKey: source.objectKey,
				contentId: `${source.contentId}#rearm-${Date.now()}`,
				state: "STABLE",
				size: source.size,
				mtimeMs: source.mtimeMs,
				stableCount: source.stableCount,
			},
		});
		return NextResponse.json(
			{ id: bumped.id, objectKey: bumped.objectKey, state: bumped.state },
			{ status: 201 },
		);
	} catch (err) {
		// N-10: two re-arms in the same millisecond collide on the unique key
		// — that is the dedup doing its job, not a server fault.
		if (isP2002(err)) {
			return jsonError(409, "An identical re-arm just landed — not repeated");
		}
		return routeError(err);
	}
}
