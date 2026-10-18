import {
	USAGE_BACKFILL_SETTING_PREFIX,
	updateBitmovinAccountSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.bitmovinAccounts.get(id);
		return row ? NextResponse.json(row) : jsonError(404, "Not found");
	} catch (err) {
		return routeError(err);
	}
}

export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = updateBitmovinAccountSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.bitmovinAccounts.update(id, parsed.data);
		return NextResponse.json(row);
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
		await ctx.bitmovinAccounts.remove(id);
		await ctx.prisma.appSetting.deleteMany({
			where: { key: `${USAGE_BACKFILL_SETTING_PREFIX}${id}` },
		});
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		return routeError(err);
	}
}
