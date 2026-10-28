import { contentRegisterSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { requestOrganizationId } from "@/lib/passive-request";
import { actorFrom, writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { readJson } from "@/lib/server/http";
import {
	libraryRoute,
	listContents,
	listQuery,
	registerContent,
} from "@/lib/server/library";

export async function GET(req: Request) {
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		return NextResponse.json(
			await listContents(
				ctx.prisma,
				listQuery.parse(Object.fromEntries(new URL(req.url).searchParams)),
				requestOrganizationId(ctx),
			),
		);
	});
}
export async function POST(req: Request) {
	return libraryRoute(async () => {
		const input = contentRegisterSchema.parse(await readJson(req));
		const ctx = await getServerContext();
		const id = await registerContent(ctx.prisma, input, actorFrom(req));
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: new URL(req.url).pathname,
				statusCode: 201,
				response: { contentId: id, sourceId: input.sourceId },
			},
			req,
		);
		return NextResponse.json({ id }, { status: 201 });
	});
}
