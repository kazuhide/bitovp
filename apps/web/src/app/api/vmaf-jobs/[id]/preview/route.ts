import {
	EXPECTED_ORGANIZATION_QUERY,
	passiveOrganizationBinding,
} from "@/lib/passive-request";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError } from "@/lib/server/http";
import {
	resolveVmafPreview,
	serveVmafPreview,
} from "@/lib/server/vmaf-preview";

export const runtime = "nodejs";

/** Protected by the existing proxy's authenticated VIEWER read floor. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const finish = (response: Response) => {
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	};
	const disabled = await requireQcVmafEnabled();
	if (disabled) return finish(disabled);
	const { id } = await params;
	const query = new URL(req.url).searchParams;
	const resultId = query.get("resultId") ?? "";
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(resultId);
	if (invalid) return finish(invalid);
	if (
		[...query.keys()].some(
			(key) => key !== "resultId" && key !== EXPECTED_ORGANIZATION_QUERY,
		) ||
		query.getAll("resultId").length !== 1 ||
		passiveOrganizationBinding(new URL(req.url), req.method).kind === "invalid"
	)
		return finish(jsonError(400, "Invalid preview query"));
	try {
		const ctx = await getServerContext();
		const job = await ctx.prisma.vmafJob.findUnique({
			where: { id },
			select: {
				mode: true,
				params: true,
				encodingJob: { select: { plan: true } },
				results: {
					where: { id: resultId },
					select: { id: true, renditionRef: true, provenance: true },
				},
			},
		});
		const result = job?.results[0];
		if (!job || !result) return finish(jsonError(404, "Not found"));
		const target = resolveVmafPreview(job, result);
		if ("unavailableReason" in target)
			return finish(
				jsonError(409, "Measured media preview unavailable", {
					code: target.unavailableReason,
				}),
			);
		return finish(await serveVmafPreview(ctx, req, target));
	} catch {
		// Neither SDK messages nor stored object names cross the media boundary.
		return finish(jsonError(500, "Measured media preview unavailable"));
	}
}
