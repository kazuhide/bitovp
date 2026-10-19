import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { vmafExportStream } from "@/lib/server/vmaf-export";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
	format: z.enum(["json", "csv"]).default("json"),
	/** Optional: a single VmafResult id to export instead of the whole job. */
	result: z.uuid().optional(),
});

/**
 * FULL per-frame export (the export requirement) — NOT downsampled. Gunzips
 * each result's framesGzip and emits either:
 *   - JSON: `[{ rendition, results: [{ id, renditionRef, frames }] }]`-shaped
 *     job document (frames carry psnr when the run computed it), or
 *   - CSV: `rendition,frameNum,vmaf,psnr` rows across every rendition. The psnr
 *     column is always present in the header; it is empty for frames/runs
 *     without PSNR (so the column layout is stable across mixed jobs).
 * Pass `?result=<uuid>` to scope to one rendition. Served as a file download.
 */
export async function GET(req: Request, { params }: RouteParams) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		format: url.searchParams.get("format") ?? undefined,
		result: url.searchParams.get("result") ?? undefined,
	});
	if (!parsed.success) {
		return jsonError(400, "Invalid export parameters");
	}
	const { format, result: resultId } = parsed.data;

	try {
		const ctx = await getServerContext();
		const job = await ctx.prisma.vmafJob.findUnique({
			where: { id },
			select: {
				id: true,
				model: true,
				results: {
					orderBy: { createdAt: "asc" },
					...(resultId ? { where: { id: resultId } } : {}),
					select: { id: true, renditionRef: true },
				},
			},
		});
		if (!job) {
			return jsonError(404, "Not found");
		}

		const stem = `vmaf-${job.id}${resultId ? `-${resultId}` : ""}`;
		const stream = vmafExportStream(
			job,
			format,
			async (resultId, signal) => {
				signal.throwIfAborted();
				const result = await ctx.prisma.vmafResult.findFirst({
					where: { id: resultId, vmafJobId: id },
					select: { framesGzip: true },
				});
				signal.throwIfAborted();
				if (!result) throw new Error("VMAF result is no longer available");
				return result.framesGzip;
			},
			req.signal,
		);
		return new NextResponse(stream, {
			status: 200,
			headers: {
				"content-type":
					format === "csv"
						? "text/csv; charset=utf-8"
						: "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="${stem}.${format}"`,
			},
		});
	} catch (err) {
		return routeError(err);
	}
}
