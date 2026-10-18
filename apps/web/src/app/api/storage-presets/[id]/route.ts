import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		await ctx.prisma.storageLocationPreset.delete({ where: { id } });
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		return routeError(err);
	}
}
