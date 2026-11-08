import "server-only";
import type { ServerContext } from "./context";
import { type ObjectPreviewTarget, serveObjectPreview } from "./object-preview";

const CHUNK_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const privateHeaders = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
};
const failure = (status: number, error: string) =>
	Response.json({ error }, { status, headers: privateHeaders });
type Chunk =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; response: Response };

/** Full attachment, read one pinned preview-sized range per consumer pull. */
export async function serveObjectDownload(
	ctx: ServerContext,
	req: Request,
	target: ObjectPreviewTarget,
	artifactId: string,
): Promise<Response> {
	const respond = (response: Response) =>
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
	if (!UUID.test(artifactId))
		return respond(failure(400, "Invalid artifact identifier"));
	if (
		!Number.isSafeInteger(target.size) ||
		target.size <= 0 ||
		target.expect.size !== target.size ||
		!(
			target.expect.etag?.trim() ||
			(target.expect.versionId?.trim() && target.expect.versionId !== "null") ||
			target.expect.generation?.trim()
		)
	)
		return respond(failure(409, "The media object version is unavailable"));
	if (req.signal.aborted)
		return respond(failure(408, "Download request canceled"));
	// Snapshot the entire locator and selector once; later ranges cannot adopt a new version.
	const pinned = { ...target, expect: { ...target.expect } };
	const abort = new AbortController();
	let stopped = false;
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let buffered: Uint8Array | undefined;
	let pending: Promise<Chunk> | undefined;
	const cleanup = () => {
		req.signal.removeEventListener("abort", onRequestAbort);
		buffered = undefined;
	};
	const onRequestAbort = () => {
		if (stopped) return;
		stopped = true;
		abort.abort();
		cleanup();
		streamController?.error(new Error("Media download canceled"));
	};
	req.signal.addEventListener("abort", onRequestAbort, { once: true });
	if (req.signal.aborted) onRequestAbort();
	const readRange = async (start: number): Promise<Chunk> => {
		const end = Math.min(start + CHUNK_BYTES, pinned.size) - 1;
		const headers = new Headers(req.headers);
		headers.set("Range", `bytes=${start}-${end}`);
		const response = await serveObjectPreview(
			ctx,
			new Request(req.url, {
				method: "GET",
				headers,
				signal: abort.signal,
			}),
			pinned,
		);
		if (!response.ok) return { ok: false, response };
		if (
			response.status !== 206 ||
			response.headers.get("Content-Range") !==
				`bytes ${start}-${end}/${pinned.size}` ||
			response.headers.get("Content-Length") !== String(end - start + 1)
		)
			return {
				ok: false,
				response: failure(502, "Media download unavailable"),
			};
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.byteLength === end - start + 1
			? { ok: true, bytes }
			: { ok: false, response: failure(502, "Media download unavailable") };
	};
	const read = async (start: number) => {
		const operation = readRange(start);
		pending = operation;
		try {
			return await operation;
		} finally {
			if (pending === operation) pending = undefined;
		}
	};
	let first: Chunk;
	try {
		first = await read(0);
	} catch {
		const canceled = abort.signal.aborted;
		abort.abort();
		cleanup();
		return respond(failure(canceled ? 408 : 502, "Media download unavailable"));
	}
	if (!first.ok) {
		cleanup();
		return respond(first.response);
	}
	if (stopped) {
		cleanup();
		return respond(failure(408, "Download request canceled"));
	}
	const responseHeaders = {
		...privateHeaders,
		"Content-Type": pinned.contentType,
		"Content-Length": String(pinned.size),
		"Content-Disposition": `attachment; filename="${artifactId}.mp4"`,
		"Accept-Ranges": "none",
	};
	if (req.method === "HEAD") {
		stopped = true;
		abort.abort();
		cleanup();
		return new Response(null, { status: 200, headers: responseHeaders });
	}
	buffered = first.bytes;
	let offset = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				streamController = controller;
			},
			async pull(controller) {
				if (stopped) return;
				try {
					let bytes = buffered;
					buffered = undefined;
					if (!bytes) {
						const chunk = await read(offset);
						if (stopped) return;
						if (!chunk.ok) throw new Error("Media download failed");
						bytes = chunk.bytes;
					}
					if (stopped) return;
					controller.enqueue(bytes);
					offset += bytes.byteLength;
					if (offset === pinned.size) {
						stopped = true;
						cleanup();
						controller.close();
					}
				} catch {
					if (stopped) return;
					stopped = true;
					abort.abort();
					cleanup();
					controller.error(new Error("Media download failed"));
				}
			},
			async cancel() {
				stopped = true;
				abort.abort();
				cleanup();
				await pending?.catch(() => undefined);
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, {
		status: 200,
		headers: responseHeaders,
	});
}
