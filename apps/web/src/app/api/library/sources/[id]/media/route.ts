import { libraryFileContentType, librarySnapshotSchema } from "@bitovp/core";
import { describeStorageError, type ObjectIdentity } from "@bitovp/storage";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError } from "@/lib/server/http";
import { libraryFileOutputsForSource } from "@/lib/server/library-playback";
import { serveObjectPreview } from "@/lib/server/object-preview";
import { browserForCredentialId } from "@/lib/server/storage";

export const runtime = "nodejs";

/** The auth proxy enforces the existing Library VIEWER read boundary. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const finish = (response: Response) => {
		response.headers.set("Cache-Control", "private, no-store");
		response.headers.set("X-Content-Type-Options", "nosniff");
		return response;
	};
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return finish(invalid);
	const query = new URL(req.url).searchParams;
	const key = query.get("key");
	if (
		!key ||
		key.length > 160 ||
		query.getAll("key").length !== 1 ||
		[...query.keys()].some((k) => k !== "key")
	)
		return finish(jsonError(400, "Invalid media query"));
	if (req.signal.aborted)
		return finish(jsonError(408, "Media request canceled"));
	try {
		const ctx = await getServerContext();
		const source = await ctx.prisma.librarySource.findUnique({
			where: { id },
			select: { jobId: true, snapshot: true },
		});
		if (!source) return finish(jsonError(404, "Media not found"));
		const snapshot = librarySnapshotSchema.parse(source.snapshot);
		const outputs = await libraryFileOutputsForSource(ctx.prisma, {
			jobId: source.jobId,
			planHash: snapshot.planHash,
			fileOutputs: snapshot.fileOutputs,
		});
		const target = outputs.find((output) => output.key === key);
		if (!target) return finish(jsonError(404, "Media not found"));
		const browser = await browserForCredentialId(
			ctx,
			target.credentialId,
			undefined,
			{ readTimeoutMs: 15000 },
		);
		if (!browser) return finish(jsonError(404, "Media unavailable"));
		let identity: ObjectIdentity;
		try {
			if (!browser.headObject || !browser.getObject)
				return finish(jsonError(409, "Media preview unavailable"));
			identity = await browser.headObject({
				bucket: target.bucket,
				key: target.path,
			});
		} finally {
			browser.dispose?.();
		}
		if (
			!Number.isSafeInteger(identity.size) ||
			identity.size <= 0 ||
			!(
				identity.etag ||
				(identity.versionId && identity.versionId !== "null") ||
				identity.generation
			)
		)
			return finish(jsonError(409, "Media preview unavailable"));
		return finish(
			await serveObjectPreview(ctx, req, {
				credentialId: target.credentialId,
				bucket: target.bucket,
				key: target.path,
				size: identity.size,
				expect: identity,
				contentType: libraryFileContentType(target.kind),
			}),
		);
	} catch (error) {
		const status = describeStorageError(error).status;
		if (status === 401 || status === 403)
			return finish(
				jsonError(502, "Media storage access denied", {
					code: "MEDIA_STORAGE_ACCESS_DENIED",
				}),
			);
		if (status === 404)
			return finish(
				jsonError(404, "Media file not found", {
					code: "MEDIA_FILE_NOT_FOUND",
				}),
			);
		return finish(jsonError(502, "Media preview unavailable"));
	}
}
