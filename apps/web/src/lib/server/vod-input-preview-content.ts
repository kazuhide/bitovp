import "server-only";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	getVodInputPreviewTaskRow,
	VodInputPreviewError,
} from "./vod-input-previews";

export async function serveVodInputPreviewContent(
	req: Request,
	id: string,
): Promise<Response> {
	const row = await getVodInputPreviewTaskRow(id);
	if (
		row.kind !== "PREVIEW" ||
		row.status !== "SUCCEEDED" ||
		!row.artifactToken ||
		!row.artifactPath ||
		!row.artifactSize ||
		!row.artifactSha256
	)
		throw new VodInputPreviewError(409, "PREVIEW_NOT_READY");
	const safeId = z.uuid();
	safeId.parse(row.organizationId);
	safeId.parse(row.id);
	safeId.parse(row.artifactToken);
	const configuredRoot =
		process.env.VOD_INPUT_PREVIEW_DIR ??
		join(tmpdir(), "bitovp-vod-input-previews");
	if (!isAbsolute(configuredRoot))
		throw new VodInputPreviewError(503, "PREVIEW_STORAGE_UNAVAILABLE");
	// This cache volume is provisioned at runtime and is never packaged application source.
	const root = await realpath(/* turbopackIgnore: true */ configuredRoot);
	const expected = join(
		root,
		row.organizationId,
		row.id,
		row.artifactToken,
		"preview.mp4",
	);
	if (
		(await realpath(/* turbopackIgnore: true */ dirname(expected))) !==
			dirname(expected) ||
		(await realpath(/* turbopackIgnore: true */ row.artifactPath)) !== expected
	)
		throw new VodInputPreviewError(404, "PREVIEW_NOT_FOUND");
	const file = await open(
		/* turbopackIgnore: true */ expected,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	let closed = false;
	async function close() {
		if (!closed) {
			closed = true;
			await file.close();
		}
	}
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			BigInt(stat.size) !== row.artifactSize ||
			stat.size > 128 * 1024 * 1024
		)
			throw new VodInputPreviewError(404, "PREVIEW_NOT_FOUND");
		const size = stat.size;
		let start = 0,
			end = size - 1;
		const range = req.headers.get("range");
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2])) {
				await close();
				return new Response(null, {
					status: 416,
					headers: {
						"Content-Range": `bytes */${size}`,
						"Cache-Control": "private, no-store",
					},
				});
			}
			if (!match[1]) start = Math.max(0, size - Number(match[2]));
			else {
				start = Number(match[1]);
				if (match[2]) end = Math.min(Number(match[2]), end);
			}
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				start > end ||
				start >= size ||
				(!match[1] && Number(match[2]) <= 0)
			) {
				await close();
				return new Response(null, {
					status: 416,
					headers: {
						"Content-Range": `bytes */${size}`,
						"Cache-Control": "private, no-store",
					},
				});
			}
		}
		const headers = {
			"Content-Type": "video/mp4",
			"Content-Length": String(end - start + 1),
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
		};
		if (req.method === "HEAD") {
			await close();
			return new Response(null, { status: range ? 206 : 200, headers });
		}
		let position = start;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					if (req.signal.aborted) {
						await close();
						controller.close();
						return;
					}
					const bytes = Buffer.alloc(Math.min(256 * 1024, end - position + 1));
					const read = await file.read(bytes, 0, bytes.length, position);
					if (!read.bytesRead) throw new Error("Preview ended unexpectedly");
					position += read.bytesRead;
					controller.enqueue(bytes.subarray(0, read.bytesRead));
					if (position > end) {
						await close();
						controller.close();
					}
				} catch (error) {
					await close();
					controller.error(error);
				}
			},
			async cancel() {
				await close();
			},
		});
		return new Response(body, { status: range ? 206 : 200, headers });
	} catch (error) {
		await close();
		throw error;
	}
}
