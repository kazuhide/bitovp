import "server-only";
import type { Readable } from "node:stream";
import {
	describeStorageError,
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
} from "@bitovp/storage";
import type { getServerContext } from "./context";
import { browserForCredentialId } from "./storage";
export type ObjectPreviewTarget = {
	credentialId: string;
	bucket: string;
	key: string;
	size: number;
	expect: ObjectIdentity;
	contentType: string;
};
const MAX_READ = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const privateHeaders = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Accept-Ranges": "bytes",
};
function failure(
	status: number,
	error: string,
	headers: Record<string, string> = {},
) {
	return Response.json(
		{ error },
		{ status, headers: { ...privateHeaders, ...headers } },
	);
}

/** Single capped range; never buffer/download an entire multi-GB QC mirror. */
export async function serveObjectPreview(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	req: Request,
	target: ObjectPreviewTarget,
): Promise<Response> {
	const raw = req.headers.get("range");
	let start = 0;
	let end = target.size - 1;
	const invalidRange = () =>
		failure(416, "A valid bounded byte range is required", {
			"Content-Range": `bytes */${target.size}`,
		});
	if (raw !== null) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
		if (!match || (!match[1] && !match[2])) return invalidRange();
		if (!match[1]) {
			const suffix = Number(match[2]);
			if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalidRange();
			start = Math.max(0, target.size - suffix);
		} else {
			start = Number(match[1]);
			end = match[2] ? Number(match[2]) : end;
		}
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start >= target.size ||
			end < start
		)
			return invalidRange();
		end = Math.min(end, target.size - 1, start + MAX_READ - 1);
	} else if (target.size > MAX_READ) return invalidRange();
	if (req.signal.aborted) return failure(408, "Preview request canceled");
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	req.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(onAbort, TIMEOUT_MS);
	let browser: ObjectStorageBrowser | null = null;
	let stream: Readable | undefined;
	const dispose = () => {
		stream?.destroy();
		browser?.dispose?.();
		browser = null;
	};
	let rejectAbort: (() => void) | undefined;
	const canceled = new Promise<never>((_, reject) => {
		rejectAbort = () => {
			dispose();
			reject(new Error("Preview canceled"));
		};
	});
	abort.signal.addEventListener("abort", () => rejectAbort?.(), { once: true });
	const transfer = async () => {
		try {
			browser = await browserForCredentialId(
				ctx,
				target.credentialId,
				undefined,
				{ readTimeoutMs: TIMEOUT_MS },
			);
			if (abort.signal.aborted) throw new Error("Preview canceled");
			if (!browser?.getObject) throw new Error("Preview unavailable");
			stream = (await browser.getObject({
				bucket: target.bucket,
				key: target.key,
				expect: target.expect,
				range: { start, end },
			})) as Readable;
			if (abort.signal.aborted) throw new Error("Preview canceled");
			const chunks: Buffer[] = [];
			let length = 0;
			for await (const chunk of stream) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += bytes.length;
				if (length > end - start + 1)
					throw new Error("Invalid preview transfer");
				chunks.push(bytes);
			}
			if (length !== end - start + 1)
				throw new Error("Invalid preview transfer");
			return Buffer.concat(chunks, length);
		} finally {
			dispose();
		}
	};
	try {
		const body = await Promise.race([transfer(), canceled]);
		return new Response(body, {
			status: raw === null ? 200 : 206,
			headers: {
				...privateHeaders,
				"Content-Type": target.contentType,
				"Content-Length": String(body.length),
				...(raw === null
					? {}
					: { "Content-Range": `bytes ${start}-${end}/${target.size}` }),
			},
		});
	} catch (error) {
		if (abort.signal.aborted)
			return failure(408, "Preview request canceled or timed out");
		if (error instanceof ObjectVersionMismatchError)
			return failure(409, "The media object has changed");
		const status = describeStorageError(error).status;
		if (status === 401 || status === 403)
			return Response.json(
				{
					error: "Media storage access denied",
					details: { code: "MEDIA_STORAGE_ACCESS_DENIED" },
				},
				{ status: 502, headers: privateHeaders },
			);
		if (status === 404)
			return Response.json(
				{
					error: "Media file not found",
					details: { code: "MEDIA_FILE_NOT_FOUND" },
				},
				{ status: 404, headers: privateHeaders },
			);
		return failure(502, "Media preview unavailable");
	} finally {
		clearTimeout(timer);
		req.signal.removeEventListener("abort", onAbort);
	}
}
