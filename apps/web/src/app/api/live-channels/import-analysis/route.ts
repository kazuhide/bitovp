import { AisaLiveImportConflict } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	AisaImportVerificationError,
	importFinalAisaAnalysis,
} from "@/lib/server/aisa-live-import";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	analysisId: z.uuid(),
});

/** Imports an existing, independently verified final run; never starts a provider job. */
export async function POST(req: Request) {
	if (!aisaLivePreviewEnabled()) return jsonError(404, "Not found");
	const started = Date.now();
	try {
		const ctx = await getServerContext();
		if (
			!ctx.tenant ||
			!["ADMIN", "OPERATOR"].includes(ctx.tenant.role) ||
			ctx.tenant.isImpersonating
		)
			return jsonError(403, "An operator is required");
		const parsed = bodySchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const result = await importFinalAisaAnalysis(ctx, parsed.data, req);
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/live-channels/import-analysis",
				bitmovinAccountId: parsed.data.bitmovinAccountId,
				request: { analysisId: parsed.data.analysisId },
				response: result,
				statusCode: result.imported ? 201 : 200,
				durationMs: Date.now() - started,
			},
			req,
		);
		return NextResponse.json(result, { status: result.imported ? 201 : 200 });
	} catch (error) {
		if (error instanceof AisaImportVerificationError)
			return jsonError(
				error.httpStatusCode,
				"The completed AISA run could not be verified",
				{
					code: error.code,
				},
			);
		if (error instanceof AisaLiveImportConflict)
			return jsonError(409, "This AISA run conflicts with existing history", {
				code: "AISA_IMPORT_CONFLICT",
			});
		return routeError(error);
	}
}
