import {
	createLivePresetSchema,
	createPlanPresetSchema,
	planHasErrors,
	templateKindSchema,
	validateLiveChannel,
	validatePlan,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { serverPlanValidationOptions } from "@/lib/server/plan-validation";

/**
 * User plan presets  — `Preset` rows with
 * `kind: "FULL_PLAN"` whose `body` is an EncodingPlan JSON. Secret-free by
 * construction (credentials are `credentialId` refs; no keys in the plan), so
 * list/create/return of `body` is safe. Mirrors the storage-presets CRUD.
 */

/** Lean list: id/name/description/createdAt only — never the full plan body.
 *  `?kind=LIVE_PLAN` lists live templates ; the default stays
 *  FULL_PLAN so every pre-PR4 consumer (wizard panel, watch-rule picker,
 *  my-presets) keeps its exact contract. */
export async function GET(req: Request) {
	const kindParam = new URL(req.url).searchParams.get("kind");
	const kind = kindParam
		? templateKindSchema.safeParse(kindParam)
		: { success: true as const, data: "FULL_PLAN" as const };
	if (!kind.success) {
		return jsonError(400, "kind must be FULL_PLAN or LIVE_PLAN");
	}
	try {
		const ctx = await getServerContext();
		const presets = await ctx.prisma.preset.findMany({
			where: { kind: kind.data },
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				createdAt: true,
				revision: true,
				updatedAt: true,
				// Uses = a COUNT over provenance + watch rules
				// — never a stored counter, which drifts.
				_count: {
					select: {
						encodingJobs: true,
						liveChannels: true,
						watchRules: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
		});
		return NextResponse.json(presets);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const raw = await readJson(req);
	// Kind peek : LIVE_PLAN saves come from the channel
	// detail; everything else is the original FULL_PLAN contract, untouched.
	const kindPeek = (raw as { kind?: unknown } | null)?.kind;
	if (kindPeek === "LIVE_PLAN") {
		const parsedLive = createLivePresetSchema.safeParse(raw);
		if (!parsedLive.success) {
			return validationError(parsedLive.error);
		}
		// The live openability gate, mirroring the FULL_PLAN PRESET-SAVE rule:
		// a template the live form could not start is refused at save.
		if (
			planHasErrors(
				validateLiveChannel(
					parsedLive.data.plan,
					serverPlanValidationOptions(),
				),
			)
		) {
			return jsonError(400, "Live channel plan has validation errors");
		}
		try {
			const ctx = await getServerContext();
			const preset = await ctx.prisma.preset.create({
				data: {
					kind: "LIVE_PLAN",
					name: parsedLive.data.name,
					description: parsedLive.data.description ?? null,
					body: parsedLive.data.plan,
				},
				select: {
					id: true,
					name: true,
					description: true,
					category: true,
					createdAt: true,
					revision: true,
					updatedAt: true,
				},
			});
			return NextResponse.json(preset, { status: 201 });
		} catch (err) {
			if ((err as { code?: string }).code === "P2002") {
				return jsonError(409, "A preset with that name exists");
			}
			return routeError(err);
		}
	}
	const parsed = createPlanPresetSchema.safeParse(raw);
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	// Reject plans that fail cross-field constraints (C1–C11 / structural) —
	// the schema parse above only covers shape. A saved preset must be a plan
	// the wizard could actually start.
	if (
		planHasErrors(validatePlan(parsed.data.plan, serverPlanValidationOptions()))
	) {
		return jsonError(400, "Plan has validation errors");
	}
	try {
		const ctx = await getServerContext();
		const preset = await ctx.prisma.preset.create({
			data: {
				kind: "FULL_PLAN",
				name: parsed.data.name,
				description: parsed.data.description ?? null,
				// Delivery presets : body stays the BARE plan (the
				// userPreset wizard load parses it as such); the constraints
				// table + advisory gate ride the spec column beside it.
				category: parsed.data.category ?? null,
				spec: (parsed.data.spec ?? undefined) as
					| Prisma.InputJsonValue
					| undefined,
				body: parsed.data.plan,
			},
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				createdAt: true,
				revision: true,
				updatedAt: true,
			},
		});
		return NextResponse.json(preset, { status: 201 });
	} catch (err) {
		// @@unique([kind, name]) collision → P2002.
		if ((err as { code?: string }).code === "P2002") {
			return jsonError(409, "A preset with that name exists");
		}
		return routeError(err);
	}
}
