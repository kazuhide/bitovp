import "server-only";
import { hashEditingEvidence, pinnedInputCaptureSchema } from "@bitovp/core";
import {
	authorizeInputCaptureRequest,
	inputCaptureUnauthorized,
} from "@/lib/auth/input-capture-gate";
import { contextForOrganization } from "./context";
import { serveObjectDownload } from "./object-download";
import { serveObjectPreview } from "./object-preview";

const privateHeaders = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
};
const hidden = () =>
	Response.json(
		{ error: "Input capture unavailable" },
		{ status: 404, headers: privateHeaders },
	);
/** A private read capability for exactly the object the encoder was instructed to consume. */
export async function servePinnedInputCapture(
	req: Request,
	receiptId: string,
): Promise<Response> {
	const head = (response: Response) =>
		req.method === "HEAD"
			? new Response(null, {
					status: response.status,
					headers: response.headers,
				})
			: response;
	if (req.method !== "GET" && req.method !== "HEAD")
		return new Response(null, {
			status: 405,
			headers: { ...privateHeaders, Allow: "GET, HEAD" },
		});
	const auth = authorizeInputCaptureRequest(req);
	if (!auth || auth.receiptId !== receiptId)
		return head(inputCaptureUnauthorized());
	try {
		const ctx = contextForOrganization(auth.organizationId, true);
		const row = await ctx.prisma.libraryEvidenceReceipt.findUnique({
			where: { id: receiptId, organizationId: auth.organizationId },
		});
		if (
			!row ||
			row.id !== receiptId ||
			row.organizationId !== auth.organizationId ||
			row.kind !== "INPUT_CAPTURE" ||
			row.proofHash !== hashEditingEvidence(row.proof)
		)
			return head(hidden());
		const result = pinnedInputCaptureSchema.safeParse(row.proof);
		if (!result.success) return head(hidden());
		const proof = result.data;
		if (
			proof.organizationId !== auth.organizationId ||
			proof.expiresAt !== auth.expiresAt ||
			proof.jobId !== row.jobId ||
			proof.encodingId !== row.encodingId ||
			!proof.storage.size ||
			proof.storage.size > 4 * 1024 ** 3
		)
			return head(hidden());
		const job = await ctx.prisma.encodingJob.findUnique({
			where: { id: proof.jobId, organizationId: auth.organizationId },
		});
		if (
			!job ||
			job.id !== proof.jobId ||
			job.organizationId !== auth.organizationId ||
			job.bitmovinEncodingId !== proof.encodingId ||
			hashEditingEvidence(job.plan) !== proof.planHash ||
			!["RUNNING", "FINISHED", "AWAITING_QC", "QC_FAILED"].includes(job.status)
		)
			return head(hidden());
		const target = {
			credentialId: proof.storage.credentialId,
			bucket: proof.storage.bucket,
			key: proof.storage.key,
			size: proof.storage.size,
			expect: { ...proof.storage.expect, size: proof.storage.size },
			contentType: "application/octet-stream",
		};
		const response = req.headers.has("range")
			? await serveObjectPreview(ctx, req, target)
			: await serveObjectDownload(ctx, req, target, receiptId);
		return head(response);
	} catch {
		// No storage locator, account response, HMAC or request headers escape errors.
		return head(
			Response.json(
				{ error: "Input capture unavailable" },
				{ status: 503, headers: privateHeaders },
			),
		);
	}
}
