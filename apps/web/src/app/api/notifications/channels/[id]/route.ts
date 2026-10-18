import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** One notification channel: enable/disable and delete . */

const patchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const body = patchSchema.safeParse(await req.json());
		if (!body.success) {
			return jsonError(400, "Body must be { enabled: boolean }");
		}
		const ctx = await getServerContext();
		const { count } = await ctx.prisma.notificationChannel.updateMany({
			where: { id },
			data: { enabled: body.data.enabled },
		});
		if (count === 0) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, enabled: body.data.enabled });
	} catch (err) {
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
		// deleteMany: idempotent like the other resource DELETEs; rules go with
		// the channel (FK Cascade). The credential row survives — it is vault
		// material with its own lifecycle.
		await ctx.prisma.notificationChannel.deleteMany({ where: { id } });
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		return routeError(err);
	}
}
