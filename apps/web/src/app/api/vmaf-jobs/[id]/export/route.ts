import { NextResponse } from "next/server";
import { z } from "zod";
import { type RenditionRef, renditionLabel } from "@/app/qc/vmaf-shared";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { decodeFrames } from "@/lib/server/vmaf-frames";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
	format: z.enum(["json", "csv"]).default("json"),
	/** Optional: a single VmafResult id to export instead of the whole job. */
	result: z.uuid().optional(),
});

/**
 * CSV-escape. Structural (RFC 4180): quote fields containing comma/quote/
 * newline, double inner quotes. Plus formula-injection defense: a field that
 * starts with = + - @ TAB or CR is prefixed with a single quote so a rendition
 * label can't execute as a formula if the CSV is opened in Excel/Sheets.
 * Only the rendition label runs through this — the frameNum/vmaf/psnr columns
 * are bare number literals (even a negative reads as a number, not a formula).
 */
function csvCell(value: string): string {
	const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(guarded)
		? `"${guarded.replace(/"/g, '""')}"`
		: guarded;
}

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
					select: { id: true, renditionRef: true, framesGzip: true },
				},
			},
		});
		if (!job) {
			return jsonError(404, "Not found");
		}

		const decoded = job.results.map((r, i) => {
			const ref = r.renditionRef as RenditionRef;
			return {
				id: r.id,
				renditionRef: ref,
				label: renditionLabel(ref, i),
				frames: r.framesGzip ? decodeFrames(r.framesGzip as Uint8Array) : [],
			};
		});

		const stem = `vmaf-${job.id}${resultId ? `-${resultId}` : ""}`;

		if (format === "csv") {
			const lines = ["rendition,frameNum,vmaf,psnr"];
			for (const r of decoded) {
				const label = csvCell(r.label);
				for (const f of r.frames) {
					// psnr column stays empty for frames without it (VMAF-only runs
					// or a mixed job) — the header is constant so the layout is stable.
					const psnr = typeof f.psnr === "number" ? f.psnr : "";
					lines.push(`${label},${f.frameNum},${f.vmaf},${psnr}`);
				}
			}
			return new NextResponse(lines.join("\n"), {
				status: 200,
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="${stem}.csv"`,
				},
			});
		}

		return new NextResponse(
			JSON.stringify(
				{
					vmafJobId: job.id,
					model: job.model,
					renditions: decoded.map((r) => ({
						id: r.id,
						label: r.label,
						renditionRef: r.renditionRef,
						frames: r.frames,
					})),
				},
				null,
				2,
			),
			{
				status: 200,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-disposition": `attachment; filename="${stem}.json"`,
				},
			},
		);
	} catch (err) {
		return routeError(err);
	}
}
