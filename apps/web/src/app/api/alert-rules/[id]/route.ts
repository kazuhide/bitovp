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

/** Enable/disable is the reversible edit; everything else is create+delete. */
const patchSchema = z.strictObject({ enabled: z.boolean() });

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
		const { count } = await ctx.prisma.alertRule.updateMany({
			where: { id },
			data: { enabled: parsed.data.enabled },
		});
		if (count === 0) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, enabled: parsed.data.enabled });
	} catch (err) {
		return routeError(err);
	}
}

/** Deletes the rule AND (by FK cascade) its event history — the UI warns. */
export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const { count } = await ctx.prisma.alertRule.deleteMany({
			where: { id },
		});
		if (count === 0) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, deleted: true });
	} catch (err) {
		return routeError(err);
	}
}
