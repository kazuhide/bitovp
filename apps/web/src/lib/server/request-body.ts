import { declaredBodyTooLarge } from "./request-body-limits";

function cancelWithoutWaiting(
	body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
) {
	// A source may reject or never settle cancellation; neither may delay 413.
	void body.cancel().catch(() => {});
}

export async function readBoundedBody(
	req: Pick<Request, "headers" | "body">,
	limit: number,
): Promise<Uint8Array | null> {
	if (declaredBodyTooLarge(req.headers.get("content-length"), limit)) {
		if (req.body) cancelWithoutWaiting(req.body);
		return null;
	}
	if (!req.body) return new Uint8Array(0);
	const reader = req.body.getReader();
	// One bounded allocation avoids retaining chunks alongside a second full copy.
	const bytes = new Uint8Array(limit);
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return bytes.subarray(0, received);
			if (value.byteLength > limit - received) {
				cancelWithoutWaiting(reader);
				return null;
			}
			bytes.set(value, received);
			received += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
}

/** Keep malformed or unreadable JSON distinct from a body-size rejection. */
export async function readBoundedJson(
	req: Request,
	limit: number,
): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
	try {
		const bytes = await readBoundedBody(req, limit);
		if (bytes === null) return { tooLarge: true };
		return {
			tooLarge: false,
			value: JSON.parse(new TextDecoder().decode(bytes)),
		};
	} catch {
		return { tooLarge: false, value: null };
	}
}
