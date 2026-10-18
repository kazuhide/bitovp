import {
	patchLivePresetSchema,
	patchPlanPresetSchema,
	planHasErrors,
	validateLiveChannel,
	validatePlan,
	watchSelfIntersectionIssues,
	watchTemplateIssues,
} from "@bitovp/core";
import { DB_NULL } from "@bitovp/db";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { serverPlanValidationOptions } from "@/lib/server/plan-validation";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Structural JSON equality — order-insensitive for objects, sensitive for
 * arrays. Needed because the stored body round-tripped through jsonb (which
 * normalizes key order), so `JSON.stringify` equality would false-negative
 * and bump `revision` on every body-carrying PATCH.
 */
function jsonStructuralEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((v, i) => jsonStructuralEqual(v, b[i]))
		);
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		const ak = Object.keys(a);
		const bk = Object.keys(b);
		return (
			ak.length === bk.length &&
			ak.every(
				(k) =>
					Object.hasOwn(b, k) &&
					jsonStructuralEqual(
						(a as Record<string, unknown>)[k],
						(b as Record<string, unknown>)[k],
					),
			)
		);
	}
	return false;
}

/**
 * One user plan preset, full body included (for loading into the wizard). The
 * body is an EncodingPlan JSON — secret-free (credentialId refs only), so
 * returning it verbatim is safe. Scoped to `kind: FULL_PLAN` so this surface
 * only ever touches plan presets.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		// Both TEMPLATE kinds  — partial kinds stay invisible
		// to this surface. FULL_PLAN consumers are unaffected: their ids are
		// FULL_PLAN rows.
		const preset = await ctx.prisma.preset.findFirst({
			where: { id, kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
		});
		if (!preset) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json(preset);
	} catch (err) {
		return routeError(err);
	}
}

/**
 * Re-edit . Compare-and-set on `updatedAt`: the client sends
 * the row's updatedAt as it last read it; a lost race is a 409, never a
 * silent last-writer-wins. `revision` bumps only when the body CHANGES
 * (structural compare — jsonb normalized the stored key order, so stringify
 * equality would bump spuriously); metadata/launchDefaults edits never bump.
 * A body the wizard cannot re-open is refused with the same PRESET-SAVE rule
 * as POST — an uneditable template violates the feature's own requirement.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const rawBody = await readJson(req);
	try {
		const ctx = await getServerContext();
		// The row's KIND picks the schema : a LIVE_PLAN row's
		// plan field must parse as a live plan, with the live validator as its
		// openability gate. Read kind+body in one query; the CAS below still
		// closes the read-write window.
		const current = await ctx.prisma.preset.findFirst({
			where: { id, kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
			select: { body: true, kind: true },
		});
		if (!current) {
			return jsonError(404, "Not found");
		}
		const isLive = current.kind === "LIVE_PLAN";
		const parsed = (
			isLive ? patchLivePresetSchema : patchPlanPresetSchema
		).safeParse(rawBody);
		if (!parsed.success) {
			return validationError(parsed.error);
		}
		if (parsed.data.plan !== undefined) {
			const gate = isLive
				? validateLiveChannel(
						parsed.data.plan as Parameters<typeof validateLiveChannel>[0],
						serverPlanValidationOptions(),
					)
				: validatePlan(
						parsed.data.plan as Parameters<typeof validatePlan>[0],
						serverPlanValidationOptions(),
					);
			if (planHasErrors(gate)) {
				return jsonError(400, "Plan has validation errors");
			}
			/**
			 * A watch rule's self-intersection check runs when the RULE is saved
			 * and this route can move the ground
			 * under it afterwards. A preset that was a safe watch template when
			 * the rule was created can be edited here to write into the bucket
			 * and prefix that rule watches, and the sweep would then discover
			 * every encode's own output as a new source: an unbounded, billable
			 * loop, reached without touching the rule at all.
			 *
			 * So the same rule is enforced from the other side. Only rules that
			 * actually USE this preset are consulted, and the check runs against
			 * the INCOMING body.
			 */
			const watchers = await ctx.prisma.watchRule.findMany({
				where: { presetId: id },
				select: {
					name: true,
					credentialId: true,
					bucket: true,
					prefix: true,
					outputPrefixTemplate: true,
					credential: { select: { provider: true } },
				},
			});
			for (const rule of watchers) {
				const issues = watchSelfIntersectionIssues(parsed.data.plan, rule);
				if (issues.length > 0) {
					return jsonError(
						422,
						`This preset is the template for watch rule "${rule.name}", and the edit would make its outputs land where that rule watches`,
						{ issues },
					);
				}
				// Same reasoning, second rule:
				// a create-time compatibility check is bypassable by editing the
				// preset afterwards. An edit that swaps the template's input to
				// a kind substitution cannot target — or to one this rule's
				// credential cannot back — would leave the rule claiming objects
				// and failing on every one of them.
				const compat = watchTemplateIssues(parsed.data.plan, {
					// Optional: an unresolvable credential degrades to the
					// documented "caller could not resolve one" arm — the check is
					// skipped rather than crashing the edit.
					credentialProvider: rule.credential?.provider,
					// EVERY create-time template code except NOT_A_PLAN. The first
					// cut filtered to INPUT_KIND and CREDENTIAL_PROVIDER, which
					// left the bypass HALF-open: watch-rules/route.ts enforces
					// all four at create time, and INPUT_COUNT / NO_INGEST are
					// just as voidable by editing the preset afterwards. Review
					// proved it by running the route — adding a second input and
					// re-pointing an ingest stream at it (a separate audio
					// mezzanine, a perfectly valid edit) returned 200 and wrote
					// the preset, after which the rule claimed objects and failed
					// on every one with INPUT_COUNT.
					//
					// NOT_A_PLAN stays out: a LIVE_PLAN body legitimately trips
					// it, and this branch runs for plan presets of either kind.
				}).filter((i) => i.code !== "NOT_A_PLAN");
				if (compat.length > 0) {
					return jsonError(
						422,
						// The remedy, not just the diagnosis. Rule PATCH deliberately
						// cannot change credentialId/presetId (bucket/credential/preset
						// changes are a NEW rule), so an operator told only "this
						// breaks rule X" has no way to act on it from the rule side.
						`This preset is the template for watch rule "${rule.name}", and the edit would leave that rule unable to instantiate it. Either keep the preset compatible, or delete and recreate that watch rule — its credential and preset cannot be changed in place`,
						{ issues: compat },
					);
				}
			}
		}
		// The bump decision reads the CURRENT body outside the write — safe
		// because the CAS below closes the window: if the body changed after
		// this read, updatedAt moved too and the update matches zero rows.
		const bump =
			parsed.data.plan !== undefined &&
			!jsonStructuralEqual(current.body, parsed.data.plan);
		const result = await ctx.prisma.preset.updateMany({
			where: {
				id,
				kind: current.kind,
				updatedAt: new Date(parsed.data.expectedUpdatedAt),
			},
			data: {
				...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
				...(parsed.data.description !== undefined
					? { description: parsed.data.description }
					: {}),
				...(parsed.data.plan !== undefined ? { body: parsed.data.plan } : {}),
				...(parsed.data.launchDefaults !== undefined
					? {
							launchDefaults:
								parsed.data.launchDefaults === null
									? DB_NULL
									: parsed.data.launchDefaults,
						}
					: {}),
				...(bump ? { revision: { increment: 1 } } : {}),
			},
		});
		if (result.count === 0) {
			// The row existed a moment ago (read above) — zero matches means
			// updatedAt moved: a lost race. (A concurrent DELETE lands here
			// too; the client's re-GET disambiguates to 404.)
			return jsonError(
				409,
				"Preset was modified since you loaded it — reload and retry",
			);
		}
		const updated = await ctx.prisma.preset.findFirst({
			where: { id, kind: current.kind },
		});
		if (!updated) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json(updated);
	} catch (err) {
		// @@unique([kind, name]) collision on rename → P2002.
		if ((err as { code?: string }).code === "P2002") {
			return jsonError(409, "A preset with that name exists");
		}
		return routeError(err);
	}
}

export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		// deleteMany scoped to the plan kind: a 0-count means "no such plan
		// preset" but stays idempotent (DELETE never 404s here, mirroring the
		// storage-presets DELETE's fire-and-forget shape).
		await ctx.prisma.preset.deleteMany({
			where: { id, kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
		});
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		// WatchRule.preset is onDelete: Restrict — a rule without its template
		// is a broken automation, so the delete is refused, not cascaded
		// . P2003 = the FK said no.
		if ((err as { code?: string }).code === "P2003") {
			return jsonError(
				409,
				"Watch rules reference this template — delete or repoint them first",
			);
		}
		return routeError(err);
	}
}
