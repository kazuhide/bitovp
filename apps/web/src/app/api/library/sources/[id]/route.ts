import { NextResponse } from "next/server";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse } from "@/lib/server/http";
import { libraryRoute, sourceView } from "@/lib/server/library";
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		return NextResponse.json(
			await sourceView(ctx.prisma, id, requestOrganizationId(ctx)),
		);
	});
}
