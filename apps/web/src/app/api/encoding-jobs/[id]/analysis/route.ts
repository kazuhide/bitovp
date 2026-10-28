import { encodingPlanSchema } from "@bitovp/core";
import { requestLibrarySource } from "@bitovp/db";
import { NextResponse } from "next/server";
import type { JobAnalysisResponse } from "@/lib/job-analysis";
import { requestOrganizationId } from "@/lib/passive-request";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError } from "@/lib/server/http";
import { libraryRoute, sourceView } from "@/lib/server/library";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		const { prisma } = ctx;
		const job = await prisma.encodingJob.findUnique({
			where: { id },
			select: {
				plan: true,
				bitmovinEncodingId: true,
				libraryCaptureSuppressed: true,
			},
		});
		if (!job) return jsonError(404, "Not found");
		const plan = encodingPlanSchema.safeParse(job.plan);
		const source = await prisma.librarySource.findFirst({
			where: { jobId: id, encodingId: job.bitmovinEncodingId ?? "" },
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});
		return NextResponse.json({
			enabled: !!(plan.success && plan.data.aiSceneAnalysis),
			captureSuppressed: job.libraryCaptureSuppressed,
			source: source
				? await sourceView(prisma, source.id, requestOrganizationId(ctx))
				: null,
		} satisfies JobAnalysisResponse);
	});
}

export async function POST(req: Request, { params }: Params) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		const source = await requestLibrarySource(ctx.prisma, id, {
			explicit: true,
		});
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: new URL(req.url).pathname,
				statusCode: 202,
				response: { sourceId: source.id },
			},
			req,
		);
		return NextResponse.json({ sourceId: source.id }, { status: 202 });
	});
}
