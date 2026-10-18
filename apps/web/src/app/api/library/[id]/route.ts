import { contentUpdateSchema } from "@bitovp/core";
import { actorFrom, writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, readJson } from "@/lib/server/http";
import { libraryRoute, readContent, updateContent } from "@/lib/server/library";

type Params = { params: Promise<{ id: string }> };
export async function GET(_req: Request, { params }: Params) {
	const { id } = await params;
	return invalidIdResponse(id) ?? libraryRoute(() => readContent(id));
}
export async function PATCH(req: Request, { params }: Params) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	return libraryRoute(async () => {
		const input = contentUpdateSchema.parse(await readJson(req));
		const ctx = await getServerContext();
		await updateContent(ctx.prisma, id, input, actorFrom(req));
		await writeAuditLog(
			ctx,
			{
				method: "PATCH",
				path: new URL(req.url).pathname,
				statusCode: 200,
				response: { contentId: id, revision: input.expectedRevision + 1 },
			},
			req,
		);
		return readContent(id);
	});
}
