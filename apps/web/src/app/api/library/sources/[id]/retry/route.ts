import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError } from "@/lib/server/http";
import { libraryRoute } from "@/lib/server/library";
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		const updated = await ctx.prisma.librarySource.updateMany({
			where: { id, state: "ERROR" },
			data: {
				state: "PENDING",
				attempts: 0,
				availableAt: new Date(),
				error: null,
				leaseToken: null,
				leaseUntil: null,
			},
		});
		if (!updated.count)
			return jsonError(409, "Only a failed import can be retried");
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: new URL(req.url).pathname,
				statusCode: 202,
				response: { sourceId: id },
			},
			req,
		);
		return NextResponse.json({ sourceId: id }, { status: 202 });
	});
}
