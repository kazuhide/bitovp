import "server-only";
import { z } from "zod";
import { jsonError, routeError, validationError } from "./http";
import { VodInputPreviewError } from "./vod-input-previews";

export async function readVodInputPreviewJson(req: Request): Promise<unknown> {
	if (!req.body) throw new VodInputPreviewError(400, "INVALID_PREVIEW_REQUEST");
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 64 * 1024) {
				await reader.cancel();
				throw new VodInputPreviewError(413, "PREVIEW_REQUEST_TOO_LARGE");
			}
			chunks.push(part.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		if (error instanceof VodInputPreviewError) throw error;
		throw new VodInputPreviewError(400, "INVALID_PREVIEW_REQUEST");
	} finally {
		reader.releaseLock();
	}
}

export function vodInputPreviewRouteError(error: unknown) {
	if (error instanceof VodInputPreviewError)
		return jsonError(error.status, error.code, { code: error.code });
	if (error instanceof z.ZodError) return validationError(error);
	return routeError(error);
}
